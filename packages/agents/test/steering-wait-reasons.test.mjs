import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";
import { dbPath } from "../dist/paths.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "steering-waits-"));
  let store = new AgentStore(root), c = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({ label: "Test", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Test" });
  const agent = store.createAgent(project.id, { title: "Boston", engine: "codex", conversationId: chat.id });
  const record = (id, policy = "steer_or_run") => {
    const communication = { eventId: id, schemaVersion: 2, projectId: project.id, conversationId: chat.id,
      sender: { kind: "user", userId: "operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "operator", agentId: agent.id }, text: id, createdAt: new Date().toISOString() };
    return c.recordRuntimeCommunication({ id, projectId: project.id, sender: communication.sender,
      intent: communication.intent, audience: communication.audience,
      payload: { communication, dispatch: { conversationId: chat.id, text: id,
        activeRunDelivery: policy === "next_run" ? "queue" : "steer", recipients: [{ agentId: agent.id, attachments: [] }] } },
      activation: { agentId: agent.id, kind: "human_message", priority: 100, dispatchPolicy: policy, promptClass: "human" } });
  };
  record("original", "next_run");
  const run = c.leaseNextRun({ workerId: "fixture", leaseMs: 60_000 });
  const receipt = id => c.deliveryReceiptsForCommunications(project.id, [id]).get(id)?.[0];
  const acknowledge = lease => {
    const ids = { injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken };
    c.preparePromptInjection({ ...ids, prompt: "canonical instructions" }); c.markPromptSubmitted(ids); c.acknowledgePromptInjection(ids);
  };
  return { root, project, chat, agent, run, record, receipt, acknowledge,
    get store() { return store; }, get c() { return c; },
    reopen() { store.close(); store = new AgentStore(root); c = new CoordinationV3Store(store.sqlite); },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("wait reasons follow authoritative barriers, not text, Queue, terminal state or acknowledgement", () => {
  const f = fixture();
  try {
    f.record("steer"); f.record("queue", "next_run");
    assert.equal(f.receipt("steer").steeringWaitReason, "run_starting");
    assert.equal(f.receipt("queue").steeringWaitReason, undefined);
    f.c.markRunStarted(f.run.runId, f.run.fencingToken); f.acknowledge(f.run);
    assert.equal(f.receipt("steer").steeringWaitReason, "scheduler_pending");
    const steering = f.c.leaseNextSteering({ workerId: "fixture" });
    f.record("later");
    assert.equal(f.receipt("steer").steeringWaitReason, undefined);
    assert.equal(f.receipt("later").steeringWaitReason, "prior_steering");
    f.acknowledge(steering);
    assert.equal(f.receipt("steer").providerAcknowledged, true);
    assert.equal(f.receipt("steer").steeringWaitReason, undefined);
    assert.equal(f.receipt("later").steeringWaitReason, "scheduler_pending");
    const revisionActivation = f.store.sqlite.prepare("SELECT id FROM agent_activations WHERE json_extract(payload_json,'$.communication.eventId')='later'").get().id;
    f.store.sqlite.prepare("INSERT INTO activation_outbox (activation_id,event_kind,payload_json,created_at) VALUES (?,'communication_revision','{}',?)").run(revisionActivation, new Date().toISOString());
    assert.equal(f.receipt("later").steeringWaitReason, "revision_pending");
    f.store.sqlite.prepare("UPDATE activation_outbox SET processed_at=? WHERE activation_id=? AND event_kind='communication_revision'").run(new Date().toISOString(), revisionActivation);
    f.c.requestContextRollover({ projectId: f.project.id, agentId: f.agent.id, oldProviderSessionId: "session",
      providerSessionGeneration: "session", detectedOccupancy: 150001, threshold: 150000, lowWaterMark: 75000,
      sourceRunId: f.run.runId, sourceActivationIds: [], scopeKey: `conversation:${f.chat.id}`, conversationId: f.chat.id,
      compactionCutoffOrdinal: 1, compactionCutoffEventId: "original", recentTail: [{ communicationEventId: "original", contentSha256: "a".repeat(64) }] });
    assert.equal(f.receipt("later").steeringWaitReason, "context_refresh");
    assert.equal(f.c.leaseNextSteering({ workerId: "fixture" }), undefined, "same barrier gates leasing");
    f.c.cancelContextRolloverAfterNativeCompaction({ agentId: f.agent.id, providerSessionGeneration: "session", providerSessionId: "session", usedTokens: 50000 });
    assert.equal(f.receipt("later").steeringWaitReason, "scheduler_pending");
    f.c.cancelAgentRun({ agentId: f.agent.id, expectedRunId: f.run.runId, idempotencyKey: "cancel" });
    assert.equal(f.receipt("steer").steeringWaitReason, undefined);
    assert.equal(f.receipt("later").steeringWaitReason, undefined, "no fabricated active-Run waiting reason");
  } finally { f.close(); }
});

test("safe observed deferral survives reopening without changing canonical text or routing", () => {
  for (const reason of ["provider_not_ready", "provider_unsupported", "preparation_retry"]) {
    const f = fixture();
    try {
      f.c.markRunStarted(f.run.runId, f.run.fencingToken); f.acknowledge(f.run); f.record("steer");
      const steer = f.c.leaseNextSteering({ workerId: "fixture" });
      const before = f.store.sqlite.prepare("SELECT payload_json FROM agent_activations WHERE id=?").get(steer.activationIds[0]);
      f.c.deferSteering({ injectionId: steer.injectionId, runId: steer.runId, fencingToken: steer.fencingToken,
        retryDelayMs: 60_000, preserveSteering: true, waitReason: reason });
      f.reopen();
      assert.equal(f.receipt("steer").steeringWaitReason, reason);
      assert.equal(f.receipt("steer").providerAcknowledged, undefined);
      assert.deepEqual(f.store.sqlite.prepare("SELECT payload_json FROM agent_activations WHERE id=?").get(steer.activationIds[0]), before);
      assert.equal(f.store.sqlite.prepare("SELECT dispatch_policy FROM agent_activations WHERE id=?").get(steer.activationIds[0]).dispatch_policy, "steer_or_run");
      f.store.sqlite.prepare("UPDATE agent_activations SET available_at=? WHERE id=?").run("2000-01-01T00:00:00Z", steer.activationIds[0]);
      assert.equal(f.receipt("steer").steeringWaitReason, reason, "retry eligibility is not evidence of provider readiness");
      const retry = f.c.leaseNextSteering({ workerId: "fixture" }); assert.ok(retry);
      assert.equal(f.receipt("steer").steeringWaitReason, undefined, "new admission replaces the old waiting observation");
      assert.equal(f.store.sqlite.prepare("SELECT steering_wait_reason FROM agent_activations WHERE id=?").get(steer.activationIds[0]).steering_wait_reason, null);
      assert.throws(() => f.store.sqlite.prepare("UPDATE agent_activations SET steering_wait_reason='private provider prose' WHERE id=?").run(steer.activationIds[0]), /CHECK/);
    } finally { f.close(); }
  }
});

test("new-Run admission retires an earlier provider deferral instead of carrying it across Runs", () => {
  const f = fixture();
  try {
    f.c.markRunStarted(f.run.runId, f.run.fencingToken); f.acknowledge(f.run); f.record("steer");
    const steer = f.c.leaseNextSteering({ workerId: "fixture" });
    f.c.deferSteering({ injectionId: steer.injectionId, runId: steer.runId, fencingToken: steer.fencingToken,
      retryDelayMs: 0, preserveSteering: true, waitReason: "provider_not_ready" });
    f.c.completeRun(f.run.runId, f.run.fencingToken);
    const next = f.c.leaseNextRun({ workerId: "fixture" }); assert.ok(next);
    assert.notEqual(next.runId, f.run.runId);
    assert.equal(f.store.sqlite.prepare("SELECT steering_wait_reason FROM agent_activations WHERE id=?").get(steer.activationIds[0]).steering_wait_reason, null);
    assert.equal(f.receipt("steer").steeringWaitReason, undefined);
  } finally { f.close(); }
});

test("migration adds no invented historical reason and remains idempotent", () => {
  const f = fixture();
  try {
    const original = f.store.sqlite.prepare("SELECT id,payload_json,state FROM agent_activations ORDER BY id").all();
    f.store.close(); const legacy = new Database(dbPath(f.root));
    legacy.exec("ALTER TABLE agent_activations DROP COLUMN steering_wait_reason; DELETE FROM _schema_version WHERE name='0018_steering_wait_reason.sql'"); legacy.close();
    f.reopen(); f.reopen();
    assert.deepEqual(f.store.sqlite.prepare("SELECT id,payload_json,state FROM agent_activations ORDER BY id").all(), original);
    assert.equal(f.store.sqlite.prepare("SELECT steering_wait_reason FROM agent_activations").get().steering_wait_reason, null);
  } finally { f.close(); }
});
