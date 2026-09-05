import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

const markerName = ".ponderosa-agent-deletion.json";

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-agent-deletion-storage-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new AgentStore(dataDir);
  t.after(() => store.close());
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const conversation = store.createConversation(project.id, { title: "Chat" });
  const agent = store.createAgent(project.id, {
    title: "Agent",
    engine: "codex",
    conversationId: conversation.id,
  });
  const directory = join(dataDir, "projects", project.id, "agents");
  const canonical = join(directory, agent.id);
  return { dataDir, store, project, conversation, agent, directory, canonical };
}

function pendingIdentity(fixtureValue) {
  const tombstoneName = `.${fixtureValue.agent.id}.deleting-${randomUUID()}`;
  return {
    version: 1,
    kind: "agent-deletion",
    projectId: fixtureValue.project.id,
    conversationId: fixtureValue.conversation.id,
    agentId: fixtureValue.agent.id,
    tombstoneName,
    ownershipToken: randomUUID(),
  };
}

function installPending(store, identity) {
  const createdAt = new Date().toISOString();
  store.sqlite.prepare(`
    INSERT INTO agent_deletion_pending (
      agent_id, project_id, conversation_id, tombstone_name, ownership_token, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    identity.agentId,
    identity.projectId,
    identity.conversationId,
    identity.tombstoneName,
    identity.ownershipToken,
    createdAt,
  );
  return createdAt;
}

function writeMarker(canonical, identity) {
  writeFileSync(join(canonical, markerName), `${JSON.stringify(identity, null, 2)}\n`);
}

test("startup preserves every unjournaled Agent deletion-shaped directory", (t) => {
  const f = fixture(t);
  f.store.close();
  const foreign = join(f.directory, `.${f.agent.id}.deleting-foreign`);
  const sentinel = join(foreign, "KEEP.txt");
  mkdirSync(foreign);
  writeFileSync(sentinel, "must survive\n");

  const reopened = new AgentStore(f.dataDir);
  reopened.close();

  assert.equal(readFileSync(sentinel, "utf8"), "must survive\n");
  assert.equal(existsSync(f.canonical), true);
});

test("startup clears an exact pending journal committed before the first rename", (t) => {
  const f = fixture(t);
  const identity = pendingIdentity(f);
  writeMarker(f.canonical, identity);
  installPending(f.store, identity);
  f.store.close();

  const reopened = new AgentStore(f.dataDir);
  try {
    assert.equal(existsSync(f.canonical), true);
    assert.equal(reopened.getAgent(f.agent.id)?.id, f.agent.id);
    assert.equal(reopened.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM agent_deletion_pending WHERE agent_id = ?",
    ).get(f.agent.id).count, 0);
  } finally {
    reopened.close();
  }
});

test("startup restores an exact pending Agent rename from before projection commit", (t) => {
  const f = fixture(t);
  const identity = pendingIdentity(f);
  const tombstone = join(f.directory, identity.tombstoneName);
  writeMarker(f.canonical, identity);
  installPending(f.store, identity);
  renameSync(f.canonical, tombstone);
  f.store.close();

  const reopened = new AgentStore(f.dataDir);
  try {
    assert.equal(existsSync(tombstone), false);
    assert.equal(existsSync(f.canonical), true);
    assert.equal(reopened.getAgent(f.agent.id)?.id, f.agent.id);
  } finally {
    reopened.close();
  }
});

test("startup fails closed when a pending Agent deletion loses both exact paths", (t) => {
  const f = fixture(t);
  const identity = pendingIdentity(f);
  const preserved = join(f.dataDir, "preserved-agent-directory");
  writeMarker(f.canonical, identity);
  installPending(f.store, identity);
  f.store.close();
  renameSync(f.canonical, preserved);

  assert.throws(() => new AgentStore(f.dataDir), /no recoverable canonical storage/u);
  assert.equal(existsSync(join(preserved, "agent.json")), true);
});

test("startup fails closed on a replaced pending Agent tombstone", (t) => {
  const f = fixture(t);
  const identity = pendingIdentity(f);
  const tombstone = join(f.directory, identity.tombstoneName);
  writeMarker(f.canonical, identity);
  installPending(f.store, identity);
  renameSync(f.canonical, tombstone);
  f.store.close();
  rmSync(tombstone, { recursive: true });
  mkdirSync(tombstone);
  const sentinel = join(tombstone, "KEEP.txt");
  writeFileSync(sentinel, "replacement\n");
  writeFileSync(join(tombstone, markerName), JSON.stringify({
    ...identity,
    ownershipToken: "foreign-token",
  }));

  assert.throws(() => new AgentStore(f.dataDir), /ownership identity does not match/u);
  assert.equal(readFileSync(sentinel, "utf8"), "replacement\n");
  assert.equal(existsSync(f.canonical), false);
});

test("startup fails closed on a symlinked pending Agent tombstone", (t) => {
  const f = fixture(t);
  const identity = pendingIdentity(f);
  const tombstone = join(f.directory, identity.tombstoneName);
  const target = join(f.dataDir, "foreign-target");
  writeMarker(f.canonical, identity);
  installPending(f.store, identity);
  f.store.close();
  renameSync(f.canonical, target);
  symlinkSync(target, tombstone, "dir");

  assert.throws(() => new AgentStore(f.dataDir), /not the owned directory/u);
  assert.equal(existsSync(join(target, "agent.json")), true);
  assert.equal(existsSync(tombstone), true);
});

test("legitimate Agent deletion consumes pending and committed storage phases", (t) => {
  const f = fixture(t);
  const preview = f.store.previewAgentDeletion([f.agent.id]);

  f.store.deleteAgentSubtrees(preview.rootAgentIds, preview.previewHash);

  const receipt = f.store.getAgentDeletionReceiptByPreviewHash(preview.previewHash);
  assert.equal(receipt?.storageCleanupCompleted, true);
  assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_deletion_pending").get().count, 0);
  assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_deletion_tombstones").get().count, 0);
  assert.equal(existsSync(f.canonical), true);
});

test("Agent cleanup retry converges after a crash immediately following audit rename", (t) => {
  const f = fixture(t);
  const identity = pendingIdentity(f);
  const tombstone = join(f.directory, identity.tombstoneName);
  const createdAt = new Date().toISOString();
  writeMarker(f.canonical, identity);
  renameSync(f.canonical, tombstone);
  const previewHash = "a".repeat(64);
  const receiptId = `agent-deletion-${previewHash}`;
  f.store.sqlite.prepare(`
    INSERT INTO agent_deletion_receipts (
      id, project_id, preview_hash, root_agent_ids_json, deleted_agent_ids_json,
      storage_cleanup_completed, server_cleanup_completed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    receiptId,
    f.project.id,
    previewHash,
    JSON.stringify([f.agent.id]),
    JSON.stringify([f.agent.id]),
    createdAt,
    createdAt,
  );
  f.store.sqlite.prepare(`
    INSERT INTO agent_deletion_tombstones (
      agent_id, project_id, conversation_id, tombstone_name, ownership_token, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    f.agent.id,
    f.project.id,
    f.conversation.id,
    identity.tombstoneName,
    identity.ownershipToken,
    createdAt,
  );
  const receipt = f.store.getAgentDeletionReceiptByPreviewHash(previewHash);

  assert.throws(
    () => f.store.finishAgentDeletionStorageCleanup(receipt, () => {
      throw new Error("injected crash after audit rename");
    }),
    /injected crash/u,
  );
  assert.equal(existsSync(tombstone), false);
  assert.equal(existsSync(f.canonical), true);

  f.store.finishAgentDeletionStorageCleanup(receipt);

  assert.equal(f.store.getAgentDeletionReceiptByPreviewHash(previewHash)?.storageCleanupCompleted, true);
});
