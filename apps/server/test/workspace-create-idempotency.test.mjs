import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

function registerBasicProjectRoutes(app, store, managedWorkspacesRoot, options = {}) {
  return registerProjectRoutes(app, {
    store,
    workspace: { getPreferences: () => ({}) },
    engines: new Map([["codex", { adapter }]]),
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
    ...options,
  });
}

const projectCreationArtifacts = async (root) => (await readdir(root))
  .filter((name) => name.startsWith(".project-creation-"))
  .sort();

test("standalone Chat creation is idempotent and cannot reuse a Project identity", async t => {
  const root = await mkdtemp(path.join(tmpdir(),"ponderosa-chat-create-"));
  const store = new AgentStore(root);
  const app = Fastify();
  t.after(async()=>{await app.close();store.close();await rm(root,{recursive:true,force:true});});
  registerBasicProjectRoutes(app,store,path.join(root,"managed"));
  const headers = {"idempotency-key":"standalone-chat-test"};
  const payload = {label:"New Chat",defaultEngine:"codex"};
  const first = await app.inject({method:"POST",url:"/api/chats",headers,payload});
  assert.equal(first.statusCode,200,first.body);
  const chat = first.json();
  assert.equal(chat.title,"New Chat");
  assert.ok(chat.workingDirectory.includes("chat-"));
  const replay = await app.inject({method:"POST",url:"/api/chats",headers,payload});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().id,chat.id);
  assert.throws(()=>store.updateProject(chat.projectId,{instructions:"Wrong owner"}),/owning Chat/);
  const collision = await app.inject({method:"POST",url:"/api/projects",headers,payload});
  assert.equal(collision.statusCode,409,collision.body);
});

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

test("concurrent managed Project creation serializes one exact idempotency claim", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-route-concurrent-"));
  const managedWorkspacesRoot = path.join(dataDir, "managed");
  const store = new AgentStore(dataDir);
  const app = Fastify();
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let reachedFirst;
  const firstReached = new Promise((resolve) => { reachedFirst = resolve; });
  let held = false;
  registerBasicProjectRoutes(app, store, managedWorkspacesRoot, {
    managedProjectCreationFault: async (boundary) => {
      if (boundary !== "receipt_persisted" || held) return;
      held = true;
      reachedFirst();
      await firstHeld;
    },
  });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = {
    method: "POST",
    url: "/api/projects",
    headers: { "idempotency-key": "project-concurrent-exact" },
    payload: { label: "Concurrent", defaultEngine: "codex", createFolderName: "concurrent" },
  };
  const first = app.inject(request);
  await firstReached;
  const followers = Array.from({ length: 7 }, () => app.inject(request));
  const conflict = await app.inject({
    ...request,
    payload: { ...request.payload, label: "Different" },
  });
  assert.equal(conflict.statusCode, 409);
  releaseFirst();
  const responses = await Promise.all([first, ...followers]);
  assert.deepEqual(responses.map((response) => response.statusCode), Array(8).fill(200));
  assert.equal(new Set(responses.map((response) => response.json().id)).size, 1);
  assert.equal(store.listProjects().filter((project) => project.label === "Concurrent").length, 1);
  assert.deepEqual(await projectCreationArtifacts(managedWorkspacesRoot), []);
});

