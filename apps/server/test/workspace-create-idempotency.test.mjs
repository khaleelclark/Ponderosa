import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore } from "@ponderosa/agents";
import { registerConversationRoutes } from "../dist/routes/conversations.js";
import { registerProjectRoutes } from "../dist/routes/projects.js";

const adapter = {
  id: "codex",
  displayName: "Codex",
  listModels: () => [],
  listEfforts: () => [],
};

test("Project API replays lost responses and never deletes a committed managed folder", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-route-create-"));
  const managedWorkspacesRoot = path.join(dataDir, "managed");
  const store = new AgentStore(dataDir);
  const app = Fastify();
  const engines = new Map([["codex", { adapter }]]);
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  registerProjectRoutes(app, {
    store,
    workspace: { getPreferences: () => ({}) },
    engines,
    managedWorkspacesRoot,
    projectFolderPathBoundary: {
      insideRoot: () => true,
      validatedBrowsePath: async (candidate) => ({ candidate, root: "/" }),
      defaultBrowsePath: async () => managedWorkspacesRoot,
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
  store.sqlite.exec(`
    CREATE TRIGGER fail_postcommit_chat_defaults BEFORE UPDATE ON conversations
    BEGIN SELECT RAISE(FAIL, 'injected postcommit failure'); END
  `);
  const request = {
    method: "POST",
    url: "/api/projects",
    headers: { "idempotency-key": "project-create-route" },
    payload: { label: "Created", defaultEngine: "codex" },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 200, first.body);
  const project = first.json();
  assert.equal(existsSync(project.hostPath), true);
  assert.equal(store.getProject(project.id)?.hostPath, project.hostPath);
  engines.clear();
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, project.id);
  assert.equal(store.listProjects().filter((item) => item.label === "Created").length, 1);
  engines.set("codex", { adapter });

  const conflict = await app.inject({
    ...request,
    payload: { ...request.payload, label: "Changed" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(existsSync(project.hostPath), true);

  store.sqlite.exec("DROP TRIGGER fail_postcommit_chat_defaults");
  store.sqlite.exec(`
    CREATE TRIGGER fail_project_presets BEFORE INSERT ON agent_presets
    BEGIN SELECT RAISE(FAIL, 'injected preset failure'); END
  `);
  const failedFolder = path.join(managedWorkspacesRoot, "failed");
  const failed = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { "idempotency-key": "project-create-failed" },
    payload: { label: "Failed", defaultEngine: "codex", createFolderName: "failed" },
  });
  assert.equal(failed.statusCode, 500);
  assert.equal(existsSync(failedFolder), false);
  assert.equal(store.listProjects().some((item) => item.label === "Failed"), false);
});

test("Chat API binds one stable creation key to one payload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-chat-route-create-"));
  const store = new AgentStore(dataDir);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const app = Fastify();
  const engines = new Map([["codex", { adapter }]]);
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  registerConversationRoutes(app, {
    store,
    workspace: { getPreferences: () => ({}) },
    engines,
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    generateConversationTitle: async () => ({ title: "Chat", generated: false }),
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
  const request = {
    method: "POST",
    url: `/api/projects/${project.id}/conversations`,
    headers: { "idempotency-key": "chat-create-route" },
    payload: { title: "UI" },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 200, first.body);
  engines.clear();
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, first.json().id);
  assert.equal(store.listConversations(project.id).filter((chat) => chat.title === "UI").length, 1);
  engines.set("codex", { adapter });

  const conflict = await app.inject({ ...request, payload: { title: "Backend" } });
  assert.equal(conflict.statusCode, 409, conflict.body);
});
