import assert from "node:assert/strict";
import test from "node:test";
import { outcomeCauseFromPayload, outcomeCauseExplanation } from "../dist/outcome-cause.js";

test("recorded uncertain outcomes have distinct, safe explanations", () => {
  const noUpdate = outcomeCauseFromPayload({ reason: "run_completed_without_request_update", runId: "run-1" });
  assert.equal(noUpdate.runId, "run-1");
  assert.match(outcomeCauseExplanation(noUpdate), /did not report/i);

  const notInjected = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", promptSubmissionState: "not_injected" });
  const injected = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", promptSubmissionState: "injected" });
  assert.match(outcomeCauseExplanation(notInjected), /before Ponderosa confirmed task delivery/i);
  assert.match(outcomeCauseExplanation(injected), /Earlier changes may exist/i);
  assert.notEqual(outcomeCauseExplanation(notInjected), outcomeCauseExplanation(injected));
  const auth = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", providerFailureCategory: "authentication" });
  assert.match(outcomeCauseExplanation(auth), /rejected its sign-in/i);
  assert.match(outcomeCauseExplanation(outcomeCauseFromPayload({ reason: "run_cancelled_by_operator" })), /You stopped/i);
});

test("unknown historical reasons never become public failure prose", () => {
  const cause = outcomeCauseFromPayload({ reason: "private stack trace", runId: "../../unsafe" });
  assert.deepEqual(cause, { code: "cause_unavailable" });
  assert.doesNotMatch(outcomeCauseExplanation(cause), /private stack trace/);
});
