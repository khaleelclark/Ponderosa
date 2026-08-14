import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProviderInputSourceManifest } from "@ponderosa/core";
import { openDb } from "./db.js";
import {
  CoordinationV3Store,
  MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES,
} from "./coordination-v3-store.js";
import type { SchedulerLease } from "./coordination-v3-types.js";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = "project-1";
const CONVERSATION_ID = "conversation-1";
const REQUESTER_ID = "requester";
const RECIPIENT_ID = "recipient";
const SCOPE_KEY = `conversation:${CONVERSATION_ID}`;

const clients: Database.Database[] = [];
const hashFor = (value: string): string => createHash("sha256").update(value).digest("hex");
const handoffTextFor = (rolloverId: string): string => `Durable handoff for ${rolloverId}`;
afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

function storeFixture(): {
  sqlite: Database.Database;
  store: CoordinationV3Store;
} {
  const { client: sqlite } = openDb(":memory:");
  clients.push(sqlite);
  sqlite.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'Project', '/tmp/project', ?, 'codex')
  `).run(PROJECT_ID, NOW);
  sqlite.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at)
    VALUES (?, ?, 'Chat', ?, ?)
  `).run(CONVERSATION_ID, PROJECT_ID, NOW, NOW);
  const insertAgent = sqlite.prepare(`
    INSERT INTO agents (
      id, project_id, conversation_id, title, active_engine,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'codex', ?, ?)
  `);
  insertAgent.run(
    REQUESTER_ID,
    PROJECT_ID,
    CONVERSATION_ID,
    "Requester",
    NOW,
    NOW,
  );
  insertAgent.run(
    RECIPIENT_ID,
    PROJECT_ID,
    CONVERSATION_ID,
    "Recipient",
    NOW,
    NOW,
  );
  const insertMembership = sqlite.prepare(`
    INSERT INTO agent_conversation_memberships (
      agent_id, conversation_id, position
    ) VALUES (?, ?, ?)
  `);
  insertMembership.run(REQUESTER_ID, CONVERSATION_ID, 0);
  insertMembership.run(RECIPIENT_ID, CONVERSATION_ID, 1);
  return { sqlite, store: new CoordinationV3Store(sqlite) };
}

function requestManualRollover(input: {
  store: CoordinationV3Store;
  sourceRunId: string;
  providerSessionGeneration?: string;
  boundaryOrdinal?: number;
  boundaryEventId?: string;
  tailEventId?: string;
  now?: string;
}) {
  const tailEventId = input.tailEventId ?? "manual-tail";
  return input.store.requestContextRollover({
    projectId: PROJECT_ID,
    agentId: RECIPIENT_ID,
    oldProviderSessionId: "provider-old",
    providerSessionGeneration: input.providerSessionGeneration ?? "manual-generation",
    detectedOccupancy: 30_000,
    threshold: 25_000,
    lowWaterMark: 15_000,
    triggerKind: "human",
    compactionCutoffOrdinal: input.boundaryOrdinal ?? 42,
    compactionCutoffEventId: input.boundaryEventId ?? "manual-boundary",
    recentTail: [{
      communicationEventId: tailEventId,
      contentSha256: hashFor(tailEventId),
    }],
    sourceRunId: input.sourceRunId,
    sourceActivationIds: [],
    scopeKey: SCOPE_KEY,
    conversationId: CONVERSATION_ID,
    now: input.now ?? NOW,
  });
}

