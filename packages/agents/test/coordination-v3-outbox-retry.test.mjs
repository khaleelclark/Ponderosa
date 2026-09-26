import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";

test("eight transient revision-signal failures back off and eventually unblock leasing", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-outbox-retry-"));
  const store = new AgentStore(directory);
  try {
    const coordination = new CoordinationV3Store(store.sqlite);
    const project = store.createProject({ label: "Retry", hostPath: "/tmp/retry", defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Chat" });
    const agent = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: conversation.id });
    const at = "2026-09-25T12:00:00.000Z";
    const communication = {
      eventId: "retry-message", schemaVersion: 2,
      projectId: project.id, conversationId: conversation.id,
      sender: { kind: "user", userId: "operator" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "operator", agentId: agent.id },
      text: "hello", createdAt: at,
    };
    coordination.recordRuntimeCommunication({
      id: communication.eventId,
      projectId: project.id,
      sender: communication.sender,
      intent: communication.intent,
      audience: communication.audience,
      payload: {
        communication,
        dispatch: {
          conversationId: conversation.id, text: "hello", activeRunDelivery: "queue",
          recipients: [{ agentId: agent.id, attachments: [] }],
        },
      },
      activations: [{
        agentId: agent.id, kind: "human_message", priority: 100,
        dispatchPolicy: "next_run", promptClass: "human",
        dedupeKey: "retry-message:recipient",
      }],
      now: at,
    });
    const activation = store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id = ?").get(agent.id);
    assert.ok(activation);
    for (const ready of coordination.claimOutbox("worker", 20, at)) {
      coordination.completeOutbox(ready.id, "worker", at);
    }
    store.sqlite.prepare(`
      INSERT INTO activation_outbox (activation_id, event_kind, payload_json, created_at)
      VALUES (?, 'communication_revision', '{}', ?)
    `).run(activation.id, at);
    assert.equal(coordination.leaseNextRun({ workerId: "worker", now: at }), undefined);

    let now = Date.parse(at);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const item = coordination.claimOutbox("worker", 20, new Date(now).toISOString()).find((row) => row.eventKind === "communication_revision");
      assert.ok(item, `attempt ${attempt} remained claimable`);
      coordination.failOutbox(item.id, "worker", "temporary SQLite interruption", new Date(now).toISOString());
      assert.equal(coordination.claimOutbox("worker", 20, new Date(now).toISOString()).length, 0);
      now += Math.min(300_000, 1_000 * 2 ** (attempt - 1));
      assert.equal(coordination.leaseNextRun({ workerId: "worker", now: new Date(now).toISOString() }), undefined);
    }
    const recovered = coordination.claimOutbox("worker", 20, new Date(now).toISOString());
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].attempts, 9);
    coordination.completeOutbox(recovered[0].id, "worker", new Date(now).toISOString());
    assert.equal(coordination.schedulerMetrics().deadLetteredActivationOutbox, 0);
    assert.ok(coordination.leaseNextRun({ workerId: "worker", now: new Date(now).toISOString() }));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
