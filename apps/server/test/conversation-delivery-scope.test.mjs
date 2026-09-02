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
import { registerAgentCreationRoutes } from "../dist/routes/agent-creation.js";
import { leaseAgentAssetReconciliation } from "../dist/server-lifecycle.js";
import { leaseAgentDelivery } from "../dist/delivery-leases.js";
import { createCommunicationProjectionReconciler } from "../dist/communication-projection-reconciler.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("Agent delivery leases deduplicate owners and release idempotently", () => {
  const leases = new Map();
  const release = leaseAgentDelivery(leases, ["agent-a", "agent-a", "agent-b"]);
  assert.deepEqual([...leases], [["agent-a", 1], ["agent-b", 1]]);
  release();
  release();
  assert.equal(leases.size, 0);
});

test("new Agents remain quarantined while opening assets are staged", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const project = { id: chat.projectId, defaultEngine: "codex" };
  const agent = {
    id: "agent-a",
    projectId: project.id,
    conversationId: chat.id,
    activeEngine: "codex",
    archived: false,
  };
  const deletingAgentIds = new Set();
  const agentDeliveryLeases = new Map();
  const stageStarted = deferred();
  const finishStage = deferred();
  const app = Fastify();
  t.after(() => app.close());
  registerAgentCreationRoutes(app, {
    store: {
      getProject: () => project,
      getConversation: () => chat,
      createAgent: () => agent,
      deleteAgent: () => true,
    },
    coordinationV3: { handleAgentDeletion: () => {} },
    workspace: { getPreferences: () => ({}) },
    assets: {
      stage: async () => {
        stageStarted.resolve();
        await finishStage.promise;
        throw new Error("stop after quarantine check");
      },
      remove: async () => true,
    },
    drafts: {
      normalizedOwner: () => "owner-a",
      prepared: async () => ({ body: Buffer.from("x"), prepared: {} }),
    },
    engines: new Map([["codex", {
      adapter: {
        id: "codex",
        listModels: () => [],
        listEfforts: () => [],
      },
    }]]),
    deletingAgentIds,
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    agentDeliveryLeases,
    cachedModelOptions: () => [],
  });

  const creation = app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/agents`,
    payload: {
      title: "Agent A",
      engine: "codex",
      conversationId: chat.id,
      draftAttachmentIds: ["draft-a"],
      draftOwnerId: "owner-a",
    },
  });
  await stageStarted.promise;
  assert.equal(deletingAgentIds.has(agent.id), true);
  assert.equal(agentDeliveryLeases.get(agent.id), 1);
  finishStage.resolve();
  assert.equal((await creation).statusCode, 409);
  assert.equal(deletingAgentIds.has(agent.id), false);
  assert.equal(agentDeliveryLeases.has(agent.id), false);
});

test("asset cleanup and message delivery cannot lease the same Agent", () => {
  const deliveryLeases = new Map([["agent-a", 1]]);
  const deletingAgentIds = new Set();
  let deletingAttachment = false;
  const cleanupLeases = new Set();
  const deletionInProgress = () => deletingAttachment;
  assert.equal(leaseAgentAssetReconciliation(deliveryLeases, deletingAgentIds, deletionInProgress, cleanupLeases, "agent-a"), undefined);
  deliveryLeases.clear();
  deletingAgentIds.add("agent-a");
  assert.equal(leaseAgentAssetReconciliation(deliveryLeases, deletingAgentIds, deletionInProgress, cleanupLeases, "agent-a"), undefined);
  deletingAgentIds.clear();
  deletingAttachment = true;
  assert.equal(leaseAgentAssetReconciliation(deliveryLeases, deletingAgentIds, deletionInProgress, cleanupLeases, "agent-a"), undefined);
  deletingAttachment = false;
  const release = leaseAgentAssetReconciliation(deliveryLeases, deletingAgentIds, deletionInProgress, cleanupLeases, "agent-a");
  assert.equal(typeof release, "function");
  assert.equal(cleanupLeases.has("agent-a"), true);
  assert.equal(leaseAgentAssetReconciliation(deliveryLeases, deletingAgentIds, deletionInProgress, cleanupLeases, "agent-a"), undefined);
  release();
  assert.equal(cleanupLeases.has("agent-a"), false);
});

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
            recipients: [{ agentId: ` ${agent.id} ` }],
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

test("multi-recipient direct messages persist the exact room attachment set", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const agents = new Map([
    ["agent-a", { id: "agent-a", projectId: chat.projectId, conversationId: chat.id, archived: false }],
    ["agent-b", { id: "agent-b", projectId: chat.projectId, conversationId: chat.id, archived: false }],
  ]);
  const assetsByAgent = new Map([
    ["agent-a", { id: "asset-a", projectId: chat.projectId, agentId: "agent-a", name: "a.txt", mediaType: "text/plain", size: 1, state: "staged" }],
    ["agent-b", { id: "asset-b", projectId: chat.projectId, agentId: "agent-b", name: "b.txt", mediaType: "text/plain", size: 1, state: "staged" }],
  ]);
  let runtimeInput;
  let roomInput;
  let roomMessage;
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: () => chat,
      getAgent: (id) => agents.get(id),
      getConversationMessageByReceiptKey: () => roomMessage,
      appendConversationMessage: (_id, message) => {
        roomInput = message;
        roomMessage = { id: "message-a", ...message };
        return roomMessage;
      },
      appendCommunicationProjection: () => ({}),
    },
    coordinationV3: {
      runtimeCommunication: () => undefined,
      recordRuntimeCommunication: (input) => {
        runtimeInput = input;
        return {
          replayed: false,
          activations: input.activations.map((activation, index) => ({
            ...activation,
            id: `delivery-${index}`,
          })),
        };
      },
    },
    assets: { associate: async () => {} },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    assetMetadata: async (agentId) => assetsByAgent.get(agentId),
    prepareUserCommunicationText: async () => ({ canonicalText: "hello", publishedText: "hello" }),
    recordCommunication: (communication) => communication,
    projectCommunicationToAgentAudit: () => {},
    publishCoordinationV3Changed: () => {},
    notifyScheduler: () => {},
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/direct-messages`,
    payload: {
      text: "hello",
      recipients: [
        { agentId: "agent-a", attachmentIds: ["asset-a"] },
        { agentId: "agent-b", attachmentIds: ["asset-b"] },
      ],
      idempotencyKey: "exact-room-assets",
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(runtimeInput.payload.dispatch.conversationAttachmentIds, ["asset-a"]);
  assert.deepEqual(runtimeInput.payload.communication.attachments.map((asset) => asset.id), ["asset-a", "asset-b"]);
  assert.deepEqual(roomInput.attachments.map((asset) => asset.id), ["asset-a"]);
});

