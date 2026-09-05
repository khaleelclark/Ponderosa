import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore } from "@ponderosa/agents";
import { AssetStore } from "../dist/assets.js";
import { encodePortableArtifact } from "../dist/agent-package-codec.js";
import { registerAgentPackageRoutes } from "../dist/routes/agent-packages.js";

function registerImportRoutes(app, dataDir, getProject = (id) => ({ id })) {
  registerAgentPackageRoutes(app, {
    dataDir,
    store: { getProject },
    coordination: {},
    assets: {},
    engines: new Map(),
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    agentMessages: () => [],
    createOperationalNotification: () => {},
  });
}

test("background import replay precedes current Project validation", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-replay-"));
  const app = Fastify();
  let projectExists = true;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  registerImportRoutes(app, dataDir, (id) => projectExists ? { id } : undefined);
  const headers = {
    "content-type": "application/vnd.ponderosa.agent-import",
    "idempotency-key": "stable-import",
  };
  const payload = Buffer.from("package bytes");
  const first = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agent-import-operations",
    headers,
    payload,
  });
  assert.equal(first.statusCode, 202);
  projectExists = false;
  const replay = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agent-import-operations",
    headers,
    payload,
  });
  assert.ok([200, 202].includes(replay.statusCode));
  assert.equal(replay.json().id, first.json().id);
});

test("completed copy replay does not reread its source Agent", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-copy-replay-"));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let sourceReads = 0;
  registerAgentPackageRoutes(app, {
    dataDir,
    store: {
      beginAgentCreationOperation: () => ({ operation: {
        id: "copy-operation-a",
        projectId: "project-a",
        actorScope: "user:local-operator",
        kind: "import",
        idempotencyKey: "stable-copy",
        payloadHash: "ignored-by-stub",
        status: "completed",
        agentIds: ["copied-a"],
        artifactIds: [],
        artifactIdentities: [],
        result: { rootAgentId: "copied-a", agentIds: ["copied-a"] },
      } }),
      getAgent: () => { sourceReads += 1; return undefined; },
    },
    coordination: {},
    assets: {},
    engines: new Map(),
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    agentMessages: () => [],
    createOperationalNotification: () => {},
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "stable-copy" },
    payload: { sourceAgentId: "deleted-source", conversationId: "chat-a" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().rootAgentId, "copied-a");
  assert.equal(sourceReads, 0);
});

test("JSON copy and synchronous import fingerprints ignore object key order", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-semantic-fingerprint-"));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const hashes = [];
  const completed = (input) => ({ id: `operation-${hashes.length}`, ...input, status: "completed",
    agentIds: ["agent-a"], artifactIds: [], artifactIdentities: [],
    result: { rootAgentId: "agent-a", agentIds: ["agent-a"] } });
  let current;
  registerAgentPackageRoutes(app, {
    dataDir,
    store: {
      beginAgentCreationOperation: (input) => {
        hashes.push(input.payloadHash);
        current = completed(input);
        return { operation: current };
      },
      getAgentCreationOperation: () => current,
      getAgent: () => undefined,
    },
    coordination: {}, assets: {}, engines: new Map(), deletingProjectIds: new Set(),
    deletingConversationIds: new Set(), deletingAgentIds: new Set(), agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [], appendWorkspace: () => {}, agentMessages: () => {},
    createOperationalNotification: () => {},
  });
  const copyA = { sourceAgentId: "source-a", conversationId: "chat-a", organization: false };
  const copyB = { organization: false, conversationId: "chat-a", sourceAgentId: "source-a" };
  await app.inject({ method: "POST", url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "copy-a" }, payload: copyA });
  await app.inject({ method: "POST", url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "copy-b" }, payload: copyB });
  assert.equal(hashes[0], hashes[1]);

  const importA = { package: {}, conversationId: "chat-a", engineMapping: { old: "new" } };
  const importB = { engineMapping: { old: "new" }, conversationId: "chat-a", package: {} };
  await app.inject({ method: "POST", url: "/api/projects/project-a/import-agents",
    headers: { "idempotency-key": "import-a" }, payload: importA });
  await app.inject({ method: "POST", url: "/api/projects/project-a/import-agents",
    headers: { "idempotency-key": "import-b" }, payload: importB });
  assert.equal(hashes[2], hashes[3]);
});

