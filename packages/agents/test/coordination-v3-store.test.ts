import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ASSET_LIMITS, type CommunicationEvent } from "@ponderosa/core";
import { CoordinationV3Store } from "../src/coordination-v3-store.js";
import { openDb, type OpenedDb } from "../src/db.js";

let opened: OpenedDb;
let store: CoordinationV3Store;
let projectId: string;
let requesterId: string;
let recipientA: string;
let recipientB: string;
let conversationId: string;

const emptyReservationReceipt = (communicationId: string) => ({
  communicationId,
  attemptId: "00000000-0000-4000-8000-000000000001",
  bindings: [],
});

function seed(): void {
  projectId = randomUUID();
  requesterId = randomUUID();
  recipientA = randomUUID();
  recipientB = randomUUID();
  conversationId = randomUUID();
  opened.client.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'V3', '/repo', '2026-07-15T00:00:00.000Z', 'codex')
  `).run(projectId);
  opened.client.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
    VALUES (?, ?, 'Trigger chat', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
  `).run(conversationId, projectId);
  const insert = opened.client.prepare(`
    INSERT INTO agents (
      id, project_id, title, active_engine, created_at, updated_at, archived
    ) VALUES (?, ?, ?, 'codex', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
  `);
  insert.run(requesterId, projectId, "Requester");
  insert.run(recipientA, projectId, "A");
  insert.run(recipientB, projectId, "B");
  const membership = opened.client.prepare(`
    INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position) VALUES (?, ?, 0)
  `);
  membership.run(requesterId, conversationId);
  membership.run(recipientA, conversationId);
  membership.run(recipientB, conversationId);
}

function seedAdditionalProject(label: string): {
  projectId: string;
  conversationId: string;
  agentId: string;
} {
  const additionalProjectId = randomUUID();
  const additionalConversationId = randomUUID();
  const additionalAgentId = randomUUID();
  opened.client.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, ?, '/repo', '2026-07-15T00:00:00.000Z', 'codex')
  `).run(additionalProjectId, label);
  opened.client.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
    VALUES (?, ?, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
  `).run(additionalConversationId, additionalProjectId, `${label} chat`);
  opened.client.prepare(`
    INSERT INTO agents (
      id, project_id, title, active_engine, created_at, updated_at, archived
    ) VALUES (?, ?, ?, 'codex', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
  `).run(additionalAgentId, additionalProjectId, `${label} agent`);
  opened.client.prepare(`
    INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
    VALUES (?, ?, 0)
  `).run(additionalAgentId, additionalConversationId);
  return {
    projectId: additionalProjectId,
    conversationId: additionalConversationId,
    agentId: additionalAgentId,
  };
}

function createTrigger(id: string, sourceKind: "webhook" | "filesystem" | "schedule" = "webhook"): void {
  store.createTriggerDefinition({
    id, projectId, conversationId, agentId: recipientA,
    name: id, instructions: "Handle this occurrence safely.", sourceKind,
    sourceConfig: sourceKind === "filesystem"
      ? { include: ["**/*"], exclude: [], quietMs: 1_000, maxWindowMs: 10_000 }
      : sourceKind === "schedule"
        ? { scheduleKind: "interval", everyMs: 60_000, startsAt: "2026-07-15T00:01:00.000Z" }
        : { replayWindowSeconds: 300 },
    nextFireAt: sourceKind === "schedule" ? "2026-07-15T00:01:00.000Z" : undefined,
  });
}

beforeEach(() => {
  opened = openDb(":memory:");
  store = new CoordinationV3Store(opened.client, {
    artifactAuthority: (_candidateProjectId, artifact) => ({
      artifact,
      localPath: `/managed/${artifact.id}`,
      contentHash: artifact.blobHash,
      byteLength: artifact.byteLength,
    }),
  });
  seed();
});

afterEach(() => opened.client.close());

const indefinite = { kind: "indefinite" as const };

function userDmEvent(input: {
  eventId: string;
  agentId: string;
  project?: string;
  conversation?: string;
  text?: string;
  createdAt?: string;
}): CommunicationEvent {
  return {
    eventId: input.eventId,
    schemaVersion: 2,
    projectId: input.project ?? projectId,
    ...(input.conversation ? { conversationId: input.conversation } : {}),
    sender: { kind: "user", userId: "local-operator" },
    intent: "user_dm",
    audience: { kind: "user_agent", userId: "local-operator", agentId: input.agentId },
    text: input.text ?? "Current-contract test message",
    createdAt: input.createdAt ?? "2026-07-15T00:00:00.000Z",
  };
}

function runtimeMutationState() {
  const count = (table: string) => (opened.client.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    communications: count("runtime_communications"),
    artifacts: count("runtime_artifacts"),
    activations: count("agent_activations"),
    outbox: count("activation_outbox"),
    retryLineage: count("activation_delivery_retry_lineage"),
    idempotency: count("coordination_idempotency"),
    promptInjections: count("scheduler_prompt_injections"),
    runs: count("scheduler_runs"),
    activeLeases: (opened.client.prepare(
      "SELECT COUNT(*) AS count FROM scheduler_runs WHERE status IN ('leased','running')",
    ).get() as { count: number }).count,
  };
}

function runtimeArtifactInput(
  sequence: number,
  overrides: Partial<{
    originAgentId: string;
    executionId: string;
    role: "long_text" | "document";
    title: string;
    mediaType: "text/markdown";
    blobHash: string;
    byteLength: number;
  }> = {},
) {
  const digest = sequence.toString(16).padStart(64, "0");
  const id = `text-${digest}`;
  return {
    id,
    role: "document" as const,
    title: `Artifact ${sequence}`,
    mediaType: "text/markdown",
    blobPath: id,
    blobHash: "a".repeat(64),
    byteLength: 8,
    ...overrides,
  };
}

function runtimeAttachment(
  agentId: string,
  overrides: Partial<import("@ponderosa/core").AssetDto> = {},
): import("@ponderosa/core").AssetDto {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    agentId,
    name: "evidence.pdf",
    mediaType: "application/pdf",
    size: 42,
    sha256: "b".repeat(64),
    state: "associated",
    createdAt: "2026-07-15T00:00:00.000Z",
    url: `/api/agents/${agentId}/assets/${id}/download`,
    downloadUrl: `/api/agents/${agentId}/assets/${id}/download`,
    ...overrides,
  };
}

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

function openQuestionScenario(prefix: string, input: { submitSteer?: boolean; acknowledgeSteer?: boolean } = {}) {
  const now = "2026-07-15T00:00:00.000Z";
  const requestId = `${prefix}-request`;
  const questionUpdateId = `${prefix}-question`;
  const joinId = `${prefix}-join`;
  store.enqueueMessageActivation({
    projectId, agentId: requesterId, messageId: `${prefix}-human`,
    kind: "human", payload: { text: "Delegate" }, now,
  });
  const requesterRun = store.leaseNextRun({ workerId: "server", now })!;
  acknowledgeLease(requesterRun);
  store.coordinate({
    projectId,
    requesterAgentId: requesterId,
    actorScope: `agent:${requesterId}`,
    idempotencyKey: `${prefix}-coordinate`,
    requests: [{ requestId, recipientAgentId: recipientA, lifetime: indefinite }],
    join: { id: joinId, mode: "all" },
  }, now);
  const recipientRun = store.leaseNextRun({ workerId: "server", now })!;
  acknowledgeLease(recipientRun);
  store.updateRequest({
    requestId,
    updateId: questionUpdateId,
    kind: "question",
    actor: { kind: "agent", id: recipientA },
    payload: { text: "Which contract?" },
    now,
  });
  store.completeRun(recipientRun.runId, recipientRun.fencingToken, now);
  const steering = store.leaseNextSteering({ workerId: "server", now })!;
  store.preparePromptInjection({
    injectionId: steering.injectionId,
    runId: steering.runId,
    fencingToken: steering.fencingToken,
    prompt: "question",
  });
  if (input.submitSteer !== false) store.markPromptSubmitted({
    injectionId: steering.injectionId,
    runId: steering.runId,
    fencingToken: steering.fencingToken,
    now,
  });
  if (input.acknowledgeSteer !== false) store.acknowledgePromptInjection({
    injectionId: steering.injectionId,
    runId: steering.runId,
    fencingToken: steering.fencingToken,
    now,
  });
  return {
    now,
    requestId,
    questionUpdateId,
    joinId,
    requesterRun,
    steering,
  };
}

function createUncertainHumanSteer(eventId: string, now: string) {
  store.enqueueMessageActivation({
    projectId, agentId: recipientA, messageId: `base:${eventId}`, kind: "ordinary", payload: { text: "Base work" }, now,
  });
  const run = store.leaseNextRun({ workerId: "worker-1", now })!;
  acknowledgeLease(run);
  const communication = userDmEvent({
    eventId, agentId: recipientA, project: projectId,
    text: "Change direction", createdAt: now,
  });
  const intake = store.recordRuntimeCommunication({
    id: `dispatch:${eventId}:${recipientA}`,
    projectId,
    sender: communication.sender,
    intent: communication.intent,
    audience: communication.audience,
    payload: {
      communication,
      dispatch: { text: "Change direction" },
    },
    activation: {
      agentId: recipientA, kind: "human_message", priority: 100,
      dispatchPolicy: "steer_or_run", promptClass: "human",
    },
    now,
  });
  const steering = store.leaseNextSteering({ workerId: "worker-1", now })!;
  store.preparePromptInjection({
    injectionId: steering.injectionId, runId: steering.runId,
    fencingToken: steering.fencingToken, prompt: "uncertain steer",
  });
  store.markPromptSubmitted({
    injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken, now,
  });
  store.markSteeringOutcomeUnknown({
    injectionId: steering.injectionId, runId: steering.runId,
    fencingToken: steering.fencingToken, now, recoveryGraceMs: 10_000,
    error: "transport closed after submission",
  });
  return { run, steering, activationId: intake.activationId! };
}