test("projection recovery leases exact owners and restores only the persisted room attachments", async () => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const agents = new Map([
    ["agent-a", { id: "agent-a", projectId: chat.projectId, conversationId: chat.id, archived: false }],
    ["agent-b", { id: "agent-b", projectId: chat.projectId, conversationId: chat.id, archived: false }],
  ]);
  const attachments = [
    { id: "asset-a", agentId: "agent-a", name: "a.txt", mediaType: "text/plain", size: 1, state: "associated" },
    { id: "asset-b", agentId: "agent-b", name: "b.txt", mediaType: "text/plain", size: 1, state: "associated" },
  ];
  const event = {
    eventId: "event-a",
    schemaVersion: 2,
    projectId: chat.projectId,
    conversationId: chat.id,
    sender: { kind: "user", userId: "local-operator" },
    intent: "user_dm",
    audience: { kind: "user_agents", userId: "local-operator", agentIds: ["agent-a", "agent-b"] },
    text: "hello",
    attachments,
    createdAt: new Date().toISOString(),
  };
  const conversationLeases = new Map();
  const agentLeases = new Map();
  let roomInput;
  const store = {
    getConversation: () => chat,
    getAgent: (id) => agents.get(id),
    getCommunicationEvent: () => event,
    canProjectCommunication: () => true,
    getConversationMessages: () => [],
    appendConversationMessage: (_id, message) => {
      assert.equal(conversationLeases.get(chat.id), 1);
      assert.equal(agentLeases.get("agent-a"), 1);
      assert.equal(agentLeases.get("agent-b"), 1);
      roomInput = message;
      return { id: "message-a", createdAt: event.createdAt, ...message };
    },
    getCommunicationProjection: () => undefined,
    appendCommunicationProjection: () => ({}),
  };
  const reconciler = createCommunicationProjectionReconciler({
    store,
    coordinationV3: {
      runtimeCommunications: () => [{
        id: "runtime-a",
        projectId: chat.projectId,
        recipientAgentIds: ["agent-a", "agent-b"],
        payload: {
          communication: event,
          dispatch: {
            conversationAttachmentIds: ["asset-a"],
            recipients: attachments.map((attachment) => ({
              agentId: attachment.agentId,
              attachments: [attachment],
            })),
          },
        },
      }],
      requestCommunicationsNeedingProjection: () => [],
      runtimeArtifacts: () => [],
    },
    assets: {
      authoritativeRuntimeCommunicationAttachments: () => attachments.map((attachment) => ({
        attachment,
        contentHash: `hash-${attachment.id}`,
        localPath: `/tmp/${attachment.id}`,
      })),
      associate: async () => {},
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    attachmentDeletionInProgress: () => false,
    assetReconciliationInProgress: () => false,
    conversationDeliveryLeases: conversationLeases,
    agentDeliveryLeases: agentLeases,
    recordCommunication: (communication) => communication,
    projectCommunicationArtifact: () => {},
    communicationArtifactAccess: () => ({}),
    scheduleCommunicationReconciliation: () => {},
    logError: (_meta, message) => { throw new Error(message); },
    logInfo: () => {},
    projectCommunicationToAgentAudit: () => {},
  });

  await reconciler.reconcileRuntimeCommunicationProjections();
  assert.deepEqual(roomInput.attachments.map((asset) => asset.id), ["asset-a"]);
  assert.equal(conversationLeases.size, 0);
  assert.equal(agentLeases.size, 0);
});

