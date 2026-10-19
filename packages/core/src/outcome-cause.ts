/** Canonical supervisor reasons are finite; never turn arbitrary failure prose into a user-facing cause. */
import { normalizeProviderFailureCategory, type ProviderFailureCategory } from "./provider-failure-summary.js";

export type OutcomeCauseCode =
  | "run_completed_without_request_update"
  | "provider_outcome_unknown"
  | "scheduler_outcome_unknown"
  | "run_cancelled_by_operator"
  | "server_restart_after_prompt_submission"
  | "lease_expired_after_prompt_injection"
  | "cause_unavailable";

export type OutcomeProcessingPhase =
  | "prompt_submission" | "provider_execution"
  | "turn_submission_rejection_before_acceptance" | "turn_submission_rejection_after_acceptance"
  | "iterator_rejection_before_acceptance" | "iterator_rejection_after_acceptance"
  | "event_projection_before_acceptance" | "event_projection_after_acceptance";

export type OutcomeInternalFailureCode =
  | "run_orchestration" | "context_rollover_conflict"
  | "context_rollover_boundary" | "internal_runtime_error";

const INTERNAL_FAILURE_CODES = new Set<OutcomeInternalFailureCode>([
  "run_orchestration", "context_rollover_conflict",
  "context_rollover_boundary", "internal_runtime_error",
]);

const PROCESSING_PHASES = new Set<OutcomeProcessingPhase>([
  "prompt_submission", "provider_execution",
  "turn_submission_rejection_before_acceptance", "turn_submission_rejection_after_acceptance",
  "iterator_rejection_before_acceptance", "iterator_rejection_after_acceptance",
  "event_projection_before_acceptance", "event_projection_after_acceptance",
]);

export interface OutcomeCause {
  code: OutcomeCauseCode;
  runId?: string;
  promptSubmissionState?: "not_injected" | "injecting" | "injected";
  providerFailureCategory?: ProviderFailureCategory;
  processingPhase?: OutcomeProcessingPhase;
  /** Correlates requests affected by one observed server-start recovery. */
  incidentId?: string;
  internalFailureCode?: OutcomeInternalFailureCode;
}

export function outcomeCauseFromPayload(payload: unknown): OutcomeCause {
  const value = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  const code: OutcomeCauseCode = value.reason === "run_completed_without_request_update"
    || value.reason === "provider_outcome_unknown"
    || value.reason === "scheduler_outcome_unknown"
    || value.reason === "run_cancelled_by_operator"
    || value.reason === "server_restart_after_prompt_submission"
    || value.reason === "lease_expired_after_prompt_injection"
      ? value.reason : "cause_unavailable";
  const runId = typeof value.runId === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value.runId)
    ? value.runId : undefined;
  const promptSubmissionState = value.promptSubmissionState === "not_injected"
    || value.promptSubmissionState === "injecting"
    || value.promptSubmissionState === "injected"
      ? value.promptSubmissionState : undefined;
  const providerFailureCategory = normalizeProviderFailureCategory(value.providerFailureCategory);
  const processingPhase = typeof value.processingPhase === "string"
    && PROCESSING_PHASES.has(value.processingPhase as OutcomeProcessingPhase)
      ? value.processingPhase as OutcomeProcessingPhase : undefined;
  const incidentId = typeof value.incidentId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.incidentId)
      ? value.incidentId : undefined;
  const internalFailureCode = typeof value.internalFailureCode === "string"
    && INTERNAL_FAILURE_CODES.has(value.internalFailureCode as OutcomeInternalFailureCode)
      ? value.internalFailureCode as OutcomeInternalFailureCode : undefined;
  return {
    code,
    ...(runId ? { runId } : {}),
    ...(promptSubmissionState ? { promptSubmissionState } : {}),
    ...(providerFailureCategory !== "unknown" ? { providerFailureCategory } : {}),
    ...(processingPhase ? { processingPhase } : {}),
    ...(incidentId ? { incidentId } : {}),
    ...(internalFailureCode ? { internalFailureCode } : {}),
  };
}

export function outcomeCauseExplanation(cause: OutcomeCause): string {
  const review = "Check the Agent's activity and any changed files before retrying; a retry could repeat work.";
  const processing = cause.processingPhase === "prompt_submission"
    ? "The interruption happened while submitting the assignment."
    : cause.processingPhase === "provider_execution"
      ? "The interruption happened during provider execution."
      : cause.processingPhase?.startsWith("turn_submission_rejection_")
        ? "The provider rejected the turn submission."
        : cause.processingPhase?.startsWith("iterator_rejection_")
          ? "Ponderosa lost the provider's response stream."
          : cause.processingPhase?.startsWith("event_projection_")
            ? "Ponderosa could not record a provider event."
            : undefined;
  switch (cause.code) {
    case "run_completed_without_request_update":
      return `The Agent's run ended, but it did not report whether this assignment was completed. Ponderosa cannot confirm the result. ${review}`;
    case "provider_outcome_unknown": {
      const issue = {
        authentication: "The provider rejected its sign-in.",
        rate_limit: "The provider limited the request.",
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
      return `${issue} ${delivery} ${processing ? `${processing} ` : ""}${review}`;
    }
    case "scheduler_outcome_unknown":
      if (!cause.internalFailureCode) {
        return `The Agent's run was interrupted before Ponderosa recorded a final result. It cannot confirm whether the assignment was completed. ${review}`;
      }
      return `${{
        context_rollover_conflict: "Ponderosa found conflicting saved context while continuing the Agent's run.",
        context_rollover_boundary: "Ponderosa could not verify the saved context needed to continue the Agent's run.",
        run_orchestration: "Ponderosa encountered an internal error while running the Agent.",
        internal_runtime_error: "Ponderosa encountered an internal error while running the Agent.",
      }[cause.internalFailureCode]} It cannot confirm whether the assignment was completed. ${review}`;
    case "run_cancelled_by_operator":
      return `An operator stopped the Agent's run after it began. Work or file changes made before cancellation may still exist. ${review}`;
    case "server_restart_after_prompt_submission":
      return `Ponderosa found this Agent run unfinished when its server started. The assignment may already have reached the provider, but Ponderosa cannot confirm how much work completed. ${review}`;
    case "lease_expired_after_prompt_injection":
      return `Ponderosa lost authority over this Agent run after the assignment may have reached the provider. It cannot confirm how much work completed. ${review}`;
    default:
      return `Ponderosa did not record why this result is unconfirmed. It cannot tell whether the Agent completed the assignment. ${review}`;
  }
}