describe("CoordinationV3Store transactions", () => {
  it("projects structurally linked Agent work without inferring from message text", () => {
    const now = new Date().toISOString();
    store.coordinate({
      projectId, conversationId, requesterAgentId: recipientB,
      actorScope: `agent:${recipientB}`, idempotencyKey: "inspect-continuation",
      requests: [{ requestId: "continuation-request", recipientAgentId: requesterId, lifetime: indefinite }],
    });
    store.coordinate({
      projectId, conversationId, requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`, idempotencyKey: "inspect-work",
      requests: [{ requestId: "inspect-request", recipientAgentId: recipientA, lifetime: indefinite, payload: { assignment: "Inspect me" } }],
      join: { id: "inspect-join", mode: "all", wakePolicy: "each_result", continuationRequestIds: ["continuation-request"] },
    });

    let { items } = store.agentWorkItems({ projectId, conversationId });
    const request = items.find((item) => item.id === "request:inspect-request")!;
    const waiting = items.find((item) => item.id === "join:inspect-join")!;
    const activation = items.find((item) => item.kind === "activation" && item.relatedItemIds.includes(request.id))!;
    expect(request.relatedItemIds).toContain(waiting.id);
    expect(waiting.relatedItemIds).toContain(request.id);
    expect(waiting.relatedItemIds).toContain("request:continuation-request");
    const lightweight = store.agentWorkItems({ projectId, conversationId });
    expect(lightweight.items.find((item) => item.id === request.id)?.details).toBeUndefined();
    expect(lightweight.items.find((item) => item.id === waiting.id)?.details).toBeUndefined();
    expect(store.agentWorkItemDetails({
      projectId, conversationId, kind: "request", recordId: "inspect-request",
    })).toContainEqual({ label: "Payload", value: '{"assignment":"Inspect me"}' });
    expect(store.agentWorkItemDetails({
      projectId, conversationId, kind: "join", recordId: "inspect-join",
    })).toContainEqual({ label: "Wake policy", value: "Each result" });

    store.coordinate({
      projectId, conversationId, requesterAgentId: recipientB,
      actorScope: `agent:${recipientB}`, idempotencyKey: "inspect-unrelated",
      requests: [{ requestId: "unrelated-request", recipientAgentId: requesterId, lifetime: indefinite }],
    });
    const scoped = store.agentWorkItems({ projectId, conversationId, agentId: recipientA });
    expect(scoped.items.some((item) => item.id === "request:inspect-request")).toBe(true);
    expect(scoped.items.some((item) => item.id === "join:inspect-join")).toBe(true);
    expect(scoped.items.some((item) => item.id === "request:unrelated-request")).toBe(false);
    expect(scoped.truncated).toBe(false);
    const bounded = store.agentWorkItems({ projectId, conversationId, agentId: recipientA, limit: 1 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.items.length).toBeLessThanOrEqual(4);

    store.updateRequest({
      requestId: "inspect-request", updateId: "inspect-question", kind: "question",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Need a detail" }, now,
    });
    ({ items } = store.agentWorkItems({ projectId, conversationId }));
    const questionActivation = items.find((item) => item.kind === "activation" && item.referenceIds.includes("inspect-question"))!;
    expect(questionActivation.relatedItemIds).toContain(request.id);

    const lease = store.leaseNextRun({ workerId: "inspector-test", now: new Date(Date.now() + 1_000).toISOString(), excludedAgentIds: [requesterId, recipientB] })!;
    ({ items } = store.agentWorkItems({ projectId, conversationId }));
    const run = items.find((item) => item.referenceIds.includes(lease.runId))!;
    const attachedActivation = items.find((item) => item.id === activation.id)!;
    expect(run.kind).toBe("run");
    expect(run.relatedItemIds).toContain(activation.id);
    expect(attachedActivation.relatedItemIds).toContain(run.id);
  });

  it("records passive communication without waking and routes actionable communication only through the scheduler", () => {
    const now = "2026-07-15T00:00:00.000Z";
    expect(store.recordRuntimeCommunication({
      id: "broadcast", projectId, sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: projectId }, payload: { text: "FYI" }, now,
    })).toEqual({ id: "broadcast", replayed: false });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM agent_activations").get()).toEqual({ count: 0 });

    const direct = store.recordRuntimeCommunication({
      id: "direct", projectId, sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: requesterId }, payload: { text: "Start" }, now,
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
      id: "direct", projectId, sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: requesterId }, payload: { text: "Start" }, now,
      activation: {
        agentId: requesterId, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
    }).replayed).toBe(true);
    expect(store.runtimeCommunications(projectId)).toEqual([
      { id: "broadcast", projectId, audience: { kind: "organization", organizationId: projectId }, payload: { text: "FYI" }, createdAt: now },
      { id: "direct", projectId, audience: { kind: "user_agent", userId: "local-operator", agentId: requesterId }, payload: { text: "Start" }, createdAt: now },
    ]);
  });

  it("keyset-pages Team operational records without rebuilding per-Agent snapshots", () => {
    for (let index = 0; index < 3; index += 1) {
      store.recordRuntimeCommunication({
        id: `team-page-${index}`, projectId, sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        scopeKey: `conversation:${conversationId}`,
        audience: { kind: "user_agent", userId: "local-operator", agentId: recipientA }, payload: { text: `Work ${index}` },
        now: `2026-07-15T00:00:0${index}.000Z`,
        activation: {
          agentId: recipientA, kind: "human_message", priority: 100,
          dispatchPolicy: "steer_or_run", promptClass: "human",
        },
      });
    }
    const first = store.teamOperationalRecords({ projectId, conversationId, limit: 2 });
    expect(first).toHaveLength(2);
    expect(first.map((item) => item.createdAt)).toEqual([
      "2026-07-15T00:00:02.000Z", "2026-07-15T00:00:01.000Z",
    ]);
    const oldest = first.at(-1)!;
    const second = store.teamOperationalRecords({
      projectId, conversationId, limit: 2,
      before: { createdAt: oldest.createdAt, id: oldest.id },
    });
    expect(second.map((item) => item.createdAt)).toEqual(["2026-07-15T00:00:00.000Z"]);
    expect(new Set([...first, ...second].map((item) => item.id)).size).toBe(3);
  });

  it("does not skip unseen Team operations when their mutable state advances after a page", () => {
    const activationIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const recorded = store.recordRuntimeCommunication({
        id: `team-mutation-${index}`, projectId, sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        scopeKey: `conversation:${conversationId}`,
        audience: { kind: "user_agent", userId: "local-operator", agentId: recipientA }, payload: { text: `Work ${index}` },
        now: `2026-07-15T00:00:0${index}.000Z`,
        activation: {
          agentId: recipientA, kind: "human_message", priority: 100,
          dispatchPolicy: "steer_or_run", promptClass: "human",
        },
      });
      activationIds.push(recorded.activationId!);
    }
    const first = store.teamOperationalRecords({ projectId, conversationId, limit: 2 });
    const boundary = first.at(-1)!;

    opened.client.prepare(`UPDATE agent_activations SET state = 'cancelled', updated_at = ? WHERE id = ?`)
      .run("2026-07-16T00:00:00.000Z", activationIds[0]);

    const second = store.teamOperationalRecords({
      projectId, conversationId, limit: 2,
      before: { createdAt: boundary.createdAt, id: boundary.id },
    });
    expect(new Set([...first, ...second].map((item) => item.id))).toEqual(
      new Set(activationIds.map((id) => `activation:${id}`)),
    );
    expect(second.find((item) => item.id === `activation:${activationIds[0]}`)?.state).toBe("cancelled");
  });

  it("pages equal-time Team operation subtypes with the namespaced stable ID tie-breaker", () => {
    const tiedAt = "2026-07-15T00:00:00.000Z";
    store.coordinate({
      projectId, conversationId, requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`, idempotencyKey: "tied-operation",
      requests: [{ requestId: "tied-request", recipientAgentId: recipientA, lifetime: indefinite }],
      now: tiedAt,
    });
    opened.client.prepare(`UPDATE coordination_requests SET created_at = ?, updated_at = ? WHERE id = 'tied-request'`).run(tiedAt, tiedAt);
    opened.client.prepare(`UPDATE agent_activations SET created_at = ?, updated_at = ? WHERE id IN (
      SELECT activation_id FROM activation_sources WHERE source_kind = 'request' AND source_id = 'tied-request'
    )`).run(tiedAt, tiedAt);
    const first = store.teamOperationalRecords({ projectId, conversationId, limit: 1 });
    const second = store.teamOperationalRecords({
      projectId, conversationId, limit: 2,
      before: { createdAt: first[0]!.createdAt, id: first[0]!.id },
    });
    expect([...first, ...second].map((item) => item.id)).toEqual([
      "request:tied-request",
      expect.stringMatching(/^activation:/u),
    ]);
    expect([...first, ...second].map((item) => item.operationGroupId)).toEqual([
      "request:tied-request",
      "request:tied-request",
    ]);
    expect([...first, ...second].every((item) => item.createdAt === tiedAt)).toBe(true);
  });

  it("projects one canonical operation group across a Request, Activation, and single-source Run", () => {
    const now = "2026-07-15T00:00:00.000Z";
    store.enqueueMessageActivation({
      projectId,
      agentId: requesterId,
      messageId: "grouped-requester-message",
      kind: "human",
      payload: { text: "Delegate" },
      now,
    });
    const requesterRun = store.leaseNextRun({ workerId: "server", now })!;
    acknowledgeLease(requesterRun);
    store.coordinate({
      projectId,
      conversationId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "grouped-operation",
      requests: [{ requestId: "grouped-request", recipientAgentId: recipientA, lifetime: indefinite }],
    }, now);
    const recipientRun = store.leaseNextRun({ workerId: "server", now })!;
    acknowledgeLease(recipientRun);

    const records = store.teamOperationalRecords({ projectId, conversationId, limit: 10 });
    const grouped = records.filter(record =>
      record.id === "request:grouped-request" ||
      ((record.kind === "run" || record.kind === "activation") &&
        record.primaryAgentId === recipientA),
    );
    expect(grouped).toHaveLength(3);
    expect(grouped.every(record => record.operationGroupId === "request:grouped-request")).toBe(true);
  });

  it("returns the 1,001st internal sentinel for a public 1,000-row page", () => {
    for (let index = 0; index < 1_001; index += 1) {
      const recorded = store.recordRuntimeCommunication({
        id: `sentinel-${index}`, projectId, sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        scopeKey: `conversation:${conversationId}`,
        audience: { kind: "user_agent", userId: "local-operator", agentId: recipientA }, payload: { text: `Work ${index}` },
        now: new Date(Date.UTC(2027, 0, 1, 0, 0, 0, index)).toISOString(),
        activation: {
          agentId: recipientA, kind: "human_message", priority: 100,
          dispatchPolicy: "steer_or_run", promptClass: "human",
        },
      });
      store.cancelPendingActivation({
        activationId: recorded.activationId!, projectId,
        idempotencyKey: `cancel-sentinel-${index}`,
        now: new Date(Date.UTC(2027, 0, 1, 0, 0, 1, index)).toISOString(),
      });
    }
    const pageWithSentinel = store.teamOperationalRecords({ projectId, conversationId, limit: 1_001 });
    expect(pageWithSentinel).toHaveLength(1_001);
  });

  it("reports truncation when one Agent has more same-kind seeds than the requested limit", () => {
    for (let index = 0; index < 5; index += 1) {
      store.recordRuntimeCommunication({
        id: `bounded-direct-${index}`, projectId, sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: recipientA }, payload: { text: `Message ${index}` },
        now: `2026-07-15T00:00:0${index}.000Z`,
        activation: {
          agentId: recipientA, kind: "human_message", priority: 100,
          dispatchPolicy: "steer_or_run", promptClass: "human",
        },
      });
    }
    const projection = store.agentWorkItems({ projectId, agentId: recipientA, limit: 2 });
    expect(projection.items.filter((item) => item.kind === "activation")).toHaveLength(2);
    expect(projection.truncated).toBe(true);
    const projectProjection = store.agentWorkItems({ projectId, limit: 2 });
    expect(projectProjection.items.filter((item) => item.kind === "activation")).toHaveLength(2);
    expect(projectProjection.truncated).toBe(true);
  });

  it("keeps unresolved Agent work visible ahead of newer terminal history", () => {
    store.coordinate({
      projectId, conversationId, requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`, idempotencyKey: "old-open",
      requests: [{ requestId: "old-open", recipientAgentId: recipientA, lifetime: indefinite }],
    });
    opened.client.prepare(`UPDATE coordination_requests SET created_at = ?, updated_at = ? WHERE id = 'old-open'`)
      .run("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    for (let index = 0; index < 4; index += 1) {
      const requestId = `new-complete-${index}`;
      store.coordinate({
        projectId, conversationId, requesterAgentId: requesterId,
        actorScope: `agent:${requesterId}`, idempotencyKey: requestId,
        requests: [{ requestId, recipientAgentId: recipientA, lifetime: indefinite }],
      });
      opened.client.prepare(`
        UPDATE coordination_requests SET state = 'completed', terminal_at = ?, updated_at = ? WHERE id = ?
      `).run(`2026-07-15T00:00:0${index}.000Z`, `2026-07-15T00:00:0${index}.000Z`, requestId);
    }
    const projection = store.agentWorkItems({ projectId, conversationId, agentId: recipientA, limit: 2 });
    expect(projection.items.some((item) => item.id === "request:old-open" && item.state === "open")).toBe(true);
    expect(projection.truncated).toBe(true);
  });

  it("uses scheduler state as Run authority while exposing a stale execution projection only in details", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "cancel-authority", kind: "ordinary", payload: { text: "Work" },
    });
    const lease = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(lease);
    store.recordProviderInput({
      executionId: "execution-authority", schedulerRunId: lease.runId, fencingToken: lease.fencingToken,
      agentId: recipientA, projectId, prompt: "Work",
      sourceManifest: {
        schemaVersion: 1, historyMessageCount: 0, activationIds: lease.activationIds,
        communicationEventIds: [], artifactIds: [], providerSessionDisposition: "fresh_task", sources: [],
      },
    });
    const now = new Date().toISOString();
    opened.client.prepare(`
      INSERT INTO runs (id, agent_id, title, status, reason, engine, started_at, updated_at)
      VALUES ('execution-authority', ?, 'Run', 'running', 'activation', 'codex', ?, ?)
    `).run(recipientA, now, now);
    expect(store.cancelAgentRun({ agentId: recipientA, expectedRunId: lease.runId, idempotencyKey: "cancel-authority" }).cancelled).toBe(true);

    const item = store.agentWorkItems({ projectId, agentId: recipientA }).items.find((candidate) => candidate.id === "run:execution-authority")!;
    expect(item.state).toBe("cancelled");
    const details = store.agentWorkItemDetails({ projectId, kind: "run", recordId: "execution-authority" });
    expect(details).toContainEqual({ label: "Execution projection status", value: "running" });
    expect(details).toContainEqual({ label: "Scheduler status", value: "cancelled" });
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

    store.updateRequest({
      requestId: "coalesced-a", updateId: "coalesced-a-done", kind: "completed",
      actor: { kind: "agent", id: recipientA },
    });
    store.updateRequest({
      requestId: "coalesced-b", updateId: "coalesced-b-done", kind: "completed",
      actor: { kind: "agent", id: recipientB },
    });
    const terminalDuplicate = store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "redundant-after-satisfaction", requests: [],
      join: { id: "redundant-terminal-join", mode: "all", requestIds: created.requestIds },
    });
    expect(terminalDuplicate).toEqual({ requestIds: [], joinId: "canonical-join", replayed: false });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_joins").get()).toEqual({ count: 1 });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'coordination_join_satisfied'
    `).get()).toEqual({ count: 1 });
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

  it("retries an unanswered question steer once, then fails closed instead of stranding its Join", () => {
    const now = "2026-07-15T00:00:00.000Z";
    store.enqueueMessageActivation({
      projectId, agentId: requesterId, messageId: "human-unanswered-question",
      kind: "human", payload: { text: "Delegate" }, now,
    });
    const requesterRun = store.leaseNextRun({ workerId: "server", now })!;
    acknowledgeLease(requesterRun);
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "unanswered-question-cycle", requests: [{
        requestId: "unanswered-question-request", recipientAgentId: recipientA, lifetime: indefinite,
      }], join: { id: "unanswered-question-join", mode: "all" },
    }, now);
    const recipientRun = store.leaseNextRun({ workerId: "server", now })!;
    acknowledgeLease(recipientRun);
    store.updateRequest({
      requestId: "unanswered-question-request", updateId: "unanswered-question-1", kind: "question",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Which contract?" }, now,
    });
    store.completeRun(recipientRun.runId, recipientRun.fencingToken, now);

    const steering = store.leaseNextSteering({ workerId: "server", now })!;
    expect(steering.activations).toEqual([
      expect.objectContaining({ kind: "coordination_question" }),
    ]);
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

    store.completeRun(requesterRun.runId, requesterRun.fencingToken, now);
    expect(store.getRequest("unanswered-question-request")?.state).toBe("awaiting_answer");
    expect(opened.client.prepare(`
      SELECT state, dispatch_policy FROM agent_activations WHERE id = ?
    `).get(steering.activationIds[0]!)).toEqual({
      state: "retry_pending", dispatch_policy: "next_run",
    });
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = 'unanswered-question-join'
    `).get()).toEqual({ state: "open" });

    const dedicatedQuestionRun = store.leaseNextRun({ workerId: "server", now })!;
    expect(dedicatedQuestionRun.agentId).toBe(requesterId);
    expect(dedicatedQuestionRun.activationIds).toEqual(steering.activationIds);
    acknowledgeLease(dedicatedQuestionRun);
    store.completeRun(dedicatedQuestionRun.runId, dedicatedQuestionRun.fencingToken, now);

    expect(store.getRequest("unanswered-question-request")?.state).toBe("outcome_unknown");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = 'unanswered-question-join'
    `).get()).toEqual({ state: "impossible" });
    expect(opened.client.prepare(`
      SELECT kind, resulting_state, payload_json
      FROM coordination_request_updates
      WHERE request_id = 'unanswered-question-request'
        AND kind = 'outcome_unknown'
    `).get()).toEqual({
      kind: "outcome_unknown",
      resulting_state: "outcome_unknown",
      payload_json: JSON.stringify({
        questionUpdateId: "unanswered-question-1",
        reason: "requester_run_completed_without_answer",
        runId: dedicatedQuestionRun.runId,
      }),
    });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_activations
      WHERE kind = 'coordination_question' AND state IN ('pending', 'retry_pending', 'attached')
    `).get()).toEqual({ count: 0 });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_impossible' AND state = 'pending'
    `).get(requesterId)).toEqual({ count: 1 });
  });

  it("terminalizes an unanswered correlated question when its requester Run is cancelled", () => {
    const scenario = openQuestionScenario("cancelled-question");
    store.cancelAgentRun({
      agentId: requesterId,
      expectedRunId: scenario.requesterRun.runId,
      idempotencyKey: "cancel-question-requester",
      now: scenario.now,
    });

    expect(store.getRequest(scenario.requestId)?.state).toBe("outcome_unknown");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = ?
    `).get(scenario.joinId)).toEqual({ state: "impossible" });
  });

  it("terminalizes an unanswered correlated question on provider outcome uncertainty", () => {
    const scenario = openQuestionScenario("provider-unknown-question");
    expect(store.failRun({
      runId: scenario.requesterRun.runId,
      fencingToken: scenario.requesterRun.fencingToken,
      workerId: "server",
      sameRunResumable: false,
      error: "provider transport closed after execution",
      now: scenario.now,
    })).toBe("outcome_unknown");

    expect(store.getRequest(scenario.requestId)?.state).toBe("outcome_unknown");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = ?
    `).get(scenario.joinId)).toEqual({ state: "impossible" });
  });

  it("terminalizes an unanswered question when its dedicated delivery exhausts retries", () => {
    const scenario = openQuestionScenario("question-retry-exhausted");
    store.completeRun(
      scenario.requesterRun.runId,
      scenario.requesterRun.fencingToken,
      scenario.now,
    );
    const dedicated = store.leaseNextRun({ workerId: "server", now: scenario.now })!;
    expect(dedicated.agentId).toBe(requesterId);

    expect(store.failRun({
      runId: dedicated.runId,
      fencingToken: dedicated.fencingToken,
      workerId: "server",
      sameRunResumable: false,
      confirmedNotExecuted: true,
      retryable: false,
      terminalOutcome: "permanent_failure",
      maxDeliveryFailures: 1,
      error: "provider is unavailable",
      now: scenario.now,
    })).toBe("terminal");

    expect(store.getRequest(scenario.requestId)?.state).toBe("outcome_unknown");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = ?
    `).get(scenario.joinId)).toEqual({ state: "impossible" });
  });

  it("cancels a promoted question Activation when its Request is cancelled", () => {
    const scenario = openQuestionScenario("cancelled-after-promotion");
    store.completeRun(
      scenario.requesterRun.runId,
      scenario.requesterRun.fencingToken,
      scenario.now,
    );
    store.updateRequest({
      requestId: scenario.requestId,
      updateId: "cancel-after-promotion",
      kind: "cancelled",
      actor: { kind: "agent", id: requesterId },
      now: scenario.now,
    });

    expect(opened.client.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(scenario.steering.activationIds[0]!)).toEqual({ state: "cancelled" });
    expect(store.getRequest(scenario.requestId)?.state).toBe("cancelled");
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'coordination_question' AND state IN ('pending', 'retry_pending')
    `).get()).toEqual({ count: 0 });
  });

  it("terminalizes an unanswered correlated question during injected-Run restart recovery", () => {
    const scenario = openQuestionScenario("restart-question");
    expect(store.recoverOrphanedRuns("replacement-worker", scenario.now)).toEqual({
      retried: 0,
      outcomeUnknown: 1,
    });

    expect(store.getRequest(scenario.requestId)?.state).toBe("outcome_unknown");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = ?
    `).get(scenario.joinId)).toEqual({ state: "impossible" });
  });

  it("terminalizes only the correlated question whose steering delivery is uncertain", () => {
    const scenario = openQuestionScenario("uncertain-question", { acknowledgeSteer: false });
    store.markSteeringOutcomeUnknown({
      injectionId: scenario.steering.injectionId,
      runId: scenario.steering.runId,
      fencingToken: scenario.steering.fencingToken,
      now: scenario.now,
      error: "transport closed after submission",
    });

    expect(store.getRequest(scenario.requestId)?.state).toBe("outcome_unknown");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = ?
    `).get(scenario.joinId)).toEqual({ state: "impossible" });
  });

  it("cancels a promoted question Activation when the exact question is answered", () => {
    const scenario = openQuestionScenario("answered-after-promotion");
    store.completeRun(
      scenario.requesterRun.runId,
      scenario.requesterRun.fencingToken,
      scenario.now,
    );
    expect(opened.client.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(scenario.steering.activationIds[0]!)).toEqual({ state: "retry_pending" });

    store.updateRequest({
      requestId: scenario.requestId,
      updateId: "answer-after-promotion",
      kind: "answer",
      actor: { kind: "agent", id: requesterId },
      inReplyToUpdateId: scenario.questionUpdateId,
      payload: { text: "Use the original contract" },
      now: scenario.now,
    });

    expect(opened.client.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(scenario.steering.activationIds[0]!)).toEqual({ state: "cancelled" });
    expect(store.leaseNextRun({ workerId: "server", now: scenario.now })?.agentId).toBe(recipientA);
  });

  it("fences an uninjected dedicated question Run when the exact question is answered", () => {
    const scenario = openQuestionScenario("answered-after-question-lease");
    store.completeRun(
      scenario.requesterRun.runId,
      scenario.requesterRun.fencingToken,
      scenario.now,
    );
    const dedicated = store.leaseNextRun({ workerId: "server", now: scenario.now })!;
    expect(dedicated.activationIds).toEqual(scenario.steering.activationIds);

    store.updateRequest({
      requestId: scenario.requestId,
      updateId: "answer-after-question-lease",
      kind: "answer",
      actor: { kind: "agent", id: requesterId },
      inReplyToUpdateId: scenario.questionUpdateId,
      payload: { text: "Use the original contract" },
      now: scenario.now,
    });

    expect(opened.client.prepare(`
      SELECT status, prompt_injection_state, side_effects_fenced_at
      FROM scheduler_runs WHERE id = ?
    `).get(dedicated.runId)).toEqual({
      status: "cancelled",
      prompt_injection_state: "not_injected",
      side_effects_fenced_at: scenario.now,
    });
    expect(opened.client.prepare(`
      SELECT state FROM scheduler_prompt_injections WHERE id = ?
    `).get(dedicated.injectionId)).toEqual({ state: "cancelled" });
    expect(opened.client.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(scenario.steering.activationIds[0]!)).toEqual({ state: "cancelled" });
    expect(() => store.markPromptSubmitted({
      injectionId: dedicated.injectionId,
      runId: dedicated.runId,
      fencingToken: dedicated.fencingToken,
      now: scenario.now,
    })).toThrow("stale run fencing token");
  });

  it("suspends an outbound question on a delegated Join and restores answer authority", () => {
    const scenario = openQuestionScenario("join-suspended-question");
    const delegated = store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "question-dependency-join",
      requests: [{
        requestId: "question-dependency-work",
        recipientAgentId: recipientB,
        lifetime: indefinite,
      }],
      join: {
        id: "question-dependency-join",
        mode: "all",
        continuationRequestIds: [scenario.requestId],
      },
    }, scenario.now);
    expect(delegated.joinId).toBe("question-dependency-join");

    store.completeRun(
      scenario.requesterRun.runId,
      scenario.requesterRun.fencingToken,
      scenario.now,
    );
    expect(store.getRequest(scenario.requestId)?.state).toBe("awaiting_answer");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_question_suspensions
      WHERE dependency_kind = 'join' AND dependency_id = 'question-dependency-join'
    `).get()).toEqual({ state: "open" });

    const helperRun = store.leaseNextRun({ workerId: "server", now: scenario.now })!;
    expect(helperRun.agentId).toBe(recipientB);
    acknowledgeLease(helperRun);
    store.updateRequest({
      requestId: "question-dependency-work",
      updateId: "question-dependency-completed",
      kind: "completed",
      actor: { kind: "agent", id: recipientB },
      runAuthorization: {
        runId: helperRun.runId,
        agentId: recipientB,
        fencingToken: helperRun.fencingToken,
      },
      payload: { answer: "Use contract B" },
      now: scenario.now,
    });
    store.completeRun(helperRun.runId, helperRun.fencingToken, scenario.now);

    const continuationRun = store.leaseNextRun({ workerId: "server", now: scenario.now })!;
    expect(continuationRun.agentId).toBe(requesterId);
    acknowledgeLease(continuationRun);
    expect(store.requestIdsAttachedToRun(continuationRun.runId, requesterId))
      .toContain(scenario.requestId);
    store.updateRequest({
      requestId: scenario.requestId,
      updateId: "join-informed-answer",
      kind: "answer",
      actor: { kind: "agent", id: requesterId },
      runAuthorization: {
        runId: continuationRun.runId,
        agentId: requesterId,
        fencingToken: continuationRun.fencingToken,
      },
      inReplyToUpdateId: scenario.questionUpdateId,
      payload: { text: "Use contract B" },
      now: scenario.now,
    });
    store.completeRun(continuationRun.runId, continuationRun.fencingToken, scenario.now);

    expect(store.getRequest(scenario.requestId)?.state).toBe("in_progress");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_question_suspensions
      WHERE dependency_kind = 'join' AND dependency_id = 'question-dependency-join'
    `).get()).toEqual({ state: "resolved" });
  });

  it("suspends an outbound question on a blocking Decision and restores answer authority", () => {
    const scenario = openQuestionScenario("decision-suspended-question");
    expect(store.suspendQuestionsForDecision({
      runId: scenario.requesterRun.runId,
      agentId: requesterId,
      decisionId: "decision-1",
      requestIds: [scenario.requestId],
      now: scenario.now,
    })).toEqual([scenario.requestId]);
    store.completeRun(
      scenario.requesterRun.runId,
      scenario.requesterRun.fencingToken,
      scenario.now,
    );
    expect(store.getRequest(scenario.requestId)?.state).toBe("awaiting_answer");

    const decisionActivationId = store.enqueueMessageActivation({
      projectId,
      agentId: requesterId,
      messageId: "decision-1:response",
      kind: "human",
      payload: { decision: { id: "decision-1", response: { text: "Contract A" } } },
      questionDependency: { kind: "decision", id: "decision-1" },
      now: scenario.now,
    });
    expect(JSON.parse((opened.client.prepare(`
      SELECT payload_json FROM agent_activations WHERE id = ?
    `).get(decisionActivationId) as { payload_json: string }).payload_json)).toMatchObject({
      continuationQuestions: [{
        requestId: scenario.requestId,
        inReplyToUpdateId: scenario.questionUpdateId,
      }],
      continuationInstruction: expect.stringContaining("exact inReplyToUpdateId"),
    });
    const decisionRun = store.leaseNextRun({ workerId: "server", now: scenario.now })!;
    acknowledgeLease(decisionRun);
    expect(store.requestIdsAttachedToRun(decisionRun.runId, requesterId))
      .toContain(scenario.requestId);
    store.updateRequest({
      requestId: scenario.requestId,
      updateId: "decision-informed-answer",
      kind: "answer",
      actor: { kind: "agent", id: requesterId },
      runAuthorization: {
        runId: decisionRun.runId,
        agentId: requesterId,
        fencingToken: decisionRun.fencingToken,
      },
      inReplyToUpdateId: scenario.questionUpdateId,
      payload: { text: "Contract A" },
      now: scenario.now,
    });
    store.completeRun(decisionRun.runId, decisionRun.fencingToken, scenario.now);

    expect(store.getRequest(scenario.requestId)?.state).toBe("in_progress");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_question_suspensions
      WHERE dependency_kind = 'decision' AND dependency_id = 'decision-1'
    `).get()).toEqual({ state: "resolved" });
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

  it("diagnoses long-lived indefinite coordination cycles without rejecting them", () => {
    const now = "2026-07-15T00:00:00.000Z";
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "cycle-a", requests: [
        { requestId: "cycle-a", recipientAgentId: recipientA, lifetime: indefinite },
      ],
    }, now);
    store.coordinate({
      projectId, requesterAgentId: recipientA, actorScope: `agent:${recipientA}`,
      idempotencyKey: "cycle-b", requests: [
        { requestId: "cycle-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
    }, now);
    store.coordinate({
      projectId, requesterAgentId: recipientB, actorScope: `agent:${recipientB}`,
      idempotencyKey: "cycle-c", requests: [
        { requestId: "cycle-c", recipientAgentId: requesterId, lifetime: indefinite },
      ],
    }, now);

    expect(store.waitGraphCycles("2026-07-15T00:10:00.000Z")).toEqual([{
      agentIds: [requesterId, recipientA, recipientB].sort(),
      requestIds: ["cycle-a", "cycle-b", "cycle-c"],
      oldestRequestAt: now,
    }]);
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
      wakePolicy: "final_only",
      progress: { terminal: 2, total: 2, remaining: 0 },
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

  it("rolls back a terminal result, Request, Join, and wake together when wake persistence fails", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "atomic-terminal", requests: [
        { requestId: "atomic-child", recipientAgentId: recipientA, lifetime: indefinite },
      ],
      join: { id: "atomic-join", mode: "all" },
    });
    opened.client.exec(`
      CREATE TRIGGER fail_atomic_join_wake
      BEFORE INSERT ON agent_activations
      WHEN NEW.kind = 'coordination_join_satisfied'
      BEGIN SELECT RAISE(ABORT, 'simulated crash before wake commit'); END;
    `);
    expect(() => store.updateRequest({
      requestId: "atomic-child", updateId: "atomic-result", kind: "completed",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Result is durable only atomically." },
    })).toThrow("simulated crash");
    expect(store.getRequest("atomic-child")).toMatchObject({ state: "open" });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'atomic-join'").get())
      .toEqual({ state: "open" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates WHERE id = 'atomic-result'
    `).get()).toEqual({ count: 0 });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'coordination_join_satisfied'
    `).get()).toEqual({ count: 0 });

    opened.client.exec("DROP TRIGGER fail_atomic_join_wake");
    expect(store.updateRequest({
      requestId: "atomic-child", updateId: "atomic-result", kind: "completed",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Result is durable only atomically." },
    })).toMatchObject({ state: "completed", replayed: false });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'atomic-join'").get())
      .toEqual({ state: "satisfied" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'coordination_join_satisfied'
    `).get()).toEqual({ count: 1 });
  });

  it("streams aggregate join progress once per terminal member before one final wake", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "streaming-join", requests: [
        { requestId: "stream-a", recipientAgentId: recipientA, lifetime: indefinite, payload: { text: "A" }, replyAuthority: { intent: "direct_to_user" } },
        { requestId: "stream-b", recipientAgentId: recipientB, lifetime: indefinite, payload: { text: "B" }, replyAuthority: { intent: "direct_to_user" } },
      ],
      join: { id: "stream-both", mode: "all", wakePolicy: "each_result" },
    });

    store.updateRequest({
      requestId: "stream-a", updateId: "stream-a-done", kind: "completed",
      actor: { kind: "agent", id: recipientA }, payload: { text: "A done" },
    });
    expect(opened.client.prepare("SELECT state, wake_policy FROM coordination_joins WHERE id = 'stream-both'").get())
      .toEqual({ state: "open", wake_policy: "each_result" });
    const progress = opened.client.prepare(`
      SELECT payload_json FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_progress'
    `).get(requesterId) as { payload_json: string };
    expect(JSON.parse(progress.payload_json)).toMatchObject({
      joinId: "stream-both", state: "open", wakePolicy: "each_result",
      replyAuthority: { intent: "direct_to_user" },
      progress: { terminal: 1, total: 2, remaining: 1, newlyTerminalRequestIds: ["stream-a"] },
      outcomes: [{ requestId: "stream-a", state: "completed" }],
    });

    store.updateRequest({
      requestId: "stream-b", updateId: "stream-b-done", kind: "completed",
      actor: { kind: "agent", id: recipientB }, payload: { text: "B done" },
    });
    expect(opened.client.prepare(`
      SELECT kind, COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind LIKE 'coordination_join_%'
      GROUP BY kind ORDER BY kind
    `).all(requesterId)).toEqual([
      { kind: "coordination_join_progress", count: 1 },
      { kind: "coordination_join_satisfied", count: 1 },
    ]);
    const terminal = opened.client.prepare(`
      SELECT payload_json FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_satisfied'
    `).get(requesterId) as { payload_json: string };
    expect(JSON.parse(terminal.payload_json)).toMatchObject({ replyAuthority: { intent: "direct_to_user" } });
  });

  it("records terminal record-only outcomes without waking the requester", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "record-only", requests: [{
        requestId: "record-only", recipientAgentId: recipientA, lifetime: indefinite,
        payload: { text: "Background inventory", completionMode: "record" },
      }],
    });
    store.updateRequest({
      requestId: "record-only", updateId: "record-only-done", kind: "completed",
      actor: { kind: "agent", id: recipientA }, payload: { text: "Inventory saved" },
    });
    expect(store.getRequest("record-only")).toMatchObject({ state: "completed" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_outcome'
    `).get(requesterId)).toEqual({ count: 0 });
  });

  it("settles permanently failed work into join, callback, and record dispositions", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "failed-callback", requests: [{
        requestId: "failed-callback", recipientAgentId: recipientA, lifetime: indefinite,
        payload: { text: "Callback work", completionMode: "callback" },
      }],
    });
    const callbackRun = store.leaseNextRun({ workerId: "worker-callback", excludedAgentIds: [requesterId] })!;
    expect(callbackRun.agentId).toBe(recipientA);
    expect(store.failRun({
      runId: callbackRun.runId, fencingToken: callbackRun.fencingToken,
      workerId: "worker-callback", sameRunResumable: false,
      retryable: true, maxDeliveryFailures: 1, error: "retry budget exhausted",
    })).toBe("terminal");
    expect(store.getRequest("failed-callback")?.state).toBe("failed");
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations activation
      JOIN activation_sources source ON source.activation_id = activation.id
      WHERE source.source_kind = 'request' AND source.source_id = 'failed-callback'
        AND activation.agent_id = ? AND activation.kind = 'coordination_outcome'
    `).get(requesterId)).toEqual({ count: 1 });

    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "failed-record", requests: [{
        requestId: "failed-record", recipientAgentId: recipientB, lifetime: indefinite,
        payload: { text: "Record work", completionMode: "record" },
      }],
    });
    const recordRun = store.leaseNextRun({ workerId: "worker-record", excludedAgentIds: [requesterId] })!;
    expect(recordRun.agentId).toBe(recipientB);
    expect(store.failRun({
      runId: recordRun.runId, fencingToken: recordRun.fencingToken,
      workerId: "worker-record", sameRunResumable: false,
      retryable: false, error: "permanent dispatch rejection",
    })).toBe("terminal");
    expect(store.getRequest("failed-record")?.state).toBe("failed");
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations activation
      JOIN activation_sources source ON source.activation_id = activation.id
      WHERE source.source_kind = 'request' AND source.source_id = 'failed-record'
        AND activation.agent_id = ? AND activation.kind = 'coordination_outcome'
    `).get(requesterId)).toEqual({ count: 0 });

    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "failed-streaming-join", requests: [
        { requestId: "failed-stream-a", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "failed-stream-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: { id: "failed-streaming-join", mode: "any", wakePolicy: "each_result" },
    });
    const firstMember = store.leaseNextRun({ workerId: "worker-member-a", excludedAgentIds: [requesterId] })!;
    expect(store.failRun({
      runId: firstMember.runId, fencingToken: firstMember.fencingToken,
      workerId: "worker-member-a", sameRunResumable: false,
      retryable: false, error: "first member unavailable",
    })).toBe("terminal");
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'failed-streaming-join'").get())
      .toEqual({ state: "open" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_progress'
    `).get(requesterId)).toEqual({ count: 1 });

    const secondMember = store.leaseNextRun({ workerId: "worker-member-b", excludedAgentIds: [requesterId] })!;
    expect(store.failRun({
      runId: secondMember.runId, fencingToken: secondMember.fencingToken,
      workerId: "worker-member-b", sameRunResumable: false,
      retryable: true, maxDeliveryFailures: 1, error: "second member exhausted",
    })).toBe("terminal");
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'failed-streaming-join'").get())
      .toEqual({ state: "impossible" });
    expect(opened.client.prepare(`
      SELECT kind, COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind LIKE 'coordination_join_%'
      GROUP BY kind ORDER BY kind
    `).all(requesterId)).toEqual([
      { kind: "coordination_join_impossible", count: 1 },
      { kind: "coordination_join_progress", count: 1 },
    ]);
  });

  it("cancels pending work when requests cancel, expire, or are superseded", () => {
    const now = "2026-07-15T00:00:00.000Z";
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "terminal-controls", requests: [
        { requestId: "pending-cancel", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "pending-expire", recipientAgentId: recipientA, lifetime: { kind: "deadline", at: "2026-07-15T00:01:00.000Z" } },
        { requestId: "pending-supersede", recipientAgentId: recipientB, lifetime: indefinite },
      ],
    }, now);
    store.updateRequest({
      requestId: "pending-cancel", updateId: "cancel-before-lease", kind: "cancelled",
      actor: { kind: "agent", id: requesterId }, now: "2026-07-15T00:00:30.000Z",
    });
    expect(store.expireDue("2026-07-15T00:01:01.000Z").requests).toBe(1);
    store.updateRequest({
      requestId: "pending-supersede", updateId: "supersede-before-lease", kind: "superseded",
      actor: { kind: "agent", id: requesterId }, now: "2026-07-15T00:01:02.000Z",
    });

    expect(opened.client.prepare(`
      SELECT source.source_id AS request_id, activation.state
      FROM agent_activations activation
      JOIN activation_sources source ON source.activation_id = activation.id
      WHERE activation.kind = 'coordination_request'
        AND source.source_kind = 'request'
        AND source.source_id IN ('pending-cancel', 'pending-expire', 'pending-supersede')
      ORDER BY source.source_id
    `).all()).toEqual([
      { request_id: "pending-cancel", state: "cancelled" },
      { request_id: "pending-expire", state: "cancelled" },
      { request_id: "pending-supersede", state: "cancelled" },
    ]);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'coordination_request' AND state IN ('pending', 'retry_pending')
    `).get()).toEqual({ count: 0 });
    expect(opened.client.prepare(`
      SELECT kind FROM agent_activations
      WHERE kind IN ('coordination_cancelled', 'coordination_superseded', 'coordination_outcome')
      ORDER BY kind
    `).all()).toEqual([
      { kind: "coordination_cancelled" },
      { kind: "coordination_outcome" },
      { kind: "coordination_superseded" },
    ]);
  });

  it("keeps cancellation passive when a consumed recipient waits only on clarification", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "passive-clarification-cancel",
      requests: [{
        requestId: "passive-clarification-request", recipientAgentId: recipientA, lifetime: indefinite,
      }],
    });
    const recipientRun = store.leaseNextRun({ workerId: "recipient-worker", excludedAgentIds: [requesterId, recipientB] })!;
    acknowledgeLease(recipientRun);
    store.updateRequest({
      requestId: "passive-clarification-request", updateId: "passive-question", kind: "question",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: {
        runId: recipientRun.runId, agentId: recipientA, fencingToken: recipientRun.fencingToken,
      },
      payload: { text: "Which format?" },
    });
    store.completeRun(recipientRun.runId, recipientRun.fencingToken);
    expect(opened.client.prepare(`
      SELECT activation.state
      FROM agent_activations activation
      JOIN activation_sources source ON source.activation_id = activation.id
      WHERE source.source_kind = 'request' AND source.source_id = 'passive-clarification-request'
        AND activation.kind = 'coordination_request'
    `).get()).toEqual({ state: "consumed" });

    const requesterRun = store.leaseNextRun({ workerId: "requester-worker", excludedAgentIds: [recipientA, recipientB] })!;
    acknowledgeLease(requesterRun);
    expect(requesterRun.activations).toEqual([
      expect.objectContaining({ kind: "coordination_question" }),
    ]);
    store.updateRequest({
      requestId: "passive-clarification-request", updateId: "passive-cancel", kind: "cancelled",
      actor: { kind: "agent", id: requesterId },
      runAuthorization: {
        runId: requesterRun.runId, agentId: requesterId, fencingToken: requesterRun.fencingToken,
      },
      payload: { reason: "request no longer needed" },
    });
    expect(store.getRequest("passive-clarification-request")?.state).toBe("cancelled");
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_cancelled'
    `).get(recipientA)).toEqual({ count: 0 });
    expect(store.leaseNextRun({ workerId: "cancellation-only-check", excludedAgentIds: [requesterId, recipientB] }))
      .toBeUndefined();
  });

  it("keeps cancellation actionable while clarification work is still attached", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "active-clarification-cancel",
      requests: [{
        requestId: "active-clarification-request", recipientAgentId: recipientA, lifetime: indefinite,
      }],
    });
    const initialRecipientRun = store.leaseNextRun({ workerId: "initial-recipient-worker", excludedAgentIds: [requesterId, recipientB] })!;
    acknowledgeLease(initialRecipientRun);
    store.updateRequest({
      requestId: "active-clarification-request", updateId: "active-question", kind: "question",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: {
        runId: initialRecipientRun.runId, agentId: recipientA, fencingToken: initialRecipientRun.fencingToken,
      },
      payload: { text: "Which format?" },
    });
    store.completeRun(initialRecipientRun.runId, initialRecipientRun.fencingToken);

    const requesterRun = store.leaseNextRun({ workerId: "requester-worker", excludedAgentIds: [recipientA, recipientB] })!;
    acknowledgeLease(requesterRun);
    store.updateRequest({
      requestId: "active-clarification-request", updateId: "active-answer", kind: "answer",
      actor: { kind: "agent", id: requesterId }, inReplyToUpdateId: "active-question",
      runAuthorization: {
        runId: requesterRun.runId, agentId: requesterId, fencingToken: requesterRun.fencingToken,
      },
      payload: { text: "Use Markdown." },
    });
    store.completeRun(requesterRun.runId, requesterRun.fencingToken);

    const resumedRecipientRun = store.leaseNextRun({ workerId: "resumed-recipient-worker", excludedAgentIds: [requesterId, recipientB] })!;
    acknowledgeLease(resumedRecipientRun);
    expect(resumedRecipientRun.activations).toEqual([
      expect.objectContaining({ kind: "coordination_answer" }),
    ]);
    store.updateRequest({
      requestId: "active-clarification-request", updateId: "active-second-question", kind: "question",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: {
        runId: resumedRecipientRun.runId, agentId: recipientA, fencingToken: resumedRecipientRun.fencingToken,
      },
      payload: { text: "Which Markdown dialect?" },
    });
    const runCountBeforeCancellation = opened.client.prepare(
      "SELECT COUNT(*) AS count FROM scheduler_runs WHERE agent_id = ?",
    ).get(recipientA);
    store.updateRequest({
      requestId: "active-clarification-request", updateId: "active-cancel", kind: "cancelled",
      actor: { kind: "agent", id: requesterId }, payload: { reason: "stop now" },
    });

    const steering = store.leaseNextSteering({ workerId: "resumed-recipient-worker" })!;
    expect(steering).toMatchObject({
      runId: resumedRecipientRun.runId,
      activations: [expect.objectContaining({ kind: "coordination_cancelled" })],
    });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM scheduler_runs WHERE agent_id = ?").get(recipientA))
      .toEqual(runCountBeforeCancellation);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs
      WHERE agent_id = ? AND status IN ('leased', 'running')
    `).get(recipientA)).toEqual({ count: 1 });
  });

  it("fences side effects after every resumed continuation is handed off while replay and cleanup remain valid", () => {
    store.coordinate({
      projectId, conversationId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "two-continuations", requests: [
        { requestId: "continuation-a", recipientAgentId: recipientA, lifetime: indefinite },
        { requestId: "continuation-b", recipientAgentId: recipientA, lifetime: indefinite },
      ],
    });
    const parentRun = store.leaseNextRun({ workerId: "worker-parent", excludedAgentIds: [requesterId, recipientB] })!;
    acknowledgeLease(parentRun);
    const parentAuthorization = {
      runId: parentRun.runId, agentId: recipientA, fencingToken: parentRun.fencingToken,
    };
    store.coordinate({
      projectId, conversationId, requesterAgentId: recipientA,
      actorScope: `agent:${recipientA}:run:${parentRun.runId}`,
      idempotencyKey: "continuation-child", runAuthorization: parentAuthorization,
      requests: [{ requestId: "continuation-child", recipientAgentId: recipientB, lifetime: indefinite }],
      join: {
        id: "continuation-child-join", mode: "all", wakePolicy: "final_only",
        continuationRequestIds: ["continuation-a", "continuation-b"],
      },
    });
    store.completeRun(parentRun.runId, parentRun.fencingToken);

    const childRun = store.leaseNextRun({ workerId: "worker-child", excludedAgentIds: [requesterId, recipientA] })!;
    acknowledgeLease(childRun);
    store.updateRequest({
      requestId: "continuation-child", updateId: "continuation-child-done", kind: "completed",
      actor: { kind: "agent", id: recipientB },
      runAuthorization: { runId: childRun.runId, agentId: recipientB, fencingToken: childRun.fencingToken },
    });
    store.completeRun(childRun.runId, childRun.fencingToken);

    const resumed = store.leaseNextRun({ workerId: "worker-resumed", excludedAgentIds: [requesterId, recipientB] })!;
    expect(resumed.activations).toEqual([
      expect.objectContaining({ kind: "coordination_join_satisfied" }),
    ]);
    acknowledgeLease(resumed);
    const resumedAuthorization = {
      runId: resumed.runId, agentId: recipientA, fencingToken: resumed.fencingToken,
    };
    store.updateRequest({
      requestId: "continuation-a", updateId: "continuation-a-done", kind: "completed",
      actor: { kind: "agent", id: recipientA }, runAuthorization: resumedAuthorization,
    });
    expect(store.ownsRun(resumed.runId, resumed.fencingToken, "worker-resumed")).toBe(true);

    const terminalUpdate = {
      requestId: "continuation-b", updateId: "continuation-b-done", kind: "completed" as const,
      actor: { kind: "agent" as const, id: recipientA }, runAuthorization: resumedAuthorization,
      payload: { text: "final canonical handoff" },
    };
    expect(store.updateRequest(terminalUpdate)).toMatchObject({ state: "completed", replayed: false });
    expect(store.ownsRun(resumed.runId, resumed.fencingToken, "worker-resumed")).toBe(false);
    expect(store.ownsRunForCleanup(resumed.runId, resumed.fencingToken, "worker-resumed")).toBe(true);
    expect(store.updateRequest(terminalUpdate)).toMatchObject({ state: "completed", replayed: true });
    expect(() => store.coordinate({
      projectId, conversationId, requesterAgentId: recipientA,
      actorScope: `agent:${recipientA}:run:${resumed.runId}`,
      idempotencyKey: "late-side-effect", runAuthorization: resumedAuthorization,
      requests: [{ requestId: "late-side-effect", recipientAgentId: recipientB, lifetime: indefinite }],
    })).toThrow("no longer authoritative");
    expect(() => store.recordRuntimeCommunication({
      id: "late-communication", projectId,
      sender: { kind: "agent", agentId: recipientA }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipientB] }, payload: { text: "late" },
      scopeKey: `conversation:${conversationId}`, runAuthorization: resumedAuthorization,
    })).toThrow("no longer authoritative");
    store.completeRun(resumed.runId, resumed.fencingToken);
    expect(opened.client.prepare("SELECT status FROM scheduler_runs WHERE id = ?").get(resumed.runId))
      .toEqual({ status: "completed" });
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
  it("preserves a parent continuation across intermediate aggregate progress Runs", () => {
    store.coordinate({
      projectId, conversationId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "stream-parent", requests: [
        { requestId: "stream-parent", recipientAgentId: recipientA, lifetime: indefinite },
      ],
    });
    const parentRun = store.leaseNextRun({ workerId: "parent" })!;
    acknowledgeLease(parentRun);
    store.coordinate({
      projectId, conversationId, requesterAgentId: recipientA,
      actorScope: `agent:${recipientA}:run:${parentRun.runId}`,
      idempotencyKey: "stream-children", requests: [
        { requestId: "stream-child-a", recipientAgentId: recipientB, lifetime: indefinite },
        { requestId: "stream-child-b", recipientAgentId: requesterId, lifetime: indefinite },
      ],
      join: {
        id: "stream-children", mode: "all", wakePolicy: "each_result",
        continuationRequestIds: ["stream-parent"],
      },
    });
    store.completeRun(parentRun.runId, parentRun.fencingToken);

    const childOne = store.leaseNextRun({ workerId: "child-one" })!;
    const childTwo = store.leaseNextRun({ workerId: "child-two" })!;
    acknowledgeLease(childOne);
    acknowledgeLease(childTwo);
    const firstRequest = store.requestIdsAttachedToRun(childOne.runId, childOne.agentId)[0]!;
    store.updateRequest({
      requestId: firstRequest, updateId: `${firstRequest}:done`, kind: "completed",
      actor: { kind: "agent", id: childOne.agentId }, payload: { text: "first" },
    });
    store.completeRun(childOne.runId, childOne.fencingToken);

    const progressRun = store.leaseNextRun({ workerId: "parent-progress" })!;
    expect(progressRun.agentId).toBe(recipientA);
    expect(progressRun.activations.map((activation) => activation.kind)).toEqual(["coordination_join_progress"]);
    acknowledgeLease(progressRun);
    const secondRequest = store.requestIdsAttachedToRun(childTwo.runId, childTwo.agentId)[0]!;
    store.updateRequest({
      requestId: secondRequest, updateId: `${secondRequest}:done`, kind: "completed",
      actor: { kind: "agent", id: childTwo.agentId }, payload: { text: "second" },
    });
    store.completeRun(childTwo.runId, childTwo.fencingToken);
    // The final wake may arrive while the parent is still handling an earlier
    // progress wake. Ending that progress Run must not strand the parent.
    store.completeRun(progressRun.runId, progressRun.fencingToken);
    expect(store.getRequest("stream-parent")).toMatchObject({ state: "waiting_dependency" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE request_id = 'stream-parent' AND kind = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });

    const finalRun = store.leaseNextRun({ workerId: "parent-final" })!;
    expect(finalRun.agentId).toBe(recipientA);
    expect(finalRun.activations.map((activation) => activation.kind)).toEqual(["coordination_join_satisfied"]);
  });

  it("suspends and reattaches an inbound request across a nested join", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "parent-work", requests: [
        { requestId: "parent-work", recipientAgentId: recipientA, lifetime: indefinite },
      ],
    });
    const parentRun = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(parentRun);
    store.coordinate({
      projectId, requesterAgentId: recipientA, actorScope: `agent:${recipientA}:run:${parentRun.runId}`,
      idempotencyKey: "nested-work", requests: [
        { requestId: "nested-work", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: {
        id: "nested-join", mode: "all", continuationRequestIds: ["parent-work"],
      },
    });
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'parent-work'").get())
      .toEqual({ state: "waiting_dependency" });
    store.completeRun(parentRun.runId, parentRun.fencingToken);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE request_id = 'parent-work' AND kind = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });

    const childRun = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(childRun);
    store.updateRequest({
      requestId: "nested-work", updateId: "nested-work-done", kind: "completed",
      actor: { kind: "agent", id: recipientB }, payload: { result: "ready" },
    });
    store.completeRun(childRun.runId, childRun.fencingToken);

    const resumed = store.leaseNextRun({ workerId: "worker-1" })!;
    expect(resumed.agentId).toBe(recipientA);
    expect(resumed.activations.map((activation) => activation.kind)).toContain("coordination_join_satisfied");
    expect(resumed.activations.find((activation) => activation.kind === "coordination_join_satisfied")?.payload)
      .toMatchObject({
        continuations: [{ requestId: "parent-work", state: "waiting_dependency" }],
        continuationInstruction: expect.stringContaining("terminally update"),
      });
    expect(store.requestIdsAttachedToRun(resumed.runId, recipientA)).toEqual(["parent-work"]);
    acknowledgeLease(resumed);
    store.updateRequest({
      requestId: "parent-work", updateId: "parent-work-done", kind: "completed",
      actor: { kind: "agent", id: recipientA }, payload: { result: "integrated" },
    });
    store.completeRun(resumed.runId, resumed.fencingToken);
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'parent-work'").get())
      .toEqual({ state: "completed" });
  });

  it("fails a resumed continuation closed instead of parking it without work", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "unreported-parent", requests: [
        { requestId: "unreported-parent", recipientAgentId: recipientA, lifetime: indefinite },
      ],
      join: { id: "unreported-outer-join", mode: "all" },
    });
    const parentRun = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(parentRun);
    store.coordinate({
      projectId, requesterAgentId: recipientA, actorScope: `agent:${recipientA}:run:${parentRun.runId}`,
      idempotencyKey: "unreported-child", requests: [
        { requestId: "unreported-child", recipientAgentId: recipientB, lifetime: indefinite },
      ],
      join: {
        id: "unreported-inner-join", mode: "all", continuationRequestIds: ["unreported-parent"],
      },
    });
    store.completeRun(parentRun.runId, parentRun.fencingToken);
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'unreported-parent'").get())
      .toEqual({ state: "waiting_dependency" });

    const childRun = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(childRun);
    store.updateRequest({
      requestId: "unreported-child", updateId: "unreported-child-done", kind: "completed",
      actor: { kind: "agent", id: recipientB }, payload: { result: "ready" },
    });
    store.completeRun(childRun.runId, childRun.fencingToken);

    const resumed = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(resumed);
    store.completeRun(resumed.runId, resumed.fencingToken);
    expect(opened.client.prepare("SELECT state FROM coordination_requests WHERE id = 'unreported-parent'").get())
      .toEqual({ state: "outcome_unknown" });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'unreported-outer-join'").get())
      .toEqual({ state: "impossible" });
    expect(store.leaseNextRun({ workerId: "worker-1" })?.agentId).toBe(requesterId);
  });

  it("resolves only the correlated requests authoritatively attached to a run", () => {
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "single-current-request",
      requests: [{ requestId: "single-current", recipientAgentId: recipientA, lifetime: indefinite }],
    });
    const single = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(single);
    expect(store.requestIdsAttachedToRun(single.runId, recipientA)).toEqual(["single-current"]);
    expect(store.requestIdsAttachedToRun(single.runId, recipientB)).toEqual([]);
    expect(store.runStartsNewRecipientRequest(single.runId, recipientA)).toBe(true);
    expect(store.runStartsNewRecipientRequest(single.runId, recipientB)).toBe(false);

    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "multiple-current-requests",
      requests: [
        { requestId: "multiple-a", recipientAgentId: recipientB, lifetime: indefinite },
        { requestId: "multiple-b", recipientAgentId: recipientB, lifetime: indefinite },
      ],
    });
    const multiple = store.leaseNextRun({ workerId: "worker-1" })!;
    expect(store.requestIdsAttachedToRun(multiple.runId, recipientB)).toEqual(["multiple-a", "multiple-b"]);
    expect(store.runStartsNewRecipientRequest(multiple.runId, recipientB)).toBe(true);
  });

  it("prioritizes human work without crossing a provider-session boundary", () => {
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
    expect(lease.activations.map((item) => item.kind)).toEqual(["human_message"]);
    expect(store.runStartsNewRecipientRequest(lease.runId, recipientA)).toBe(false);
    expect(store.getAgentAvailability(recipientA)).toBe("running");
    acknowledgeLease(lease);
    store.completeRun(lease.runId, lease.fencingToken);

    const requestLease = store.leaseNextRun({ workerId: "worker-1", coalesceLimit: 8 })!;
    expect(requestLease.activations.map((item) => item.kind)).toEqual(["coordination_request"]);
    expect(store.runStartsNewRecipientRequest(requestLease.runId, recipientA)).toBe(true);
  });

  it("never coalesces or steers Activations across Team Chat scopes", () => {
    const chatA = randomUUID();
    const chatB = randomUUID();
    const insertConversation = opened.client.prepare(`
      INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
      VALUES (?, ?, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
    `);
    insertConversation.run(chatA, projectId, "Chat A");
    insertConversation.run(chatB, projectId, "Chat B");
    const addMembership = opened.client.prepare(`
      INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
      VALUES (?, ?, 0)
    `);
    addMembership.run(recipientA, chatA);
    addMembership.run(recipientA, chatB);
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "chat-a", scopeKey: `conversation:${chatA}`,
      kind: "ordinary", payload: { text: "A" },
    });
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "chat-b", scopeKey: `conversation:${chatB}`,
      kind: "human", payload: { text: "B" },
    });
    const first = store.leaseNextRun({ workerId: "worker-1", coalesceLimit: 8 })!;
    expect(first.scopeKey).toBe(`conversation:${chatB}`);
    expect(first.activations).toHaveLength(1);
    acknowledgeLease(first);
    expect(store.leaseNextSteering({ workerId: "worker-1" })).toBeUndefined();
    store.completeRun(first.runId, first.fencingToken);

    const second = store.leaseNextRun({ workerId: "worker-1", coalesceLimit: 8 })!;
    expect(second.scopeKey).toBe(`conversation:${chatA}`);
    expect(second.activations).toHaveLength(1);
    expect(store.runChangesScope(second.runId, recipientA)).toBe(true);
  });

  it("leases explicit queued human turns FIFO as one Run each", () => {
    for (const [index, text] of ["first", "second"].entries()) store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: `queued-${index}`, kind: "human",
      payload: { communication: { eventId: `queued-${index}` }, dispatch: { text, activeRunDelivery: "queue" } },
    });
    const first = store.leaseNextRun({ workerId: "worker-1", coalesceLimit: 8 })!;
    expect(first.activations).toHaveLength(1);
    expect(first.activations[0]?.payload).toMatchObject({ dispatch: { text: "first" } });
    acknowledgeLease(first);
    store.completeRun(first.runId, first.fencingToken);
    const second = store.leaseNextRun({ workerId: "worker-1", coalesceLimit: 8 })!;
    expect(second.activations).toHaveLength(1);
    expect(second.activations[0]?.payload).toMatchObject({ dispatch: { text: "second" } });
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

  it("persists exact provider input with a structured source manifest", () => {
    store.enqueueMessageActivation({ projectId, agentId: recipientA, messageId: "context", kind: "ordinary", payload: { text: "Work" } });
    const lease = store.leaseNextRun({ workerId: "worker-1" })!;
    const manifest = {
      schemaVersion: 1 as const, historyMessageCount: 2, activationIds: lease.activationIds,
      communicationEventIds: ["communication-1"], artifactIds: ["artifact-1"],
      providerSessionDisposition: "fresh_task" as const,
      sources: [{ kind: "identity" as const, ref: recipientA }],
    };
    store.recordProviderInput({
      executionId: "execution-1", schedulerRunId: lease.runId, fencingToken: lease.fencingToken,
      agentId: recipientA, projectId, prompt: "exact sensitive prompt", sourceManifest: manifest,
    });
    const recorded = opened.client.prepare(`SELECT provider_prompt, prompt_hash, source_manifest_json FROM provider_inputs WHERE execution_id = 'execution-1'`).get() as {
      provider_prompt: string; prompt_hash: string; source_manifest_json: string;
    };
    expect(recorded.provider_prompt).toBe("exact sensitive prompt");
    expect(recorded.prompt_hash).toBe("12c83c3a0cae0a2af5e25837bf52de0ffc91e6267925d6f20e41c401e0af6d98");
    expect(JSON.parse(recorded.source_manifest_json)).toEqual(manifest);
  });

  it("retries an explicit capacity rejection after submission with backoff", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "capacity", kind: "ordinary", payload: { text: "Work" },
      now: "2026-07-15T00:00:00.000Z",
    });
    const lease = store.leaseNextRun({ workerId: "worker-1", now: "2026-07-15T00:00:00.000Z" })!;
    store.preparePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, prompt: "Work" });
    store.markRunStarted(lease.runId, lease.fencingToken, "2026-07-15T00:00:00.000Z");
    store.markPromptSubmitted({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, now: "2026-07-15T00:00:00.000Z" });
    expect(store.failRun({
      runId: lease.runId, fencingToken: lease.fencingToken, workerId: "worker-1", sameRunResumable: false,
      confirmedNotExecuted: true, failureKind: "capacity", error: "[capacity] Selected model is at capacity",
      now: "2026-07-15T00:00:01.000Z",
    })).toBe("retry");
    expect(opened.client.prepare(`SELECT state FROM scheduler_prompt_injections WHERE id = ?`).get(lease.injectionId)).toEqual({ state: "cancelled" });
    expect(store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:00:02.999Z" })).toBeUndefined();
    expect(store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:00:03.000Z" })?.activationIds).toEqual(lease.activationIds);
  });

  it("retains provider-blocked work beyond the ordinary retry budget and resumes the same wake-up once", () => {
    const activationId = store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "provider-blocked", kind: "ordinary",
      payload: { dispatch: { text: "Synthesize", model: "model-a", effort: "high", speed: "fast" } },
      now: "2026-07-15T00:00:00.000Z",
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const now = `2026-07-15T00:00:0${attempt}.000Z`;
      const lease = store.leaseNextRun({ workerId: `worker-${attempt}`, now })!;
      expect(lease.activationIds).toEqual([activationId]);
      expect(store.failRun({
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        workerId: `worker-${attempt}`,
        sameRunResumable: false,
        confirmedNotExecuted: true,
        failureKind: "rate_limit",
        error: "[rate_limit] Usage limit reached",
        maxDeliveryFailures: 2,
        retryDelayMs: attempt === 5 ? 60_000 : 0,
        now,
      })).toBe("retry");
    }
    expect(opened.client.prepare(`
      SELECT state, delivery_failures, terminal_outcome FROM agent_activations WHERE id = ?
    `).get(activationId)).toEqual({
      state: "retry_pending", delivery_failures: 6, terminal_outcome: null,
    });
    expect(store.providerBlockedState(recipientA)).toEqual({
      classification: "rate_limit",
      activationIds: [activationId],
      retryEligible: true,
      blockedAt: "2026-07-15T00:00:05.000Z",
      nextRetryAt: "2026-07-15T00:01:05.000Z",
      deliveryFailures: 6,
    });
    expect(store.agentWorkItems({ projectId }).items.find((item) => item.id === `activation:${activationId}`))
      .toMatchObject({
        state: "retry_pending",
        providerRecovery: {
          classification: "rate_limit",
          activationIds: [activationId],
          retryEligible: true,
          deliveryFailures: 6,
        },
      });
    const codexB = { activeEngine: "codex", model: "model-b", effort: "low" };
    expect(store.resumeProviderBlockedAgent(recipientA, codexB, "2026-07-15T00:00:10.000Z")).toEqual({
      activationIds: [activationId], resumed: 1,
    });
    expect(store.resumeProviderBlockedAgent(recipientA, codexB, "2026-07-15T00:00:10.000Z")).toEqual({
      activationIds: [], resumed: 0,
    });
    const firstManualRecovery = store.leaseNextRun({
      workerId: "manual-resume", now: "2026-07-15T00:00:10.000Z",
    })!;
    expect(firstManualRecovery.activationIds).toEqual([activationId]);
    expect(firstManualRecovery.activations[0]?.payload).toMatchObject({
      dispatch: { text: "Synthesize", speed: "fast" },
      providerRecovery: {
        runtimeSelectionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeSelection: codexB,
        reboundAt: "2026-07-15T00:00:10.000Z",
      },
    });
    expect(firstManualRecovery.activations[0]?.payload).not.toMatchObject({
      dispatch: { model: expect.anything() },
    });
    expect(firstManualRecovery.activations[0]?.payload).not.toMatchObject({
      dispatch: { effort: expect.anything() },
    });
    expect(store.failRun({
      runId: firstManualRecovery.runId,
      fencingToken: firstManualRecovery.fencingToken,
      workerId: "manual-resume",
      sameRunResumable: false,
      confirmedNotExecuted: true,
      failureKind: "rate_limit",
      error: "[rate_limit] Usage limit reached again",
      retryDelayMs: 60_000,
      now: "2026-07-15T00:00:11.000Z",
    })).toBe("retry");
    expect(store.resumeProviderBlockedAgent(recipientA, codexB, "2026-07-15T00:00:12.000Z"))
      .toEqual({ activationIds: [], resumed: 0 });
    expect(store.leaseNextRun({ workerId: "replayed-settings", now: "2026-07-15T00:00:12.000Z" }))
      .toBeUndefined();

    const claude = { activeEngine: "claude", model: "claude-opus", effort: "high" };
    expect(store.resumeProviderBlockedAgent(recipientA, claude, "2026-07-15T00:00:13.000Z"))
      .toEqual({ activationIds: [activationId], resumed: 1 });
    const crossEngineRecovery = store.leaseNextRun({
      workerId: "cross-engine", now: "2026-07-15T00:00:13.000Z",
    })!;
    expect(crossEngineRecovery.activationIds).toEqual([activationId]);
    expect(crossEngineRecovery.activations[0]?.payload).toMatchObject({
      dispatch: { text: "Synthesize", speed: "fast" },
      providerRecovery: { runtimeSelection: claude },
    });
  });

  it("terminalizes a permanent dispatch rejection with an operator-visible outcome", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "missing-recipient", kind: "human", payload: { text: "Wake" },
      now: "2026-07-15T00:00:00.000Z",
    });
    const lease = store.leaseNextRun({ workerId: "worker-1", now: "2026-07-15T00:00:00.000Z" })!;
    expect(store.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: "worker-1",
      sameRunResumable: false,
      retryable: false,
      terminalOutcome: "recipient_unavailable",
      error: "agent not found",
      now: "2026-07-15T00:00:01.000Z",
    })).toBe("terminal");
    expect(store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:01:00.000Z" })).toBeUndefined();
    expect(opened.client.prepare(`
      SELECT state, delivery_failures, last_delivery_error, terminal_outcome, terminal_at
      FROM agent_activations WHERE id = ?
    `).get(lease.activationIds[0])).toEqual({
      state: "failed",
      delivery_failures: 1,
      last_delivery_error: "agent not found",
      terminal_outcome: "recipient_unavailable",
      terminal_at: "2026-07-15T00:00:01.000Z",
    });
    expect(store.schedulerMetrics()).toMatchObject({ recipientUnavailableActivations: 1 });
    expect(store.terminalActivations(projectId)).toEqual([
      expect.objectContaining({
        id: lease.activationIds[0], outcome: "recipient_unavailable", deliveryFailures: 1,
        lastDeliveryError: "agent not found",
      }),
    ]);
  });

  it("bounds transient delivery retries and terminalizes exhaustion", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "bounded-retry", kind: "ordinary", payload: { text: "Work" },
      now: "2026-07-15T00:00:00.000Z",
    });
    const first = store.leaseNextRun({ workerId: "worker-1", now: "2026-07-15T00:00:00.000Z" })!;
    expect(store.failRun({
      runId: first.runId, fencingToken: first.fencingToken, workerId: "worker-1",
      sameRunResumable: false, retryable: true, error: "busy", maxDeliveryFailures: 2,
      retryDelayMs: 0, now: "2026-07-15T00:00:01.000Z",
    })).toBe("retry");
    const second = store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:00:01.000Z" })!;
    expect(store.failRun({
      runId: second.runId, fencingToken: second.fencingToken, workerId: "worker-2",
      sameRunResumable: false, retryable: true, error: "still busy", maxDeliveryFailures: 2,
      retryDelayMs: 0, now: "2026-07-15T00:00:02.000Z",
    })).toBe("terminal");
    expect(opened.client.prepare(`
      SELECT state, delivery_failures, terminal_outcome FROM agent_activations WHERE id = ?
    `).get(first.activationIds[0])).toEqual({
      state: "failed", delivery_failures: 2, terminal_outcome: "retry_exhausted",
    });
    expect(store.schedulerMetrics()).toMatchObject({ retryExhaustedActivations: 1, pendingActivations: 0 });
  });

  it("reconciles and explicitly repairs only detached Activations with unavailable recipients", () => {
    const reconciliation = store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "startup-poison", kind: "human", payload: { text: "Wake" },
    });
    const targeted = store.enqueueMessageActivation({
      projectId, agentId: recipientB, messageId: "targeted-poison", kind: "human", payload: { text: "Wake" },
    });
    opened.client.prepare("DELETE FROM agents WHERE id = ?").run(recipientA);
    expect(store.reconcileUnavailableActivationRecipients("2026-07-15T01:00:00.000Z")).toEqual({ settled: 1 });
    expect(store.terminalActivations(projectId)).toEqual([
      expect.objectContaining({ id: reconciliation, outcome: "recipient_unavailable" }),
    ]);
    expect(() => store.settleUnavailableActivation({
      activationId: targeted,
      projectId,
      idempotencyKey: "still-live",
    })).toThrow("still available");

    opened.client.prepare("DELETE FROM agents WHERE id = ?").run(recipientB);
    const input = {
      activationId: targeted, projectId, idempotencyKey: "repair-once",
      reason: "verified deleted recipient", now: "2026-07-15T01:01:00.000Z",
    };
    expect(store.settleUnavailableActivation(input)).toEqual({
      settled: true, replayed: false, status: "recipient_unavailable",
    });
    expect(store.settleUnavailableActivation(input)).toEqual({
      settled: true, replayed: true, status: "recipient_unavailable",
    });
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

  it("never lets a stale targeted cancellation stop a successor Run", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "first-cancel-target", kind: "human", payload: { text: "First" },
    });
    const first = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(first);
    expect(store.cancelAgentRun({
      agentId: recipientA, expectedRunId: first.runId, idempotencyKey: "cancel-first",
    })).toMatchObject({ cancelled: true, runId: first.runId });

    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "successor-cancel-target", kind: "human", payload: { text: "Successor" },
    });
    const successor = store.leaseNextRun({ workerId: "worker-2" })!;
    acknowledgeLease(successor);
    expect(store.cancelAgentRun({
      agentId: recipientA, expectedRunId: first.runId, idempotencyKey: "stale-cancel",
    })).toEqual({ cancelled: false, replayed: false });
    expect(store.agentSnapshot(recipientA).activeRun?.id).toBe(successor.runId);
    expect(store.cancelAgentRun({
      agentId: recipientA, expectedRunId: successor.runId, idempotencyKey: "cancel-successor",
    })).toMatchObject({ cancelled: true, runId: successor.runId });
  });

  it("settles the attached Request and reevaluates its Join when a child Run is cancelled", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "cancel-child", requests: [{
        requestId: "cancel-child-request", recipientAgentId: recipientA, lifetime: indefinite,
      }], join: { id: "cancel-child-join", mode: "all" },
    });
    const child = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(child);
    store.cancelAgentRun({ agentId: recipientA, idempotencyKey: "cancel-child-run" });
    expect(store.getRequest("cancel-child-request")?.state).toBe("outcome_unknown");
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'cancel-child-join'").get())
      .toEqual({ state: "impossible" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_impossible'
    `).get(requesterId)).toEqual({ count: 1 });
  });

  it("rejects every provider mutation after cancellation inside the mutation transaction", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "authorize-run", kind: "human", payload: { text: "Work" },
    });
    const lease = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(lease);
    const authorization = { runId: lease.runId, agentId: recipientA, fencingToken: lease.fencingToken };
    store.cancelAgentRun({ agentId: recipientA, idempotencyKey: "cancel-authorized-run" });

    expect(() => store.recordRuntimeCommunication({
      id: "late-message", projectId, sender: { kind: "agent", agentId: recipientA },
      intent: "collaboration", audience: { kind: "agents", agentIds: [recipientB] }, payload: { text: "late" },
      runAuthorization: authorization,
      artifacts: [{
        id: "late-artifact", role: "long_text", title: "Late", mediaType: "text/markdown",
        blobPath: "late-artifact", blobHash: "a".repeat(64), byteLength: 4,
        originAgentId: recipientA, executionId: lease.runId,
      }],
    })).toThrow("no longer authoritative");
    expect(() => store.coordinate({
      projectId, requesterAgentId: recipientA, actorScope: `agent:${recipientA}:run:${lease.runId}`,
      idempotencyKey: "late-coordinate", runAuthorization: authorization,
      requests: [{ requestId: "late-request", recipientAgentId: recipientB, lifetime: indefinite }],
    })).toThrow("no longer authoritative");
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM runtime_communications WHERE id = 'late-message'").get())
      .toEqual({ count: 0 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM runtime_artifacts WHERE id = 'late-artifact'").get())
      .toEqual({ count: 0 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_requests WHERE id = 'late-request'").get())
      .toEqual({ count: 0 });
  });

  it("allows only the requester to cancel its exact historical outbound Request", () => {
    store.coordinate({
      projectId, requesterAgentId: recipientA, actorScope: `agent:${recipientA}`,
      idempotencyKey: "historical-request", requests: [
        { requestId: "historical-request", recipientAgentId: recipientB, lifetime: indefinite },
      ],
    });
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "current-work", kind: "human", payload: { text: "Current" },
    });
    const lease = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(lease);
    expect(store.requestIdsAttachedToRun(lease.runId, recipientA)).toEqual([]);
    expect(store.updateRequest({
      requestId: "historical-request", updateId: "late-cancel", kind: "cancelled",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: { runId: lease.runId, agentId: recipientA, fencingToken: lease.fencingToken },
    })).toMatchObject({ requestId: "historical-request", state: "cancelled" });
    expect(store.getRequest("historical-request")?.state).toBe("cancelled");
    expect(() => store.updateRequest({
      requestId: "historical-request", updateId: "late-complete", kind: "completed",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: { runId: lease.runId, agentId: recipientA, fencingToken: lease.fencingToken },
    })).toThrow();
  });

  it("exposes the latest acknowledged steering injection as an output fence", () => {
    store.enqueueMessageActivation({ projectId, agentId: recipientA, messageId: "base-fence", kind: "ordinary", payload: { text: "base" } });
    const run = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(run);
    expect(store.latestAcknowledgedSteeringInjection(run.runId)).toBeUndefined();
    store.enqueueMessageActivation({ projectId, agentId: recipientA, messageId: "steer-fence", kind: "human", payload: { text: "new" } });
    const steering = store.leaseNextSteering({ workerId: "worker-1" })!;
    store.preparePromptInjection({ injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken, prompt: "new" });
    store.markPromptSubmitted({ injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken });
    store.acknowledgePromptInjection({ injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken });
    expect(store.latestAcknowledgedSteeringInjection(run.runId)).toBe(steering.injectionId);
  });

  it("settles pending and submitted steering distinctly during cancellation", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "base", kind: "ordinary", payload: { text: "Base" },
    });
    const run = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(run);
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "submitted-steer", kind: "human", payload: { text: "Steer" },
    });
    const steering = store.leaseNextSteering({ workerId: "worker-1" })!;
    store.preparePromptInjection({
      injectionId: steering.injectionId, runId: steering.runId,
      fencingToken: steering.fencingToken, prompt: "steering",
    });
    store.markPromptSubmitted({
      injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken,
    });

    store.cancelAgentRun({ agentId: recipientA, idempotencyKey: "cancel-submitted-steer" });
    expect(opened.client.prepare("SELECT state FROM scheduler_prompt_injections WHERE id = ?").get(steering.injectionId))
      .toEqual({ state: "outcome_unknown" });
    expect(opened.client.prepare("SELECT state FROM agent_activations WHERE id = ?").get(steering.activationIds[0]))
      .toEqual({ state: "outcome_unknown" });
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

  it("batches delivery receipts for a message page without crossing communication identity", () => {
    const eventIds = ["batch-receipt-a", "batch-receipt-b"];
    for (const [index, eventId] of eventIds.entries()) {
      const agentId = index === 0 ? recipientA : recipientB;
      const communication = userDmEvent({ eventId, agentId, conversation: conversationId });
      store.recordRuntimeCommunication({
        id: `dispatch:${eventId}:${agentId}`,
        projectId,
        sender: communication.sender,
        intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication,
          dispatch: { conversationId, text: communication.text },
        },
        activation: {
          agentId,
          kind: "human_message",
          priority: 100,
          dispatchPolicy: "steer_or_run",
          promptClass: "human",
          scopeKey: `conversation:${conversationId}`,
        },
      });
    }

    const singular = new Map(eventIds.map((eventId) => [
      eventId,
      store.deliveryReceiptsForCommunication(projectId, eventId),
    ]));
    const batch = store.deliveryReceiptsForCommunications(projectId, [...eventIds, eventIds[0]!, "missing"]);

    expect(batch.get(eventIds[0]!)).toEqual(singular.get(eventIds[0]!));
    expect(batch.get(eventIds[1]!)).toEqual(singular.get(eventIds[1]!));
    expect(batch.get("missing")).toEqual([]);
  });

  it("records an honest unconfirmed receipt, then recovers by fencing only the originating Run", () => {
    const now = "2026-07-15T00:00:00.000Z";
    const eventId = "uncertain-human-steer";
    const { run, steering, activationId } = createUncertainHumanSteer(eventId, now);
    expect(store.deliveryReceiptsForCommunication(projectId, eventId)).toEqual([expect.objectContaining({
      activationId,
      targetAgentId: recipientA,
      state: "unconfirmed",
      injectionId: steering.injectionId,
      recoveryAt: "2026-07-15T00:00:10.000Z",
      canLetCurrentRunFinish: true,
    })]);

    expect(store.processDueSteeringRecoveries("2026-07-15T00:00:09.999Z")).toEqual([]);
    expect(store.processDueSteeringRecoveries("2026-07-15T00:00:10.000Z")).toEqual([recipientA]);
    expect(opened.client.prepare("SELECT status FROM scheduler_runs WHERE id = ?").get(run.runId))
      .toEqual({ status: "cancelled" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM provider_operation_outbox
      WHERE run_id = ? AND operation = 'interrupt' AND state = 'pending'
    `).get(run.runId)).toEqual({ count: 1 });
    const recoveryReceipt = store.deliveryReceiptsForCommunication(projectId, eventId)[0]!;
    expect(recoveryReceipt).toMatchObject({
      activationId,
      state: "recovery_queued",
      recoveryActivationId: expect.any(String),
    });
    const { items: inspected } = store.agentWorkItems({ projectId, agentId: recipientA });
    const sourceItem = inspected.find((item) => item.id === `activation:${activationId}`)!;
    expect(sourceItem.relatedItemIds).toContain(`activation:${recoveryReceipt.recoveryActivationId}`);
    expect(recoveryReceipt).not.toHaveProperty("canLetCurrentRunFinish");
    const recovery = store.leaseNextRun({ workerId: "worker-1", now: "2026-07-15T00:00:10.000Z" })!;
    expect(recovery.runId).not.toBe(run.runId);
    expect(recovery.activations).toEqual([expect.objectContaining({
      kind: "steering_recovery",
      dispatchPolicy: "next_run",
      payload: expect.objectContaining({
        dispatch: { text: "Change direction" },
        steeringRecovery: expect.objectContaining({
          sourceRunId: run.runId,
          sourceInjectionId: steering.injectionId,
          sourceActivationId: activationId,
        }),
      }),
    })]);
  });

  it("lets the exact current Run finish before executing linked recovery", () => {
    const now = "2026-07-15T00:00:00.000Z";
    const eventId = "wait-for-current-run";
    const { run, steering } = createUncertainHumanSteer(eventId, now);
    expect(store.letCurrentRunFinish({
      injectionId: steering.injectionId,
      idempotencyKey: "wait-choice",
      now: "2026-07-15T00:00:01.000Z",
    })).toMatchObject({ accepted: true, replayed: false, state: "waiting_for_run", agentId: recipientA });
    expect(store.letCurrentRunFinish({
      injectionId: steering.injectionId,
      idempotencyKey: "wait-choice-retry",
      now: "2026-07-15T00:00:02.000Z",
    })).toMatchObject({ accepted: true, replayed: true, state: "waiting_for_run" });
    expect(opened.client.prepare("SELECT status FROM scheduler_runs WHERE id = ?").get(run.runId))
      .toEqual({ status: "running" });
    expect(store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:00:02.000Z" })).toBeUndefined();
    const waitingReceipt = store.deliveryReceiptsForCommunication(projectId, eventId)[0]!;
    expect(waitingReceipt).toMatchObject({
      state: "waiting_for_run",
    });
    expect(waitingReceipt).not.toHaveProperty("canLetCurrentRunFinish");
    store.completeRun(run.runId, run.fencingToken, "2026-07-15T00:00:03.000Z");
    expect(store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:00:03.000Z" })?.activations[0]?.kind)
      .toBe("steering_recovery");
  });

  it("labels historical uncertain steering as undelivered without replaying it", () => {
    const eventId = "historical-uncertain-steer";
    const { steering } = createUncertainHumanSteer(eventId, "2026-07-15T00:00:00.000Z");
    opened.client.prepare("DELETE FROM scheduler_steering_recoveries WHERE injection_id = ?").run(steering.injectionId);
    const historicalReceipt = store.deliveryReceiptsForCommunication(projectId, eventId)[0]!;
    expect(historicalReceipt).toMatchObject({
      state: "undelivered",
      injectionId: steering.injectionId,
    });
    expect(historicalReceipt).not.toHaveProperty("recoveryAt");
    expect(store.processDueSteeringRecoveries("2026-07-16T00:00:00.000Z")).toEqual([]);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'steering_recovery'
    `).get()).toEqual({ count: 0 });
  });

  it("retries only the latest terminal operator delivery and preserves one canonical message", () => {
    const eventId = "retry-historical-uncertain-steer";
    const { activationId, steering } = createUncertainHumanSteer(eventId, "2026-07-15T00:00:00.000Z");
    opened.client.prepare("DELETE FROM scheduler_steering_recoveries WHERE injection_id = ?").run(steering.injectionId);

    expect(store.deliveryReceiptsForCommunication(projectId, eventId)).toEqual([expect.objectContaining({
      activationId,
      state: "undelivered",
      attemptCount: 1,
      canRetry: true,
      retryMayDuplicate: true,
    })]);
    const countRetryState = () => ({
      activations: (opened.client.prepare(`SELECT COUNT(*) AS count FROM agent_activations`).get() as { count: number }).count,
      outbox: (opened.client.prepare(`SELECT COUNT(*) AS count FROM activation_outbox`).get() as { count: number }).count,
      idempotency: (opened.client.prepare(`
        SELECT COUNT(*) AS count FROM coordination_idempotency
        WHERE operation = 'retry_message_delivery'
      `).get() as { count: number }).count,
    });
    const beforeRetry = countRetryState();
    const retry = store.retryMessageDelivery({
      projectId, activationId, idempotencyKey: "retry-once", now: "2026-07-14T23:59:59.000Z",
    });
    expect(retry).toMatchObject({
      accepted: true, replayed: false, state: "queued", targetAgentId: recipientA,
      retryMayDuplicate: true, activationId: expect.any(String),
    });
    expect(countRetryState()).toEqual({
      activations: beforeRetry.activations + 1,
      outbox: beforeRetry.outbox + 1,
      idempotency: beforeRetry.idempotency + 1,
    });
    expect(store.retryMessageDelivery({
      projectId, activationId, idempotencyKey: "retry-once", now: "2026-07-15T00:00:21.000Z",
    })).toEqual({ ...retry, replayed: true });
    expect(store.retryMessageDelivery({
      projectId, activationId, idempotencyKey: "competing-retry", now: "2026-07-15T00:00:21.000Z",
    })).toMatchObject({
      accepted: false, state: "not_retryable", rejectionReason: "stale_attempt",
    });
    expect(countRetryState()).toEqual({
      activations: beforeRetry.activations + 1,
      outbox: beforeRetry.outbox + 1,
      idempotency: beforeRetry.idempotency + 1,
    });
    expect(opened.client.prepare(`
      SELECT predecessor_activation_id, successor_activation_id,
        root_activation_id, attempt_number
      FROM activation_delivery_retry_lineage
    `).all()).toEqual([{
      predecessor_activation_id: activationId,
      successor_activation_id: retry.activationId,
      root_activation_id: activationId,
      attempt_number: 1,
    }]);

    const latest = store.deliveryReceiptsForCommunication(projectId, eventId);
    expect(latest).toEqual([expect.objectContaining({
      activationId: retry.activationId,
      state: "queued",
      attemptCount: 2,
    })]);
    expect(latest[0]).not.toHaveProperty("canRetry");
    const retryActivation = store.pendingActivations(projectId)
      .find((candidate) => candidate.id === retry.activationId)!;
    expect(retryActivation.payload).toMatchObject({
      communication: { eventId },
      deliveryRetry: {
        previousActivationId: activationId,
        rootActivationId: activationId,
        requestedBy: "local-operator",
      },
      steeringRecovery: {
        instruction: expect.stringContaining("Audit current state before acting"),
      },
    });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM runtime_communications
      WHERE json_extract(payload_json, '$.communication.eventId') = ?
    `).get(eventId)).toEqual({ count: 1 });

    opened.client.prepare(`
      UPDATE agent_activations SET state = 'failed', updated_at = ? WHERE id = ?
    `).run("2026-07-15T00:00:22.000Z", retry.activationId);
    const third = store.retryMessageDelivery({
      projectId, activationId: retry.activationId!, idempotencyKey: "retry-after-failure",
      now: "2026-07-15T00:00:23.000Z",
    });
    expect(third).toMatchObject({ accepted: true, replayed: false, state: "queued" });
    expect(store.deliveryReceiptsForCommunication(projectId, eventId)).toEqual([expect.objectContaining({
      activationId: third.activationId,
      attemptCount: 3,
      state: "queued",
    })]);
    expect(opened.client.prepare(`
      SELECT predecessor_activation_id, successor_activation_id,
        root_activation_id, attempt_number
      FROM activation_delivery_retry_lineage
      ORDER BY attempt_number
    `).all()).toEqual([
      {
        predecessor_activation_id: activationId,
        successor_activation_id: retry.activationId,
        root_activation_id: activationId,
        attempt_number: 1,
      },
      {
        predecessor_activation_id: retry.activationId,
        successor_activation_id: third.activationId,
        root_activation_id: activationId,
        attempt_number: 2,
      },
    ]);
  });

  it("isolates colliding communication event IDs and retry admission by authoritative Project", () => {
    const foreign = seedAdditionalProject("Foreign retry Project");
    const eventId = "same-event-id-in-two-projects";
    const recordDelivery = (input: {
      runtimeId: string;
      projectId: string;
      conversationId: string;
      agentId: string;
    }) => {
      const communication = userDmEvent({
        eventId, agentId: input.agentId, project: input.projectId,
        conversation: input.conversationId, text: `Work in ${input.projectId}`,
      });
      return store.recordRuntimeCommunication({
      id: input.runtimeId,
      projectId: input.projectId,
      sender: communication.sender,
      intent: communication.intent,
      audience: communication.audience,
      payload: {
        communication,
        dispatch: { conversationId: input.conversationId, text: `Work in ${input.projectId}` },
      },
      activation: {
        agentId: input.agentId,
        kind: "ordinary_message",
        priority: 50,
        dispatchPolicy: "next_run",
        promptClass: "ordinary",
      },
      now: "2026-07-15T00:00:00.000Z",
      });
    };
    const localDelivery = recordDelivery({
      runtimeId: "runtime:local-collision",
      projectId,
      conversationId,
      agentId: recipientA,
    });
    const foreignDelivery = recordDelivery({
      runtimeId: "runtime:foreign-collision",
      projectId: foreign.projectId,
      conversationId: foreign.conversationId,
      agentId: foreign.agentId,
    });
    opened.client.prepare(`
      UPDATE agent_activations SET state = 'failed', updated_at = ? WHERE id IN (?, ?)
    `).run(
      "2026-07-15T00:00:01.000Z",
      localDelivery.activationId,
      foreignDelivery.activationId,
    );

    expect(store.deliveryReceiptsForCommunication(projectId, eventId)).toEqual([
      expect.objectContaining({
        activationId: localDelivery.activationId,
        targetAgentId: recipientA,
        state: "failed",
        canRetry: true,
      }),
    ]);
    expect(store.deliveryReceiptsForCommunication(foreign.projectId, eventId)).toEqual([
      expect.objectContaining({
        activationId: foreignDelivery.activationId,
        targetAgentId: foreign.agentId,
        state: "failed",
        canRetry: true,
      }),
    ]);

    const mutationCounts = () => ({
      activations: (opened.client.prepare(`SELECT COUNT(*) AS count FROM agent_activations`).get() as { count: number }).count,
      outbox: (opened.client.prepare(`SELECT COUNT(*) AS count FROM activation_outbox`).get() as { count: number }).count,
      idempotency: (opened.client.prepare(`
        SELECT COUNT(*) AS count FROM coordination_idempotency
        WHERE operation = 'retry_message_delivery'
      `).get() as { count: number }).count,
    });
    const beforeForeignRetry = mutationCounts();
    expect(store.retryMessageDelivery({
      projectId,
      activationId: foreignDelivery.activationId!,
      idempotencyKey: "foreign-project-retry",
      now: "2026-07-15T00:00:02.000Z",
    })).toEqual({
      accepted: false,
      replayed: false,
      state: "not_retryable",
      rejectionReason: "not_found",
    });
    expect(mutationCounts()).toEqual(beforeForeignRetry);
    expect(store.leaseNextRun({
      workerId: "foreign-project-retry-worker",
      now: "2026-07-15T00:00:03.000Z",
    })).toBeUndefined();
    expect(opened.client.prepare(`SELECT COUNT(*) AS count FROM scheduler_runs`).get())
      .toEqual({ count: 0 });

    const communicationBefore = opened.client.prepare(`
      SELECT * FROM runtime_communications WHERE id = 'runtime:local-collision'
    `).get();
    const accepted = store.retryMessageDelivery({
      projectId,
      activationId: localDelivery.activationId!,
      idempotencyKey: "local-project-retry",
      now: "2026-07-15T00:00:04.000Z",
    });
    expect(accepted).toMatchObject({
      accepted: true,
      replayed: false,
      state: "queued",
      targetAgentId: recipientA,
    });
    expect(store.deliveryReceiptsForCommunication(projectId, eventId)).toEqual([
      expect.objectContaining({
        activationId: accepted.activationId,
        targetAgentId: recipientA,
        state: "queued",
        attemptCount: 2,
      }),
    ]);
    expect(store.leaseNextRun({
      workerId: "local-project-retry-worker",
      now: "2026-07-15T00:00:05.000Z",
    })).toMatchObject({
      projectId,
      agentId: recipientA,
      activationIds: [accepted.activationId],
    });
    expect(opened.client.prepare(`
      SELECT * FROM runtime_communications WHERE id = 'runtime:local-collision'
    `).get()).toEqual(communicationBefore);
  });

  it("rejects malformed, contradictory, cross-Project, and nonmember runtime identities before mutation", () => {
    const foreign = seedAdditionalProject("Foreign authority Project");
    const secondConversationId = randomUUID();
    const scopeOnlyAgentId = randomUUID();
    opened.client.prepare(`
      INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
      VALUES (?, ?, 'Scope-only chat', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
    `).run(secondConversationId, projectId);
    opened.client.prepare(`
      INSERT INTO agents (id, project_id, title, active_engine, created_at, updated_at, archived)
      VALUES (?, ?, 'Scope-only Agent', 'codex', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
    `).run(scopeOnlyAgentId, projectId);
    opened.client.prepare(`
      INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position) VALUES (?, ?, 0)
    `).run(scopeOnlyAgentId, secondConversationId);

    const local = userDmEvent({
      eventId: "runtime-authority", agentId: recipientA, conversation: conversationId,
    });
    const baseInput = {
      id: "runtime-authority",
      projectId,
      sender: local.sender,
      intent: local.intent,
      audience: local.audience,
      payload: { communication: local, dispatch: { conversationId, text: local.text } },
      activation: {
        agentId: recipientA,
        kind: "ordinary_message",
        priority: 50,
        dispatchPolicy: "next_run" as const,
        promptClass: "ordinary" as const,
      },
    };
    const foreignAudience = userDmEvent({
      eventId: "foreign-audience", agentId: foreign.agentId, project: projectId,
      conversation: conversationId,
    });
    const nonmemberCollaboration: CommunicationEvent = {
      eventId: "nonmember-sender", schemaVersion: 2, projectId, conversationId,
      sender: { kind: "agent", agentId: scopeOnlyAgentId }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipientA] }, text: "Contradictory membership",
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const conversationScopeMismatch = userDmEvent({
      eventId: "conversation-scope-mismatch", agentId: scopeOnlyAgentId,
      conversation: conversationId,
    });
    const managedChildFailure = {
      id: "managed-child-failure", projectId,
      sender: { kind: "system", component: "runtime-supervisor" },
      intent: "managed_child_failure",
      audience: { kind: "agents", agentIds: [requesterId] },
      payload: {
        text: "Child failed", childAgentId: recipientA,
        executionId: "failed-child-execution", failure: "provider exited",
      },
      scopeKey: `conversation:${conversationId}`,
      activation: {
        agentId: requesterId, kind: "managed_child_failure", priority: 90,
        dispatchPolicy: "steer_or_run", promptClass: "blocker",
      },
    };
    const malformedValues: unknown[] = [[], null, "malformed"];
    const rejectedInputs: unknown[] = [
      { ...baseInput, id: "unknown-sender", sender: { kind: "unknown", userId: "local-operator" } },
      { ...baseInput, id: "unknown-audience", audience: { kind: "unknown", agentId: recipientA } },
      { ...baseInput, id: "unknown-intent", intent: "unknown" },
      {
        ...baseInput, id: "foreign-canonical-audience",
        payload: { communication: foreignAudience, dispatch: { conversationId, text: foreignAudience.text } },
      },
      {
        ...baseInput, id: "nonmember-sender", sender: nonmemberCollaboration.sender,
        intent: nonmemberCollaboration.intent, audience: nonmemberCollaboration.audience,
        payload: { communication: nonmemberCollaboration },
      },
      {
        ...baseInput, id: "conversation-scope-mismatch", audience: conversationScopeMismatch.audience,
        payload: { communication: conversationScopeMismatch },
        scopeKey: `conversation:${secondConversationId}`,
        activation: { ...baseInput.activation, agentId: scopeOnlyAgentId },
      },
      ...malformedValues.map((communication, index) => ({
        ...baseInput, id: `malformed-communication-${index}`, payload: { communication },
      })),
      ...malformedValues.map((dispatch, index) => ({
        ...baseInput, id: `malformed-dispatch-${index}`, payload: { text: "work", dispatch },
      })),
      { ...managedChildFailure, id: "managed-wrong-component", sender: { kind: "system", component: "other" } },
      {
        ...managedChildFailure, id: "managed-missing-payload-field",
        payload: { ...managedChildFailure.payload, failure: "" },
      },
      {
        ...managedChildFailure, id: "managed-foreign-child",
        payload: { ...managedChildFailure.payload, childAgentId: foreign.agentId },
      },
      {
        ...managedChildFailure, id: "managed-child-outside-scope",
        payload: { ...managedChildFailure.payload, childAgentId: scopeOnlyAgentId },
      },
      {
        ...managedChildFailure, id: "managed-wrong-activation-kind",
        activation: { ...managedChildFailure.activation, kind: "ordinary_message" },
      },
    ];
    const before = runtimeMutationState();
    for (const input of rejectedInputs) {
      expect(() => store.recordRuntimeCommunication(input as never)).toThrow(
        "runtime communication authority does not agree on one Project",
      );
      expect(runtimeMutationState()).toEqual(before);
    }
    expect(store.deliveryReceiptsForCommunication(projectId, conversationScopeMismatch.eventId)).toEqual([]);
    expect(store.retryMessageDelivery({
      projectId, activationId: "conversation-scope-mismatch", idempotencyKey: "mismatch-retry",
    })).toMatchObject({ accepted: false, rejectionReason: "not_found" });
    expect(runtimeMutationState()).toEqual(before);
    expect(store.leaseNextRun({ workerId: "mismatch-worker" })).toBeUndefined();
    expect(runtimeMutationState()).toEqual(before);
  });

  it("admits runtime artifact provenance only from authoritative same-Project identities before mutation", () => {
    const foreign = seedAdditionalProject("Foreign artifact provenance");
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "local-artifact-run",
      kind: "ordinary", payload: { text: "local artifact authority" },
    });
    const localRun = store.leaseNextRun({ workerId: "local-artifact-worker" })!;
    store.enqueueMessageActivation({
      projectId: foreign.projectId, agentId: foreign.agentId, messageId: "foreign-artifact-run",
      kind: "ordinary", payload: { text: "foreign artifact authority" },
    });
    const foreignRun = store.leaseNextRun({ workerId: "foreign-artifact-worker" })!;
    expect(localRun).toMatchObject({ projectId, agentId: recipientA });
    expect(foreignRun).toMatchObject({ projectId: foreign.projectId, agentId: foreign.agentId });

    const broadcastInput = (id: string, artifact: ReturnType<typeof runtimeArtifactInput>) => ({
      id,
      projectId,
      sender: { kind: "user" as const, userId: "local-operator" },
      intent: "broadcast" as const,
      audience: { kind: "organization" as const, organizationId: projectId },
      payload: { text: `Artifact admission ${id}` },
      artifacts: [artifact],
    });
    const rejected = [
      broadcastInput("artifact-foreign-origin", runtimeArtifactInput(1, { originAgentId: foreign.agentId })),
      broadcastInput("artifact-foreign-execution", runtimeArtifactInput(2, { executionId: foreignRun.runId })),
      broadcastInput("artifact-foreign-pair", runtimeArtifactInput(15, {
        originAgentId: foreign.agentId, executionId: foreignRun.runId,
      })),
      broadcastInput("artifact-mismatched-identities", runtimeArtifactInput(3, {
        originAgentId: recipientB, executionId: localRun.runId,
      })),
      broadcastInput("artifact-malformed-origin", runtimeArtifactInput(4, { originAgentId: "not-a-uuid" })),
      broadcastInput("artifact-malformed-execution", runtimeArtifactInput(5, { executionId: "not-a-uuid" })),
      broadcastInput("artifact-unknown-field", { ...runtimeArtifactInput(10), unknown: true } as never),
      broadcastInput("artifact-noncanonical-role", { ...runtimeArtifactInput(11), role: "result" } as never),
      broadcastInput("artifact-noncanonical-media", { ...runtimeArtifactInput(12), mediaType: "text/plain" } as never),
      broadcastInput("artifact-uppercase-origin", runtimeArtifactInput(13, {
        originAgentId: recipientA.toUpperCase(), executionId: localRun.runId,
      })),
      broadcastInput("artifact-uppercase-execution", runtimeArtifactInput(14, {
        originAgentId: recipientA, executionId: localRun.runId.toUpperCase(),
      })),
      broadcastInput("artifact-uppercase-id", {
        ...runtimeArtifactInput(21), id: runtimeArtifactInput(21).id.toUpperCase(),
        blobPath: runtimeArtifactInput(21).id.toUpperCase(),
      } as never),
    ];
    const before = runtimeMutationState();
    for (const input of rejected) {
      expect(() => store.recordRuntimeCommunication(input)).toThrow(
        "runtime communication artifact metadata or provenance is invalid",
      );
      expect(runtimeMutationState()).toEqual(before);
    }

    const matching = runtimeArtifactInput(6, {
      originAgentId: recipientA,
      executionId: localRun.runId,
    });
    expect(store.recordRuntimeCommunication(broadcastInput("artifact-matching-identities", matching)))
      .toMatchObject({ artifactIds: [matching.id], replayed: false });
    expect(store.runtimeArtifact(matching.id)).toMatchObject({
      projectId,
      originAgentId: recipientA,
      executionId: localRun.runId,
    });

    const userArtifact = runtimeArtifactInput(7);
    expect(store.recordRuntimeCommunication(broadcastInput("artifact-user-without-provenance", userArtifact)))
      .toMatchObject({ artifactIds: [userArtifact.id], replayed: false });
    expect(store.runtimeArtifact(userArtifact.id)).toMatchObject({ projectId });
    expect(store.runtimeArtifact(userArtifact.id)).not.toHaveProperty("originAgentId");
    expect(store.runtimeArtifact(userArtifact.id)).not.toHaveProperty("executionId");
  });

  it("authorizes managed artifact attachments inside the fenced Communication transaction and hashes their identities", () => {
    const firstArtifactId = randomUUID();
    const secondArtifactId = randomUUID();
    const authorized = new Set([firstArtifactId, secondArtifactId]);
    const authorityCalls: string[][] = [];
    const revalidationCalls: string[][] = [];
    store = new CoordinationV3Store(opened.client, {
      managedArtifactAttachmentAuthority: (input) => {
        expect(opened.client.inTransaction).toBe(true);
        authorityCalls.push(input.artifactIds);
        expect(input).toMatchObject({
          projectId,
          sender: { kind: "agent", agentId: recipientA },
          audience: { kind: "agents", agentIds: [recipientB] },
        });
        if (input.artifactIds.some((id) => !authorized.has(id))) {
          throw new Error("managed artifact attachment is unavailable or unauthorized");
        }
      },
      managedArtifactAttachmentRevalidator: (input) => {
        expect(opened.client.inTransaction).toBe(false);
        revalidationCalls.push(input.artifactIds);
      },
    });
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "managed-attachment-run",
      scopeKey: `conversation:${conversationId}`,
      kind: "ordinary", payload: { text: "Attach the screenshot" },
    });
    const run = store.leaseNextRun({ workerId: "managed-attachment-worker" })!;
    acknowledgeLease(run);
    const runAuthorization = {
      runId: run.runId,
      agentId: recipientA,
      fencingToken: run.fencingToken,
    };
    const communication = (artifactIds: string[]): CommunicationEvent => ({
      eventId: "managed-attachment-message",
      schemaVersion: 2,
      projectId,
      conversationId,
      sender: { kind: "agent", agentId: recipientA, executionId: run.runId },
      intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipientB] },
      text: "",
      artifactIds,
      createdAt: "2026-07-15T00:00:00.000Z",
      idempotencyKey: "managed-attachment-key",
    });
    const record = (artifactIds: string[], id = "managed-attachment-message") => {
      const event = { ...communication(artifactIds), eventId: id };
      return store.recordRuntimeCommunication({
        id,
        projectId,
        sender: event.sender,
        intent: event.intent,
        audience: event.audience,
        payload: event,
        scopeKey: `conversation:${conversationId}`,
        runAuthorization,
        activation: {
          agentId: recipientB,
          kind: "ordinary_message",
          priority: 50,
          dispatchPolicy: "next_run",
          promptClass: "ordinary",
        },
        now: event.createdAt,
      });
    };

    expect(record([firstArtifactId])).toMatchObject({ replayed: false });
    expect(revalidationCalls).toEqual([[firstArtifactId]]);
    authorized.delete(firstArtifactId);
    expect(record([firstArtifactId])).toMatchObject({ replayed: true });
    expect(revalidationCalls).toEqual([[firstArtifactId]]);
    expect(() => record([secondArtifactId])).toThrow("runtime communication ID collision");
    expect(opened.client.prepare(`
      SELECT json_extract(payload_json, '$.artifactIds[0]') AS artifactId
      FROM runtime_communications WHERE id = 'managed-attachment-message'
    `).get()).toEqual({ artifactId: firstArtifactId });

    const beforeUnauthorized = runtimeMutationState();
    expect(() => record([randomUUID()], "managed-attachment-unauthorized"))
      .toThrow("managed artifact attachment is unavailable or unauthorized");
    expect(runtimeMutationState()).toEqual(beforeUnauthorized);

    store.cancelAgentRun({
      agentId: recipientA,
      expectedRunId: run.runId,
      idempotencyKey: "cancel-managed-attachment-run",
    });
    expect(() => record([firstArtifactId], "managed-attachment-after-cancel"))
      .toThrow("no longer authoritative");
    expect(authorityCalls).toHaveLength(2);
  });

  it("applies the same artifact provenance admission before request-update and queued-edit mutation", () => {
    const foreign = seedAdditionalProject("Foreign alternate artifact path");
    const invalidAlternateArtifacts = [
      runtimeArtifactInput(8, { originAgentId: foreign.agentId }),
      runtimeArtifactInput(16, { executionId: randomUUID() }),
      { ...runtimeArtifactInput(17), extra: "closed" },
      { ...runtimeArtifactInput(18), mediaType: "text/plain" },
    ];
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "artifact-request",
      requests: [{ requestId: "artifact-request", recipientAgentId: recipientA, lifetime: indefinite }],
    });
    const beforeUpdate = runtimeMutationState();
    invalidAlternateArtifacts.forEach((artifact, index) => {
      expect(() => store.updateRequest({
        requestId: "artifact-request",
        updateId: `artifact-request-update-${index}`,
        kind: "completed",
        actor: { kind: "agent", id: recipientA },
        payload: { text: "Result" },
        artifacts: [artifact as never],
      })).toThrow("request update artifact metadata or provenance is invalid");
      expect(runtimeMutationState()).toEqual(beforeUpdate);
    });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates WHERE id LIKE 'artifact-request-update-%'
    `).get()).toEqual({ count: 0 });
    expect(store.getRequest("artifact-request")).toMatchObject({ state: "open", version: 0 });

    const communication = userDmEvent({
      eventId: "artifact-queued-edit", agentId: recipientB, text: "Original",
    });
    const intake = store.recordRuntimeCommunication({
      id: communication.eventId,
      projectId,
      sender: communication.sender,
      intent: communication.intent,
      audience: communication.audience,
      payload: { communication, dispatch: { text: communication.text } },
      activation: {
        agentId: recipientB,
        kind: "human_message",
        priority: 100,
        dispatchPolicy: "next_run",
        promptClass: "human",
      },
    });
    const beforeEdit = runtimeMutationState();
    const activationBefore = opened.client.prepare(`
      SELECT payload_json FROM agent_activations WHERE id = ?
    `).get(intake.activationId) as { payload_json: string };
    invalidAlternateArtifacts.forEach((artifact, index) => {
      expect(() => store.editPendingActivationText({
        activationId: intake.activationId!,
        projectId,
        requestText: `Edited ${index}`,
        text: `Edited ${index}`,
        revisionOwnerId: `artifact-queued-edit-revision-${index}`,
        artifact: artifact as never,
        revisionOutboxPayload: { revision: `artifact-queued-edit-revision-${index}` },
        idempotencyKey: `artifact-queued-edit-${index}`,
      })).toThrow("queued edit artifact metadata or provenance is invalid");
      expect(runtimeMutationState()).toEqual(beforeEdit);
    });
    expect(opened.client.prepare(`
      SELECT payload_json FROM agent_activations WHERE id = ?
    `).get(intake.activationId)).toEqual(activationBefore);
  });

  it("requires exact managed-artifact bytes on Communication, Request update, and queued edit before mutation", () => {
    const missing = runtimeArtifactInput(31);
    const mismatched = runtimeArtifactInput(32);
    store = new CoordinationV3Store(opened.client, {
      artifactAuthority: (_candidateProjectId, artifact) => artifact.id === mismatched.id
        ? {
            artifact,
            localPath: `/managed/${artifact.id}`,
            contentHash: "f".repeat(64),
            byteLength: artifact.byteLength,
          }
        : undefined,
    });
    const broadcast = (id: string, artifact: typeof missing) => ({
      id, projectId,
      sender: { kind: "user" as const, userId: "local-operator" },
      intent: "broadcast" as const,
      audience: { kind: "organization" as const, organizationId: projectId },
      payload: { text: id }, artifacts: [artifact],
    });
    const empty = runtimeMutationState();
    expect(() => store.recordRuntimeCommunication(broadcast("missing-runtime-artifact", missing)))
      .toThrow("runtime communication artifact authority mismatch");
    expect(() => store.recordRuntimeCommunication(broadcast("mismatched-runtime-artifact", mismatched)))
      .toThrow("runtime communication artifact authority mismatch");
    expect(runtimeMutationState()).toEqual(empty);
    expect(store.leaseNextRun({ workerId: "artifact-rejection" })).toBeUndefined();

    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "missing-authority-request",
      requests: [{ requestId: "missing-authority-request", recipientAgentId: recipientA, lifetime: indefinite }],
    });
    const beforeUpdate = runtimeMutationState();
    for (const [index, artifact] of [missing, mismatched].entries()) {
      expect(() => store.updateRequest({
        requestId: "missing-authority-request", updateId: `missing-authority-update-${index}`,
        kind: "completed", actor: { kind: "agent", id: recipientA },
        payload: { text: "must not commit" }, artifacts: [artifact],
      })).toThrow("request update artifact authority mismatch");
      expect(runtimeMutationState()).toEqual(beforeUpdate);
    }
    expect(store.getRequest("missing-authority-request")).toMatchObject({ state: "open", version: 0 });

    const communication = userDmEvent({ eventId: "missing-authority-edit", agentId: recipientB, text: "Original" });
    const intake = store.recordRuntimeCommunication({
      id: communication.eventId, projectId, sender: communication.sender,
      intent: communication.intent, audience: communication.audience,
      payload: { communication, dispatch: { text: communication.text } },
      activation: {
        agentId: recipientB, kind: "human_message", priority: 100,
        dispatchPolicy: "next_run", promptClass: "human",
      },
    });
    const beforeEdit = runtimeMutationState();
    for (const [index, artifact] of [missing, mismatched].entries()) {
      expect(() => store.editPendingActivationText({
        activationId: intake.activationId!, projectId, requestText: `Rejected ${index}`,
        text: `Rejected ${index}`, revisionOwnerId: `missing-authority-edit-${index}`,
        artifact, revisionOutboxPayload: { rejected: index }, idempotencyKey: `missing-authority-edit-${index}`,
      })).toThrow("queued edit artifact authority mismatch");
      expect(runtimeMutationState()).toEqual(beforeEdit);
    }
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual({ count: 0 });
  });

  it("accepts paired agent/Run provenance and provenance-free user artifacts on alternate artifact paths", () => {
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "artifact-positive-run",
      kind: "ordinary", payload: { text: "artifact authority" },
    });
    const lease = store.leaseNextRun({ workerId: "artifact-positive-worker" })!;
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "artifact-positive-request",
      requests: [{ requestId: "artifact-positive-request", recipientAgentId: recipientA, lifetime: indefinite }],
    });
    const paired = runtimeArtifactInput(19, {
      originAgentId: recipientA,
      executionId: lease.runId,
    });
    expect(store.updateRequest({
      requestId: "artifact-positive-request",
      updateId: "artifact-positive-update",
      kind: "completed",
      actor: { kind: "agent", id: recipientA },
      payload: { text: "Paired result" },
      artifacts: [paired],
    })).toMatchObject({ state: "completed", replayed: false });
    expect(store.runtimeArtifact(paired.id)).toMatchObject({
      ownerKind: "request_update",
      originAgentId: recipientA,
      executionId: lease.runId,
    });

    const communication = userDmEvent({
      eventId: "artifact-positive-queued-edit", agentId: recipientB, text: "Original",
    });
    const intake = store.recordRuntimeCommunication({
      id: communication.eventId,
      projectId,
      sender: communication.sender,
      intent: communication.intent,
      audience: communication.audience,
      payload: { communication, dispatch: { text: communication.text } },
      activation: {
        agentId: recipientB,
        kind: "human_message",
        priority: 100,
        dispatchPolicy: "next_run",
        promptClass: "human",
      },
    });
    const userArtifact = runtimeArtifactInput(20);
    expect(store.editPendingActivationText({
      activationId: intake.activationId!,
      projectId,
      requestText: "Edited",
      text: "Edited",
      revisionOwnerId: "artifact-positive-revision",
      artifact: userArtifact,
      revisionOutboxPayload: { revision: "artifact-positive-revision" },
      idempotencyKey: "artifact-positive-edit",
    })).toMatchObject({ edited: true, replayed: false });
    expect(store.runtimeArtifact(userArtifact.id)).toMatchObject({ ownerKind: "communication", projectId });
    expect(store.runtimeArtifact(userArtifact.id)).not.toHaveProperty("originAgentId");
    expect(store.runtimeArtifact(userArtifact.id)).not.toHaveProperty("executionId");
  });

  it("rejects malformed top-level and per-recipient dispatch attachments before durable intake", () => {
    const validAttachment = {
      id: randomUUID(), name: "evidence.pdf", mediaType: "application/pdf", size: 42,
    };
    const input = (id: string, dispatch: unknown) => {
      const communication = userDmEvent({
        eventId: id, agentId: recipientA, conversation: conversationId,
      });
      return {
        id,
        projectId,
        sender: communication.sender,
        intent: communication.intent,
        audience: communication.audience,
        payload: { communication, dispatch },
        activation: {
          agentId: recipientA,
          kind: "human_message",
          priority: 100,
          dispatchPolicy: "next_run" as const,
          promptClass: "human" as const,
        },
      };
    };
    const duplicate = [{ ...validAttachment }, { ...validAttachment, name: "duplicate.pdf" }];
    const rejected = [
      input("top-level-attachments-non-array", { attachments: {} }),
      input("top-level-attachment-non-record", { attachments: [null] }),
      input("top-level-attachment-incomplete", { attachments: [{ ...validAttachment, name: undefined }] }),
      input("top-level-attachment-malformed-metadata", {
        attachments: [{ ...validAttachment, mediaType: "text/html" }],
      }),
      input("top-level-attachment-unknown-metadata", {
        attachments: [{ ...validAttachment, agentId: recipientA }],
      }),
      input("top-level-attachment-duplicate", { attachments: duplicate }),
      input("recipients-non-array", { recipients: {} }),
      input("recipient-non-record", { recipients: [null] }),
      input("recipient-attachments-non-array", {
        recipients: [{ agentId: recipientA, attachments: {} }],
      }),
      input("recipient-attachment-non-record", {
        recipients: [{ agentId: recipientA, attachments: [null] }],
      }),
      input("recipient-attachment-incomplete", {
        recipients: [{ agentId: recipientA, attachments: [{ ...validAttachment, size: undefined }] }],
      }),
      input("recipient-attachment-malformed-metadata", {
        recipients: [{ agentId: recipientA, attachments: [{ ...validAttachment, id: "not-a-uuid" }] }],
      }),
      input("recipient-attachment-unknown-metadata", {
        recipients: [{ agentId: recipientA, attachments: [{ ...validAttachment, url: "/not-dispatch-metadata" }] }],
      }),
      input("recipient-attachment-duplicate", {
        recipients: [{ agentId: recipientA, attachments: duplicate }],
      }),
    ];
    const before = runtimeMutationState();
    for (const candidate of rejected) {
      expect(() => store.recordRuntimeCommunication(candidate as never)).toThrow(
        /runtime communication (attachments are invalid|authority does not agree)/,
      );
      expect(runtimeMutationState()).toEqual(before);
    }

    const authoritative = runtimeAttachment(recipientA, { id: validAttachment.id });
    store = new CoordinationV3Store(opened.client, {
      attachmentAuthority: {
        resolve: (candidateProjectId, candidateAgentId, attachmentId) =>
          candidateProjectId === projectId && candidateAgentId === recipientA && attachmentId === authoritative.id
            ? {
                attachment: authoritative as typeof authoritative & { sha256: string },
                localPath: `/validated/${authoritative.id}.bin`,
                contentHash: authoritative.sha256!,
                byteLength: authoritative.size,
              }
            : undefined,
        reserveCommunication: (communicationId) => emptyReservationReceipt(communicationId),
        compensateCommunication: () => undefined,
      },
    });

    expect(store.recordRuntimeCommunication(input("top-level-empty-attachments", { attachments: [] })).activationId)
      .toBeTruthy();
    expect(store.recordRuntimeCommunication(input("recipient-empty-attachments", {
      recipients: [{ agentId: recipientA, attachments: [] }],
    })).activationId).toBeTruthy();
    expect(store.recordRuntimeCommunication(input("top-level-valid-attachment", {
      attachments: [{ ...validAttachment, localPath: `/validated/${authoritative.id}.bin` }],
    })).activationId).toBeTruthy();
    expect(store.recordRuntimeCommunication(input("recipient-valid-attachment", {
      recipients: [{ agentId: recipientA, attachments: [validAttachment] }],
    })).activationId).toBeTruthy();
  });

  it("binds canonical and dispatch attachments to one authoritative Project and owner before mutation", () => {
    const foreign = seedAdditionalProject("Foreign attachment authority");
    const authority = new Map<string, { attachment: import("@ponderosa/core").AssetDto; localPath: string }>();
    const register = (candidateProjectId: string, agentId: string, attachment: import("@ponderosa/core").AssetDto) => {
      const bound = {
        attachment,
        localPath: `/authority/projects/${candidateProjectId}/agents/${agentId}/${attachment.id}.bin`,
      };
      authority.set(`${candidateProjectId}:${agentId}:${attachment.id}`, bound);
      return bound;
    };
    store = new CoordinationV3Store(opened.client, {
      attachmentAuthority: {
        resolve: (candidateProjectId, agentId, attachmentId) => {
          const resolved = authority.get(`${candidateProjectId}:${agentId}:${attachmentId}`);
          return resolved ? {
            attachment: resolved.attachment as typeof resolved.attachment & { sha256: string },
            localPath: resolved.localPath,
            contentHash: resolved.attachment.sha256!,
            byteLength: resolved.attachment.size,
          } : undefined;
        },
        reserveCommunication: (communicationId) => emptyReservationReceipt(communicationId),
        compensateCommunication: () => undefined,
      },
    });
    const snapshot = (attachment: import("@ponderosa/core").AssetDto, localPath?: string) => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      ...(localPath ? { localPath } : {}),
    });
    const input = (
      id: string,
      attachments: import("@ponderosa/core").AssetDto[] | undefined,
      dispatch?: Record<string, unknown>,
    ) => {
      const communication = userDmEvent({ eventId: id, agentId: recipientA, conversation: conversationId });
      return {
        id,
        projectId,
        sender: communication.sender,
        intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication: {
            ...communication,
            ...(attachments !== undefined ? { attachments } : {}),
          },
          ...(dispatch ? { dispatch } : {}),
        },
        activation: {
          agentId: recipientA,
          kind: "human_message",
          priority: 100,
          dispatchPolicy: "next_run" as const,
          promptClass: "human" as const,
        },
      };
    };

    const valid = runtimeAttachment(recipientA);
    const validBound = register(projectId, recipientA, valid);
    const missingCanonical = runtimeAttachment(recipientA);
    const foreignCanonical = runtimeAttachment(recipientA);
    register(foreign.projectId, recipientA, foreignCanonical);
    const reused = runtimeAttachment(recipientA);
    register(projectId, recipientA, reused);
    const oversized = Array.from({ length: 11 }, (_, index) => {
      const item = runtimeAttachment(recipientA, {
        id: randomUUID(), name: `oversized-${index}.pdf`, size: 8 * 1024 * 1024,
      });
      register(projectId, recipientA, item);
      return item;
    });
    const overCount = Array.from({ length: 21 }, (_, index) => runtimeAttachment(recipientA, {
      id: randomUUID(), name: `count-${index}.pdf`,
    }));
    const rejected = [
      input("missing-canonical-authority", [missingCanonical]),
      input("foreign-canonical-authority", [foreignCanonical]),
      input("forged-local-path", [valid], {
        attachments: [snapshot(valid, `/other/project/${valid.id}.bin`)],
      }),
      input("uppercase-attachment-id", undefined, {
        attachments: [{ ...snapshot(valid), id: valid.id.toUpperCase() }],
      }),
      input("case-variant-reuse", undefined, {
        recipients: [{ agentId: recipientA, attachments: [snapshot(valid), {
          ...snapshot(valid), id: valid.id.toUpperCase(),
        }] }],
      }),
      input("top-recipient-reuse", undefined, {
        attachments: [snapshot(reused)],
        recipients: [{ agentId: recipientA, attachments: [snapshot(reused)] }],
      }),
      input("cross-recipient-reuse", undefined, {
        recipients: [
          { agentId: recipientA, attachments: [snapshot(reused)] },
          { agentId: recipientB, attachments: [snapshot(reused)] },
        ],
      }),
      input("over-count", undefined, { attachments: overCount.map((item) => snapshot(item)) }),
      input("over-size", undefined, { attachments: oversized.map((item) => snapshot(item)) }),
      input("canonical-over-count", overCount),
      input("canonical-over-size", oversized),
      input("canonical-unknown-field", [{ ...valid, localPath: validBound.localPath } as never]),
    ];
    const before = runtimeMutationState();
    for (const candidate of rejected) {
      expect(() => store.recordRuntimeCommunication(candidate as never)).toThrow(/runtime communication attachment/);
      expect(runtimeMutationState()).toEqual(before);
    }

    expect(store.recordRuntimeCommunication(input("valid-empty-canonical", [], { attachments: [] })).activationId)
      .toBeTruthy();
    expect(store.recordRuntimeCommunication(input("valid-authoritative-attachment", [valid], {
      attachments: [snapshot(valid, validBound.localPath)],
    })).activationId).toBeTruthy();
    expect((store.runtimeCommunication("valid-authoritative-attachment")!.payload as {
      dispatch: { attachments: Array<{ localPath: string }> };
    }).dispatch.attachments[0]!.localPath).toBe(validBound.localPath);
    const passive = input("valid-passive-authoritative-attachment", [valid], {
      attachments: [snapshot(valid)],
    });
    expect(store.recordRuntimeCommunication({ ...passive, activation: undefined })).toMatchObject({
      id: "valid-passive-authoritative-attachment",
      replayed: false,
    });

    const mediaTypes: import("@ponderosa/core").AssetMediaType[] = [
      "image/png", "image/jpeg", "image/webp", "application/pdf",
      "text/plain", "application/json", "application/zip",
    ];
    for (const [index, mediaType] of mediaTypes.entries()) {
      const attachment = runtimeAttachment(recipientA, {
        id: randomUUID(), name: `type-${index}`, mediaType,
      });
      register(projectId, recipientA, attachment);
      expect(store.recordRuntimeCommunication(input(`valid-media-${index}`, [attachment])).activationId).toBeTruthy();
    }
  });

  it("enforces one global canonical budget and resolves each multi-recipient attachment identity once", () => {
    const authority = new Map<string, import("../src/coordination-v3-store.js").RuntimeAttachmentAuthorityV3>();
    const calls = new Map<string, number>();
    const register = (owner: string, size = 64, id = randomUUID()) => {
      const attachment = runtimeAttachment(owner, {
        id, name: `${id}.pdf`, size, sha256: id.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
      }) as import("@ponderosa/core").AssetDto & { sha256: string };
      const key = `${projectId}:${owner}:${id}`;
      authority.set(key, {
        attachment, localPath: `/authority/${projectId}/${owner}/${id}.bin`,
        contentHash: attachment.sha256, byteLength: size,
      });
      return attachment;
    };
    store = new CoordinationV3Store(opened.client, {
      attachmentAuthority: {
        resolve: (candidateProjectId, owner, id) => {
          const key = `${candidateProjectId}:${owner}:${id}`;
          calls.set(key, (calls.get(key) ?? 0) + 1);
          return authority.get(key);
        },
        reserveCommunication: (communicationId) => emptyReservationReceipt(communicationId),
        compensateCommunication: () => undefined,
      },
    });
    const snapshot = (attachment: import("@ponderosa/core").AssetDto) => ({
      id: attachment.id, name: attachment.name, mediaType: attachment.mediaType,
      size: attachment.size, sha256: attachment.sha256,
    });
    const communicationInput = (
      id: string,
      dispatchAttachments: import("@ponderosa/core").AssetDto[],
      options: { canonicalAttachments?: import("@ponderosa/core").AssetDto[]; omitCanonical?: boolean } = {},
    ) => {
      const canonicalAttachments = options.omitCanonical ? undefined
        : options.canonicalAttachments ?? dispatchAttachments;
      const communication: CommunicationEvent = {
        eventId: id, schemaVersion: 2, projectId, conversationId,
        sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        audience: { kind: "user_agents", userId: "local-operator", agentIds: [recipientA, recipientB] },
        text: "Bounded multi-recipient intake",
        ...(canonicalAttachments ? { attachments: canonicalAttachments } : {}),
        createdAt: "2026-07-15T00:00:00.000Z",
      };
      return {
        id, projectId, sender: communication.sender, intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication,
          dispatch: {
            text: communication.text,
            recipients: dispatchAttachments.map((attachment) => ({
              agentId: attachment.agentId, attachments: [snapshot(attachment)],
            })),
          },
        },
        activations: [recipientA, recipientB].map((agentId) => ({
          agentId, kind: "human_message", priority: 100,
          dispatchPolicy: "next_run" as const, promptClass: "human" as const,
        })),
      };
    };

    const first = register(recipientA);
    const second = register(recipientB);
    expect(store.recordRuntimeCommunication(communicationInput("bounded-resolver-work", [first, second])))
      .toMatchObject({ replayed: false, activationIds: expect.arrayContaining([expect.any(String), expect.any(String)]) });
    expect([...calls.values()]).toEqual([2, 2]);
    const persisted = store.runtimeCommunication("bounded-resolver-work")!.payload as {
      dispatch: { recipients: Array<{ attachments: Array<{ sha256: string; localPath: string }> }> };
    };
    expect(persisted.dispatch.recipients.flatMap((recipient) => recipient.attachments))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sha256: first.sha256, localPath: expect.stringContaining(first.id) }),
        expect.objectContaining({ sha256: second.sha256, localPath: expect.stringContaining(second.id) }),
      ]));

    const deterministicId = (sequence: number) =>
      `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    const overCount = Array.from({ length: 21 }, (_, index) =>
      register(index < 11 ? recipientA : recipientB, 64, deterministicId(index + 1)));
    const before = runtimeMutationState();
    calls.clear();
    expect(() => store.recordRuntimeCommunication(communicationInput(
      "global-cross-owner-count", overCount, { omitCanonical: true },
    )))
      .toThrow("runtime communication attachments are invalid");
    expect(calls.size).toBe(0);
    expect(runtimeMutationState()).toEqual(before);

    const four = overCount.slice(0, 4);
    const fanout = communicationInput("bounded-structural-fanout", four, { omitCanonical: true });
    fanout.payload.dispatch.recipients = Array.from({ length: 100 }, () => ({
      agentId: recipientA,
      attachments: four.map(snapshot),
    }));
    calls.clear();
    expect(() => store.recordRuntimeCommunication(fanout))
      .toThrow("runtime communication attachments are invalid");
    expect(calls.size).toBe(0);
    expect(runtimeMutationState()).toEqual(before);

    const overBytes = Array.from({ length: 11 }, (_, index) => register(
      index < 6 ? recipientA : recipientB,
      DEFAULT_ASSET_LIMITS.maxFileBytes,
      deterministicId(30 + index),
    ));
    expect(() => store.recordRuntimeCommunication(communicationInput(
      "global-cross-owner-bytes", overBytes, { omitCanonical: true },
    )))
      .toThrow("runtime communication attachments are invalid");
    expect(calls.size).toBe(11);
    expect([...calls.values()]).toEqual(Array.from({ length: 11 }, () => 1));
    expect(runtimeMutationState()).toEqual(before);

    calls.clear();
    const exactBudget = [
      register(recipientA, 6 * 1024 * 1024, deterministicId(10)),
      register(recipientA, 6 * 1024 * 1024, deterministicId(11)),
      register(recipientB, 6 * 1024 * 1024, deterministicId(12)),
      register(recipientB, 6 * 1024 * 1024, deterministicId(13)),
    ];
    expect(store.recordRuntimeCommunication(communicationInput("exact-global-budget", exactBudget)))
      .toMatchObject({ replayed: false });
    expect(calls.size).toBe(4);
    expect([...calls.values()]).toEqual([2, 2, 2, 2]);
    const afterExactBudget = runtimeMutationState();

    const sharedId = randomUUID();
    const ownerA = register(recipientA, 64, sharedId);
    register(recipientB, 65, sharedId);
    const contradictory = communicationInput("cross-owner-one-id", [ownerA]);
    (contradictory.payload.dispatch.recipients as Array<{ agentId: string; attachments: unknown[] }>)[0] = {
      agentId: recipientB, attachments: [{ ...snapshot(ownerA), size: 65 }],
    };
    expect(() => store.recordRuntimeCommunication(contradictory))
      .toThrow(/attachment (authority mismatch|identity conflicts)/);
    expect(runtimeMutationState()).toEqual(afterExactBudget);
  });

  it("enforces the aggregate attachment budget when canonical attachments are absent", () => {
    const authority = new Map<string, import("../src/coordination-v3-store.js").RuntimeAttachmentAuthorityV3>();
    const deterministicId = (sequence: number) =>
      `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    const register = (owner: string, sequence: number, size: number) => {
      const id = deterministicId(sequence);
      const attachment = runtimeAttachment(owner, {
        id, name: `aggregate-${sequence}.pdf`, size,
        sha256: id.replaceAll("-", "").padEnd(64, "b").slice(0, 64),
      }) as import("@ponderosa/core").AssetDto & { sha256: string };
      authority.set(`${projectId}:${owner}:${id}`, {
        attachment,
        localPath: `/authority/${projectId}/${owner}/${id}.bin`,
        contentHash: attachment.sha256,
        byteLength: size,
      });
      return attachment;
    };
    store = new CoordinationV3Store(opened.client, {
      attachmentAuthority: {
        resolve: (candidateProjectId, owner, id) => authority.get(`${candidateProjectId}:${owner}:${id}`),
        reserveCommunication: (communicationId) => emptyReservationReceipt(communicationId),
        compensateCommunication: () => undefined,
      },
    });
    const snapshot = (attachment: import("@ponderosa/core").AssetDto) => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      sha256: attachment.sha256,
    });
    const input = (
      id: string,
      attachments: import("@ponderosa/core").AssetDto[],
      canonicalAttachments?: import("@ponderosa/core").AssetDto[],
      activate = true,
    ) => {
      const communication: CommunicationEvent = {
        eventId: id, schemaVersion: 2, projectId, conversationId,
        sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        audience: { kind: "user_agents", userId: "local-operator", agentIds: [recipientA, recipientB] },
        text: "Aggregate attachment budget",
        ...(canonicalAttachments ? { attachments: canonicalAttachments } : {}),
        createdAt: "2026-07-19T00:00:00.000Z",
      };
      return {
        id, projectId, sender: communication.sender, intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication,
          dispatch: {
            text: communication.text,
            recipients: [recipientA, recipientB].map((agentId) => ({
              agentId,
              attachments: attachments.filter((attachment) => attachment.agentId === agentId).map(snapshot),
            })),
          },
        },
        ...(activate ? { activations: [recipientA, recipientB].map((agentId) => ({
          agentId, kind: "human_message", priority: 100,
          dispatchPolicy: "next_run" as const, promptClass: "human" as const,
        })) } : {}),
      };
    };

    const overCount = Array.from({ length: 21 }, (_, index) =>
      register(index < 11 ? recipientA : recipientB, index + 1, 1));
    const before = runtimeMutationState();
    expect(() => store.recordRuntimeCommunication(input("recipient-only-five-items", overCount)))
      .toThrow("runtime communication attachments are invalid");
    expect(runtimeMutationState()).toEqual(before);
    expect(store.leaseNextRun({ workerId: "recipient-only-count-rejection" })).toBeUndefined();
    expect(runtimeMutationState()).toEqual(before);

    const overBytes = Array.from({ length: 11 }, (_, index) =>
      register(index < 6 ? recipientA : recipientB, 30 + index, DEFAULT_ASSET_LIMITS.maxFileBytes));
    expect(() => store.recordRuntimeCommunication(input("recipient-only-over-byte-budget", overBytes)))
      .toThrow("runtime communication attachments are invalid");
    expect(runtimeMutationState()).toEqual(before);
    expect(store.leaseNextRun({ workerId: "recipient-only-byte-rejection" })).toBeUndefined();
    expect(runtimeMutationState()).toEqual(before);

    const boundary = [
      register(recipientA, 10, DEFAULT_ASSET_LIMITS.maxFileBytes),
      register(recipientA, 11, DEFAULT_ASSET_LIMITS.maxFileBytes),
      register(recipientB, 12, DEFAULT_ASSET_LIMITS.maxFileBytes / 2),
      register(recipientB, 13, DEFAULT_ASSET_LIMITS.maxFileBytes / 2),
    ];
    expect(store.recordRuntimeCommunication(input("recipient-only-twenty-four-mib", boundary)))
      .toMatchObject({ replayed: false, activationIds: expect.arrayContaining([expect.any(String), expect.any(String)]) });
    expect(store.leaseNextRun({ workerId: "recipient-only-boundary" })).toMatchObject({ projectId });

    const identical = [
      register(recipientA, 14, DEFAULT_ASSET_LIMITS.maxFileBytes),
      register(recipientA, 15, DEFAULT_ASSET_LIMITS.maxFileBytes),
      register(recipientB, 16, DEFAULT_ASSET_LIMITS.maxFileBytes / 2),
      register(recipientB, 17, DEFAULT_ASSET_LIMITS.maxFileBytes / 2),
    ];
    expect(store.recordRuntimeCommunication(input(
      "canonical-dispatch-identical-twenty-four-mib", identical, identical, false,
    ))).toEqual({ id: "canonical-dispatch-identical-twenty-four-mib", replayed: false });

    const sharedId = deterministicId(18);
    const ownerA = register(recipientA, 18, 64);
    const ownerB = register(recipientB, 18, 65);
    expect(ownerA.id).toBe(sharedId);
    const mismatch = input("canonical-dispatch-mismatch", [ownerB], [ownerA], false);
    const beforeMismatch = runtimeMutationState();
    expect(() => store.recordRuntimeCommunication(mismatch))
      .toThrow(/attachment (authority mismatch|identity conflicts)/);
    expect(runtimeMutationState()).toEqual(beforeMismatch);
  });

  it("accepts current canonical and closed internal RuntimeCommunication variants", () => {
    const userDm = userDmEvent({ eventId: "valid-user-dm", agentId: recipientA, conversation: conversationId });
    expect(store.recordRuntimeCommunication({
      id: userDm.eventId, projectId, sender: userDm.sender, intent: userDm.intent,
      audience: userDm.audience, payload: { communication: userDm },
      activation: { agentId: recipientA, kind: "human_message", priority: 100, dispatchPolicy: "next_run", promptClass: "human" },
    }).activationId).toBeTruthy();

    const collaboration: CommunicationEvent = {
      eventId: "valid-agent-collaboration", schemaVersion: 2, projectId, conversationId,
      sender: { kind: "agent", agentId: requesterId }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipientB] }, text: "Please review",
      createdAt: "2026-07-15T00:00:01.000Z",
    };
    expect(store.recordRuntimeCommunication({
      id: collaboration.eventId, projectId, sender: collaboration.sender, intent: collaboration.intent,
      audience: collaboration.audience, payload: { communication: collaboration },
      activation: { agentId: recipientB, kind: "ordinary_message", priority: 50, dispatchPolicy: "next_run", promptClass: "ordinary" },
    }).activationId).toBeTruthy();

    const broadcast: CommunicationEvent = {
      eventId: "valid-organization-audience", schemaVersion: 2, projectId, conversationId,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: projectId }, text: "Shared context",
      createdAt: "2026-07-15T00:00:02.000Z",
    };
    expect(store.recordRuntimeCommunication({
      id: broadcast.eventId, projectId, sender: broadcast.sender, intent: broadcast.intent,
      audience: broadcast.audience, payload: { communication: broadcast },
    })).toEqual({ id: broadcast.eventId, replayed: false });

    const managedFailure = store.recordRuntimeCommunication({
      id: "valid-managed-child-failure", projectId,
      sender: { kind: "system", component: "runtime-supervisor" }, intent: "managed_child_failure",
      audience: { kind: "agents", agentIds: [requesterId] },
      payload: {
        text: "Child failed", childAgentId: recipientA,
        executionId: "valid-child-execution", failure: "provider exited",
      },
      scopeKey: `conversation:${conversationId}`,
      activation: { agentId: requesterId, kind: "managed_child_failure", priority: 90, dispatchPolicy: "steer_or_run", promptClass: "blocker" },
    });
    expect(managedFailure.activationId).toBeTruthy();
    expect(store.deliveryReceiptsForCommunication(projectId, "valid-managed-child-failure"))
      .toEqual([expect.objectContaining({
        activationId: managedFailure.activationId,
        targetAgentId: requesterId,
        state: "queued",
      })]);

    const correction = userDmEvent({
      eventId: "valid-correction", agentId: recipientA, conversation: conversationId,
      text: "Corrected instruction", createdAt: "2026-07-15T00:00:03.000Z",
    });
    expect(store.recordRuntimeCommunication({
      id: correction.eventId, projectId, sender: correction.sender, intent: "correction",
      audience: correction.audience, payload: { communication: correction },
      activation: { agentId: recipientA, kind: "message_correction", priority: 100, dispatchPolicy: "next_run", promptClass: "human" },
    }).activationId).toBeTruthy();
  });

  it("keeps a queued delivery retry and its single-flight fence across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-delivery-retry-"));
    const databasePath = join(directory, "retry.sqlite");
    opened.client.close();
    try {
      opened = openDb(databasePath);
      store = new CoordinationV3Store(opened.client);
      seed();
      const eventId = "restart-safe-delivery-retry";
      const { activationId, steering } = createUncertainHumanSteer(eventId, "2026-07-15T00:00:00.000Z");
      opened.client.prepare("DELETE FROM scheduler_steering_recoveries WHERE injection_id = ?").run(steering.injectionId);
      const retry = store.retryMessageDelivery({
        projectId, activationId, idempotencyKey: "restart-retry", now: "2026-07-15T00:00:20.000Z",
      });
      opened.client.close();

      opened = openDb(databasePath);
      store = new CoordinationV3Store(opened.client);
      expect(store.deliveryReceiptsForCommunication(projectId, eventId)).toEqual([expect.objectContaining({
        activationId: retry.activationId,
        attemptCount: 2,
        state: "queued",
      })]);
      expect(store.retryMessageDelivery({
        projectId, activationId, idempotencyKey: "restart-competing-retry", now: "2026-07-15T00:00:21.000Z",
      })).toMatchObject({
        accepted: false, state: "not_retryable", rejectionReason: "stale_attempt",
      });
    } finally {
      opened.client.close();
      rmSync(directory, { recursive: true, force: true });
      opened = openDb(":memory:");
      store = new CoordinationV3Store(opened.client);
    }
  });

  it("rejects delivery retries while recovery is active, after recipient deletion, and for non-operator sources", () => {
    const active = createUncertainHumanSteer("active-recovery-not-retryable", "2026-07-15T00:00:00.000Z");
    expect(store.retryMessageDelivery({
      projectId, activationId: active.activationId, idempotencyKey: "too-early",
      now: "2026-07-15T00:00:01.000Z",
    })).toMatchObject({ accepted: false, rejectionReason: "not_terminal" });

    opened.client.prepare("DELETE FROM scheduler_steering_recoveries WHERE injection_id = ?")
      .run(active.steering.injectionId);
    opened.client.prepare("UPDATE agents SET archived = 1 WHERE id = ?").run(recipientA);
    expect(store.retryMessageDelivery({
      projectId, activationId: active.activationId, idempotencyKey: "missing-recipient",
      now: "2026-07-15T00:00:02.000Z",
    })).toMatchObject({ accepted: false, rejectionReason: "recipient_unavailable" });
    opened.client.prepare("UPDATE agents SET archived = 0 WHERE id = ?").run(recipientA);

    const nonOperator = store.recordRuntimeCommunication({
      id: "agent-authored-delivery", projectId,
      sender: { kind: "agent", agentId: requesterId }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipientA] },
      payload: { communication: {
        eventId: "agent-authored", schemaVersion: 2, projectId, conversationId,
        sender: { kind: "agent", agentId: requesterId }, intent: "collaboration",
        audience: { kind: "agents", agentIds: [recipientA] }, text: "Agent-authored work",
        createdAt: "2026-07-15T00:00:03.000Z",
      } },
      activation: {
        agentId: recipientA, kind: "ordinary_message", priority: 50,
        dispatchPolicy: "next_run", promptClass: "ordinary",
      },
      now: "2026-07-15T00:00:03.000Z",
    });
    opened.client.prepare("UPDATE agent_activations SET state = 'failed' WHERE id = ?")
      .run(nonOperator.activationId);
    expect(store.retryMessageDelivery({
      projectId, activationId: nonOperator.activationId!, idempotencyKey: "agent-authored-retry",
      now: "2026-07-15T00:00:04.000Z",
    })).toMatchObject({ accepted: false, rejectionReason: "not_operator_message" });
  });

  it("revokes Retry and ordinary lease admission when conversation membership is removed", () => {
    const otherConversationId = randomUUID();
    opened.client.prepare(`
      INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
      VALUES (?, ?, 'Other chat', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
    `).run(otherConversationId, projectId);
    opened.client.prepare(`
      INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
      VALUES (?, ?, 0)
    `).run(recipientA, otherConversationId);
    const failedEventId = "removed-scope-failed-delivery";
    const failedCommunication = userDmEvent({
      eventId: failedEventId, agentId: recipientA, conversation: conversationId,
      text: "Retry this only while membership remains active",
    });
    const failed = store.recordRuntimeCommunication({
      id: `dispatch:${failedEventId}:${recipientA}`,
      projectId,
      sender: failedCommunication.sender,
      intent: failedCommunication.intent,
      audience: failedCommunication.audience,
      payload: {
        communication: failedCommunication,
        dispatch: { text: "Retry this only while membership remains active" },
      },
      activation: {
        agentId: recipientA, kind: "ordinary_message", priority: 50,
        dispatchPolicy: "next_run", promptClass: "ordinary",
      },
      now: "2026-07-15T00:00:00.000Z",
    });
    opened.client.prepare(`
      UPDATE agent_activations
      SET state = 'failed', updated_at = '2026-07-15T00:00:01.000Z'
      WHERE id = ?
    `).run(failed.activationId);
    expect(store.deliveryReceiptsForCommunication(projectId, failedEventId)[0]).toMatchObject({
      activationId: failed.activationId,
      state: "failed",
      canRetry: true,
    });

    const targetCommunication = userDmEvent({
      eventId: "removed-scope-pending", agentId: recipientA, conversation: conversationId,
      text: "Must not lease after removal", createdAt: "2026-07-15T00:00:02.000Z",
    });
    const targetPending = store.recordRuntimeCommunication({
      id: "removed-scope-pending",
      projectId,
      sender: targetCommunication.sender,
      intent: targetCommunication.intent,
      audience: targetCommunication.audience,
      payload: {
        communication: targetCommunication,
        dispatch: { text: "Must not lease after removal" },
      },
      activation: {
        agentId: recipientA, kind: "ordinary_message", priority: 100,
        dispatchPolicy: "next_run", promptClass: "human",
      },
      now: "2026-07-15T00:00:02.000Z",
    });
    const otherCommunication = userDmEvent({
      eventId: "other-scope-pending", agentId: recipientA, conversation: otherConversationId,
      text: "Other-chat work remains authorized", createdAt: "2026-07-15T00:00:03.000Z",
    });
    const otherPending = store.recordRuntimeCommunication({
      id: "other-scope-pending",
      projectId,
      sender: otherCommunication.sender,
      intent: otherCommunication.intent,
      audience: otherCommunication.audience,
      payload: {
        communication: otherCommunication,
        dispatch: { text: "Other-chat work remains authorized" },
      },
      activation: {
        agentId: recipientA, kind: "ordinary_message", priority: 50,
        dispatchPolicy: "next_run", promptClass: "ordinary",
      },
      now: "2026-07-15T00:00:03.000Z",
    });

    opened.client.prepare(`
      DELETE FROM agent_conversation_memberships
      WHERE agent_id = ? AND conversation_id = ?
    `).run(recipientA, conversationId);
    expect(opened.client.prepare(`
      SELECT archived FROM agents WHERE id = ?
    `).get(recipientA)).toEqual({ archived: 0 });
    expect(opened.client.prepare(`
      SELECT 1 AS present FROM agent_conversation_memberships
      WHERE agent_id = ? AND conversation_id = ?
    `).get(recipientA, otherConversationId)).toEqual({ present: 1 });
    expect(store.deliveryReceiptsForCommunication(projectId, failedEventId)[0]).not.toHaveProperty("canRetry");
    const activationCount = (opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
    `).get() as { count: number }).count;
    expect(store.retryMessageDelivery({
      projectId,
      activationId: failed.activationId!,
      idempotencyKey: "removed-scope-retry",
      now: "2026-07-15T00:00:04.000Z",
    })).toMatchObject({
      accepted: false,
      rejectionReason: "recipient_unavailable",
    });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
    `).get()).toEqual({ count: activationCount });

    const lease = store.leaseNextRun({ workerId: "scope-worker", now: "2026-07-15T00:00:05.000Z" })!;
    expect(lease.scopeKey).toBe(`conversation:${otherConversationId}`);
    expect(lease.activationIds).toEqual([otherPending.activationId]);
    expect(opened.client.prepare(`
      SELECT state, terminal_outcome FROM agent_activations WHERE id = ?
    `).get(targetPending.activationId)).toEqual({
      state: "failed",
      terminal_outcome: "recipient_unavailable",
    });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE scope_key = ?
    `).get(`conversation:${conversationId}`)).toEqual({ count: 0 });
  });

  it("rejects removed-scope steering while preserving unrelated scoped work", () => {
    const otherConversationId = randomUUID();
    opened.client.prepare(`
      INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
      VALUES (?, ?, 'Other steering chat', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 0)
    `).run(otherConversationId, projectId);
    opened.client.prepare(`
      INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
      VALUES (?, ?, 0)
    `).run(recipientA, otherConversationId);
    store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      scopeKey: `conversation:${conversationId}`,
      messageId: "removed-steering-base",
      kind: "ordinary",
      payload: { text: "Start scoped work" },
      now: "2026-07-15T00:00:00.000Z",
    });
    const running = store.leaseNextRun({ workerId: "steering-worker", now: "2026-07-15T00:00:00.000Z" })!;
    acknowledgeLease(running);
    const steeringCommunication = userDmEvent({
      eventId: "removed-scope-steering", agentId: recipientA, conversation: conversationId,
      text: "Must not steer after removal", createdAt: "2026-07-15T00:00:01.000Z",
    });
    const steering = store.recordRuntimeCommunication({
      id: "removed-scope-steering",
      projectId,
      sender: steeringCommunication.sender,
      intent: steeringCommunication.intent,
      audience: steeringCommunication.audience,
      payload: {
        communication: steeringCommunication,
        dispatch: { text: "Must not steer after removal" },
      },
      activation: {
        agentId: recipientA, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
      now: "2026-07-15T00:00:01.000Z",
    });
    opened.client.prepare(`
      DELETE FROM agent_conversation_memberships
      WHERE agent_id = ? AND conversation_id = ?
    `).run(recipientA, conversationId);

    expect(store.leaseNextSteering({
      workerId: "steering-worker",
      now: "2026-07-15T00:00:02.000Z",
    })).toBeUndefined();
    expect(opened.client.prepare(`
      SELECT state, terminal_outcome FROM agent_activations WHERE id = ?
    `).get(steering.activationId)).toEqual({
      state: "failed",
      terminal_outcome: "recipient_unavailable",
    });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_prompt_injections
      WHERE run_id = ? AND kind = 'steer'
    `).get(running.runId)).toEqual({ count: 0 });

    store.completeRun(running.runId, running.fencingToken, "2026-07-15T00:00:03.000Z");
    store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      scopeKey: `conversation:${otherConversationId}`,
      messageId: "other-chat-after-removal",
      kind: "ordinary",
      payload: { text: "Still authorized elsewhere" },
      now: "2026-07-15T00:00:04.000Z",
    });
    expect(store.leaseNextRun({
      workerId: "other-worker",
      now: "2026-07-15T00:00:05.000Z",
    })?.scopeKey).toBe(`conversation:${otherConversationId}`);
  });

  it("fails malformed and cross-recipient Activation scopes closed", () => {
    store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      scopeKey: "conversation:",
      messageId: "malformed-scope",
      kind: "ordinary",
      payload: { text: "Malformed" },
    });
    store.enqueueMessageActivation({
      projectId,
      agentId: recipientB,
      scopeKey: `agent:${recipientA}`,
      messageId: "cross-recipient-scope",
      kind: "ordinary",
      payload: { text: "Wrong recipient" },
    });
    expect(store.leaseNextRun({ workerId: "fail-closed-worker" })).toBeUndefined();
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE terminal_outcome = 'recipient_unavailable'
        AND id IN (
          SELECT activation_id FROM activation_sources
          WHERE source_id IN ('malformed-scope', 'cross-recipient-scope')
        )
    `).get()).toEqual({ count: 2 });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs
    `).get()).toEqual({ count: 0 });
  });

  it("never interrupts a later unrelated Run when the recovery deadline races forward", () => {
    const now = "2026-07-15T00:00:00.000Z";
    const { run } = createUncertainHumanSteer("do-not-interrupt-later-run", now);
    store.completeRun(run.runId, run.fencingToken, "2026-07-15T00:00:05.000Z");
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "later-unrelated", kind: "ordinary",
      payload: { text: "Later unrelated work" }, now: "2026-07-15T00:00:06.000Z",
    });
    const later = store.leaseNextRun({ workerId: "worker-2", now: "2026-07-15T00:00:06.000Z" })!;
    acknowledgeLease(later);

    expect(store.processDueSteeringRecoveries("2026-07-15T00:00:10.000Z")).toEqual([recipientA]);
    expect(opened.client.prepare("SELECT status FROM scheduler_runs WHERE id = ?").get(later.runId))
      .toEqual({ status: "running" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM provider_operation_outbox WHERE run_id = ?
    `).get(later.runId)).toEqual({ count: 0 });
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

  it("retains one correlated late result without reopening an outcome-unknown Request or impossible Join", () => {
    store.coordinate({
      projectId, requesterAgentId: requesterId, actorScope: `agent:${requesterId}`,
      idempotencyKey: "saratoga-forge", requests: [{
        requestId: "forge-result", recipientAgentId: recipientA, lifetime: indefinite,
        payload: { text: "Forge the Saratoga result." },
      }], join: { id: "saratoga-join", mode: "all" },
    });
    const run = store.leaseNextRun({ workerId: "worker-1" })!;
    acknowledgeLease(run);
    expect(store.failRun({
      runId: run.runId, fencingToken: run.fencingToken,
      workerId: "worker-1", sameRunResumable: false,
    })).toBe("outcome_unknown");
    expect(store.getRequest("forge-result")?.state).toBe("outcome_unknown");
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'saratoga-join'").get())
      .toEqual({ state: "impossible" });

    expect(() => store.updateRequest({
      requestId: "forge-result", updateId: "forge-unauthorized-late", kind: "completed",
      actor: { kind: "agent", id: recipientA },
      payload: { text: "This matching recipient still lacks Run authorization." },
    })).toThrow("late result requires authorization from the original outcome-unknown run");
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_request_late_results").get())
      .toEqual({ count: 0 });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_late_result'
    `).get(requesterId)).toEqual({ count: 0 });

    const late = store.updateRequest({
      requestId: "forge-result", updateId: "forge-late-complete", kind: "completed",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: { runId: run.runId, agentId: recipientA, fencingToken: run.fencingToken },
      payload: { text: "Forge completed after the uncertain boundary.", canonicalHandoff: true },
    });
    expect(late).toEqual({ requestId: "forge-result", state: "outcome_unknown", version: 1, replayed: false });
    const runsBeforeReplay = opened.client.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get();
    expect(store.updateRequest({
      requestId: "forge-result", updateId: "forge-late-complete", kind: "completed",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: { runId: run.runId, agentId: recipientA, fencingToken: run.fencingToken },
      payload: { text: "Forge completed after the uncertain boundary.", canonicalHandoff: true },
    })).toMatchObject({ state: "outcome_unknown", replayed: true });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual(runsBeforeReplay);
    expect(opened.client.prepare("SELECT state, version FROM coordination_requests WHERE id = 'forge-result'").get())
      .toEqual({ state: "outcome_unknown", version: 1 });
    expect(opened.client.prepare("SELECT state FROM coordination_joins WHERE id = 'saratoga-join'").get())
      .toEqual({ state: "impossible" });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_request_late_results").get())
      .toEqual({ count: 1 });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_late_result'
    `).get(requesterId)).toEqual({ count: 1 });
    expect(store.requestForUpdate("forge-late-complete")).toMatchObject({
      id: "forge-result", state: "outcome_unknown",
    });
    const operationalItems = store.agentWorkItems({ projectId, agentId: requesterId }).items;
    expect(operationalItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "activation", title: "Late result needs audit" }),
    ]));
    const lateActivation = operationalItems.find((item) => item.title === "Late result needs audit")!;
    expect(store.agentWorkItemDetails({
      projectId, kind: "activation", recordId: lateActivation.recordId,
    })).toEqual(expect.arrayContaining([
      { label: "Kind", value: "coordination_late_result" },
      expect.objectContaining({ label: "Payload", value: expect.stringContaining("forge-result") }),
      expect.objectContaining({ label: "Payload", value: expect.stringContaining("do not redo") }),
    ]));
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
        replyAuthority: { intent: "direct_to_user" },
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
    const outcome = opened.client.prepare(`
      SELECT payload_json FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_outcome'
    `).get(requesterId) as { payload_json: string };
    expect(JSON.parse(outcome.payload_json)).toMatchObject({ replyAuthority: { intent: "direct_to_user" } });
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

  it("atomically fences an edited Activation behind its durable revision outbox", () => {
    const communication = userDmEvent({
      eventId: "queued-communication", agentId: recipientA, text: "old",
    });
    const intake = store.recordRuntimeCommunication({
      id: "queued-communication",
      projectId,
      sender: communication.sender,
      intent: communication.intent,
      audience: communication.audience,
      payload: {
        communication,
        dispatch: { text: "old" },
      },
      activation: { agentId: recipientA, kind: "human_message", priority: 100, dispatchPolicy: "next_run" },
    });
    for (const item of store.claimOutbox("signals")) store.completeOutbox(item.id, "signals");

    const first = store.editPendingActivationText({
      activationId: intake.activationId,
      projectId,
      requestText: "replacement",
      text: "Full message: ponderosa://artifact/replacement",
      document: { id: "replacement", createdAt: "first-attempt" },
      artifactId: "replacement",
      resultRef: "ponderosa://artifact/replacement",
      revisionOwnerId: "revision-1",
      revisionOutboxPayload: { revision: { eventId: "revision-1", text: "replacement" } },
      idempotencyKey: "edit-once",
    });
    expect(first).toMatchObject({ edited: true, replayed: false });
    expect(store.leaseNextRun({ workerId: "worker" })).toBeUndefined();

    const revision = store.claimOutbox("projector");
    expect(revision).toEqual([expect.objectContaining({
      activationId: intake.activationId,
      eventKind: "communication_revision",
      payload: { revision: { eventId: "revision-1", text: "replacement" } },
    })]);
    const replay = store.editPendingActivationText({
      activationId: intake.activationId,
      projectId,
      requestText: "replacement",
      text: "Full message: ponderosa://artifact/replacement",
      document: { id: "replacement", createdAt: "later-attempt" },
      artifactId: "replacement",
      resultRef: "ponderosa://artifact/replacement",
      revisionOwnerId: "revision-1",
      revisionOutboxPayload: { revision: { eventId: "revision-1", text: "replacement", createdAt: "later-attempt" } },
      idempotencyKey: "edit-once",
    });
    expect(replay).toMatchObject({ edited: true, replayed: true });
    store.completeOutbox(revision[0]!.id, "projector");
    expect(store.leaseNextRun({ workerId: "worker" })?.activationIds).toEqual([intake.activationId]);
  });

  it("backpressures new external intake without blocking idempotent replay", () => {
    store = new CoordinationV3Store(opened.client, { maxPendingActivationsPerAgent: 1 });
    const first = store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "bounded-1", kind: "ordinary", payload: { text: "one" },
    });
    expect(store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "bounded-1", kind: "ordinary", payload: { text: "one" },
    })).toBe(first);
    expect(() => store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "bounded-2", kind: "ordinary", payload: { text: "two" },
    })).toThrow("pending activation limit reached");
    expect(store.pendingActivations(projectId)).toHaveLength(1);
  });

  it("admits and deduplicates a server-owned continuation at ordinary intake capacity", () => {
    store = new CoordinationV3Store(opened.client, { maxPendingActivationsPerAgent: 1 });
    store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      messageId: "occupy-continuation-capacity",
      kind: "ordinary",
      payload: { text: "ordinary intake" },
    });
    const response = store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      messageId: "decision:resolved:response",
      kind: "human",
      payload: { decision: { id: "resolved", response: { text: "approved" } } },
      bypassCapacity: true,
    });
    expect(store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      messageId: "decision:resolved:response",
      kind: "human",
      payload: { decision: { id: "resolved", response: { text: "approved" } } },
      bypassCapacity: true,
    })).toBe(response);
    expect(store.pendingActivations(projectId)).toHaveLength(2);
  });

  it("dead-letters malformed and repeatedly failing outbox records", () => {
    store = new CoordinationV3Store(opened.client, { maxOutboxAttempts: 2 });
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "malformed", kind: "ordinary", payload: { text: "work" },
    });
    opened.client.prepare("UPDATE activation_outbox SET payload_json = '{' ").run();
    expect(store.claimOutbox("dispatcher", 10, "2026-07-15T00:00:01.000Z")).toEqual([]);
    expect(store.schedulerMetrics()).toMatchObject({ deadLetteredActivationOutbox: 1, pendingActivationOutbox: 0 });
    expect(store.claimOutbox("dispatcher", 10, "2026-07-15T00:01:00.000Z")).toEqual([]);
    opened.client.prepare("UPDATE agent_activations SET state = 'cancelled' WHERE agent_id = ?").run(recipientA);

    const secondActivation = store.enqueueMessageActivation({
      projectId, agentId: recipientB, messageId: "cancel-for-outbox", kind: "human", payload: { text: "work" },
    });
    expect(secondActivation).toBeTruthy();
    const lease = store.leaseNextRun({ workerId: "worker" })!;
    acknowledgeLease(lease);
    store.cancelAgentRun({
      agentId: recipientB,
      idempotencyKey: "cancel-for-outbox",
      now: "2026-07-15T00:00:00.000Z",
    });
    const first = store.claimProviderOperations("supervisor", 10, "2026-07-15T00:00:01.000Z")[0]!;
    store.failProviderOperation(first.id, "supervisor", "offline", 1, "2026-07-15T00:00:01.000Z");
    const second = store.claimProviderOperations("supervisor", 10, "2026-07-15T00:00:02.000Z")[0]!;
    store.failProviderOperation(second.id, "supervisor", "still offline", 1, "2026-07-15T00:00:02.000Z");
    expect(store.claimProviderOperations("supervisor", 10, "2026-07-15T00:00:03.000Z")).toEqual([]);
    expect(store.schedulerMetrics()).toMatchObject({ deadLetteredProviderOperations: 1, pendingProviderOperations: 0 });
  });

  it("prunes settled operational receipts to a bounded diagnostic tail", () => {
    for (let index = 0; index < 105; index += 1) {
      store.enqueueMessageActivation({
        projectId, agentId: recipientA, messageId: `settled-${index}`, kind: "ordinary", payload: { index },
      });
    }
    const outbox = store.claimOutbox("dispatcher", 200);
    expect(outbox).toHaveLength(105);
    for (const item of outbox) store.completeOutbox(item.id, "dispatcher");
    expect(store.pruneSettledOutboxes(100)).toEqual({ activationOutbox: 5, providerOperations: 0 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM activation_outbox").get()).toEqual({ count: 100 });
  });

  it("persists and deduplicates trigger occurrences without creating Runs", () => {
    createTrigger("github:push");
    const input = {
      triggerId: "github:push",
      occurrenceKey: "delivery-1",
      payload: { ref: "refs/heads/main" },
      provenance: { source: "github", deliveryId: "delivery-1" },
      now: "2026-07-15T00:00:00.000Z",
    };
    const first = store.recordTriggerOccurrence(input);
    expect(first).toMatchObject({ state: "activated", replayed: false, activationId: expect.any(String) });
    expect(store.recordTriggerOccurrence(input)).toEqual({ ...first, replayed: true });
    store.updateTriggerDefinition("github:push", { instructions: "Use the edited instructions" });
    expect(store.recordTriggerOccurrence({
      ...input,
      provenance: { source: "github", deliveryId: "delivery-1", remoteAddress: "127.0.0.2" },
      now: "2026-07-15T00:05:00.000Z",
    })).toEqual({ ...first, replayed: true });
    expect(store.getTriggerOccurrence(first.occurrenceId)?.triggerSnapshot).toMatchObject({
      instructions: "Handle this occurrence safely.",
    });
    expect(store.activeRunCount()).toBe(0);
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM trigger_occurrences").get()).toEqual({ count: 1 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM agent_activations").get()).toEqual({ count: 1 });
    expect(() => store.recordTriggerOccurrence({ ...input, payload: { ref: "different" } }))
      .toThrow("idempotency conflict");
  });

  it("retains burst occurrences and lets the scheduler batch only one Trigger", () => {
    createTrigger("filesystem:changed", "filesystem");
    createTrigger("filesystem:other", "filesystem");
    const base = {
      triggerId: "filesystem:changed",
      payload: { path: "src/app.ts" },
      provenance: { source: "filesystem", watcher: "workspace" },
    };
    expect(store.recordTriggerOccurrence({
      ...base, occurrenceKey: "change-1", now: "2026-07-15T00:00:00.000Z",
    }).state).toBe("activated");
    expect(store.recordTriggerOccurrence({
      ...base, occurrenceKey: "change-2", now: "2026-07-15T00:00:00.500Z",
    })).toMatchObject({ state: "activated", replayed: false });
    expect(opened.client.prepare(`
      SELECT state, provenance_json FROM trigger_occurrences ORDER BY occurred_at
    `).all()).toEqual([
      { state: "activated", provenance_json: '{"source":"filesystem","watcher":"workspace"}' },
      { state: "activated", provenance_json: '{"source":"filesystem","watcher":"workspace"}' },
    ]);
    store.recordTriggerOccurrence({
      triggerId: "filesystem:other", occurrenceKey: "other-1", payload: { path: "README.md" },
      provenance: { source: "filesystem", watcher: "workspace" }, now: "2026-07-15T00:00:00.750Z",
    });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM agent_activations").get()).toEqual({ count: 3 });
    const lease = store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:01.000Z" })!;
    expect(lease.activations).toHaveLength(2);
    expect(lease.activations.every((activation) => activation.kind === "trigger_occurrence")).toBe(true);
    expect(lease.activations.map((activation) => (activation.payload as { trigger: { id: string } }).trigger.id))
      .toEqual(["filesystem:changed", "filesystem:changed"]);
    expect(store.schedulerMetrics()).toMatchObject({ pendingActivations: 1 });
  });

  it("charges one budget unit per external Trigger Run, holds queued work, and resumes after allowance", () => {
    store.createTriggerDefinition({
      id: "budgeted", projectId, conversationId, agentId: recipientA,
      name: "Budgeted", instructions: "Handle every outside event.", sourceKind: "webhook",
      sourceConfig: { replayWindowSeconds: 300 }, runBudget: { limit: 1, period: "lifetime" },
      now: "2026-07-15T00:00:00.000Z",
    });
    for (const [index, at] of ["2026-07-15T00:00:00.100Z", "2026-07-15T00:00:00.200Z"].entries()) {
      store.recordTriggerOccurrence({
        triggerId: "budgeted", occurrenceKey: `batch-${index}`, payload: { index }, provenance: { source: "test" }, now: at,
      });
    }
    const batched = store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:01.000Z" })!;
    expect(batched.activations).toHaveLength(2);
    expect(store.getTriggerDefinition("budgeted")).toMatchObject({ budgetState: { used: 1, allowance: 0, held: true } });
    expect(store.failRun({
      runId: batched.runId,
      fencingToken: batched.fencingToken,
      workerId: "worker",
      sameRunResumable: false,
      confirmedNotExecuted: true,
      now: "2026-07-15T00:00:01.100Z",
      retryDelayMs: 1,
    })).toBe("retry");
    const retried = store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:01.101Z" })!;
    expect(retried.activationIds).toEqual(batched.activationIds);
    expect(store.getTriggerDefinition("budgeted")).toMatchObject({ budgetState: { used: 1, allowance: 0, held: true } });
    acknowledgeLease(retried);
    store.completeRun(retried.runId, retried.fencingToken, "2026-07-15T00:00:02.000Z");
    store.recordTriggerOccurrence({
      triggerId: "budgeted", occurrenceKey: "held", payload: { index: 3 }, provenance: { source: "test" }, now: "2026-07-15T00:00:03.000Z",
    });
    expect(store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:04.000Z" })).toBeUndefined();
    expect(store.allowTriggerRuns("budgeted", 2, "2026-07-15T00:00:05.000Z")).toMatchObject({ budgetState: { allowance: 2, held: false } });
    const resumed = store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:06.000Z" })!;
    expect(resumed.activations).toHaveLength(1);
    expect(store.getTriggerDefinition("budgeted")).toMatchObject({ budgetState: { used: 2, allowance: 2, held: false } });
  });

  it("backpressures Trigger occurrence intake at the configured pending capacity", () => {
    store = new CoordinationV3Store(opened.client, {
      maxPendingActivationsPerAgent: 1,
      maxPendingTriggerOccurrencesPerAgent: 1,
      maxTriggerAttempts: 2,
    });
    store.enqueueMessageActivation({
      projectId, agentId: recipientA, messageId: "occupy-capacity", kind: "ordinary", payload: {},
      now: "2026-07-15T00:00:00.000Z",
    });
    createTrigger("timer:tick", "schedule");
    const base = {
      triggerId: "timer:tick",
      payload: { task: "refresh" },
      provenance: { source: "timer" },
      retryDelayMs: 1,
    };
    expect(store.recordTriggerOccurrence({
      ...base, occurrenceKey: "tick-1", now: "2026-07-15T00:00:00.000Z",
    })).toMatchObject({ state: "pending" });
    expect(() => store.recordTriggerOccurrence({
      ...base, occurrenceKey: "tick-2", now: "2026-07-15T00:00:00.000Z",
    })).toThrow("pending trigger occurrence limit reached for Agent (1)");
    expect(store.processDueTriggerOccurrences("2026-07-15T00:00:00.002Z"))
      .toEqual({ activated: 0, pending: 1, deadLettered: 0 });
    expect(store.schedulerMetrics()).toMatchObject({
      pendingTriggerOccurrences: 1,
      deadLetteredTriggerOccurrences: 0,
      activeRuns: 0,
    });
    const occupying = store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:00.003Z" })!;
    acknowledgeLease(occupying);
    store.completeRun(occupying.runId, occupying.fencingToken, "2026-07-15T00:00:00.004Z");
    expect(store.processDueTriggerOccurrences("2026-07-15T00:00:00.005Z"))
      .toEqual({ activated: 1, pending: 0, deadLettered: 0 });
    const firstTriggerRun = store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:00.006Z" })!;
    acknowledgeLease(firstTriggerRun);
    store.completeRun(firstTriggerRun.runId, firstTriggerRun.fencingToken, "2026-07-15T00:00:00.007Z");
    expect(store.listTriggerOccurrences("timer:tick").every((occurrence) => occurrence.state === "activated")).toBe(true);
  });

  it("rejects excessively deep Trigger JSON deterministically without recursive overflow", () => {
    createTrigger("webhook:deep");
    let payload: unknown = "leaf";
    for (let depth = 0; depth < 100; depth += 1) payload = { nested: payload };
    expect(() => store.recordTriggerOccurrence({
      triggerId: "webhook:deep",
      occurrenceKey: "deep",
      payload,
      provenance: { source: "signed_webhook" },
    })).toThrow("canonical JSON exceeds maximum depth 64");
    expect(store.listTriggerOccurrences("webhook:deep")).toHaveLength(0);
  });

  it("rejects over-wide Trigger JSON before scheduling an unbounded canonicalization stack", () => {
    createTrigger("webhook:wide");
    expect(() => store.recordTriggerOccurrence({
      triggerId: "webhook:wide",
      occurrenceKey: "wide",
      payload: Array.from({ length: 250_001 }, () => 0),
      provenance: { source: "signed_webhook" },
    })).toThrow("canonical JSON exceeds 250000 nodes");
    expect(store.listTriggerOccurrences("webhook:wide")).toHaveLength(0);
  });

  it("cancels unstarted Trigger work on disable without deleting occurrence history", () => {
    createTrigger("webhook:disable");
    const occurrence = store.recordTriggerOccurrence({
      triggerId: "webhook:disable", occurrenceKey: "delivery", payload: { action: "sync" },
      provenance: { source: "signed_webhook" },
    });
    expect(occurrence.state).toBe("activated");
    expect(store.updateTriggerDefinition("webhook:disable", { enabled: false })).toMatchObject({ enabled: false });
    expect(store.getTriggerOccurrence(occurrence.occurrenceId)).toMatchObject({ state: "cancelled", payload: { action: "sync" } });
    expect(store.schedulerMetrics()).toMatchObject({ pendingActivations: 0 });
    expect(() => store.recordTriggerOccurrence({
      triggerId: "webhook:disable", occurrenceKey: "later", payload: {}, provenance: { source: "signed_webhook" },
    })).toThrow("disabled");
    expect(store.deleteTriggerDefinition("webhook:disable")).toBe(true);
    expect(store.getTriggerOccurrence(occurrence.occurrenceId)).toMatchObject({ state: "cancelled" });
  });

  it("fences an attached Trigger Run if the definition is disabled before injection", () => {
    createTrigger("webhook:fence");
    store.recordTriggerOccurrence({
      triggerId: "webhook:fence", occurrenceKey: "delivery", payload: {}, provenance: { source: "test" },
    });
    const lease = store.leaseNextRun({ workerId: "worker" })!;
    store.updateTriggerDefinition("webhook:fence", { enabled: false });
    expect(() => store.markPromptSubmitted({
      injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
    })).toThrow("stale run fencing token");
    expect(opened.client.prepare(`SELECT status, prompt_injection_state FROM scheduler_runs WHERE id = ?`).get(lease.runId))
      .toEqual({ status: "cancelled", prompt_injection_state: "not_injected" });
    expect(store.getTriggerOccurrence(
      (lease.activations[0]!.payload as { occurrence: { id: string } }).occurrence.id,
    )).toMatchObject({ state: "cancelled" });
    expect(store.leaseNextRun({ workerId: "worker-2" })).toBeUndefined();
    expect(store.schedulerMetrics()).toMatchObject({ pendingActivations: 0, activeRuns: 0 });
  });

  it("durably rolls one provider generation into one fresh continuation while retaining new work", () => {
    const now = "2026-08-01T12:00:00.000Z";
    store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      scopeKey: `conversation:${conversationId}`,
      messageId: "rollover-source",
      kind: "ordinary",
      payload: {
        text: "Long autonomous task",
        replyAuthority: { intent: "direct_to_user" },
      },
      now,
    });
    const sourceRun = store.leaseNextRun({ workerId: "source-worker", now })!;
    acknowledgeLease(sourceRun);

    const requested = store.requestContextRollover({
      projectId,
      agentId: recipientA,
      oldProviderSessionId: "old-session",
      providerSessionGeneration: "old-session:generation-1",
      detectedOccupancy: 80_000,
      aggregateTokens: 10_193_417,
      threshold: 75_000,
      contextWindow: 200_000,
      lowWaterMark: 45_000,
      sourceRunId: sourceRun.runId,
      sourceActivationIds: sourceRun.activationIds,
      scopeKey: `conversation:${conversationId}`,
      conversationId,
      replyAuthority: { intent: "direct_to_user" },
      now,
    });
    store = new CoordinationV3Store(opened.client);
    const replay = store.requestContextRollover({
      projectId,
      agentId: recipientA,
      oldProviderSessionId: "old-session",
      providerSessionGeneration: "old-session:generation-1",
      detectedOccupancy: 90_000,
      threshold: 75_000,
      lowWaterMark: 45_000,
      sourceRunId: sourceRun.runId,
      sourceActivationIds: sourceRun.activationIds,
      scopeKey: `conversation:${conversationId}`,
      conversationId,
      now,
    });
    expect(requested.created).toBe(true);
    expect(replay).toMatchObject({ created: false, rollover: { id: requested.rollover.id } });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get()).toEqual({ count: 1 });

    const pendingUserActivation = store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      scopeKey: `conversation:${conversationId}`,
      messageId: "arrived-during-rollover",
      kind: "human",
      payload: { text: "Also include the latest change" },
      now: "2026-08-01T12:00:01.000Z",
    });
    const crossChatUserActivation = store.enqueueMessageActivation({
      projectId,
      agentId: recipientA,
      scopeKey: "conversation:another-chat",
      messageId: "arrived-in-another-chat-during-rollover",
      kind: "human",
      payload: { text: "Separate chat work must stay queued" },
      now: "2026-08-01T12:00:01.000Z",
    });
    const steering = store.leaseNextSteering({ workerId: "source-worker", now: "2026-08-01T12:00:02.000Z" })!;
    expect(steering.activations).toHaveLength(1);
    expect(steering.activations[0]).toMatchObject({ kind: "context_rollover_handoff" });
    expect(steering.activationIds).not.toContain(pendingUserActivation);
    store.preparePromptInjection({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
      prompt: "Create the bounded handoff",
    });
    store.markPromptSubmitted({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
    });
    store.acknowledgePromptInjection({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
    });

    store.commitContextRolloverHandoff(requested.rollover.id, "handoff-event", "2026-08-01T12:00:03.000Z");
    store = new CoordinationV3Store(opened.client);
    expect(store.commitContextRolloverHandoff(
      requested.rollover.id,
      "handoff-event",
      "2026-08-01T12:00:03.500Z",
    ).handoffCommittedAt).toBe("2026-08-01T12:00:03.000Z");
    store.completeRun(sourceRun.runId, sourceRun.fencingToken, "2026-08-01T12:00:04.000Z");
    store.beginContextRolloverRetirement(requested.rollover.id, "2026-08-01T12:00:05.000Z");

    // Recreate the authority facade to model process recovery between durable
    // transitions. Repeating the continuation transition must not duplicate it.
    store = new CoordinationV3Store(opened.client);
    const continuation = store.prepareContextRolloverContinuation({
      id: requested.rollover.id,
      visibleResponseCommitted: false,
      now: "2026-08-01T12:00:06.000Z",
    });
    expect(store.prepareContextRolloverContinuation({
      id: requested.rollover.id,
      visibleResponseCommitted: false,
      now: "2026-08-01T12:00:07.000Z",
    }).continuationActivationId).toBe(continuation.continuationActivationId);
    expect(continuation).toMatchObject({
      state: "continuation_ready",
      conversationId,
      replyAuthority: { intent: "direct_to_user" },
      aggregateTokens: 10_193_417,
    });

    const freshRun = store.leaseNextRun({ workerId: "fresh-worker", now: "2026-08-01T12:00:08.000Z" })!;
    expect(freshRun.activationIds).toEqual(expect.arrayContaining([
      continuation.continuationActivationId!,
      pendingUserActivation,
    ]));
    expect(freshRun.activationIds).not.toContain(crossChatUserActivation);
    const continuationPayload = freshRun.activations.find(
      (activation) => activation.kind === "context_rollover_continuation",
    )?.payload;
    expect(continuationPayload).toMatchObject({
      rolloverId: requested.rollover.id,
      replyAuthority: { intent: "direct_to_user" },
    });
    store.recordContextRolloverReplacementSession(
      continuation.continuationActivationId!,
      "fresh-session",
      "2026-08-01T12:00:09.000Z",
    );
    store = new CoordinationV3Store(opened.client);
    expect(store.observeContextRolloverReplacementOccupancy(
      requested.rollover.id,
      "fresh-session",
      20_000,
      "2026-08-01T12:00:10.000Z",
    )).toMatchObject({ state: "completed", replacementSessionId: "fresh-session" });
  });

  it("transfers one managed Request and Join through rollover without replaying its source Activation", () => {
    const now = "2026-08-01T13:00:00.000Z";
    store.coordinate({
      projectId,
      requesterAgentId: requesterId,
      actorScope: `agent:${requesterId}`,
      idempotencyKey: "rollover-managed-request",
      requests: [{
        requestId: "rollover-owned-request",
        recipientAgentId: recipientA,
        lifetime: indefinite,
        payload: { assignment: "Finish the managed work after refreshing context" },
      }],
      join: { id: "rollover-owned-join", mode: "all" },
    }, now);
    const sourceRun = store.leaseNextRun({ workerId: "source-worker", now })!;
    acknowledgeLease(sourceRun);
    expect(store.requestIdsAttachedToRun(sourceRun.runId, recipientA))
      .toEqual(["rollover-owned-request"]);

    const rollover = store.requestContextRollover({
      projectId,
      agentId: recipientA,
      oldProviderSessionId: "managed-old-session",
      providerSessionGeneration: "managed-generation",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 45_000,
      sourceRunId: sourceRun.runId,
      sourceActivationIds: sourceRun.activationIds,
      scopeKey: `conversation:${conversationId}`,
      conversationId,
    }).rollover;
    store.commitContextRolloverHandoff(rollover.id, "managed-handoff");
    // A crash can settle the source Run after the handoff commit but before
    // continuation creation. The durable rollover already owns the lineage,
    // so recovery must not orphan the Request in that interval.
    store.completeRun(sourceRun.runId, sourceRun.fencingToken);
    expect(store.getRequest("rollover-owned-request")?.state).toBe("open");
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE request_id = 'rollover-owned-request' AND kind = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });
    store.beginContextRolloverRetirement(rollover.id);
    const continuation = store.prepareContextRolloverContinuation({
      id: rollover.id,
      visibleResponseCommitted: false,
    });

    const replacementRun = store.leaseNextRun({ workerId: "replacement-worker" })!;
    expect(replacementRun.activationIds).toEqual([continuation.continuationActivationId]);
    expect(replacementRun.activationIds).not.toEqual(expect.arrayContaining(sourceRun.activationIds));
    expect(store.requestIdsAttachedToRun(replacementRun.runId, recipientA))
      .toEqual(["rollover-owned-request"]);
    expect(store.contextRolloverForContinuationRun(replacementRun.runId, recipientA))
      .toMatchObject({ id: rollover.id, continuationActivationId: continuation.continuationActivationId });
    acknowledgeLease(replacementRun);
    const completed = store.updateRequest({
      requestId: "rollover-owned-request",
      updateId: "rollover-owned-result",
      kind: "completed",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: {
        runId: replacementRun.runId,
        agentId: recipientA,
        fencingToken: replacementRun.fencingToken,
      },
      payload: { text: "Managed result committed once" },
    });
    expect(completed).toMatchObject({ state: "completed", replayed: false });
    expect(store.updateRequest({
      requestId: "rollover-owned-request",
      updateId: "rollover-owned-result",
      kind: "completed",
      actor: { kind: "agent", id: recipientA },
      runAuthorization: {
        runId: replacementRun.runId,
        agentId: recipientA,
        fencingToken: replacementRun.fencingToken,
      },
      payload: { text: "Managed result committed once" },
    })).toMatchObject({ state: "completed", replayed: true });
    store.completeRun(replacementRun.runId, replacementRun.fencingToken);
    expect(store.getRequest("rollover-owned-request")?.state).toBe("completed");
    expect(opened.client.prepare(`
      SELECT state FROM coordination_joins WHERE id = 'rollover-owned-join'
    `).get()).toEqual({ state: "satisfied" });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE request_id = 'rollover-owned-request' AND kind = 'completed'
    `).get()).toEqual({ count: 1 });
  });

  it("cancels an unclaimed manual handoff request and leases only the fresh continuation", () => {
    const rollover = store.requestContextRollover({
      projectId,
      agentId: recipientA,
      oldProviderSessionId: "manual-old-session",
      providerSessionGeneration: "manual-generation",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 45_000,
      sourceRunId: "manual-source-run",
      sourceActivationIds: [],
      scopeKey: `conversation:${conversationId}`,
      conversationId,
    }).rollover;
    expect(opened.client.prepare(`
      SELECT state FROM agent_activations
      WHERE kind = 'context_rollover_handoff' AND id IN (
        SELECT activation_id FROM activation_sources
        WHERE source_kind = 'context_rollover' AND source_id = ?
      )
    `).get(rollover.id)).toEqual({ state: "pending" });

    store.commitContextRolloverHandoff(rollover.id, "manual-handoff");
    expect(opened.client.prepare(`
      SELECT state FROM agent_activations
      WHERE kind = 'context_rollover_handoff' AND id IN (
        SELECT activation_id FROM activation_sources
        WHERE source_kind = 'context_rollover' AND source_id = ?
      )
    `).get(rollover.id)).toEqual({ state: "cancelled" });
    store.beginContextRolloverRetirement(rollover.id);
    const continuation = store.prepareContextRolloverContinuation({
      id: rollover.id,
      visibleResponseCommitted: false,
    });
    const replacementRun = store.leaseNextRun({ workerId: "replacement-worker" })!;
    expect(replacementRun.activationIds).toEqual([continuation.continuationActivationId]);
    expect(replacementRun.activations.map((activation) => activation.kind))
      .toEqual(["context_rollover_continuation"]);
  });

  it("allows a controlled retry after terminal handoff failure but not after seed overflow", () => {
    const input = {
      projectId,
      agentId: recipientA,
      oldProviderSessionId: "retry-session",
      providerSessionGeneration: "retry-generation",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 45_000,
      sourceRunId: "retry-source-one",
      sourceActivationIds: [],
      scopeKey: `conversation:${conversationId}`,
      conversationId,
    };
    const first = store.requestContextRollover(input);
    store.failContextRollover(first.rollover.id, "failed", "provider ended before handoff");
    const retry = store.requestContextRollover({
      ...input,
      sourceRunId: "retry-source-two",
    });
    expect(retry).toMatchObject({ created: true, rollover: { sourceRunId: "retry-source-two" } });
    expect(retry.rollover.id).not.toBe(first.rollover.id);
    store.failContextRollover(
      retry.rollover.id,
      "failed",
      "rollover_seed_overflow: reconstructed seed is too large",
    );
    expect(store.requestContextRollover({
      ...input,
      sourceRunId: "retry-source-three",
    })).toMatchObject({ created: false, rollover: { id: retry.rollover.id } });
  });

  it("terminalizes and purges every active context rollover during Project deletion", () => {
    const fourthAgent = randomUUID();
    opened.client.prepare(`
      INSERT INTO agents (id, project_id, title, active_engine, created_at, updated_at, archived)
      VALUES (?, ?, 'D', 'codex', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 0)
    `).run(fourthAgent, projectId);
    const agents = [requesterId, recipientA, recipientB, fourthAgent];
    const rollovers = agents.map((agentId, index) => store.requestContextRollover({
      projectId,
      agentId,
      oldProviderSessionId: `delete-session-${index}`,
      providerSessionGeneration: `delete-generation-${index}`,
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 45_000,
      sourceRunId: `delete-source-${index}`,
      sourceActivationIds: [],
      scopeKey: `conversation:${conversationId}`,
      conversationId,
    }).rollover);
    store.commitContextRolloverHandoff(rollovers[1]!.id, "delete-handoff-1");
    store.commitContextRolloverHandoff(rollovers[2]!.id, "delete-handoff-2");
    store.beginContextRolloverRetirement(rollovers[2]!.id);
    store.commitContextRolloverHandoff(rollovers[3]!.id, "delete-handoff-3");
    store.beginContextRolloverRetirement(rollovers[3]!.id);
    store.prepareContextRolloverContinuation({
      id: rollovers[3]!.id,
      visibleResponseCommitted: false,
    });
    expect(store.activeContextRollovers(projectId).map((rollover) => rollover.state).sort())
      .toEqual(["continuation_ready", "handoff_committed", "requested", "session_retiring"]);

    store.prepareProjectDeletion(projectId, "2026-08-01T01:00:00.000Z");
    expect(store.activeContextRollovers(projectId)).toEqual([]);
    expect(opened.client.prepare(`
      SELECT state, last_error AS lastError FROM context_rollovers
      WHERE project_id = ? ORDER BY state, id
    `).all(projectId)).toHaveLength(4);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM context_rollovers
      WHERE project_id = ? AND state = 'failed'
        AND last_error = 'project deletion fenced context rollover'
    `).get(projectId)).toEqual({ count: 4 });

    store.purgeProject(projectId);
    store = new CoordinationV3Store(opened.client);
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM context_rollovers WHERE project_id = ?
    `).get(projectId)).toEqual({ count: 0 });
    expect(store.activeContextRollovers(projectId)).toEqual([]);
    expect(store.leaseNextRun({ workerId: "after-delete" })).toBeUndefined();
  });

  it("suppresses duplicate continuation after a visible response and terminalizes seed overflow without a loop", () => {
    const createRollover = (generation: string, runId: string, visibleResponseCommitted = false) => store.requestContextRollover({
      projectId,
      agentId: recipientA,
      oldProviderSessionId: generation,
      providerSessionGeneration: generation,
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 45_000,
      sourceRunId: runId,
      sourceActivationIds: [],
      scopeKey: `conversation:${conversationId}`,
      conversationId,
      visibleResponseCommitted,
    }).rollover;

    const completed = createRollover("generation-completed", "run-completed", true);
    store.commitContextRolloverHandoff(completed.id, "completed-handoff");
    store.beginContextRolloverRetirement(completed.id);
    expect(store.prepareContextRolloverContinuation({
      id: completed.id,
      visibleResponseCommitted: false,
    })).toMatchObject({ state: "completed", visibleResponseCommitted: true });
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations activation
      JOIN activation_sources source ON source.activation_id = activation.id
      WHERE activation.kind = 'context_rollover_continuation'
        AND source.source_kind = 'context_rollover' AND source.source_id = ?
    `).get(completed.id)).toEqual({ count: 0 });

    const overflow = createRollover("generation-overflow", "run-overflow");
    store.commitContextRolloverHandoff(overflow.id, "overflow-handoff");
    store.beginContextRolloverRetirement(overflow.id);
    const ready = store.prepareContextRolloverContinuation({ id: overflow.id, visibleResponseCommitted: false });
    const firstReplacement = store.recordContextRolloverReplacementSession(
      ready.continuationActivationId!,
      "overflow-session",
      "2026-08-01T12:30:00.000Z",
    );
    expect(store.recordContextRolloverReplacementSession(
      ready.continuationActivationId!,
      "overflow-session",
      "2026-08-01T12:31:00.000Z",
    )).toMatchObject({
      replacementSessionId: "overflow-session",
      replacementSessionAt: firstReplacement?.replacementSessionAt,
    });
    expect(() => store.recordContextRolloverReplacementSession(
      ready.continuationActivationId!,
      "conflicting-session",
    )).toThrow("context rollover replacement session conflict");
    expect(store.contextRollover(overflow.id)).toMatchObject({
      replacementSessionId: "overflow-session",
      replacementSessionAt: "2026-08-01T12:30:00.000Z",
    });
    expect(store.observeContextRolloverReplacementOccupancy(
      overflow.id,
      "overflow-session",
      60_000,
    )).toMatchObject({
      state: "failed",
      lastError: expect.stringContaining("rollover_seed_overflow"),
    });
    expect(store.contextRolloverForReplacementSession(recipientA, "overflow-session"))
      .toMatchObject({ id: overflow.id, state: "failed" });

    const noEquivalentOccupancy = store.requestContextRollover({
      projectId,
      agentId: recipientA,
      oldProviderSessionId: "claude-session",
      providerSessionGeneration: "claude-session",
      detectedOccupancy: 0,
      threshold: 75_000,
      lowWaterMark: 45_000,
      lowWaterConfirmationRequired: false,
      sourceRunId: "run-manual-claude",
      sourceActivationIds: [],
      scopeKey: `conversation:${conversationId}`,
      conversationId,
    }).rollover;
    store.commitContextRolloverHandoff(noEquivalentOccupancy.id, "claude-handoff");
    store.beginContextRolloverRetirement(noEquivalentOccupancy.id);
    const claudeReady = store.prepareContextRolloverContinuation({
      id: noEquivalentOccupancy.id,
      visibleResponseCommitted: false,
    });
    expect(store.recordContextRolloverReplacementSession(
      claudeReady.continuationActivationId!,
      "claude-fresh-session",
    )).toMatchObject({
      state: "completed",
      lowWaterConfirmationRequired: false,
      replacementSessionId: "claude-fresh-session",
    });
    expect(store.activeContextRollover(recipientA)).toBeUndefined();
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get()).toEqual({ count: 3 });
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
