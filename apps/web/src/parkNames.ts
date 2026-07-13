import configuredAgentNames from "./agent-names.json";

// Edit agent-names.json to replace or extend the names offered by Ponderosa.
// Blank entries and case-insensitive duplicates are ignored so local
// customization cannot make name selection unreliable.
export const AGENT_NAMES: readonly string[] = Array.from(
  new Map(
    configuredAgentNames
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => [name.toLowerCase(), name]),
  ).values(),
);

/**
 * Pick a configured name not already used by an existing agent. Comparison is
 * case-insensitive. Falls back to a numbered suffix once the pool is exhausted.
 */
export function pickAgentName(existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const available = AGENT_NAMES.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)]!;
  }

  // An intentionally empty custom configuration still produces a useful name.
  if (AGENT_NAMES.length === 0) return "Agent";

  const base = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)]!;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
