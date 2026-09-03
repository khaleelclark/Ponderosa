import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import {
  publishManagedArtifactContentAsync,
  readManagedArtifactContent,
} from "@ponderosa/agents";
import {
  conversationDeliveryRequestFingerprint,
  registerConversationDeliveryRoutes,
} from "../dist/routes/conversation-deliveries.js";
import { registerConversationRoutes } from "../dist/routes/conversations.js";
import { registerAgentMaintenanceRoutes } from "../dist/routes/agent-maintenance.js";
import { registerCollaborationRoutes } from "../dist/routes/collaboration.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { registerAgentCreationRoutes } from "../dist/routes/agent-creation.js";
import { registerAgentMessageRunRoute } from "../dist/routes/agent-message-run.js";
import { registerAgentRequestCommandRoutes } from "../dist/routes/agent-request-commands.js";
import { registerAgentCoordinationRoutes } from "../dist/routes/agent-coordination.js";
import { registerAgentCommunicationRoutes } from "../dist/routes/agent-communications.js";
import { registerQueuedMessageRoutes } from "../dist/routes/queued-messages.js";
import {
  leaseAgentAssetReconciliation,
  recoverCanonicalAgentCreations,
} from "../dist/server-lifecycle.js";
import { leaseAgentDelivery } from "../dist/delivery-leases.js";
import { createCommunicationProjectionReconciler } from "../dist/communication-projection-reconciler.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function agentCreationJournal() {
  let operation;
  const normalizePatch = (patch) => ({
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.communicationEventId !== undefined ? { communicationEventId: patch.communicationEventId } : {}),
    ...(patch.artifactIds !== undefined ? { artifactIds: patch.artifactIds } : {}),
    ...(patch.artifactIdentities !== undefined ? { artifactIdentities: patch.artifactIdentities } : {}),
    ...(patch.result !== undefined ? { result: patch.result } : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
  });
  return {
    sqlite: { transaction: (callback) => () => callback() },
    beginAgentCreationOperation: (input) => {
      if (operation && operation.payloadHash !== input.payloadHash) {
        throw new Error("Agent creation idempotency key was reused with different input");
      }
      operation ??= {
        id: "creation-operation-a",
        ...input,
        status: "preparing",
        agentIds: [],
        artifactIds: [],
        artifactIdentities: [],
        communicationEventId: undefined,
        result: undefined,
        lastError: null,
      };
      return { operation, replayed: Boolean(operation.agentIds.length) };
    },
    addAgentCreationOperationMember: (_operationId, agentId) => {
      operation.agentIds.push(agentId);
      return operation;
    },
    updateAgentCreationOperation: (_operationId, patch) => {
      Object.assign(operation, normalizePatch(patch));
      return operation;
    },
    getAgentCreationOperation: () => operation,
  };
}

test("Agent delivery leases deduplicate owners and release idempotently", () => {
  const leases = new Map();
  const release = leaseAgentDelivery(leases, ["agent-a", "agent-a", "agent-b"]);
  assert.deepEqual([...leases], [["agent-a", 1], ["agent-b", 1]]);
  release();
  release();
  assert.equal(leases.size, 0);
});

test("delivery fingerprints ignore JSON object insertion order", () => {
  assert.equal(
    conversationDeliveryRequestFingerprint({
      recipientAttachments: [{ agentId: "agent-a", attachmentIds: ["asset-a"] }],
    }),
    conversationDeliveryRequestFingerprint({
      recipientAttachments: [{ attachmentIds: ["asset-a"], agentId: "agent-a" }],
    }),
  );
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
      ...agentCreationJournal(),
      getProject: () => project,
      getConversation: () => chat,
      createAgent: (_projectId, _input, _preset, id) => {
        agent.id = id;
        return agent;
      },
      getAgent: () => undefined,
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

function agentCreationTransactionApp({
  dataDir = "/tmp",
  stage = async () => { throw new Error("unexpected attachment stage"); },
  prepared = async () => ({ body: Buffer.from("x"), prepared: {} }),
  prepareUserCommunicationText = async ({ text }) => ({ publishedText: text }),
  recordRuntimeCommunication = () => { throw new Error("unexpected opening communication"); },
  reconcileRuntimeCommunicationProjections = async () => 1,
} = {}) {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const project = { id: chat.projectId, defaultEngine: "codex" };
  const agent = {
    id: "agent-a",
    projectId: project.id,
    conversationId: chat.id,
    activeEngine: "codex",
    handle: "AgentA",
    archived: false,
  };
  let created = false;
  let deleted = false;
  const removed = [];
  const deletingAgentIds = new Set();
  const app = Fastify();
  const journal = agentCreationJournal();
  registerAgentCreationRoutes(app, {
    dataDir,
    store: {
      ...journal,
      getProject: () => project,
      getConversation: () => chat,
      findAgentCreation: () => created ? agent : undefined,
      createAgent: (_projectId, _input, _preset, id) => {
        created = true;
        agent.id = id;
        return agent;
      },
      getAgent: (id) => created && id === agent.id ? agent : undefined,
      deleteAgent: () => {
        created = false;
        deleted = true;
        return true;
      },
    },
    coordinationV3: {
      handleAgentDeletion: () => {},
      recordRuntimeCommunication,
    },
    workspace: { getPreferences: () => ({}) },
    assets: {
      stage,
      remove: async (_projectId, _agentId, id) => {
        removed.push(id);
        return true;
      },
      associate: async () => [],
      authoritativeRuntimeArtifactMetadataById: () => undefined,
      removeRuntimeArtifactReservation: () => false,
    },
    drafts: {
      normalizedOwner: () => "owner-a",
      prepared,
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
    agentDeliveryLeases: new Map(),
    cachedModelOptions: () => [],
    prepareUserCommunicationText,
    reconcileRuntimeCommunicationProjections,
    publishMessageDeliveryChanged: () => {},
    notifyScheduler: () => {},
  });
  return {
    agent,
    app,
    chat,
    deletingAgentIds,
    removed,
    creationOperation: () => journal.getAgentCreationOperation(),
    wasDeleted: () => deleted,
  };
}

test("completed Agent creation replays before destination Chat validation", async (t) => {
  const { app, chat } = agentCreationTransactionApp();
  t.after(() => app.close());
  const payload = {
    title: "Agent A",
    engine: "codex",
    conversationId: chat.id,
    idempotencyKey: "stable-create",
    managementPermissions: {
      allowAutomaticDescendantDeletion: true,
      allowAutomaticDescendantReorganization: false,
    },
  };
  const first = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload: {
      ...payload,
      managementPermissions: {
        allowAutomaticDescendantReorganization: false,
        allowAutomaticDescendantDeletion: true,
      },
    },
  });
  assert.equal(first.statusCode, 200);
  chat.archived = true;
  const replay = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().id, first.json().id);
});

