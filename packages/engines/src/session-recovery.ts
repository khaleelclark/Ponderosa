/**
 * Return true only for engine failures that mean the persisted runtime session
 * can no longer be continued. Callers may safely retry these failures by
 * starting a fresh session from Ponderosa's canonical thread history.
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
