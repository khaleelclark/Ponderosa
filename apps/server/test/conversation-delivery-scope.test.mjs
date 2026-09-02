import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import {
  conversationDeliveryRequestFingerprint,
  registerConversationDeliveryRoutes,
} from "../dist/routes/conversation-deliveries.js";
import { registerConversationRoutes } from "../dist/routes/conversations.js";
import { registerAgentMaintenanceRoutes } from "../dist/routes/agent-maintenance.js";
import { registerCollaborationRoutes } from "../dist/routes/collaboration.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";

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
    coordinationV3: { runtimeCommunication: () => undefined },
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
    coordinationV3: { runtimeCommunication: () => undefined },
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
    coordinationV3: { runtimeCommunication: () => undefined },
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

test("direct message retries replay the original success after a recipient is archived", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const requestPayload = {
    text: "hello",
    recipients: [{ agentId: "agent-a" }, { agentId: "agent-b" }],
    idempotencyKey: "stable-retry",
  };
  const requestFingerprint = conversationDeliveryRequestFingerprint({
    version: 1,
    kind: "direct",
    conversationId: chat.id,
    text: requestPayload.text,
    recipients: requestPayload.recipients.map((recipient) => ({
      agentId: recipient.agentId,
      attachmentIds: [],
    })),
    activeRunDelivery: "steer",
    runtimeSelection: {},
  });
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: () => chat,
      getConversationMessageByReceiptKey: () => ({ id: "message-a" }),
    },
    coordinationV3: {
      runtimeCommunication: () => ({
        id: "event-a",
        projectId: chat.projectId,
        audience: {},
        createdAt: new Date().toISOString(),
        payload: {
          requestFingerprint,
          dispatch: { recipients: [{ agentId: "agent-a" }, { agentId: "agent-b" }] },
        },
        activations: [
          { id: "delivery-a", agentId: "agent-a" },
          { id: "delivery-b", agentId: "agent-b" },
        ],
      }),
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    reconcileRuntimeCommunicationProjections: async () => 0,
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/direct-messages`,
    payload: requestPayload,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    messageId: "message-a",
    replayed: true,
    recipients: [
      { agentId: "agent-a", queued: true, deliveryId: "delivery-a", state: "queued" },
      { agentId: "agent-b", queued: true, deliveryId: "delivery-b", state: "queued" },
    ],
  });
});

test("broadcast attachments lease their owning Agent", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const owner = {
    id: "agent-owner",
    projectId: chat.projectId,
    conversationId: chat.id,
    handle: "Owner",
    title: "Owner",
    archived: false,
  };
  const agentLeases = new Map();
  const preparationStarted = deferred();
  const finishPreparation = deferred();
  const asset = {
    id: "asset-a",
    projectId: chat.projectId,
    agentId: owner.id,
    name: "note.txt",
    mediaType: "text/plain",
    size: 4,
    state: "staged",
  };
  const assets = {
    read: async () => asset,
    remove: async () => true,
  };
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: () => chat,
      listAgents: () => [owner],
      getAgent: () => owner,
    },
    coordinationV3: {
      runtimeCommunication: () => undefined,
      recordRuntimeCommunication: () => { throw new Error("stop after preparation"); },
    },
    assets,
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: agentLeases,
    assetMetadata: async () => asset,
    prepareUserCommunicationText: async () => {
      preparationStarted.resolve();
      await finishPreparation.promise;
      return { canonicalText: "hello", publishedText: "hello" };
    },
  });
  registerAttachmentRoutes(app, {
    store: { getAgent: () => owner },
    assets,
    agentDeliveryLeases: agentLeases,
    deletingAttachmentKeys: new Set(),
  });
  const delivery = app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/messages`,
    payload: {
      text: "hello",
      attachments: [{ id: "asset-a", agentId: owner.id }],
      idempotencyKey: "attachment-race",
    },
  });
  await preparationStarted.promise;
  assert.equal(agentLeases.get(owner.id), 1);
  const deletion = await app.inject({
    method: "DELETE",
    url: `/api/agents/${owner.id}/attachments/${asset.id}`,
  });
  assert.equal(deletion.statusCode, 409);
  finishPreparation.resolve();
  assert.equal((await delivery).statusCode, 409);
  assert.equal(agentLeases.has(owner.id), false);
});

test("archived Chats reject collaboration before activating recipients", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: true };
  let viewed = false;
  const app = Fastify();
  t.after(() => app.close());
  registerCollaborationRoutes(app, {
    store: { getConversation: () => chat },
    coordinationV3: { runtimeCommunication: () => undefined },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    collaborationViewDetail: () => {
      viewed = true;
      throw new Error("must not inspect archived Chat");
    },
  });
  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/collaboration/messages`,
    payload: { text: "hello", recipientAgentIds: ["agent-a"], idempotencyKey: "archived" },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(viewed, false);
});

test("collaboration leases its Chat and recipient Agents while preparing text", async (t) => {
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
    getConversation: () => chat,
    updateConversation: (_id, body) => Object.assign(chat, body),
    getAgent: () => agent,
  };
  const app = Fastify();
  t.after(() => app.close());
  registerCollaborationRoutes(app, {
    store,
    coordinationV3: {
      runtimeCommunication: () => undefined,
      recordRuntimeCommunication: () => { throw new Error("stop after preparation"); },
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: leases,
    agentDeliveryLeases: agentLeases,
    collaborationViewDetail: () => ({ agents: [agent], messages: [] }),
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
  const delivery = app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/collaboration/messages`,
    payload: {
      text: "hello",
      recipientAgentIds: [agent.id],
      idempotencyKey: "collaboration-race",
    },
  });
  await preparationStarted.promise;
  assert.equal(leases.get(chat.id), 1);
  assert.equal(agentLeases.get(agent.id), 1);
  const [archiveChat, archiveAgent] = await Promise.all([
    app.inject({ method: "PATCH", url: `/api/conversations/${chat.id}`, payload: { archived: true } }),
    app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, payload: { archived: true } }),
  ]);
  assert.equal(archiveChat.statusCode, 409);
  assert.equal(archiveAgent.statusCode, 409);
  finishPreparation.resolve();
  assert.equal((await delivery).statusCode, 409);
  assert.equal(leases.has(chat.id), false);
  assert.equal(agentLeases.has(agent.id), false);
});

