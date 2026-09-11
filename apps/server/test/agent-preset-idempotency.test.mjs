import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore } from "@ponderosa/agents";
import { registerAgentPresetRoutes } from "../dist/routes/agent-presets.js";

test("Agent preset POST requires and replays one exact creation identity", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-preset-route-"));
  const store = new AgentStore(dataDir);
  const project = store.createProject({
    label: "Project", hostPath: "/tmp/project", defaultEngine: "codex",
  });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  registerAgentPresetRoutes(app, { store, validateRuntimeSelection: () => undefined });
  const payload = {
    name: "Custom QA",
    description: "Checks",
    guidance: "Verify exact behavior carefully.",
    engine: "codex",
  };
  const request = {
    method: "POST",
    url: `/api/projects/${project.id}/agent-presets`,
    headers: { "idempotency-key": "preset-route-stable" },
    payload,
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 201, first.body);
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, first.json().id);
  assert.equal(store.listAgentPresets(project.id).filter((preset) => preset.name === payload.name).length, 1);

  const conflict = await app.inject({ ...request, payload: { ...payload, name: "Changed" } });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const missing = await app.inject({ method: "POST", url: request.url, payload });
  assert.equal(missing.statusCode, 400, missing.body);
});
