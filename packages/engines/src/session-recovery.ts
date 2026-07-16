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
  errorMessage: string,
): boolean {
  if (engineId !== "codex") return false;

  return /failed to run pre-sampling compact/i.test(errorMessage);
}

export type ProviderFailureKind = "capacity" | "rate_limit" | "authentication" | "context" | "unknown";

/** Normalize provider/CLI wording without leaking engine-specific strings into scheduling. */
export function classifyProviderFailure(errorMessage: string): ProviderFailureKind {
  if (/selected model is at capacity|model.*capacity|overloaded|no capacity|resource exhausted/i.test(errorMessage)) return "capacity";
  if (/rate.?limit|too many requests|\b429\b/i.test(errorMessage)) return "rate_limit";
  if (/unauthori[sz]ed|authentication|sign.?in|oauth|invalid.*credential/i.test(errorMessage)) return "authentication";
  if (/context window|too many tokens|maximum context|pre-sampling compact/i.test(errorMessage)) return "context";
  return "unknown";
}