test("direct message retries lease the Chat while repairing a missing projection", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const requestPayload = {
    text: "hello",
    recipients: [{ agentId: "agent-a" }],
    idempotencyKey: "repair-retry",
  };
  const requestFingerprint = conversationDeliveryRequestFingerprint({
    version: 1,
    kind: "direct",
    conversationId: chat.id,
    text: requestPayload.text,
    recipients: [{ agentId: "agent-a", attachmentIds: [] }],
    activeRunDelivery: "steer",
    runtimeSelection: {},
  });
  const repairStarted = deferred();
  const finishRepair = deferred();
  const conversationLeases = new Map();
  const agentLeases = new Map();
  let repaired = false;
  const store = {
    getConversation: () => chat,
    getConversationMessageByReceiptKey: () => repaired ? { id: "message-a" } : undefined,
    listAgents: () => [],
  };
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store,
    coordinationV3: {
      runtimeCommunication: () => ({
        payload: { requestFingerprint, dispatch: { recipients: [{ agentId: "agent-a" }] } },
        activations: [{ id: "delivery-a", agentId: "agent-a" }],
      }),
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: conversationLeases,
    agentDeliveryLeases: agentLeases,
    reconcileRuntimeCommunicationProjections: async () => {
      repairStarted.resolve();
      await finishRepair.promise;
      repaired = true;
      return 1;
    },
  });
  registerConversationRoutes(app, {
    store,
    engines: new Map(),
    cachedModelOptions: () => [],
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: conversationLeases,
  });

  const retry = app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/direct-messages`,
    payload: requestPayload,
  });
  await repairStarted.promise;
  assert.equal(conversationLeases.get(chat.id), 1);
  assert.equal(agentLeases.get("agent-a"), 1);
  const deletion = await app.inject({ method: "DELETE", url: `/api/conversations/${chat.id}` });
  assert.equal(deletion.statusCode, 409);
  finishRepair.resolve();
  assert.equal((await retry).statusCode, 200);
  assert.equal(conversationLeases.has(chat.id), false);
  assert.equal(agentLeases.has("agent-a"), false);
});

test("direct message replay repair waits for attachment maintenance", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const requestPayload = {
    text: "hello",
    recipients: [{ agentId: "agent-a", attachmentIds: ["asset-a"] }],
    idempotencyKey: "repair-with-attachment",
  };
  const requestFingerprint = conversationDeliveryRequestFingerprint({
    version: 1,
    kind: "direct",
    conversationId: chat.id,
    text: requestPayload.text,
    recipients: requestPayload.recipients,
    activeRunDelivery: "steer",
    runtimeSelection: {},
  });
  let repaired = false;
  const app = Fastify();
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversation: () => chat,
      getConversationMessageByReceiptKey: () => undefined,
    },
    coordinationV3: {
      runtimeCommunication: () => ({
        payload: {
          requestFingerprint,
          dispatch: {
            recipients: [{
              agentId: "agent-a",
              attachments: [{ id: "asset-a", name: "note.txt", mediaType: "text/plain", size: 4 }],
            }],
          },
        },
        activations: [],
      }),
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    attachmentDeletionInProgress: () => false,
    assetReconciliationInProgress: () => true,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    reconcileRuntimeCommunicationProjections: async () => { repaired = true; return 1; },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/direct-messages`,
    payload: requestPayload,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(repaired, false);
});

