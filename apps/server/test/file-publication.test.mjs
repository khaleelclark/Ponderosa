import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink, unlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { AgentStore, WorkspaceStore, CoordinationV3Store, MANAGED_ARTIFACT_MAX_BYTES } from "@ponderosa/agents";
import { PONDEROSA_IMPORT_FILE_TOOL } from "@ponderosa/core";
import { AssetStore } from "../dist/assets.js";
import { registerAgentRuntimeToolRoutes } from "../dist/routes/agent-runtime-tools.js";
import { registerArtifactRoutes } from "../dist/routes/artifacts.js";
import { ProjectFileAuthority } from "../dist/routes/project-files.js";
import { createProviderDynamicToolHandler } from "../dist/routes/provider-dynamic-tool-handler.js";
import { createServer } from "../dist/app.js";
import { registerAgentCommunicationRoutes } from "../dist/routes/agent-communications.js";

async function fixture(t, engine = "codex") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "file-publication-")));
  const workingRoot = path.join(root, randomUUID()), external = path.join(root, randomUUID()), dataDir = path.join(root, randomUUID());
  await mkdir(workingRoot); await mkdir(external);
  const body = Buffer.from(`Synthetic deliverable ${randomUUID()}\n`), source = path.join(external, "deliverable.bin");
  await writeFile(source, body);
  let store = new AgentStore(dataDir), workspace = new WorkspaceStore(dataDir), coordinator = new CoordinationV3Store(store.sqlite), assets = new AssetStore(dataDir), app;
  const project = store.createProject({ label: "Disposable", hostPath: workingRoot, defaultEngine: engine });
  const chat = store.createConversation(project.id, { title: "Disposable Chat" });
  const agent = store.createAgent(project.id, { title: "Publisher", engine, conversationId: chat.id });
  const activeRuns = new Map(), capabilities = new Map(), deletingProjectIds = new Set(), deletingAgentIds = new Set(), deletingConversationIds = new Set();
  let active, capability, token, storageOpen = true;
  function lease(messageId = randomUUID(), selectedAgent = agent, payload = {}) {
    coordinator.enqueueMessageActivation({ projectId: selectedAgent.projectId, agentId: selectedAgent.id,
      scopeKey: `conversation:${selectedAgent.conversationId}`, messageId, kind: "human", payload, bypassCapacity: true });
    const run = coordinator.leaseNextRun({ workerId: "fixture", leaseMs: 120000 });
    assert.equal(run.agentId, selectedAgent.id);
    const injection = { injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken };
    coordinator.preparePromptInjection({ ...injection, prompt: "Disposable synthetic turn" });
    coordinator.markPromptSubmitted(injection);
    coordinator.acknowledgePromptInjection(injection);
    coordinator.markRunStarted(run.runId, run.fencingToken);
    token = randomUUID();
    active = { runId: run.runId, executionId: run.runId, v3SchedulerRunId: run.runId, v3FencingToken: run.fencingToken,
      controller: new AbortController(), messageCapability: token, workingCopy: { rootPath: workingRoot }, conversationId: selectedAgent.conversationId };
    capability = { agentId: selectedAgent.id, conversationId: selectedAgent.conversationId, runId: run.runId,
      v3SchedulerRunId: run.runId, v3FencingToken: run.fencingToken, availableToolNames: [PONDEROSA_IMPORT_FILE_TOOL.name] };
    activeRuns.set(selectedAgent.id, active); capabilities.set(token, capability);
    return run;
  }
  function register() {
    app = Fastify();
    registerAgentRuntimeToolRoutes(app, { store, workspace, coordinationV3: coordinator, assets, dataDir, allowedImportRoots: [],
      activeRuns, agentMessageCapabilities: capabilities, deletingProjectIds, deletingAgentIds, deletingConversationIds,
      capabilityOwnsAuthoritativeRun: (cap, run) => cap.runId === run?.runId && coordinator.ownsRun(cap.runId, cap.v3FencingToken),
      publish: () => {}, publishWorkspaceSince: () => {} });
    registerArtifactRoutes(app, { store, assets, dataDir, projectFileAuthority: new ProjectFileAuthority(store, { resolve: async () => ({ rootPath: workingRoot }) }), publish: () => {}, managedProjectArtifactAgreesWithRuntime: () => false });
  }
  lease(); register();
  const send = (file = source, toolCallId = randomUUID(), extra = {}) => app.inject({ method: "POST", url: "/api/agent-import-file", headers: { authorization: `Bearer ${token}` }, payload: { path: file, toolCallId, ...extra } });
  const events = () => store.readEvents(agent.id).filter(row => row.event.type === "generated_artifact");
  async function request() {
    const response = await send(); assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().code, "outside_import_roots");
    const decision = workspace.getDecision(response.json().decisionId); assert.ok(decision); return decision;
  }
  const resolve = (decision, optionId = "approve") => workspace.resolveDecision(decision.id, { optionId, respondedAt: new Date().toISOString() });
  async function closeStorage() {
    await app.close();
    if (storageOpen) { assets.close(); store.close(); storageOpen = false; }
  }
  async function reopen() {
    await closeStorage();
    store = new AgentStore(dataDir); workspace = new WorkspaceStore(dataDir); coordinator = new CoordinationV3Store(store.sqlite); assets = new AssetStore(dataDir); register();
    storageOpen = true;
  }
  const finish = () => { coordinator.completeRun(active.runId, capability.v3FencingToken); activeRuns.clear(); capabilities.clear(); };
  t.after(async () => { await closeStorage(); await rm(root, { recursive: true, force: true }); });
  return { root, workingRoot, external, dataDir, body, source, project, chat, agent, send, events, request, resolve, reopen, closeStorage, lease, finish,
    deletingProjectIds, deletingAgentIds, deletingConversationIds,
    get app() { return app; }, get store() { return store; }, get workspace() { return workspace; }, get coordinator() { return coordinator; }, get active() { return active; }, get token() { return token; }, get assets() { return assets; } };
}

