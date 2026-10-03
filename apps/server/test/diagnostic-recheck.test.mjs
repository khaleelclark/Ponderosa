import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../dist/app.js";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("rechecks coalesce through late handler settlement; old success cannot erase a newer denial or enable a disabled provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-recheck-"));
  let release, started, probes = 0;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const app = createServer({ dataDir: root, logger: false, startDrained: true, resourceAdmission: { enabled: false }, requestLimits: { handlerDeadlineMs: 100 }, engines: [{ adapter: { id: "codex", displayName: "Synthetic", listModels: () => [], listEfforts: () => [] }, authStatus: async () => ({ authenticated: true }), availabilityProbe: async () => { probes++; started(); await gate; return { available: true }; } }] });
  try {
    await app.ready();
    const requests = Array.from({ length: 10 }, () => app.inject({ method: "POST", url: "/api/engines/codex/recheck" }));
    await entered;
    const replies = await Promise.all(requests); assert.ok(replies.every(reply => reply.statusCode === 504)); assert.equal(probes, 1);
    const more = app.inject({ method: "POST", url: "/api/engines/codex/recheck" }); await delay(120); assert.equal(probes, 1);
    await app.inject({ method: "PATCH", url: "/api/engines/codex", payload: { enabled: false } });
    release(); await more; await delay(30);
    const engine = (await app.inject("/api/engines")).json()[0]; assert.equal(engine.enabled, false); assert.equal(engine.intakeReady, false);
  } finally { release(); app.prepareForShutdown(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
