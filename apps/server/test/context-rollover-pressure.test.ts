import { describe, expect, it } from "vitest";
import { evaluateContextRolloverPressure } from "../src/context-rollover-pressure.js";

const preferences = {
  contextRolloverTokens: 75_000,
  contextRolloverWindowFraction: 0.7,
};

describe("context rollover pressure", () => {
  it("does not roll over for ten million aggregate tokens when occupancy is 45k", () => {
    expect(evaluateContextRolloverPressure({
      usedTokens: 45_000,
      aggregateTokens: 10_000_000,
      windowTokens: 258_400,
    }, preferences)).toEqual({
      shouldRequest: false,
      threshold: 75_000,
      lowWaterMark: 45_000,
    });
  });

  it("requests rollover when current occupancy crosses the threshold even with low aggregate traffic", () => {
    expect(evaluateContextRolloverPressure({
      usedTokens: 75_001,
      aggregateTokens: 80_000,
      windowTokens: 258_400,
    }, preferences)).toMatchObject({ shouldRequest: true, threshold: 75_000 });
  });
});