test("deterministic Agent creation rejection leaves no preparing operation", async (t) => {
  const { app, creationOperation } = agentCreationTransactionApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload: {
      title: "Agent A",
      engine: "codex",
      conversationId: "chat-a",
      idempotencyKey: "invalid-drafts",
      draftOwnerId: "owner-a",
      draftAttachmentIds: ["same", "same"],
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(creationOperation(), undefined);
});

test("mutable Agent creation validation rolls back its mutation-free journal", async (t) => {
  const { app, creationOperation } = agentCreationTransactionApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload: {
      title: "Agent A",
      engine: "removed-engine",
      conversationId: "chat-a",
      idempotencyKey: "invalid-engine",
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(creationOperation().status, "rolled_back");
});

test("canonical Agent creation recovery retries live and clears quarantine", async () => {
  const operation = {
    id: "operation-a",
    projectId: "project-a",
    actorScope: "user:local-operator",
    kind: "human",
    idempotencyKey: "create-once",
    payloadHash: "hash-a",
    status: "canonical_committed",
    agentIds: ["agent-a"],
    artifactIds: [],
    artifactIdentities: [],
    communicationEventId: "opening-a",
  };
  const deletingAgentIds = new Set(operation.agentIds);
  let attempts = 0;
  const store = {
    listRecoverableAgentCreationOperations: () =>
      operation.status === "completed" ? [] : [operation],
    updateAgentCreationOperation: (_id, patch) => Object.assign(operation, patch),
  };
  const reconcileRuntimeCommunicationProjections = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient projection failure");
    return 1;
  };
  const first = await recoverCanonicalAgentCreations({
    store,
    deletingAgentIds,
    reconcileRuntimeCommunicationProjections,
  });
  assert.equal(first.failures.length, 1);
  assert.equal(operation.status, "canonical_committed");
  assert.equal(deletingAgentIds.has("agent-a"), true);
  const second = await recoverCanonicalAgentCreations({
    store,
    deletingAgentIds,
    reconcileRuntimeCommunicationProjections,
  });
  assert.equal(second.recovered, 1);
  assert.equal(operation.status, "completed");
  assert.equal(deletingAgentIds.has("agent-a"), false);
});

test("an idempotent Agent creation retry cannot replay an in-flight opening", async (t) => {
  const stageStarted = deferred();
  const finishStage = deferred();
  const { agent, app, deletingAgentIds } = agentCreationTransactionApp({
    stage: async () => {
      stageStarted.resolve();
      await finishStage.promise;
      throw new Error("opening failed");
    },
  });
  t.after(() => app.close());
  const payload = {
    title: "Agent A",
    engine: "codex",
    conversationId: "chat-a",
    draftAttachmentIds: ["draft-a"],
    draftOwnerId: "owner-a",
    idempotencyKey: "create-once",
  };
  const first = app.inject({ method: "POST", url: "/api/projects/project-a/agents", payload });
  await stageStarted.promise;
  assert.equal(deletingAgentIds.has(agent.id), true);
  const retry = await app.inject({ method: "POST", url: "/api/projects/project-a/agents", payload });
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json().operationId, "creation-operation-a");
  finishStage.resolve();
  assert.equal((await first).statusCode, 409);
});

test("an exact retry cannot race creation before its Agent member is recorded", async (t) => {
  const preparationStarted = deferred();
  const finishPreparation = deferred();
  const { app } = agentCreationTransactionApp({
    prepared: async () => {
      preparationStarted.resolve();
      await finishPreparation.promise;
      return { body: Buffer.from("x"), prepared: {} };
    },
  });
  t.after(() => app.close());
  const payload = {
    title: "Agent A",
    engine: "codex",
    conversationId: "chat-a",
    draftAttachmentIds: ["draft-a"],
    draftOwnerId: "owner-a",
    idempotencyKey: "create-once",
  };
  const first = app.inject({ method: "POST", url: "/api/projects/project-a/agents", payload });
  await preparationStarted.promise;
  const retry = await app.inject({ method: "POST", url: "/api/projects/project-a/agents", payload });
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json().operationId, "creation-operation-a");
  finishPreparation.resolve();
  assert.equal((await first).statusCode, 409);
});

