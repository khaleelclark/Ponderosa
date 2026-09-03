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