test("attachment upload leases its Agent and rejects archived Agents", async (t) => {
  const agent = {
    id: "agent-a",
    projectId: "project-a",
    conversationId: "chat-a",
    archived: false,
  };
  const leases = new Map();
  const stageStarted = deferred();
  const finishStage = deferred();
  let staged = 0;
  const app = Fastify();
  t.after(() => app.close());
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  registerAttachmentRoutes(app, {
    store: { getAgent: () => agent },
    assets: {
      stage: async () => {
        staged += 1;
        stageStarted.resolve();
        await finishStage.promise;
        return { id: "asset-a", projectId: agent.projectId, agentId: agent.id };
      },
    },
    agentDeliveryLeases: leases,
    agentDeletionInProgress: () => false,
    deletingAttachmentKeys: new Set(),
    reconcilingAssetAgentIds: new Set(),
  });

  const upload = app.inject({
    method: "POST",
    url: `/api/agents/${agent.id}/attachments`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("data"),
  });
  await stageStarted.promise;
  assert.equal(leases.get(agent.id), 1);
  finishStage.resolve();
  assert.equal((await upload).statusCode, 201);
  assert.equal(leases.has(agent.id), false);

  agent.archived = true;
  const rejected = await app.inject({
    method: "POST",
    url: `/api/agents/${agent.id}/attachments`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("data"),
  });
  assert.equal(rejected.statusCode, 404);
  assert.equal(staged, 1);
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
    agentDeletionInProgress: () => false,
    deletingAttachmentKeys: new Set(),
    reconcilingAssetAgentIds: new Set(),
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
    agentDeletionInProgress: () => false,
    deletingAttachmentKeys,
    reconcilingAssetAgentIds: new Set(),
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
    text: "#everyone hello",
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
  assert.equal(response.json().audience, "mention");
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
    ["/api/conversations/chat-a/messages", { text: 1, attachments: [{ id: "asset-a", agentId: "agent-a" }], idempotencyKey: "bad-text" }],
    ["/api/conversations/chat-a/messages", { text: "hello", role: "assistant", idempotencyKey: "bad-role" }],
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
