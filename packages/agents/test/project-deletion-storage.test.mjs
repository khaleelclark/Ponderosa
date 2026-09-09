import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { AgentStore } from "../dist/index.js";

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-project-deletion-storage-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new AgentStore(dataDir);
  t.after(() => store.close());
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  return { dataDir, store, project };
}

test("startup preserves an unjournaled deletion-shaped Project directory", (t) => {
  const { dataDir, store } = fixture(t);
  store.close();
  const sentinel = join(
    dataDir,
    "projects",
    ".foreign.deleting-user-owned",
    "KEEP.txt",
  );
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "must survive\n");

  const reopened = new AgentStore(dataDir);
  reopened.close();

  assert.equal(readFileSync(sentinel, "utf8"), "must survive\n");
});

test("Project cleanup preserves a replacement at the exact receipt path", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  store.close();
  rmSync(tombstone, { recursive: true, force: true });
  const sentinel = join(tombstone, "KEEP.txt");
  mkdirSync(tombstone, { recursive: true });
  writeFileSync(sentinel, "replacement data\n");
  writeFileSync(join(tombstone, ".ponderosa-project-deletion.json"), JSON.stringify({
    version: 1,
    projectId: project.id,
    tombstoneName: receipt.tombstoneName,
    ownershipToken: "foreign-token",
  }));

  const reopened = new AgentStore(dataDir);
  assert.throws(
    () => reopened.finishProjectDeletionStorageCleanup(receipt),
    /ownership identity does not match/u,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "replacement data\n");
  assert.equal(reopened.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);
  reopened.close();
});

test("Project cleanup keeps a missing receipt tombstone pending", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  rmSync(tombstone, { recursive: true, force: true });

  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt),
    /tombstone is missing/u,
  );
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.removalStarted, false);
});

test("Project cleanup retry converges after a crash immediately following removal", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);

  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt, () => {
      throw new Error("injected crash after tombstone removal");
    }),
    /injected crash/u,
  );
  assert.equal(existsSync(tombstone), false);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.removalStarted, true);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);

  store.finishProjectDeletionStorageCleanup(receipt);

  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, true);
});

test("late projection failure cannot roll back completed Project storage recovery", (t) => {
  const { dataDir, store, project } = fixture(t);
  const unrelated = store.createProject({
    label: "Unrelated",
    hostPath: "/tmp/unrelated",
    defaultEngine: "codex",
  });
  const unrelatedJson = join(dataDir, "projects", unrelated.id, "project.json");
  const originalUnrelatedJson = readFileSync(unrelatedJson, "utf8");
  const receipt = store.commitProjectDeletion(project.id);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt, () => {
      throw new Error("injected crash after tombstone removal");
    }),
    /injected crash/u,
  );
  store.close();
  writeFileSync(unrelatedJson, "{corrupt unrelated projection");

  const quarantined = new AgentStore(dataDir);
  assert.equal(quarantined.getProject(unrelated.id), undefined);
  const [recoveryIssue] = quarantined.startupProfile().recoveryIssues;
  assert.equal(recoveryIssue?.projectId, unrelated.id);
  assert.match(recoveryIssue?.detail ?? "", /JSON/u);
  assert.equal(readFileSync(unrelatedJson, "utf8"), "{corrupt unrelated projection");
  quarantined.close();
  const sqlite = new Database(join(dataDir, "ponderosa.db"), { readonly: true });
  const recoveredReceipt = sqlite.prepare(`
    SELECT removal_started removalStarted,
           storage_cleanup_completed storageCleanupCompleted
    FROM project_deletion_receipts WHERE project_id = ?
  `).get(project.id);
  sqlite.close();
  assert.deepEqual(recoveredReceipt, {
    removalStarted: 1,
    storageCleanupCompleted: 1,
  });
  assert.equal(existsSync(tombstone), false);

  writeFileSync(unrelatedJson, originalUnrelatedJson);
  const reopened = new AgentStore(dataDir);
  assert.equal(reopened.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, true);
  assert.equal(reopened.getProject(project.id), undefined);
  assert.equal(reopened.getProject(unrelated.id)?.id, unrelated.id);
  reopened.close();
});

test("Project cleanup preserves an ABA replacement after removal started", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt, () => {
      throw new Error("injected crash after tombstone removal");
    }),
    /injected crash/u,
  );
  mkdirSync(tombstone);
  const sentinel = join(tombstone, "KEEP.txt");
  writeFileSync(sentinel, "replacement data\n");
  writeFileSync(join(tombstone, ".ponderosa-project-deletion.json"), JSON.stringify({
    version: 1,
    projectId: project.id,
    tombstoneName: receipt.tombstoneName,
    ownershipToken: "replacement-token",
  }));

  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt),
    /ownership identity does not match/u,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "replacement data\n");
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);
});

test("Project cleanup removes its exact receipt-bound tombstone", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  assert.equal(existsSync(tombstone), true);

  store.finishProjectDeletionStorageCleanup(receipt);

  assert.equal(existsSync(tombstone), false);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.removalStarted, true);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, true);
});