for (const engine of ["codex", "claude"]) test(`${engine}: ordinary external import remains rejected; scoped approval publishes exact bytes and retries one receipt`, async t => {
  const f = await fixture(t, engine);
  const decision = await f.request();
  assert.equal(decision.status, "pending"); assert.equal(f.events().length, 0);
  assert.deepEqual(decision.options.map(option => option.label), ["Publish this file", "Not now"]);
  assert.equal(decision.approvalScope.sha256, createHash("sha256").update(f.body).digest("hex"));
  assert.equal(decision.approvalScope.sourcePath, f.source); assert.equal(decision.conversationId, f.chat.id);
  assert.match(decision.context, /does not authorize other files/);
  assert.equal((await f.send()).json().decisionId, decision.id);
  f.resolve(decision);
  const first = await f.send(), repeated = await f.send();
  assert.equal(first.statusCode, 200, first.body); assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(first.json().artifact.id, repeated.json().artifact.id); assert.equal(f.events().length, 1);
  assert.equal(first.json().artifact.name, path.basename(f.source));
  const downloaded = await f.app.inject(first.json().artifact.downloadUrl);
  assert.equal(downloaded.statusCode, 200, downloaded.body); assert.deepEqual(downloaded.rawPayload, f.body);
  assert.ok(f.assets.authoritativeGeneratedArtifact(f.project.id, f.store.getProjectArtifact(f.project.id, first.json().artifact.id)));
});

