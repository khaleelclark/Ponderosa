import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineAvailabilityStore } from "../src/engine-availability-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EngineAvailabilityStore", () => {
  it("keeps provider denial authoritative across time and restart until positive evidence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-engine-availability-"));
    dirs.push(dir);
    const first = new EngineAvailabilityStore(dir);
    first.record({
      engineId: "claude",
      available: false,
      detail: "subscription inactive",
      source: "provider_run",
      observedAt: "2026-07-16T00:00:00.000Z",
    });

    const restarted = new EngineAvailabilityStore(dir);
    expect(restarted.denial("claude")).toMatchObject({ detail: "subscription inactive" });
    restarted.record({
      engineId: "claude",
      available: true,
      detail: "test request accepted",
      source: "operator_probe",
      observedAt: "2026-07-16T03:00:00.000Z",
    });
    expect(new EngineAvailabilityStore(dir).denial("claude")).toBeUndefined();
    expect(readFileSync(path.join(dir, "engine-availability.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});