test("generated-file import rollback clears its exact authority before retry", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-generated-import-rollback-"));
  const store = new AgentStore(dataDir);
  const assets = new AssetStore(dataDir);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    assets.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const chat = store.createConversation(project.id, { title: "Chat" });
  const artifactId = randomUUID();
  const bytes = Buffer.from("generated\n");
  let failAfterRegistration = true;
  const registerGenerated = assets.registerPublishedGeneratedArtifact.bind(assets);
  assets.registerPublishedGeneratedArtifact = (artifact, publication) => {
    const registered = registerGenerated(artifact, publication);
    if (failAfterRegistration) {
      failAfterRegistration = false;
      throw new Error("injected failure after generated authority commit");
    }
    return registered;
  };
  registerAgentPackageRoutes(app, {
    dataDir,
    store,
    coordination: { runtimeArtifact: () => undefined, handleAgentDeletion: () => {} },
    assets,
    engines: new Map([["codex", {
      adapter: { id: "codex", listModels: () => [], listEfforts: () => [] },
    }]]),
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    agentMessages: () => [],
    createOperationalNotification: () => {},
  });
  const request = {
    method: "POST",
    url: `/api/projects/${project.id}/import-agents`,
    headers: { "idempotency-key": "generated-rollback" },
    payload: {
      conversationId: chat.id,
      engineMapping: { codex: "codex" },
      package: {
        schema: "ponderosa.agent-package.v1",
        mode: "full",
        kind: "agent",
        exportedAt: new Date().toISOString(),
        sourceLabel: "source",
        rootRef: "source-agent",
        agents: [{
          ref: "source-agent",
          title: "Imported",
          engine: "codex",
          managementPermissions: {
            allowAutomaticDescendantDeletion: false,
            allowAutomaticDescendantReorganization: false,
          },
          artifacts: [{
            ref: artifactId,
            kind: "generated_file",
            path: `${artifactId}.txt`,
            summary: `${artifactId}.txt`,
            createdAt: new Date().toISOString(),
            mediaType: "text/plain",
            dataBase64: await encodePortableArtifact(bytes),
          }],
        }],
      },
    },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 500);
  assert.equal(assets.authority.generatedArtifact(project.id, artifactId), undefined);
  assert.equal(store.listAgents(project.id).length, 0);

  const retry = await app.inject(request);
  assert.equal(retry.statusCode, 201);
  assert.ok(assets.authority.generatedArtifact(project.id, artifactId));
});

test("unfinished copy retry uses the first durable source snapshot", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-copy-snapshot-"));
  let store = new AgentStore(dataDir);
  let app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const chat = store.createConversation(project.id, { title: "Chat" });
  const source = store.createAgent(project.id, {
    title: "Original source",
    engine: "codex",
    conversationId: chat.id,
  });
  const deletingConversationIds = new Set([chat.id]);
  const register = () => registerAgentPackageRoutes(app, {
    dataDir,
    store,
    coordination: { runtimeArtifact: () => undefined },
    assets: {},
    engines: new Map([["codex", {
      adapter: {
        id: "codex",
        listModels: () => [],
        listEfforts: () => [],
      },
    }]]),
    deletingProjectIds: new Set(),
    deletingConversationIds,
    deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    agentMessages: () => [],
    createOperationalNotification: () => {},
  });
  register();
  const request = {
    method: "POST",
    url: `/api/projects/${project.id}/copy-agent`,
    headers: { "idempotency-key": "stable-copy-snapshot" },
    payload: { sourceAgentId: source.id, conversationId: chat.id },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 400);

  await app.close();
  store.close();
  store = new AgentStore(dataDir);
  store.updateAgent(source.id, { title: "Changed source" });
  deletingConversationIds.clear();
  app = Fastify();
  register();
  const retry = await app.inject(request);
  assert.equal(retry.statusCode, 201);
  assert.equal(store.getAgent(retry.json().rootAgentId).title, "Original source");
});

