import type { EngineDto } from "@ponderosa/core";

/**
 * Resolve a Project chat's engine only after the live engine roster arrives.
 * Marking initialization complete against an empty query result strands the
 * chat on an empty engine even though the app header later becomes ready.
 */
export function resolveConversationEngine(
  defaultEngine: string | undefined,
  engines: EngineDto[],
): string | undefined {
  if (engines.length === 0) return undefined;
  if (defaultEngine && engines.some((engine) => engine.id === defaultEngine)) return defaultEngine;
  return engines.find((engine) => engine.authenticated)?.id ?? engines[0]?.id;
}
