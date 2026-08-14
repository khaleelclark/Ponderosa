import { classifyProviderFailure as classifyCoreProviderFailure } from "@ponderosa/core";
import { classifyProviderFailure as classifyEngineProviderFailure } from "@ponderosa/engines";
import { describe, expect, it } from "vitest";
import { publicProviderFailureCategorySummary } from "./provider-availability-detail.js";

describe("provider failure category projection", () => {
  it.each([
    ["subscription expired", "authentication", "Provider authentication was rejected."],
    ["subscription inactive", "authentication", "Provider authentication was rejected."],
    ["0 weighted tokens left", "rate_limit", "Provider usage limit was reached."],
  ] as const)("keeps %s canonical", (detail, category, summary) => {
    expect(classifyCoreProviderFailure(detail)).toBe(category);
    expect(classifyEngineProviderFailure(detail)).toBe(category);
    expect(publicProviderFailureCategorySummary(detail)).toBe(summary);
  });
});
