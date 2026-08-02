import { describe, expect, it } from "vitest";
import { codexContextUsageSnapshot } from "./codex-app-server.js";

describe("Codex context occupancy", () => {
  it("keeps cumulative traffic separate from last-request context occupancy", () => {
    expect(codexContextUsageSnapshot({
      total: {
        inputTokens: 9_900_000,
        outputTokens: 293_417,
        totalTokens: 10_193_417,
      },
      last: {
        inputTokens: 200_000,
        outputTokens: 3_233,
        totalTokens: 203_233,
      },
      modelContextWindow: 258_400,
    })).toEqual({
      usedTokens: 203_233,
      aggregateTokens: 10_193_417,
      modelContextWindow: 258_400,
    });
  });

  it("uses input plus output when Codex omits a last-request total", () => {
    expect(codexContextUsageSnapshot({
      total: { totalTokens: 10_000_000 },
      last: { inputTokens: 40_000, outputTokens: 5_000 },
    })).toEqual({ usedTokens: 45_000, aggregateTokens: 10_000_000 });
  });
});
