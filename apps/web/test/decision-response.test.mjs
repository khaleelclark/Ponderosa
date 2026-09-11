import assert from "node:assert/strict";
import test from "node:test";
import { settleDecisionResponse } from "../src/components/decisions/decisionResponse.js";

test("a rejected Decision response is consumed and remains retryable", async () => {
  let attempts = 0;
  const respond = () => settleDecisionResponse(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("offline");
    return "resolved";
  });
  assert.equal(await respond(), undefined);
  assert.equal(await respond(), "resolved");
  assert.equal(attempts, 2);
});
