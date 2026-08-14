import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProviderInputSourceManifest } from "@ponderosa/core";
import { CoordinationV3Store, openDb, type SchedulerLease } from "@ponderosa/agents";
import { afterEach, describe, expect, test } from "vitest";
import { CoordinationV3Scheduler } from "./coordination-v3-scheduler.js";

const NOW = "2026-01-01T00:00:00.000Z";
const AFTER_EXPIRY = "2026-01-01T00:00:02.000Z";
const PROJECT_ID = "project-expiry";
const CONVERSATION_ID = "conversation-expiry";
const REQUESTER_ID = "requester-expiry";
const RECIPIENT_ID = "recipient-expiry";
const SCOPE_KEY = `conversation:${CONVERSATION_ID}`;
const clients: Database.Database[] = [];

afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

const hashFor = (value: string): string => createHash("sha256").update(value).digest("hex");

function replacementManifest(activationIds: string[], rolloverId: string): ProviderInputSourceManifest {
  const handoffId = `handoff:${rolloverId}`;
  const handoffText = `Durable handoff for ${rolloverId}`;
  return {
    schemaVersion: 3,
    historyMessageCount: 1,
    retainedSessionSourceCount: 0,
    activationIds,
    triggerOccurrenceIds: [],
    communicationEventIds: ["tail-default"],
    artifactIds: [],
    conversationId: CONVERSATION_ID,
    providerSessionDisposition: "reseeded",
    sources: [
      { kind: "identity", ref: RECIPIENT_ID, delivery: "submitted" },
      { kind: "policy", ref: "policy", delivery: "submitted", hash: hashFor("policy") },
      { kind: "team_directory", ref: CONVERSATION_ID, delivery: "submitted", hash: hashFor("team") },
      { kind: "communication", ref: "tail-default", delivery: "submitted", hash: hashFor("tail-default") },
      {
        kind: "continuation_handoff",
        ref: handoffId,
        delivery: "submitted",
        hash: hashFor(handoffText),
        createdAt: NOW,
      },
      ...activationIds.map((activationId) => ({
        kind: "activation" as const,
        ref: activationId,
        delivery: "submitted" as const,
      })),
    ],
  };
}

