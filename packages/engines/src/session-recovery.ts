/**
 * Return true only for engine failures that mean the persisted runtime session
 * can no longer be continued. Callers may safely retry these failures by
 * starting a fresh session from Ponderosa's canonical agent history.
 *
 * Keep this deliberately narrow: authentication, quota, network, model, and
 * general command failures must remain visible and must not trigger a retry.
 */
export function shouldRolloverEngineSession(
  engineId: string,
  error: string | Extract<AgentEvent, { type: "error" }>,
): boolean {
  if (engineId !== "codex") return false;

  return typeof error === "string"
    ? /failed to run pre-sampling compact/i.test(error)
    : preSamplingCompactFailures.has(error);
}

// Recovery provenance stays attached to the projected event by identity. It is
// neither provider-controlled metadata nor a field in public/persisted errors.
const preSamplingCompactFailures = new WeakSet<Extract<AgentEvent, { type: "error" }>>();

export function preserveEngineSessionRecoverySignal(
  source: Extract<AgentEvent, { type: "error" }>,
  projected: Extract<AgentEvent, { type: "error" }>,
): Extract<AgentEvent, { type: "error" }> {
  const codeCategory = classifyProviderFailure("", source.code);
  if (projected.category === "context_length" &&
      (codeCategory === "context_length" || codeCategory === "unknown") &&
      source.terminalStatus !== "interrupted" &&
      source.message.length <= MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS &&
      /failed to run pre-sampling compact/i.test(source.message)) {
    preSamplingCompactFailures.add(projected);
  }
  return projected;
}

export { classifyProviderFailure };
export type { ProviderFailureKind };
import {
  classifyProviderFailure,
  MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS,
  type AgentEvent,
  type ProviderFailureKind,
} from "@ponderosa/core";
