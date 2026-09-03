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
