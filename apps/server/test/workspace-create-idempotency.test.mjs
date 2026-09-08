import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore, stableJson } from "@ponderosa/agents";
import { registerConversationRoutes } from "../dist/routes/conversations.js";
import { registerProjectRoutes } from "../dist/routes/projects.js";

const adapter = {
  id: "codex",
  displayName: "Codex",
  listModels: () => [],
  listEfforts: () => [],
};

function managedCreationReceipt(managedWorkspacesRoot, idempotencyKey, payload) {
  const hostPath = path.join(managedWorkspacesRoot, payload.createFolderName);
  return {
    receipt: {
      version: 1,
      idempotencyKey,
      payloadHash: createHash("sha256").update(stableJson({
        label: payload.label,
        hostPath,
        defaultEngine: payload.defaultEngine,
        defaultModel: null,
        defaultEffort: null,
      })).digest("hex"),
      hostPath,
    },
    receiptPath: path.join(
      managedWorkspacesRoot,
      `.project-creation-${createHash("sha256").update(idempotencyKey).digest("hex")}.jsonl`,
    ),
  };
}

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

test("managed Project folder receipts recover every pre-canonical crash boundary", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-managed-project-recovery-"));
  const managedWorkspacesRoot = path.join(dataDir, "managed");
  const store = new AgentStore(dataDir);
  await mkdir(managedWorkspacesRoot, { recursive: true });
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
    activeRuns: new Map(), scheduledSessionRollovers: new Map(),
    organizationEnvelopeStates: new Map(), cachedModelOptions: () => [],
    appendWorkspace: () => {}, refreshCommunicationReconciliation: () => {},
    clearAgentResumeSession: () => {}, persistentRuntimeForTermination: () => undefined,
    teardownPersistentRuntime: async () => {},
  });

  for (const phase of ["receipt", "empty-folder", "marker"]) {
    const idempotencyKey = `managed-${phase}`;
    const payload = { label: phase, defaultEngine: "codex", createFolderName: phase };
    const { receipt, receiptPath } = managedCreationReceipt(
      managedWorkspacesRoot, idempotencyKey, payload,
    );
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    if (phase !== "receipt") await mkdir(receipt.hostPath);
    if (phase === "marker") {
      await writeFile(
        path.join(receipt.hostPath, ".ponderosa-project-creation.jsonl"),
        `${JSON.stringify(receipt)}\n`,
      );
    }
    const response = await app.inject({
      method: "POST", url: "/api/projects",
      headers: { "idempotency-key": idempotencyKey }, payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(existsSync(receipt.hostPath), true);
    assert.equal(existsSync(receiptPath), false);
    assert.equal(existsSync(path.join(receipt.hostPath, ".ponderosa-project-creation.jsonl")), false);
  }

  const conflictKey = "managed-conflict";
  const original = { label: "Original", defaultEngine: "codex", createFolderName: "conflict" };
  const { receipt, receiptPath } = managedCreationReceipt(managedWorkspacesRoot, conflictKey, original);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  const conflict = await app.inject({
    method: "POST", url: "/api/projects", headers: { "idempotency-key": conflictKey },
    payload: { ...original, label: "Changed" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(await readFile(receiptPath, "utf8"), `${JSON.stringify(receipt)}\n`);

  const foreign = path.join(managedWorkspacesRoot, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "owned-by-user.txt"), "keep");
  const rejected = await app.inject({
    method: "POST", url: "/api/projects", headers: { "idempotency-key": "managed-foreign" },
    payload: { label: "Foreign", defaultEngine: "codex", createFolderName: "foreign" },
  });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(await readFile(path.join(foreign, "owned-by-user.txt"), "utf8"), "keep");
});
