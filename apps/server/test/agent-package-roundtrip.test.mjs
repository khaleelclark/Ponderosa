import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore } from "@ponderosa/agents";
import { AssetStore } from "../dist/assets.js";
import { registerAgentPackageRoutes } from "../dist/routes/agent-packages.js";

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