test("Project deletion receipt durably inventories Chat and Agent draft surfaces", (t) => {
  const { store, project } = fixture(t);
  const chat = store.createConversation(project.id, { title: "Chat" });
  const agent = store.createAgent(project.id, {
    title: "Agent",
    engine: "codex",
    conversationId: chat.id,
  });
  const expected = [
    ...store.listConversations(project.id)
      .map(({ id }) => id)
      .sort()
      .flatMap(id => [id, `collaboration:${id}`]),
    `agent:${agent.id}`,
  ];

  assert.deepEqual(store.markProjectDeletionPending(project.id), expected);
  assert.deepEqual(store.markProjectDeletionPending(project.id), expected);
  const receipt = store.commitProjectDeletion(project.id);
  assert.deepEqual(receipt?.draftSurfaceIds, expected);
  assert.equal(receipt?.draftCleanupCompleted, false);

  store.finishProjectDeletionStorageCleanup(receipt);
  assert.equal(store.listPendingProjectDeletionReceipts().length, 1);
  store.markProjectDeletionDraftCleanupComplete(project.id);
  assert.equal(store.listPendingProjectDeletionReceipts().length, 1);
  store.markProjectDeletionAssetAuthorityCleanupComplete(project.id);
  assert.equal(store.listPendingProjectDeletionReceipts().length, 0);
});

test("Project asset authority cleanup cannot complete before physical cleanup", (t) => {
  const { store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt);

  assert.throws(
    () => store.markProjectDeletionAssetAuthorityCleanupComplete(project.id),
    /storage and draft cleanup must finish/u,
  );
  store.finishProjectDeletionStorageCleanup(receipt);
  store.markProjectDeletionDraftCleanupComplete(project.id);
  store.markProjectDeletionAssetAuthorityCleanupComplete(project.id);

  const completed = store.getProjectDeletionReceipt(project.id);
  assert.equal(completed?.assetAuthorityCleanupCompleted, true);
  assert.ok(completed?.completedAt);
});

test("Project commit preserves incomplete Agent deletion cleanup authority", (t) => {
  const { dataDir, store, project } = fixture(t);
  const chat = store.getConversation(project.lastConversationId);
  const agent = store.createAgent(project.id, {
    title: "Agent",
    engine: "codex",
    conversationId: chat.id,
  });
  const preview = store.previewAgentDeletion([agent.id]);
  store.deleteAgentSubtrees(preview.rootAgentIds, preview.previewHash);
  const agentReceipt = store.getAgentDeletionReceiptByPreviewHash(preview.previewHash);
  assert.equal(agentReceipt?.storageCleanupCompleted, true);
  assert.equal(agentReceipt?.serverCleanupCompleted, false);

  assert.throws(
    () => store.commitProjectDeletion(project.id),
    /cannot commit while Agent deletion cleanup is pending/u,
  );
  assert.equal(store.getProject(project.id)?.id, project.id);
  assert.equal(existsSync(join(dataDir, "projects", project.id)), true);
  assert.ok(store.getAgentDeletionReceiptByPreviewHash(preview.previewHash));

  store.markAgentDeletionServerCleanupComplete(agentReceipt.id);
  assert.ok(store.commitProjectDeletion(project.id));
  assert.equal(store.getAgentDeletionReceiptByPreviewHash(preview.previewHash), undefined);
});

test("Project commit preserves an Agent deletion precommit journal", (t) => {
  const { dataDir, store, project } = fixture(t);
  const chat = store.getConversation(project.lastConversationId);
  const agent = store.createAgent(project.id, {
    title: "Agent",
    engine: "codex",
    conversationId: chat.id,
  });
  store.sqlite.prepare(`
    INSERT INTO agent_deletion_pending (
      agent_id, project_id, conversation_id, tombstone_name, ownership_token, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    project.id,
    chat.id,
    `.${agent.id}.deleting-test`,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    new Date().toISOString(),
  );

  assert.throws(
    () => store.commitProjectDeletion(project.id),
    /cannot commit while Agent deletion cleanup is pending/u,
  );
  assert.equal(existsSync(join(dataDir, "projects", project.id)), true);
  assert.equal(store.sqlite.prepare(
    "SELECT COUNT(*) count FROM agent_deletion_pending WHERE agent_id = ?",
  ).get(agent.id).count, 1);
});

test("a sibling Project Agent deletion receipt does not block Project commit", (t) => {
  const { store, project } = fixture(t);
  const sibling = store.createProject({
    label: "Sibling",
    hostPath: "/tmp/sibling",
    defaultEngine: "codex",
  });
  const siblingAgent = store.createAgent(sibling.id, {
    title: "Sibling Agent",
    engine: "codex",
    conversationId: sibling.lastConversationId,
  });
  const preview = store.previewAgentDeletion([siblingAgent.id]);
  store.deleteAgentSubtrees(preview.rootAgentIds, preview.previewHash);

  assert.ok(store.commitProjectDeletion(project.id));
  assert.ok(store.getProject(sibling.id));
  assert.ok(store.getAgentDeletionReceiptByPreviewHash(preview.previewHash));
});