test("pending, denied, cancelled, expired and failed approval persistence publish nothing", async t => {
  for (const outcome of ["pending", "denied", "cancelled", "expired", "failed"]) await t.test(outcome, async t => {
    const f = await fixture(t);
    if (outcome === "failed") {
      f.workspace.createDecision = () => { throw new Error("disposable persistence failure"); };
      const response = await f.send(); assert.equal(response.statusCode, 503); assert.equal(response.json().code, "publication_approval_storage_failure");
      assert.equal(f.workspace.listDecisions().length, 0);
    } else {
      const decision = await f.request();
      if (outcome === "denied") f.resolve(decision, "do_not_approve");
      if (outcome === "cancelled") f.workspace.cancelDecision(decision.id);
      if (outcome === "expired") { decision.approvalScope.expiresAt = new Date(0).toISOString(); f.resolve(decision); }
      const result = await f.send(); assert.notEqual(result.statusCode, 200);
      assert.equal(result.json().code, { pending: "outside_import_roots", denied: "publication_denied", cancelled: "publication_cancelled", expired: "publication_expired" }[outcome]);
    }
    assert.equal(f.events().length, 0); assert.equal(f.store.getProjectArtifacts(f.project.id).length, 0);
  });
});

test("changed bytes, symlinks, siblings and substituted paths cannot reuse approval", async t => {
  const f = await fixture(t), decision = await f.request(); f.resolve(decision);
  await writeFile(f.source, "different bytes");
  assert.equal((await f.send()).json().code, "publication_file_changed");
  const sibling = path.join(f.external, "sibling.bin"); await writeFile(sibling, f.body);
  const rejected = await f.send(sibling); assert.equal(rejected.statusCode, 403); assert.notEqual(rejected.json().decisionId, decision.id);
  await unlink(f.source); await symlink(sibling, f.source);
  assert.equal((await f.send()).json().code, "publication_unsafe_file");
  const alias = path.join(f.root, "alias"); await symlink(f.external, alias, "dir");
  assert.equal((await f.send(path.join(alias, "sibling.bin"))).json().code, "publication_unsafe_file");
  assert.equal(f.events().length, 0);
});

test("workspace imports are unchanged; oversized and missing external files fail before approval", async t => {
  const f = await fixture(t);
  const inside = path.join(f.workingRoot, "inside.txt"); await writeFile(inside, f.body);
  const imported = await f.send(inside, "stable-inside"), replay = await f.send(inside, "stable-inside");
  assert.equal(imported.statusCode, 200, imported.body); assert.equal(replay.json().artifact.id, imported.json().artifact.id);
  const oversized = path.join(f.external, "oversized.bin"); const descriptor = await open(oversized, "w");
  await descriptor.truncate(MANAGED_ARTIFACT_MAX_BYTES + 1); await descriptor.close();
  assert.equal((await f.send(oversized)).json().code, "publication_too_large");
  assert.equal((await f.send(path.join(f.external, "missing.bin"))).json().code, "publication_file_missing");
  assert.equal(f.workspace.listDecisions().length, 0);
});

test("exact Decision continuation and store reopening retain approval without duplicate publication", async t => {
  const f = await fixture(t), decision = await f.request();
  await f.reopen(); assert.equal((await f.send()).statusCode, 403, "restart never approves a pending Decision");
  f.resolve(f.workspace.getDecision(decision.id)); f.finish();
  f.lease(`decision:${decision.id}:response`, f.agent, { decision: { id: decision.id } });
  assert.equal(f.coordinator.decisionResponseAttachedToRun(decision.id, f.active.runId, f.agent.id), true);
  const first = await f.send(); assert.equal(first.statusCode, 200, first.body);
  await f.reopen();
  const replay = await f.send(); assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().artifact.id, first.json().artifact.id); assert.equal(f.events().length, 1);
});

