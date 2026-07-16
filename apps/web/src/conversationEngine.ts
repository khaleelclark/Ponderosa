import type { EffortOption, EngineDto } from "@ponderosa/core";

export function engineIsAvailable(engine: Pick<EngineDto, "authenticated" | "available"> | undefined): boolean {
  return Boolean(engine?.authenticated && engine.available);
}

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
  return engines.find(engineIsAvailable)?.id ?? engines[0]?.id;
}

/** Keep Project-chat runtime controls attached to both creation and first dispatch. */
export function selectedRunConfig(model: string, effort: string): { model?: string; effort?: string } {
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** Prefer the provider's exact effort roster for a selected model. */
export function effortOptionsForModel(engine: EngineDto | undefined, model: string): EffortOption[] {
  if (!engine) return [];
  return engine.models.find((option) => option.id === model)?.efforts ?? engine.efforts;
}

export function modelSelectionIsCompatible(engine: EngineDto | undefined, model: string): boolean {
  return !model || engine?.modelCatalogKnown === false || Boolean(engine?.models.some((option) => option.id === model));
}

export function effortSelectionIsCompatible(engine: EngineDto | undefined, model: string, effort: string): boolean {
  if (!effort) return true;
  if (model && engine?.modelCatalogKnown === false && !engine.models.some((option) => option.id === model)) return true;
  const selectedModel = model ? engine?.models.find((option) => option.id === model) : undefined;
  if (selectedModel && selectedModel.efforts === undefined) return true;
  return effortOptionsForModel(engine, model).some((option) => option.id === effort);
}
