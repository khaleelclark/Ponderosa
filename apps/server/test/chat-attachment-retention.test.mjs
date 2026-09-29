import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AgentStore, retainChatAttachment, retainedChatAttachmentContent } from "@ponderosa/agents";
import { AssetStore } from "../dist/assets.js";
import Fastify from "fastify";
import sharp from "sharp";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { createCommunicationProjectionReconciler } from "../dist/communication-projection-reconciler.js";

async function fixture(t, body = Buffer.from("durable sent bytes"), name = "sent.txt") {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-retained-chat-"));
  const store = new AgentStore(dataDir);
  const assets = new AssetStore(dataDir, { portableFiles: true });
  t.after(() => { assets.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const project = store.createProject({ label: "Retention", hostPath: dataDir, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Retained Chat" });
  const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: chat.id });
  const asset = await assets.stage({ projectId: project.id, agentId: agent.id, name, body });
  await assets.associate(project.id, agent.id, [asset.id]);
  const event = store.appendCommunicationEvent({
    eventId: randomUUID(), projectId: project.id, conversationId: chat.id,
    schemaVersion: 2, intent: "broadcast", sender: { kind: "user", userId: "operator" }, audience: { kind: "organization", organizationId: project.id },
    text: "File", createdAt: new Date().toISOString(), attachments: [asset],
  }).event;
  store.appendCommunicationProjection(project.id, {
    eventId: event.eventId, surface: "conversation", projectionKey: chat.id, projectedAt: event.createdAt,
    message: { messageId: event.eventId, role: "user", createdAt: event.createdAt, attachments: [asset] },
  });
  return { dataDir, store, assets, project, chat, agent, asset, event };
}

test("sent Chat attachment survives Agent deletion and restart with canonical identity unchanged", async t => {
  const f = await fixture(t);
  const privateAsset = await f.assets.stage({ projectId: f.project.id, agentId: f.agent.id, name: "private.txt", body: Buffer.from("unsent private") });
  const preview = f.store.previewAgentDeletion([f.agent.id]);
  f.store.deleteAgentSubtrees(preview.rootAgentIds, preview.previewHash);
  const receipt = f.store.getAgentDeletionReceiptByPreviewHash(preview.previewHash);
  assert.equal(receipt.storageCleanupCompleted, true, receipt.lastError);
  assert.equal(existsSync(join(f.dataDir, "projects", f.project.id, "agents", f.agent.id, "attachments")), false);
  const retained = retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, f.asset.id, false);
  assert.equal(retained.body.toString(), "durable sent bytes");
  assert.equal(retained.record.eventId, f.event.eventId);
  assert.equal(retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, privateAsset.id, false), undefined);
  assert.equal(retainedChatAttachmentContent(f.dataDir, randomUUID(), f.chat.id, f.agent.id, f.asset.id, false), undefined);
  const message = f.store.getConversationMessages(f.chat.id).find(item => item.communicationEventId === f.event.eventId);
  assert.match(message.attachments[0].downloadUrl, /retained-attachments/);
  f.store.close();
  const reopened = new AgentStore(f.dataDir);
  try {
    assert.equal(reopened.getConversationMessages(f.chat.id).find(item => item.communicationEventId === f.event.eventId).attachments[0].id, f.asset.id);
    assert.equal(retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, f.asset.id, false).body.toString(), "durable sent bytes");
    const deletion = reopened.commitConversationDeletion(f.chat.id);
    reopened.finishConversationDeletionStorageCleanup(deletion);
    assert.equal(retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, f.asset.id, false), undefined);
  } finally { reopened.close(); }
});

test("missing sent bytes leave cleanup pending rather than destroying the source", async t => {
  const f = await fixture(t);
  const original = join(f.dataDir, "projects", f.project.id, "agents", f.agent.id, "attachments", f.asset.id + ".bin");
  writeFileSync(original, "changed");
  const preview = f.store.previewAgentDeletion([f.agent.id]);
  f.store.deleteAgentSubtrees(preview.rootAgentIds, preview.previewHash);
  const receipt = f.store.getAgentDeletionReceiptByPreviewHash(preview.previewHash);
  assert.equal(receipt.storageCleanupCompleted, false);
  assert.match(receipt.lastError, /missing or changed/);
  const agentsFolder = join(f.dataDir, "projects", f.project.id, "agents");
  const tombstone = readdirSync(agentsFolder).find(name => name.startsWith(`.${f.agent.id}.deleting-`));
  const pendingSource = join(agentsFolder, tombstone, "attachments", `${f.asset.id}.bin`);
  f.store.close();
  const reopened = new AgentStore(f.dataDir);
  try {
    assert.equal(reopened.getAgentDeletionReceiptByPreviewHash(preview.previewHash).storageCleanupCompleted, false);
    writeFileSync(pendingSource, "durable sent bytes");
    reopened.finishAgentDeletionStorageCleanup(reopened.getAgentDeletionReceiptByPreviewHash(preview.previewHash));
    assert.equal(reopened.getAgentDeletionReceiptByPreviewHash(preview.previewHash).storageCleanupCompleted, true);
    assert.equal(retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, f.asset.id, false).body.toString(), "durable sent bytes");
  }
  finally { reopened.close(); }
});

