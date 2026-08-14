import type { EngineDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import {
  engineCanTestAccess,
  engineIsAvailable,
  engineStatusPresentation,
} from "./conversationEngine.js";

function engine(overrides: Partial<EngineDto> = {}): EngineDto {
  return {
    id: "codex",
    displayName: "Codex",
    models: [],
    efforts: [],
    configured: true,
    authentication: "authenticated",
    enabled: true,
    intakeReady: true,
    reachability: "unverified",
    ...overrides,
  };
}

describe("provider readiness presentation", () => {
  it("keeps scheduler intake separate from real provider reachability", () => {
    const loading = engine();
    expect(engineIsAvailable(loading)).toBe(true);
    expect(engineCanTestAccess(loading)).toBe(true);
    expect(engineStatusPresentation(loading)).toEqual({
      label: "Intake ready",
      color: "success",
    });
  });

  it("reports positive real-work evidence as reachable", () => {
    const reachable = engine({ reachability: "reachable" });
    expect(engineCanTestAccess(reachable)).toBe(false);
    expect(engineStatusPresentation(reachable).label).toBe("Reachable");
  });

  it("does not call degraded or unauthenticated intake available", () => {
    expect(engineIsAvailable(engine({ intakeReady: false, reachability: "degraded" }))).toBe(false);
    expect(engineStatusPresentation(engine({ intakeReady: false, reachability: "degraded" })).label)
      .toBe("Needs attention");
    expect(engineIsAvailable(engine({ authentication: "unauthenticated", intakeReady: false }))).toBe(false);
    expect(engineStatusPresentation(engine({ authentication: "checking", intakeReady: false, reachability: "checking" })).label)
      .toBe("Checking");
  });
});
