import type { EngineDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { providerAvailabilityMessage } from "./providerAvailability";

function degraded(detail: string): EngineDto {
  return {
    id: "codex",
    displayName: "Codex",
    models: [],
    efforts: [],
    configured: true,
    authentication: "authenticated",
    enabled: true,
    intakeReady: false,
    reachability: "degraded",
    availabilityDetail: detail,
  };
}

describe("canonical provider availability categories", () => {
  it("uses authentication remediation for expired and inactive subscriptions", () => {
    for (const detail of ["subscription expired", "subscription inactive"]) {
      expect(providerAvailabilityMessage(degraded(detail))).toBe(
        "Codex access is unavailable. Check the provider subscription and sign-in, then retry.",
      );
    }
  });

  it("uses limit remediation when the provider reports zero weighted tokens", () => {
    expect(providerAvailabilityMessage(degraded("0 weighted tokens left"))).toBe(
      "Codex access is unavailable. Wait for the provider usage limit to reset, then retry.",
    );
  });
});