test("other Runs and Agents cannot use an approval; payload prose is not continuation authority", async t => {
  const f = await fixture(t), decision = await f.request(); f.resolve(decision); f.finish();
  f.lease(randomUUID(), f.agent, { decision: { id: decision.id } });
  assert.equal(f.coordinator.decisionResponseAttachedToRun(decision.id, f.active.runId, f.agent.id), false);
  const unrelated = await f.send(); assert.equal(unrelated.statusCode, 403); assert.notEqual(unrelated.json().decisionId, decision.id);
  f.finish();
  const otherChat = f.store.createConversation(f.project.id, { title: "Other Chat" });
  const other = f.store.createAgent(f.project.id, { title: "Other", engine: "codex", conversationId: otherChat.id });
  f.lease(`decision:${decision.id}:response`, other, { decision: { id: decision.id } });
  const rejected = await f.send(); assert.equal(rejected.statusCode, 403); assert.notEqual(rejected.json().decisionId, decision.id);
  assert.equal(f.events().length, 0);
});

test("deletion and Run cancellation fence publication after approval", async t => {
  for (const target of ["agent", "chat", "project", "run"]) await t.test(target, async t => {
    const f = await fixture(t), decision = await f.request(); f.resolve(decision);
    if (target === "agent") f.deletingAgentIds.add(f.agent.id);
    if (target === "chat") f.deletingConversationIds.add(f.chat.id);
    if (target === "project") f.deletingProjectIds.add(f.project.id);
    if (target === "run") f.active.controller.abort();
    assert.notEqual((await f.send()).statusCode, 200); assert.equal(f.events().length, 0);
  });
});

test("storage failure reuses the approved operation rather than duplicating its artifact", async t => {
  const f = await fixture(t), decision = await f.request(); f.resolve(decision);
  const register = f.assets.registerPublishedGeneratedArtifactImport.bind(f.assets);
  let fail = true;
  f.assets.registerPublishedGeneratedArtifactImport = (...args) => { const receipt = register(...args); if (fail) { fail = false; throw new Error("failure after durable receipt"); } return receipt; };
  const failed = await f.send(); assert.equal(failed.statusCode, 503); assert.equal(failed.json().code, "publication_storage_failure");
  const recovered = await f.send(); assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(f.events().length, 1);
});

test("provider dynamic-tool rejection stays an ordinary recoverable result", async t => {
  const f = await fixture(t);
  const handler = createProviderDynamicToolHandler(f.app, [PONDEROSA_IMPORT_FILE_TOOL], f.token);
  const rejected = await handler({ id: "proposal", name: PONDEROSA_IMPORT_FILE_TOOL.name, arguments: { path: f.source } });
  assert.equal(rejected.success, false); const body = JSON.parse(rejected.text); assert.equal(body.code, "outside_import_roots");
  f.resolve(f.workspace.getDecision(body.decisionId));
  const published = await handler({ id: "retry", name: PONDEROSA_IMPORT_FILE_TOOL.name, arguments: { path: f.source } });
  assert.equal(published.success, true); assert.equal(f.events().length, 1);
});