test("startup preserves a rolling-back copy snapshot for its exact retry", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-copy-rollback-snapshot-"));
  let store = new AgentStore(dataDir);
  let app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const chat = store.createConversation(project.id, { title: "Chat" });
  const source = store.createAgent(project.id, {
    title: "Original source",
    engine: "codex",
    conversationId: chat.id,
  });
  const deletingConversationIds = new Set([chat.id]);
  const register = () => registerAgentPackageRoutes(app, {
    dataDir,
    store,
    coordination: { runtimeArtifact: () => undefined },
    assets: {},
    engines: new Map([["codex", {
      adapter: {
        id: "codex",
        listModels: () => [],
        listEfforts: () => [],
      },
    }]]),
    deletingProjectIds: new Set(),
    deletingConversationIds,
    deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    agentMessages: () => [],
    createOperationalNotification: () => {},
  });
  register();
  const request = {
    method: "POST",
    url: `/api/projects/${project.id}/copy-agent`,
    headers: { "idempotency-key": "rolling-copy-snapshot" },
    payload: { sourceAgentId: source.id, conversationId: chat.id },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 400);
  const operation = store.sqlite.prepare(`
    SELECT id FROM agent_creation_operations WHERE idempotency_key = ?
  `).get("rolling-copy-snapshot");
  const snapshot = path.join(dataDir, "agent-import-operations", `${operation.id}.copy.payload`);
  assert.equal(existsSync(snapshot), true);
  store.updateAgentCreationOperation(operation.id, { status: "rolling_back" });

  await app.close();
  store.close();
  store = new AgentStore(dataDir);
  app = Fastify();
  register();
  await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/agent-import-operations/${randomUUID()}`,
  });
  assert.equal(existsSync(snapshot), true);
  store.updateAgentCreationOperation(operation.id, { status: "rolled_back" });
  store.updateAgent(source.id, { title: "Changed source" });
  deletingConversationIds.clear();

  const retry = await app.inject(request);
  assert.equal(retry.statusCode, 201);
  assert.equal(store.getAgent(retry.json().rootAgentId).title, "Original source");
  assert.equal(existsSync(snapshot), false);
});

test("completed synchronous import replays before destination validation", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-sync-import-replay-"));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let projectReads = 0;
  const completed = {
    id: "import-operation-a",
    projectId: "project-a",
    actorScope: "user:local-operator",
    kind: "import",
    idempotencyKey: "stable-sync-import",
    payloadHash: "ignored-by-stub",
    status: "completed",
    agentIds: ["imported-a"],
    artifactIds: [],
    artifactIdentities: [],
    result: { rootAgentId: "imported-a", agentIds: ["imported-a"] },
  };
  registerAgentPackageRoutes(app, {
    dataDir,
    store: {
      beginAgentCreationOperation: () => ({ operation: completed }),
      getAgentCreationOperation: () => completed,
      getProject: () => { projectReads += 1; return undefined; },
    },
    coordination: {},
    assets: {},
    engines: new Map(),
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    agentMessages: () => [],
    createOperationalNotification: () => {},
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/import-agents",
    headers: { "idempotency-key": "stable-sync-import" },
    payload: { package: {}, conversationId: "deleted-chat", engineMapping: {} },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().rootAgentId, "imported-a");
  assert.equal(projectReads, 0);
});

test("background import idempotency is bound to the exact payload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-operation-"));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  registerImportRoutes(app, dataDir);
  const headers = {
    "content-type": "application/vnd.ponderosa.agent-import",
    "idempotency-key": "same-request",
  };
  const first = await app.inject({ method: "POST", url: "/api/projects/project-a/agent-import-operations", headers, payload: Buffer.from("first") });
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().payloadHash, createHash("sha256").update("first").digest("hex"));

  const conflict = await app.inject({ method: "POST", url: "/api/projects/project-a/agent-import-operations", headers, payload: Buffer.from("different") });
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().error, /reused with different input/u);
});

test("startup hydration removes payloads for terminal import operations", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-hydration-"));
  const directory = path.join(dataDir, "agent-import-operations");
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const payload = path.join(directory, `${id}.payload`);
  const now = new Date().toISOString();
  await writeFile(payload, "already consumed");
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
    id,
    requestId: "terminal-request",
    payloadHash: createHash("sha256").update("already consumed").digest("hex"),
    projectId: "project-a",
    sourceLabel: "Agent import",
    phase: "completed",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    result: { rootAgentId: "agent-a", agentIds: ["agent-a"] },
  }));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  registerImportRoutes(app, dataDir);
  const response = await app.inject({
    method: "GET",
    url: `/api/projects/project-a/agent-import-operations/${id}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(existsSync(payload), false);
});

test("a failed operation directory sync is never acknowledged from read-back", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-fsync-"));
  const directory = path.join(dataDir, "agent-import-operations");
  const app = Fastify();
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  t.after(async () => {
    fs.open = originalOpen;
    fs.unlink = originalUnlink;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  registerImportRoutes(app, dataDir);
  fs.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args);
    if (String(target) !== directory || flags !== "r") return handle;
    return new Proxy(handle, {
      get(object, property) {
        if (property === "sync") return async () => { throw new Error("injected directory sync failure"); };
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  };
  fs.unlink = async (target, ...args) => {
    if (String(target).startsWith(`${directory}${path.sep}`) && String(target).endsWith(".json")) {
      throw new Error("injected rollback failure");
    }
    return originalUnlink(target, ...args);
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agent-import-operations",
    headers: {
      "content-type": "application/vnd.ponderosa.agent-import",
      "idempotency-key": "failed-fsync-request",
    },
    payload: Buffer.from("payload"),
  });
  assert.equal(response.statusCode, 500);
});
