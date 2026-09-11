import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-replay-"));
  const store = new AgentStore(directory);
  const coordination = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const conversation = store.createConversation(project.id, { title: "Chat" });
  const requester = store.createAgent(project.id, {
    title: "Requester",
    engine: "codex",
    conversationId: conversation.id,
  });
  const recipient = store.createAgent(project.id, {
    title: "Recipient",
    engine: "codex",
    conversationId: conversation.id,
  });
  return {
    store,
    coordination,
    project,
    conversation,
    requester,
    recipient,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("coordinate replay ignores later server-derived continuation context and recipient state", () => {
  const context = fixture();
  try {
    const input = {
      projectId: context.project.id,
      conversationId: context.conversation.id,
      requesterAgentId: context.requester.id,
      actorScope: "user:local-operator",
      idempotencyKey: "coordinate-once",
      requests: [{
        requestId: "request-a",
        recipientAgentId: context.recipient.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "work" },
      }],
      join: { id: "join-a", mode: "all" },
    };
    const first = context.coordination.coordinate(input);
    context.store.updateAgent(context.recipient.id, { archived: true });
    const replay = context.coordination.replayCoordinate({
      ...input,
      join: { ...input.join, continuationRequestIds: ["request-a"] },
    });
    assert.equal(first.replayed, false);
    assert.equal(replay?.replayed, true);
    assert.deepEqual(replay?.requestIds, first.requestIds);
  } finally {
    context.close();
  }
});

test("request update replay and retry identity survive later mutable state", () => {
  const context = fixture();
  try {
    context.coordination.coordinate({
      projectId: context.project.id,
      conversationId: context.conversation.id,
      requesterAgentId: context.requester.id,
      actorScope: "user:local-operator",
      idempotencyKey: "request-once",
      requests: [{
        requestId: "request-original",
        recipientAgentId: context.recipient.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "work" },
      }],
    });
    const update = {
      requestId: "request-original",
      updateId: "cancel-once",
      kind: "cancelled",
      actor: { kind: "user", id: "local-operator" },
      payload: { reason: "stop" },
    };
    context.coordination.updateRequest(update);
    context.store.updateAgent(context.recipient.id, { archived: true });
    assert.equal(context.coordination.replayRequestUpdate(update)?.replayed, true);

    context.store.sqlite.prepare(`
      INSERT INTO coordination_requests (
        id, project_id, conversation_id, requester_agent_id, recipient_agent_id,
        payload_json, state, version, lifetime_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '{}', 'failed', 0, 'indefinite', ?, ?)
    `).run(
      "request-successor",
      context.project.id,
      context.conversation.id,
      context.requester.id,
      context.recipient.id,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    context.store.sqlite.prepare(
      "UPDATE coordination_requests SET superseded_by_request_id = ? WHERE id = ?",
    ).run("request-successor", "request-original");
    assert.deepEqual(context.coordination.requestRetryStatus("request-original"), {
      successorRequestId: "request-successor",
      successorState: "failed",
    });
  } finally {
    context.close();
  }
});

test("delivery retry has a read-only replay boundary", () => {
  const context = fixture();
  try {
    const now = "2026-09-09T12:00:00.000Z";
    const communication = {
      eventId: "retry-message",
      schemaVersion: 2,
      projectId: context.project.id,
      conversationId: context.conversation.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "user_dm",
      audience: {
        kind: "user_agent",
        userId: "local-operator",
        agentId: context.recipient.id,
      },
      text: "retry me",
      createdAt: now,
    };
    const recorded = context.coordination.recordRuntimeCommunication({
      id: communication.eventId,
      projectId: context.project.id,
      sender: communication.sender,
      intent: communication.intent,
      audience: communication.audience,
      payload: {
        communication,
        dispatch: {
          conversationId: context.conversation.id,
          text: communication.text,
          activeRunDelivery: "steer",
          recipients: [{ agentId: context.recipient.id, attachments: [] }],
        },
      },
      activation: {
        agentId: context.recipient.id,
        kind: "human_message",
        priority: 100,
        dispatchPolicy: "steer_or_run",
        promptClass: "human",
      },
      now,
    });
    context.store.sqlite.prepare(
      "UPDATE agent_activations SET state = 'failed' WHERE id = ?",
    ).run(recorded.activationId);
    const input = {
      projectId: context.project.id,
      activationId: recorded.activationId,
      idempotencyKey: "retry-once",
      now,
    };
    const first = context.coordination.retryMessageDelivery(input);
    assert.equal(first.accepted, true);
    assert.equal(first.replayed, false);
    assert.deepEqual(
      context.coordination.replayRetryMessageDelivery(input),
      { ...first, replayed: true },
    );
    assert.equal(
      context.coordination.replayRetryMessageDelivery({
        ...input,
        idempotencyKey: "not-recorded",
      }),
      undefined,
    );
  } finally {
    context.close();
  }
});