test("managed Project creation restarts cleanly at every durable preparation boundary", async (t) => {
  const boundaries = [
    "receipt_persisted",
    "marker_seed_persisted",
    "preparation_directory_created",
    "preparation_marker_installed",
    "stage_published",
  ];
  for (const boundary of boundaries) {
    const dataDir = await mkdtemp(path.join(tmpdir(), `ponderosa-project-route-${boundary}-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const managedWorkspacesRoot = path.join(dataDir, "managed");
    let store = new AgentStore(dataDir);
    let app = Fastify();
    let injected = false;
    registerBasicProjectRoutes(app, store, managedWorkspacesRoot, {
      managedProjectCreationFault: (reached) => {
        if (reached === boundary && !injected) {
          injected = true;
          throw new Error(`injected ${boundary} interruption`);
        }
      },
    });
    const request = {
      method: "POST",
      url: "/api/projects",
      headers: { "idempotency-key": `restart-${boundary.replaceAll("_", "-")}` },
      payload: { label: boundary, defaultEngine: "codex", createFolderName: boundary },
    };
    const interrupted = await app.inject(request);
    assert.equal(interrupted.statusCode, 500, `${boundary}: ${interrupted.body}`);
    await app.close();
    store.close();

    store = new AgentStore(dataDir);
    app = Fastify();
    registerBasicProjectRoutes(app, store, managedWorkspacesRoot);
    await app.ready();
    const retried = await app.inject(request);
    assert.equal(retried.statusCode, 200, `${boundary}: ${retried.body}`);
    assert.deepEqual(await projectCreationArtifacts(managedWorkspacesRoot), [], boundary);
    await app.close();
    store.close();
  }
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

test("Chat creation is rejected after Project deletion quarantine at route and store boundaries", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-chat-project-quarantine-"));
  const store = new AgentStore(dataDir);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const existingChatIds = store.listConversations(project.id).map(chat => chat.id);
  store.markProjectDeletionPending(project.id);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  registerConversationRoutes(app, {
    store,
    workspace: { getPreferences: () => ({}) },
    engines: new Map([["codex", { adapter }]]),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    generateConversationTitle: async () => ({ title: "Chat", generated: false }),
    conversationDetail: () => undefined,
    agentHealth: () => ({}),
    teamDirectory: () => ({}),
    hasActiveRun: () => false,
    projectDeletionInProgress: () => true,
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: async () => 0,
    refreshTriggers: async () => {},
    processConversationDeletionCleanup: async () => true,
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/conversations`,
    headers: { "idempotency-key": "late-chat-route" },
    payload: { title: "Late Chat" },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(store.listConversations(project.id).map(chat => chat.id), existingChatIds);

  assert.throws(
    () => store.createConversation(project.id, { title: "Store race loser" }, {
      idempotencyKey: "late-chat-store",
      payloadHash: "a".repeat(64),
    }),
    /Project deletion is in progress/u,
  );
  assert.deepEqual(store.listConversations(project.id).map(chat => chat.id), existingChatIds);
  const receipt = store.commitProjectDeletion(project.id);
  assert.deepEqual(receipt?.draftSurfaceIds, existingChatIds.flatMap(id => [id, `collaboration:${id}`]));
});

test("startup removes authenticated orphan contender stages and preserves foreign stages", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-orphan-stages-"));
  const managedWorkspacesRoot = path.join(dataDir, "managed");
  let store = new AgentStore(dataDir);
  let app = Fastify();
  registerBasicProjectRoutes(app, store, managedWorkspacesRoot);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const key = "project-orphan-contenders";
  const payload = {
    label: "Settled",
    defaultEngine: "codex",
    createFolderName: "settled",
  };
  const created = await app.inject({
    method: "POST", url: "/api/projects",
    headers: { "idempotency-key": key }, payload,
  });
  assert.equal(created.statusCode, 200, created.body);
  const base = managedCreationReceipt(managedWorkspacesRoot, key, payload);
  for (const token of [
    "31111111-1111-4111-8111-111111111111",
    "32222222-2222-4222-8222-222222222222",
  ]) {
    const receipt = { ...base.receipt, version: 2, ownershipToken: token, phase: "staged" };
    const stage = path.join(
      managedWorkspacesRoot,
      `.project-creation-${createHash("sha256").update(key).digest("hex")}-${token}.staging`,
    );
    await mkdir(stage);
    await writeFile(
      path.join(stage, ".ponderosa-project-creation.jsonl"),
      `${JSON.stringify(receipt)}\n`,
    );
  }
  const abortedKey = "project-aborted-contenders";
  const abortedPayload = {
    label: "Aborted",
    defaultEngine: "codex",
    createFolderName: "aborted",
  };
  const abortedBase = managedCreationReceipt(
    managedWorkspacesRoot, abortedKey, abortedPayload,
  );
  for (const [token, current] of [
    ["41111111-1111-4111-8111-111111111111", true],
    ["42222222-2222-4222-8222-222222222222", false],
  ]) {
    const receipt = {
      ...abortedBase.receipt,
      version: 2,
      ownershipToken: token,
      phase: "staged",
    };
    if (current) {
      await writeFile(abortedBase.receiptPath, `${JSON.stringify(receipt)}\n`);
    }
    const stage = path.join(
      managedWorkspacesRoot,
      `.project-creation-${createHash("sha256").update(abortedKey).digest("hex")}-${token}.staging`,
    );
    await mkdir(stage);
    await writeFile(
      path.join(stage, ".ponderosa-project-creation.jsonl"),
      `${JSON.stringify(receipt)}\n`,
    );
  }
  const foreignToken = "33333333-3333-4333-8333-333333333333";
  const foreignStage = path.join(
    managedWorkspacesRoot,
    `.project-creation-${createHash("sha256").update(key).digest("hex")}-${foreignToken}.staging`,
  );
  await mkdir(foreignStage);
  await writeFile(path.join(foreignStage, "KEEP.txt"), "keep");
  const foreignMarkerToken = "34444444-4444-4444-8444-444444444444";
  const foreignMarkerStage = path.join(
    managedWorkspacesRoot,
    `.project-creation-${createHash("sha256").update(key).digest("hex")}-${foreignMarkerToken}.staging`,
  );
  const foreignMarkerPath = path.join(
    foreignMarkerStage, ".ponderosa-project-creation.jsonl",
  );
  await mkdir(foreignMarkerStage);
  await writeFile(foreignMarkerPath, "{torn");

  await app.close();
  store.close();
  store = new AgentStore(dataDir);
  app = Fastify();
  registerBasicProjectRoutes(app, store, managedWorkspacesRoot);
  await app.ready();
  assert.deepEqual(await projectCreationArtifacts(managedWorkspacesRoot), [
    path.basename(foreignMarkerStage),
    path.basename(foreignStage),
  ].sort());
  assert.equal(await readFile(path.join(foreignStage, "KEEP.txt"), "utf8"), "keep");
  assert.equal(await readFile(foreignMarkerPath, "utf8"), "{torn");
  await app.close();
  store.close();
});

test("managed Project folder receipts recover owned states and preserve ambiguous folders", async (t) => {
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
  const managedFolders = registerProjectRoutes(app, {
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
    if (phase === "empty-folder") {
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(existsSync(receipt.hostPath), true);
      assert.equal(existsSync(receiptPath), false);
      continue;
    }
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(existsSync(receipt.hostPath), true);
    assert.equal(existsSync(receiptPath), false);
    assert.equal(existsSync(path.join(receipt.hostPath, ".ponderosa-project-creation.jsonl")), false);
  }

  for (const [boundary, phase] of [
    ["preparing-receipt", "preparing"],
    ["preparing-stage", "preparing"],
    ["staged", "staged"],
    ["target-reserved", "target_reserved"],
  ]) {
    const key = `managed-v2-${boundary}`;
    const payload = { label: boundary, defaultEngine: "codex", createFolderName: boundary };
    const base = managedCreationReceipt(managedWorkspacesRoot, key, payload);
    const token = boundary === "preparing-receipt"
      ? "61111111-1111-4111-8111-111111111111"
      : boundary === "preparing-stage"
        ? "62222222-2222-4222-8222-222222222222"
        : boundary === "staged"
          ? "63333333-3333-4333-8333-333333333333"
          : "64444444-4444-4444-8444-444444444444";
    const receipt = { ...base.receipt, version: 2, ownershipToken: token, phase };
    const stagePath = path.join(
      managedWorkspacesRoot,
      `.project-creation-${createHash("sha256").update(key).digest("hex")}-${token}.staging`,
    );
    await writeFile(base.receiptPath, `${JSON.stringify(receipt)}\n`);
    if (boundary !== "preparing-receipt") await mkdir(stagePath);
    if (["staged", "target-reserved"].includes(boundary)) {
      await writeFile(
        path.join(stagePath, ".ponderosa-project-creation.jsonl"),
        `${JSON.stringify(receipt)}\n`,
      );
    }
    if (boundary === "target-reserved") await mkdir(receipt.hostPath);
    await managedFolders.reconcileManagedProjectFolders();
    if (boundary === "preparing-stage") {
      assert.equal(existsSync(base.receiptPath), true);
      assert.equal(existsSync(stagePath), true);
      assert.equal(existsSync(receipt.hostPath), false);
      continue;
    }
    assert.equal(existsSync(base.receiptPath), false);
    assert.equal(existsSync(stagePath), false);
    assert.equal(existsSync(receipt.hostPath), false);
    const retry = await app.inject({
      method: "POST", url: "/api/projects",
      headers: { "idempotency-key": key }, payload,
    });
    assert.equal(retry.statusCode, 200, retry.body);
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

  const stagedKey = "managed-staged-conflict";
  const stagedPayload = { label: "Staged", defaultEngine: "codex", createFolderName: "foreign-empty" };
  const stagedBase = managedCreationReceipt(managedWorkspacesRoot, stagedKey, stagedPayload);
  const ownershipToken = "11111111-1111-4111-8111-111111111111";
  const stagedReceipt = {
    ...stagedBase.receipt,
    version: 2,
    ownershipToken,
    phase: "staged",
  };
  const stagedPath = path.join(
    managedWorkspacesRoot,
    `.project-creation-${createHash("sha256").update(stagedKey).digest("hex")}-${ownershipToken}.staging`,
  );
  await writeFile(stagedBase.receiptPath, `${JSON.stringify(stagedReceipt)}\n`);
  await mkdir(stagedPath);
  await writeFile(
    path.join(stagedPath, ".ponderosa-project-creation.jsonl"),
    `${JSON.stringify(stagedReceipt)}\n`,
  );
  await mkdir(stagedReceipt.hostPath);
  const stagedConflict = await app.inject({
    method: "POST", url: "/api/projects", headers: { "idempotency-key": stagedKey },
    payload: stagedPayload,
  });
  assert.equal(stagedConflict.statusCode, 409, stagedConflict.body);
  assert.equal(existsSync(stagedReceipt.hostPath), true);
  assert.equal(existsSync(stagedPath), true);
  assert.equal(existsSync(stagedBase.receiptPath), true);
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(stagedReceipt.hostPath), true);
  assert.equal(existsSync(stagedPath), true);
  assert.equal(existsSync(stagedBase.receiptPath), true);

  const deletedKey = "managed-deleted-cleanup";
  const deletedPayload = { label: "Deleted", defaultEngine: "codex", createFolderName: "deleted" };
  const deletedBase = managedCreationReceipt(managedWorkspacesRoot, deletedKey, deletedPayload);
  const deletedReceipt = {
    ...deletedBase.receipt,
    version: 2,
    ownershipToken: "22222222-2222-4222-8222-222222222222",
    phase: "installed",
  };
  await writeFile(deletedBase.receiptPath, `${JSON.stringify(deletedReceipt)}\n`);
  await mkdir(deletedReceipt.hostPath);
  await writeFile(
    path.join(deletedReceipt.hostPath, ".ponderosa-project-creation.jsonl"),
    `${JSON.stringify(deletedReceipt)}\n`,
  );
  const deletedProject = store.createProject({
    label: deletedPayload.label,
    hostPath: deletedReceipt.hostPath,
    defaultEngine: "codex",
  }, {
    idempotencyKey: deletedKey,
    payloadHash: deletedReceipt.payloadHash,
  });
  assert.equal(store.deleteProject(deletedProject.id), true);
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(deletedBase.receiptPath), false);
  assert.equal(existsSync(deletedReceipt.hostPath), false);

  const retainedKey = "managed-retained-content";
  const retainedPayload = { label: "Retained", defaultEngine: "codex", createFolderName: "retained" };
  const retainedBase = managedCreationReceipt(managedWorkspacesRoot, retainedKey, retainedPayload);
  const retainedReceipt = {
    ...retainedBase.receipt,
    version: 2,
    ownershipToken: "55555555-5555-4555-8555-555555555555",
    phase: "installed",
  };
  await writeFile(retainedBase.receiptPath, `${JSON.stringify(retainedReceipt)}\n`);
  await mkdir(retainedReceipt.hostPath);
  await writeFile(
    path.join(retainedReceipt.hostPath, ".ponderosa-project-creation.jsonl"),
    `${JSON.stringify(retainedReceipt)}\n`,
  );
  await writeFile(path.join(retainedReceipt.hostPath, "user.txt"), "keep");
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(retainedBase.receiptPath), false);
  assert.equal(existsSync(retainedReceipt.hostPath), true);
  assert.equal(existsSync(path.join(retainedReceipt.hostPath, ".ponderosa-project-creation.jsonl")), false);
  assert.equal(await readFile(path.join(retainedReceipt.hostPath, "user.txt"), "utf8"), "keep");

  const preservedKey = "managed-preserved-restart";
  const preservedPayload = { label: "Preserved", defaultEngine: "codex", createFolderName: "preserved" };
  const preservedBase = managedCreationReceipt(managedWorkspacesRoot, preservedKey, preservedPayload);
  const preservedReceipt = {
    ...preservedBase.receipt,
    version: 2,
    ownershipToken: "65555555-5555-4555-8555-555555555555",
    phase: "content_preserved",
  };
  await writeFile(preservedBase.receiptPath, `${JSON.stringify(preservedReceipt)}\n`);
  await mkdir(preservedReceipt.hostPath);
  await writeFile(path.join(preservedReceipt.hostPath, "user.txt"), "keep after marker removal");
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(preservedBase.receiptPath), false);
  assert.equal(await readFile(path.join(preservedReceipt.hostPath, "user.txt"), "utf8"), "keep after marker removal");

  const abandonedKey = "managed-unauthenticated-stage";
  const abandonedPayload = { label: "Abandoned", defaultEngine: "codex", createFolderName: "abandoned" };
  const abandonedBase = managedCreationReceipt(managedWorkspacesRoot, abandonedKey, abandonedPayload);
  const abandonedReceipt = {
    ...abandonedBase.receipt,
    version: 2,
    ownershipToken: "66666666-6666-4666-8666-666666666666",
    phase: "preparing",
  };
  const abandonedStage = path.join(
    managedWorkspacesRoot,
    `.project-creation-${createHash("sha256").update(abandonedKey).digest("hex")}-${abandonedReceipt.ownershipToken}.staging`,
  );
  await writeFile(abandonedBase.receiptPath, `${JSON.stringify(abandonedReceipt)}\n`);
  await mkdir(abandonedStage);
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(abandonedBase.receiptPath), true);
  assert.equal(existsSync(abandonedStage), true);

  const stagedCleanupKey = "managed-staged-cleanup-restart";
  const stagedCleanupPayload = {
    label: "Staged Cleanup",
    defaultEngine: "codex",
    createFolderName: "staged-cleanup",
  };
  const stagedCleanupBase = managedCreationReceipt(
    managedWorkspacesRoot,
    stagedCleanupKey,
    stagedCleanupPayload,
  );
  const stagedCleanupReceipt = {
    ...stagedCleanupBase.receipt,
    version: 2,
    ownershipToken: "67777777-7777-4777-8777-777777777777",
    phase: "staged",
  };
  const stagedCleanupPath = path.join(
    managedWorkspacesRoot,
    `.project-creation-${createHash("sha256").update(stagedCleanupKey).digest("hex")}-${stagedCleanupReceipt.ownershipToken}.staging`,
  );
  await writeFile(stagedCleanupBase.receiptPath, `${JSON.stringify(stagedCleanupReceipt)}\n`);
  await mkdir(stagedCleanupPath);
  await writeFile(
    path.join(stagedCleanupPath, ".ponderosa-project-creation.jsonl"),
    `${JSON.stringify(stagedCleanupReceipt)}\n`,
  );
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(stagedCleanupBase.receiptPath), false);
  assert.equal(existsSync(stagedCleanupPath), false);

  for (const kind of ["stage", "target"]) {
    const key = `managed-symlink-${kind}`;
    const payload = { label: kind, defaultEngine: "codex", createFolderName: `symlink-${kind}` };
    const base = managedCreationReceipt(managedWorkspacesRoot, key, payload);
    const receipt = {
      ...base.receipt,
      version: 2,
      ownershipToken: kind === "stage"
        ? "76666666-6666-4666-8666-666666666666"
        : "77777777-7777-4777-8777-777777777777",
      phase: kind === "stage" ? "staged" : "installed",
    };
    const external = path.join(dataDir, `external-${kind}`);
    await mkdir(external);
    const externalMarker = path.join(external, ".ponderosa-project-creation.jsonl");
    await writeFile(externalMarker, `${JSON.stringify(receipt)}\n`);
    await writeFile(base.receiptPath, `${JSON.stringify(receipt)}\n`);
    const linkedPath = kind === "stage"
      ? path.join(
          managedWorkspacesRoot,
          `.project-creation-${createHash("sha256").update(key).digest("hex")}-${receipt.ownershipToken}.staging`,
        )
      : receipt.hostPath;
    await symlink(external, linkedPath, "dir");
    await managedFolders.reconcileManagedProjectFolders();
    assert.equal(await readFile(externalMarker, "utf8"), `${JSON.stringify(receipt)}\n`);
    assert.equal(existsSync(base.receiptPath), true);
  }

  const cleanupKey = "managed-cleanup-restart";
  const cleanupPayload = { label: "Cleanup", defaultEngine: "codex", createFolderName: "cleanup" };
  const cleanupBase = managedCreationReceipt(managedWorkspacesRoot, cleanupKey, cleanupPayload);
  const cleanupReceipt = {
    ...cleanupBase.receipt,
    version: 2,
    ownershipToken: "88888888-8888-4888-8888-888888888888",
    phase: "cleanup_prepared",
  };
  await writeFile(cleanupBase.receiptPath, `${JSON.stringify(cleanupReceipt)}\n`);
  await mkdir(cleanupReceipt.hostPath);
  await writeFile(
    path.join(cleanupReceipt.hostPath, ".ponderosa-project-creation.jsonl"),
    `${JSON.stringify(cleanupReceipt)}\n`,
  );
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(cleanupReceipt.hostPath), false);
  assert.equal(existsSync(cleanupBase.receiptPath), false);

  const partialKey = "managed-cleanup-partial";
  const partialPayload = { label: "Partial", defaultEngine: "codex", createFolderName: "partial" };
  const partialBase = managedCreationReceipt(managedWorkspacesRoot, partialKey, partialPayload);
  const partialToken = "99999999-9999-4999-8999-999999999999";
  const partialPath = path.join(
    managedWorkspacesRoot,
    `.project-creation-${createHash("sha256").update(partialKey).digest("hex")}-${partialToken}.cleanup`,
  );
  await mkdir(partialPath);
  const partialStat = await lstat(partialPath);
  const partialReceipt = {
    ...partialBase.receipt,
    version: 2,
    ownershipToken: partialToken,
    phase: "cleanup_authorized",
    cleanupDevice: String(partialStat.dev),
    cleanupInode: String(partialStat.ino),
  };
  await writeFile(partialBase.receiptPath, `${JSON.stringify(partialReceipt)}\n`);
  await managedFolders.reconcileManagedProjectFolders();
  assert.equal(existsSync(partialPath), false);
  assert.equal(existsSync(partialBase.receiptPath), false);
});
