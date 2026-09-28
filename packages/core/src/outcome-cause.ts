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
  switch (cause.code) {
    case "run_completed_without_request_update":
      return "The Agent's attempt finished, but it did not report this assignment's result. Review its work before retrying.";
    case "provider_outcome_unknown":
      if (cause.providerFailureCategory === "authentication") {
        return "The provider rejected its sign-in while handling this assignment. Earlier work may exist; check provider access and review the Agent's activity before retrying.";
      }
      if (cause.providerFailureCategory === "rate_limit") {
        return "The provider reached a usage limit while handling this assignment. Earlier work may exist; review the Agent's activity before retrying.";
      }
      return cause.promptSubmissionState === "not_injected"
        ? "The provider stopped before Ponderosa confirmed task delivery. Review the Agent's activity before retrying."
        : "The provider stopped without a confirmed result. Earlier changes may exist; review the Agent's activity before retrying.";
    case "scheduler_outcome_unknown":
      return "The Agent's attempt was interrupted before Ponderosa recorded a result. Review its activity before retrying.";
    case "run_cancelled_by_operator":
      return "You stopped this Agent attempt after it began. Earlier changes may exist; review them before retrying.";
    default:
      return "Ponderosa cannot confirm this assignment's result. Review the Agent's activity before retrying.";
  }
}
