import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore, publishManagedArtifactContentAsync } from "@ponderosa/agents";
import { AssetStore } from "../dist/assets.js";
import { registerAgentPackageRoutes } from "../dist/routes/agent-packages.js";

test("template exports avoid history readers while full and legacy context preserve private audience", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-template-export-"));
  const store = new AgentStore(dataDir);
  const assets = new AssetStore(dataDir);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    assets.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.createProject({ label: "Template", hostPath: dataDir, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Template Chat" });
  store.updateConversation(chat.id, { instructions: "Full context only" });
  const root = store.createAgent(project.id, { title: "Root", engine: "codex", conversationId: chat.id });
  const child = store.createAgent(project.id, { title: "Child", engine: "codex", conversationId: chat.id, managerAgentId: root.id });
  let documentReads = 0, importedReads = 0, messageReads = 0;
  store.readCommunicationEvents = () => {
    documentReads++;
    return [{ sender: { kind: "user" }, intent: "user_dm", audience: { kind: "user_agent", agentId: root.id },
      conversationId: chat.id, document: { artifactId: "private-document" }, text: "Private root document", createdAt: "2026-10-08T00:00:00Z" }];
  };
  store.getImportedHistory = id => {
    importedReads++;
    return { messages: [{ role: "user", text: `Imported ${id}`, createdAt: "2026-10-08T00:00:00Z" }] };
  };
  registerAgentPackageRoutes(app, {
    dataDir, store, assets,
    coordination: { runtimeArtifact: () => undefined, handleAgentDeletion: () => {} },
    engines: new Map(), deletingProjectIds: new Set(), deletingConversationIds: new Set(), deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(), cachedModelOptions: () => [], appendWorkspace: () => {},
    agentMessages: id => {
      messageReads++;
      return [{ role: "assistant", text: `Current ${id}`, createdAt: "2026-10-08T00:00:00Z" }];
    },
    createOperationalNotification: () => {},
  });
  const exported = async mode => {
    const response = await app.inject({ method: "GET", url: `/api/agents/${root.id}/export?mode=${mode}&organization=true&download=1` });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers["content-type"], /^application\/json/);
    assert.match(response.headers["content-disposition"], /\.ponderosa\.json"$/);
    const result = response.json();
    delete result.exportedAt;
    return result;
  };
  const template = await exported("template");
  assert.equal(template.mode, "template");
  assert.equal(template.agents.length, 2);
  assert.equal(template.sourceProjectInstructions, undefined);
  assert.ok(template.agents.every(agent => !('history' in agent) && !('artifacts' in agent)));
  assert.deepEqual([documentReads, importedReads, messageReads], [0, 0, 0]);
  const full = await exported("full");
  assert.equal(full.mode, "full");
  assert.equal(full.sourceProjectInstructions, "Full context only");
  assert.match(JSON.stringify(full.agents.find(agent => agent.ref === root.id).history), /Private root document/);
  assert.doesNotMatch(JSON.stringify(full.agents.find(agent => agent.ref === child.id).history), /Private root document/);
  assert.deepEqual([documentReads, importedReads, messageReads], [1, 2, 2]);
  assert.deepEqual(await exported("context"), full);
});

test("full package import and export preserve artifacts across bounded batches", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-package-roundtrip-"));
  const store = new AgentStore(dataDir);
  const assets = new AssetStore(dataDir);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    assets.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
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
  const project = store.createProject({ label: "Roundtrip", hostPath: "/tmp/project", defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Roundtrip" });
  const ref = randomUUID();
  const source = Array.from({ length: 270 }, (_, index) => {
    const bytes = Buffer.from(`artifact-${index}-content`);
    return {
      ref: randomUUID(), kind: "document", path: `artifact-${index}.txt`,
      createdAt: new Date().toISOString(), mediaType: "text/plain",
      dataBase64: bytes.toString("base64"),
    };
  });
  const portable = {
    schema: "ponderosa.agent-package.v1", mode: "full", kind: "agent",
    exportedAt: new Date().toISOString(), sourceLabel: "Roundtrip", rootRef: ref,
    agents: [{
      ref, title: "Roundtrip", engine: "codex",
      managementPermissions: {
        allowAutomaticDescendantDeletion: false,
        allowAutomaticDescendantReorganization: false,
      },
      artifacts: source,
    }],
  };
  const payload = Buffer.from(
    `${JSON.stringify({ conversationId: chat.id, engineMapping: { codex: "codex" } })}\n${JSON.stringify(portable)}`,
  );
  const imported = await app.inject({
    method: "POST", url: `/api/projects/${project.id}/import-agent-package`,
    headers: {
      "content-type": "application/vnd.ponderosa.agent-import",
      "idempotency-key": "roundtrip-270-artifacts",
    },
    payload,
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const exported = await app.inject({
    method: "GET", url: `/api/agents/${imported.json().rootAgentId}/export?mode=full`,
  });
  assert.equal(exported.statusCode, 200, exported.body.slice(0, 200));
  const after = exported.json().agents[0].artifacts;
  assert.equal(after.length, source.length);
  assert.deepEqual(
    after.map((item) => item.dataBase64).sort(),
    source.map((item) => item.dataBase64).sort(),
  );
  store.createAgent(project.id, {
    title: "Roundtrip child",
    engine: "codex",
    conversationId: chat.id,
    managerAgentId: imported.json().rootAgentId,
  });
  for (const mode of ["template", "full"]) {
    for (const organization of [false, true]) {
      const download = await app.inject({
        method: "GET",
        url: `/api/agents/${imported.json().rootAgentId}/export?mode=${mode}&organization=${organization}&download=1`,
      });
      assert.equal(download.statusCode, 200, download.body.slice(0, 200));
      assert.match(download.headers["content-type"], /^application\/json/);
      assert.match(download.headers["content-disposition"], /\.ponderosa\.json"$/);
      assert.equal(download.json().schema, "ponderosa.agent-package.v1");
      assert.equal(download.json().mode, mode);
      assert.equal(download.json().kind, organization ? "organization" : "agent");
    }
  }
  const copied = await app.inject({
    method: "POST", url: `/api/projects/${project.id}/copy-agent`,
    headers: { "idempotency-key": "roundtrip-copy-270-artifacts" },
    payload: { sourceAgentId: imported.json().rootAgentId, conversationId: chat.id, mode: "full", rootTitle: "Copied root" },
  });
  assert.equal(copied.statusCode, 201, copied.body);
  const copiedExport = await app.inject({
    method: "GET", url: `/api/agents/${copied.json().rootAgentId}/export?mode=full`,
  });
  assert.equal(copiedExport.statusCode, 200, copiedExport.body.slice(0, 200));
  assert.equal(copiedExport.json().agents[0].title, "Copied root");
  assert.deepEqual(
    copiedExport.json().agents[0].artifacts.map((item) => item.dataBase64).sort(),
    source.map((item) => item.dataBase64).sort(),
  );
});

test("same-Chat Agent export excludes another Agent's long private document", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-private-package-"));
  const store = new AgentStore(dataDir);
  const assets = new AssetStore(dataDir);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    assets.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  registerAgentPackageRoutes(app, {
    dataDir, store,
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
  const project = store.createProject({ label: "Private export", hostPath: "/tmp/private-export", defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Shared Chat" });
  const alice = store.createAgent(project.id, { title: "Alice", engine: "codex", conversationId: chat.id });
  const bob = store.createAgent(project.id, { title: "Bob", engine: "codex", conversationId: chat.id });
  const artifactId = randomUUID();
  const privateText = `PRIVATE-AUDIT-MARKER ${"x".repeat(12_000)} ${artifactId}`;
  await publishManagedArtifactContentAsync(dataDir, project.id, artifactId, privateText);
  store.appendCommunicationEvent({
    schemaVersion: 2,
    eventId: randomUUID(),
    projectId: project.id,
    conversationId: chat.id,
    sender: { kind: "user", userId: "operator" },
    intent: "user_dm",
    audience: { kind: "user_agent", userId: "operator", agentId: alice.id },
    text: privateText,
    document: {
      id: randomUUID(), title: "Private", mediaType: "text/markdown", artifactId,
      byteLength: Buffer.byteLength(privateText), authorUserId: "operator",
      createdAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  });
  const exportAgent = async (id) => {
    const response = await app.inject({ method: "GET", url: `/api/agents/${id}/export?mode=full` });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
    return response.json();
  };
  assert.match(JSON.stringify(await exportAgent(alice.id)), /PRIVATE-AUDIT-MARKER/);
  assert.doesNotMatch(JSON.stringify(await exportAgent(bob.id)), /PRIVATE-AUDIT-MARKER/);
  assert.doesNotMatch(JSON.stringify(await exportAgent(bob.id)), new RegExp(artifactId));
});