function seedExpiredInjectedReplacement(input: { verified?: boolean } = {}): {
  sqlite: Database.Database;
  store: CoordinationV3Store;
  requestId: string;
  rolloverId: string;
  replacementRun: SchedulerLease;
} {
  const { client: sqlite } = openDb(":memory:");
  clients.push(sqlite);
  sqlite.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'Expiry project', '/tmp/expiry-project', ?, 'codex')
  `).run(PROJECT_ID, NOW);
  sqlite.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at)
    VALUES (?, ?, 'Expiry chat', ?, ?)
  `).run(CONVERSATION_ID, PROJECT_ID, NOW, NOW);
  const insertAgent = sqlite.prepare(`
    INSERT INTO agents (
      id, project_id, conversation_id, title, active_engine, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'codex', ?, ?)
  `);
  insertAgent.run(REQUESTER_ID, PROJECT_ID, CONVERSATION_ID, "Requester", NOW, NOW);
  insertAgent.run(RECIPIENT_ID, PROJECT_ID, CONVERSATION_ID, "Recipient", NOW, NOW);
  sqlite.prepare(`
    INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
    VALUES (?, ?, ?)
  `).run(REQUESTER_ID, CONVERSATION_ID, 0);
  sqlite.prepare(`
    INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
    VALUES (?, ?, ?)
  `).run(RECIPIENT_ID, CONVERSATION_ID, 1);
  const store = new CoordinationV3Store(sqlite);
  const requestId = store.coordinate({
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    requesterAgentId: REQUESTER_ID,
    actorScope: `agent:${REQUESTER_ID}`,
    idempotencyKey: "expiry-source",
    requests: [{
      recipientAgentId: RECIPIENT_ID,
      lifetime: { kind: "indefinite" },
      payload: { text: "continue after rollover" },
    }],
  }, NOW).requestIds[0]!;
  const sourceRun = store.leaseNextRun({ workerId: "source", now: NOW });
  if (!sourceRun) throw new Error("source Run was not leased");
  store.markRunStarted(sourceRun.runId, sourceRun.fencingToken, NOW);
  store.preparePromptInjection({
    injectionId: sourceRun.injectionId,
    runId: sourceRun.runId,
    fencingToken: sourceRun.fencingToken,
    prompt: "source prompt",
    now: NOW,
  });
  store.markPromptSubmitted({
    injectionId: sourceRun.injectionId,
    runId: sourceRun.runId,
    fencingToken: sourceRun.fencingToken,
    providerSessionId: "provider-old",
    now: NOW,
  });
  store.acknowledgePromptInjection({
    injectionId: sourceRun.injectionId,
    runId: sourceRun.runId,
    fencingToken: sourceRun.fencingToken,
    providerSessionId: "provider-old",
    now: NOW,
  });
  const rollover = store.requestContextRollover({
    projectId: PROJECT_ID,
    agentId: RECIPIENT_ID,
    oldProviderSessionId: "provider-old",
    providerSessionGeneration: "generation-expiry",
    detectedOccupancy: 80_000,
    threshold: 75_000,
    lowWaterMark: 25_000,
    compactionCutoffOrdinal: 1,
    compactionCutoffEventId: "tail-default",
    recentTail: [{ communicationEventId: "tail-default", contentSha256: hashFor("tail-default") }],
    sourceRunId: sourceRun.runId,
    sourceActivationIds: sourceRun.activationIds,
    scopeKey: SCOPE_KEY,
    conversationId: CONVERSATION_ID,
    replyAuthority: { intent: "direct_to_user" },
    now: NOW,
  }).rollover;
  store.completeRun(sourceRun.runId, sourceRun.fencingToken, NOW);

  const handoffRun = store.leaseNextRun({ workerId: "handoff", now: NOW });
  if (!handoffRun) throw new Error("handoff Run was not leased");
  store.markRunStarted(handoffRun.runId, handoffRun.fencingToken, NOW);
  store.preparePromptInjection({
    injectionId: handoffRun.injectionId,
    runId: handoffRun.runId,
    fencingToken: handoffRun.fencingToken,
    prompt: "handoff prompt",
    now: NOW,
  });
  store.markPromptSubmitted({
    injectionId: handoffRun.injectionId,
    runId: handoffRun.runId,
    fencingToken: handoffRun.fencingToken,
    providerSessionId: "provider-old",
    now: NOW,
  });
  store.acknowledgePromptInjection({
    injectionId: handoffRun.injectionId,
    runId: handoffRun.runId,
    fencingToken: handoffRun.fencingToken,
    providerSessionId: "provider-old",
    now: NOW,
  });
  const handoffId = `handoff:${rollover.id}`;
  sqlite.prepare(`
    INSERT INTO continuation_handoffs (id, agent_id, source_execution_id, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(handoffId, RECIPIENT_ID, handoffRun.runId, `Durable handoff for ${rollover.id}`, NOW);
  store.commitContextRolloverHandoff(rollover.id, handoffId, NOW);
  store.completeRun(handoffRun.runId, handoffRun.fencingToken, NOW);
  store.beginContextRolloverRetirement(rollover.id, NOW);
  store.prepareContextRolloverContinuation({ id: rollover.id, now: NOW });

  const replacementRun = store.leaseNextRun({
    workerId: "replacement",
    now: NOW,
    leaseMs: 1_000,
  });
  if (!replacementRun) throw new Error("replacement Run was not leased");
  store.markRunStarted(replacementRun.runId, replacementRun.fencingToken, NOW);
  store.recordProviderInputAndCommitContextRolloverReplacement({
    executionId: replacementRun.runId,
    schedulerRunId: replacementRun.runId,
    fencingToken: replacementRun.fencingToken,
    agentId: RECIPIENT_ID,
    projectId: PROJECT_ID,
    prompt: "exact replacement packet",
    sourceManifest: replacementManifest(replacementRun.activationIds, rollover.id),
    now: NOW,
  });
  store.preparePromptInjection({
    injectionId: replacementRun.injectionId,
    runId: replacementRun.runId,
    fencingToken: replacementRun.fencingToken,
    prompt: "exact replacement packet",
    now: NOW,
  });
  store.markPromptSubmitted({
    injectionId: replacementRun.injectionId,
    runId: replacementRun.runId,
    fencingToken: replacementRun.fencingToken,
    providerSessionId: "provider-expired",
    now: NOW,
  });
  store.acknowledgePromptInjection({
    injectionId: replacementRun.injectionId,
    runId: replacementRun.runId,
    fencingToken: replacementRun.fencingToken,
    providerSessionId: "provider-expired",
    now: NOW,
  });
  store.recordContextRolloverReplacementSessionForRun(
    replacementRun.runId,
    RECIPIENT_ID,
    "provider-expired",
    NOW,
  );
  if (input.verified) {
    store.observeContextRolloverReplacementOccupancy(
      rollover.id,
      "provider-expired",
      10_000,
      NOW,
    );
  }
  return { sqlite, store, requestId, rolloverId: rollover.id, replacementRun };
}

describe("CoordinationV3Scheduler rollover expiry recovery", () => {
  test("recovers an injected replacement before saturated capacity accounting", async () => {
    const fixture = seedExpiredInjectedReplacement();
    const leased: SchedulerLease[] = [];
    const scheduler = new CoordinationV3Scheduler(
      fixture.store,
      async (lease) => {
        leased.push(lease);
        return { accepted: true };
      },
      {
        workerId: "same-live-daemon",
        maxConcurrentRuns: 1,
        now: () => Date.parse(AFTER_EXPIRY),
        blockedAgentIds: () => [REQUESTER_ID],
      },
    );

    expect(fixture.store.activeRunCount()).toBe(1);
    expect(await scheduler.drainOnce()).toBe(0);
    expect(fixture.sqlite.prepare(`
      SELECT status FROM scheduler_runs WHERE id = ?
    `).get(fixture.replacementRun.runId)).toEqual({ status: "outcome_unknown" });
    const expired = fixture.store.contextRollover(fixture.rolloverId);
    expect(expired).toMatchObject({
      state: "outcome_unknown",
      oldProviderSessionId: "provider-old",
      replacementRunId: fixture.replacementRun.runId,
      replacementSessionId: "provider-expired",
    });
    expect(expired?.replacementVerifiedAt).toBeUndefined();
    expect(fixture.sqlite.prepare(`
      SELECT consumed_at FROM continuation_handoffs WHERE id = ?
    `).get(`handoff:${fixture.rolloverId}`)).toEqual({ consumed_at: null });

    const recoveryRequestId = `${fixture.requestId}:recovery`;
    fixture.store.coordinate({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      requesterAgentId: REQUESTER_ID,
      actorScope: "user:local-operator",
      idempotencyKey: "expiry-recovery",
      rolloverRecoveryForRequestId: fixture.requestId,
      requests: [{
        requestId: recoveryRequestId,
        recipientAgentId: RECIPIENT_ID,
        lifetime: { kind: "indefinite" },
        payload: { text: "retry after expiry", retryOfRequestId: fixture.requestId },
      }],
    }, AFTER_EXPIRY);
    expect(await scheduler.drainOnce()).toBe(1);
    expect(leased).toHaveLength(1);
    expect(fixture.store.contextRolloverCandidateForRun(
      leased[0]!.runId,
      RECIPIENT_ID,
    )?.id).toBe(fixture.rolloverId);
  });

  test("does not terminalize a matching replacement already verified at low water", async () => {
    const fixture = seedExpiredInjectedReplacement({ verified: true });
    const scheduler = new CoordinationV3Scheduler(
      fixture.store,
      async () => ({ accepted: true }),
      {
        workerId: "same-live-daemon",
        maxConcurrentRuns: 1,
        now: () => Date.parse(AFTER_EXPIRY),
        blockedAgentIds: () => [REQUESTER_ID],
      },
    );

    expect(await scheduler.drainOnce()).toBe(0);
    expect(fixture.sqlite.prepare(`
      SELECT status FROM scheduler_runs WHERE id = ?
    `).get(fixture.replacementRun.runId)).toEqual({ status: "outcome_unknown" });
    expect(fixture.store.contextRollover(fixture.rolloverId)).toMatchObject({
      state: "continuation_ready",
      replacementRunId: fixture.replacementRun.runId,
      replacementVerifiedAt: NOW,
    });
  });
});
