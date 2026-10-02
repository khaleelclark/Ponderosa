import assert from "node:assert/strict";
import test from "node:test";
import { settleDecisionResponse, decisionResponseChoice, decisionResponseSummary } from "../src/components/decisions/decisionResponse.js";

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

test("text, choice and approval presentation names the recipient without modifying answers", () => {
  for (const [mode, response, expected] of [
    ["text", { text: "Do it yourself #NotTheRecipient" }, "Answered #Boston: Do it yourself #NotTheRecipient"],
    ["choice", { optionId: "yes" }, "Chose for #Boston: Continue"],
    ["approval", { optionId: "yes" }, "Approval response to #Boston: Continue"],
  ]) {
    const decision = { mode, response, options: [{ id: "yes", label: "Continue" }] };
    const original = structuredClone(decision);
    assert.equal(decisionResponseSummary(decision, decisionResponseChoice(decision), "#Boston"), expected);
    assert.deepEqual(decision, original);
  }
});

test("historical automatic responses preserve their original text", () => {
  assert.equal(decisionResponseChoice({ response: { optionId: "auto_allowed", text: "Automatically allowed by your saved permission" },
    options: [{ id: "auto_allowed", label: "This must not replace the historical text" }] }), "Automatically allowed by your saved permission");
});
