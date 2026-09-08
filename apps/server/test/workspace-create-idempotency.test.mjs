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
    assert.equal(existsSync(base.receiptPath), false);
    assert.equal(existsSync(stagePath), false);
    assert.equal(existsSync(receipt.hostPath), boundary === "target-reserved");
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
  assert.equal(existsSync(stagedPath), false);
  assert.equal(existsSync(stagedBase.receiptPath), false);

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
});
