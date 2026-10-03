import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { AgentStore, WorkspaceStore, CoordinationV3Store } from "@ponderosa/agents";
import { PONDEROSA_IMPORT_FILE_TOOL } from "@ponderosa/core";
import { AssetStore } from "../dist/assets.js";
import { registerAgentRuntimeToolRoutes } from "../dist/routes/agent-runtime-tools.js";
import { runtimeEnvironmentFacts } from "../dist/runtime-environment-facts.js";

test("a reviewer publishes from the existing external root; rejected and symbolic paths are never copied or granted", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "reviewer-publication-")));
  const writer = join(directory, "writer"), authorized = join(directory, "reports"), outside = join(directory, "outside");
  await Promise.all([writer, authorized, outside].map(path => mkdir(path)));
  const store = new AgentStore(join(directory, "data")), app = Fastify();
  const p = store.createProject({ label: "Synthetic", hostPath: writer, defaultEngine: "codex" });
  const a = store.createAgent(p.id, { title: "Reviewer", engine: "codex", conversationId: p.lastConversationId });
  const runId = randomUUID();
  const capability = { agentId: a.id, runId, availableToolNames: [PONDEROSA_IMPORT_FILE_TOOL.name] };
  const assets = new AssetStore(join(directory, "data"));
  registerAgentRuntimeToolRoutes(app, { store, workspace: new WorkspaceStore(join(directory, "data")), coordinationV3: new CoordinationV3Store(store.sqlite), publishWorkspaceSince: () => {}, assets, dataDir: join(directory, "data"), allowedImportRoots: [authorized], agentMessageCapabilities: new Map([["synthetic", capability]]), activeRuns: new Map([[a.id, { runId, executionId: runId, controller: new AbortController(), messageCapability: "synthetic", workingCopy: { rootPath: writer } }]]), capabilityOwnsAuthoritativeRun: () => true, publish: () => {} });
  const send = (path, toolCallId) => app.inject({ method: "POST", url: "/api/agent-import-file", headers: { authorization: "Bearer synthetic" }, payload: { path, toolCallId } });
  try {
    const facts = await runtimeEnvironmentFacts({ cwd: writer, agentId: a.id, allowedImportRoots: [authorized] });
    assert.ok(facts.reportOutputRoot.startsWith(authorized)); await mkdir(facts.reportOutputRoot, { recursive: true });
    const report = join(facts.reportOutputRoot, "review.md"); await writeFile(report, "Synthetic review only");
    const first = await send(report, "publish"); assert.equal(first.statusCode, 200, first.body);
    const replay = await send(report, "publish"); assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().artifact.id, first.json().artifact.id);
    assert.equal(store.readEvents(a.id).filter(item => item.event.type === "generated_artifact").length, 1);
    const excluded = join(outside, "excluded.md"); await writeFile(excluded, "Must not be copied");
    const rejected = await send(excluded, "excluded"); assert.equal(rejected.statusCode, 403); assert.equal(rejected.json().code, "outside_import_roots"); assert.ok(rejected.json().decisionId); assert.match(rejected.json().error, /single-file publication Decision/);
    const escape = join(facts.reportOutputRoot, "escape.md"); await symlink(excluded, escape);
    const symbolic = await send(escape, "escape"); assert.notEqual(symbolic.statusCode, 200);
    assert.equal(store.readEvents(a.id).filter(item => item.event.type === "generated_artifact").length, 1);
  } finally { await app.close(); assets.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
