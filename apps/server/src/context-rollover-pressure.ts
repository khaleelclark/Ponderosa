export interface ContextRolloverPressureInput {
  usedTokens: number;
  aggregateTokens?: number;
  windowTokens?: number;
}

export interface ContextRolloverPressurePreferences {
  contextRolloverTokens: number;
  contextRolloverWindowFraction: number;
}

export function evaluateContextRolloverPressure(
  usage: ContextRolloverPressureInput,
  preferences: ContextRolloverPressurePreferences,
): { shouldRequest: boolean; threshold: number; lowWaterMark: number } {
  const windowThreshold = usage.windowTokens === undefined
    ? undefined
    : Math.max(75_000, usage.windowTokens * preferences.contextRolloverWindowFraction);
  const threshold = Math.max(1, Math.floor(windowThreshold === undefined
    ? preferences.contextRolloverTokens
    : Math.min(preferences.contextRolloverTokens, windowThreshold)));
  return {
    // aggregateTokens is intentionally excluded. It is cumulative provider
    // traffic for usage/cost telemetry, not current context occupancy.
    shouldRequest: usage.usedTokens >= threshold,
    threshold,
    lowWaterMark: Math.max(1, Math.floor(threshold * 0.6)),
  };
}

/** A pending handoff already owns this pressure cycle. Its next Run can report
 * higher usage without freezing a second, conflicting canonical boundary. */
export function shouldRequestAutomaticContextRollover(
  pressure: { shouldRequest: boolean },
  activeRollover: object | undefined,
): boolean {
  return pressure.shouldRequest && activeRollover === undefined;
}

export function contextRecoveryRequired(message: string) {
  return Object.assign(new Error(message), { statusCode: 422, code: "context_recovery_required" });
}

/** Conservative pre-submit accounting, not a provider tokenizer. Reconstruction
 * uses the existing context policy. Compatible continuations spend their actual
 * remaining provider window; an unreported window stays unknown. */
export function providerInputBudget(
  preferences: ContextRolloverPressurePreferences,
  usage: { usedTokens: number; windowTokens?: number; providerSessionGeneration?: string } | undefined = undefined,
  input: { resumeSessionId?: string; replacementLowWaterMark?: number;
    postObservationUtf8Bytes?: number; estimatedSessionUtf8Bytes?: number;
    occupancyObservation?: { source: "live_session" | "accepted_run" | "provider_command" | "accepted_input_estimate"; providerSessionId: string;
      observedAt?: string; sampledAt?: string; executionId?: string; commandInvocationId?: string; fencingToken?: number;
      requestOutputIncluded?: boolean; acceptedInputUtf8Bytes?: number; outputUtf8Bytes?: number; retainedStaticUtf8Bytes?: number; liveLowerBoundTokens?: number } } = {},
) {
  const exact = Boolean(input.resumeSessionId && usage?.providerSessionGeneration === input.resumeSessionId);
  if (input.resumeSessionId && !exact && input.estimatedSessionUtf8Bytes === undefined) {
    throw contextRecoveryRequired("Retained provider context is unavailable; explicit context recovery is required before dispatch.");
  }
  const reportedWindow = input.resumeSessionId && usage?.providerSessionGeneration &&
      usage.providerSessionGeneration !== input.resumeSessionId ? undefined : usage?.windowTokens;
  const windowTokens = reportedWindow && reportedWindow > 0 ? reportedWindow : undefined;
  const pressure = evaluateContextRolloverPressure({ usedTokens: 0, ...(windowTokens ? { windowTokens } : {}) }, preferences);
  const knownInputCeiling = windowTokens === undefined ? undefined : Math.min(pressure.threshold, Math.floor(windowTokens * preferences.contextRolloverWindowFraction));
  const responseHeadroomTokens = windowTokens === undefined
    ? pressure.threshold - pressure.lowWaterMark
    : Math.max(0, windowTokens - knownInputCeiling!);
  let inputCeilingTokens = windowTokens === undefined ? pressure.threshold - responseHeadroomTokens : knownInputCeiling!;
  // Neither a proactive rollover threshold nor its reconstruction target is
  // provider capacity. This applies to the original generation's handoff too.
  const retained = Boolean(input.resumeSessionId);
  if (!retained && input.replacementLowWaterMark !== undefined) inputCeilingTokens = Math.min(inputCeilingTokens, input.replacementLowWaterMark - 1);
  return {
    estimator: "conservative_utf8_bytes" as const,
    basis: retained && windowTokens === undefined ? "unknown_provider_window" as const
      : windowTokens === undefined ? "context_policy" as const : "provider_window" as const,
    // A verified window must leave at least one token for a response. There is
    // no separately configured response limit; report the actual remainder.
    inputCeilingTokens: retained ? windowTokens === undefined ? undefined : Math.max(0, windowTokens - 1)
      : Math.max(0, Math.floor(inputCeilingTokens)),
    responseHeadroomTokens: retained ? windowTokens === undefined ? undefined : Math.max(0, windowTokens - (exact ? usage!.usedTokens : 0))
      : responseHeadroomTokens,
    responseHeadroomBasis: retained ? windowTokens === undefined ? "unknown_provider_window" as const
      : "provider_window_remaining" as const
      : windowTokens === undefined ? "policy_low_water_margin" as const : "provider_window_margin" as const,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    occupancyBasis: input.estimatedSessionUtf8Bytes !== undefined ? "estimated_session" as const
      : exact ? "exact_session" as const : "fresh_session" as const,
    occupancyTokens: input.estimatedSessionUtf8Bytes !== undefined
      ? Math.max(input.estimatedSessionUtf8Bytes, exact ? usage!.usedTokens : 0) : exact ? usage!.usedTokens : 0,
    postObservationUtf8Bytes: exact ? input.postObservationUtf8Bytes ?? 0 : 0,
    ...(input.resumeSessionId && (exact || input.estimatedSessionUtf8Bytes !== undefined) ? { providerSessionGeneration: input.resumeSessionId,
      ...(input.occupancyObservation ? { occupancyObservation: input.occupancyObservation } : {}) } : {}),
  };
}

export function estimateProviderInput(
  budget: ReturnType<typeof providerInputBudget>, systemPrompt: string,
  tools: readonly unknown[], prompt: string,
) {
  // JSON escaping and field wrappers are counted too. Retained instructions and
  // tools are already in exact-session occupancy; do not charge them twice.
  const retained = budget.occupancyBasis === "exact_session" || budget.occupancyBasis === "estimated_session";
  const outgoing = retained ? { input: prompt } : { systemPrompt, tools, input: prompt };
  const submittedUtf8Bytes = Buffer.byteLength(JSON.stringify(outgoing), "utf8");
  return {
    ...budget,
    submittedUtf8Bytes,
    systemPromptUtf8Bytes: Buffer.byteLength(systemPrompt, "utf8"),
    toolDefinitionsUtf8Bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
    estimatedInputTokens: budget.occupancyTokens + budget.postObservationUtf8Bytes + submittedUtf8Bytes,
    ...(budget.responseHeadroomBasis === "provider_window_remaining" ? {
      responseHeadroomTokens: Math.max(0, budget.windowTokens! - budget.occupancyTokens - budget.postObservationUtf8Bytes - submittedUtf8Bytes),
    } : {}),
  };
}
