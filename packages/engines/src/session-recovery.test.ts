import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "./session-recovery.js";

describe("classifyProviderFailure", () => {
  it.each([
    "You have 0 weighted tokens left",
    "You've hit your usage limit. Your limit resets at 8:00 PM",
    "Session limit reached; try again later",
    "Quota is exhausted",
    "HTTP 429 Too Many Requests",
  ])("classifies provider quota wording as rate limited: %s", (message) => {
    expect(classifyProviderFailure(message)).toBe("rate_limit");
  });

  it("keeps capacity distinct from quota", () => {
    expect(classifyProviderFailure("Selected model is at capacity")).toBe("capacity");
  });
});