test("terminal request update replay survives the Run side-effect fence it created", () => {
  const context = fixture();
  try {
    context.coordination.coordinate({
      projectId: context.project.id,
      conversationId: context.conversation.id,
      requesterAgentId: context.requester.id,
      actorScope: "user:local-operator",
      idempotencyKey: "terminal-request",
      requests: [{
        requestId: "request-terminal",
        recipientAgentId: context.recipient.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "work" },
      }],
    });
    const lease = context.coordination.leaseNextRun({ workerId: "worker-a" });
    assert.ok(lease);
    assert.equal(lease.agentId, context.recipient.id);
    const update = {
      requestId: "request-terminal",
      updateId: "terminal-result",
      kind: "completed",
      actor: { kind: "agent", id: context.recipient.id },
      runAuthorization: {
        runId: lease.runId,
        agentId: lease.agentId,
        fencingToken: lease.fencingToken,
      },
      payload: { text: "done", executionId: lease.runId },
    };
    assert.equal(context.coordination.updateRequest(update).replayed, false);
    assert.ok(context.store.sqlite.prepare(
      "SELECT side_effects_fenced_at fencedAt FROM scheduler_runs WHERE id = ?",
    ).get(lease.runId).fencedAt);
    assert.equal(context.coordination.replayRequestUpdate(update)?.replayed, true);
  } finally {
    context.close();
  }
});

test("coordinate replay survives a later Run side-effect fence", () => {
  const context = fixture();
  try {
    context.coordination.coordinate({
      projectId: context.project.id,
      conversationId: context.conversation.id,
      requesterAgentId: context.requester.id,
      actorScope: "user:local-operator",
      idempotencyKey: "parent-request",
      requests: [{
        requestId: "request-parent",
        recipientAgentId: context.recipient.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "work" },
      }],
    });
    const lease = context.coordination.leaseNextRun({ workerId: "worker-a" });
    assert.ok(lease);
    const authorization = {
      runId: lease.runId,
      agentId: lease.agentId,
      fencingToken: lease.fencingToken,
    };
    const input = {
      projectId: context.project.id,
      conversationId: context.conversation.id,
      requesterAgentId: context.recipient.id,
      actorScope: `agent:${context.recipient.id}:run:${lease.runId}`,
      idempotencyKey: "child-request",
      runAuthorization: authorization,
      requests: [{
        requestId: "request-child",
        recipientAgentId: context.requester.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "child work" },
      }],
    };
    assert.equal(context.coordination.coordinate(input).replayed, false);
    context.coordination.updateRequest({
      requestId: "request-parent",
      updateId: "parent-result",
      kind: "completed",
      actor: { kind: "agent", id: context.recipient.id },
      runAuthorization: authorization,
      payload: { text: "done", executionId: lease.runId },
    });
    assert.equal(context.coordination.coordinate(input).replayed, true);
    assert.equal(context.coordination.replayCoordinate(input)?.replayed, true);
  } finally {
    context.close();
  }
});

