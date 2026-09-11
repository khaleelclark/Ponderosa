import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";
import { CommunicationV4NextRunDeliveryAuthority } from "../dist/communication-v4-next-run-delivery-authority.js";

test("an exact next-run delivery retry does not need renewed Run authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-next-run-replay-"));
  const store = new AgentStore(directory);
  try {
    const project = store.createProject({
      label: "Project",
      hostPath: "/tmp/project",
      defaultEngine: "codex",
    });
    const conversation = store.createConversation(project.id, { title: "Chat" });
    const publisher = store.createAgent(project.id, {
      title: "Publisher",
      engine: "codex",
      conversationId: conversation.id,
    });
    const recipient = store.createAgent(project.id, {
      title: "Recipient",
      engine: "codex",
      conversationId: conversation.id,
    });
    let authorizationChecks = 0;
    const authority = new CommunicationV4NextRunDeliveryAuthority(store.sqlite, () => {
      authorizationChecks += 1;
      if (authorizationChecks > 1) throw new Error("Run authority expired");
    });
    const input = {
      projectId: project.id,
      conversationId: conversation.id,
      publisherAgentId: publisher.id,
      sourceRunId: "run-a",
      runAuthorization: { runId: "run-a", agentId: publisher.id, fencingToken: 1 },
      idempotencyKey: "send-once",
      text: "remember this",
      recipientAgentIds: [recipient.id],
    };

    const first = authority.publishAgent(input);
    const replay = authority.publishAgent(input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.delivery.id, first.delivery.id);
    assert.equal(authorizationChecks, 1);
    assert.throws(
      () => authority.publishAgent({ ...input, text: "different" }),
      /idempotency conflict/u,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
