import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { registerConversationDeliveryRoutes } from "../dist/routes/conversation-deliveries.js";
import { registerConversationRoutes } from "../dist/routes/conversations.js";
import { registerAgentMaintenanceRoutes } from "../dist/routes/agent-maintenance.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function deliveryLeaseApp({ direct = false, targeted = false } = {}) {
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
  const agentLeases = new Map();
  const preparationStarted = deferred();
  const finishPreparation = deferred();
  const store = {
    getConversation: (id) => id === chat.id ? chat : undefined,
    updateConversation: (_id, body) => Object.assign(chat, body),
    listAgents: () => direct || targeted ? [agent] : [],
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
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: leases,
    agentDeliveryLeases: agentLeases,
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
  registerAgentMaintenanceRoutes(app, {
    store,
    deletingAgentIds: new Set(),
    agentDeliveryLeases: agentLeases,
  });
  return { agentLeases, app, agent, chat, finishPreparation, leases, preparationStarted };
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
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
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
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
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

for (const { direct, targeted, label } of [
  { direct: false, targeted: false, label: "passive broadcasts" },
  { direct: false, targeted: true, label: "targeted broadcasts" },
  { direct: true, targeted: true, label: "direct messages" },
]) {
  test(`${label} lease their Chat while preparing text`, async (t) => {
    const { agentLeases, app, agent, chat, finishPreparation, leases, preparationStarted } = deliveryLeaseApp({ direct, targeted });
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
        : {
            text: targeted ? "#AgentA hello" : "hello",
            ...(targeted ? {
              recipientAgentMentions: [{ agentId: agent.id, handle: agent.handle }],
            } : {}),
            idempotencyKey: "delivery-race",
          },
    });
    await preparationStarted.promise;

    assert.equal(leases.get(chat.id), 1);
    assert.equal(agentLeases.get(agent.id), targeted ? 1 : undefined);
    const archive = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${chat.id}`,
      payload: { archived: true },
    });
    assert.equal(archive.statusCode, 409);
    assert.equal(chat.archived, false);
    if (targeted) {
      const archiveAgent = await app.inject({
        method: "PATCH",
        url: `/api/agents/${agent.id}`,
        payload: { archived: true },
      });
      assert.equal(archiveAgent.statusCode, 409);
      assert.equal(agent.archived, false);
    }

    finishPreparation.resolve();
    assert.equal((await delivery).statusCode, 409);
    assert.equal(leases.has(chat.id), false);
    assert.equal(agentLeases.has(agent.id), false);
  });
}

test("archive mutations reject non-boolean values", async (t) => {
  const { app, agent, chat } = deliveryLeaseApp({ direct: true });
  t.after(() => app.close());
  const [chatResponse, agentResponse] = await Promise.all([
    app.inject({ method: "PATCH", url: `/api/conversations/${chat.id}`, payload: { archived: "true" } }),
    app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, payload: { archived: 1 } }),
  ]);
  assert.equal(chatResponse.statusCode, 400);
  assert.equal(agentResponse.statusCode, 400);
  assert.equal(chat.archived, false);
  assert.equal(agent.archived, false);
});

test("Agent deletion in progress rejects direct delivery before staging text", async (t) => {
  let staged = false;
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const agent = {
    id: "agent-a",
    projectId: chat.projectId,
    conversationId: chat.id,
    archived: false,
  };
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: () => chat,
      getAgent: () => agent,
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => true,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    prepareUserCommunicationText: async () => {
      staged = true;
      throw new Error("must not stage");
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/direct-messages`,
    payload: {
      text: "hello",
      recipients: [{ agentId: agent.id }],
      idempotencyKey: "deleting-agent",
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(staged, false);
});

test("disconnecting the client does not release a delivery lease before the handler settles", async (t) => {
  const { app, chat, finishPreparation, leases, preparationStarted } = deliveryLeaseApp();
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const payload = JSON.stringify({ text: "hello", idempotencyKey: "disconnect-race" });
  const client = httpRequest({
    host: "127.0.0.1",
    port: address.port,
    method: "POST",
    path: `/api/conversations/${chat.id}/messages`,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  });
  client.on("error", () => {});
  client.end(payload);
  await preparationStarted.promise;

  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(leases.get(chat.id), 1);

  finishPreparation.resolve();
  for (let attempt = 0; leases.has(chat.id) && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(leases.has(chat.id), false);
});
