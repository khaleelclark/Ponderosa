import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { ResourceAdmission } from "../dist/resource-admission.js";
import { CoordinationV3Scheduler } from "../dist/coordination-v3-scheduler.js";
const MiB = 1024 ** 2;
const healthy = { availableBytes: 1024 * MiB, memoryFullPercent: 0, ioFullPercent: 0, source: "linux_host_and_cgroup" };

test("memory, PSI, hysteresis and startup headroom share one bounded observation", async () => {
  let now = 0, sample = healthy, calls = 0;
  const monitor = new ResourceAdmission({ reserveBytes: 128 * MiB, startupBytes: 64 * MiB }, async () => { calls++; return sample; }, () => now, "linux");
  assert.equal((await monitor.observe()).state, "ready"); assert.equal(monitor.capacity(), 14);
  assert.equal(monitor.snapshot(14).state, "held");
  for (const pressure of [{ availableBytes: 180 * MiB }, { memoryFullPercent: 5 }, { ioFullPercent: 10 }]) {
    sample = { ...healthy, ...pressure }; now += 2000;
    await Promise.all(Array.from({ length: 30 }, () => monitor.observe()));
    assert.equal(monitor.snapshot().state, "held");
    sample = healthy; now += 2000; await monitor.observe(); assert.equal(monitor.snapshot().state, "held");
    now += 2000; await monitor.observe(); assert.equal(monitor.snapshot().state, "ready");
  }
  assert.equal(calls, 10);
  now += 10001; assert.equal(monitor.snapshot().protected, false); assert.equal(monitor.snapshot().reason, "measurement_stale");
});

test("measurement failures and unsupported hosts advertise no protection; unresolved probes cannot multiply or strand work", async () => {
  let now = 0, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const monitor = new ResourceAdmission({}, async () => { calls++; await gate; return healthy; }, () => now, "linux");
  await Promise.all(Array.from({ length: 30 }, () => monitor.observe())); assert.equal(calls, 1);
  now += 11000; await monitor.observe(); assert.equal(calls, 1); assert.equal(monitor.capacity(), Infinity);
  release(); await gate; await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.snapshot().state, "held", "default reserve exceeds this synthetic host's headroom");
  now += 2000; monitor.load = async () => { throw Error("controlled read failure"); }; await monitor.observe();
  assert.equal(monitor.snapshot().state, "unavailable"); assert.equal(monitor.capacity(), Infinity);
  const unavailable = new ResourceAdmission({}, async () => { throw Error("must not run"); }, Date.now, "darwin");
  assert.equal((await unavailable.observe()).state, "unsupported");
  assert.throws(() => new ResourceAdmission({ reserveBytes: NaN }));
});

test("a confirmed resource hold preserves canonical pending activation without leasing or failed-delivery attempts; recovery resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pressure-pending-")), store = new AgentStore(root), coordination = new CoordinationV3Store(store.sqlite);
  let now = 0, sample = { ...healthy, memoryFullPercent: 8 }, starts = 0;
  const monitor = new ResourceAdmission({ reserveBytes: 128 * MiB, startupBytes: 64 * MiB }, async () => sample, () => now, "linux");
  const project = store.createProject({ label: "Disposable", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Disposable" });
  const agent = store.createAgent(project.id, { title: "Pending", engine: "codex", conversationId: chat.id });
  const activation = coordination.enqueueMessageActivation({ projectId: project.id, agentId: agent.id, messageId: "exact-message", kind: "human", dispatchPolicy: "next_run", payload: { text: "exact authored text" } });
  const scheduler = new CoordinationV3Scheduler(coordination, async () => { starts++; return { accepted: true }; }, { workerId: "disposable", blockedAgentIds: async () => { await monitor.observe(); return monitor.snapshot().state === "held" ? [agent.id] : []; } });
  try {
    for (let i = 0; i < 10; i++) { now += 2000; await scheduler.drainOnce(); }
    assert.equal(starts, 0); assert.equal(coordination.activeRunCount(), 0);
    const before = store.sqlite.prepare("SELECT * FROM agent_activations WHERE id=?").get(activation);
    assert.equal(before.state, "pending"); assert.equal(before.delivery_failures, 0);
    sample = healthy; now += 2000; await scheduler.drainOnce(); assert.equal(starts, 0);
    now += 2000; await scheduler.drainOnce(); assert.equal(starts, 1);
    assert.equal(store.sqlite.prepare("SELECT delivery_failures FROM agent_activations WHERE id=?").get(activation).delivery_failures, 0);
  } finally { await scheduler.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
