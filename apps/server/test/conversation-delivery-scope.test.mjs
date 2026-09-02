import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerConversationDeliveryRoutes } from "../dist/routes/conversation-deliveries.js";
import { registerConversationRoutes } from "../dist/routes/conversations.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function deliveryLeaseApp({ direct = false } = {}) {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const agent = {
    id: "agent-a",
    projectId: chat.projectId,
    conversationId: chat.id,
    handle: "AgentA",
    title: "Agent A",
    archived: false,
  };
  const leases = new Map();
  const preparationStarted = deferred();
  const finishPreparation = deferred();
  const store = {
    getConversation: (id) => id === chat.id ? chat : undefined,
    updateConversation: (_id, body) => Object.assign(chat, body),
    listAgents: () => direct ? [agent] : [],
    getAgent: (id) => id === agent.id ? agent : undefined,
  };
  const app = Fastify();
  registerConversationDeliveryRoutes(app, {
    store,
    coordinationV3: {
      runtimeCommunication: () => undefined,
      recordRuntimeCommunication: () => { throw new Error("stop after preparation"); },
    },
    projectDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    conversationDeliveryLeases: leases,
    prepareUserCommunicationText: async () => {
      preparationStarted.resolve();
      await finishPreparation.promise;
      return { canonicalText: "hello", publishedText: "hello" };
    },
  });
  registerConversationRoutes(app, {
    store,
    engines: new Map(),
    cachedModelOptions: () => [],
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: leases,
  });
  return { app, agent, chat, finishPreparation, leases, preparationStarted };
}

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
    conversationDeliveryLeases: new Map(),
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

for (const direct of [false, true]) {
  test(`${direct ? "direct messages" : "broadcasts"} lease their Chat while preparing text`, async (t) => {
    const { app, agent, chat, finishPreparation, leases, preparationStarted } = deliveryLeaseApp({ direct });
    t.after(() => app.close());
    const delivery = app.inject({
      method: "POST",
      url: direct
        ? `/api/conversations/${chat.id}/direct-messages`
        : `/api/conversations/${chat.id}/messages`,
      payload: direct
        ? {
            text: "hello",
            recipients: [{ agentId: agent.id }],
            idempotencyKey: "delivery-race",
          }
        : { text: "hello", idempotencyKey: "delivery-race" },
    });
    await preparationStarted.promise;

    assert.equal(leases.get(chat.id), 1);
    const archive = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${chat.id}`,
      payload: { archived: true },
    });
    assert.equal(archive.statusCode, 409);
    assert.equal(chat.archived, false);

    finishPreparation.resolve();
    assert.equal((await delivery).statusCode, 409);
    assert.equal(leases.has(chat.id), false);
  });
}
