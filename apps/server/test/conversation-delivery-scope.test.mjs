import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerConversationDeliveryRoutes } from "../dist/routes/conversation-deliveries.js";

test("broadcasts cannot target an Agent owned by another Chat", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a" };
  const otherChatAgent = {
    id: "agent-b",
    projectId: "project-a",
    conversationId: "chat-b",
    handle: "OtherChatAgent",
    archived: false,
  };
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: (id) => id === chat.id ? chat : undefined,
      listAgents: () => [otherChatAgent],
      getAgent: (id) => id === otherChatAgent.id ? otherChatAgent : undefined,
    },
    projectDeletionInProgress: () => false,
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/messages`,
    payload: {
      text: "#OtherChatAgent do this",
      recipientAgentMentions: [{ agentId: otherChatAgent.id, handle: otherChatAgent.handle }],
      idempotencyKey: "cross-chat-attempt",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "every targeted #Agent mention must have one canonical binding",
  });
});

test("archived Chats reject broadcasts before staging long text", async (t) => {
  let staged = false;
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: () => ({ id: "chat-a", projectId: "project-a", archived: true }),
    },
    projectDeletionInProgress: () => false,
    prepareUserCommunicationText: async () => {
      staged = true;
      throw new Error("must not stage");
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/conversations/chat-a/messages",
    payload: {
      text: "x".repeat(100_000),
      idempotencyKey: "archived-chat-attempt",
    },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(staged, false);
});
