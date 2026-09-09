import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore, ProjectDeletionInProgressError } from "@ponderosa/agents";
import { registerAgentPresetRoutes } from "../dist/routes/agent-presets.js";
import { registerConversationRoutes } from "../dist/routes/conversations.js";
import { registerProjectRoutes } from "../dist/routes/projects.js";

const adapter = {
  id: "codex",
  displayName: "Codex",
  listModels: () => [],
  listEfforts: () => [],
};

test("durable Project quarantine maps every metadata route to one 409", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-metadata-routes-"));
  const store = new AgentStore(dataDir);
  const affected = store.createProject({ label: "Affected", hostPath: "/tmp/affected", defaultEngine: "codex" });
  const sibling = store.createProject({ label: "Sibling", hostPath: "/tmp/sibling", defaultEngine: "codex" });
  const conversation = store.getConversation(affected.lastConversationId);
  const preset = store.createAgentPreset(affected.id, {
    name: "Affected preset",
    description: "Focused metadata regression",
    guidance: "Exercise the durable route mutation fence.",
    engine: "codex",
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof ProjectDeletionInProgressError
    ? reply.code(409).send({ error: error.message })
    : Promise.reject(error));
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const engines = new Map([["codex", { adapter }]]);
  const workspace = { getPreferences: () => ({}) };
  registerProjectRoutes(app, {
    store,
    workspace,
    engines,
    managedWorkspacesRoot: path.join(dataDir, "managed"),
    projectFolderPathBoundary: {
      insideRoot: () => true,
      validatedBrowsePath: async (candidate) => ({ candidate, root: "/" }),
      defaultBrowsePath: async () => dataDir,
    },
    activeRuns: new Map(),
    scheduledSessionRollovers: new Map(),
    organizationEnvelopeStates: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    refreshCommunicationReconciliation: () => {},
    clearAgentResumeSession: () => {},
    persistentRuntimeForTermination: () => undefined,
    teardownPersistentRuntime: async () => {},
  });
  registerConversationRoutes(app, {
    store,
    workspace,
    engines,
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    generateConversationTitle: async (id) => ({
      title: store.updateConversation(id, { title: "Generated" }).title,
      generated: true,
    }),
    conversationDetail: () => undefined,
    agentHealth: () => ({}),
    teamDirectory: () => ({}),
    hasActiveRun: () => false,
    projectDeletionInProgress: () => false,
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: async () => 0,
    refreshTriggers: async () => {},
    processConversationDeletionCleanup: async () => true,
  });
  registerAgentPresetRoutes(app, { store, validateRuntimeSelection: () => undefined });
  store.markProjectDeletionPending(affected.id);

  const requests = [
    { method: "PATCH", url: `/api/projects/${affected.id}`, payload: { label: "Blocked" } },
    { method: "POST", url: `/api/projects/${affected.id}/use`, payload: { conversationId: conversation.id } },
    { method: "PATCH", url: `/api/conversations/${conversation.id}`, payload: { title: "Blocked" } },
    { method: "POST", url: `/api/conversations/${conversation.id}/generate-title` },
    {
      method: "POST",
      url: `/api/projects/${affected.id}/agent-presets`,
      headers: { "idempotency-key": "blocked-preset-create" },
      payload: {
        name: "Blocked create",
        description: "Focused metadata regression",
        guidance: "Exercise the durable route mutation fence.",
        engine: "codex",
      },
    },
    { method: "PATCH", url: `/api/agent-presets/${preset.id}`, payload: { name: "Blocked update" } },
    { method: "DELETE", url: `/api/agent-presets/${preset.id}` },
  ];
  for (const request of requests) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 409, `${request.method} ${request.url}: ${response.body}`);
    assert.equal(response.json().error, "Project deletion is in progress");
  }

  const siblingResponse = await app.inject({
    method: "PATCH", url: `/api/projects/${sibling.id}`, payload: { label: "Sibling after" },
  });
  assert.equal(siblingResponse.statusCode, 200, siblingResponse.body);
  assert.equal(siblingResponse.json().label, "Sibling after");
});
