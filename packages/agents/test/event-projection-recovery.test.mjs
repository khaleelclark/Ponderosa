import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

test("first post-restart Run keeps its pending Communication link", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-projection-restart-"));
  let store = new AgentStore(directory);
  try {
    const project = store.createProject({ label: "Restart", hostPath: "/tmp/restart", defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Chat" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: chat.id });
    store.appendCommunicationEvent({
      eventId: "communication-1", schemaVersion: 2, projectId: project.id,
      conversationId: chat.id, sender: { kind: "user", userId: "operator" },
      intent: "user_dm", audience: { kind: "user_agent", userId: "operator", agentId: agent.id },
      text: "Please help", createdAt: new Date().toISOString(),
    });
    store.appendEvent(agent.id, { type: "user_message", text: "Please help", communicationEventId: "communication-1" });
    store.close();
    store = new AgentStore(directory);
    store.appendEvent(agent.id, {
      type: "agent_lifecycle", executionId: "run-1", status: "running", reason: "active_run",
    });
    const row = store.sqlite.prepare("SELECT communication_event_id FROM runs WHERE id = 'run-1'").get();
    assert.equal(row.communication_event_id, "communication-1");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed SQLite projection fences later appends until canonical replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-projection-failure-"));
  let store = new AgentStore(directory);
  try {
    const project = store.createProject({ label: "Recovery", hostPath: "/tmp/recovery", defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Chat" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: chat.id });
    store.sqlite.exec(`CREATE TRIGGER fail_agent_event BEFORE INSERT ON events
      BEGIN SELECT RAISE(FAIL, 'injected projection failure'); END`);
    assert.throws(() => store.appendEvent(agent.id, { type: "text", delta: "canonical", executionId: "run" }), /injected projection failure/);
    store.sqlite.exec("DROP TRIGGER fail_agent_event");
    assert.throws(() => store.appendEvent(agent.id, { type: "text", delta: "must not append", executionId: "run" }), /restart and replay/);
    assert.equal(store.readEvents(agent.id).length, 1);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) count FROM events WHERE agent_id = ?").get(agent.id).count, 0);
    store.close();
    store = new AgentStore(directory);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) count FROM events WHERE agent_id = ?").get(agent.id).count, 1);
    assert.equal(store.appendEvent(agent.id, { type: "text", delta: "after replay", executionId: "run" }).seq, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
