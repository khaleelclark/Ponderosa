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
