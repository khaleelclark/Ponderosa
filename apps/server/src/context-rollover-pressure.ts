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
  input: { resumeSessionId?: string; replacementLowWaterMark?: number; handoff?: boolean } = {},
) {
  const exact = Boolean(input.resumeSessionId && usage?.providerSessionGeneration === input.resumeSessionId);
  const windowTokens = input.resumeSessionId && usage?.providerSessionGeneration &&
      usage.providerSessionGeneration !== input.resumeSessionId ? undefined : usage?.windowTokens;
  const pressure = evaluateContextRolloverPressure({ usedTokens: 0, ...(windowTokens ? { windowTokens } : {}) }, preferences);
  const knownInputCeiling = windowTokens === undefined ? undefined : Math.min(pressure.threshold, Math.floor(windowTokens * preferences.contextRolloverWindowFraction));
  let responseHeadroomTokens = windowTokens === undefined
    ? pressure.threshold - pressure.lowWaterMark
    : Math.max(0, windowTokens - knownInputCeiling!);
  let inputCeilingTokens = windowTokens === undefined ? pressure.threshold - responseHeadroomTokens : knownInputCeiling!;
  if (input.handoff && windowTokens !== undefined) { inputCeilingTokens = windowTokens; responseHeadroomTokens = 0; }
  if (input.replacementLowWaterMark !== undefined) inputCeilingTokens = Math.min(inputCeilingTokens, input.replacementLowWaterMark - 1);
  return {
    estimator: "conservative_utf8_bytes" as const,
    basis: windowTokens === undefined ? "context_policy" as const : "provider_window" as const,
    inputCeilingTokens: Math.max(0, Math.floor(inputCeilingTokens)),
    responseHeadroomTokens,
    responseHeadroomBasis: windowTokens === undefined ? "policy_low_water_margin" as const : "provider_window_margin" as const,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    occupancyBasis: exact ? "exact_session" as const : input.resumeSessionId ? "unavailable" as const : "fresh_session" as const,
    occupancyTokens: exact ? usage!.usedTokens : 0,
    ...(exact ? { providerSessionGeneration: input.resumeSessionId } : {}),
  };
}

export function estimateProviderInput(
  budget: ReturnType<typeof providerInputBudget>, systemPrompt: string,
  tools: readonly unknown[], prompt: string,
) {
  // JSON escaping and field wrappers are counted too. Retained instructions and
  // tools are already in exact-session occupancy; do not charge them twice.
  const retained = budget.occupancyBasis === "exact_session";
  const outgoing = retained ? { input: prompt } : { systemPrompt, tools, input: prompt };
  const submittedUtf8Bytes = Buffer.byteLength(JSON.stringify(outgoing), "utf8");
  return {
    ...budget,
    submittedUtf8Bytes,
    systemPromptUtf8Bytes: Buffer.byteLength(systemPrompt, "utf8"),
    toolDefinitionsUtf8Bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
    estimatedInputTokens: budget.occupancyTokens + submittedUtf8Bytes,
  };
}