test("draft preparation rejection immediately settles a mutation-free Agent creation", async (t) => {
  const { app, creationOperation } = agentCreationTransactionApp({
    prepared: async () => { throw new Error("draft storage unavailable"); },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload: {
      title: "Agent A",
      engine: "codex",
      conversationId: "chat-a",
      draftAttachmentIds: ["draft-a"],
      draftOwnerId: "owner-a",
      idempotencyKey: "create-once",
    },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(creationOperation().status, "rolled_back");
  assert.deepEqual(creationOperation().agentIds, []);
});

test("a failed post-create opening rolls back the partial Agent", async (t) => {
  const { agent, app, deletingAgentIds, removed, wasDeleted } = agentCreationTransactionApp({
    stage: async () => ({
      id: "opening-asset",
      name: "opening.txt",
      mediaType: "text/plain",
      size: 1,
      state: "staged",
    }),
    recordRuntimeCommunication: () => { throw new Error("runtime intake failed"); },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload: {
      title: "Agent A",
      engine: "codex",
      conversationId: "chat-a",
      initialMessage: "start work",
      draftAttachmentIds: ["draft-a"],
      draftOwnerId: "owner-a",
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(wasDeleted(), true);
  assert.deepEqual(removed, ["opening-asset"]);
  assert.equal(deletingAgentIds.has(agent.id), false);
});

test("a failed Agent opening removes its exact pre-canonical managed artifact", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-agent-opening-"));
  const content = Buffer.from("durable opening text");
  const identity = {
    id: "opening-long-text",
    byteLength: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  const { app } = agentCreationTransactionApp({
    dataDir,
    prepareUserCommunicationText: async ({ beforeArtifactPublish }) => {
      beforeArtifactPublish(identity);
      await publishManagedArtifactContentAsync(dataDir, "project-a", identity.id, content);
      return { publishedText: "[Opening text]" };
    },
    recordRuntimeCommunication: () => { throw new Error("runtime intake failed"); },
  });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload: {
      title: "Agent A",
      engine: "codex",
      conversationId: "chat-a",
      initialMessage: "long opening",
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(readManagedArtifactContent(
    dataDir,
    "project-a",
    identity.id,
    identity.byteLength,
    identity.sha256,
  ), undefined);
});

test("a committed Agent stays quarantined while projection recovery is pending", async (t) => {
  const { agent, app, deletingAgentIds } = agentCreationTransactionApp({
    recordRuntimeCommunication: () => {},
    reconcileRuntimeCommunicationProjections: async () => {
      throw new Error("projection unavailable");
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agents",
    payload: {
      title: "Agent A",
      engine: "codex",
      conversationId: "chat-a",
      initialMessage: "start work",
    },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    committed: true,
    recovering: true,
    operationId: "creation-operation-a",
    agentId: agent.id,
  });
  assert.equal(deletingAgentIds.has(agent.id), true);
});

function agentMessageValidationApp({
  assetMetadata = async () => undefined,
  agentOverrides = {},
  coordinationV3 = {},
  reconcileRuntimeCommunicationProjections = async () => 0,
  agentPresent = true,
} = {}) {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const project = { id: chat.projectId, defaultEngine: "codex" };
  const agent = {
    id: "agent-a",
    projectId: project.id,
    conversationId: chat.id,
    activeEngine: "codex",
    archived: false,
    ...agentOverrides,
  };
  const staged = [];
  const removed = [];
  const app = Fastify();
  registerAgentMessageRunRoute(app, {
    store: {
      getAgent: () => agentPresent ? agent : undefined,
      getAgentProjectId: () => project.id,
      getProject: () => project,
      getConversation: (id) => id === chat.id ? chat : undefined,
      getRuns: () => [],
    },
    workspace: { getPreferences: () => ({}) },
    coordinationV3,
    assets: {
      stage: async () => {
        const asset = { id: "asset-a", name: "a.txt", mediaType: "text/plain", size: 1, state: "staged" };
        staged.push(asset.id);
        return asset;
      },
      remove: async (_projectId, _agentId, id) => {
        removed.push(id);
        return true;
      },
    },
    drafts: {
      normalizedOwner: () => "owner-a",
      validId: () => true,
      prepared: async () => ({ body: Buffer.from("x"), prepared: {} }),
    },
    engines: new Map([["codex", {
      adapter: {
        id: "codex",
        listModels: () => [],
        listEfforts: () => [],
      },
    }]]),
    activeRuns: new Map(),
    agentMessageCapabilities: new Map(),
    deletingProjectIds: new Set(),
    deletingAgentIds: new Set(),
    conversationDeletionInProgress: () => false,
    attachmentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    assetReconciliationInProgress: () => false,
    v3DispatchKey: "dispatch-key",
    reusableRuntime: () => undefined,
    assetMetadata,
    reconcileRuntimeCommunicationProjections,
    cachedModelOptions: () => [],
  });
  return { app, removed, staged };
}

function agentCommunicationArtifactApp({
  stageCommunicationArtifact,
  recordRuntimeCommunication,
  runtimeArtifact = () => undefined,
}) {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const agent = {
    id: "agent-a", projectId: chat.projectId, conversationId: chat.id,
    title: "Agent A", archived: false,
  };
  const removed = [];
  const app = Fastify();
  registerAgentCommunicationRoutes(app, {
    store: {
      getAgent: () => agent,
      getConversation: () => chat,
    },
    coordinationV3: {
      steeringInjectionIds: () => [],
      latestAcknowledgedSteeringInjection: () => undefined,
      requiredReplyAuthoritiesForRun: () => [],
      runtimeCommunication: () => undefined,
      runtimeArtifact,
      recordRuntimeCommunication,
    },
    workspace: {},
    agentMessageCapabilities: new Map([["token", {
      agentId: agent.id,
      runId: "run-a",
      conversationId: chat.id,
      mentionDepth: 0,
      mentionTrail: [],
    }]]),
    activeRuns: new Map([[agent.id, { messageCapability: "token" }]]),
    projectDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    capabilityOwnsAuthoritativeRun: () => true,
    runAuthorization: () => ({ runId: "run-a", agentId: agent.id, fencingToken: 1 }),
    resolveExplicitCollaborationIntents: () => ({ text: "", intents: [], blocked: [] }),
    appendBlockedMentionWarnings: () => {},
    runtimeArtifactMetadata: (artifact) => artifact,
    stageCommunicationArtifact,
    removeRuntimeArtifactReservation: (_projectId, artifactId) => { removed.push(artifactId); },
    publishCoordinationV3Changed: () => {},
    reconcileRuntimeCommunicationProjections: async () => 0,
    resolveOperationalNotification: () => {},
    notifyScheduler: () => {},
  });
  return { app, removed };
}

function preparedArtifact(id, reservationCreated = true) {
  return {
    id,
    role: "long_text",
    title: "Agent response",
    mediaType: "text/markdown",
    blobPath: `communication/${id}.md`,
    blobHash: "a".repeat(64),
    byteLength: 70_000,
    originAgentId: "agent-a",
    executionId: "run-a",
    createdAt: new Date().toISOString(),
    ...(reservationCreated ? { reservationCreated: true } : {}),
  };
}

test("Agent communication releases its own artifact after partial staging failure", async (t) => {
  let calls = 0;
  const first = preparedArtifact("artifact-first");
  const { app, removed } = agentCommunicationArtifactApp({
    stageCommunicationArtifact: async () => {
      calls += 1;
      if (calls === 1) return first;
      throw new Error("second artifact failed");
    },
    recordRuntimeCommunication: () => { throw new Error("must not commit"); },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-messages",
    headers: { authorization: "Bearer token" },
    payload: {
      intent: "direct_to_user",
      text: "x".repeat(70_000),
      document: { title: "Separate document", content: "different" },
      idempotencyKey: "partial-stage",
    },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(removed, [first.id]);
});

test("Agent communication compensates only its own uncatalogued reservation after a Run fence", async (t) => {
  const cases = [
    { reservationCreated: true, canonical: false, expectedRemoved: ["artifact-a"] },
    { reservationCreated: false, canonical: false, expectedRemoved: [] },
    { reservationCreated: true, canonical: true, expectedRemoved: [] },
  ];
  for (const { reservationCreated, canonical, expectedRemoved } of cases) {
    const artifact = preparedArtifact("artifact-a", reservationCreated);
    const { app, removed } = agentCommunicationArtifactApp({
      stageCommunicationArtifact: async () => artifact,
      recordRuntimeCommunication: () => { throw new Error("Run authorization is fenced"); },
      runtimeArtifact: () => canonical ? artifact : undefined,
    });
    t.after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: "Bearer token" },
      payload: {
        intent: "direct_to_user",
        text: "x".repeat(70_000),
        idempotencyKey: `fenced-${reservationCreated}`,
      },
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(removed, expectedRemoved);
  }
});

test("invalid mention metadata is rejected before draft promotion", async (t) => {
  const { app, staged } = agentMessageValidationApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/agent-a/messages",
    payload: {
      text: "hello",
      agentMentionDepth: 65,
      draftAttachmentIds: ["draft-a"],
      draftId: "draft-surface",
      draftOwnerId: "owner-a",
    },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(staged, []);
});

test("a promoted draft is removed when later attachment validation rejects delivery", async (t) => {
  const { app, removed, staged } = agentMessageValidationApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/agent-a/messages",
    payload: {
      text: "hello",
      draftAttachmentIds: ["draft-a"],
      draftId: "draft-surface",
      draftOwnerId: "owner-a",
    },
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(staged, ["asset-a"]);
  assert.deepEqual(removed, ["asset-a"]);
});

test("an exact direct Agent-message retry replays after the Agent is archived", async (t) => {
  const payload = { text: "hello", idempotencyKey: "stable-message", activeRunDelivery: "queue" };
  const communicationEventId = `user-message-${createHash("sha256")
    .update(`project-a\0agent-a\0${payload.idempotencyKey}`)
    .digest("hex")}`;
  const requestFingerprint = conversationDeliveryRequestFingerprint({
    version: 1,
    agentId: "agent-a",
    text: payload.text,
    idempotencyKey: payload.idempotencyKey,
    model: null,
    effort: null,
    speed: null,
    sourceChannel: null,
    sourceConversationId: null,
    shareWithOrganization: false,
    activeRunDelivery: "queue",
    attachmentIds: [],
    draftAttachmentIds: [],
    draftId: null,
    draftOwnerId: null,
    agentMentionDepth: 0,
    agentMentionTrail: [],
  });
  let reconciliations = 0;
  const { app } = agentMessageValidationApp({
    agentOverrides: { archived: true },
    coordinationV3: {
      runtimeCommunication: (id) => id === `dispatch:${communicationEventId}:agent-a`
        ? {
            id: communicationEventId,
            projectId: "project-a",
            payload: {
              requestFingerprint,
              communication: {
                eventId: communicationEventId,
                projectId: "project-a",
                conversationId: "chat-a",
                sender: { kind: "user", userId: "local-operator" },
                intent: "user_dm",
                audience: { kind: "user_agent", userId: "local-operator", agentId: "agent-a" },
                text: payload.text,
              },
            },
            activations: [{ id: "delivery-a", agentId: "agent-a" }],
          }
        : undefined,
      activation: () => ({ id: "delivery-a", projectId: "project-a", agentId: "agent-a", state: "pending" }),
      pendingActivations: () => [{ id: "delivery-a", agentId: "agent-a" }],
    },
    reconcileRuntimeCommunicationProjections: async () => { reconciliations += 1; return 1; },
  });
  t.after(() => app.close());

  const replay = await app.inject({
    method: "POST",
    url: "/api/agents/agent-a/messages",
    payload,
  });
  assert.equal(replay.statusCode, 202);
  assert.deepEqual(replay.json(), {
    queued: true,
    position: 1,
    deliveryId: "delivery-a",
    communicationEventId,
  });
  assert.equal(reconciliations, 1);

  const collision = await app.inject({
    method: "POST",
    url: "/api/agents/agent-a/messages",
    payload: { ...payload, text: "different" },
  });
  assert.equal(collision.statusCode, 409);
});

test("an exact direct Agent-message retry replays after permanent Agent deletion", async (t) => {
  const payload = { text: "hello", idempotencyKey: "deleted-replay", activeRunDelivery: "queue" };
  const communicationEventId = `user-message-${createHash("sha256")
    .update(`project-a\0agent-a\0${payload.idempotencyKey}`)
    .digest("hex")}`;
  const requestFingerprint = conversationDeliveryRequestFingerprint({
    version: 1,
    agentId: "agent-a",
    text: payload.text,
    idempotencyKey: payload.idempotencyKey,
    model: null,
    effort: null,
    speed: null,
    sourceChannel: null,
    sourceConversationId: null,
    shareWithOrganization: false,
    activeRunDelivery: "queue",
    attachmentIds: [],
    draftAttachmentIds: [],
    draftId: null,
    draftOwnerId: null,
    agentMentionDepth: 0,
    agentMentionTrail: [],
  });
  const { app } = agentMessageValidationApp({
    agentPresent: false,
    coordinationV3: {
      runtimeCommunication: () => ({
        projectId: "project-a",
        payload: { requestFingerprint, communication: { conversationId: "chat-a" } },
        activations: [{ id: "delivery-a", agentId: "agent-a" }],
      }),
      activation: () => ({ id: "delivery-a", projectId: "project-a", agentId: "agent-a", state: "pending" }),
      pendingActivations: () => [{ id: "delivery-a", agentId: "agent-a" }],
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/agents/agent-a/messages", payload });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().communicationEventId, communicationEventId);
});

test("an exact direct Agent-message retry reports a consumed delivery as settled", async (t) => {
  const payload = { text: "hello", idempotencyKey: "settled-replay", activeRunDelivery: "queue" };
  const communicationEventId = `user-message-${createHash("sha256")
    .update(`project-a\0agent-a\0${payload.idempotencyKey}`)
    .digest("hex")}`;
  const requestFingerprint = conversationDeliveryRequestFingerprint({
    version: 1,
    agentId: "agent-a",
    text: payload.text,
    idempotencyKey: payload.idempotencyKey,
    model: null,
    effort: null,
    speed: null,
    sourceChannel: null,
    sourceConversationId: null,
    shareWithOrganization: false,
    activeRunDelivery: "queue",
    attachmentIds: [],
    draftAttachmentIds: [],
    draftId: null,
    draftOwnerId: null,
    agentMentionDepth: 0,
    agentMentionTrail: [],
  });
  const { app } = agentMessageValidationApp({
    coordinationV3: {
      runtimeCommunication: () => ({
        projectId: "project-a",
        payload: { requestFingerprint, communication: { conversationId: "chat-a" } },
        activations: [{ id: "delivery-a", agentId: "agent-a" }],
      }),
      activation: () => ({ id: "delivery-a", projectId: "project-a", agentId: "agent-a", state: "consumed" }),
      pendingActivations: () => [],
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/agents/agent-a/messages", payload });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    queued: false,
    settled: true,
    replayed: true,
    deliveryId: "delivery-a",
    deliveryState: "delivered",
    communicationEventId,
  });
});

test("request-update replay precedes long-text staging and mutable participant checks", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerAgentRequestCommandRoutes(app, {
    store: { getAgent: () => undefined },
    coordinationV3: {
      steeringInjectionIds: () => [],
      requestIdsAttachedToRun: () => ["request-a"],
      getRequest: () => ({
        id: "request-a",
        projectId: "project-a",
        conversationId: "chat-a",
        recipientAgentId: "agent-a",
        state: "completed",
        version: 1,
        payload: {},
      }),
      requestLifecycleDetails: () => ({ updates: [] }),
      replayRequestUpdate: () => ({ requestId: "request-a", state: "completed", version: 1, replayed: true }),
    },
    agentMessageCapabilities: new Map([["token", { agentId: "agent-a", runId: "run-a", v3SchedulerRunId: "run-a" }]]),
    activeRuns: new Map([["agent-a", { messageCapability: "token" }]]),
    projectDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    capabilityMatchesCleanupRun: () => true,
    runAuthorization: () => ({ runId: "run-a", agentId: "agent-a", fencingToken: 1 }),
    projectCommunicationArtifact: () => {},
    requestArtifactAccess: () => ({}),
    runtimeArtifactMetadata: () => ({}),
    stageCommunicationArtifact: async () => { throw new Error("unexpected staging"); },
    removeRuntimeArtifactReservation: () => {},
    recordCommunication: (event) => event,
    projectCommunicationToAgentAudit: () => {},
    publishCoordinationV3Changed: () => {},
    notifyScheduler: () => {},
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-request-updates",
    headers: { authorization: "Bearer token" },
    payload: {
      requestId: "request-a",
      updateId: "update-a",
      kind: "completed",
      text: "x".repeat(70_000),
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().replayed, true);
});

test("coordinate replay precedes mutable recipient checks", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const author = { id: "author-a", projectId: "project-a", conversationId: "chat-a", archived: false };
  let replayed = false;
  registerAgentCoordinationRoutes(app, {
    store: {
      getAgent: (id) => id === author.id ? author : undefined,
      getConversationMessages: () => [],
      appendConversationMessage: () => {},
    },
    coordinationV3: {
      steeringInjectionIds: () => [],
      replayCoordinate: () => { replayed = true; return { requestIds: ["request-a"], replayed: true }; },
      getRequest: () => ({ conversationId: "chat-a" }),
      requestDelivery: () => undefined,
    },
    engines: new Map(),
    deletingAgentIds: new Set(),
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    agentMessageCapabilities: new Map([["token", {
      agentId: author.id,
      runId: "run-a",
      conversationId: "chat-a",
      mentionDepth: 0,
      mentionTrail: [],
    }]]),
    activeRuns: new Map([[author.id, { messageCapability: "token" }]]),
    cachedModelOptions: () => [],
    capabilityOwnsAuthoritativeRun: () => true,
    recordCommunication: (event) => event,
    projectCommunicationToAgentAudit: () => {},
    publishCoordinationV3Changed: () => {},
    notifyScheduler: () => {},
    runAuthorization: () => ({ runId: "run-a", agentId: author.id, fencingToken: 1 }),
    resolveExplicitCollaborationIntents: (_chatId, _authorId, recipientAgentIds, text) => ({
      text,
      intents: recipientAgentIds.map((targetAgentId) => ({ targetAgentId })),
    }),
    logWarn: () => {},
    reconcileRuntimeCommunicationProjections: async () => 0,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-coordinate",
    headers: { authorization: "Bearer token" },
    payload: {
      idempotencyKey: "coordinate-once",
      recipientAgentId: "deleted-recipient",
      text: "work",
      lifetime: { kind: "indefinite" },
      completionMode: "record",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().replayed, true);
  assert.equal(replayed, true);
});

test("managed Agent spawn replay canonicalizes input before current engine validation", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const manager = {
    id: "manager-a",
    projectId: "project-a",
    conversationId: "chat-a",
    archived: false,
  };
  const payloadHashes = [];
  registerAgentCoordinationRoutes(app, {
    store: {
      getAgent: () => manager,
      beginAgentCreationOperation: (input) => {
        payloadHashes.push(input.payloadHash);
        return {
          operation: {
            id: "spawn-operation-a",
            projectId: manager.projectId,
            actorScope: "agent:manager-a:run:run-a",
            kind: "managed",
            idempotencyKey: "stable-spawn",
            payloadHash: "ignored-by-stub",
            status: "completed",
            agentIds: ["child-a"],
            artifactIds: [],
            artifactIdentities: [],
            result: { agent: { id: "child-a" }, requestIds: ["request-a"] },
          },
        };
      },
    },
    coordinationV3: { steeringInjectionIds: () => [] },
    engines: new Map(),
    deletingAgentIds: new Set([manager.id]),
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    agentMessageCapabilities: new Map([["token", {
      agentId: manager.id,
      runId: "run-a",
      conversationId: manager.conversationId,
      mentionDepth: 0,
      mentionTrail: [],
    }]]),
    activeRuns: new Map([[manager.id, { messageCapability: "token" }]]),
    cachedModelOptions: () => [],
    capabilityOwnsAuthoritativeRun: () => true,
    reconcileRuntimeCommunicationProjections: async () => 0,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-spawn",
    headers: { authorization: "Bearer token" },
    payload: {
      idempotencyKey: "stable-spawn",
      title: "Child Agent",
      engine: "removed-engine",
      model: " model-a ",
      effort: " high ",
      text: "Do the work",
      lifetime: { kind: "deadline", at: "2026-08-30T00:00:00Z" },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().replayed, true);
  assert.equal(response.json().agent.id, "child-a");
  const reordered = await app.inject({
    method: "POST",
    url: "/api/agent-spawn",
    headers: { authorization: "Bearer token" },
    payload: {
      idempotencyKey: "stable-spawn",
      title: "Child Agent",
      engine: "removed-engine",
      model: "model-a",
      effort: "high",
      text: "Do the work",
      lifetime: { at: "2026-08-30T00:00:00Z", kind: "deadline" },
    },
  });
  assert.equal(reordered.statusCode, 200);
  assert.equal(reordered.json().replayed, true);
  assert.deepEqual(payloadHashes, [payloadHashes[0], payloadHashes[0]]);
});

test("a rejected long request update releases its staged artifact reservation", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const agent = { id: "agent-a", projectId: "project-a", conversationId: "chat-a", archived: false };
  const requestRecord = {
    id: "request-a",
    projectId: "project-a",
    conversationId: "chat-a",
    requesterAgentId: "requester-a",
    recipientAgentId: "agent-a",
    state: "awaiting_answer",
    version: 1,
    payload: {},
  };
  const removed = [];
  registerAgentRequestCommandRoutes(app, {
    store: {
      getAgent: (id) => id === "requester-a" ? { ...agent, id } : agent,
      getConversation: () => ({ id: "chat-a", projectId: "project-a", archived: false }),
    },
    coordinationV3: {
      steeringInjectionIds: () => [],
      requestIdsAttachedToRun: () => ["request-a"],
      getRequest: () => requestRecord,
      runtimeArtifact: () => undefined,
      replayRequestUpdate: () => undefined,
      updateRequest: () => { throw new Error("answer does not match the open question"); },
    },
    agentMessageCapabilities: new Map([["token", { agentId: "agent-a", runId: "run-a", v3SchedulerRunId: "run-a" }]]),
    activeRuns: new Map([["agent-a", { messageCapability: "token" }]]),
    projectDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    capabilityMatchesCleanupRun: () => true,
    runAuthorization: () => ({ runId: "run-a", agentId: "agent-a", fencingToken: 1 }),
    projectCommunicationArtifact: () => {},
    requestArtifactAccess: () => ({}),
    runtimeArtifactMetadata: (artifact) => artifact,
    stageCommunicationArtifact: async () => ({
      id: "artifact-a",
      role: "long_text",
      title: "Result",
      reservationCreated: true,
    }),
    removeRuntimeArtifactReservation: (_projectId, artifactId) => { removed.push(artifactId); },
    recordCommunication: (event) => event,
    projectCommunicationToAgentAudit: () => {},
    publishCoordinationV3Changed: () => {},
    notifyScheduler: () => {},
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-request-updates",
    headers: { authorization: "Bearer token" },
    payload: {
      requestId: "request-a",
      updateId: "update-a",
      kind: "answer",
      inReplyToUpdateId: "wrong-question",
      text: "x".repeat(70_000),
    },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(removed, ["artifact-a"]);
});

test("a failed long request-update replay preserves an existing artifact reservation", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const removed = [];
  registerAgentRequestCommandRoutes(app, {
    store: { getAgent: () => undefined },
    coordinationV3: {
      steeringInjectionIds: () => [],
      requestIdsAttachedToRun: () => ["request-a"],
      getRequest: () => ({
        id: "request-a",
        projectId: "project-a",
        conversationId: "chat-a",
        recipientAgentId: "agent-a",
        state: "completed",
        version: 1,
        payload: {},
      }),
      runtimeArtifact: (id) => ({ id }),
      replayRequestUpdate: () => { throw new Error("Run authority expired"); },
    },
    agentMessageCapabilities: new Map([["token", { agentId: "agent-a", runId: "run-a", v3SchedulerRunId: "run-a" }]]),
    activeRuns: new Map([["agent-a", { messageCapability: "token" }]]),
    projectDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    capabilityMatchesCleanupRun: () => true,
    runAuthorization: () => ({ runId: "run-a", agentId: "agent-a", fencingToken: 1 }),
    projectCommunicationArtifact: () => {},
    requestArtifactAccess: () => ({}),
    runtimeArtifactMetadata: (artifact) => artifact,
    stageCommunicationArtifact: async () => ({ id: "artifact-a", role: "long_text", title: "Result" }),
    removeRuntimeArtifactReservation: (_projectId, artifactId) => { removed.push(artifactId); },
    recordCommunication: (event) => event,
    projectCommunicationToAgentAudit: () => {},
    publishCoordinationV3Changed: () => {},
    notifyScheduler: () => {},
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-request-updates",
    headers: { authorization: "Bearer token" },
    payload: {
      requestId: "request-a",
      updateId: "update-a",
      kind: "completed",
      text: "x".repeat(70_000),
    },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(removed, []);
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
  let reconciliations = 0;
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
      activation: (id) => ({
        id,
        projectId: chat.projectId,
        agentId: id === "delivery-a" ? "agent-a" : "agent-b",
        state: "pending",
      }),
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    reconcileRuntimeCommunicationProjections: async () => { reconciliations += 1; return 0; },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/direct-messages`,
    payload: requestPayload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(reconciliations, 1);
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
    reconcileRuntimeCommunicationProjections: async () => {
      const roomAttachmentIds = new Set(runtimeInput.payload.dispatch.conversationAttachmentIds);
      roomInput = {
        communicationEventId: runtimeInput.payload.communication.eventId,
        attachments: runtimeInput.payload.communication.attachments.filter((attachment) =>
          roomAttachmentIds.has(attachment.id)),
      };
      roomMessage = { id: "message-a", ...roomInput };
      return 1;
    },
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
  const associations = [];
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
      associate: async (_projectId, agentId, attachmentIds) => {
        associations.push([agentId, attachmentIds]);
      },
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
    logError: (meta, message) => { throw meta.err ?? new Error(message); },
    logInfo: () => {},
    projectCommunicationToAgentAudit: () => {},
  });

  await reconciler.reconcileRuntimeCommunicationProjections();
  assert.deepEqual(roomInput.attachments.map((asset) => asset.id), ["asset-a"]);
  assert.deepEqual(associations, [
    ["agent-a", ["asset-a"]],
    ["agent-b", ["asset-b"]],
  ]);
  assert.equal(conversationLeases.size, 0);
  assert.equal(agentLeases.size, 0);
});

test("projection recovery associates canonical attachments for a passive broadcast", async () => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const owner = { id: "agent-a", projectId: chat.projectId, conversationId: chat.id, archived: false };
  const attachment = {
    id: "asset-a", agentId: owner.id, name: "a.txt", mediaType: "text/plain", size: 1, state: "associated",
  };
  const event = {
    eventId: "event-a",
    schemaVersion: 2,
    projectId: chat.projectId,
    conversationId: chat.id,
    sender: { kind: "user", userId: "local-operator" },
    intent: "broadcast",
    audience: { kind: "organization", organizationId: chat.projectId },
    text: "hello",
    attachments: [attachment],
    createdAt: new Date().toISOString(),
  };
  const associations = [];
  let associationFailure = false;
  const reconciler = createCommunicationProjectionReconciler({
    store: {
      getConversation: () => chat,
      getAgent: () => owner,
      getCommunicationEvent: () => event,
      canProjectCommunication: () => true,
      getConversationMessages: () => [{ id: "message-a", communicationEventId: event.eventId }],
      getCommunicationProjection: () => ({ message: { messageId: "message-a" } }),
      appendCommunicationProjection: () => ({ replayed: true }),
    },
    coordinationV3: {
      runtimeCommunications: () => [{
        id: "runtime-a",
        projectId: chat.projectId,
        recipientAgentIds: [],
        payload: { communication: event },
      }],
      requestCommunicationsNeedingProjection: () => [],
      runtimeArtifacts: () => [],
    },
    assets: {
      authoritativeRuntimeCommunicationAttachments: () => [{
        attachment,
        contentHash: "hash-a",
        localPath: "/tmp/asset-a",
      }],
      associate: async (_projectId, agentId, attachmentIds) => {
        if (associationFailure) throw new Error("association failed");
        associations.push([agentId, attachmentIds]);
      },
    },
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    attachmentDeletionInProgress: () => false,
    assetReconciliationInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    recordCommunication: (communication) => communication,
    projectCommunicationArtifact: () => {},
    communicationArtifactAccess: () => ({}),
    scheduleCommunicationReconciliation: () => {},
    logError: () => {},
    logInfo: () => {},
    projectCommunicationToAgentAudit: () => {},
  });

  await reconciler.reconcileRuntimeCommunicationProjections();
  assert.deepEqual(associations, [[owner.id, [attachment.id]]]);
  associationFailure = true;
  await assert.rejects(
    () => reconciler.reconcileRuntimeCommunicationProjections({
      projectId: chat.projectId,
      communicationEventId: event.eventId,
    }),
    /exact retry remains safe/,
  );
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
        projectId: chat.projectId,
        payload: { requestFingerprint, dispatch: { recipients: [{ agentId: "agent-a" }] } },
        activations: [{ id: "delivery-a", agentId: "agent-a" }],
      }),
      activation: () => ({ id: "delivery-a", projectId: chat.projectId, agentId: "agent-a", state: "pending" }),
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

test("multi-Agent direct replay reports terminal recipient delivery state", async (t) => {
  const chat = { id: "chat-a", projectId: "project-a", archived: false };
  const requestPayload = {
    text: "hello",
    recipients: [{ agentId: "agent-a" }],
    idempotencyKey: "terminal-direct-replay",
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
  const app = Fastify();
  let activationState = "failed";
  t.after(() => app.close());
  registerConversationDeliveryRoutes(app, {
    store: {
      getConversationMessageByReceiptKey: () => ({ id: "message-a" }),
    },
    coordinationV3: {
      runtimeCommunication: () => ({
        projectId: chat.projectId,
        payload: { requestFingerprint, dispatch: { recipients: [{ agentId: "agent-a" }] } },
        activations: [{ id: "delivery-a", agentId: "agent-a" }],
      }),
      activation: () => ({
        id: "delivery-a",
        projectId: chat.projectId,
        agentId: "agent-a",
        state: activationState,
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
  assert.deepEqual(response.json().recipients, [{
    agentId: "agent-a",
    queued: false,
    deliveryId: "delivery-a",
    state: "failed",
  }]);
  activationState = "consumed";
  const consumed = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/direct-messages`,
    payload: requestPayload,
  });
  assert.equal(consumed.statusCode, 200);
  assert.deepEqual(consumed.json().recipients, [{
    agentId: "agent-a",
    queued: false,
    deliveryId: "delivery-a",
    state: "delivered",
  }]);
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
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().committed, true);
  assert.equal(response.json().recovering, true);
  assert.equal(repaired, true);
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
  let reconciliations = 0;
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
    reconcileRuntimeCommunicationProjections: async () => { reconciliations += 1; return 0; },
  });
  const response = await app.inject({
    method: "POST",
    url: `/api/conversations/${chat.id}/collaboration/messages`,
    payload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(reconciliations, 1);
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

function queuedMessageApp({ coordinationV3 = {}, store = {}, notifyScheduler = () => {}, publishMessageDeliveryChanged = () => {} } = {}) {
  const app = Fastify();
  registerQueuedMessageRoutes(app, {
    store: {
      getAgent: () => ({ id: "agent-a", projectId: "project-a", conversationId: "chat-a", archived: false }),
      getConversation: () => ({ id: "chat-a", projectId: "project-a", archived: false }),
      ...store,
    },
    coordinationV3,
    workspace: {},
    projectDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    prepareUserCommunicationText: async () => { throw new Error("unexpected text preparation"); },
    runtimeArtifactMetadata: () => { throw new Error("unexpected artifact projection"); },
    removeRuntimeArtifactReservation: () => {},
    appendWorkspace: () => {},
    publishWorkspaceSince: () => {},
    publishCoordinationV3Changed: () => {},
    publishMessageDeliveryChanged,
    notifyScheduler,
  });
  return app;
}

test("queued-message commands replay before mutable queue and participant state", async (t) => {
  const activation = {
    id: "delivery-a",
    projectId: "project-a",
    agentId: "agent-a",
    dispatchPolicy: "steer_or_run",
    state: "attached",
    payload: {
      communication: {
        sender: { kind: "user", userId: "local-operator" },
        conversationId: "chat-a",
      },
      dispatch: { conversationId: "chat-a" },
    },
  };
  const coordinationV3 = {
    activationProjectId: () => activation.projectId,
    activation: () => activation,
    replayCancelPendingActivation: () => ({ cancelled: true, replayed: true, status: "cancelled" }),
    replayEditPendingActivationText: ({ requestText }) => {
      assert.equal(requestText, "edited");
      return { edited: true, replayed: true, status: "edited" };
    },
    replaySteerPendingActivation: () => ({ steered: true, replayed: true, status: "steered" }),
  };
  const store = {
    getAgent: () => { throw new Error("mutable Agent state must not be read for replay"); },
    getConversation: () => { throw new Error("mutable Chat state must not be read for replay"); },
  };
  const apps = [
    ["POST", "/api/conversations/chat-a/queued-messages/delivery-a/cancel", { idempotencyKey: "cancel" }],
    ["POST", "/api/agents/agent-a/queued-messages/delivery-a/cancel", { idempotencyKey: "cancel" }],
    ["PATCH", "/api/agents/agent-a/queued-messages/delivery-a", { text: " edited ", idempotencyKey: "edit" }],
    ["POST", "/api/agents/agent-a/queued-messages/delivery-a/steer", { idempotencyKey: "steer" }],
  ].map(([method, url, payload]) => ({ app: queuedMessageApp({ coordinationV3, store }), method, url, payload }));
  t.after(() => Promise.all(apps.map(({ app }) => app.close())));
  for (const item of apps) {
    const response = await item.app.inject({ method: item.method, url: item.url, payload: item.payload });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().replayed, true);
  }
});

test("queued-message mutations reject malformed bodies before coordination", async (t) => {
  const app = queuedMessageApp();
  t.after(() => app.close());
  const cases = [
    ["POST", "/api/conversations/chat-a/queued-messages/delivery-a/cancel", { idempotencyKey: 1 }],
    ["POST", "/api/agents/agent-a/queued-messages/delivery-a/cancel", { idempotencyKey: false }],
    ["PATCH", "/api/agents/agent-a/queued-messages/delivery-a", { text: {}, idempotencyKey: "edit" }],
    ["POST", "/api/agents/agent-a/queued-messages/delivery-a/steer", { idempotencyKey: "steer", extra: true }],
    ["POST", "/api/message-deliveries/injection-a/let-current-run-finish", { idempotencyKey: [] }],
    ["POST", "/api/projects/project-a/message-deliveries/delivery-a/retry", { idempotencyKey: 1 }],
    ["POST", "/api/projects/project-a/message-deliveries/delivery-a/cancel", null],
  ];
  for (const [method, url, payload] of cases) {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
  }
});

test("queued-message retry stays successful when post-commit projections fail", async (t) => {
  const app = queuedMessageApp({
    coordinationV3: {
      retryMessageDelivery: () => ({ accepted: true, replayed: false, targetAgentId: "agent-a" }),
    },
    notifyScheduler: () => { throw new Error("scheduler unavailable"); },
    publishMessageDeliveryChanged: () => { throw new Error("stream unavailable"); },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/message-deliveries/delivery-a/retry",
    payload: { idempotencyKey: "retry-once" },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().accepted, true);
});
