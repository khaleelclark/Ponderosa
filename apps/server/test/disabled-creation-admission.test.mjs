import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { createServer } from "../dist/app.js";
import { registerAgentCoordinationRoutes } from "../dist/routes/agent-coordination.js";
import { registerAgentCreationRoutes } from "../dist/routes/agent-creation.js";

const counts = store => Object.fromEntries(["agents", "runtime_communications", "coordination_requests", "coordination_joins", "agent_activations"].map(table => [table, store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));

test("human executable creation rejects disabled provider with no residue; config records and committed replay remain valid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "disabled-creation-"));
  const store = new AgentStore(directory); let probes = 0;
  const adapter = { id: "codex", displayName: "Synthetic", listModels: () => [], listEfforts: () => [] };
  const project = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Synthetic" });
  const app = createServer({ dataDir: directory, store, engines: [{ adapter, authStatus: async () => { probes++; return { authenticated: true }; } }], logger: false, startDrained: true });
  const create = (idempotencyKey, initialMessage) => app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: idempotencyKey, engine: "codex", conversationId: chat.id, idempotencyKey, ...(initialMessage ? { initialMessage } : {}) } });
  try {
    await app.ready();
    const committed = await create("committed", "Opening work"); assert.equal(committed.statusCode, 200, committed.body);
    await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { providerAvailability: { codex: false } } });
    const before = counts(store), priorProbes = probes;
    const rejected = await create("rejected", "Opening work"); assert.equal(rejected.statusCode, 409, rejected.body); assert.equal(rejected.json().code, "provider_disabled");
    assert.deepEqual(counts(store), before); assert.equal(probes, priorProbes, "creation does not spawn an auth probe");
    const replay = await create("committed", "Opening work"); assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().id, committed.json().id); assert.equal(replay.json().replayed, true);
    assert.deepEqual(counts(store), before);
    const config = await create("configuration-only"); assert.equal(config.statusCode, 200, config.body); assert.equal(counts(store).agent_activations, before.agent_activations);
    await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { providerAvailability: { codex: true } } });
    assert.equal((await create("rejected", "Opening work")).statusCode, 200);
  } finally { app.prepareForShutdown(); await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("managed creation shares disabled admission and committed replay precedes a later disable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "managed-admission-"));
  const store = new AgentStore(directory), c = new CoordinationV3Store(store.sqlite), app = Fastify();
  try {
    const project = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Synthetic" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: chat.id });
    c.coordinate({ projectId: project.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "parent", requests: [{ requestId: "parent", recipientAgentId: manager.id, lifetime: { kind: "indefinite" }, payload: {} }] });
    const lease = c.leaseNextRun({ workerId: "synthetic" }); let enabled = true;
    const authorization = { runId: lease.runId, agentId: manager.id, fencingToken: lease.fencingToken };
    const capability = { agentId: manager.id, conversationId: chat.id, runId: lease.runId, v3SchedulerRunId: lease.runId, v3FencingToken: lease.fencingToken };
    registerAgentCoordinationRoutes(app, { store, coordinationV3: c, engines: new Map([["codex", { adapter: { id: "codex", listModels: () => [], listEfforts: () => [] } }]]), providerEnabled: () => enabled,
      deletingAgentIds: new Set(), deletingProjectIds: new Set(), deletingConversationIds: new Set(), conversationDeliveryLeases: new Map(), agentDeliveryLeases: new Map(), agentMessageCapabilities: new Map([["synthetic", capability]]), activeRuns: new Map([[manager.id, { messageCapability: "synthetic" }]]), cachedModelOptions: () => [], capabilityOwnsAuthoritativeRun: () => true, runAuthorization: () => authorization, reconcileRuntimeCommunicationProjections: async () => 0, recordCommunication: event => event, projectCommunicationToAgentAudit: () => {}, publishCoordinationV3Changed: () => {}, notifyScheduler: () => {}, logWarn: () => {} });
    const create = key => app.inject({ method: "POST", url: "/api/agent-spawn", headers: { authorization: "Bearer synthetic" }, payload: { idempotencyKey: key, title: key, engine: "codex", text: "Opening work", lifetime: { kind: "indefinite" } } });
    const first = await create("committed"); assert.equal(first.statusCode, 200, first.body);
    enabled = false; const before = counts(store);
    const rejected = await create("rejected"); assert.equal(rejected.statusCode, 409, rejected.body); assert.equal(rejected.json().code, "provider_disabled"); assert.deepEqual(counts(store), before);
    const replay = await create("committed"); assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().agent.id, first.json().agent.id); assert.deepEqual(counts(store), before);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("preset-selected disabled admission is rechecked after asynchronous draft preparation without canonical residue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "creation-preparation-race-"));
  const store = new AgentStore(directory), c = new CoordinationV3Store(store.sqlite), app = Fastify();
  let enabled = true, release, entered;
  const prepared = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  try {
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const preset = store.createAgentPreset(p.id, { name: "Synthetic preset", description: "Synthetic", guidance: "No external work", engine: "codex" });
    const before = counts(store);
    registerAgentCreationRoutes(app, { dataDir: directory, store, coordinationV3: c,
      workspace: { getPreferences: () => ({ providerAvailability: { codex: enabled } }) },
      assets: {}, drafts: { normalizedOwner: () => "owner", prepared: async () => { entered(); await prepared; return { body: Buffer.from("synthetic"), prepared: {} }; } },
      engines: new Map([["codex", { adapter: { id: "codex", listModels: () => [], listEfforts: () => [] } }]]),
      deletingAgentIds: new Set(), deletingProjectIds: new Set(), deletingConversationIds: new Set(), agentCreationConversationLeases: new Map(), agentDeliveryLeases: new Map(), cachedModelOptions: () => [],
      publish: () => {}, publishMessageDeliveryChanged: () => {}, notifyScheduler: () => {}, reconcileRuntimeCommunicationProjections: async () => 0,
    });
    const creation = app.inject({ method: "POST", url: `/api/projects/${p.id}/agents`, payload: { title: "Synthetic", engine: "codex", presetId: preset.id, conversationId: chat.id, initialMessage: "Opening work", draftAttachmentIds: ["synthetic"], draftOwnerId: "owner", idempotencyKey: "race" } });
    await started; enabled = false; release();
    const response = await creation; assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().code, "provider_disabled");
    assert.deepEqual(counts(store), before);
    assert.equal(store.sqlite.prepare("SELECT status FROM agent_creation_operations WHERE idempotency_key='race'").get().status, "rolled_back");
  } finally { release(); await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
