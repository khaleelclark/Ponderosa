import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { AssetStore } from "../dist/assets.js";
import { encodePortableArtifact } from "../dist/agent-package-codec.js";
import { registerAgentPackageRoutes } from "../dist/routes/agent-packages.js";
import {registerProductScope,rewriteProductUrl} from "../dist/product-scope.js";

function importUpload(label="Agent import",conversationId="chat-a") {
  const metadata={conversationId,engineMapping:{codex:"codex"}};
  const portable={schema:"ponderosa.agent-package.v1",mode:"template",kind:"agent",exportedAt:new Date().toISOString(),sourceLabel:label,rootRef:"root",agents:[{ref:"root",title:"Imported",engine:"codex",managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  return Buffer.from(JSON.stringify(metadata)+"\n"+JSON.stringify(portable));
}
const scopedStore=(extra={})=>({
  getProject:id=>({id}),
  getConversation:id=>({id,projectId:"project-a",branchId:undefined,archived:false}),
  sqlite:{prepare:()=>({get:()=>({branch_id:null})})},
  ...extra,
});

function registerImportRoutes(app, dataDir, getProject = (id) => ({ id })) {
  registerAgentPackageRoutes(app, {
    dataDir,
    store: scopedStore({ getProject }),
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
  const payload = importUpload("replay");
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
  for(let i=0;i<100;i++){
    const status=await app.inject({url:`/api/projects/project-a/agent-import-operations/${first.json().id}`});
    if(status.json().status!=="pending")break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
});

test("completed copy replay does not reread its source Agent", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-copy-replay-"));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let sourceReads = 0;
  registerAgentPackageRoutes(app, {
    dataDir,
    store: scopedStore({
      beginAgentCreationOperation: () => ({ operation: {
        id: "copy-operation-a",
        projectId: "project-a",
        actorScope: "user:local-operator",
        kind: "import",
        idempotencyKey: "stable-copy",
        payloadHash: "ignored-by-stub",
        conversationId:"chat-a",
        productScope:"dev",
        status: "completed",
        agentIds: ["copied-a"],
        artifactIds: [],
        artifactIdentities: [],
        result: { rootAgentId: "copied-a", agentIds: ["copied-a"] },
      } }),
      getAgent: () => { sourceReads += 1; return undefined; },
    }),
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
    store: scopedStore({
      beginAgentCreationOperation: (input) => {
        hashes.push(input.payloadHash);
        current = completed(input);
        return { operation: current };
      },
      getAgentCreationOperation: () => current,
      getAgent: () => undefined,
    }),
    coordination: {}, assets: {}, engines: new Map(), deletingProjectIds: new Set(),
    deletingConversationIds: new Set(), deletingAgentIds: new Set(), agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [], appendWorkspace: () => {}, agentMessages: () => {},
    createOperationalNotification: () => {},
  });
  const copyA = { sourceAgentId: "source-a", conversationId: "chat-a", organization: false };
  const copyB = { organization: false, conversationId: "chat-a", sourceAgentId: "source-a" };
  await app.inject({ method: "POST", url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "copy-key-a" }, payload: copyA });
  await app.inject({ method: "POST", url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "copy-key-b" }, payload: copyB });
  assert.equal(hashes[0], hashes[1]);
  await app.inject({ method: "POST", url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "copy-key-c" }, payload: { ...copyA, rootTitle: "New root" } });
  assert.notEqual(hashes[0], hashes[2]);
  await app.inject({ method: "POST", url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "copy-key-d" }, payload: { ...copyA, rootTitle: " New root " } });
  assert.equal(hashes[2], hashes[3]);
  const invalidName = await app.inject({ method: "POST", url: "/api/projects/project-a/copy-agent",
    headers: { "idempotency-key": "copy-key-invalid" }, payload: { ...copyA, rootTitle: "   " } });
  assert.equal(invalidName.statusCode, 400);
  assert.equal(hashes.length, 4);

  const importA = { package: {}, conversationId: "chat-a", engineMapping: { old: "new" } };
  const importB = { engineMapping: { old: "new" }, conversationId: "chat-a", package: {} };
  await app.inject({ method: "POST", url: "/api/projects/project-a/import-agents",
    headers: { "idempotency-key": "import-key-a" }, payload: importA });
  await app.inject({ method: "POST", url: "/api/projects/project-a/import-agents",
    headers: { "idempotency-key": "import-key-b" }, payload: importB });
  assert.equal(hashes[4], hashes[5]);
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

test("copy authorization precedes snapshot persistence", async (t) => {
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
  assert.equal(first.statusCode, 404);

  await app.close();
  store.close();
  store = new AgentStore(dataDir);
  store.updateAgent(source.id, { title: "Changed source" });
  deletingConversationIds.clear();
  app = Fastify();
  register();
  const retry = await app.inject(request);
  assert.equal(retry.statusCode, 201);
  assert.equal(store.getAgent(retry.json().rootAgentId).title, "Changed source");
});

test("copy authorization does not persist rollback authority", async (t) => {
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
  assert.equal(first.statusCode, 404);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM agent_creation_operations WHERE idempotency_key=?").get("rolling-copy-snapshot").n,0);

  await app.close();
  store.close();
  store = new AgentStore(dataDir);
  app = Fastify();
  register();
  store.updateAgent(source.id, { title: "Changed source" });
  deletingConversationIds.clear();

  const retry = await app.inject(request);
  assert.equal(retry.statusCode, 201);
  assert.equal(store.getAgent(retry.json().rootAgentId).title, "Changed source");
});

test("synchronous import authorizes its destination before completed replay", async (t) => {
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
      getConversation:()=>undefined,
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
  assert.equal(response.statusCode, 404);
  assert.equal(projectReads, 1);
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
  const firstPayload=importUpload("first");
  const first = await app.inject({ method: "POST", url: "/api/projects/project-a/agent-import-operations", headers, payload: firstPayload });
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().payloadHash, createHash("sha256").update(firstPayload).digest("hex"));

  const conflict = await app.inject({ method: "POST", url: "/api/projects/project-a/agent-import-operations", headers, payload: importUpload("different") });
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().error, /reused with different input/u);
  for(let i=0;i<100;i++){
    const status=await app.inject({url:`/api/projects/project-a/agent-import-operations/${first.json().id}`});
    if(status.json().status!=="pending")break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
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
    conversationId:"chat-a",
    product:"dev",
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

test("startup quarantines one malformed import journal without poisoning valid operations", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-corrupt-journal-"));
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const directory = path.join(dataDir, "agent-import-operations");
  await mkdir(directory, { recursive: true });
  const corruptId = randomUUID();
  const validId = randomUUID();
  const corruptPayload = path.join(directory, `${corruptId}.payload`);
  const now = new Date().toISOString();
  await writeFile(path.join(directory, `${corruptId}.json`), "{not-json");
  await writeFile(corruptPayload, "preserve me");
  await writeFile(path.join(directory, `${validId}.json`), JSON.stringify({
    id: validId,
    requestId: "valid-operation",
    payloadHash: createHash("sha256").update("already consumed").digest("hex"),
    projectId: "project-a",
    conversationId:"chat-a",
    product:"dev",
    sourceLabel: "Valid import",
    phase: "completed",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    result: { rootAgentId: "agent-a", agentIds: ["agent-a"] },
  }));
  const notifications = [];
  const register = (app) => registerAgentPackageRoutes(app, {
    dataDir,
    store: { getProject: (id) => ({ id }) },
    coordination: {}, assets: {}, engines: new Map(), deletingProjectIds: new Set(),
    deletingConversationIds: new Set(), deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(), cachedModelOptions: () => [],
    appendWorkspace: () => {}, agentMessages: () => {},
    createOperationalNotification: (notification) => notifications.push(notification),
  });

  const first = Fastify();
  apps.push(first);
  register(first);
  const response = await first.inject({
    method: "GET",
    url: `/api/projects/project-a/agent-import-operations/${validId}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().id, validId);
  assert.equal(existsSync(corruptPayload), true);
  assert.equal(existsSync(path.join(directory, `${corruptId}.json.corrupt`)), true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /payload was preserved/u);
  await first.close();
  apps.splice(apps.indexOf(first), 1);

  const restarted = Fastify();
  apps.push(restarted);
  register(restarted);
  const replay = await restarted.inject({
    method: "GET",
    url: `/api/projects/project-a/agent-import-operations/${validId}`,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(existsSync(corruptPayload), true);
  assert.equal(notifications.length, 1);
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
    payload: importUpload("fsync"),
  });
  assert.equal(response.statusCode, 500);
});


test("Agent package admission and operation status are bound to the requested product",async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),"ponderosa-import-product-scope-"));
  const store=new AgentStore(dataDir),workspace=new WorkspaceStore(dataDir),app=Fastify({rewriteUrl:rewriteProductUrl});
  t.after(async()=>{await app.close();store.close();await rm(dataDir,{recursive:true,force:true});});
  const project=store.createProject({label:"Dev",hostPath:dataDir,defaultEngine:"codex"}),chat=store.getConversation(project.lastConversationId);
  registerProductScope(app,store,workspace,()=>undefined,()=>false);
  registerAgentPackageRoutes(app,{dataDir,store,coordination:{},assets:{},engines:new Map(),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:()=>[],createOperationalNotification(){}});
  const portable={schema:"ponderosa.agent-package.v1",mode:"template",kind:"agent",exportedAt:new Date().toISOString(),sourceLabel:"Scoped",rootRef:"root",agents:[{ref:"root",title:"Scoped",engine:"codex",managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  const body={conversationId:chat.id,engineMapping:{codex:"codex"},package:portable};
  const sync=await app.inject({method:"POST",url:`/api/branches/engine/projects/${project.id}/import-agents`,headers:{"idempotency-key":"scoped-sync"},payload:body});
  assert.equal(sync.statusCode,404,sync.body);assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM agent_creation_operations").get().n,0);
  const queued=await app.inject({method:"POST",url:`/api/branches/engine/projects/${project.id}/agent-import-operations`,headers:{"content-type":"application/vnd.ponderosa.agent-import","idempotency-key":"scoped-queue"},payload:Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:"codex"}})+"\n"+JSON.stringify(portable))});
  assert.equal(queued.statusCode,404,queued.body);
  const operationId=randomUUID(),now=new Date().toISOString(),directory=path.join(dataDir,"agent-import-operations");
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,`${operationId}.json`),JSON.stringify({id:operationId,requestId:"scoped-status",payloadHash:"0".repeat(64),projectId:project.id,conversationId:chat.id,product:"dev",sourceLabel:"Scoped",phase:"completed",status:"completed",createdAt:now,updatedAt:now,result:{rootAgentId:"agent",agentIds:["agent"]}}));
  const restarted=Fastify({rewriteUrl:rewriteProductUrl});registerProductScope(restarted,store,workspace,()=>undefined,()=>false);registerAgentPackageRoutes(restarted,{dataDir,store,coordination:{},assets:{},engines:new Map(),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:()=>[],createOperationalNotification(){}});
  t.after(()=>restarted.close());
  assert.equal((await restarted.inject(`/api/projects/${project.id}/agent-import-operations/${operationId}`)).statusCode,200);
  assert.equal((await restarted.inject(`/api/branches/engine/projects/${project.id}/agent-import-operations/${operationId}`)).statusCode,404);
});