function retireRollover(input: {
  sqlite: Database.Database;
  store: CoordinationV3Store;
  sourceRunId: string;
  sourceActivationIds: string[];
  replyAuthority?: { intent: "direct_to_user" };
  recentTailCommunicationEventIds?: string[];
}): string {
  const recentTailCommunicationEventIds = input.recentTailCommunicationEventIds ?? ["tail-default"];
  const requested = input.store.requestContextRollover({
    projectId: PROJECT_ID,
    agentId: RECIPIENT_ID,
    oldProviderSessionId: "provider-old",
    providerSessionGeneration: "generation-1",
    detectedOccupancy: 80_000,
    threshold: 75_000,
    lowWaterMark: 25_000,
    compactionCutoffOrdinal: 42,
    compactionCutoffEventId: "communication-cutoff",
    recentTail: recentTailCommunicationEventIds.map((communicationEventId) => ({
      communicationEventId,
      contentSha256: hashFor(communicationEventId),
    })),
    sourceRunId: input.sourceRunId,
    sourceActivationIds: input.sourceActivationIds,
    scopeKey: SCOPE_KEY,
    conversationId: CONVERSATION_ID,
    ...(input.replyAuthority
      ? { replyAuthority: input.replyAuthority }
      : {}),
    now: NOW,
  });
  const handoffActivation = input.sqlite.prepare(`
    SELECT activation.id
    FROM agent_activations activation
    JOIN activation_sources source ON source.activation_id = activation.id
    WHERE activation.kind = 'context_rollover_handoff'
      AND source.source_kind = 'context_rollover'
      AND source.source_id = ?
  `).get(requested.rollover.id) as { id: string };
  const handoffRunId = `handoff-run:${requested.rollover.id}`;
  const nextFence = (input.sqlite.prepare(`
    SELECT next_fencing_token FROM scheduler_agent_fences WHERE agent_id = ?
  `).get(RECIPIENT_ID) as { next_fencing_token: number } | undefined)?.next_fencing_token ?? 1;
  input.sqlite.prepare(`
    INSERT INTO scheduler_agent_fences (agent_id, next_fencing_token)
    VALUES (?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET next_fencing_token = excluded.next_fencing_token
  `).run(RECIPIENT_ID, nextFence + 1);
  input.sqlite.prepare(`
    INSERT INTO scheduler_runs (
      id, project_id, agent_id, status, lease_owner, lease_expires_at,
      fencing_token, prompt_injection_state, provider_session_id,
      heartbeat_at, created_at, updated_at, started_at, terminal_at,
      scope_key, context_disposition
    ) VALUES (?, ?, ?, 'completed', 'handoff-worker', ?, ?, 'injected',
      'provider-old', ?, ?, ?, ?, ?, ?, 'fresh_task')
  `).run(
    handoffRunId, PROJECT_ID, RECIPIENT_ID, NOW, nextFence,
    NOW, NOW, NOW, NOW, NOW, SCOPE_KEY,
  );
  input.sqlite.prepare(`
    INSERT INTO scheduler_run_activations (run_id, activation_id, attached_at, consumed_at)
    VALUES (?, ?, ?, ?)
  `).run(handoffRunId, handoffActivation.id, NOW, NOW);
  input.sqlite.prepare(`
    UPDATE agent_activations
    SET state = 'consumed', consumed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(NOW, NOW, handoffActivation.id);
  input.sqlite.prepare(`
    INSERT INTO scheduler_prompt_injections (
      id, run_id, kind, sequence, state, prompt_hash,
      activation_ids_json, provider_turn_id, created_at, updated_at,
      submitted_at, acknowledged_at, terminal_at
    ) VALUES (?, ?, 'turn', 0, 'acknowledged', ?, ?, 'handoff-turn',
      ?, ?, ?, ?, ?)
  `).run(
    `handoff-injection:${requested.rollover.id}`,
    handoffRunId,
    hashFor("handoff prompt"),
    JSON.stringify([handoffActivation.id]),
    NOW, NOW, NOW, NOW, NOW,
  );
  input.sqlite.prepare(`
    INSERT INTO continuation_handoffs (
      id, agent_id, source_execution_id, text, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    `handoff:${requested.rollover.id}`,
    RECIPIENT_ID,
    handoffRunId,
    handoffTextFor(requested.rollover.id),
    NOW,
  );
  input.store.commitContextRolloverHandoff(
    requested.rollover.id,
    `handoff:${requested.rollover.id}`,
    NOW,
  );
  input.store.beginContextRolloverRetirement(requested.rollover.id, NOW);
  return requested.rollover.id;
}

function replacementManifest(input: {
  activationIds: string[];
  rolloverId: string;
  recentTailCommunicationEventIds?: string[];
  conversationId?: string;
}): ProviderInputSourceManifest {
  const recentTail = input.recentTailCommunicationEventIds ?? ["tail-default"];
  return {
    schemaVersion: 3,
    historyMessageCount: recentTail.length,
    retainedSessionSourceCount: 0,
    activationIds: input.activationIds,
    triggerOccurrenceIds: [],
    communicationEventIds: recentTail,
    artifactIds: [],
    conversationId: input.conversationId ?? CONVERSATION_ID,
    providerSessionDisposition: "reseeded",
    sources: [
      { kind: "identity", ref: RECIPIENT_ID, delivery: "submitted" },
      { kind: "policy", ref: "policy", delivery: "submitted", hash: hashFor("policy") },
      { kind: "team_directory", ref: CONVERSATION_ID, delivery: "submitted", hash: hashFor("team") },
      ...recentTail.map((communicationEventId) => ({
        kind: "communication" as const,
        ref: communicationEventId,
        delivery: "submitted" as const,
        hash: hashFor(communicationEventId),
      })),
      {
        kind: "continuation_handoff",
        ref: `handoff:${input.rolloverId}`,
        delivery: "submitted",
        hash: hashFor(handoffTextFor(input.rolloverId)),
        createdAt: NOW,
      },
      ...input.activationIds.map((activationId) => ({
        kind: "activation" as const,
        ref: activationId,
        delivery: "submitted" as const,
      })),
    ],
  };
}

function requestSourceFixture(): ReturnType<typeof storeFixture> & {
  requestId: string;
  sourceRunId: string;
  sourceFencingToken: number;
  sourceInjectionId: string;
  sourceActivationIds: string[];
} {
  const fixture = storeFixture();
  const requestId = fixture.store.coordinate({
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    requesterAgentId: REQUESTER_ID,
    actorScope: `agent:${REQUESTER_ID}`,
    idempotencyKey: "request-1",
    requests: [{
      recipientAgentId: RECIPIENT_ID,
      lifetime: { kind: "indefinite" },
      payload: { text: "work" },
    }],
  }, NOW).requestIds[0]!;
  const lease = fixture.store.leaseNextRun({ workerId: "worker", now: NOW });
  if (!lease) throw new Error("source Run was not leased");
  return {
    ...fixture,
    requestId,
    sourceRunId: lease.runId,
    sourceFencingToken: lease.fencingToken,
    sourceInjectionId: lease.injectionId,
    sourceActivationIds: lease.activationIds,
  };
}

function recordDirectMessage(input: {
  store: CoordinationV3Store;
  communicationId: string;
  agentId: string;
  text: string;
}): void {
  input.store.recordRuntimeCommunication({
    id: input.communicationId,
    projectId: PROJECT_ID,
    scopeKey: SCOPE_KEY,
    sender: { kind: "user", userId: "local-operator" },
    intent: "user_dm",
    audience: {
      kind: "user_agent",
      userId: "local-operator",
      agentId: input.agentId,
    },
    payload: {
      communication: {
        schemaVersion: 2,
        eventId: input.communicationId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        sender: { kind: "user", userId: "local-operator" },
        intent: "user_dm",
        audience: {
          kind: "user_agent",
          userId: "local-operator",
          agentId: input.agentId,
        },
        text: input.text,
        createdAt: NOW,
      },
    },
    activation: {
      agentId: input.agentId,
      kind: "human_message",
      priority: 100,
      dispatchPolicy: "steer_or_run",
      promptClass: "human",
    },
    now: NOW,
  });
}

function directMessageSourceFixture(
  messageCount = 1,
): ReturnType<typeof storeFixture> & {
  sourceRunId: string;
  sourceFencingToken: number;
  sourceInjectionId: string;
  sourceActivationIds: string[];
} {
  const fixture = storeFixture();
  for (let index = 0; index < messageCount; index += 1) {
    recordDirectMessage({
      store: fixture.store,
      communicationId: messageCount === 1 ? "direct-source" : `direct-source-${index + 1}`,
      agentId: RECIPIENT_ID,
      text: `Please reply privately after completing task ${index + 1}.`,
    });
  }
  const lease = fixture.store.leaseNextRun({
    workerId: "direct-source-worker",
    now: NOW,
  });
  if (!lease) throw new Error("direct-message source Run was not leased");
  return {
    ...fixture,
    sourceRunId: lease.runId,
    sourceFencingToken: lease.fencingToken,
    sourceInjectionId: lease.injectionId,
    sourceActivationIds: lease.activationIds,
  };
}

function directReplyReplacementCandidate(
  sourceAttemptCount = 0,
  sourceMessageCount = 1,
): ReturnType<typeof directMessageSourceFixture> & {
  rolloverId: string;
  candidateRun: SchedulerLease;
  staleRecoveryActivationId: string;
} {
  const fixture = directMessageSourceFixture(sourceMessageCount);
  acknowledgeRun({
    store: fixture.store,
    runId: fixture.sourceRunId,
    fencingToken: fixture.sourceFencingToken,
    injectionId: fixture.sourceInjectionId,
    prompt: "accepted direct-message source prompt",
  });
  const requested = fixture.store.requestContextRollover({
    projectId: PROJECT_ID,
    agentId: RECIPIENT_ID,
    oldProviderSessionId: "provider-old",
    providerSessionGeneration: "generation-direct-reply",
    detectedOccupancy: 80_000,
    threshold: 75_000,
    lowWaterMark: 25_000,
    compactionCutoffOrdinal: 42,
    compactionCutoffEventId: "communication-cutoff",
    recentTail: [{
      communicationEventId: "tail-default",
      contentSha256: hashFor("tail-default"),
    }],
    sourceRunId: fixture.sourceRunId,
    sourceActivationIds: fixture.sourceActivationIds,
    scopeKey: SCOPE_KEY,
    conversationId: CONVERSATION_ID,
    replyAuthority: { intent: "direct_to_user" },
    now: NOW,
  });
  fixture.store.completeRun(
    fixture.sourceRunId,
    fixture.sourceFencingToken,
    NOW,
  );
  const sourceObligation = fixture.store.requiredReplyObligationForRun(
    fixture.sourceRunId,
  );
  if (!sourceObligation?.recoveryActivationId) {
    throw new Error("source required-reply recovery was not queued");
  }
  if (sourceAttemptCount > 0) fixture.sqlite.prepare(`
    UPDATE required_reply_obligations SET attempt_count = ?
    WHERE run_id = ? AND source_activation_id = ?
  `).run(
    sourceAttemptCount,
    fixture.sourceRunId,
    sourceObligation.sourceActivationId,
  );
  const handoffRun = fixture.store.leaseNextRun({
    workerId: "direct-handoff-worker",
    now: NOW,
  });
  if (!handoffRun) throw new Error("direct-message handoff Run was not leased");
  acknowledgeRun({
    store: fixture.store,
    runId: handoffRun.runId,
    fencingToken: handoffRun.fencingToken,
    injectionId: handoffRun.injectionId,
    prompt: "bounded direct-message handoff prompt",
  });
  fixture.sqlite.prepare(`
    INSERT INTO continuation_handoffs (
      id, agent_id, source_execution_id, text, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    `handoff:${requested.rollover.id}`,
    RECIPIENT_ID,
    handoffRun.runId,
    handoffTextFor(requested.rollover.id),
    NOW,
  );
  fixture.store.commitContextRolloverHandoff(
    requested.rollover.id,
    `handoff:${requested.rollover.id}`,
    NOW,
  );
  fixture.store.completeRun(handoffRun.runId, handoffRun.fencingToken, NOW);
  fixture.store.beginContextRolloverRetirement(requested.rollover.id, NOW);
  const continued = fixture.store.prepareContextRolloverContinuation({
    id: requested.rollover.id,
    now: NOW,
  });
  const candidateRun = fixture.store.leaseNextRun({
    workerId: "direct-replacement-worker",
    now: NOW,
  });
  if (!candidateRun || !continued.continuationActivationId) {
    throw new Error("direct-message replacement Run was not leased");
  }
  expect(candidateRun.activationIds).toEqual([
    continued.continuationActivationId,
  ]);
  return {
    ...fixture,
    rolloverId: requested.rollover.id,
    candidateRun,
    staleRecoveryActivationId: sourceObligation.recoveryActivationId,
  };
}

function acknowledgeRun(input: {
  store: CoordinationV3Store;
  runId: string;
  fencingToken: number;
  injectionId: string;
  prompt: string;
}): void {
  input.store.markRunStarted(input.runId, input.fencingToken, NOW);
  input.store.preparePromptInjection({
    injectionId: input.injectionId,
    runId: input.runId,
    fencingToken: input.fencingToken,
    prompt: input.prompt,
    now: NOW,
  });
  input.store.markPromptSubmitted({
    injectionId: input.injectionId,
    runId: input.runId,
    fencingToken: input.fencingToken,
    providerSessionId: "provider-old",
    now: NOW,
  });
  input.store.acknowledgePromptInjection({
    injectionId: input.injectionId,
    runId: input.runId,
    fencingToken: input.fencingToken,
    providerSessionId: "provider-old",
    now: NOW,
  });
}

function activeManualHandoffFixture(): ReturnType<typeof storeFixture> & {
  rolloverId: string;
  handoffRun: SchedulerLease;
  handoffId: string;
} {
  const fixture = storeFixture();
  const sourceActivationId = fixture.store.enqueueMessageActivation({
    projectId: PROJECT_ID,
    agentId: RECIPIENT_ID,
    scopeKey: SCOPE_KEY,
    messageId: "cancellation-source",
    kind: "human",
    payload: { text: "source work" },
    now: NOW,
  });
  const sourceRun = fixture.store.leaseNextRun({ workerId: "source-worker", now: NOW });
  if (!sourceRun) throw new Error("source Run was not leased");
  expect(sourceRun.activationIds).toEqual([sourceActivationId]);
  acknowledgeRun({
    store: fixture.store,
    runId: sourceRun.runId,
    fencingToken: sourceRun.fencingToken,
    injectionId: sourceRun.injectionId,
    prompt: "cancellation source prompt",
  });
  fixture.store.completeRun(sourceRun.runId, sourceRun.fencingToken, NOW);
  const rollover = requestManualRollover({
    store: fixture.store,
    sourceRunId: sourceRun.runId,
    providerSessionGeneration: "cancellation-generation",
  }).rollover;
  const handoffRun = fixture.store.leaseNextRun({ workerId: "handoff-worker", now: NOW });
  if (!handoffRun) throw new Error("handoff Run was not leased");
  acknowledgeRun({
    store: fixture.store,
    runId: handoffRun.runId,
    fencingToken: handoffRun.fencingToken,
    injectionId: handoffRun.injectionId,
    prompt: "cancellation handoff prompt",
  });
  const handoffId = `handoff:${rollover.id}`;
  fixture.sqlite.prepare(`
    INSERT INTO continuation_handoffs (
      id, agent_id, source_execution_id, text, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    handoffId,
    RECIPIENT_ID,
    handoffRun.runId,
    handoffTextFor(rollover.id),
    NOW,
  );
  return { ...fixture, rolloverId: rollover.id, handoffRun, handoffId };
}

describe("context rollover continuation obligations", () => {
  it("retains provider-blocked recovery authority in a structured durable category", () => {
    const fixture = storeFixture();
    const activationId = fixture.store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: "structured-provider-block",
      kind: "human",
      payload: { text: "blocked work" },
      now: NOW,
    });
    const lease = fixture.store.leaseNextRun({ workerId: "blocked-worker", now: NOW });
    if (!lease) throw new Error("provider-blocked Run was not leased");
    expect(fixture.store.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: "blocked-worker",
      sameRunResumable: false,
      confirmedNotExecuted: true,
      failureKind: "capacity",
      error: "contradictory authentication prose",
      now: NOW,
    })).toBe("retry");
    fixture.sqlite.prepare(`
      UPDATE agent_activations SET last_delivery_error = 'Provider execution failed.'
      WHERE id = ?
    `).run(activationId);
    expect(fixture.sqlite.prepare(`
      SELECT state, provider_failure_category FROM agent_activations WHERE id = ?
    `).get(activationId)).toEqual({
      state: "retry_pending",
      provider_failure_category: "capacity",
    });

    const restarted = new CoordinationV3Store(fixture.sqlite);
    expect(restarted.providerBlockedState(RECIPIENT_ID)).toMatchObject({
      classification: "capacity",
      activationIds: [activationId],
    });
    expect(restarted.resumeProviderBlockedAgent(RECIPIENT_ID, {
      activeEngine: "codex",
      model: "replacement-model",
    }, "2026-01-01T00:00:01.000Z")).toEqual({
      activationIds: [activationId],
      resumed: 1,
    });
  });

  it.each([
    ["rate_limit", "Provider usage limit was reached.", true],
    ["context_length", "Provider context limit was reached.", false],
  ] as const)("uses structured %s authority for scheduler retry decisions", (
    failureKind,
    expectedError,
    providerBlocked,
  ) => {
    const fixture = storeFixture();
    const activationId = fixture.store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: `structured-retry-${failureKind}`,
      kind: "human",
      payload: { text: "retry work" },
      now: NOW,
    });
    const lease = fixture.store.leaseNextRun({ workerId: `${failureKind}-worker`, now: NOW });
    if (!lease) throw new Error("structured retry Run was not leased");
    expect(fixture.store.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: `${failureKind}-worker`,
      sameRunResumable: false,
      confirmedNotExecuted: true,
      failureKind,
      error: "contradictory authentication rejected prose",
      now: NOW,
    })).toBe("retry");
    expect(fixture.sqlite.prepare(`
      SELECT state, provider_failure_category, last_delivery_error
      FROM agent_activations WHERE id = ?
    `).get(activationId)).toEqual({
      state: "retry_pending",
      provider_failure_category: failureKind,
      last_delivery_error: expectedError,
    });
    expect(Boolean(new CoordinationV3Store(fixture.sqlite).providerBlockedState(RECIPIENT_ID)))
      .toBe(providerBlocked);
  });

  it.each([
    "requested",
    "handoff_committed",
    "session_retiring",
    "continuation_ready",
  ] as const)("fences cancellation during %s without creating delayed replacement work", (phase) => {
    const fixture = activeManualHandoffFixture();
    if (phase !== "requested") {
      fixture.store.commitContextRolloverHandoff(
        fixture.rolloverId,
        fixture.handoffId,
        NOW,
      );
    }
    if (phase === "session_retiring" || phase === "continuation_ready") {
      fixture.store.beginContextRolloverRetirement(fixture.rolloverId, NOW);
    }
    const continuation = phase === "continuation_ready"
      ? fixture.store.prepareContextRolloverContinuation({
          id: fixture.rolloverId,
          now: NOW,
        })
      : undefined;
    expect(fixture.store.contextRollover(fixture.rolloverId)?.state).toBe(phase);

    const cancelledAt = "2026-01-01T00:00:01.000Z";
    expect(fixture.store.cancelAgentRun({
      agentId: RECIPIENT_ID,
      expectedRunId: fixture.handoffRun.runId,
      idempotencyKey: `cancel-rollover-${phase}`,
      now: cancelledAt,
    })).toMatchObject({ cancelled: true, replayed: false });
    const terminal = fixture.store.contextRollover(fixture.rolloverId);
    expect(terminal).toMatchObject({
      state: "outcome_unknown",
      terminalAt: cancelledAt,
    });
    expect(() => fixture.store.prepareContextRolloverContinuation({
      id: fixture.rolloverId,
      now: "2026-01-01T00:00:02.000Z",
    })).toThrow("context rollover session is not retiring");
    if (continuation?.continuationActivationId) {
      expect(fixture.sqlite.prepare(`
        SELECT state FROM agent_activations WHERE id = ?
      `).get(continuation.continuationActivationId)).toEqual({ state: "cancelled" });
    }
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'context_rollover_continuation'
        AND state IN ('pending','retry_pending','attached')
    `).get()).toEqual({ count: 0 });

    const restarted = new CoordinationV3Store(fixture.sqlite);
    expect(restarted.activeContextRollover(RECIPIENT_ID)).toBeUndefined();
    restarted.failContextRollover(
      fixture.rolloverId,
      "failed",
      "late teardown must not overwrite cancellation",
      "2026-01-01T00:00:03.000Z",
    );
    expect(restarted.contextRollover(fixture.rolloverId)).toMatchObject({
      state: "outcome_unknown",
      terminalAt: cancelledAt,
      lastError: "Provider execution failed.",
    });

    const laterActivationId = restarted.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: `later-work-${phase}`,
      kind: "human",
      payload: { text: "later work" },
      now: "2026-01-01T00:00:03.000Z",
    });
    expect(restarted.leaseNextRun({
      workerId: "later-worker",
      now: "2026-01-01T00:00:03.000Z",
    })?.activationIds).toEqual([laterActivationId]);
  });

  it("terminalizes a failed manual handoff, releases later work, and creates one explicit retry", () => {
    const fixture = storeFixture();
    const sourceActivationId = fixture.store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: "manual-rollover-source",
      kind: "human",
      payload: { text: "source work" },
      now: NOW,
    });
    const sourceRun = fixture.store.leaseNextRun({ workerId: "source-worker", now: NOW });
    if (!sourceRun) throw new Error("source Run was not leased");
    expect(sourceRun.activationIds).toEqual([sourceActivationId]);
    acknowledgeRun({
      store: fixture.store,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      injectionId: sourceRun.injectionId,
      prompt: "source prompt",
    });
    fixture.store.completeRun(sourceRun.runId, sourceRun.fencingToken, NOW);

    const requested = requestManualRollover({
      store: fixture.store,
      sourceRunId: sourceRun.runId,
    });
    const laterActivationId = fixture.store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: "work-after-failed-manual-rollover",
      kind: "human",
      payload: { text: "later work" },
      now: NOW,
    });
    const handoffRun = fixture.store.leaseNextRun({ workerId: "handoff-worker", now: NOW });
    if (!handoffRun) throw new Error("rollover handoff Run was not leased");
    expect(handoffRun.activations).toEqual([
      expect.objectContaining({ kind: "context_rollover_handoff" }),
    ]);
    fixture.store.markRunStarted(handoffRun.runId, handoffRun.fencingToken, NOW);
    const safeFailure = "deadline exceeded / Ошибка подключения к провайдеру";
    expect(fixture.store.failRun({
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      workerId: "handoff-worker",
      sameRunResumable: false,
      error: safeFailure,
      retryDelayMs: 0,
      now: NOW,
    })).toBe("terminal");
    const failed = fixture.store.contextRollover(requested.rollover.id);
    expect(failed).toMatchObject({
      state: "failed",
      lastError: "Provider execution failed.",
      terminalAt: NOW,
    });
    expect(fixture.sqlite.prepare(`
      SELECT state FROM agent_activations
      WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
    `).get(handoffRun.runId)).toEqual({ state: "failed" });

    const laterRun = fixture.store.leaseNextRun({ workerId: "later-worker", now: NOW });
    if (!laterRun) throw new Error("later ordinary work remained excluded");
    expect(laterRun.activationIds).toEqual([laterActivationId]);
    acknowledgeRun({
      store: fixture.store,
      runId: laterRun.runId,
      fencingToken: laterRun.fencingToken,
      injectionId: laterRun.injectionId,
      prompt: "later prompt",
    });
    fixture.store.completeRun(laterRun.runId, laterRun.fencingToken, NOW);

    const automaticReplay = fixture.store.requestContextRollover({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      oldProviderSessionId: "provider-old",
      providerSessionGeneration: "manual-generation",
      detectedOccupancy: 30_000,
      threshold: 25_000,
      lowWaterMark: 15_000,
      compactionCutoffOrdinal: 43,
      compactionCutoffEventId: "automatic-later-boundary",
      recentTail: [{
        communicationEventId: "automatic-later-tail",
        contentSha256: hashFor("automatic-later-tail"),
      }],
      sourceRunId: laterRun.runId,
      sourceActivationIds: [],
      scopeKey: SCOPE_KEY,
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(automaticReplay).toMatchObject({
      created: false,
      rollover: { id: requested.rollover.id, state: "failed" },
    });

    const retry = requestManualRollover({
      store: fixture.store,
      sourceRunId: laterRun.runId,
      boundaryOrdinal: 43,
      boundaryEventId: "manual-boundary-retry",
      tailEventId: "manual-tail-retry",
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(retry.created).toBe(true);
    expect(retry.rollover).toMatchObject({ state: "requested", triggerKind: "human" });
    expect(retry.rollover.id).not.toBe(requested.rollover.id);
    const retryReplay = requestManualRollover({
      store: fixture.store,
      sourceRunId: laterRun.runId,
      boundaryOrdinal: 43,
      boundaryEventId: "manual-boundary-retry",
      tailEventId: "manual-tail-retry",
      now: "2026-01-01T00:00:02.000Z",
    });
    expect(retryReplay.created).toBe(false);
    expect(retryReplay.rollover.id).toBe(retry.rollover.id);
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM context_rollovers
      WHERE agent_id = ? AND provider_session_generation = 'manual-generation'
    `).get(RECIPIENT_ID)).toEqual({ count: 2 });

    fixture.store.failContextRollover(
      requested.rollover.id,
      "outcome_unknown",
      "late executor transition must not overwrite scheduler authority",
      "2026-01-01T00:00:03.000Z",
    );
    expect(fixture.store.contextRollover(requested.rollover.id)).toMatchObject({
      state: "failed",
      lastError: "Provider execution failed.",
      terminalAt: NOW,
    });
  });

  it("keeps injected rollover provider failure raw only in restricted Run audit evidence", () => {
    const fixture = storeFixture();
    const sourceActivationId = fixture.store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: "restricted-rollover-source",
      kind: "human",
      payload: { text: "source work" },
      now: NOW,
    });
    const sourceRun = fixture.store.leaseNextRun({ workerId: "source-worker", now: NOW });
    if (!sourceRun) throw new Error("source Run was not leased");
    expect(sourceRun.activationIds).toEqual([sourceActivationId]);
    acknowledgeRun({
      store: fixture.store,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      injectionId: sourceRun.injectionId,
      prompt: "restricted rollover source prompt",
    });
    fixture.store.completeRun(sourceRun.runId, sourceRun.fencingToken, NOW);

    const requested = requestManualRollover({
      store: fixture.store,
      sourceRunId: sourceRun.runId,
      providerSessionGeneration: "restricted-rollover-generation",
    });
    const handoffRun = fixture.store.leaseNextRun({ workerId: "handoff-worker", now: NOW });
    if (!handoffRun) throw new Error("rollover handoff Run was not leased");
    acknowledgeRun({
      store: fixture.store,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      injectionId: handoffRun.injectionId,
      prompt: "restricted rollover handoff prompt",
    });
    const restricted = [
      String.raw`provider rejected pa\\u0073sword=hunter2`,
      "cGFzc3dvcmQ9aHVudGVyMg==",
      "Веагег short123",
      "сode=hunter2",
      "Basic dXNlcjpodW50ZXIy",
      "signing_key=x",
      "access_token=private-rollover-token",
      "at /root/.codex/auth.json",
    ].join(" ");
    expect(fixture.store.failRun({
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      workerId: "handoff-worker",
      sameRunResumable: false,
      error: restricted,
      failureKind: "authentication",
      failureDetail: {
        phase: "prompt_submission",
        promptInjectionState: "injected",
        message: restricted,
      },
      now: NOW,
    })).toBe("outcome_unknown");

    const publicRollover = fixture.store.contextRollover(requested.rollover.id);
    expect(publicRollover).toMatchObject({
      state: "outcome_unknown",
      lastError: "Provider authentication was rejected.",
    });
    const persisted = fixture.sqlite.prepare(`
      SELECT last_error FROM context_rollovers WHERE id = ?
    `).get(requested.rollover.id) as { last_error: string };
    expect(persisted.last_error).toBe("Provider authentication was rejected.");
    expect(JSON.stringify({ publicRollover, persisted })).not.toMatch(
      /cGFzc3dv|hunter2|short123|dXNlcj|signing_key|private-rollover-token|password|access_token|root|auth\.json/iu,
    );
    const audit = fixture.sqlite.prepare(`
      SELECT provider_failure_json FROM scheduler_runs WHERE id = ?
    `).get(handoffRun.runId) as { provider_failure_json: string };
    expect(audit.provider_failure_json).toContain("hunter2");
    expect(audit.provider_failure_json).toContain("cGFzc3dvcmQ9aHVudGVyMg==");
    expect(audit.provider_failure_json).toContain("Веагег short123");
    expect(audit.provider_failure_json).toContain("Basic dXNlcjpodW50ZXIy");
    expect(audit.provider_failure_json).toContain("signing_key=x");
    expect(audit.provider_failure_json).toContain("private-rollover-token");
    expect(audit.provider_failure_json).toContain("/root/.codex/auth.json");

    const retry = requestManualRollover({
      store: fixture.store,
      sourceRunId: sourceRun.runId,
      providerSessionGeneration: "restricted-rollover-generation",
      boundaryOrdinal: 43,
      boundaryEventId: "restricted-rollover-retry-boundary",
      tailEventId: "restricted-rollover-retry-tail",
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(retry.created).toBe(true);
    const retryHandoff = fixture.store.leaseNextRun({
      workerId: "retry-handoff-worker",
      now: "2026-01-01T00:00:01.000Z",
    });
    if (!retryHandoff) throw new Error("retry handoff Run was not leased");
    acknowledgeRun({
      store: fixture.store,
      runId: retryHandoff.runId,
      fencingToken: retryHandoff.fencingToken,
      injectionId: retryHandoff.injectionId,
      prompt: "safe retry handoff prompt",
    });
    const retryHandoffId = `handoff:${retry.rollover.id}`;
    fixture.sqlite.prepare(`
      INSERT INTO continuation_handoffs (
        id, agent_id, source_execution_id, text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      retryHandoffId,
      RECIPIENT_ID,
      retryHandoff.runId,
      handoffTextFor(retry.rollover.id),
      NOW,
    );
    fixture.store.commitContextRolloverHandoff(retry.rollover.id, retryHandoffId, NOW);
    fixture.store.beginContextRolloverRetirement(retry.rollover.id, NOW);
    fixture.store.completeRun(retryHandoff.runId, retryHandoff.fencingToken, NOW);
    const continued = fixture.store.prepareContextRolloverContinuation({
      id: retry.rollover.id,
      now: NOW,
    });
    const replacement = fixture.store.leaseNextRun({ workerId: "replacement-worker", now: NOW });
    if (!replacement || !continued.continuationActivationId) {
      throw new Error("replacement Run was not leased");
    }
    fixture.store.markRunStarted(replacement.runId, replacement.fencingToken, NOW);
    const modelContext = JSON.stringify({
      priorRollover: publicRollover,
      retryRollover: fixture.store.contextRollover(retry.rollover.id),
      activations: replacement.activations,
    });
    expect(modelContext).not.toMatch(
      /cGFzc3dv|hunter2|short123|dXNlcj|signing_key|private-rollover-token|password|access_token|root|auth\.json/iu,
    );
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: replacement.runId,
      schedulerRunId: replacement.runId,
      fencingToken: replacement.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: modelContext,
      sourceManifest: replacementManifest({
        activationIds: replacement.activationIds,
        rolloverId: retry.rollover.id,
        recentTailCommunicationEventIds: ["restricted-rollover-retry-tail"],
      }),
      now: NOW,
    });
    const providerInput = fixture.sqlite.prepare(`
      SELECT provider_prompt, source_manifest_json FROM provider_inputs
      WHERE scheduler_run_id = ?
    `).get(replacement.runId) as {
      provider_prompt: string;
      source_manifest_json: string;
    };
    expect(JSON.stringify(providerInput)).not.toMatch(
      /cGFzc3dv|hunter2|short123|dXNlcj|signing_key|private-rollover-token|password|access_token|root|auth\.json/iu,
    );
  });

  it("terminalizes a requested manual rollover during daemon restart recovery", () => {
    const fixture = storeFixture();
    const sourceActivationId = fixture.store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: "restart-source",
      kind: "human",
      payload: { text: "source work" },
      now: NOW,
    });
    const sourceRun = fixture.store.leaseNextRun({ workerId: "source-worker", now: NOW });
    if (!sourceRun) throw new Error("source Run was not leased");
    expect(sourceRun.activationIds).toEqual([sourceActivationId]);
    acknowledgeRun({
      store: fixture.store,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      injectionId: sourceRun.injectionId,
      prompt: "restart source prompt",
    });
    fixture.store.completeRun(sourceRun.runId, sourceRun.fencingToken, NOW);
    const requested = requestManualRollover({
      store: fixture.store,
      sourceRunId: sourceRun.runId,
      providerSessionGeneration: "restart-generation",
    });
    const handoffRun = fixture.store.leaseNextRun({ workerId: "old-daemon", now: NOW });
    if (!handoffRun) throw new Error("handoff Run was not leased");

    expect(fixture.store.recoverOrphanedRuns(
      "new-daemon",
      "2026-01-01T00:01:00.000Z",
    )).toEqual({ retried: 1, outcomeUnknown: 0 });
    const restarted = new CoordinationV3Store(fixture.sqlite);
    const active = restarted.activeContextRollover(RECIPIENT_ID);
    expect(active?.id).toBe(requested.rollover.id);
    restarted.failContextRollover(
      requested.rollover.id,
      "outcome_unknown",
      "server restarted before the provider committed a bounded rollover handoff",
      "2026-01-01T00:01:00.000Z",
    );
    expect(restarted.activeContextRollover(RECIPIENT_ID)).toBeUndefined();
    expect(restarted.contextRollover(requested.rollover.id)).toMatchObject({
      state: "outcome_unknown",
      terminalAt: "2026-01-01T00:01:00.000Z",
    });
    expect(fixture.sqlite.prepare(`
      SELECT state FROM agent_activations
      WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
    `).get(handoffRun.runId)).toEqual({ state: "cancelled" });

    const laterActivationId = restarted.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: "restart-later-work",
      kind: "human",
      payload: { text: "later work" },
      now: "2026-01-01T00:01:00.000Z",
    });
    expect(restarted.leaseNextRun({
      workerId: "new-daemon",
      now: "2026-01-01T00:01:00.000Z",
    })?.activationIds).toEqual([laterActivationId]);
  });

  it("transfers a human DM reply exactly once through an accepted replacement", () => {
    const fixture = directReplyReplacementCandidate();
    expect(fixture.store.requiredReplyObligationForRun(
      fixture.sourceRunId,
    )).toMatchObject({ state: "superseded" });
    expect(fixture.sqlite.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(fixture.staleRecoveryActivationId)).toEqual({ state: "cancelled" });
    expect(fixture.store.requiredReplyObligationForRun(
      fixture.candidateRun.runId,
    )).toMatchObject({
      state: "pending",
      sourceActivationId: fixture.sourceActivationIds[0],
      replyAuthority: { intent: "direct_to_user" },
      attemptCount: 0,
    });

    fixture.store.markRunStarted(
      fixture.candidateRun.runId,
      fixture.candidateRun.fencingToken,
      NOW,
    );
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: fixture.candidateRun.runId,
      schedulerRunId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "exact direct-message replacement packet",
      sourceManifest: replacementManifest({
        activationIds: fixture.candidateRun.activationIds,
        rolloverId: fixture.rolloverId,
      }),
      now: NOW,
    });
    fixture.store.preparePromptInjection({
      injectionId: fixture.candidateRun.injectionId,
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      prompt: "exact direct-message replacement packet",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.candidateRun.injectionId,
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      providerSessionId: "provider-direct-replacement",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.candidateRun.injectionId,
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      providerSessionId: "provider-direct-replacement",
      now: NOW,
    });
    fixture.store.recordContextRolloverReplacementSessionForRun(
      fixture.candidateRun.runId,
      RECIPIENT_ID,
      "provider-direct-replacement",
      NOW,
    );
    const publishReply = () => fixture.store.recordRuntimeCommunication({
      id: "direct-replacement-reply",
      projectId: PROJECT_ID,
      scopeKey: SCOPE_KEY,
      sender: {
        kind: "agent",
        agentId: RECIPIENT_ID,
        executionId: fixture.candidateRun.runId,
      },
      intent: "direct_to_user",
      audience: { kind: "user", userId: "local-operator" },
      payload: { text: "The requested work is complete." },
      runAuthorization: {
        runId: fixture.candidateRun.runId,
        agentId: RECIPIENT_ID,
        fencingToken: fixture.candidateRun.fencingToken,
      },
      satisfiesRequiredReply: true,
      now: NOW,
    });
    expect(publishReply()).toMatchObject({ replayed: false });
    expect(publishReply()).toMatchObject({ replayed: true });
    expect(fixture.store.requiredReplyObligationForRun(
      fixture.candidateRun.runId,
    )).toMatchObject({
      state: "satisfied",
      satisfiedCommunicationId: "direct-replacement-reply",
    });
    fixture.store.observeContextRolloverReplacementOccupancy(
      fixture.rolloverId,
      "provider-direct-replacement",
      10_000,
      NOW,
    );
    fixture.store.completeVerifiedContextRolloverReplacement(
      fixture.rolloverId,
      "provider-direct-replacement",
      NOW,
    );
    fixture.store.completeRun(
      fixture.candidateRun.runId,
      fixture.candidateRun.fencingToken,
      NOW,
    );
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
        AND state IN ('pending','retry_pending','attached')
    `).get()).toEqual({ count: 0 });
    expect(fixture.store.leaseNextRun({
      workerId: "no-duplicate-worker",
      now: NOW,
    })).toBeUndefined();
  });

  it("preserves multiple human DM reply roots across repeated rollovers", () => {
    const fixture = directReplyReplacementCandidate(0, 2);
    const originalSourceIds = fixture.store.requiredReplyObligationsForRun(
      fixture.candidateRun.runId,
    ).map((obligation) => obligation.sourceActivationId);
    expect(originalSourceIds).toHaveLength(2);
    expect(fixture.store.requiredReplyObligationsForRun(
      fixture.candidateRun.runId,
    ).every((obligation) => obligation.state === "pending")).toBe(true);

    recordDirectMessage({
      store: fixture.store,
      communicationId: "unrelated-direct-source",
      agentId: REQUESTER_ID,
      text: "This separate Agent still owes its own private reply.",
    });
    const unrelatedRun = fixture.store.leaseNextRun({
      workerId: "unrelated-direct-worker",
      now: NOW,
    });
    if (!unrelatedRun || unrelatedRun.agentId !== REQUESTER_ID) {
      throw new Error("unrelated direct-message Run was not leased");
    }
    const unrelatedBefore = fixture.store.requiredReplyObligationsForRun(
      unrelatedRun.runId,
    );
    expect(unrelatedBefore).toEqual([
      expect.objectContaining({
        state: "pending",
        replyAuthority: { intent: "direct_to_user" },
      }),
    ]);

    fixture.store.markRunStarted(
      fixture.candidateRun.runId,
      fixture.candidateRun.fencingToken,
      NOW,
    );
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: fixture.candidateRun.runId,
      schedulerRunId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "first repeated-rollover replacement packet",
      sourceManifest: replacementManifest({
        activationIds: fixture.candidateRun.activationIds,
        rolloverId: fixture.rolloverId,
      }),
      now: NOW,
    });
    fixture.store.preparePromptInjection({
      injectionId: fixture.candidateRun.injectionId,
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      prompt: "first repeated-rollover replacement packet",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.candidateRun.injectionId,
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      providerSessionId: "provider-replacement-1",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.candidateRun.injectionId,
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      providerSessionId: "provider-replacement-1",
      now: NOW,
    });
    fixture.store.recordContextRolloverReplacementSessionForRun(
      fixture.candidateRun.runId,
      RECIPIENT_ID,
      "provider-replacement-1",
      NOW,
    );
    fixture.store.observeContextRolloverReplacementOccupancy(
      fixture.rolloverId,
      "provider-replacement-1",
      10_000,
      NOW,
    );
    fixture.store.completeVerifiedContextRolloverReplacement(
      fixture.rolloverId,
      "provider-replacement-1",
      NOW,
    );

    const second = fixture.store.requestContextRollover({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      oldProviderSessionId: "provider-replacement-1",
      providerSessionGeneration: "generation-direct-reply-2",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 25_000,
      compactionCutoffOrdinal: 43,
      compactionCutoffEventId: "communication-cutoff-2",
      recentTail: [{
        communicationEventId: "tail-second",
        contentSha256: hashFor("tail-second"),
      }],
      sourceRunId: fixture.candidateRun.runId,
      sourceActivationIds: fixture.candidateRun.activationIds,
      scopeKey: SCOPE_KEY,
      conversationId: CONVERSATION_ID,
      replyAuthority: { intent: "direct_to_user" },
      now: NOW,
    });
    fixture.store.completeRun(
      fixture.candidateRun.runId,
      fixture.candidateRun.fencingToken,
      NOW,
    );
    const firstOwners = fixture.store.requiredReplyObligationsForRun(
      fixture.candidateRun.runId,
    );
    expect(firstOwners).toHaveLength(2);
    expect(firstOwners.every((obligation) =>
      obligation.state === "recovery_pending" &&
      Boolean(obligation.recoveryActivationId))).toBe(true);

    const handoffRun = fixture.store.leaseNextRun({
      workerId: "second-handoff-worker",
      now: NOW,
    });
    if (!handoffRun || handoffRun.activations[0]?.kind !== "context_rollover_handoff") {
      throw new Error("second rollover handoff Run was not leased");
    }
    acknowledgeRun({
      store: fixture.store,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      injectionId: handoffRun.injectionId,
      prompt: "second bounded handoff prompt",
    });
    fixture.sqlite.prepare(`
      INSERT INTO continuation_handoffs (
        id, agent_id, source_execution_id, text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      `handoff:${second.rollover.id}`,
      RECIPIENT_ID,
      handoffRun.runId,
      handoffTextFor(second.rollover.id),
      NOW,
    );
    fixture.store.commitContextRolloverHandoff(
      second.rollover.id,
      `handoff:${second.rollover.id}`,
      NOW,
    );
    fixture.store.completeRun(handoffRun.runId, handoffRun.fencingToken, NOW);
    fixture.store.beginContextRolloverRetirement(second.rollover.id, NOW);
    const continued = fixture.store.prepareContextRolloverContinuation({
      id: second.rollover.id,
      now: NOW,
    });
    const secondReplacement = fixture.store.leaseNextRun({
      workerId: "second-replacement-worker",
      now: NOW,
    });
    if (!secondReplacement || !continued.continuationActivationId) {
      throw new Error("second replacement Run was not leased");
    }
    expect(secondReplacement.activationIds).toEqual([
      continued.continuationActivationId,
    ]);
    expect(fixture.store.requiredReplyObligationsForRun(
      secondReplacement.runId,
    )).toEqual(originalSourceIds.map((sourceActivationId) =>
      expect.objectContaining({
        sourceActivationId,
        state: "pending",
        replyAuthority: { intent: "direct_to_user" },
        attemptCount: 0,
      })));
    expect(fixture.store.requiredReplyObligationsForRun(
      fixture.candidateRun.runId,
    ).every((obligation) => obligation.state === "superseded")).toBe(true);
    for (const predecessor of firstOwners) {
      expect(fixture.sqlite.prepare(`
        SELECT state FROM agent_activations WHERE id = ?
      `).get(predecessor.recoveryActivationId)).toEqual({ state: "cancelled" });
    }
    expect(fixture.store.requiredReplyObligationsForRun(
      unrelatedRun.runId,
    )).toEqual(unrelatedBefore);

    fixture.store.markRunStarted(
      secondReplacement.runId,
      secondReplacement.fencingToken,
      NOW,
    );
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: secondReplacement.runId,
      schedulerRunId: secondReplacement.runId,
      fencingToken: secondReplacement.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "second repeated-rollover replacement packet",
      sourceManifest: replacementManifest({
        activationIds: secondReplacement.activationIds,
        rolloverId: second.rollover.id,
        recentTailCommunicationEventIds: ["tail-second"],
      }),
      now: NOW,
    });
    fixture.store.preparePromptInjection({
      injectionId: secondReplacement.injectionId,
      runId: secondReplacement.runId,
      fencingToken: secondReplacement.fencingToken,
      prompt: "second repeated-rollover replacement packet",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: secondReplacement.injectionId,
      runId: secondReplacement.runId,
      fencingToken: secondReplacement.fencingToken,
      providerSessionId: "provider-replacement-2",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: secondReplacement.injectionId,
      runId: secondReplacement.runId,
      fencingToken: secondReplacement.fencingToken,
      providerSessionId: "provider-replacement-2",
      now: NOW,
    });
    fixture.store.recordContextRolloverReplacementSessionForRun(
      secondReplacement.runId,
      RECIPIENT_ID,
      "provider-replacement-2",
      NOW,
    );
    const publishReply = () => fixture.store.recordRuntimeCommunication({
      id: "second-replacement-reply",
      projectId: PROJECT_ID,
      scopeKey: SCOPE_KEY,
      sender: {
        kind: "agent",
        agentId: RECIPIENT_ID,
        executionId: secondReplacement.runId,
      },
      intent: "direct_to_user",
      audience: { kind: "user", userId: "local-operator" },
      payload: { text: "Both private requests are complete." },
      runAuthorization: {
        runId: secondReplacement.runId,
        agentId: RECIPIENT_ID,
        fencingToken: secondReplacement.fencingToken,
      },
      satisfiesRequiredReply: true,
      now: NOW,
    });
    expect(publishReply()).toMatchObject({ replayed: false });
    expect(publishReply()).toMatchObject({ replayed: true });
    expect(fixture.store.requiredReplyObligationsForRun(
      secondReplacement.runId,
    ).every((obligation) =>
      obligation.state === "satisfied" &&
      obligation.satisfiedCommunicationId === "second-replacement-reply")).toBe(true);
    fixture.store.observeContextRolloverReplacementOccupancy(
      second.rollover.id,
      "provider-replacement-2",
      10_000,
      NOW,
    );
    fixture.store.completeVerifiedContextRolloverReplacement(
      second.rollover.id,
      "provider-replacement-2",
      NOW,
    );
    fixture.store.completeRun(
      secondReplacement.runId,
      secondReplacement.fencingToken,
      NOW,
    );
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
        AND state IN ('pending','retry_pending','attached')
    `).get()).toEqual({ count: 0 });
    expect(fixture.store.requiredReplyObligationsForRun(
      unrelatedRun.runId,
    )).toEqual(unrelatedBefore);
    expect(fixture.store.leaseNextRun({
      workerId: "no-repeated-rollover-duplicate",
      now: NOW,
    })).toBeUndefined();
  });

  it("preserves the transferred DM obligation across an uninjected restart", () => {
    const fixture = directReplyReplacementCandidate();
    expect(fixture.store.recoverOrphanedRuns(
      "restart-worker",
      "2026-01-01T00:00:01.000Z",
    )).toEqual({ retried: 1, outcomeUnknown: 0 });
    expect(fixture.store.requiredReplyObligationForRun(
      fixture.candidateRun.runId,
    )).toMatchObject({ state: "retried", attemptCount: 0 });
    const restarted = new CoordinationV3Store(fixture.sqlite);
    const retry = restarted.leaseNextRun({
      workerId: "restart-worker",
      now: "2026-01-01T00:00:01.000Z",
    });
    if (!retry) throw new Error("replacement continuation was not retried");
    expect(retry.activationIds).toEqual(fixture.candidateRun.activationIds);
    expect(restarted.requiredReplyObligationForRun(retry.runId)).toMatchObject({
      state: "pending",
      sourceActivationId: fixture.sourceActivationIds[0],
      replyAuthority: { intent: "direct_to_user" },
      attemptCount: 0,
    });
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
        AND state IN ('pending','retry_pending','attached')
    `).get()).toEqual({ count: 0 });
  });

  it("recovers one DM obligation after an unverified replacement fails", () => {
    const fixture = directReplyReplacementCandidate();
    fixture.store.markRunStarted(
      fixture.candidateRun.runId,
      fixture.candidateRun.fencingToken,
      NOW,
    );
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: fixture.candidateRun.runId,
      schedulerRunId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "unverified direct-message replacement packet",
      sourceManifest: replacementManifest({
        activationIds: fixture.candidateRun.activationIds,
        rolloverId: fixture.rolloverId,
      }),
      now: NOW,
    });
    expect(fixture.store.failRun({
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      workerId: "direct-replacement-worker",
      sameRunResumable: false,
      retryDelayMs: 0,
      now: NOW,
    })).toBe("terminal");
    expect(fixture.store.contextRollover(fixture.rolloverId)).toMatchObject({
      state: "outcome_unknown",
      replacementRunId: fixture.candidateRun.runId,
    });
    expect(fixture.store.requiredReplyObligationForRun(
      fixture.candidateRun.runId,
    )).toMatchObject({
      state: "recovery_pending",
      attemptCount: 0,
    });
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
        AND state IN ('pending','retry_pending','attached')
    `).get()).toEqual({ count: 1 });
    const recovery = fixture.store.leaseNextRun({
      workerId: "single-recovery-worker",
      now: NOW,
    });
    if (!recovery) throw new Error("required reply recovery was not leased");
    expect(recovery.activations).toEqual([
      expect.objectContaining({ kind: "required_reply_recovery" }),
    ]);
    expect(fixture.store.requiredReplyObligationForRun(recovery.runId))
      .toMatchObject({
        state: "pending",
        replyAuthority: { intent: "direct_to_user" },
        attemptCount: 1,
      });
  });

  it("preserves reply exhaustion when the rollover continuation takes ownership", () => {
    const fixture = directReplyReplacementCandidate(5);
    expect(fixture.store.requiredReplyObligationForRun(
      fixture.candidateRun.runId,
    )).toMatchObject({ state: "pending", attemptCount: 5 });
    fixture.store.markRunStarted(
      fixture.candidateRun.runId,
      fixture.candidateRun.fencingToken,
      NOW,
    );
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: fixture.candidateRun.runId,
      schedulerRunId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "exhausted direct-message replacement packet",
      sourceManifest: replacementManifest({
        activationIds: fixture.candidateRun.activationIds,
        rolloverId: fixture.rolloverId,
      }),
      now: NOW,
    });
    expect(fixture.store.failRun({
      runId: fixture.candidateRun.runId,
      fencingToken: fixture.candidateRun.fencingToken,
      workerId: "direct-replacement-worker",
      sameRunResumable: false,
      retryDelayMs: 0,
      now: NOW,
    })).toBe("terminal");
    expect(fixture.store.requiredReplyObligationForRun(
      fixture.candidateRun.runId,
    )).toMatchObject({ state: "failed", attemptCount: 5 });
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'required_reply_recovery'
        AND state IN ('pending','retry_pending','attached')
    `).get()).toEqual({ count: 0 });
  });

  it("completes a rollover without manufacturing work for a terminal inbound Request", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    fixture.store.updateRequest({
      requestId: fixture.requestId,
      updateId: "completed-1",
      kind: "completed",
      actor: { kind: "agent", id: RECIPIENT_ID },
      payload: { text: "done" },
      now: NOW,
    });

    const completed = fixture.store.prepareContextRolloverContinuation({
      id: rolloverId,
      now: NOW,
    });
    expect(completed.state).toBe("completed");
    expect(completed.continuationActivationId).toBeUndefined();
    expect(fixture.store.prepareContextRolloverContinuation({
      id: rolloverId,
      now: NOW,
    })).toEqual(completed);
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'context_rollover_continuation'
    `).get()).toEqual({ count: 0 });
  });

  it("owns one rollover per provider generation and cancels it after verified native compaction", () => {
    const fixture = requestSourceFixture();
    const request = () => fixture.store.requestContextRollover({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      oldProviderSessionId: "provider-old",
      providerSessionGeneration: "generation-native",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 25_000,
      compactionCutoffOrdinal: 42,
      compactionCutoffEventId: "communication-42",
      recentTail: ["tail-2", "tail-1"].map((communicationEventId) => ({
        communicationEventId,
        contentSha256: hashFor(communicationEventId),
      })),
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      scopeKey: SCOPE_KEY,
      conversationId: CONVERSATION_ID,
      now: NOW,
    });
    const first = request();
    const replay = request();
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.rollover.id).toBe(first.rollover.id);
    expect(first.rollover).toMatchObject({
      compactionCutoffOrdinal: 42,
      compactionCutoffEventId: "communication-42",
      recentTailCommunicationEventIds: ["tail-2", "tail-1"],
      recentTailContentHashes: [hashFor("tail-2"), hashFor("tail-1")],
    });

    expect(fixture.store.cancelContextRolloverAfterNativeCompaction({
      agentId: RECIPIENT_ID,
      providerSessionGeneration: "generation-native",
      providerSessionId: "provider-old",
      usedTokens: 20_000,
      now: NOW,
    })).toMatchObject({
      state: "completed",
      completionReason: "native_compaction",
    });
    expect(fixture.sqlite.prepare(`
      SELECT state FROM agent_activations
      WHERE kind = 'context_rollover_handoff'
    `).get()).toEqual({ state: "cancelled" });
  });

  it("binds replacement input through distinct pressure, acknowledged handoff, and candidate Runs", () => {
    const fixture = requestSourceFixture();
    const requested = fixture.store.requestContextRollover({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      oldProviderSessionId: "provider-old",
      providerSessionGeneration: "generation-three-runs",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 25_000,
      compactionCutoffOrdinal: 42,
      compactionCutoffEventId: "communication-cutoff",
      recentTail: [{
        communicationEventId: "tail-default",
        contentSha256: hashFor("tail-default"),
      }],
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      scopeKey: SCOPE_KEY,
      conversationId: CONVERSATION_ID,
      replyAuthority: { intent: "direct_to_user" },
      now: NOW,
    });
    fixture.store.markRunStarted(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      prompt: "pressure source prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);

    const handoffRun = fixture.store.leaseNextRun({ workerId: "handoff-worker", now: NOW });
    if (!handoffRun) throw new Error("dedicated handoff Run was not leased");
    expect(handoffRun.activationIds).toHaveLength(1);
    expect(fixture.sqlite.prepare(`
      SELECT kind FROM agent_activations WHERE id = ?
    `).get(handoffRun.activationIds[0])).toEqual({ kind: "context_rollover_handoff" });
    fixture.store.markRunStarted(handoffRun.runId, handoffRun.fencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: handoffRun.injectionId,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      prompt: "bounded handoff prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: handoffRun.injectionId,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: handoffRun.injectionId,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.sqlite.prepare(`
      INSERT INTO continuation_handoffs (
        id, agent_id, source_execution_id, text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      `handoff:${requested.rollover.id}`,
      RECIPIENT_ID,
      handoffRun.runId,
      handoffTextFor(requested.rollover.id),
      NOW,
    );
    fixture.store.commitContextRolloverHandoff(
      requested.rollover.id,
      `handoff:${requested.rollover.id}`,
      NOW,
    );
    fixture.store.completeRun(handoffRun.runId, handoffRun.fencingToken, NOW);
    fixture.store.beginContextRolloverRetirement(requested.rollover.id, NOW);
    const continued = fixture.store.prepareContextRolloverContinuation({
      id: requested.rollover.id,
      now: NOW,
    });

    const candidateRun = fixture.store.leaseNextRun({ workerId: "candidate-worker", now: NOW });
    if (!candidateRun || !continued.continuationActivationId) {
      throw new Error("replacement candidate Run was not leased");
    }
    expect(new Set([
      fixture.sourceRunId,
      handoffRun.runId,
      candidateRun.runId,
    ]).size).toBe(3);
    expect(candidateRun.activationIds).toEqual([continued.continuationActivationId]);
    fixture.store.markRunStarted(candidateRun.runId, candidateRun.fencingToken, NOW);
    expect(fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: candidateRun.runId,
      schedulerRunId: candidateRun.runId,
      fencingToken: candidateRun.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "exact replacement packet",
      sourceManifest: replacementManifest({
        activationIds: candidateRun.activationIds,
        rolloverId: requested.rollover.id,
      }),
      now: NOW,
    })).toMatchObject({
      id: requested.rollover.id,
      replacementRunId: candidateRun.runId,
      state: "continuation_ready",
    });
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM provider_inputs WHERE scheduler_run_id = ?
    `).get(candidateRun.runId)).toEqual({ count: 1 });
  });

  it("routes a human rollover through the same dedicated handoff Run authority", () => {
    const fixture = requestSourceFixture();
    acknowledgeRun({
      store: fixture.store,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      injectionId: fixture.sourceInjectionId,
      prompt: "accepted source prompt",
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const requested = fixture.store.requestContextRollover({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      oldProviderSessionId: "provider-old",
      providerSessionGeneration: "human-three-run-generation",
      detectedOccupancy: 12_000,
      threshold: 25_000,
      lowWaterMark: 15_000,
      triggerKind: "human",
      compactionCutoffOrdinal: 42,
      compactionCutoffEventId: "communication-cutoff",
      recentTail: [{
        communicationEventId: "tail-default",
        contentSha256: hashFor("tail-default"),
      }],
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: [],
      scopeKey: SCOPE_KEY,
      conversationId: CONVERSATION_ID,
      now: NOW,
    });
    const handoffRun = fixture.store.leaseNextRun({ workerId: "human-handoff", now: NOW });
    if (!handoffRun) throw new Error("human handoff Run was not leased");
    acknowledgeRun({
      store: fixture.store,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      injectionId: handoffRun.injectionId,
      prompt: "human bounded handoff prompt",
    });
    fixture.sqlite.prepare(`
      INSERT INTO continuation_handoffs (
        id, agent_id, source_execution_id, text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      `handoff:${requested.rollover.id}`,
      RECIPIENT_ID,
      handoffRun.runId,
      handoffTextFor(requested.rollover.id),
      NOW,
    );
    fixture.store.commitContextRolloverHandoff(
      requested.rollover.id,
      `handoff:${requested.rollover.id}`,
      NOW,
    );
    fixture.store.completeRun(handoffRun.runId, handoffRun.fencingToken, NOW);
    fixture.store.beginContextRolloverRetirement(requested.rollover.id, NOW);
    const continued = fixture.store.prepareContextRolloverContinuation({
      id: requested.rollover.id,
      now: NOW,
    });
    const candidateRun = fixture.store.leaseNextRun({ workerId: "human-candidate", now: NOW });
    if (!candidateRun || !continued.continuationActivationId) {
      throw new Error("human replacement candidate was not leased");
    }
    expect(candidateRun.activationIds).toEqual([continued.continuationActivationId]);
    fixture.store.markRunStarted(candidateRun.runId, candidateRun.fencingToken, NOW);
    expect(fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: candidateRun.runId,
      schedulerRunId: candidateRun.runId,
      fencingToken: candidateRun.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "human exact replacement packet",
      sourceManifest: replacementManifest({
        activationIds: candidateRun.activationIds,
        rolloverId: requested.rollover.id,
      }),
      now: NOW,
    })).toMatchObject({
      triggerKind: "human",
      replacementRunId: candidateRun.runId,
    });
  });

  it("commits the exact replacement manifest before session creation and switches only after low-water verification", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    const continued = fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    fixture.store.markRunStarted(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      prompt: "source prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const lease = fixture.store.leaseNextRun({ workerId: "replacement-worker", now: NOW });
    if (!lease || !continued.continuationActivationId) throw new Error("replacement Run was not leased");
    expect(lease.activationIds).toContain(continued.continuationActivationId);
    fixture.store.markRunStarted(lease.runId, lease.fencingToken, NOW);

    expect(() => fixture.store.recordContextRolloverReplacementSessionForRun(
      lease.runId,
      RECIPIENT_ID,
      "provider-new",
      NOW,
    )).toThrow("replacement input is not durably committed");

    expect(() => fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "x".repeat(MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES + 1),
      sourceManifest: replacementManifest({ activationIds: lease.activationIds, rolloverId }),
      now: NOW,
    })).toThrow("aggregate prompt and system-prompt bound");

    const committed = fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "exact bounded replacement input",
      systemPrompt: "exact replacement system prompt",
      sourceManifest: replacementManifest({
        activationIds: lease.activationIds,
        rolloverId,
      }),
      now: NOW,
    });
    expect(committed).toMatchObject({
      replacementRunId: lease.runId,
      replacementInputCommittedAt: NOW,
    });
    fixture.store.recordProviderInput({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "tampered after commit",
      systemPrompt: "tampered system prompt",
      sourceManifest: replacementManifest({ activationIds: lease.activationIds, rolloverId }),
      now: NOW,
    });
    expect(() => fixture.store.recordContextRolloverReplacementSessionForRun(
      lease.runId,
      RECIPIENT_ID,
      "provider-new",
      NOW,
    )).toThrow("replacement input changed after its durable commit");
    fixture.store.recordProviderInput({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "exact bounded replacement input",
      systemPrompt: "exact replacement system prompt",
      sourceManifest: replacementManifest({ activationIds: lease.activationIds, rolloverId }),
      now: NOW,
    });
    fixture.store.recordContextRolloverReplacementSessionForRun(
      lease.runId,
      RECIPIENT_ID,
      "provider-new",
      NOW,
    );
    const verified = fixture.store.observeContextRolloverReplacementOccupancy(
      rolloverId,
      "provider-new",
      20_000,
      NOW,
    );
    expect(verified.state).toBe("continuation_ready");
    expect(verified.replacementVerifiedAt).toBe(NOW);
    // Simulate a crash after the canonical acceptance event was fsynced and
    // projected, but before coordination completion committed.
    fixture.sqlite.prepare(`
      UPDATE agents SET active_session_id = ? WHERE id = ?
    `).run("provider-new", RECIPIENT_ID);
    fixture.sqlite.prepare(`
      UPDATE continuation_handoffs
      SET consumed_by_execution_id = ?, consumed_at = ? WHERE id = ?
    `).run(lease.runId, NOW, `handoff:${rolloverId}`);
    fixture.sqlite.prepare(`
      UPDATE context_rollovers
      SET state = 'outcome_unknown', last_error = 'injected projection boundary failure'
      WHERE id = ?
    `).run(rolloverId);
    expect(fixture.store.contextRolloverCanonicalAcceptanceCandidates()).toHaveLength(1);
    expect(fixture.store.reconcileContextRolloverCanonicalAcceptance({
      id: rolloverId,
      replacementSessionId: "provider-new",
      replacementRunId: lease.runId,
      handoffEventId: `handoff:${rolloverId}`,
      now: NOW,
    })).toMatchObject({
      state: "completed",
      completionReason: "replacement_verified",
    });
  });

  it("rolls back provider input when the exact rollover manifest cannot be committed", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
      recentTailCommunicationEventIds: ["tail-required"],
    });
    const continued = fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    fixture.store.markRunStarted(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      prompt: "source prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const lease = fixture.store.leaseNextRun({ workerId: "replacement-worker", now: NOW });
    if (!lease || !continued.continuationActivationId) throw new Error("replacement Run was not leased");
    fixture.store.markRunStarted(lease.runId, lease.fencingToken, NOW);

    expect(() => fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "candidate missing its frozen tail",
      sourceManifest: {
        schemaVersion: 3,
        historyMessageCount: 0,
        retainedSessionSourceCount: 0,
        activationIds: lease.activationIds,
        triggerOccurrenceIds: [],
        communicationEventIds: [],
        artifactIds: [],
        providerSessionDisposition: "reseeded",
        sources: [],
      },
      now: NOW,
    })).toThrow("replacement history count does not match its frozen tail");
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM provider_inputs WHERE scheduler_run_id = ?
    `).get(lease.runId)).toEqual({ count: 0 });
    expect(() => fixture.store.recordContextRolloverReplacementSessionForRun(
      lease.runId,
      RECIPIENT_ID,
      "provider-must-not-start",
      NOW,
    )).toThrow("replacement input is not durably committed");
  });

  it("rebinds one operator-authorized recovery Run to the same failed rollover generation", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    fixture.store.markRunStarted(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      prompt: "source prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const first = fixture.store.leaseNextRun({ workerId: "first-candidate", now: NOW });
    if (!first) throw new Error("first replacement Run was not leased");
    fixture.store.markRunStarted(first.runId, first.fencingToken, NOW);
    const firstManifest = replacementManifest({ activationIds: first.activationIds, rolloverId });
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: first.runId,
      schedulerRunId: first.runId,
      fencingToken: first.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "first exact replacement packet",
      systemPrompt: "system contract",
      sourceManifest: firstManifest,
      now: NOW,
    });
    const restarted = fixture.store.failUnidentifiedContextRolloverReplacementAfterRestart(
      rolloverId,
      NOW,
    );
    expect(restarted).toMatchObject({
      state: "outcome_unknown",
      replacementRunId: first.runId,
    });
    expect(restarted.replacementSessionId).toBeUndefined();
    fixture.store.cancelAgentRun({
      agentId: RECIPIENT_ID,
      expectedRunId: first.runId,
      idempotencyKey: "cancel-first-candidate",
      now: NOW,
    });
    expect(fixture.store.contextRollover(rolloverId)).toMatchObject({
      state: "outcome_unknown",
      replacementRunId: first.runId,
      replacementAttempt: 1,
    });

    const retryRequestId = `${fixture.requestId}:retry`;
    fixture.store.coordinate({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      requesterAgentId: REQUESTER_ID,
      actorScope: "user:local-operator",
      idempotencyKey: "retry-failed-rollover",
      rolloverRecoveryForRequestId: fixture.requestId,
      requests: [{
        requestId: retryRequestId,
        recipientAgentId: RECIPIENT_ID,
        lifetime: { kind: "indefinite" },
        payload: { text: "retry work", retryOfRequestId: fixture.requestId },
      }],
    }, NOW);
    const unrelatedRequestId = fixture.store.coordinate({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      requesterAgentId: REQUESTER_ID,
      actorScope: "user:local-operator",
      idempotencyKey: "unrelated-work-during-recovery",
      requests: [{
        recipientAgentId: RECIPIENT_ID,
        lifetime: { kind: "indefinite" },
        payload: { text: "unrelated new work" },
      }],
    }, NOW).requestIds[0]!;
    expect(fixture.store.contextRolloverRecoveryForRequest(retryRequestId)?.id)
      .toBe(rolloverId);
    const recoveryActivation = fixture.sqlite.prepare(`
      SELECT activation.id FROM agent_activations activation
      JOIN activation_sources source ON source.activation_id = activation.id
      WHERE source.source_kind = 'context_rollover_recovery' AND source.source_id = ?
    `).get(rolloverId) as { id: string };
    const recovery = fixture.store.leaseNextRun({
      workerId: "recovery-candidate",
      now: NOW,
      excludedAgentIds: [REQUESTER_ID],
    });
    if (!recovery) throw new Error("recovery replacement Run was not leased");
    expect(recovery.activationIds).toEqual([recoveryActivation.id]);
    expect(fixture.sqlite.prepare(`
      SELECT state FROM coordination_requests WHERE id = ?
    `).get(unrelatedRequestId)).toEqual({ state: "open" });
    expect(fixture.store.contextRolloverCandidateForRun(recovery.runId, RECIPIENT_ID)?.id)
      .toBe(rolloverId);
    fixture.store.markRunStarted(recovery.runId, recovery.fencingToken, NOW);
    expect(() => fixture.store.recordContextRolloverReplacementSessionForRun(
      recovery.runId,
      RECIPIENT_ID,
      "provider-recovery",
      NOW,
    )).toThrow("replacement input is not durably committed");
    expect(() => fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: recovery.runId,
      schedulerRunId: recovery.runId,
      fencingToken: recovery.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "changed recovery packet",
      systemPrompt: "system contract",
      sourceManifest: firstManifest,
      now: NOW,
    })).toThrow("exact previously committed provider packet");
    const rebound = fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: recovery.runId,
      schedulerRunId: recovery.runId,
      fencingToken: recovery.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "first exact replacement packet",
      systemPrompt: "system contract",
      sourceManifest: firstManifest,
      now: NOW,
    });
    expect(rebound).toMatchObject({
      id: rolloverId,
      state: "continuation_ready",
      replacementRunId: recovery.runId,
      replacementAttempt: 2,
    });
    fixture.store.recordContextRolloverReplacementSessionForRun(
      recovery.runId,
      RECIPIENT_ID,
      "provider-recovery",
      NOW,
    );
    expect(fixture.store.contextRolloverForReplacementSession(
      RECIPIENT_ID,
      "provider-recovery",
    )?.id).toBe(rolloverId);
    fixture.store.cancelAgentRun({
      agentId: RECIPIENT_ID,
      expectedRunId: recovery.runId,
      idempotencyKey: "cancel-recovery-candidate",
      now: NOW,
    });
    expect(fixture.store.contextRollover(rolloverId)).toMatchObject({
      state: "outcome_unknown",
      replacementRunId: recovery.runId,
      replacementSessionId: "provider-recovery",
    });
  });

  it("terminally fences an ordinary retry after durable replacement input commit", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    fixture.store.markRunStarted(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      prompt: "source prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const lease = fixture.store.leaseNextRun({ workerId: "candidate", now: NOW });
    if (!lease) throw new Error("replacement Run was not leased");
    fixture.store.markRunStarted(lease.runId, lease.fencingToken, NOW);
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "exact replacement packet",
      sourceManifest: replacementManifest({ activationIds: lease.activationIds, rolloverId }),
      now: NOW,
    });

    expect(fixture.store.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: "candidate",
      sameRunResumable: false,
      retryDelayMs: 0,
      now: NOW,
    })).toBe("terminal");
    expect(fixture.store.contextRollover(rolloverId)).toMatchObject({
      state: "outcome_unknown",
      replacementRunId: lease.runId,
    });
    expect(fixture.sqlite.prepare(`
      SELECT state FROM agent_activations
      WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
    `).get(lease.runId)).toEqual({ state: "failed" });
  });

  it("terminalizes an unverified injected replacement on live lease expiry without restart", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    acknowledgeRun({
      store: fixture.store,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      injectionId: fixture.sourceInjectionId,
      prompt: "source prompt",
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const lease = fixture.store.leaseNextRun({
      workerId: "expiring-candidate",
      now: NOW,
      leaseMs: 1_000,
    });
    if (!lease) throw new Error("replacement Run was not leased");
    fixture.store.markRunStarted(lease.runId, lease.fencingToken, NOW);
    fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "exact replacement packet",
      sourceManifest: replacementManifest({ activationIds: lease.activationIds, rolloverId }),
      now: NOW,
    });
    fixture.store.preparePromptInjection({
      injectionId: lease.injectionId,
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      prompt: "exact replacement packet",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: lease.injectionId,
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      providerSessionId: "provider-expired",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: lease.injectionId,
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      providerSessionId: "provider-expired",
      now: NOW,
    });
    fixture.store.recordContextRolloverReplacementSessionForRun(
      lease.runId,
      RECIPIENT_ID,
      "provider-expired",
      NOW,
    );

    const afterExpiry = "2026-01-01T00:00:02.000Z";
    expect(fixture.store.leaseNextRun({
      workerId: "same-live-daemon",
      now: afterExpiry,
      excludedAgentIds: [REQUESTER_ID],
    })).toBeUndefined();
    expect(fixture.sqlite.prepare(`
      SELECT status FROM scheduler_runs WHERE id = ?
    `).get(lease.runId)).toEqual({ status: "outcome_unknown" });
    const expiredRollover = fixture.store.contextRollover(rolloverId);
    expect(expiredRollover).toMatchObject({
      state: "outcome_unknown",
      oldProviderSessionId: "provider-old",
      replacementRunId: lease.runId,
      replacementSessionId: "provider-expired",
    });
    expect(expiredRollover?.replacementVerifiedAt).toBeUndefined();
    expect(fixture.sqlite.prepare(`
      SELECT consumed_at FROM continuation_handoffs WHERE id = ?
    `).get(`handoff:${rolloverId}`)).toEqual({ consumed_at: null });

    const recoveryRequestId = `${fixture.requestId}:live-expiry-recovery`;
    fixture.store.coordinate({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      requesterAgentId: REQUESTER_ID,
      actorScope: "user:local-operator",
      idempotencyKey: "live-expiry-recovery",
      rolloverRecoveryForRequestId: fixture.requestId,
      requests: [{
        requestId: recoveryRequestId,
        recipientAgentId: RECIPIENT_ID,
        lifetime: { kind: "indefinite" },
        payload: { text: "recover after live expiry", retryOfRequestId: fixture.requestId },
      }],
    }, afterExpiry);
    expect(fixture.store.contextRolloverRecoveryForRequest(recoveryRequestId)?.id)
      .toBe(rolloverId);
    const recovery = fixture.store.leaseNextRun({
      workerId: "same-live-daemon",
      now: afterExpiry,
      excludedAgentIds: [REQUESTER_ID],
    });
    expect(recovery?.activationIds).toHaveLength(1);
    expect(fixture.store.contextRolloverCandidateForRun(
      recovery!.runId,
      RECIPIENT_ID,
    )?.id).toBe(rolloverId);
  });

  it("terminally fences a malformed mixed candidate before input binding", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    acknowledgeRun({
      store: fixture.store,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      injectionId: fixture.sourceInjectionId,
      prompt: "source prompt",
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const lease = fixture.store.leaseNextRun({ workerId: "malformed-candidate", now: NOW });
    if (!lease) throw new Error("replacement Run was not leased");
    fixture.store.markRunStarted(lease.runId, lease.fencingToken, NOW);
    const unrelatedActivationId = fixture.store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      scopeKey: SCOPE_KEY,
      messageId: "unrelated-mixed-message",
      kind: "human",
      payload: { text: "unrelated work" },
      now: NOW,
    });
    fixture.sqlite.prepare(`
      UPDATE agent_activations SET state = 'attached', updated_at = ? WHERE id = ?
    `).run(NOW, unrelatedActivationId);
    fixture.sqlite.prepare(`
      INSERT INTO scheduler_run_activations (run_id, activation_id, attached_at)
      VALUES (?, ?, ?)
    `).run(lease.runId, unrelatedActivationId, NOW);
    expect(() => fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "malformed mixed replacement packet",
      sourceManifest: replacementManifest({ activationIds: lease.activationIds, rolloverId }),
      now: NOW,
    })).toThrow("unrelated attached work");
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM provider_inputs WHERE scheduler_run_id = ?
    `).get(lease.runId)).toEqual({ count: 0 });
    expect(fixture.store.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: "malformed-candidate",
      sameRunResumable: false,
      retryDelayMs: 0,
      now: NOW,
    })).toBe("terminal");
    const failed = fixture.store.contextRollover(rolloverId);
    expect(failed).toMatchObject({ state: "failed" });
    expect(failed?.replacementRunId).toBeUndefined();
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
        AND state = 'retry_pending'
    `).get(lease.runId)).toEqual({ count: 0 });
  });

  it("rejects a wrong canonical handoff hash and unrelated replacement sources", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    fixture.store.markRunStarted(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      prompt: "source prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const lease = fixture.store.leaseNextRun({ workerId: "candidate", now: NOW });
    if (!lease) throw new Error("replacement Run was not leased");
    fixture.store.markRunStarted(lease.runId, lease.fencingToken, NOW);
    const canonicalHandoffRun = (fixture.sqlite.prepare(`
      SELECT source_execution_id FROM continuation_handoffs WHERE id = ?
    `).get(`handoff:${rolloverId}`) as { source_execution_id: string }).source_execution_id;
    fixture.sqlite.prepare(`
      UPDATE continuation_handoffs SET source_execution_id = ? WHERE id = ?
    `).run(fixture.sourceRunId, `handoff:${rolloverId}`);
    expect(() => fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "pressure Run is not handoff authority",
      sourceManifest: replacementManifest({ activationIds: lease.activationIds, rolloverId }),
      now: NOW,
    })).toThrow("exact durable handoff");
    fixture.sqlite.prepare(`
      UPDATE continuation_handoffs SET source_execution_id = ? WHERE id = ?
    `).run(canonicalHandoffRun, `handoff:${rolloverId}`);
    const wrongHandoff = replacementManifest({ activationIds: lease.activationIds, rolloverId });
    const handoffSource = wrongHandoff.sources.find((source) => source.kind === "continuation_handoff")!;
    handoffSource.hash = hashFor("different canonical text");
    expect(() => fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "wrong handoff",
      sourceManifest: wrongHandoff,
      now: NOW,
    })).toThrow("exact durable handoff");

    const extraSource = replacementManifest({ activationIds: lease.activationIds, rolloverId });
    extraSource.sources.push({
      kind: "history_message",
      ref: "unrelated-history",
      delivery: "submitted",
      hash: hashFor("unrelated"),
    });
    expect(() => fixture.store.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "extra source",
      sourceManifest: extraSource,
      now: NOW,
    })).toThrow("unapproved source kind");
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM provider_inputs WHERE scheduler_run_id = ?
    `).get(lease.runId)).toEqual({ count: 0 });
  });

  it("fails a replacement that remains above low water without scheduling a rollover loop", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    const continued = fixture.store.prepareContextRolloverContinuation({ id: rolloverId, now: NOW });
    fixture.store.markRunStarted(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    fixture.store.preparePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      prompt: "source prompt",
      now: NOW,
    });
    fixture.store.markPromptSubmitted({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.acknowledgePromptInjection({
      injectionId: fixture.sourceInjectionId,
      runId: fixture.sourceRunId,
      fencingToken: fixture.sourceFencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    fixture.store.completeRun(fixture.sourceRunId, fixture.sourceFencingToken, NOW);
    const lease = fixture.store.leaseNextRun({ workerId: "overflow-worker", now: NOW });
    if (!lease || !continued.continuationActivationId) throw new Error("replacement Run was not leased");
    fixture.store.markRunStarted(lease.runId, lease.fencingToken, NOW);
    fixture.store.recordProviderInput({
      executionId: lease.runId,
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: RECIPIENT_ID,
      projectId: PROJECT_ID,
      prompt: "oversized replacement input",
      sourceManifest: replacementManifest({
        activationIds: lease.activationIds,
        rolloverId,
      }),
      now: NOW,
    });
    fixture.store.commitContextRolloverReplacementInputForRun(lease.runId, RECIPIENT_ID, NOW);
    fixture.store.recordContextRolloverReplacementSessionForRun(
      lease.runId,
      RECIPIENT_ID,
      "provider-overflow",
      NOW,
    );
    expect(fixture.store.observeContextRolloverReplacementOccupancy(
      rolloverId,
      "provider-overflow",
      30_000,
      NOW,
    )).toMatchObject({
      state: "failed",
      failureSignal: "seed_overflow",
      lastError: "Provider execution failed.",
    });
    expect(fixture.sqlite.prepare(`
      SELECT failure_signal, last_error FROM context_rollovers WHERE id = ?
    `).get(rolloverId)).toEqual({
      failure_signal: "seed_overflow",
      last_error: "Provider execution failed.",
    });
    const restarted = new CoordinationV3Store(fixture.sqlite);
    expect(restarted.contextRollover(rolloverId)?.failureSignal).toBe("seed_overflow");
    const recoveryRequestId = `${fixture.requestId}:seed-overflow-recovery`;
    restarted.coordinate({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      requesterAgentId: REQUESTER_ID,
      actorScope: "user:local-operator",
      idempotencyKey: "seed-overflow-recovery-must-remain-fenced",
      rolloverRecoveryForRequestId: fixture.requestId,
      requests: [{
        requestId: recoveryRequestId,
        recipientAgentId: RECIPIENT_ID,
        lifetime: { kind: "indefinite" },
        payload: { text: "retry overflow", retryOfRequestId: fixture.requestId },
      }],
    }, NOW);
    expect(restarted.contextRolloverRecoveryForRequest(recoveryRequestId)).toBeUndefined();
    const replay = fixture.store.requestContextRollover({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      oldProviderSessionId: "provider-old",
      providerSessionGeneration: "generation-1",
      detectedOccupancy: 30_000,
      threshold: 25_000,
      lowWaterMark: 15_000,
      compactionCutoffOrdinal: 42,
      compactionCutoffEventId: "communication-cutoff",
      recentTail: [{
        communicationEventId: "tail-default",
        contentSha256: hashFor("tail-default"),
      }],
      sourceRunId: lease.runId,
      sourceActivationIds: lease.activationIds,
      scopeKey: SCOPE_KEY,
      now: NOW,
    });
    expect(replay.created).toBe(false);
    expect(replay.rollover.id).toBe(rolloverId);
  });

  it("creates exactly one continuation for nonterminal Request lineage", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      sqlite: fixture.sqlite,
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });

    const continued = fixture.store.prepareContextRolloverContinuation({
      id: rolloverId,
      now: NOW,
    });
    expect(continued.state).toBe("continuation_ready");
    const activation = fixture.sqlite.prepare(`
      SELECT scope_key, payload_json FROM agent_activations
      WHERE id = ? AND kind = 'context_rollover_continuation'
    `).get(continued.continuationActivationId) as {
      scope_key: string;
      payload_json: string;
    };
    expect(activation.scope_key).toBe(SCOPE_KEY);
    expect(JSON.parse(activation.payload_json)).toMatchObject({
      rolloverId,
      replyAuthority: { intent: "direct_to_user" },
    });
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM activation_sources
      WHERE activation_id = ? AND source_kind = 'request' AND source_id = ?
    `).get(continued.continuationActivationId, fixture.requestId)).toEqual({
      count: 1,
    });
  });

  it("continues direct work only when an immutable reply route exists", () => {
    for (const withReplyAuthority of [false, true]) {
      const fixture = storeFixture();
      fixture.store.enqueueMessageActivation({
        projectId: PROJECT_ID,
        agentId: RECIPIENT_ID,
        scopeKey: SCOPE_KEY,
        messageId: `message-${withReplyAuthority}`,
        kind: "human",
        payload: { text: "work" },
        now: NOW,
      });
      const lease = fixture.store.leaseNextRun({
        workerId: `worker-${withReplyAuthority}`,
        now: NOW,
      });
      if (!lease) throw new Error("direct source Run was not leased");
      const rolloverId = retireRollover({
        sqlite: fixture.sqlite,
        store: fixture.store,
        sourceRunId: lease.runId,
        sourceActivationIds: lease.activationIds,
        ...(withReplyAuthority
          ? { replyAuthority: { intent: "direct_to_user" as const } }
          : {}),
      });
      const result = fixture.store.prepareContextRolloverContinuation({
        id: rolloverId,
        now: NOW,
      });
      expect(result.state).toBe(
        withReplyAuthority ? "continuation_ready" : "completed",
      );
    }
  });

  it("routes a human-triggered rollover through the same verified continuation protocol", () => {
    const fixture = requestSourceFixture();
    const manualScope = SCOPE_KEY;
    const requested = fixture.store.requestContextRollover({
      projectId: PROJECT_ID,
      agentId: RECIPIENT_ID,
      oldProviderSessionId: "provider-old",
      providerSessionGeneration: "human-generation",
      detectedOccupancy: 12_000,
      threshold: 25_000,
      lowWaterMark: 15_000,
      triggerKind: "human",
      compactionCutoffOrdinal: 42,
      compactionCutoffEventId: "communication-cutoff",
      recentTail: [{
        communicationEventId: "tail-default",
        contentSha256: hashFor("tail-default"),
      }],
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: [],
      scopeKey: manualScope,
      now: NOW,
    });
    expect(requested.rollover.triggerKind).toBe("human");
    fixture.store.commitContextRolloverHandoff(
      requested.rollover.id,
      `handoff:${requested.rollover.id}`,
      NOW,
    );
    fixture.store.beginContextRolloverRetirement(requested.rollover.id, NOW);

    const continued = fixture.store.prepareContextRolloverContinuation({
      id: requested.rollover.id,
      now: NOW,
    });
    expect(continued).toMatchObject({
      state: "continuation_ready",
      triggerKind: "human",
      continuationActivationId: expect.any(String),
    });
    expect(fixture.sqlite.prepare(`
      SELECT scope_key FROM agent_activations WHERE id = ?
    `).get(continued.continuationActivationId)).toEqual({ scope_key: manualScope });
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM activation_sources
      WHERE activation_id = ? AND source_kind IN ('request','request_update','join')
    `).get(continued.continuationActivationId)).toEqual({ count: 0 });
    expect(fixture.store.getRequest(fixture.requestId)?.state).toBe("open");
  });
});
