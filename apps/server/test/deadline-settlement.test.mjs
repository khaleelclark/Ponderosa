import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import Fastify from "fastify";
import { registerRequestSecurityHooks } from "../dist/server-request-hooks.js";

for (const mode of ["implicit", "explicit", "throw"]) {
  test(`deadline sends once for late ${mode}, holding admission until actual settlement`, async () => {
    const logs = []; const app = Fastify({ logger: { level: "warn", stream: { write: line => logs.push(JSON.parse(line)) } } });
    registerRequestSecurityHooks(app, { opts: { dataDir: "/tmp/unused", engines: [], requestLimits: { maxRequestsPerMinute: 100, maxInflight: 1, handlerDeadlineMs: 10 } }, v3DispatchKey: "synthetic", agentMessageCapabilities: new Map(), deletingAgentIds: new Set(), validLauncherSession: () => false, artifactFilesystemError: () => undefined, isArtifactDependentWorkIntake: () => false, isPublicWebAssetRequest: () => false });
    let settle; const blocked = new Promise(resolve => { settle = resolve; });
    let settled = false;
    app.get("/api/delayed", async (_request, reply) => {
      await blocked; settled = true;
      if (mode === "throw") throw Error("controlled late failure");
      if (mode === "explicit") return reply.send({ late: true });
      return { late: true };
    });
    app.get("/api/quick", async () => ({ ok: true }));
    try {
      const response = await app.inject("/api/delayed");
      assert.equal(response.statusCode, 504);
      assert.equal(settled, false);
      assert.equal((await app.inject("/api/quick")).statusCode, 503);
      settle(); await delay(15);
      assert.equal(settled, true);
      assert.equal((await app.inject("/api/quick")).statusCode, 200);
      assert.ok(!logs.some(log => log.err?.code === "FST_ERR_REP_ALREADY_SENT" || /Promise errored, but reply.sent/.test(log.msg)));
      if (mode === "throw") assert.ok(logs.some(log => log.msg === "request handler failed after deadline response"));
    } finally { settle(); await app.close(); }
  });
}
