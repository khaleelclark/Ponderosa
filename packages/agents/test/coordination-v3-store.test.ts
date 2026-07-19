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
    expect([...first, ...second].every((item) => item.createdAt === tiedAt)).toBe(true);
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
        reserveCommunication: () => undefined,
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
        reserveCommunication: () => undefined,
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
    const oversized = Array.from({ length: 4 }, (_, index) => {
      const item = runtimeAttachment(recipientA, {
        id: randomUUID(), name: `oversized-${index}.pdf`, size: 8 * 1024 * 1024,
      });
      register(projectId, recipientA, item);
      return item;
    });
    const overCount = Array.from({ length: 5 }, (_, index) => runtimeAttachment(recipientA, {
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
        reserveCommunication: () => undefined,
      },
    });
    const snapshot = (attachment: import("@ponderosa/core").AssetDto) => ({
      id: attachment.id, name: attachment.name, mediaType: attachment.mediaType,
      size: attachment.size, sha256: attachment.sha256,
    });
    const communicationInput = (id: string, attachments: import("@ponderosa/core").AssetDto[]) => {
      const communication: CommunicationEvent = {
        eventId: id, schemaVersion: 2, projectId, conversationId,
        sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
        audience: { kind: "user_agents", userId: "local-operator", agentIds: [recipientA, recipientB] },
        text: "Bounded multi-recipient intake", attachments,
        createdAt: "2026-07-15T00:00:00.000Z",
      };
      return {
        id, projectId, sender: communication.sender, intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication,
          dispatch: {
            text: communication.text,
            recipients: attachments.map((attachment) => ({
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
    expect([...calls.values()]).toEqual([1, 1]);
    const persisted = store.runtimeCommunication("bounded-resolver-work")!.payload as {
      dispatch: { recipients: Array<{ attachments: Array<{ sha256: string; localPath: string }> }> };
    };
    expect(persisted.dispatch.recipients.flatMap((recipient) => recipient.attachments))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sha256: first.sha256, localPath: expect.stringContaining(first.id) }),
        expect.objectContaining({ sha256: second.sha256, localPath: expect.stringContaining(second.id) }),
      ]));

    const overCount = [
      register(recipientA), register(recipientA), register(recipientA),
      register(recipientB), register(recipientB),
    ];
    const before = runtimeMutationState();
    expect(() => store.recordRuntimeCommunication(communicationInput("global-cross-owner-count", overCount)))
      .toThrow("runtime communication attachments are invalid");
    expect(runtimeMutationState()).toEqual(before);

    const overBytes = [
      register(recipientA, DEFAULT_ASSET_LIMITS.maxFileBytes),
      register(recipientA, DEFAULT_ASSET_LIMITS.maxFileBytes),
      register(recipientB, DEFAULT_ASSET_LIMITS.maxFileBytes),
      register(recipientB, DEFAULT_ASSET_LIMITS.maxFileBytes),
    ];
    expect(() => store.recordRuntimeCommunication(communicationInput("global-cross-owner-bytes", overBytes)))
      .toThrow("runtime communication attachments are invalid");
    expect(runtimeMutationState()).toEqual(before);

    const sharedId = randomUUID();
    const ownerA = register(recipientA, 64, sharedId);
    register(recipientB, 65, sharedId);
    const contradictory = communicationInput("cross-owner-one-id", [ownerA]);
    (contradictory.payload.dispatch.recipients as Array<{ agentId: string; attachments: unknown[] }>)[0] = {
      agentId: recipientB, attachments: [{ ...snapshot(ownerA), size: 65 }],
    };
    expect(() => store.recordRuntimeCommunication(contradictory))
      .toThrow(/attachment (authority mismatch|identity conflicts)/);
    expect(runtimeMutationState()).toEqual(before);
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
    acknowledgeLease(batched);
    store.completeRun(batched.runId, batched.fencingToken, "2026-07-15T00:00:02.000Z");
    store.recordTriggerOccurrence({
      triggerId: "budgeted", occurrenceKey: "held", payload: { index: 3 }, provenance: { source: "test" }, now: "2026-07-15T00:00:03.000Z",
    });
    expect(store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:04.000Z" })).toBeUndefined();
    expect(store.allowTriggerRuns("budgeted", 2, "2026-07-15T00:00:05.000Z")).toMatchObject({ budgetState: { allowance: 2, held: false } });
    const resumed = store.leaseNextRun({ workerId: "worker", now: "2026-07-15T00:00:06.000Z" })!;
    expect(resumed.activations).toHaveLength(1);
    expect(store.getTriggerDefinition("budgeted")).toMatchObject({ budgetState: { used: 2, allowance: 2, held: false } });
  });

  it("bounds trigger backpressure, retries, and pending intake", () => {
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
    expect(store.recordTriggerOccurrence({
      ...base, occurrenceKey: "tick-2", now: "2026-07-15T00:00:00.000Z",
    })).toMatchObject({ state: "dead_lettered" });
    expect(store.processDueTriggerOccurrences("2026-07-15T00:00:00.002Z"))
      .toEqual({ activated: 0, pending: 0, deadLettered: 1 });
    expect(store.schedulerMetrics()).toMatchObject({
      pendingTriggerOccurrences: 0,
      deadLetteredTriggerOccurrences: 2,
      activeRuns: 0,
    });
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
