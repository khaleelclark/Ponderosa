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

/** Conservative pre-submit accounting, not a provider tokenizer. The existing
 * rollover policy is the fallback input ceiling, never a claimed model window.
 * A reported window reserves its remaining space for replies/host overhead. */
export function providerInputBudget(
  preferences: ContextRolloverPressurePreferences,
  usage: { usedTokens: number; windowTokens?: number; providerSessionGeneration?: string } | undefined = undefined,
  input: { resumeSessionId?: string; replacementLowWaterMark?: number; handoff?: boolean;
    postObservationUtf8Bytes?: number; estimatedSessionUtf8Bytes?: number;
    occupancyObservation?: { source: "live_session" | "accepted_run" | "accepted_input_estimate"; providerSessionId: string;
      observedAt?: string; sampledAt?: string; executionId?: string;
      requestOutputIncluded?: boolean; acceptedInputUtf8Bytes?: number; outputUtf8Bytes?: number; retainedStaticUtf8Bytes?: number; liveLowerBoundTokens?: number } } = {},
) {
  const exact = Boolean(input.resumeSessionId && usage?.providerSessionGeneration === input.resumeSessionId);
  if (input.resumeSessionId && !exact && input.estimatedSessionUtf8Bytes === undefined) {
    throw Object.assign(new Error("Retained provider context is unavailable under the context policy; explicit context recovery is required before dispatch."), { statusCode: 413 });
  }
  const reportedWindow = input.resumeSessionId && usage?.providerSessionGeneration &&
      usage.providerSessionGeneration !== input.resumeSessionId ? undefined : usage?.windowTokens;
  const windowTokens = reportedWindow && reportedWindow > 0 ? reportedWindow : undefined;
  const pressure = evaluateContextRolloverPressure({ usedTokens: 0, ...(windowTokens ? { windowTokens } : {}) }, preferences);
  const knownInputCeiling = windowTokens === undefined ? undefined : Math.min(pressure.threshold, Math.floor(windowTokens * preferences.contextRolloverWindowFraction));
  let responseHeadroomTokens = windowTokens === undefined
    ? pressure.threshold - pressure.lowWaterMark
    : Math.max(0, windowTokens - knownInputCeiling!);
  let inputCeilingTokens = windowTokens === undefined ? pressure.threshold - responseHeadroomTokens : knownInputCeiling!;
  if (input.handoff && windowTokens !== undefined) {
    // The original generation must still be able to write its bounded handoff
    // after crossing the ordinary pressure threshold. Record only the actual
    // remaining verified window; the final packet subtracts its required bytes.
    inputCeilingTokens = windowTokens - 1;
    responseHeadroomTokens = Math.max(0, windowTokens - (exact ? usage!.usedTokens : 0));
  }
  if (input.replacementLowWaterMark !== undefined) inputCeilingTokens = Math.min(inputCeilingTokens, input.replacementLowWaterMark - 1);
  return {
    estimator: "conservative_utf8_bytes" as const,
    basis: windowTokens === undefined ? "context_policy" as const : "provider_window" as const,
    inputCeilingTokens: Math.max(0, Math.floor(inputCeilingTokens)),
    responseHeadroomTokens,
    responseHeadroomBasis: windowTokens === undefined ? "policy_low_water_margin" as const
      : input.handoff ? "handoff_remaining_window" as const : "provider_window_margin" as const,
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
    ...(budget.responseHeadroomBasis === "handoff_remaining_window" ? {
      responseHeadroomTokens: Math.max(0, budget.windowTokens! - budget.occupancyTokens - budget.postObservationUtf8Bytes - submittedUtf8Bytes),
    } : {}),
  };
}
