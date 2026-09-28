import assert from "node:assert/strict";
import test from "node:test";
import { broadcastAttachmentsForOwner, newChatSubmission } from "../src/conversationRouting.js";

test("an explicit new-Chat broadcast never becomes an Agent creation", () => {
  assert.deepEqual(newChatSubmission("#broadcast Shared context"), {
    kind: "broadcast",
    text: "Shared context",
  });
  assert.deepEqual(newChatSubmission("Shared context #broadcast"), {
    kind: "broadcast",
    text: "Shared context",
  });
});

test("an ordinary first message keeps the existing new-Agent behavior", () => {
  assert.deepEqual(newChatSubmission("Please help with this"), {
    kind: "agent",
    text: "Please help with this",
  });
});

test("a zero-Agent Broadcast carries its Chat-owned image identity through the send payload", () => {
  const chatUploads = [{ agentId: "chat-1", attachments: [{ id: "image-1" }] }];
  assert.deepEqual(broadcastAttachmentsForOwner("chat-1", "chat-1", chatUploads), [
    { id: "image-1", agentId: "chat-1", conversationId: "chat-1" },
  ]);
  assert.deepEqual(broadcastAttachmentsForOwner("chat-1", "agent-1", [
    { agentId: "agent-1", attachments: [{ id: "image-2" }] },
  ]), [{ id: "image-2", agentId: "agent-1" }]);
});