test("an attachment deletion reservation blocks a delivery that starts second", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const owner = {
    id: "agent-owner",
    projectId: chat.projectId,
    conversationId: chat.id,
    handle: "Owner",
    title: "Owner",
    archived: false,
  };
  const deletionReadStarted = deferred();
  const finishDeletionRead = deferred();
  const deletingAttachmentKeys = new Set();
  let prepared = false;
  const asset = {
    id: "asset-a",
    projectId: chat.projectId,
    agentId: owner.id,
    name: "note.txt",
    mediaType: "text/plain",
    size: 4,
    state: "staged",
  };
  const assets = {
    read: async () => {
      deletionReadStarted.resolve();
      await finishDeletionRead.promise;
      return asset;
    },
    remove: async () => true,
  };
  const app = Fastify();
  t.after(() => app.close());
  registerAttachmentRoutes(app, {
    store: { getAgent: () => owner },
    assets,
    agentDeliveryLeases: new Map(),
    deletingAttachmentKeys,
  });
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: () => chat,
      listAgents: () => [owner],
      getAgent: () => owner,
    },
    coordinationV3: { runtimeCommunication: () => undefined },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    attachmentDeletionInProgress: (agentId, attachmentId) =>
      deletingAttachmentKeys.has(`${agentId}\0${attachmentId}`),
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    prepareUserCommunicationText: async () => {
      prepared = true;
      throw new Error("must not prepare");
    },
  });

  const deletion = app.inject({
    method: "DELETE",
    url: `/api/agents/${owner.id}/attachments/${asset.id}`,
  });
  await deletionReadStarted.promise;
  const delivery = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/messages`,
    payload: {
      text: "hello",
      attachments: [{ id: asset.id, agentId: owner.id }],
      idempotencyKey: "reverse-attachment-race",
    },
  });
  assert.equal(delivery.statusCode, 409);
  assert.equal(prepared, false);
  finishDeletionRead.resolve();
  assert.equal((await deletion).statusCode, 204);
  assert.equal(deletingAttachmentKeys.size, 0);
});

test("collaboration retries read the collaboration channel", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const payload = {
    text: "hello",
    recipientAgentIds: ["agent-a"],
    idempotencyKey: "collaboration-replay",
  };
  const requestFingerprint = conversationDeliveryRequestFingerprint({
    version: 1,
    kind: "collaboration",
    conversationId: chat.id,
    text: payload.text,
    recipientAgentIds: payload.recipientAgentIds,
    recipientAttachments: [],
  });
  const eventId = `collaboration-${createHash("sha256").update(`${chat.id}\0${payload.idempotencyKey}`).digest("hex")}`;
  let requestedChannel;
  const app = Fastify();
  t.after(() => app.close());
  registerCollaborationRoutes(app, {
    store: {
      getConversation: () => chat,
      getConversationMessages: (_id, channel) => {
        requestedChannel = channel;
        return [{ id: "message-a", communicationEventId: eventId }];
      },
    },
    coordinationV3: {
      runtimeCommunication: () => ({
        id: "event-a",
        projectId: chat.projectId,
        audience: {},
        createdAt: new Date().toISOString(),
        payload: {
          requestFingerprint,
          dispatch: { recipients: [{ agentId: "agent-a" }] },
        },
      }),
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    reconcileRuntimeCommunicationProjections: async () => 0,
  });
  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/collaboration/messages`,
    payload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(requestedChannel, "collaboration");
});

test("delivery routes reject malformed JSON shapes with 400", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const common = {
    store: {},
    coordinationV3: {},
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
  };
  registerConversationDeliveryRoutes(app, common);
  registerCollaborationRoutes(app, { ...common, collaborationViewDetail: () => undefined });
  const cases = [
    ["/api/conversations/chat-a/messages", { text: "hello", idempotencyKey: 1 }],
    ["/api/conversations/chat-a/messages", {
      text: "#AgentA hello",
      recipientAgentMentions: [{ agentId: "agent-a", handle: "AgentA" }],
      recipientAttachments: [null],
      idempotencyKey: "bad-attachment-list",
    }],
    ["/api/conversations/chat-a/direct-messages", { text: {}, recipients: [{ agentId: "agent-a" }], idempotencyKey: "bad-text" }],
    ["/api/conversations/chat-a/direct-messages", { text: "hello", recipients: [null], idempotencyKey: "bad-recipient" }],
    ["/api/conversations/chat-a/direct-messages", { text: "hello", recipients: [{ agentId: "agent-a" }], idempotencyKey: 1 }],
    ["/api/conversations/chat-a/collaboration/messages", { text: {}, recipientAgentIds: ["agent-a"] }],
    ["/api/conversations/chat-a/collaboration/messages", { text: "hello", recipientAgentIds: ["agent-a"], idempotencyKey: 1 }],
  ];
  for (const [url, payload] of cases) {
    const response = await app.inject({ method: "POST", url, payload });
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
  }
});
