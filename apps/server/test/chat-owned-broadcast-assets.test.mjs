import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { ASSET_LIMITS, AssetStore, prepareAssetUpload } from "../dist/assets.js";
import { createCommunicationProjectionReconciler } from "../dist/communication-projection-reconciler.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { registerConversationDeliveryRoutes } from "../dist/routes/conversation-deliveries.js";
import { registerBodyParsers } from "../dist/server-request-hooks.js";

test("a Chat with no Agent owns Broadcast media, fences another Chat, and cleans it on deletion", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-chat-media-"));
  const store = new AgentStore(dataDir);
  const assets = new AssetStore(dataDir, { portableFiles: true });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    assets.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.createProject({ label: "Media", hostPath: dataDir, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Empty Chat" });
  const otherChat = store.createConversation(project.id, { title: "Other Chat" });
  assert.deepEqual(store.listAgents(project.id), []);
  const coordinationV3 = new CoordinationV3Store(store.sqlite, { attachmentAuthority: {
    resolve: (projectId, ownerId, id) => assets.authoritativeRuntimeAttachment(projectId, ownerId, id),
    reserveCommunication: (id, bindings) => assets.reserveRuntimeCommunication(id, bindings),
    compensateCommunication: (receipt) => assets.compensateRuntimeCommunicationReservation(receipt),
  } });
  const conversationDeliveryLeases = new Map();
  const agentDeliveryLeases = new Map();
  const deletingAttachmentKeys = new Set();
  registerBodyParsers(app);
  registerAttachmentRoutes(app, {
    store,
    assets,
    agentDeliveryLeases,
    conversationDeliveryLeases,
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    deletingAttachmentKeys,
    reconcilingAssetAgentIds: new Set(),
  });
  app.post("/api/unrelated", async () => ({ accepted: true }));
  const image = await sharp({ create: { width: 5, height: 5, channels: 3, background: "red" } }).png().toBuffer();
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/attachments`,
    headers: {
      "content-type": "application/x-ponderosa-attachment",
      "x-ponderosa-filename": "table.png",
      "x-ponderosa-media-type": "image/png",
    },
    payload: image,
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const staged = uploaded.json();
  assert.equal(staged.conversationId, chat.id);
  assert.equal(staged.agentId, chat.id);
  assert.equal(staged.previewUrl, `/api/conversations/${chat.id}/assets/${staged.id}/preview`);
  assert.equal((await app.inject({ method: "GET", url: staged.previewUrl })).statusCode, 200);
  const download = await app.inject({ method: "GET", url: staged.downloadUrl });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, image);
  assert.equal((await app.inject({
    method: "GET", url: `/api/conversations/${otherChat.id}/assets/${staged.id}/download`,
  })).statusCode, 404);
  assert.equal((await app.inject({
    method: "POST", url: "/api/unrelated",
    headers: { "content-type": "application/x-ponderosa-attachment" }, payload: image,
  })).statusCode, 415);
  const reconciler = createCommunicationProjectionReconciler({
    store, coordinationV3, assets,
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    attachmentDeletionInProgress: (ownerId, id) => deletingAttachmentKeys.has(`${ownerId}\0${id}`),
    assetReconciliationInProgress: () => false,
    conversationDeliveryLeases, agentDeliveryLeases,
    recordCommunication: (event) => store.appendCommunicationEvent(event).event,
    projectCommunicationArtifact: () => {},
    communicationArtifactAccess: () => ({}),
    scheduleCommunicationReconciliation: () => {},
    logError: (_meta, message) => { throw new Error(message); },
    logInfo: () => {},
    projectCommunicationToAgentAudit: () => {},
  });
  const deliveryApp = Fastify();
  t.after(() => deliveryApp.close());
  registerConversationDeliveryRoutes(deliveryApp, {
    withMessagePresentation: (_projectId, messages) => messages,
    store,
    coordinationV3,
    assets,
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    attachmentDeletionInProgress: () => false,
    assetReconciliationInProgress: () => false,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    assetMetadata: (ownerId, id) => assets.read(project.id, ownerId, id),
    prepareUserCommunicationText: async ({ text }) => ({ canonicalText: text, publishedText: text }),
    reconcileRuntimeCommunicationProjections: reconciler.reconcileRuntimeCommunicationProjections,
    appendWorkspace: () => {},
    publishCoordinationV3Changed: () => {},
    notifyScheduler: () => {},
  });
  const send = () => deliveryApp.inject({
    method: "POST", url: `/api/conversations/${chat.id}/messages`,
    payload: { text: "#broadcast Table pictures", attachments: [staged], idempotencyKey: "one-broadcast" },
  });
  const sent = await send();
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(coordinationV3.runtimeCommunication(sent.json().communicationEventId).payload.communication.attachments[0].conversationId, chat.id);
  const laterAgent = store.createAgent(project.id, { title: "Later reader", engine: "codex", conversationId: chat.id });
  assert.equal(laterAgent.conversationId, chat.id);
  const historicalBroadcast = store.getOrganizationalConversationContextSourcePage(chat.id, { limit: 20 })
    .items.find((message) => message.communicationEventId === sent.json().communicationEventId);
  assert.equal(historicalBroadcast?.attachments?.[0]?.conversationId, chat.id);
  const replay = await send();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().communicationEventId, sent.json().communicationEventId);
  const wrongChat = await deliveryApp.inject({ method: "POST", url: `/api/conversations/${otherChat.id}/messages`,
    payload: { text: "#broadcast wrong Chat", attachments: [staged], idempotencyKey: "wrong-chat" } });
  assert.equal(wrongChat.statusCode, 400, wrongChat.body);
  const changedReplay = await deliveryApp.inject({ method: "POST", url: `/api/conversations/${chat.id}/messages`,
    payload: { text: "#broadcast different message", attachments: [staged], idempotencyKey: "one-broadcast" } });
  assert.equal(changedReplay.statusCode, 409, changedReplay.body);
  assert.equal((await app.inject({ method: "GET", url: staged.downloadUrl })).statusCode, 200);
  const reopened = new AssetStore(dataDir, { portableFiles: true });
  try {
    assert.deepEqual((await reopened.content(project.id, chat.id, staged.id, false))?.body, image);
  } finally { reopened.close(); }
  await assets.purgeConversationAssets(project.id, chat.id);
  assert.equal(await assets.read(project.id, chat.id, staged.id), undefined);
  assert.equal((await app.inject({ method: "GET", url: staged.downloadUrl })).statusCode, 404);
});

test("one file may reach 80 MiB exactly and remains readable through portable retained storage", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-eighty-mib-"));
  const assets = new AssetStore(dataDir, { portableFiles: true });
  t.after(async () => { assets.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectId = randomUUID();
  const agentId = randomUUID();
  const body = Buffer.alloc(ASSET_LIMITS.maxFileBytes, 0x61);
  body.write("%PDF-", 0, "ascii");
  const staged = await assets.stage({ projectId, agentId, body, name: "large.pdf", declaredType: "application/pdf" });
  assert.equal(staged.size, ASSET_LIMITS.maxFileBytes);
  assert.deepEqual((await assets.content(projectId, agentId, staged.id, false))?.body, body);
  const reopened = new AssetStore(dataDir, { portableFiles: true });
  try {
    assert.deepEqual((await reopened.content(projectId, agentId, staged.id, false))?.body, body);
  } finally { reopened.close(); }
  await assert.rejects(prepareAssetUpload({ body: Buffer.alloc(ASSET_LIMITS.maxFileBytes + 1), name: "too-large.pdf" }), /80 MiB limit/u);
});

test("large attachment parsing is route-scoped and admits only two concurrent uploads", async (t) => {
  const chat = { id: randomUUID(), projectId: randomUUID(), archived: false };
  const app = Fastify();
  t.after(() => app.close());
  registerBodyParsers(app);
  let started = 0;
  let notifyStarted;
  const bothStarted = new Promise((resolve) => { notifyStarted = resolve; });
  let releaseUploads;
  const uploadsReleased = new Promise((resolve) => { releaseUploads = resolve; });
  registerAttachmentRoutes(app, {
    store: { getConversation: () => chat, getAgent: () => undefined },
    assets: { stage: async ({ body }) => {
      if (++started === 2) notifyStarted();
      await uploadsReleased;
      return { id: randomUUID(), size: body.length };
    } },
    agentDeliveryLeases: new Map(), conversationDeliveryLeases: new Map(),
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    deletingAttachmentKeys: new Set(), reconcilingAssetAgentIds: new Set(),
  });
  app.post("/api/other", async () => ({ accepted: true }));
  const send = (body) => app.inject({ method: "POST", url: `/api/conversations/${chat.id}/attachments`,
    headers: { "content-type": "application/x-ponderosa-attachment" }, payload: body });
  const large = Buffer.alloc(9 * 1024 * 1024, 0x61);
  const first = send(large);
  const second = send(Buffer.from("second"));
  await bothStarted;
  const third = await send(Buffer.from("third"));
  assert.equal(third.statusCode, 503, third.body);
  assert.equal(third.json().code, "attachment_upload_busy");
  assert.equal(third.headers["retry-after"], "1");
  assert.equal(started, 2);
  releaseUploads();
  assert.equal((await first).statusCode, 201);
  assert.equal((await second).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/api/other",
    headers: { "content-type": "application/x-ponderosa-attachment" }, payload: large })).statusCode, 415);
});
