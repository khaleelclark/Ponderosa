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

function acknowledgeLease(lease: NonNullable<ReturnType<CoordinationV3Store["leaseNextRun"]>>, prompt = "test prompt"): void {
  store.preparePromptInjection({
    injectionId: lease.injectionId, runId: lease.runId,
    fencingToken: lease.fencingToken, prompt,
  });
  store.markRunStarted(lease.runId, lease.fencingToken);
  store.markPromptSubmitted({
    injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
    providerSessionId: "provider-session",
  });
  store.acknowledgePromptInjection({
    injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
    providerSessionId: "provider-session", providerTurnId: `turn:${lease.runId}`,
  });
}

describe("CoordinationV3Store transactions", () => {
  it("records passive communication without waking and routes actionable communication only through the scheduler", () => {
    const now = "2026-07-15T00:00:00.000Z";
    expect(store.recordRuntimeCommunication({
      id: "broadcast", projectId, sender: { kind: "user" }, intent: "broadcast",
      audience: { kind: "organization", id: projectId }, payload: { text: "FYI" }, now,
    })).toEqual({ id: "broadcast", replayed: false });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM agent_activations").get()).toEqual({ count: 0 });

    const direct = store.recordRuntimeCommunication({
      id: "direct", projectId, sender: { kind: "user" }, intent: "user_dm",
      audience: { kind: "agent", id: requesterId }, payload: { text: "Start" }, now,
      activation: {
        agentId: requesterId, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
    });
    expect(direct.activationId).toBeTruthy();
    expect(opened.client.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(direct.activationId)).toEqual({ state: "pending" });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual({ count: 0 });
    const lease = store.leaseNextRun({ workerId: "server", now })!;
    acknowledgeLease(lease);
    store.completeRun(lease.runId, lease.fencingToken, now);
    expect(opened.client.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(direct.activationId)).toEqual({ state: "consumed" });
    expect(store.recordRuntimeCommunication({
      id: "direct", projectId, sender: { kind: "user" }, intent: "user_dm",
      audience: { kind: "agent", id: requesterId }, payload: { text: "Start" }, now,
      activation: {
        agentId: requesterId, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
    }).replayed).toBe(true);
    expect(store.runtimeCommunications(projectId)).toEqual([
      { id: "broadcast", projectId, payload: { text: "FYI" }, createdAt: now },
      { id: "direct", projectId, payload: { text: "Start" }, createdAt: now },
    ]);
  });

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

  it("creates an immutable join over existing owned requests without duplicating them", () => {
    const created = store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "requests-first", requests: [
        { requestId: "existing-a", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "existing-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
    });
    expect(created.requestIds).toEqual(["existing-a", "existing-b"]);
    const joined = store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "join-later", requests: [],
      join: { id: "existing-join", mode: "all", requestIds: created.requestIds },
    });
    expect(joined).toEqual({ requestIds: [], joinId: "existing-join", replayed: false });
    expect(opened.client.prepare(`
      SELECT request_id FROM coordination_join_members WHERE join_id = 'existing-join' ORDER BY position
    `).all()).toEqual([{ request_id: "existing-a" }, { request_id: "existing-b" }]);
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_requests").get()).toEqual({ count: 2 });
  });

  it("coalesces an equivalent open join created under a new idempotency key", () => {
    const created = store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "joined-at-create", requests: [
        { requestId: "coalesced-a", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "coalesced-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: { id: "canonical-join", mode: "all" },
    });
    const duplicate = store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "redundant-recovery", requests: [],
      join: { id: "redundant-join", mode: "all", requestIds: created.requestIds.slice().reverse() },
    });

    expect(duplicate).toEqual({ requestIds: [], joinId: "canonical-join", replayed: false });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_joins").get()).toEqual({ count: 1 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_join_members").get()).toEqual({ count: 2 });
  });

  it("normalizes new recipient IDs repeated as same-call join request IDs", () => {
    const result = store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "recipient-id-members", requests: [
        { requestId: "normalized-a", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "normalized-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: { id: "normalized-join", mode: "all", requestIds: [recipientA, recipientB] },
    });

    expect(result).toEqual({
      requestIds: ["normalized-a", "normalized-b"], joinId: "normalized-join", replayed: false,
    });
    expect(opened.client.prepare(`
      SELECT request_id FROM coordination_join_members WHERE join_id = 'normalized-join' ORDER BY position
    `).all()).toEqual([{ request_id: "normalized-a" }, { request_id: "normalized-b" }]);
  });

  it("does not mark a request unknown when its requester run answers a correlated question", () => {
    const now = "2026-07-15T00:00:00.000Z";
    store.enqueueMessageActivation({
      projectId, agentId: requesterId, messageId: "human", kind: "human", payload: { text: "Delegate" }, now,
    });
    const requesterRun = store.leaseNextRun({ workerId: "server", now })!;
    acknowledgeLease(requesterRun);
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "question-cycle", requests: [{
        requestId: "question-request", recipientAgentId: recipientA, lifetime: indefinite,
      }], join: { id: "question-join", mode: "all" },
    }, now);
    const recipientRun = store.leaseNextRun({ workerId: "server", now })!;
    acknowledgeLease(recipientRun);
    store.updateRequest({
      requestId: "question-request", updateId: "question-1", kind: "question",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Which contract?" }, now,
    });
    const steering = store.leaseNextSteering({ workerId: "server", now })!;
    store.preparePromptInjection({
      injectionId: steering.injectionId, runId: steering.runId,
      fencingToken: steering.fencingToken, prompt: "question",
    });
    store.markPromptSubmitted({
      injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken,
    });
    store.acknowledgePromptInjection({
      injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken,
    });
    store.updateRequest({
      requestId: "question-request", updateId: "answer-1", kind: "answer",
      actor: { kind: "agent", id: requesterId }, inReplyToUpdateId: "question-1",
      payload: { text: "Use the original contract" }, now,
    });

    store.completeRun(requesterRun.runId, requesterRun.fencingToken, now);
    expect(store.getRequest("question-request")?.state).toBe("in_progress");
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates WHERE kind = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });
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
      actor: { kind: "agent", id: recipientB }, payload: { text: "B finished the review." },
    });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'both'").get()).toEqual({ state: "satisfied" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_satisfied'
    `).get(requesterId)).toEqual({ count: 1 });
    const joinActivation = opened.client.prepare(`
      SELECT payload_json FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_satisfied'
    `).get(requesterId) as { payload_json: string };
    expect(JSON.parse(joinActivation.payload_json)).toEqual({
      joinId: "both",
      outcomes: [
        { requestId: "a", state: "completed", request: null, update: {
          id: "done-a", kind: "completed", payload: null, createdAt: expect.any(String),
        } },
        { requestId: "b", state: "completed", request: null, update: {
          id: "done-b", kind: "completed", payload: { text: "B finished the review." }, createdAt: expect.any(String),
        } },
      ],
      state: "satisfied",
    });
    expect(store.updateRequest({
      requestId: "b", updateId: "done-b", kind: "completed",
      actor: { kind: "agent", id: recipientB }, payload: { text: "B finished the review." },
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
    acknowledgeLease(resumable);
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
    acknowledgeLease(ambiguous);
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
    acknowledgeLease(lease);
    const cancelled = store.cancelAgentRun({ agentId: recipientA, idempotencyKey: "cancel-once" });
    expect(cancelled).toMatchObject({ cancelled: true, replayed: false, runId: lease.runId });
    expect(cancelled.fencingToken).toBeGreaterThan(lease.fencingToken);
    expect(store.cancelAgentRun({ agentId: recipientA, idempotencyKey: "cancel-once" }))
      .toMatchObject({ cancelled: true, replayed: true, runId: lease.runId });
    expect(() => store.markRunStarted(lease.runId, lease.fencingToken)).toThrow("stale");
    expect(store.leaseNextRun({ workerId: "worker-2" })).toBeUndefined();
    const operations = store.claimProviderOperations("supervisor");
    expect(operations).toEqual([expect.objectContaining({ runId: lease.runId, operation: "interrupt", attempts: 1 })]);
    store.completeProviderOperation(operations[0]!.id, "supervisor");
    expect(store.claimProviderOperations("supervisor-2")).toHaveLength(0);
  });

  it("attaches urgent steering to the authoritative run without creating another run", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "initial", kind: "ordinary", payload: { text: "Work" },
    });
    const run = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(run);
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "steer", kind: "human", payload: { text: "Change direction" },
    });
    expect(store.leaseNextRun({ workerId: "worker-2" })).toBeUndefined();
    const steering = store.leaseNextSteering({ workerId: "worker-1" })!;
    expect(steering.runId).toBe(run.runId);
    expect(steering.activationIds).toHaveLength(1);
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual({ count: 1 });
    store.preparePromptInjection({
      injectionId: steering.injectionId, runId: steering.runId,
      fencingToken: steering.fencingToken, prompt: "steering prompt",
    });
    store.markPromptSubmitted({
      injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken,
    });
    store.acknowledgePromptInjection({
      injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken,
      providerTurnId: "steer-turn",
    });
    store.completeRun(run.runId, run.fencingToken);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE state = 'consumed'
    `).get()).toEqual({ count: 2 });
  });

  it("fails closed when a submitted injection cannot be reconciled", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "ambiguous-submission",
      kind: "ordinary", payload: { text: "Work" },
    });
    const lease = store.leaseNextRun({ workerId: "worker-1" })!;
    store.preparePromptInjection({
      injectionId: lease.injectionId, runId: lease.runId,
      fencingToken: lease.fencingToken, prompt: "durable prompt",
    });
    store.markPromptSubmitted({
      injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      providerSessionId: "session",
    });
    expect(store.failRun({
      runId: lease.runId, fencingToken: lease.fencingToken,
      workerId: "recovery", sameRunResumable: false,
    })).toBe("outcome_unknown");
    expect(opened.client.prepare(`
      SELECT state FROM scheduler_prompt_injections WHERE id = ?
    `).get(lease.injectionId)).toEqual({ state: "outcome_unknown" });
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
    acknowledgeLease(omitted);
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
    acknowledgeLease(suspended);
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
    acknowledgeLease(ambiguous);
    expect(store.failRun({
      runId: ambiguous.runId, fencingToken: ambiguous.fencingToken,
      workerId: "worker-2", sameRunResumable: false,
    })).toBe("outcome_unknown");
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'ambiguous-request'").get())
      .toEqual({ state: "outcome_unknown" });
  });

  it("delivers a completed no-join consultation outcome without marking it unknown", () => {
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "no-join-consultation",
      requests: [{
        requestId: "consultation", recipientAgentId: recipientA, lifetime: indefinite,
        payload: { text: "Which response contract should I use?" },
      }],
    });
    const recipientRun = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(recipientRun);
    store.updateRequest({
      requestId: "consultation", updateId: "consultation-result", kind: "completed",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Use the canonical envelope." },
    });
    store.completeRun(recipientRun.runId, recipientRun.fencingToken);

    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'consultation'").get())
      .toEqual({ state: "completed" });
    expect(opened.client.prepare(`
      SELECT kind, state FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_outcome'
    `).all(requesterId)).toEqual([{ kind: "coordination_outcome", state: "pending" }]);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE request_id = 'consultation' AND kind = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });
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
