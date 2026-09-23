import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EngineAvailabilityStore } from "../dist/engine-availability-store.js";

test("availability evidence records serving build and startup identity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ponderosa-availability-"));
  try {
    const first = new EngineAvailabilityStore(dir, "revision-a");
    const observed = first.record({ engineId: "codex", available: true, source: "provider_run" });
    assert.equal(observed.buildRevision, "revision-a");
    assert.equal(observed.instanceId, first.servingInstanceId);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "engine-availability.jsonl"), "utf8")).instanceId,
      first.servingInstanceId);

    const second = new EngineAvailabilityStore(dir, "revision-b");
    assert.equal(second.get("codex")?.buildRevision, "revision-a");
    assert.notEqual(second.servingInstanceId, first.servingInstanceId);
    const refreshed = second.record({ engineId: "codex", available: true, source: "operator_probe" });
    assert.equal(refreshed.buildRevision, "revision-b");
    assert.equal(refreshed.instanceId, second.servingInstanceId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy evidence remains visible but cannot claim current provenance", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ponderosa-availability-"));
  try {
    writeFileSync(path.join(dir, "engine-availability.jsonl"), JSON.stringify({
      engineId: "codex", available: false, source: "provider_run",
      observedAt: "2026-09-22T11:59:59.000Z",
    }) + "\n");
    const store = new EngineAvailabilityStore(dir, "revision-b");
    assert.equal(store.denial("codex")?.available, false);
    assert.equal(store.get("codex")?.buildRevision, undefined);
    assert.equal(store.get("codex")?.instanceId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
