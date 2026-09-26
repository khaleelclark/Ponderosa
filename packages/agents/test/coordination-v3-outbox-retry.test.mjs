import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
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

test("migration retains poisoned historical dead letters until exact audited repair", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-outbox-poison-migration-"));
  let store = new AgentStore(directory);
  try {
    let coordination = new CoordinationV3Store(store.sqlite);
    const project = store.createProject({ label: "Repair", hostPath: "/tmp/repair", defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Chat" });
    const otherChat = store.createConversation(project.id, { title: "Other Chat" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: chat.id });
    const otherAgent = store.createAgent(project.id, { title: "Other Agent", engine: "codex", conversationId: otherChat.id });
    const at = "2026-09-25T12:00:00.000Z";
    const source = {
      eventId: "repair-message", schemaVersion: 2, projectId: project.id,
      conversationId: chat.id, sender: { kind: "user", userId: "operator" },
      intent: "user_dm", audience: { kind: "user_agent", userId: "operator", agentId: agent.id },
      text: "original", createdAt: at,
    };
    store.appendCommunicationEvent(source);
    store.appendCommunicationEvent({ ...source, eventId: "other-message" });
    store.appendCommunicationEvent({
      ...source, eventId: "other-chat-message", conversationId: otherChat.id,
      audience: { ...source.audience, agentId: otherAgent.id },
    });
    const recorded = coordination.recordRuntimeCommunication({
      id: source.eventId, projectId: project.id, sender: source.sender,
      intent: source.intent, audience: source.audience,
      payload: {
        communication: source,
        dispatch: {
          conversationId: chat.id, text: source.text, activeRunDelivery: "queue",
          recipients: [{ agentId: agent.id, attachments: [] }],
        },
      },
      activations: [{
        agentId: agent.id, kind: "human_message", priority: 100,
        dispatchPolicy: "next_run", promptClass: "human",
        dedupeKey: "repair-message:recipient",
      }],
      now: at,
    });
    const activationId = recorded.activationId;
    assert.ok(activationId);
    for (const ready of coordination.claimOutbox("worker", 20, at)) coordination.completeOutbox(ready.id, "worker", at);
    const oldError = "invalid queued-edit revision outbox payload";
    const inserted = store.sqlite.prepare(`
      INSERT INTO activation_outbox (
        activation_id, event_kind, payload_json, created_at, last_error, dead_lettered_at
      ) VALUES (?, 'communication_revision', '{}', ?, ?, ?)
    `).run(activationId, at, oldError, at);
    const outboxId = Number(inserted.lastInsertRowid);
    store.close();

    const oldDb = new Database(join(directory, "ponderosa.db"));
    oldDb.exec(`
      DROP INDEX activation_outbox_available;
      DROP TABLE activation_outbox_repair_audit;
      ALTER TABLE activation_outbox DROP COLUMN available_at;
      DELETE FROM _schema_version WHERE name = '0014_activation_outbox_retry.sql';
    `);
    oldDb.close();

    store = new AgentStore(directory);
    coordination = new CoordinationV3Store(store.sqlite);
    const historical = store.sqlite.prepare(`
      SELECT payload_json, dead_lettered_at, last_error FROM activation_outbox WHERE id = ?
    `).get(outboxId);
    assert.equal(historical.payload_json, "{}");
    assert.equal(historical.last_error, oldError);
    assert.ok(historical.dead_lettered_at);
    assert.equal(coordination.claimOutbox("worker", 20, at).length, 0);
    assert.equal(coordination.schedulerMetrics().deadLetteredActivationOutbox, 1);
    assert.equal(coordination.leaseNextRun({ workerId: "worker", now: at }), undefined);

    const corrected = {
      activationId, agentId: agent.id, conversationId: chat.id,
      revision: {
        eventId: "repair-revision", schemaVersion: 1, kind: "edit",
        projectId: project.id, conversationId: chat.id, targetEventId: "repair-message",
        sender: { kind: "user", userId: "operator" }, text: "corrected",
        createdAt: at, idempotencyKey: "repair-revision-key",
      },
    };
    assert.throws(() => coordination.requeueDeadLetteredRevision(
      outboxId, activationId, oldError, {}, source, "operator correction", at,
    ), /corrected revision payload/u);
    assert.throws(() => coordination.requeueDeadLetteredRevision(
      outboxId, activationId, oldError, {
        ...corrected,
        revision: { ...corrected.revision, targetEventId: "other-message" },
      }, source, "operator correction", at,
    ), /canonical Communication source/u);
    const originalActivationPayload = store.sqlite.prepare(
      "SELECT payload_json FROM agent_activations WHERE id = ?",
    ).get(activationId).payload_json;
    const alteredActivationPayload = JSON.parse(originalActivationPayload);
    alteredActivationPayload.communication.audience.agentId = otherAgent.id;
    store.sqlite.prepare("UPDATE agent_activations SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(alteredActivationPayload), activationId);
    assert.throws(() => coordination.requeueDeadLetteredRevision(
      outboxId, activationId, oldError, corrected, source, "operator correction", at,
    ), /source audience or conversation/u);
    store.sqlite.prepare("UPDATE agent_activations SET payload_json = ? WHERE id = ?")
      .run(originalActivationPayload, activationId);
    assert.equal(store.sqlite.prepare("SELECT count(*) count FROM activation_outbox_repair_audit").get().count, 0);
    const payloadFile = join(directory, "corrected-revision.json");
    writeFileSync(payloadFile, JSON.stringify(corrected));
    store.close();
    const offlineCli = fileURLToPath(new URL("../tools/data-directory.mjs", import.meta.url));
    const listed = JSON.parse(execFileSync(process.execPath, [
      offlineCli, "outbox-list", "--data-dir", directory,
    ], { encoding: "utf8" }));
    assert.equal(listed.rows.find(row => row.id === outboxId)?.last_error, oldError);
    const requeue = (file) => execFileSync(process.execPath, [
      offlineCli,
      "outbox-requeue", "--data-dir", directory,
      "--outbox-id", String(outboxId), "--activation-id", activationId,
      "--expected-error", oldError, "--payload-file", file,
      "--reason", "operator correction",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    for (const [eventId, conversationId] of [["other-message", chat.id], ["other-chat-message", otherChat.id]]) {
      const wrongFile = join(directory, `${eventId}.json`);
      writeFileSync(wrongFile, JSON.stringify({
        ...corrected, conversationId,
        revision: { ...corrected.revision, targetEventId: eventId, conversationId },
      }));
      assert.throws(() => requeue(wrongFile), /canonical user-owned Communication/u);
    }
    const beforeRepair = new Database(join(directory, "ponderosa.db"), { readonly: true });
    assert.equal(beforeRepair.prepare("SELECT count(*) count FROM activation_outbox_repair_audit").get().count, 0);
    assert.ok(beforeRepair.prepare("SELECT dead_lettered_at FROM activation_outbox WHERE id = ?").get(outboxId).dead_lettered_at);
    beforeRepair.close();
    const repairOutput = requeue(payloadFile);
    assert.equal(JSON.parse(repairOutput).status, "requeued");
    store = new AgentStore(directory);
    coordination = new CoordinationV3Store(store.sqlite);
    assert.equal(coordination.schedulerMetrics().deadLetteredActivationOutbox, 0);
    assert.throws(() => coordination.requeueDeadLetteredRevision(
      outboxId, activationId, oldError, corrected, source, "stale retry", at,
    ), /repair target changed/u);
    const audit = store.sqlite.prepare(`
      SELECT previous_payload_json, replacement_payload_json, previous_error, reason
      FROM activation_outbox_repair_audit WHERE outbox_id = ?
    `).get(outboxId);
    assert.equal(audit.previous_payload_json, "{}");
    assert.deepEqual(JSON.parse(audit.replacement_payload_json), corrected);
    assert.equal(audit.previous_error, oldError);
    assert.equal(audit.reason, "operator correction");
    const repairedAt = new Date().toISOString();
    const [ready] = coordination.claimOutbox("worker", 20, repairedAt);
    assert.equal(ready.id, outboxId);
    store.appendCommunicationRevision(ready.payload.revision);
    coordination.completeOutbox(ready.id, "worker", repairedAt);
    assert.ok(coordination.leaseNextRun({ workerId: "worker", now: repairedAt }));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
