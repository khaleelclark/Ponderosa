import assert from "node:assert/strict";
import test from "node:test";
import { sseReplayWithinBudget } from "../dist/routes/streams.js";

test("SSE replay admits ordinary bounded event batches", () => {
  assert.equal(sseReplayWithinBudget([{ id: 1, text: "ok" }], 10), true);
});

test("SSE replay resets when its byte or preparation-time budget is exceeded", () => {
  assert.equal(sseReplayWithinBudget([{ text: "x".repeat(8 * 1024 * 1024) }], 10), false);
  assert.equal(sseReplayWithinBudget([{ id: 1 }], 2_001), false);
});