test("delivery receipts project the exact execution reached by their activation", () => {
  const context = fixture();
  try {
    const now = "2026-09-09T12:00:00.000Z";
    const communication = {
      eventId: "communication-exact-run",
      schemaVersion: 2,
      projectId: context.project.id,
      conversationId: context.conversation.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "user_dm",
      audience: {
        kind: "user_agent",
        userId: "local-operator",
        agentId: context.recipient.id,
      },
      text: "work",
      createdAt: now,
    };
    context.coordination.recordRuntimeCommunication({
      id: communication.eventId,
      projectId: context.project.id,
      sender: communication.sender,
      intent: communication.intent,
      audience: communication.audience,
      payload: {
        communication,
        dispatch: {
          conversationId: context.conversation.id,
          text: communication.text,
          activeRunDelivery: "steer",
          recipients: [{ agentId: context.recipient.id, attachments: [] }],
        },
      },
      activation: {
        agentId: context.recipient.id,
        kind: "human_message",
        priority: 100,
        dispatchPolicy: "steer_or_run",
        promptClass: "human",
      },
      now,
    });
    const lease = context.coordination.leaseNextRun({
      workerId: "worker-a",
      now,
    });
    assert.ok(lease);
    context.coordination.markRunStarted(lease.runId, lease.fencingToken, now);
    context.coordination.recordProviderInput({
      executionId: "execution-exact",
      schedulerRunId: lease.runId,
      fencingToken: lease.fencingToken,
      agentId: context.recipient.id,
      projectId: context.project.id,
      prompt: "work",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: lease.activationIds,
        communicationEventIds: [communication.eventId],
        artifactIds: [],
        conversationId: context.conversation.id,
        providerSessionDisposition: "fresh_task",
        sources: [],
      },
      now,
    });
    context.coordination.preparePromptInjection({
      injectionId: lease.injectionId,
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      prompt: "work",
      now,
    });
    context.coordination.markPromptSubmitted({
      injectionId: lease.injectionId,
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      now,
    });
    assert.deepEqual(
      context.coordination.deliveryReceiptsForCommunication(
        context.project.id,
        communication.eventId,
      ).map(receipt => ({
        activationId: receipt.activationId,
        executionId: receipt.executionId,
        state: receipt.state,
      })),
      [{
        activationId: lease.activationIds[0],
        executionId: "execution-exact",
        state: "started",
      }],
    );
  } finally {
    context.close();
  }
});