test("real operator Decision response persists first, rejects expired/deleted owners, and cannot grant access on failed persistence", async t => {
  const f = await fixture(t), decision = await f.request();
  const makeDecision = (idempotencyKey, patch) => f.workspace.createDecision({
    projectId: f.project.id, conversationId: f.chat.id, agentId: f.agent.id, runId: f.active.runId,
    question: "Publish the synthetic file?", mode: "approval", blocking: true, allowOther: false,
    options: decision.options, idempotencyKey,
    approvalScope: { ...decision.approvalScope, operationId: randomUUID(), ...patch },
  });
  const expired = makeDecision("expired", { expiresAt: new Date(0).toISOString() });
  const deletedOwner = makeDecision("deleted", { agentId: randomUUID() });
  await f.app.close();
  const operator = createServer({ dataDir: f.dataDir, store: f.store, engines: [], logger: false, startDrained: true });
  await operator.ready();
  try {
    const original = WorkspaceStore.prototype.resolveDecision;
    WorkspaceStore.prototype.resolveDecision = function (id, response) { if (id === decision.id) throw new Error("injected approval persistence failure"); return original.call(this, id, response); };
    try {
      const failed = await operator.inject({ method: "POST", url: `/api/decisions/${decision.id}/respond`, payload: { optionId: "approve" } });
      assert.equal(failed.statusCode, 503, failed.body); assert.equal(failed.json().code, "publication_approval_storage_failure");
      assert.equal((await operator.inject("/api/decisions?status=pending")).json().some(item => item.id === decision.id), true);
      assert.equal(f.events().length, 0);
    } finally { WorkspaceStore.prototype.resolveDecision = original; }
    assert.equal((await operator.inject({ method: "POST", url: `/api/decisions/${expired.id}/respond`, payload: { optionId: "approve" } })).json().code, "publication_expired");
    assert.equal((await operator.inject({ method: "POST", url: `/api/decisions/${deletedOwner.id}/respond`, payload: { optionId: "approve" } })).json().code, "publication_cancelled");
    const accepted = await operator.inject({ method: "POST", url: `/api/decisions/${decision.id}/respond`, payload: { optionId: "approve" } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(new WorkspaceStore(f.dataDir).getDecision(decision.id).response.optionId, "approve");
    assert.equal(f.events().length, 0, "approval itself does not publish or read into storage");
  } finally { operator.prepareForShutdown(); await operator.close(); }
  await f.reopen();
});

test("Claude MCP transport exposes the same recoverable publication Decision and exact receipt", async t => {
  const f = await fixture(t, "claude");
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  const endpoint = `http://127.0.0.1:${f.app.server.address().port}/api/agent-import-file`;
  const transport = fileURLToPath(new URL("../../../packages/engines/dist/ponderosa-mcp.js", import.meta.url));
  const child = spawn(process.execPath, [transport], { env: { PATH: process.env.PATH, PONDEROSA_AGENT_IMPORT_FILE_URL: endpoint, PONDEROSA_AGENT_MESSAGE_TOKEN: f.token, PONDEROSA_AGENT_TOOL_NAMES: JSON.stringify([PONDEROSA_IMPORT_FILE_TOOL.name]) }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; const responses = new Map(); const pending = new Map();
  child.stdout.on("data", chunk => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) !== -1) {
      const response = JSON.parse(output.slice(0, newline)); output = output.slice(newline + 1);
      responses.set(response.id, response); pending.get(response.id)?.(response);
    }
  });
  const call = id => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Disposable MCP transport timed out")), 10000);
    pending.set(id, response => { clearTimeout(timer); resolve(response.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "import_file", arguments: { path: f.source } } }) + "\n");
  });
  try {
    const rejected = await call(1); assert.equal(rejected.isError, true);
    const result = JSON.parse(rejected.content[0].text); assert.equal(result.code, "outside_import_roots");
    f.resolve(f.workspace.getDecision(result.decisionId));
    const accepted = await call(2); assert.equal(accepted.isError, false);
    const replay = await call(3); assert.equal(replay.isError, false);
    assert.equal(JSON.parse(accepted.content[0].text).artifact.id, JSON.parse(replay.content[0].text).artifact.id);
    assert.equal(f.events().length, 1);
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve)); child.stdin.end(); await exited;
  }
});

test("external publication preserves existing format handling and exact bytes across deliverable extensions", async t => {
  const f = await fixture(t);
  for (const extension of ["pdf", "png", "jpg", "jpeg", "webp", "gif", "svg", "docx", "xlsx", "pptx", "jar", "md", "txt", "csv", "log", "json", "html", "zip", "apk", "ttf", "py", "bin"]) {
    const source = path.join(f.external, `${randomUUID()}.${extension}`); await writeFile(source, f.body);
    const pending = await f.send(source); assert.equal(pending.statusCode, 403, pending.body);
    f.resolve(f.workspace.getDecision(pending.json().decisionId));
    const published = await f.send(source); assert.equal(published.statusCode, 200, published.body);
    const downloaded = await f.app.inject(published.json().artifact.downloadUrl);
    assert.deepEqual(downloaded.rawPayload, f.body, extension);
    const inside = path.join(f.workingRoot, `${randomUUID()}.${extension}`); await writeFile(inside, f.body);
    assert.equal((await f.send(inside)).json().artifact.mediaType, published.json().artifact.mediaType, extension);
  }
});

