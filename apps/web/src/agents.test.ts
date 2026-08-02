import { describe, expect, it } from "vitest";
import { isProviderBlockedHealth } from "./agents";

describe("isProviderBlockedHealth", () => {
  it("requires the authoritative provider-blocked reason", () => {
    expect(isProviderBlockedHealth({
      status: "blocked",
      reason: "provider_capacity_unavailable",
    })).toBe(true);
    expect(isProviderBlockedHealth({
      status: "running",
      reason: "active_run",
    })).toBe(false);
    expect(isProviderBlockedHealth({
      status: "blocked",
      reason: "execution_lease_expired",
    })).toBe(false);
  });
});