test("an orphaned retained mapping is unavailable rather than offering a working-looking download", async t => {
  const f = await fixture(t);
  const deletion = f.store.previewAgentDeletion([f.agent.id]);
  f.store.deleteAgentSubtrees(deletion.rootAgentIds, deletion.previewHash);
  const retainedFile = join(f.dataDir, "projects", f.project.id, "conversations", f.chat.id, "retained-attachments", `${f.agent.id}-${f.asset.id}.bin`);
  rmSync(retainedFile);
  const attachment = f.store.getConversationMessages(f.chat.id).find(message => message.communicationEventId === f.event.eventId).attachments[0];
  assert.equal(attachment.unavailable, true);
  assert.equal(attachment.downloadUrl, undefined);
  assert.equal(attachment.previewUrl, undefined);
  assert.equal(attachment.id, f.asset.id);
});

test("mapping failure keeps source cleanup pending and recovery after publication is idempotent", async t => {
  const f = await fixture(t);
  const target = join(f.dataDir, "projects", f.project.id, "conversations", f.chat.id, "retained-attachments");
  mkdirSync(target);
  const mapping = join(target, `${f.agent.id}-${f.asset.id}.json`);
  mkdirSync(mapping); // Durable mapping publication cannot replace a directory.
  const deletion = f.store.previewAgentDeletion([f.agent.id]);
  f.store.deleteAgentSubtrees(deletion.rootAgentIds, deletion.previewHash);
  const receipt = f.store.getAgentDeletionReceiptByPreviewHash(deletion.previewHash);
  assert.equal(receipt.storageCleanupCompleted, false);
  const agentsFolder = join(f.dataDir, "projects", f.project.id, "agents");
  const tombstone = readdirSync(agentsFolder).find(name => name.startsWith(`.${f.agent.id}.deleting-`));
  assert.equal(existsSync(join(agentsFolder, tombstone, "attachments", `${f.asset.id}.bin`)), true);
  rmSync(mapping, { recursive: true });
  retainChatAttachment({ dataDir: f.dataDir, sourceDirectory: `projects/${f.project.id}/agents/${tombstone}/attachments`, projectId: f.project.id, conversationId: f.chat.id, eventId: f.event.eventId, attachment: f.asset });
  f.store.close(); // Simulate stopping after mapping publication but before source removal.
  const reopened = new AgentStore(f.dataDir);
  try {
    assert.equal(reopened.getAgentDeletionReceiptByPreviewHash(deletion.previewHash).storageCleanupCompleted, true);
    assert.equal(retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, f.asset.id, false).body.toString(), "durable sent bytes");
    reopened.finishAgentDeletionStorageCleanup(receipt);
  } finally { reopened.close(); }
});

test("interrupted copy publication resumes exactly, and conflicting bytes fail closed", async t => {
  const f = await fixture(t);
  const target = join(f.dataDir, "projects", f.project.id, "conversations", f.chat.id, "retained-attachments");
  mkdirSync(target);
  const bytes = Buffer.from("durable sent bytes");
  writeFileSync(join(target, f.agent.id + "-" + f.asset.id + ".bin"), bytes);
  const input = { dataDir: f.dataDir, sourceDirectory: `projects/${f.project.id}/agents/${f.agent.id}/attachments`, projectId: f.project.id, conversationId: f.chat.id, eventId: f.event.eventId, attachment: f.asset };
  retainChatAttachment(input);
  retainChatAttachment(input);
  assert.equal(retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, f.asset.id, false).body.toString(), bytes.toString());
  writeFileSync(join(target, f.agent.id + "-" + f.asset.id + ".bin"), "bad");
  assert.throws(() => retainChatAttachment(input), /verification/);
});

test("a retained image serves its verified preview/download after deletion and fences other Chats", async t => {
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const f = await fixture(t, image, "photo.png");
  const otherChat = f.store.createConversation(f.project.id, { title: "Other Chat" });
  const deletion = f.store.previewAgentDeletion([f.agent.id]);
  f.store.deleteAgentSubtrees(deletion.rootAgentIds, deletion.previewHash);
  const app = Fastify();
  t.after(() => app.close());
  registerAttachmentRoutes(app, { store: f.store, assets: f.assets, dataDir: f.dataDir,
    agentDeliveryLeases: new Map(), conversationDeliveryLeases: new Map(), deletingAttachmentKeys: new Set(),
    reconcilingAssetAgentIds: new Set(), conversationDeletionInProgress: () => false, agentDeletionInProgress: () => false });
  const base = `/api/conversations/${f.chat.id}/retained-attachments/${f.agent.id}/${f.asset.id}`;
  const download = await app.inject({ method: "GET", url: `${base}/download` });
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, image);
  const preview = await app.inject({ method: "GET", url: `${base}/preview` });
  assert.equal(preview.statusCode, 200);
  assert.equal((await sharp(preview.rawPayload).metadata()).width, 4);
  assert.equal((await app.inject({ method: "GET", url: base.replace(f.chat.id, otherChat.id) + "/download" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `${base}/download`, headers: { range: "bytes=0-1" } })).statusCode, 416);
});