test("concurrent calls and missing or changed sources after publication recover one immutable receipt without communication", async t => {
  const f = await fixture(t), decision = await f.request(); f.resolve(decision);
  const responses = await Promise.all([f.send(), f.send(), f.send()]);
  assert(responses.some(response => response.statusCode === 200), "one concurrent call publishes");
  for (let index = 0; index < responses.length; index++) {
    if (responses[index].statusCode === 503) responses[index] = await f.send();
    assert.equal(responses[index].statusCode, 200, responses[index].body);
  }
  assert.equal(new Set(responses.map(response => response.json().artifact.id)).size, 1);
  await writeFile(f.source, "later unrelated contents");
  assert.equal((await f.send()).json().artifact.id, responses[0].json().artifact.id);
  await unlink(f.source);
  assert.equal((await f.send()).json().artifact.id, responses[0].json().artifact.id);
  const download = await f.app.inject(responses[0].json().artifact.downloadUrl);
  assert.deepEqual(download.rawPayload, f.body); assert.equal(f.events().length, 1);
  assert.equal(f.store.getMessages(f.agent.id).length, 0, "publication never creates additional communication");
});

test("lost Run or deleting owner after the secure read cannot commit an artifact", async t => {
  for (const target of ["run", "chat"]) await t.test(target, async t => {
    const f = await fixture(t), decision = await f.request(); f.resolve(decision);
    const ownsRun = f.coordinator.ownsRun.bind(f.coordinator); let checks = 0;
    f.coordinator.ownsRun = (...args) => {
      if (++checks === 3) {
        if (target === "run") f.coordinator.cancelAgentRun({ agentId: f.agent.id, expectedRunId: f.active.runId, idempotencyKey: randomUUID() });
        else f.deletingConversationIds.add(f.chat.id);
      }
      return ownsRun(...args);
    };
    const response = await f.send(); assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "publication_cancelled"); assert.equal(f.events().length, 0);
    assert.equal(f.store.getProjectArtifacts(f.project.id).length, 0);
  });
});

