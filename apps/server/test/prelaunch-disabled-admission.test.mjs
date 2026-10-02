import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.env.PONDEROSA_QUALIFICATION_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
const load = file => import(pathToFileURL(join(root, file)));
const { AgentStore, CoordinationV3Store } = await load("packages/agents/dist/index.js");
const { AssetStore } = await load("apps/server/dist/assets.js");
const { createServer } = await load("apps/server/dist/app.js");

test("disable during real Run preparation prevents provider launch and requeues the exact canonical work without consuming a retry", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "prelaunch-disabled-"))); const store = new AgentStore(directory);
  let launches = 0, entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const originalAssociate = AssetStore.prototype.associate;
  const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
  const chat = store.createConversation(p.id, { title: "Synthetic" });
  const agent = store.createAgent(p.id, { title: "Synthetic", engine: "codex", conversationId: chat.id });
  AssetStore.prototype.associate = async function (projectId, ...args) { if (projectId === p.id) { entered(); await gate; } return originalAssociate.call(this, projectId, ...args); };
  const adapter = { id: "codex", displayName: "Synthetic", trustedSystemPromptChannel: "developer", listModels: () => [], listEfforts: () => [], seed: async function* () { launches++; yield { type: "turn_done" }; }, continue: async function* () { launches++; yield { type: "turn_done" }; } };
  const app = createServer({ dataDir: directory, store, engines: [{ adapter }], logger: false, startDrained: true, communicationV3: { pollMs: 10 } });
  try {
    await app.ready();
    const intake = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Synthetic exact opening", idempotencyKey: "exact" } }); assert.equal(intake.statusCode, 202, intake.body);
    const resume = await app.inject({ method: "POST", url: "/api/deployment/resume" }); assert.equal(resume.statusCode, 200, resume.body);
    let waitingTimer;
    try { await Promise.race([started, new Promise((_resolve, reject) => { waitingTimer = setTimeout(() => reject(new Error(JSON.stringify({ runs: store.sqlite.prepare("SELECT status FROM scheduler_runs").all(), activations: store.sqlite.prepare("SELECT state,last_delivery_error FROM agent_activations").all() }))), 3000); })]); } finally { clearTimeout(waitingTimer); }
    const leased = store.sqlite.prepare("SELECT id, fencing_token FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(agent.id); assert.ok(leased);
    const activation = store.sqlite.prepare("SELECT activation_id FROM scheduler_run_activations WHERE run_id=?").get(leased.id).activation_id;
    await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { providerAvailability: { codex: false } } }); release();
    const deadline = Date.now() + 5000;
    while (["leased", "running"].includes(store.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id=?").get(leased.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(launches, 0);
    assert.equal(store.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id=?").get(leased.id).status, "cancelled");
    const held = store.sqlite.prepare("SELECT state, delivery_failures FROM agent_activations WHERE id=?").get(activation); assert.equal(held.state, "pending"); assert.equal(held.delivery_failures, 0);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?").get(agent.id).n, 1);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE project_id=?").get(p.id).n, 1);
  } finally { release(); AssetStore.prototype.associate = originalAssociate; app.prepareForShutdown(); await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("disabling intake does not cancel an accepted Run; canonical result and exact environment manifest remain valid", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "active-provider-disable-"))); const store = new AgentStore(directory);
  let app, release, entered; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
  const chat = store.createConversation(p.id, { title: "Synthetic" });
  const agent = store.createAgent(p.id, { title: "Synthetic", engine: "codex", conversationId: chat.id });
  const c = new CoordinationV3Store(store.sqlite);
  const adapter = { id: "codex", displayName: "Synthetic", trustedSystemPromptChannel: "developer", listModels: () => [], listEfforts: () => [], seed: async function* (options) {
    yield { type: "session", sessionId: "synthetic-session" }; entered(options); await gate;
    const result = await app.inject({ method: "POST", url: "/api/agent-request-updates", headers: { authorization: `Bearer ${options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN}` }, payload: { text: "one canonical result" } }); assert.equal(result.statusCode, 200, result.body);
    yield { type: "turn_done" };
  } };
  app = createServer({ dataDir: directory, store, engines: [{ adapter }], logger: false, startDrained: true, communicationV3: { pollMs: 10 } });
  try {
    await app.ready();
    c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "exact", requests: [{ requestId: "exact", recipientAgentId: agent.id, lifetime: { kind: "indefinite" }, payload: {} }] });
    await app.inject({ method: "POST", url: "/api/deployment/resume" });
    let waitingTimer; let options;
    try { options = await Promise.race([started, new Promise((_resolve, reject) => { waitingTimer = setTimeout(() => reject(Error("synthetic provider did not start")), 3000); })]); } finally { clearTimeout(waitingTimer); }
    const run = store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status='running'").get(agent.id); assert.ok(run);
    const input = store.getProviderInput(run.id, true); assert.equal(input.sourceManifest.environmentFacts.cwd, options.cwd);
    assert.equal(input.sourceManifest.environmentFacts.platform, process.platform); assert.equal(input.sourceManifest.environmentFacts.executables.length, 5);
    assert.match(input.sourceManifest.sources.find(source => source.kind === "environment").hash, /^[a-f0-9]{64}$/);
    assert.match(input.exactSystemPrompt, /Use only the current Run's host-provided reply route/);
    assert.match(input.exactPrompt, /no authorized default reply route/);
    assert.equal(`${input.exactPrompt}${input.exactSystemPrompt}`.includes(options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN), false);
    await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { providerAvailability: { codex: false } } });
    assert.equal(options.signal.aborted, false); assert.equal(store.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id=?").get(run.id).status, "running");
    const health = (await app.inject(`/api/conversations/${chat.id}/agent-health`)).json().agents.find(row => row.agentId === agent.id); assert.equal(health.status, "running"); assert.equal(health.admissionBlocker, undefined);
    release(); const deadline = Date.now() + 5000;
    while (store.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id=?").get(run.id).status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(c.getRequest("exact").state, "completed"); assert.equal(store.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id=?").get(run.id).status, "completed");
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_request_updates WHERE request_id='exact' AND kind='completed'").get().n, 1);
  } finally { release(); app.prepareForShutdown(); await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
