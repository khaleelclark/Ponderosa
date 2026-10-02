import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { CoordinationV3Scheduler } from "../dist/coordination-v3-scheduler.js";

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "steering-admission-"));
  const store = new AgentStore(root), coordination = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({ label: "Test", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Test" });
  const agents = ["Active", "Slow", "Third"].map(title => store.createAgent(project.id, { title, engine: "codex", conversationId: chat.id }));
  let sequence = 0;
  const enqueue = (agent, policy = "next_run") => coordination.enqueueMessageActivation({
    projectId: project.id, agentId: agent.id, messageId: `message-${++sequence}`,
    kind: "human", dispatchPolicy: policy, payload: { text: `instructions-${sequence}` },
  });
  enqueue(agents[0]);
  const active = coordination.leaseNextRun({ workerId: "setup", leaseMs: 60_000 });
  coordination.markRunStarted(active.runId, active.fencingToken);
  const acknowledge = lease => {
    coordination.markPromptSubmitted({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken });
    coordination.acknowledgePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken });
  };
  coordination.preparePromptInjection({ injectionId: active.injectionId, runId: active.runId, fencingToken: active.fencingToken, prompt: "original" });
  acknowledge(active);
  return { store, coordination, agents, active, enqueue, acknowledge,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const slowStage of ["preparation", "startup"]) test(`slow other-Agent ${slowStage} does not block exact-Run steering`, async () => {
  const f = fixture(), blocked = gate(), entered = gate();
  const steers = [], starts = [];
  const scheduler = new CoordinationV3Scheduler(f.coordination, async lease => {
    starts.push(lease.agentId);
    if (slowStage === "startup") { entered.release(); await blocked.promise; }
    return { accepted: true };
  }, {
    workerId: "test", maxConcurrentRuns: 2,
    compilePrompt: async lease => {
      if (slowStage === "preparation" && lease.agentId === f.agents[1].id) { entered.release(); await blocked.promise; }
      return { prompt: "exact instructions" };
    },
    dispatchSteering: async lease => { steers.push(lease); f.acknowledge(lease); return { accepted: true }; },
  });
  let pass;
  try {
    f.enqueue(f.agents[1]); pass = scheduler.drainOnce(); await entered.promise;
    const activation = f.enqueue(f.agents[0], "steer_or_run");
    await scheduler.drainOnce();
    assert.equal(steers.length, 1, "steering must proceed before the other Agent's gate is released");
    assert.equal(steers[0].runId, f.active.runId);
    assert.deepEqual(steers[0].activationIds, [activation]);
    await scheduler.drainOnce(); assert.equal(steers.length, 1, "no duplicate submission");
    assert.equal(f.coordination.activeRunCount(), 2, "workspace budget remains authoritative");
  } finally { blocked.release(); await pass; await scheduler.stop(); f.close(); }
});

test("pause/stop await all admitted startup work and do not lease later work", async () => {
  for (const operation of ["pauseLeasing", "stop"]) {
    const f = fixture(), blocked = gate(), entered = gate(); let settled = false;
    const scheduler = new CoordinationV3Scheduler(f.coordination, async () => {
      entered.release(); await blocked.promise; return { accepted: true };
    }, { workerId: "test", maxConcurrentRuns: 2 });
    let pass, barrier;
    try {
      f.enqueue(f.agents[1]); pass = scheduler.drainOnce(); await entered.promise;
      barrier = scheduler[operation]().then(() => { settled = true; });
      await tick(); assert.equal(settled, false, "in-flight startup is included in the drain barrier");
      f.enqueue(f.agents[2]); await scheduler.drainOnce();
      assert.equal(f.coordination.activeRunCount(), 2);
      blocked.release(); await pass; await barrier; assert.equal(settled, true);
    } finally { blocked.release(); await pass; await barrier; await scheduler.stop(); f.close(); }
  }
});

test("polling admits steering while another Agent's startup remains pending", async () => {
  const f = fixture(), blocked = gate(), entered = gate(), steered = gate();
  let timeout;
  const scheduler = new CoordinationV3Scheduler(f.coordination, async () => {
    entered.release(); await blocked.promise; return { accepted: true };
  }, { workerId: "test", maxConcurrentRuns: 2, pollMs: 5,
    dispatchSteering: async lease => { f.acknowledge(lease); steered.release(); return { accepted: true }; } });
  try {
    f.enqueue(f.agents[1]); scheduler.start(); await entered.promise;
    f.enqueue(f.agents[0], "steer_or_run");
    await Promise.race([steered.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("polling blocked behind startup")), 1000); })]);
  } finally { clearTimeout(timeout); blocked.release(); await scheduler.stop(); f.close(); }
});

