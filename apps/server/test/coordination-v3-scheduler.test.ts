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
      runId: "run", projectId, agentId: agentA, fencingToken: 1,
      leaseOwner: "scheduler", leaseExpiresAt: "2026-07-15T00:01:00.000Z",
      activationIds: ["activation"],
      activations: [{ id: "activation", kind: "coordination_join_satisfied", priority: 70, payload: {
        joinId: "join", state: "satisfied", outcomes: [{ requestId: "request", state: "completed" }],
      } }],
    });
    expect(prompt).toContain("For an outbound request, do not repeat or forward the recipient's update");
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
      return attempts === 1
        ? { accepted: false, retryable: true, error: "claim race" }
        : { accepted: true };
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
});