test("steering recovery receipts preserve original and exact recovery executions", () => {
  const context = fixture();
  try {
    const communication = (eventId, text, now) => ({
      eventId,
      schemaVersion: 2,
      projectId: context.project.id,
      conversationId: context.conversation.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "user_dm",
      audience: {
        kind: "user_agent",
        userId: "local-operator",
        agentId: context.recipient.id,
      },
      text,
      createdAt: now,
    });
    const record = (message, dispatchPolicy) =>
      context.coordination.recordRuntimeCommunication({
        id: message.eventId,
        projectId: context.project.id,
        sender: message.sender,
        intent: message.intent,
        audience: message.audience,
        payload: {
          communication: message,
          dispatch: {
            conversationId: context.conversation.id,
            text: message.text,
            activeRunDelivery: "steer",
            recipients: [{ agentId: context.recipient.id, attachments: [] }],
          },
        },
        activation: {
          agentId: context.recipient.id,
          kind: "human_message",
          priority: 100,
          dispatchPolicy,
          promptClass: "human",
        },
        now: message.createdAt,
      });
    const base = communication(
      "communication-base-run",
      "base",
      "2026-09-09T12:00:00.000Z",
    );
    record(base, "next_run");
    const baseRun = context.coordination.leaseNextRun({
      workerId: "worker-a",
      now: "2026-09-09T12:00:01.000Z",
    });
    assert.ok(baseRun);
    context.coordination.markRunStarted(
      baseRun.runId,
      baseRun.fencingToken,
      "2026-09-09T12:00:02.000Z",
    );
    context.coordination.recordProviderInput({
      executionId: "execution-original",
      schedulerRunId: baseRun.runId,
      fencingToken: baseRun.fencingToken,
      agentId: context.recipient.id,
      projectId: context.project.id,
      prompt: "base",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: baseRun.activationIds,
        communicationEventIds: [base.eventId],
        artifactIds: [],
        conversationId: context.conversation.id,
        providerSessionDisposition: "fresh_task",
        sources: [],
      },
      now: "2026-09-09T12:00:02.000Z",
    });
    context.coordination.preparePromptInjection({
      injectionId: baseRun.injectionId,
      runId: baseRun.runId,
      fencingToken: baseRun.fencingToken,
      prompt: "base",
      now: "2026-09-09T12:00:02.000Z",
    });
    context.coordination.markPromptSubmitted({
      injectionId: baseRun.injectionId,
      runId: baseRun.runId,
      fencingToken: baseRun.fencingToken,
      now: "2026-09-09T12:00:02.000Z",
    });
    context.coordination.acknowledgePromptInjection({
      injectionId: baseRun.injectionId,
      runId: baseRun.runId,
      fencingToken: baseRun.fencingToken,
      now: "2026-09-09T12:00:03.000Z",
    });

    const target = communication(
      "communication-recovered-steer",
      "steer",
      "2026-09-09T12:00:04.000Z",
    );
    record(target, "steer_or_run");
    const steering = context.coordination.leaseNextSteering({
      workerId: "worker-a",
      now: "2026-09-09T12:00:05.000Z",
    });
    assert.ok(steering);
    context.coordination.preparePromptInjection({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
      prompt: "steer",
      now: "2026-09-09T12:00:05.000Z",
    });
    context.coordination.markPromptSubmitted({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
      now: "2026-09-09T12:00:05.000Z",
    });
    context.coordination.markSteeringOutcomeUnknown({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
      recoveryGraceMs: 0,
      now: "2026-09-09T12:00:06.000Z",
    });
    context.coordination.processDueSteeringRecoveries(
      "2026-09-09T12:00:06.000Z",
    );
    const recoveryRun = context.coordination.leaseNextRun({
      workerId: "worker-a",
      now: "2026-09-09T12:00:07.000Z",
    });
    assert.ok(recoveryRun);
    context.coordination.markRunStarted(
      recoveryRun.runId,
      recoveryRun.fencingToken,
      "2026-09-09T12:00:08.000Z",
    );
    context.coordination.recordProviderInput({
      executionId: "execution-recovery",
      schedulerRunId: recoveryRun.runId,
      fencingToken: recoveryRun.fencingToken,
      agentId: context.recipient.id,
      projectId: context.project.id,
      prompt: "recover",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: recoveryRun.activationIds,
        communicationEventIds: [target.eventId],
        artifactIds: [],
        conversationId: context.conversation.id,
        providerSessionDisposition: "fresh_task",
        sources: [],
      },
      now: "2026-09-09T12:00:08.000Z",
    });
    context.coordination.preparePromptInjection({
      injectionId: recoveryRun.injectionId,
      runId: recoveryRun.runId,
      fencingToken: recoveryRun.fencingToken,
      prompt: "recover",
      now: "2026-09-09T12:00:08.000Z",
    });
    context.coordination.markPromptSubmitted({
      injectionId: recoveryRun.injectionId,
      runId: recoveryRun.runId,
      fencingToken: recoveryRun.fencingToken,
      now: "2026-09-09T12:00:08.000Z",
    });
    const recovering = context.coordination.deliveryReceiptsForCommunication(
      context.project.id,
      target.eventId,
    )[0];
    assert.equal(recovering.state, "recovering");
    assert.equal(recovering.executionId, "execution-original");
    assert.equal(recovering.recoveryExecutionId, "execution-recovery");

    context.coordination.acknowledgePromptInjection({
      injectionId: recoveryRun.injectionId,
      runId: recoveryRun.runId,
      fencingToken: recoveryRun.fencingToken,
      now: "2026-09-09T12:00:09.000Z",
    });
    context.coordination.completeRun(
      recoveryRun.runId,
      recoveryRun.fencingToken,
      "2026-09-09T12:00:10.000Z",
    );
    const recovered = context.coordination.deliveryReceiptsForCommunication(
      context.project.id,
      target.eventId,
    )[0];
    assert.equal(recovered.state, "recovered");
    assert.equal(recovered.recoveryExecutionId, "execution-recovery");
  } finally {
    context.close();
  }
});
