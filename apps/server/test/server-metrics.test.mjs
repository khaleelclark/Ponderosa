import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { ServerMetrics } from "../dist/server-metrics.js";

test("authenticated metrics remain bounded by route patterns and expose runtime state", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ponderosa-metrics-"));
  const app = Fastify({ logger: false });
  const metrics = new ServerMetrics(dataDir, {
    totalMs: 1_250,
    recoveryMs: 250,
    projectCount: 7,
  });
  metrics.install(app);
  app.get("/api/projects/:id", async () => ({ ok: true }));
  try {
    await app.inject({ method: "GET", url: "/api/projects/untrusted-cardinality" });
    const close = metrics.openSse(true);
    metrics.sseBackpressure();
    close();
    const output = metrics.render({
      activeRuns: 2,
      deploymentBlockers: 3,
      browserCleanupPending: 4,
      browserCleanupFailed: 1,
    });
    assert.match(output, /ponderosa_startup_duration_seconds\{phase="total"\} 1\.25/u);
    assert.match(output, /ponderosa_startup_projects 7/u);
    assert.match(output, /ponderosa_active_runs 2/u);
    assert.match(output, /ponderosa_sse_opened_total 1/u);
    assert.match(output, /ponderosa_sse_backpressure_disconnects_total 1/u);
    assert.match(output, /route="\/api\/projects\/:id"/u);
    assert.doesNotMatch(output, /untrusted-cardinality/u);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