test("opt-in attachment repair previews, rejects wrong bytes/scope, and restores only the canonical Chat file", async t => {
  const f = await fixture(t);
  const backup = mkdtempSync(join(tmpdir(), "ponderosa-repair-backup-"));
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  const source = `projects/${f.project.id}/agents/${f.agent.id}/attachments`;
  mkdirSync(join(backup, source), { recursive: true });
  cpSync(join(f.dataDir, source), join(backup, source), { recursive: true });
  const deletion = f.store.previewAgentDeletion([f.agent.id]);
  f.store.deleteAgentSubtrees(deletion.rootAgentIds, deletion.previewHash);
  const retainedFolder = join(f.dataDir, "projects", f.project.id, "conversations", f.chat.id, "retained-attachments");
  rmSync(retainedFolder, { recursive: true }); // Historical missing bytes, not a live-data repair.
  assert.equal(f.store.getConversationMessages(f.chat.id)[0].attachments[0].unavailable, true);
  f.assets.close();
  f.store.close();
  const cli = new URL("../../../packages/agents/tools/data-directory.mjs", import.meta.url).pathname;
  const args = [cli, "attachment-repair", "--data-dir", f.dataDir, "--project-id", f.project.id, "--chat-id", f.chat.id,
    "--event-id", f.event.eventId, "--attachment-id", f.asset.id, "--backup", backup, "--reason", "Disposable repair test"];
  const run = extra => JSON.parse(execFileSync(process.execPath, [...args, ...extra], { encoding: "utf8", stdio: "pipe" }));
  assert.equal(run([]).status, "preview");
  assert.equal(existsSync(retainedFolder), false, "preview must not publish a retained copy");
  const sourceFile = join(backup, source, `${f.asset.id}.bin`);
  writeFileSync(sourceFile, "wrong bytes");
  assert.throws(() => run(["--apply"]), /do not match/);
  writeFileSync(sourceFile, "durable sent bytes");
  const wrongScope = args.slice();
  wrongScope[wrongScope.indexOf("--chat-id") + 1] = randomUUID();
  assert.throws(() => execFileSync(process.execPath, [...wrongScope, "--apply"], { encoding: "utf8", stdio: "pipe" }), /retained Chat/);
  assert.equal(run(["--apply"]).status, "retained");
  assert.equal(run(["--apply"]).alreadyRetained, true);
  const reopened = new AgentStore(f.dataDir);
  try {
    assert.equal(reopened.getAgent(f.agent.id), undefined);
    assert.equal(reopened.getCommunicationEvent(f.project.id, f.event.eventId).eventId, f.event.eventId);
    assert.equal(retainedChatAttachmentContent(f.dataDir, f.project.id, f.chat.id, f.agent.id, f.asset.id, false).body.toString(), "durable sent bytes");
    const manifest = JSON.parse(readFileSync(join(retainedFolder, `${f.agent.id}-${f.asset.id}.json`), "utf8"));
    assert.equal(JSON.parse(manifest.repairSource).reason, "Disposable repair test");
  } finally { reopened.close(); }
});

test("startup accepts complete historical projections without upload reservations, but blocks incomplete sends", async t => {
  const f = await fixture(t);
  const errors = [];
  const runtime = { id: "runtime-row", projectId: f.project.id, sourceKind: "communication", recipientAgentIds: [], payload: { communication: f.event } };
  let complete = true;
  const store = Object.create(f.store);
  store.getCommunicationEvent = (...args) => complete ? f.store.getCommunicationEvent(...args) : undefined;
  const reconciler = createCommunicationProjectionReconciler({ store,
    coordinationV3: { runtimeCommunication: () => runtime, runtimeCommunications: () => [runtime], requestCommunicationsNeedingProjection: () => [], runtimeArtifacts: () => [{ id: "missing-runtime-artifact" }], communicationRecipientAgentIds: () => [] },
    assets: { read: (...args) => f.assets.read(...args), authoritativeRuntimeArtifact: () => undefined },
    projectDeletionInProgress: () => false, agentDeletionInProgress: () => false, conversationDeletionInProgress: () => false,
    attachmentDeletionInProgress: () => false, assetReconciliationInProgress: () => false,
    conversationDeliveryLeases: new Map(), agentDeliveryLeases: new Map(), recordCommunication: event => event,
    projectCommunicationArtifact: () => {}, communicationArtifactAccess: () => ({}), scheduleCommunicationReconciliation: () => {},
    logError: (_meta, message) => errors.push(message), logInfo: () => {}, projectCommunicationToAgentAudit: () => {} });
  await reconciler.reconcileRuntimeCommunicationProjections({ projectId: f.project.id, communicationEventId: f.event.eventId });
  assert.deepEqual(errors, []);
  complete = false;
  await assert.rejects(reconciler.reconcileRuntimeCommunicationProjections({ projectId: f.project.id, communicationEventId: f.event.eventId }), error => /incomplete/.test(error.message) && /unavailable/.test(error.cause?.message));
  assert.match(errors[0], /uncommitted/);
});
