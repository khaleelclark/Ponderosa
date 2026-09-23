import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateContextRolloverPressure,
  shouldRequestAutomaticContextRollover,
} from "../dist/context-rollover-pressure.js";

test("a pending handoff owns repeated pressure on the same provider session", () => {
  const preferences = { contextRolloverTokens: 150_000, contextRolloverWindowFraction: 0.8 };
  const sourcePressure = evaluateContextRolloverPressure({ usedTokens: 150_257 }, preferences);
  assert.equal(shouldRequestAutomaticContextRollover(sourcePressure, undefined), true);

  const handoffRunPressure = evaluateContextRolloverPressure({ usedTokens: 226_187 }, preferences);
  assert.equal(shouldRequestAutomaticContextRollover(
    handoffRunPressure, { state: "requested", compactionCutoffOrdinal: 599 },
  ), false);
  assert.equal(shouldRequestAutomaticContextRollover(
    handoffRunPressure, { state: "handoff_committed" },
  ), false);
  assert.equal(shouldRequestAutomaticContextRollover(
    evaluateContextRolloverPressure({ usedTokens: 50_000 }, preferences), undefined,
  ), false);
});
