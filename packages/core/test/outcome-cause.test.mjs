import assert from "node:assert/strict";
import test from "node:test";
import { outcomeCauseFromPayload, outcomeCauseExplanation } from "../dist/outcome-cause.js";

test("recorded uncertain outcomes have distinct, safe explanations", () => {
  const noUpdate = outcomeCauseFromPayload({ reason: "run_completed_without_request_update", runId: "run-1" });
  assert.equal(noUpdate.runId, "run-1");
  assert.match(outcomeCauseExplanation(noUpdate), /run ended, but it did not report whether this assignment was completed/i);

  const notInjected = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", promptSubmissionState: "not_injected" });
  const injecting = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", promptSubmissionState: "injecting" });
  const injected = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", promptSubmissionState: "injected" });
  assert.match(outcomeCauseExplanation(notInjected), /did not confirm sending/i);
  assert.match(outcomeCauseExplanation(injecting), /was sending this assignment/i);
  assert.match(outcomeCauseExplanation(injected), /submitted this assignment, but did not record how much work completed/i);
  assert.notEqual(outcomeCauseExplanation(notInjected), outcomeCauseExplanation(injected));
  const auth = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", providerFailureCategory: "authentication" });
  assert.match(outcomeCauseExplanation(auth), /rejected its sign-in/i);
  const rateLimit = outcomeCauseFromPayload({ reason: "provider_outcome_unknown", providerFailureCategory: "rate_limit" });
  assert.match(outcomeCauseExplanation(rateLimit), /usage limit/i);
  assert.match(outcomeCauseExplanation(outcomeCauseFromPayload({ reason: "scheduler_outcome_unknown" })), /interrupted before Ponderosa recorded/i);
  assert.match(outcomeCauseExplanation(outcomeCauseFromPayload({ reason: "run_cancelled_by_operator" })), /An operator stopped/i);
  for (const explanation of [noUpdate, notInjected, injecting, injected, auth, rateLimit].map(outcomeCauseExplanation)) {
    assert.match(explanation, /before retrying; a retry could repeat work/i);
    assert.doesNotMatch(explanation, /outcome_unknown|prompt_injection_state|provider_failure_category/iu);
  }
});

test("unknown historical reasons never become public failure prose", () => {
  const cause = outcomeCauseFromPayload({ reason: "private stack trace", runId: "../../unsafe" });
  assert.deepEqual(cause, { code: "cause_unavailable" });
  assert.doesNotMatch(outcomeCauseExplanation(cause), /private stack trace/);
});
