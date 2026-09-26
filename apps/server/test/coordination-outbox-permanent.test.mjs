import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import {
  appendQueuedEditRevisionOrThrow,
  requireQueuedEditRevisionOutboxPayload,
} from "../dist/coordination-scheduler-service.js";
import { CoordinationV3Scheduler, PermanentOutboxError } from "../dist/coordination-v3-scheduler.js";

test("malformed revision signal dead-letters once and keeps its Activation blocked for repair", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-poison-outbox-"));
  const store = new AgentStore(directory);
  try {
    const coordination = new CoordinationV3Store(store.sqlite);
    const project = store.createProject({ label: "Poison", hostPath: "/tmp/poison", defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Chat" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: chat.id });
    const activationId = coordination.enqueueMessageActivation({
      projectId: project.id, agentId: agent.id, messageId: "message-1",
      kind: "human", dispatchPolicy: "next_run", payload: { text: "hello" },
    });
    const scheduler = new CoordinationV3Scheduler(coordination, async () => ({ accepted: true }), {
      workerId: "worker",
      processOutbox: item => {
        if (item.eventKind !== "communication_revision") return;
        appendQueuedEditRevisionOrThrow(store, requireQueuedEditRevisionOutboxPayload(item));
      },
    });
    store.sqlite.prepare(`
      INSERT INTO activation_outbox (activation_id, event_kind, payload_json, created_at)
      VALUES (?, 'communication_revision', '{}', ?)
    `).run(activationId, new Date().toISOString());

    assert.equal(await scheduler.drainOnce(), 0);
    const row = store.sqlite.prepare(`
      SELECT id, attempts, processed_at, dead_lettered_at, last_error
      FROM activation_outbox WHERE activation_id = ? AND event_kind = 'communication_revision'
    `).get(activationId);
    assert.equal(row.attempts, 1);
    assert.equal(row.processed_at, null);
    assert.ok(row.dead_lettered_at);
    assert.equal(row.last_error, "invalid queued-edit revision outbox payload");
    assert.equal(coordination.schedulerMetrics().deadLetteredActivationOutbox, 1);
    assert.equal(coordination.leaseNextRun({ workerId: "worker" }), undefined);
    assert.equal(await scheduler.drainOnce(), 0);
    assert.equal(store.sqlite.prepare("SELECT attempts FROM activation_outbox WHERE id = ?").get(row.id).attempts, 1);

    const missingTarget = {
      activationId, agentId: agent.id, conversationId: chat.id,
      revision: {
        eventId: "revision-1", schemaVersion: 1, kind: "edit",
        projectId: project.id, conversationId: chat.id,
        targetEventId: "missing", sender: { kind: "user", userId: "operator" },
        text: "corrected", createdAt: new Date().toISOString(), idempotencyKey: "edit-1",
      },
    };
    assert.throws(
      () => appendQueuedEditRevisionOrThrow(store, requireQueuedEditRevisionOutboxPayload({ activationId, payload: missingTarget })),
      error => error instanceof PermanentOutboxError && /target not found/u.test(error.message),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
