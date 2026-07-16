import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinationV3Store, openDb } from "@ponderosa/agents";
import type { SchedulerLease } from "@ponderosa/agents";
import { CoordinationV3Scheduler, formatActivationPrompt } from "../src/coordination-v3-scheduler.js";

let opened: ReturnType<typeof openDb>;
let store: CoordinationV3Store;
let projectId: string;
let agentA: string;
let agentB: string;

beforeEach(() => {
  opened = openDb(":memory:");
  store = new CoordinationV3Store(opened.client);
  projectId = randomUUID();
  agentA = randomUUID();
  agentB = randomUUID();
  opened.client.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'V3', '/repo', '2026-07-15T00:00:00.000Z', 'codex')
  `).run(projectId);
  const insert = opened.client.prepare(`
    INSERT INTO agents (id, project_id, title, active_engine, created_at, updated_at, archived)
    VALUES (?, ?, ?, 'codex', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
  `);
  insert.run(agentA, projectId, "A");
  insert.run(agentB, projectId, "B");
});

afterEach(() => opened.client.close());

describe("Communication V3 central scheduler", () => {
  it("tells requesters to consume joined outcomes without redundant updates", () => {
    const prompt = formatActivationPrompt({
      runId: "run", projectId, agentId: agentA, scopeKey: "conversation:test", fencingToken: 1,
      leaseOwner: "scheduler", leaseExpiresAt: "2026-07-15T00:01:00.000Z",
      injectionId: "injection",
      activationIds: ["activation"],
      activations: [{
        id: "activation", kind: "coordination_join_satisfied", priority: 70,
        dispatchPolicy: "next_run", promptClass: "coordination", payload: {
        joinId: "join", state: "satisfied", outcomes: [{ requestId: "request", state: "completed" }],
      } }],
    });
    expect(prompt).toContain("For an outbound request, do not repeat or forward the recipient's update");
    expect(prompt).toContain("If the request itself asks for information or consultation, send that reply as completed");
    expect(prompt).toContain("send exactly one terminal request update only after all work and edits are complete");
    expect(prompt).toContain('"requestId":"request"');
  });

  it("recovers a retryable dispatch rejection without losing or duplicating its activation", async () => {
    let clock = Date.parse("2026-07-15T00:00:00.000Z");
    store.enqueueMessageActivation({
      projectId, agentId: agentA, messageId: "retry", kind: "human", payload: { text: "Wake" },
      now: new Date(clock).toISOString(),
    });
    const leases: SchedulerLease[] = [];
    let attempts = 0;
    const scheduler = new CoordinationV3Scheduler(store, async (lease) => {
      leases.push(lease);
      attempts += 1;
      if (attempts === 1) return { accepted: false, retryable: true, error: "claim race" };
      store.markRunStarted(lease.runId, lease.fencingToken);
      store.markPromptSubmitted({
        injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      });
      store.acknowledgePromptInjection({
        injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      });
      return { accepted: true };
    }, { workerId: "scheduler", now: () => clock, maxConcurrentRuns: 2 });

    expect(await scheduler.drainOnce()).toBe(1);
    expect(attempts).toBe(1);
    expect(store.schedulerMetrics()).toMatchObject({ pendingActivations: 1, activeRuns: 0, failedRuns: 1 });
    clock += 499;
    expect(await scheduler.drainOnce()).toBe(0);
    clock += 1;
    expect(await scheduler.drainOnce()).toBe(1);
    expect(attempts).toBe(2);
    expect(leases[1]!.activationIds).toEqual(leases[0]!.activationIds);
    expect(leases[1]!.runId).not.toBe(leases[0]!.runId);
    expect(scheduler.snapshotMetrics()).toMatchObject({
      claimedRuns: 2, acceptedRuns: 1, rejectedRuns: 1, outboxSignals: 1,
    });
  });

  it("enforces one central concurrency budget across agents", async () => {
    const now = "2026-07-15T00:00:00.000Z";
    store.enqueueMessageActivation({ projectId, agentId: agentA, messageId: "a", kind: "ordinary", payload: {}, now });
    store.enqueueMessageActivation({ projectId, agentId: agentB, messageId: "b", kind: "ordinary", payload: {}, now });
    const leases: SchedulerLease[] = [];
    const scheduler = new CoordinationV3Scheduler(store, async (lease) => {
      leases.push(lease);
      store.markRunStarted(lease.runId, lease.fencingToken);
      store.markPromptSubmitted({
        injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      });
      store.acknowledgePromptInjection({
        injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      });
      return { accepted: true };
    }, { workerId: "scheduler", now: () => Date.parse(now), maxConcurrentRuns: 1 });

    expect(await scheduler.drainOnce()).toBe(1);
    expect(store.activeRunCount()).toBe(1);
    expect(await scheduler.drainOnce()).toBe(0);
    store.completeRun(leases[0]!.runId, leases[0]!.fencingToken, now);
    expect(await scheduler.drainOnce()).toBe(1);
    expect(leases).toHaveLength(2);
    expect(leases[1]!.agentId).not.toBe(leases[0]!.agentId);
  });

  it("emits explicit references instead of silently dropping oversized activation payloads", () => {
    const prompt = formatActivationPrompt({
      runId: "run", projectId, agentId: agentA, scopeKey: "conversation:test", fencingToken: 1,
      leaseOwner: "scheduler", leaseExpiresAt: "2026-07-15T00:01:00.000Z",
      injectionId: "injection", activationIds: ["large"],
      activations: [{
        id: "large", kind: "coordination_join_satisfied", priority: 70,
        dispatchPolicy: "next_run", promptClass: "coordination", payload: { report: "x".repeat(20_000) },
      }],
    }, { maxChars: 4_000, maxInlineChars: 500 });
    expect(prompt).toContain("overflow: explicit");
    expect(prompt).toContain("ponderosa://activation/large");
    expect(prompt).not.toContain("x".repeat(501));
  });

  it("waits for an in-flight drain before shutdown completes", async () => {
    store.enqueueMessageActivation({
      projectId, agentId: agentA, messageId: "shutdown", kind: "human", payload: { text: "Wake" },
    });
    let releaseDispatch!: () => void;
    const dispatchBlocked = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const scheduler = new CoordinationV3Scheduler(store, async (lease) => {
      await dispatchBlocked;
      store.markRunStarted(lease.runId, lease.fencingToken);
      store.markPromptSubmitted({
        injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      });
      store.acknowledgePromptInjection({
        injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      });
      return { accepted: true };
    }, { workerId: "scheduler" });

    const drain = scheduler.drainOnce();
    await Promise.resolve();
    let stopped = false;
    const stop = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseDispatch();
    await Promise.all([drain, stop]);
    expect(stopped).toBe(true);
  });

  it("contains a cancellation race after submitted steering without rejecting the drain", async () => {
    store.enqueueMessageActivation({
      projectId, agentId: agentA, messageId: "base-run", kind: "ordinary", payload: { text: "Base" },
    });
    const run = store.leaseNextRun({ workerId: "scheduler" })!;
    store.preparePromptInjection({
      injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken, prompt: "base",
    });
    store.markRunStarted(run.runId, run.fencingToken);
    store.markPromptSubmitted({
      injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken,
    });
    store.acknowledgePromptInjection({
      injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken,
    });
    store.enqueueMessageActivation({
      projectId, agentId: agentA, messageId: "racing-steer", kind: "human", payload: { text: "Steer" },
    });
    const scheduler = new CoordinationV3Scheduler(store, async () => {
      throw new Error("new Run dispatch should not occur");
    }, {
      workerId: "scheduler",
      maxConcurrentRuns: 1,
      dispatchSteering: async (steering) => {
        store.markPromptSubmitted({
          injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken,
        });
        store.cancelAgentRun({ agentId: agentA, idempotencyKey: "race-cancel" });
        return { accepted: false, outcomeUnknown: true, error: "provider completion raced cancellation" };
      },
    });

    await expect(scheduler.drainOnce()).resolves.toBe(0);
    expect(store.activeRunCount()).toBe(0);
    expect(opened.client.prepare(`
      SELECT state FROM scheduler_prompt_injections
      WHERE run_id = ? AND kind = 'steer'
    `).get(run.runId)).toEqual({ state: "outcome_unknown" });
  });
});
