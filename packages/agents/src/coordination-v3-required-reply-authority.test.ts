import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openDb } from "./db.js";
import { CoordinationV3Store } from "./coordination-v3-store.js";
import type { SchedulerLease } from "./coordination-v3-types.js";

const NOW = "2026-08-14T00:00:00.000Z";
const PROJECT_ID = "project-required-reply";
const CONVERSATION_ID = "conversation-required-reply";
const AGENT_ID = "agent-required-reply";
const SCOPE_KEY = `conversation:${CONVERSATION_ID}`;

const clients: Database.Database[] = [];
afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

function fixture(database = ":memory:"): { sqlite: Database.Database; store: CoordinationV3Store } {
  const { client: sqlite } = openDb(database);
  clients.push(sqlite);
  sqlite.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'Required reply', '/tmp/required-reply', ?, 'codex')
  `).run(PROJECT_ID, NOW);
  sqlite.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at)
    VALUES (?, ?, 'Project chat', ?, ?)
  `).run(CONVERSATION_ID, PROJECT_ID, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO agents (
      id, project_id, conversation_id, title, active_engine, created_at, updated_at
    ) VALUES (?, ?, ?, 'Agent', 'codex', ?, ?)
  `).run(AGENT_ID, PROJECT_ID, CONVERSATION_ID, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO agents (
      id, project_id, conversation_id, title, active_engine, created_at, updated_at
    ) VALUES ('peer-agent', ?, ?, 'Peer', 'codex', ?, ?)
  `).run(PROJECT_ID, CONVERSATION_ID, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
    VALUES (?, ?, 0)
  `).run(AGENT_ID, CONVERSATION_ID);
  sqlite.prepare(`
    INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
    VALUES ('peer-agent', ?, 1)
  `).run(CONVERSATION_ID);
  return { sqlite, store: new CoordinationV3Store(sqlite) };
}

function closeTracked(sqlite: Database.Database): void {
  const index = clients.indexOf(sqlite);
  if (index >= 0) clients.splice(index, 1);
  sqlite.close();
}

function enqueueBroadcast(store: CoordinationV3Store, id: string): void {
  store.recordRuntimeCommunication({
    id,
    projectId: PROJECT_ID,
    scopeKey: SCOPE_KEY,
    sender: { kind: "user", userId: "local-operator" },
    intent: "broadcast",
    audience: { kind: "organization", organizationId: PROJECT_ID },
    payload: {
      communication: {
        schemaVersion: 2,
        eventId: id,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        sender: { kind: "user", userId: "local-operator" },
        intent: "broadcast",
        audience: { kind: "organization", organizationId: PROJECT_ID },
        text: "Please report the result in Project chat.",
        createdAt: NOW,
      },
    },
    activation: {
      agentId: AGENT_ID,
      kind: "human_message",
      priority: 100,
      dispatchPolicy: "steer_or_run",
      promptClass: "human",
    },
    now: NOW,
  });
}

function enqueueDirect(store: CoordinationV3Store, id: string): void {
  store.recordRuntimeCommunication({
    id,
    projectId: PROJECT_ID,
    scopeKey: SCOPE_KEY,
    sender: { kind: "user", userId: "local-operator" },
    intent: "user_dm",
    audience: { kind: "user_agent", userId: "local-operator", agentId: AGENT_ID },
    payload: {
      communication: {
        schemaVersion: 2,
        eventId: id,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        sender: { kind: "user", userId: "local-operator" },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: AGENT_ID },
        text: "Please reply privately.",
        createdAt: NOW,
      },
    },
    activation: {
      agentId: AGENT_ID,
      kind: "human_message",
      priority: 100,
      dispatchPolicy: "steer_or_run",
      promptClass: "human",
    },
    now: NOW,
  });
}

function enqueuePeerMessage(
  store: CoordinationV3Store,
  id: string,
  kind: "ordinary_message" | "urgent_message",
): void {
  store.recordRuntimeCommunication({
    id,
    projectId: PROJECT_ID,
    scopeKey: SCOPE_KEY,
    sender: { kind: "agent", agentId: "peer-agent" },
    intent: "collaboration",
    audience: { kind: "agents", agentIds: [AGENT_ID] },
    payload: {
      communication: {
        schemaVersion: 2,
        eventId: id,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        sender: { kind: "agent", agentId: "peer-agent" },
        intent: "collaboration",
        audience: { kind: "agents", agentIds: [AGENT_ID] },
        text: "Peer input",
        createdAt: NOW,
      },
    },
    activation: {
      agentId: AGENT_ID,
      kind,
      priority: kind === "urgent_message" ? 90 : 50,
      dispatchPolicy: kind === "urgent_message" ? "steer_or_run" : "next_run",
      promptClass: kind === "urgent_message" ? "blocker" : "ordinary",
      dedupeKey: `peer:${id}`,
    },
    now: NOW,
  });
}

function injectRun(store: CoordinationV3Store, lease: SchedulerLease): void {
  store.preparePromptInjection({
    injectionId: lease.injectionId,
    runId: lease.runId,
    fencingToken: lease.fencingToken,
    prompt: "bounded provider prompt",
    now: NOW,
  });
  store.markPromptSubmitted({
    injectionId: lease.injectionId,
    runId: lease.runId,
    fencingToken: lease.fencingToken,
    now: NOW,
  });
  store.markRunStarted(lease.runId, lease.fencingToken, NOW);
  store.acknowledgePromptInjection({
    injectionId: lease.injectionId,
    runId: lease.runId,
    fencingToken: lease.fencingToken,
    now: NOW,
  });
}

describe("durable required reply recovery", () => {
  test("queues one recovery when a Run ends with Work-log output only", () => {
    const { sqlite, store } = fixture();
    enqueueBroadcast(store, "broadcast-a");
    const lease = store.leaseNextRun({ workerId: "worker-a", now: NOW })!;
    expect(store.requiredReplyObligationForRun(lease.runId)).toMatchObject({
      state: "pending",
      replyAuthority: { intent: "broadcast" },
    });
    injectRun(store, lease);

    store.completeRun(lease.runId, lease.fencingToken, NOW);
    const recovered = store.requiredReplyObligationForRun(lease.runId)!;
    expect(recovered).toMatchObject({
      state: "recovery_pending",
      replyAuthority: { intent: "broadcast" },
    });
    expect(sqlite.prepare(`
      SELECT kind, state, payload_json FROM agent_activations WHERE id = ?
    `).get(recovered.recoveryActivationId) as {
      kind: string; state: string; payload_json: string;
    }).toMatchObject({
      kind: "required_reply_recovery",
      state: "pending",
    });
    expect(JSON.parse((sqlite.prepare(`
      SELECT payload_json FROM agent_activations WHERE id = ?
    `).get(recovered.recoveryActivationId) as { payload_json: string }).payload_json)).toMatchObject({
      replyAuthority: { intent: "broadcast" },
      requiredReplyRecovery: { sourceRunId: lease.runId, attempt: 1 },
    });
  });

  test("commits the visible reply and obligation in one SQLite transaction", () => {
    const { sqlite, store } = fixture();
    enqueueBroadcast(store, "broadcast-b");
    const lease = store.leaseNextRun({ workerId: "worker-a", now: NOW })!;
    injectRun(store, lease);

    store.recordRuntimeCommunication({
      id: "reply-b",
      projectId: PROJECT_ID,
      scopeKey: SCOPE_KEY,
      sender: { kind: "agent", agentId: AGENT_ID, executionId: lease.runId },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: PROJECT_ID },
      payload: {
        schemaVersion: 2,
        eventId: "reply-b",
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        sender: { kind: "agent", agentId: AGENT_ID, executionId: lease.runId },
        intent: "broadcast",
        audience: { kind: "organization", organizationId: PROJECT_ID },
        text: "Completed result",
        createdAt: NOW,
      },
      runAuthorization: {
        runId: lease.runId,
        agentId: AGENT_ID,
        fencingToken: lease.fencingToken,
      },
      satisfiesRequiredReply: true,
      now: NOW,
    });
    expect(store.requiredReplyObligationForRun(lease.runId)).toMatchObject({
      state: "satisfied",
      satisfiedCommunicationId: "reply-b",
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM runtime_communications WHERE id = 'reply-b'",
    ).get()).toEqual({ count: 1 });

    store.completeRun(lease.runId, lease.fencingToken, NOW);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'required_reply_recovery'
    `).get()).toEqual({ count: 0 });
  });

  test("does not satisfy the obligation with an explicit Communication on the same route", () => {
    const { store } = fixture();
    enqueueBroadcast(store, "broadcast-explicit");
    const lease = store.leaseNextRun({ workerId: "worker-explicit", now: NOW })!;
    injectRun(store, lease);

    store.recordRuntimeCommunication({
      id: "explicit-broadcast",
      projectId: PROJECT_ID,
      scopeKey: SCOPE_KEY,
      sender: { kind: "agent", agentId: AGENT_ID, executionId: lease.runId },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: PROJECT_ID },
      payload: {
        schemaVersion: 2,
        eventId: "explicit-broadcast",
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        sender: { kind: "agent", agentId: AGENT_ID, executionId: lease.runId },
        intent: "broadcast",
        audience: { kind: "organization", organizationId: PROJECT_ID },
        text: "A separate explicit status",
        createdAt: NOW,
      },
      runAuthorization: {
        runId: lease.runId,
        agentId: AGENT_ID,
        fencingToken: lease.fencingToken,
      },
      now: NOW,
    });

    expect(store.requiredReplyObligationForRun(lease.runId)?.state).toBe("pending");
  });

  test("keeps one obligation per mixed human source and recovers only the unanswered route", () => {
    const { sqlite, store } = fixture();
    enqueueBroadcast(store, "broadcast-mixed");
    enqueueDirect(store, "direct-mixed");
    const lease = store.leaseNextRun({ workerId: "worker-mixed", now: NOW })!;

    expect(lease.activationIds).toHaveLength(2);
    expect(store.requiredReplyObligationForRun(lease.runId)).toBeUndefined();
    expect(store.requiredReplyAuthoritiesForRun(lease.runId)
      .map((authority) => authority.intent).sort()).toEqual([
      "broadcast",
      "direct_to_user",
    ]);
    expect(store.requiredReplyObligationsForRun(lease.runId)).toHaveLength(2);

    injectRun(store, lease);
    store.recordRuntimeCommunication({
      id: "mixed-broadcast-reply",
      projectId: PROJECT_ID,
      scopeKey: SCOPE_KEY,
      sender: { kind: "agent", agentId: AGENT_ID, executionId: lease.runId },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: PROJECT_ID },
      payload: { text: "Shared result" },
      runAuthorization: {
        runId: lease.runId,
        agentId: AGENT_ID,
        fencingToken: lease.fencingToken,
      },
      satisfiesRequiredReply: true,
      now: NOW,
    });
    expect(Object.fromEntries(store.requiredReplyObligationsForRun(lease.runId)
      .map((item) => [item.replyAuthority.intent, item.state]))).toEqual({
      broadcast: "satisfied",
      direct_to_user: "pending",
    });
    store.completeRun(lease.runId, lease.fencingToken, NOW);
    expect(Object.fromEntries(store.requiredReplyObligationsForRun(lease.runId)
      .map((item) => [item.replyAuthority.intent, item.state]))).toEqual({
      broadcast: "satisfied",
      direct_to_user: "recovery_pending",
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
    `).get()).toEqual({ count: 1 });
  });

  test("does not let an unrelated peer Communication suppress a human obligation", () => {
    const { store } = fixture();
    enqueueBroadcast(store, "broadcast-with-peer");
    enqueuePeerMessage(store, "peer-with-broadcast", "ordinary_message");
    const lease = store.leaseNextRun({ workerId: "worker-peer-mixed", now: NOW })!;

    expect(lease.activationIds).toHaveLength(2);
    expect(store.requiredReplyObligationsForRun(lease.runId)).toEqual([
      expect.objectContaining({ replyAuthority: { intent: "broadcast" }, state: "pending" }),
    ]);
  });

  test.each(["ordinary_message", "urgent_message"] as const)(
    "does not create acknowledgement churn for %s peer input",
    (kind) => {
      const { sqlite, store } = fixture();
      enqueuePeerMessage(store, `peer-${kind}`, kind);
      const lease = store.leaseNextRun({ workerId: `worker-${kind}`, now: NOW })!;
      expect(store.requiredReplyObligationsForRun(lease.runId)).toEqual([]);
      injectRun(store, lease);
      store.completeRun(lease.runId, lease.fencingToken, NOW);
      expect(sqlite.prepare(`
        SELECT COUNT(*) AS count FROM agent_activations
        WHERE kind = 'required_reply_recovery'
      `).get()).toEqual({ count: 0 });
    },
  );

  test("recovers an injected Run when its lease expires", () => {
    const { sqlite, store } = fixture();
    enqueueBroadcast(store, "broadcast-expired");
    const lease = store.leaseNextRun({ workerId: "worker-expired", now: NOW, leaseMs: 1_000 })!;
    injectRun(store, lease);

    const recoveryLease = store.leaseNextRun({
      workerId: "worker-after-expiry",
      now: "2026-08-14T00:00:02.000Z",
    })!;
    expect(recoveryLease.activations).toEqual([
      expect.objectContaining({ kind: "required_reply_recovery" }),
    ]);
    expect(store.requiredReplyObligationsForRun(lease.runId)).toEqual([
      expect.objectContaining({ state: "superseded" }),
    ]);
    expect(sqlite.prepare(`
      SELECT status FROM scheduler_runs WHERE id = ?
    `).get(lease.runId)).toEqual({ status: "outcome_unknown" });
  });

  test("terminalizes old obligations across retry, cancellation, and deletion preparation", () => {
    {
      const { store } = fixture();
      enqueueBroadcast(store, "broadcast-retry");
      const lease = store.leaseNextRun({ workerId: "worker-retry", now: NOW })!;
      expect(store.failRun({
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        workerId: "worker-retry",
        sameRunResumable: false,
        confirmedNotExecuted: true,
        retryDelayMs: 0,
        now: NOW,
      })).toBe("retry");
      expect(store.requiredReplyObligationsForRun(lease.runId)[0]?.state).toBe("retried");
      const retried = store.leaseNextRun({ workerId: "worker-retry-next", now: NOW })!;
      expect(store.requiredReplyObligationsForRun(retried.runId)[0]?.state).toBe("pending");
    }
    {
      const { store } = fixture();
      enqueueBroadcast(store, "broadcast-cancel");
      const lease = store.leaseNextRun({ workerId: "worker-cancel", now: NOW })!;
      store.cancelAgentRun({
        agentId: AGENT_ID,
        expectedRunId: lease.runId,
        idempotencyKey: "cancel-required-reply",
        now: NOW,
      });
      expect(store.requiredReplyObligationsForRun(lease.runId)[0]?.state).toBe("cancelled");
    }
    {
      const { store } = fixture();
      enqueueBroadcast(store, "broadcast-agent-delete");
      const lease = store.leaseNextRun({ workerId: "worker-agent-delete", now: NOW })!;
      injectRun(store, lease);
      store.completeRun(lease.runId, lease.fencingToken, NOW);
      expect(store.requiredReplyObligationsForRun(lease.runId)[0]?.state).toBe("recovery_pending");
      store.handleAgentDeletion(AGENT_ID, NOW);
      expect(store.requiredReplyObligationsForRun(lease.runId)[0]?.state).toBe("cancelled");
    }
    {
      const { sqlite, store } = fixture();
      enqueueBroadcast(store, "broadcast-project-delete");
      const lease = store.leaseNextRun({ workerId: "worker-project-delete", now: NOW })!;
      injectRun(store, lease);
      store.completeRun(lease.runId, lease.fencingToken, NOW);
      expect(store.requiredReplyObligationsForRun(lease.runId)[0]?.state).toBe("recovery_pending");
      store.prepareProjectDeletion(PROJECT_ID, NOW);
      expect(store.requiredReplyObligationsForRun(lease.runId)[0]?.state).toBe("cancelled");
      store.purgeProject(PROJECT_ID);
      expect(sqlite.prepare(`
        SELECT COUNT(*) AS count FROM required_reply_obligations
        WHERE project_id = ?
      `).get(PROJECT_ID)).toEqual({ count: 0 });
    }
  });

  test("migration 0005 backfills only an authoritative in-flight human source", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-required-reply-migration-"));
    const database = join(directory, "agents.sqlite");
    const { sqlite, store } = fixture(database);
    enqueueBroadcast(store, "broadcast-upgrade");
    enqueuePeerMessage(store, "peer-upgrade", "ordinary_message");
    const lease = store.leaseNextRun({ workerId: "worker-upgrade", now: NOW })!;
    sqlite.exec("DROP TABLE required_reply_obligations");
    sqlite.prepare("DELETE FROM _schema_version WHERE name = '0005_required_reply_obligations.sql'").run();
    closeTracked(sqlite);

    const reopened = openDb(database).client;
    clients.push(reopened);
    const restartedStore = new CoordinationV3Store(reopened);
    expect(restartedStore.requiredReplyObligationsForRun(lease.runId)).toEqual([
      expect.objectContaining({
        sourceActivationId: lease.activations.find((item) => item.kind === "human_message")!.id,
        replyAuthority: { intent: "broadcast" },
        state: "pending",
      }),
    ]);
    closeTracked(reopened);
    rmSync(directory, { recursive: true, force: true });
  });

  test("missing explicit Request result becomes protocol outcome_unknown", () => {
    const { store } = fixture();
    const coordinated = store.coordinate({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      actorScope: "user:local-operator",
      idempotencyKey: "request-without-explicit-result",
      requests: [{
        recipientAgentId: AGENT_ID,
        lifetime: { kind: "indefinite" },
        payload: { text: "Return a canonical result" },
      }],
    }, NOW);
    const lease = store.leaseNextRun({ workerId: "worker-request", now: NOW })!;
    injectRun(store, lease);

    store.completeRun(lease.runId, lease.fencingToken, NOW);
    expect(store.getRequest(coordinated.requestIds[0]!)?.state).toBe("outcome_unknown");
  });

  test("keeps a required reply recoverable when provider outcome becomes unknown", () => {
    const { sqlite, store } = fixture();
    enqueueBroadcast(store, "broadcast-failure");
    const lease = store.leaseNextRun({ workerId: "worker-failure", now: NOW })!;
    injectRun(store, lease);

    expect(store.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: "worker-failure",
      sameRunResumable: false,
      now: NOW,
    })).toBe("outcome_unknown");
    expect(store.requiredReplyObligationForRun(lease.runId)).toMatchObject({
      state: "recovery_pending",
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
    `).get()).toEqual({ count: 1 });
  });

  test("recovers an injected prior-worker Run idempotently after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-required-reply-"));
    const database = join(directory, "agents.sqlite");
    const { sqlite, store } = fixture(database);
    enqueueBroadcast(store, "broadcast-c");
    const lease = store.leaseNextRun({ workerId: "worker-old", now: NOW })!;
    injectRun(store, lease);
    closeTracked(sqlite);

    const reopened = openDb(database).client;
    clients.push(reopened);
    const restartedStore = new CoordinationV3Store(reopened);

    expect(restartedStore.recoverOrphanedRuns("worker-new", NOW)).toEqual({
      retried: 0,
      outcomeUnknown: 1,
    });
    const recovered = restartedStore.requiredReplyObligationForRun(lease.runId)!;
    expect(recovered.state).toBe("recovery_pending");
    expect(restartedStore.recoverOrphanedRuns("worker-new", NOW)).toEqual({
      retried: 0,
      outcomeUnknown: 0,
    });
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE dedupe_key = ?
    `).get(`required-reply-recovery:${lease.runId}:${lease.activationIds[0]}`)).toEqual({ count: 1 });
    closeTracked(reopened);
    rmSync(directory, { recursive: true, force: true });
  });

  test("stops after six generations with durable operator attention and explicit idempotent retry", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-required-reply-exhausted-"));
    const database = join(directory, "agents.sqlite");
    const { sqlite, store } = fixture(database);
    enqueueBroadcast(store, "broadcast-exhausted");
    const sourceActivationId = (sqlite.prepare(`
      SELECT id FROM agent_activations WHERE kind = 'human_message'
    `).get() as { id: string }).id;

    for (let generation = 0; generation <= 5; generation += 1) {
      const lease = store.leaseNextRun({
        workerId: `worker-exhausted-${generation}`,
        now: `2026-08-14T00:00:0${generation}.000Z`,
      })!;
      expect(lease.activations).toEqual([
        expect.objectContaining({
          kind: generation === 0 ? "human_message" : "required_reply_recovery",
        }),
      ]);
      injectRun(store, lease);
      store.completeRun(
        lease.runId,
        lease.fencingToken,
        `2026-08-14T00:00:0${generation}.500Z`,
      );
    }

    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
    `).get()).toEqual({ count: 5 });
    expect(sqlite.prepare(`
      SELECT state, terminal_outcome, delivery_failures, last_delivery_error
      FROM agent_activations WHERE id = ?
    `).get(sourceActivationId)).toEqual({
      state: "outcome_unknown",
      terminal_outcome: "retry_exhausted",
      delivery_failures: 6,
      last_delivery_error: "Required Chat reply was not published after 6 provider Runs. Automatic recovery stopped; use Try Delivery Again to start an explicit bounded retry.",
    });
    const failedObligation = sqlite.prepare(`
      SELECT state FROM required_reply_obligations
      WHERE attempt_count = 5
    `).get();
    expect(failedObligation).toEqual({ state: "failed" });
    closeTracked(sqlite);

    const reopened = openDb(database).client;
    clients.push(reopened);
    const restartedStore = new CoordinationV3Store(reopened);
    expect(restartedStore.recoverOrphanedRuns("worker-after-exhaustion", NOW)).toEqual({
      retried: 0,
      outcomeUnknown: 0,
    });
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
    `).get()).toEqual({ count: 5 });
    expect(restartedStore.communicationAttentionActivations(PROJECT_ID)).toEqual([
      expect.objectContaining({
        id: sourceActivationId,
        state: "outcome_unknown",
        terminalOutcome: "retry_exhausted",
        deliveryFailures: 6,
        communicationIntent: "broadcast",
      }),
    ]);
    expect(restartedStore.deliveryReceiptsForCommunication(
      PROJECT_ID,
      "broadcast-exhausted",
    )).toEqual([
      expect.objectContaining({
        activationId: sourceActivationId,
        targetAgentId: AGENT_ID,
        state: "retry_exhausted",
        updatedAt: "2026-08-14T00:00:05.500Z",
        attemptCount: 6,
        canRetry: true,
        retryMayDuplicate: true,
      }),
    ]);

    const explicitRetry = restartedStore.retryMessageDelivery({
      projectId: PROJECT_ID,
      activationId: sourceActivationId,
      idempotencyKey: "explicit-required-reply-retry",
      now: "2026-08-14T00:01:00.000Z",
    });
    expect(explicitRetry).toMatchObject({
      accepted: true,
      replayed: false,
      state: "queued",
      retryMayDuplicate: true,
    });
    expect(restartedStore.deliveryReceiptsForCommunication(
      PROJECT_ID,
      "broadcast-exhausted",
    )).toEqual([
      expect.objectContaining({
        activationId: explicitRetry.activationId,
        targetAgentId: AGENT_ID,
        state: "queued",
        updatedAt: "2026-08-14T00:01:00.000Z",
        attemptCount: 7,
      }),
    ]);
    closeTracked(reopened);

    const replayed = openDb(database).client;
    clients.push(replayed);
    const replayedStore = new CoordinationV3Store(replayed);
    expect(replayedStore.retryMessageDelivery({
      projectId: PROJECT_ID,
      activationId: sourceActivationId,
      idempotencyKey: "explicit-required-reply-retry",
      now: "2026-08-14T00:02:00.000Z",
    })).toEqual({ ...explicitRetry, replayed: true });
    const retryLease = replayedStore.leaseNextRun({
      workerId: "worker-explicit-retry",
      now: "2026-08-14T00:02:00.000Z",
    })!;
    expect(retryLease.activationIds).toEqual([explicitRetry.activationId]);
    expect(replayedStore.requiredReplyObligationsForRun(retryLease.runId)).toEqual([
      expect.objectContaining({
        sourceActivationId: explicitRetry.activationId,
        state: "pending",
        attemptCount: 0,
        replyAuthority: { intent: "broadcast" },
      }),
    ]);
    closeTracked(replayed);
    rmSync(directory, { recursive: true, force: true });
  });
});
