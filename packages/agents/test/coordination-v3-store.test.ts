import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinationV3Store } from "../src/coordination-v3-store.js";
import { openDb, type OpenedDb } from "../src/db.js";

let opened: OpenedDb;
let store: CoordinationV3Store;
let projectId: string;
let requesterId: string;
let recipientA: string;
let recipientB: string;

function seed(): void {
  projectId = randomUUID();
  requesterId = randomUUID();
  recipientA = randomUUID();
  recipientB = randomUUID();
  opened.client.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'V3', '/repo', '2026-07-15T00:00:00.000Z', 'codex')
  `).run(projectId);
  const insert = opened.client.prepare(`
    INSERT INTO agents (
      id, project_id, title, active_engine, created_at, updated_at, archived
    ) VALUES (?, ?, ?, 'codex', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
  `);
  insert.run(requesterId, projectId, "Requester");
  insert.run(recipientA, projectId, "A");
  insert.run(recipientB, projectId, "B");
}

beforeEach(() => {
  opened = openDb(":memory:");
  store = new CoordinationV3Store(opened.client);
  seed();
});

afterEach(() => opened.client.close());

const indefinite = { kind: "indefinite" as const };

describe("CoordinationV3Store transactions", () => {
  it("creates requests, an immutable join, activations, and an outbox atomically", () => {
    const input = {
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "coordinate-1",
      requests: [
        { requestId: "request-a", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "request-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: { id: "join-1", mode: "all" as const },
    };
    expect(store.coordinate(input)).toEqual({
      requestIds: ["request-a", "request-b"], joinId: "join-1", replayed: false,
    });
    expect(store.coordinate(input)).toEqual({
      requestIds: ["request-a", "request-b"], joinId: "join-1", replayed: true,
    });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_requests").get()).toEqual({ count: 2 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_join_members").get()).toEqual({ count: 2 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM agent_activations").get()).toEqual({ count: 2 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM activation_outbox").get()).toEqual({ count: 2 });
    expect(() => store.coordinate({ ...input, requests: input.requests.slice(0, 1) })).toThrow("collision");
  });

  it("rolls back the whole coordinate operation if one recipient is invalid", () => {
    expect(() => store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "bad-batch",
      requests: [
        { requestId: "valid-first", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "invalid-second", recipientAgentId: "missing", lifetime: indefinite },
      ],
    })).toThrow("agent not found");
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_requests").get()).toEqual({ count: 0 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM agent_activations").get()).toEqual({ count: 0 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM activation_outbox").get()).toEqual({ count: 0 });
  });

  it("authorizes updates, correlates questions, and wakes a join owner exactly once", () => {
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "joined",
      requests: [
        { requestId: "a", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: { id: "both", mode: "all" },
    });
    expect(() => store.updateRequest({
      requestId: "a", updateId: "bad", kind: "completed",
      actor: { kind: "agent", id: requesterId },
    })).toThrow("not authorized");

    store.updateRequest({
      requestId: "a", updateId: "q1", kind: "question",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Which format?" },
    });
    expect(store.updateRequest({
      requestId: "a", updateId: "answer1", kind: "answer",
      actor: { kind: "agent", id: requesterId }, inReplyToUpdateId: "q1",
    }).state).toBe("in_progress");
    expect(store.updateRequest({
      requestId: "a", updateId: "done-a", kind: "completed",
      actor: { kind: "agent", id: recipientA },
    }).state).toBe("completed");
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'both'").get()).toEqual({ state: "open" });
    store.updateRequest({
      requestId: "b", updateId: "done-b", kind: "completed",
      actor: { kind: "agent", id: recipientB },
    });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'both'").get()).toEqual({ state: "satisfied" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_satisfied'
    `).get(requesterId)).toEqual({ count: 1 });
    expect(store.updateRequest({
      requestId: "b", updateId: "done-b", kind: "completed",
      actor: { kind: "agent", id: recipientB },
    }).replayed).toBe(true);
  });

  it("keeps request deadlines independent from join deadlines", () => {
    const now = "2026-07-15T00:00:00.000Z";
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "deadlines",
      requests: [
        { requestId: "deadline-a", recipientAgentId: recipientA, lifetime: { kind: "deadline", at: "2026-07-15T00:01:00.000Z" } },
        { requestId: "indefinite-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: { id: "any-deadline", mode: "any", deadlineAt: "2026-07-15T00:02:00.000Z" },
    }, now);
    expect(store.expireDue("2026-07-15T00:01:30.000Z")).toEqual({ requests: 1, joins: 0 });
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'deadline-a'").get())
      .toEqual({ state: "expired" });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'any-deadline'").get())
      .toEqual({ state: "open" });
    expect(store.expireDue("2026-07-15T00:02:30.000Z")).toEqual({ requests: 0, joins: 1 });
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'indefinite-b'").get())
      .toEqual({ state: "open" });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'any-deadline'").get())
      .toEqual({ state: "expired" });
  });

  it("cancels owner joins without redundant wakeups and handles recipient deletion", () => {
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "delete",
      requests: [{ requestId: "delete-a", recipientAgentId: recipientA, lifetime: indefinite }],
      join: { id: "delete-join", mode: "all" },
    });
    expect(store.cancelJoin("delete-join", requesterId)).toBe(true);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind LIKE 'coordination_join_%'
    `).get(requesterId)).toEqual({ count: 0 });

    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "delete-2",
      requests: [{ requestId: "delete-b", recipientAgentId: recipientB, lifetime: indefinite }],
    });
    store.handleAgentDeletion(recipientB, "2026-07-15T01:00:00.000Z");
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'delete-b'").get())
      .toEqual({ state: "recipient_unavailable" });
  });
});

describe("CoordinationV3Store scheduler", () => {
  it("prioritizes human work and coalesces compatible activations once", () => {
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "priority",
      requests: [{ requestId: "priority-request", recipientAgentId: recipientA, lifetime: indefinite }],
    });
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "human-1", kind: "human", payload: { text: "Stop and check" },
    });
    const lease = store.leaseNextRun({ workerId: "worker-1", coalesceLimit: 8 })!;
    expect(lease.agentId).toBe(recipientA);
    expect(lease.activations.map((item) => item.kind)).toEqual(["human_message", "coordination_request"]);
    expect(new Set(lease.activationIds).size).toBe(2);
    expect(store.getAgentAvailability(recipientA)).toBe("running");
  });

  it("retries only before injection and rejects stale fencing tokens", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "retry-1", kind: "ordinary", payload: { text: "Work" },
      now: "2026-07-15T00:00:00.000Z",
    });
    const first = store.leaseNextRun({
      workerId: "worker-1", now: "2026-07-15T00:00:00.000Z", leaseMs: 1_000,
    })!;
    expect(store.failRun({
      runId: first.runId, fencingToken: first.fencingToken, workerId: "worker-1",
      sameRunResumable: false, now: "2026-07-15T00:00:00.500Z", retryDelayMs: 0,
    })).toBe("retry");
    const second = store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:00:00.500Z" })!;
    expect(second.activationIds).toEqual(first.activationIds);
    expect(second.runId).not.toBe(first.runId);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(() => store.completeRun(first.runId, first.fencingToken)).toThrow("stale");
  });

  it("resumes the same injected run when possible and otherwise records ambiguity", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "resume-1", kind: "ordinary", payload: { text: "Work" },
    });
    const resumable = store.leaseNextRun({ workerId: "worker-1" })!;
    store.markRunStarted(resumable.runId, resumable.fencingToken);
    store.markPromptInjecting(resumable.runId, resumable.fencingToken);
    store.markPromptInjected(resumable.runId, resumable.fencingToken);
    expect(store.failRun({
      runId: resumable.runId, fencingToken: resumable.fencingToken,
      workerId: "worker-2", sameRunResumable: true,
    })).toBe("resume_same_run");
    const resumed = opened.client.prepare(`
      SELECT id, status, fencing_token, lease_owner FROM scheduler_runs WHERE id = ?
    `).get(resumable.runId) as { id: string; status: string; fencing_token: number; lease_owner: string };
    expect(resumed).toMatchObject({ id: resumable.runId, status: "leased", lease_owner: "worker-2" });
    expect(resumed.fencing_token).toBeGreaterThan(resumable.fencingToken);

    store.enqueueMessageActivation({
      projectId, agentId: recipientB, messageId: "ambiguous-1", kind: "ordinary", payload: { text: "Work" },
    });
    const ambiguous = store.leaseNextRun({ workerId: "worker-1" })!;
    store.markPromptInjecting(ambiguous.runId, ambiguous.fencingToken);
    store.markPromptInjected(ambiguous.runId, ambiguous.fencingToken);
    expect(store.failRun({
      runId: ambiguous.runId, fencingToken: ambiguous.fencingToken,
      workerId: "worker-2", sameRunResumable: false,
    })).toBe("outcome_unknown");
    expect(store.leaseNextRun({ workerId: "worker-3" })).toBeUndefined();
    expect(opened.client.prepare("SELECT state FROM agent_activations WHERE id = ?").get(ambiguous.activationIds[0]))
      .toEqual({ state: "outcome_unknown" });
  });

  it("treats cancellation as an immediate fenced control-plane operation", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "cancel-1", kind: "human", payload: { text: "Work" },
    });
    const lease = store.leaseNextRun({ workerId: "worker-1" })!;
    const cancellationFence = store.cancelRun(lease.runId);
    expect(cancellationFence).toBeGreaterThan(lease.fencingToken);
    expect(() => store.markRunStarted(lease.runId, lease.fencingToken)).toThrow("stale");
    expect(store.leaseNextRun({ workerId: "worker-2" })).toBeUndefined();
  });

  it("never leaves a correlated request parked when a run omits or loses its outcome", () => {
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "protocol-omission",
      requests: [{ requestId: "omitted", recipientAgentId: recipientA, lifetime: indefinite }],
    });
    const omitted = store.leaseNextRun({ workerId: "worker-1" })!;
    store.completeRun(omitted.runId, omitted.fencingToken);
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'omitted'").get())
      .toEqual({ state: "outcome_unknown" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_outcome'
    `).get(requesterId)).toEqual({ count: 1 });

    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "temporary-dependency",
      requests: [{ requestId: "suspended", recipientAgentId: recipientB, lifetime: indefinite }],
    });
    const suspended = store.leaseNextRun({ workerId: "worker-1" })!;
    store.updateRequest({
      requestId: "suspended", updateId: "waiting", kind: "waiting_dependency",
      actor: { kind: "agent", id: recipientB }, payload: { dependency: "external" },
    });
    store.completeRun(suspended.runId, suspended.fencingToken);
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'suspended'").get())
      .toEqual({ state: "waiting_dependency" });

    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "ambiguous-request",
      requests: [{ requestId: "ambiguous-request", recipientAgentId: recipientB, lifetime: indefinite }],
    });
    const ambiguous = store.leaseNextRun({ workerId: "worker-1" })!;
    store.markPromptInjecting(ambiguous.runId, ambiguous.fencingToken);
    store.markPromptInjected(ambiguous.runId, ambiguous.fencingToken);
    expect(store.failRun({
      runId: ambiguous.runId, fencingToken: ambiguous.fencingToken,
      workerId: "worker-2", sameRunResumable: false,
    })).toBe("outcome_unknown");
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'ambiguous-request'").get())
      .toEqual({ state: "outcome_unknown" });
  });

  it("reclaims a crashed outbox claim without losing the wake cause", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "outbox-1", kind: "human", payload: { text: "Wake" },
      now: "2026-07-15T00:00:00.000Z",
    });
    const first = store.claimOutbox("dispatcher-1", 10, "2026-07-15T00:00:01.000Z", 30_000);
    expect(first).toHaveLength(1);
    expect(store.claimOutbox("dispatcher-2", 10, "2026-07-15T00:00:02.000Z", 30_000)).toHaveLength(0);
    const reclaimed = store.claimOutbox("dispatcher-2", 10, "2026-07-15T00:00:32.000Z", 30_000);
    expect(reclaimed).toEqual([expect.objectContaining({
      id: first[0]!.id, activationId: first[0]!.activationId, attempts: 2,
    })]);
    store.completeOutbox(reclaimed[0]!.id, "dispatcher-2");
    expect(store.claimOutbox("dispatcher-3", 10, "2026-07-15T00:01:10.000Z", 30_000)).toHaveLength(0);
  });

  it("recovers a pre-injection lease after a process restart", () => {
    opened.client.close();
    const dir = mkdtempSync(join(tmpdir(), "ponderosa-v3-restart-"));
    const file = join(dir, "state.db");
    try {
      opened = openDb(file);
      store = new CoordinationV3Store(opened.client);
      seed();
      store.enqueueMessageActivation({
        projectId, agentId: recipientA, messageId: "restart-1", kind: "ordinary", payload: { text: "Work" },
        now: "2026-07-15T00:00:00.000Z",
      });
      const before = store.leaseNextRun({
        workerId: "dead-worker", now: "2026-07-15T00:00:00.000Z", leaseMs: 1_000,
      })!;
      opened.client.close();
      opened = openDb(file);
      store = new CoordinationV3Store(opened.client);
      const recovered = store.leaseNextRun({ workerId: "new-worker", now: "2026-07-15T00:00:02.000Z" })!;
      expect(recovered.activationIds).toEqual(before.activationIds);
      expect(recovered.runId).not.toBe(before.runId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