test("fresh application processes retain a pending Decision and persist approval without publishing", async t => {
  const f = await fixture(t), decision = await f.request();
  f.finish();
  const entry = new URL("../dist/app.js", import.meta.url).href;
  for (const approve of [false, true]) {
    await f.closeStorage();
    const script = `import assert from 'node:assert/strict'; import {createServer} from ${JSON.stringify(entry)};
      const app=createServer({dataDir:${JSON.stringify(f.dataDir)},engines:[],logger:false,startDrained:true});
      try { await app.ready(); const pending=await app.inject('/api/decisions?status=pending');
        assert.equal(pending.json().some(d=>d.id===${JSON.stringify(decision.id)}),true);
        ${approve ? `const response=await app.inject({method:'POST',url:${JSON.stringify(`/api/decisions/${decision.id}/respond`)},payload:{optionId:'approve'}}); assert.equal(response.statusCode,200,response.body);` : ""}
      } finally { app.prepareForShutdown(); await app.close(); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk; }); child.stdout.resume();
    const code = await new Promise(resolve => child.once("exit", resolve)); assert.equal(code, 0, errors);
    await f.reopen();
    assert.equal(f.workspace.getDecision(decision.id).status, approve ? "resolved" : "pending");
    assert.equal(f.events().length, 0);
  }
  const continuation = f.lease(`decision:${decision.id}:response`);
  const activated = f.coordinator.activationPayloads(f.agent.id, continuation.activationIds, continuation.runId);
  assert.deepEqual(activated[0].payload.decision.publication, {
    sourcePath: f.source, filename: path.basename(f.source), operationId: decision.approvalScope.operationId,
    sha256: decision.approvalScope.sha256, size: f.body.length, expiresAt: decision.approvalScope.expiresAt,
  }, "a fresh continuation receives approved metadata without relying on provider memory");
  const response = await f.send(); assert.equal(response.statusCode, 200, response.body); assert.equal(f.events().length, 1);
});

test("the published artifact attaches through the real Agent message route with one canonical idempotent response", async t => {
  const f = await fixture(t), decision = await f.request(); f.resolve(decision);
  const imported = await f.send(); assert.equal(imported.statusCode, 200, imported.body);
  const artifactId = imported.json().artifact.id;
  const coordinator = new CoordinationV3Store(f.store.sqlite, {
    managedArtifactAttachmentAuthority: ({ projectId, artifactIds, sender, audience }) => {
      assert.equal(sender.agentId, f.agent.id); assert.equal(audience.kind, "user_agent");
      for (const id of artifactIds) {
        const artifact = f.store.getProjectArtifact(projectId, id);
        assert(f.store.agentCanReadProjectArtifact(projectId, id, sender.agentId));
        assert(f.store.operatorCanReadProjectArtifact(projectId, id));
        assert(f.store.agentCanReadProjectArtifact(projectId, id, audience.agentId));
        assert(f.assets.managedProjectArtifactMetadataIsAuthoritative(projectId, artifact));
      }
    },
    managedArtifactAttachmentRevalidator: ({ projectId, artifactIds }) => {
      for (const id of artifactIds) assert(f.assets.managedProjectArtifactIsAvailable(projectId, f.store.getProjectArtifact(projectId, id)));
    },
  });
  f.store.configureCommunicationAttachmentMetadataAuthority((projectId, artifact) =>
    f.assets.managedProjectArtifactMetadataIsAuthoritative(projectId, artifact));
  const messageApp = Fastify(); t.after(() => messageApp.close());
  const capability = { agentId: f.agent.id, conversationId: f.chat.id, runId: f.active.runId, v3FencingToken: f.active.v3FencingToken };
  registerAgentCommunicationRoutes(messageApp, {
    store: f.store, workspace: f.workspace, coordinationV3: coordinator,
    activeRuns: new Map([[f.agent.id, f.active]]), agentMessageCapabilities: new Map([[f.token, capability]]),
    projectDeletionInProgress: () => false, conversationDeletionInProgress: () => false, agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(), agentDeliveryLeases: new Map(),
    capabilityOwnsAuthoritativeRun: cap => coordinator.ownsRun(cap.runId, cap.v3FencingToken),
    runAuthorization: cap => ({ runId: cap.runId, agentId: cap.agentId, fencingToken: cap.v3FencingToken }),
    reconcileRuntimeCommunicationProjections: async ({ communicationEventId }) => {
      f.store.appendCommunicationEvent(coordinator.runtimeCommunication(communicationEventId).payload.communication);
      return 1;
    },
    resolveOperationalNotification: () => {}, notifyScheduler: () => {},
  });
  const request = { method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${f.token}` },
    payload: { intent: "direct_to_user", text: "The synthetic deliverable is ready.", artifactIds: [artifactId], idempotencyKey: "publication-response" } };
  const first = await messageApp.inject(request), replay = await messageApp.inject(request);
  assert.equal(first.statusCode, 200, first.body); assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(first.json().eventId, replay.json().eventId); assert.equal(replay.json().replayed, true);
  assert.deepEqual(coordinator.runtimeCommunication(first.json().eventId).payload.communication.artifactIds, [artifactId]);
  const download = await f.app.inject(imported.json().artifact.downloadUrl);
  assert.deepEqual(download.rawPayload, f.body); assert.equal(f.events().length, 1);
});
