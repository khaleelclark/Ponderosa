import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

test("legacy deleted Agents without Chats do not crash historical DTO reads", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-legacy-agent-read-"));
  const store = new AgentStore(dataDir);
  try {
    const project = store.createProject({ label: "Upgrade", hostPath: dataDir, defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Chat" });
    const legacy = store.createAgent(project.id, { title: "Legacy", engine: "codex", conversationId: chat.id });
    const current = store.createAgent(project.id, { title: "Current", engine: "codex", conversationId: chat.id });
    const deletedAt = new Date().toISOString();
    store.sqlite.prepare("UPDATE agents SET deleted_at = ?, archived = 1, conversation_id = NULL WHERE id = ?").run(deletedAt, legacy.id);
    const before = store.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(legacy.id);
    assert.equal(store.getAgentDetail(legacy.id), undefined);
    assert.deepEqual(store.getProjectedAgentMessages(legacy.id), []);
    assert.equal(store.getAgentDetail(current.id).agent.id, current.id);
    assert.deepEqual(store.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(legacy.id), before);
    // Modern deleted Agents retain their existing historical DTO behavior.
    store.sqlite.prepare("UPDATE agents SET deleted_at = ?, archived = 1 WHERE id = ?").run(deletedAt, current.id);
    assert.equal(store.getAgentDetail(current.id).agent.deletedAt, deletedAt);
    // A malformed live Agent must still fail closed rather than disappear.
    store.sqlite.prepare("UPDATE agents SET deleted_at = NULL, conversation_id = NULL WHERE id = ?").run(current.id);
    assert.throws(() => store.getAgentDetail(current.id), /has no owner Chat/);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
