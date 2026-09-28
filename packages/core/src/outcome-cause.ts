/** Canonical supervisor reasons are finite; never turn arbitrary failure prose into a user-facing cause. */
import { normalizeProviderFailureCategory, type ProviderFailureCategory } from "./provider-failure-summary.js";

export type OutcomeCauseCode =
  | "run_completed_without_request_update"
  | "provider_outcome_unknown"
  | "scheduler_outcome_unknown"
  | "run_cancelled_by_operator"
  | "cause_unavailable";

export interface OutcomeCause {
  code: OutcomeCauseCode;
  runId?: string;
  promptSubmissionState?: "not_injected" | "injecting" | "injected";
  providerFailureCategory?: ProviderFailureCategory;
}

export function outcomeCauseFromPayload(payload: unknown): OutcomeCause {
  const value = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  const code: OutcomeCauseCode = value.reason === "run_completed_without_request_update"
    || value.reason === "provider_outcome_unknown"
    || value.reason === "scheduler_outcome_unknown"
    || value.reason === "run_cancelled_by_operator"
      ? value.reason : "cause_unavailable";
  const runId = typeof value.runId === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value.runId)
    ? value.runId : undefined;
  const promptSubmissionState = value.promptSubmissionState === "not_injected"
    || value.promptSubmissionState === "injecting"
    || value.promptSubmissionState === "injected"
      ? value.promptSubmissionState : undefined;
  const providerFailureCategory = normalizeProviderFailureCategory(value.providerFailureCategory);
  return {
    code,
    ...(runId ? { runId } : {}),
    ...(promptSubmissionState ? { promptSubmissionState } : {}),
    ...(providerFailureCategory !== "unknown" ? { providerFailureCategory } : {}),
  };
}

export function outcomeCauseExplanation(cause: OutcomeCause): string {
  const review = "Check the Agent's activity and any changed files before retrying; a retry could repeat work.";
  switch (cause.code) {
    case "run_completed_without_request_update":
      return `The Agent's run ended, but it did not report whether this assignment was completed. Ponderosa cannot confirm the result. ${review}`;
    case "provider_outcome_unknown": {
      const issue = {
        authentication: "The provider rejected its sign-in.",
        rate_limit: "The provider reached a usage limit.",
        capacity: "The provider reported that it was at capacity.",
        context_length: "The provider reported that the request exceeded its context limit.",
        invalid_request: "The provider rejected the request.",
        unavailable: "The provider was unavailable.",
        unknown: "The provider stopped before Ponderosa recorded a final result.",
      }[cause.providerFailureCategory ?? "unknown"];
      const delivery = cause.promptSubmissionState === "not_injected"
        ? "Ponderosa did not confirm sending this assignment, so it cannot say whether the provider received it."
        : cause.promptSubmissionState === "injecting"
          ? "Ponderosa was sending this assignment when the run stopped; it cannot say whether the provider received it or did any work."
          : cause.promptSubmissionState === "injected"
            ? "Ponderosa submitted this assignment, but did not record how much work completed."
            : "Ponderosa did not record enough about submission to say whether work started.";
      return `${issue} ${delivery} ${review}`;
    }
    case "scheduler_outcome_unknown":
      return `The Agent's run was interrupted before Ponderosa recorded a final result. It cannot confirm whether the assignment was completed. ${review}`;
    case "run_cancelled_by_operator":
      return `An operator stopped the Agent's run after it began. Work or file changes made before cancellation may still exist. ${review}`;
    default:
      return `Ponderosa did not record why this result is unconfirmed. It cannot tell whether the Agent completed the assignment. ${review}`;
  }
}
