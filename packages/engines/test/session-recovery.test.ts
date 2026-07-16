import { describe, expect, it } from "vitest";
import { classifyProviderFailure, shouldRolloverEngineSession } from "../src/session-recovery.js";

describe("classifyProviderFailure", () => {
  it("recognizes capacity and rate-limit rejections", () => {
    expect(classifyProviderFailure("Selected model is at capacity")).toBe("capacity");
    expect(classifyProviderFailure("429 Too Many Requests: rate limit exceeded")).toBe("rate_limit");
    expect(classifyProviderFailure("compiler exited")).toBe("unknown");
  });
});

describe("shouldRolloverEngineSession", () => {
  it("classifies Codex pre-sampling compaction failures", () => {
    expect(
      shouldRolloverEngineSession(
        "codex",
        "codex exited with code 1: ERROR codex_core::session::turn: Failed to run pre-sampling compact",
      ),
    ).toBe(true);
  });

  it.each([
    "not logged in",
    "quota exceeded",
    "network connection closed",
    "model is unavailable",
    "run cancelled",
  ])("does not hide an unrelated Codex failure: %s", (message) => {
    expect(shouldRolloverEngineSession("codex", message)).toBe(false);
  });

  it("does not apply Codex-specific recovery to another engine", () => {
    expect(
      shouldRolloverEngineSession("claude", "Failed to run pre-sampling compact"),
    ).toBe(false);
  });
});
