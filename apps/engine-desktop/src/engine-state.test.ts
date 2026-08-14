import { describe, expect, it } from "vitest";
import { classifyEngineReadiness, type EngineReadinessSnapshot } from "./engine-state.js";

const readiness = (overrides: Partial<EngineReadinessSnapshot> = {}): EngineReadinessSnapshot => ({
  status: "ready",
  canAcceptWork: true,
  acceptingDurableIntake: true,
  leasingRuns: true,
  checks: { daemon: { ok: true, detail: "daemon request loop is running" } },
  ...overrides,
});

describe("classifyEngineReadiness", () => {
  it("does not call a merely reachable service ready", () => {
    expect(classifyEngineReadiness(undefined)).toEqual({
      state: "reachable",
      detail: "The local service is reachable; intake readiness could not be verified yet.",
    });
  });

  it("calls the service running only when authoritative readiness accepts work", () => {
    expect(classifyEngineReadiness(readiness()).state).toBe("running");
  });

  it("retains the failed readiness reason for a degraded service", () => {
    expect(classifyEngineReadiness(readiness({
      status: "not_ready",
      canAcceptWork: false,
      checks: { runtimes: { ok: false, detail: "no authenticated runtime is intake-ready" } },
    }))).toEqual({
      state: "degraded",
      detail: "no authenticated runtime is intake-ready",
    });
  });
});