test("slow steering preparation is isolated; same-Run ordering and Run budget remain bounded", async () => {
  const f = fixture(), blocked = gate(), entered = gate(); const steers = [], starts = [];
  f.enqueue(f.agents[1]);
  const second = f.coordination.leaseNextRun({ workerId: "setup", leaseMs: 60_000 });
  f.coordination.markRunStarted(second.runId, second.fencingToken);
  f.coordination.preparePromptInjection({ injectionId: second.injectionId, runId: second.runId, fencingToken: second.fencingToken, prompt: "original" });
  f.acknowledge(second);
  const scheduler = new CoordinationV3Scheduler(f.coordination, async lease => { starts.push(lease); return { accepted: true }; }, {
    workerId: "test", maxConcurrentRuns: 3,
    compilePrompt: async lease => {
      if (lease.agentId === f.agents[0].id) { entered.release(); await blocked.promise; }
      return { prompt: "exact instructions" };
    }, dispatchSteering: async lease => { steers.push(lease); f.acknowledge(lease); return { accepted: true }; },
  });
  let pass;
  try {
    const first = f.enqueue(f.agents[0], "steer_or_run"); pass = scheduler.drainOnce(); await entered.promise;
    f.enqueue(f.agents[0], "steer_or_run"); f.enqueue(f.agents[1], "steer_or_run"); f.enqueue(f.agents[2]);
    assert.equal(await scheduler.drainOnce(), 1);
    assert.deepEqual(steers.map(lease => lease.runId), [second.runId]);
    assert.equal(starts.length, 1); assert.equal(f.coordination.activeRunCount(), 3);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state IN ('pending','submitted')").get(f.active.runId).n, 1);
    blocked.release(); await pass;
    assert.deepEqual(steers.find(lease => lease.runId === f.active.runId).activationIds, [first]);
    await scheduler.drainOnce(); assert.equal(steers.filter(lease => lease.runId === f.active.runId).length, 2);
  } finally { blocked.release(); await pass; await scheduler.stop(); f.close(); }
});

test("pause or budget reduction during quarantine lookup prevents subsequent admission", async () => {
  for (const change of ["pause", "budget"]) {
    const f = fixture(), blocked = gate(), entered = gate(); let starts = 0;
    const scheduler = new CoordinationV3Scheduler(f.coordination, async () => { starts++; return { accepted: true }; }, {
      workerId: "test", maxConcurrentRuns: 2, blockedAgentIds: async () => { entered.release(); await blocked.promise; return []; },
    });
    let pass, pause;
    try {
      f.enqueue(f.agents[1]); pass = scheduler.drainOnce(); await entered.promise;
      if (change === "pause") pause = scheduler.pauseLeasing(); else scheduler.setMaxConcurrentRuns(1);
      blocked.release(); assert.equal(await pass, 0); await pause;
      assert.equal(starts, 0); assert.equal(f.coordination.activeRunCount(), 1);
    } finally { blocked.release(); await pass; await pause; await scheduler.stop(); f.close(); }
  }
});

test("cancellation during asynchronous preparation fences the job before provider dispatch", async () => {
  const f = fixture(), blocked = gate(), entered = gate(); let starts = 0;
  const scheduler = new CoordinationV3Scheduler(f.coordination, async () => { starts++; return { accepted: true }; }, {
    workerId: "test", maxConcurrentRuns: 2,
    compilePrompt: async () => { entered.release(); await blocked.promise; return { prompt: "exact instructions" }; },
  });
  let pass;
  try {
    f.enqueue(f.agents[1]); pass = scheduler.drainOnce(); await entered.promise;
    const pending = f.store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status='leased'").get(f.agents[1].id);
    f.coordination.cancelAgentRun({ agentId: f.agents[1].id, expectedRunId: pending.id, idempotencyKey: "cancel-preparation" });
    blocked.release(); await pass;
    assert.equal(starts, 0); assert.equal(scheduler.snapshotMetrics().activePreparations, 0);
    assert.equal(f.store.sqlite.prepare("SELECT state FROM scheduler_prompt_injections WHERE run_id=?").get(pending.id).state, "cancelled");
  } finally { blocked.release(); await pass; await scheduler.stop(); f.close(); }
});

test("provider deferral records only an observed category and preserves steering, exact Run, and retry delay", async () => {
  const f = fixture(); let calls = 0;
  const scheduler = new CoordinationV3Scheduler(f.coordination, async () => { throw new Error("must not open a new Run"); }, {
    workerId: "test", dispatchSteering: async () => {
      calls++; return { accepted: false, retryable: true, retrySteering: true, steeringWaitReason: "provider_not_ready" };
    },
  });
  try {
    const activation = f.enqueue(f.agents[0], "steer_or_run");
    await scheduler.drainOnce(); await scheduler.drainOnce();
    assert.equal(calls, 1, "backoff is respected");
    const row = f.store.sqlite.prepare("SELECT state,dispatch_policy,steering_wait_reason FROM agent_activations WHERE id=?").get(activation);
    assert.deepEqual(row, { state: "retry_pending", dispatch_policy: "steer_or_run", steering_wait_reason: "provider_not_ready" });
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?").get(f.agents[0].id).n, 1);
    assert.equal(f.store.sqlite.prepare("SELECT run_id,state FROM scheduler_prompt_injections WHERE kind='steer'").get().run_id, f.active.runId);
  } finally { await scheduler.stop(); f.close(); }
});
