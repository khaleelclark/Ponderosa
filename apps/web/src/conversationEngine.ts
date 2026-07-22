import type { EffortOption, EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";

export function engineIsAvailable(engine: Pick<EngineDto, "authenticated" | "available" | "enabled"> | undefined): boolean {
  return Boolean(engine?.enabled !== false && engine?.authenticated && engine.available);
}

/** An operator-disabled provider is intentionally inactive, not unhealthy. */
export function engineCanTestAccess(engine: Pick<EngineDto, "authenticated" | "available" | "enabled">): boolean {
  return engine.enabled !== false && engine.authenticated && !engine.available;
}

export function engineStatusPresentation(engine: Pick<EngineDto, "available" | "enabled">): {
  label: "Ready" | "Needs attention" | "Inactive";
  color: "success" | "warning" | "default";
} {
  if (engine.enabled === false) return { label: "Inactive", color: "default" };
  return engine.available
    ? { label: "Ready", color: "success" }
    : { label: "Needs attention", color: "warning" };
}

function conciseAvailabilityDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const firstLine = detail.split("\n")[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
}

export function engineAvailabilityPresentation(engines: EngineDto[]): {
  label: "Engine ready" | "Needs attention" | "Inactive" | "Checking engines";
  severity: "success" | "warning" | "default";
  detail: string;
} {
  if (engines.length === 0) {
    return { label: "Checking engines", severity: "warning", detail: "Ponderosa is still checking its AI providers." };
  }

  const enabled = engines.filter((engine) => engine.enabled !== false);
  const available = enabled.filter(engineIsAvailable);
  const unavailable = enabled.filter((engine) => !engineIsAvailable(engine));
  const disabled = engines.filter((engine) => engine.enabled === false);
  const availableSummary = available.length
    ? `${available.map((engine) => engine.displayName).join(", ")} ${available.length === 1 ? "is" : "are"} ready.`
    : "No enabled engine can currently run work.";
  const unavailableSummary = unavailable.map((engine) => {
    const state = engine.authenticated ? "unavailable" : "not signed in";
    const detail = conciseAvailabilityDetail(engine.availabilityDetail ?? engine.authDetail);
    return `${engine.displayName} is ${state}${detail ? `: ${detail}` : ""}.`;
  }).join(" ");
  const disabledSummary = disabled.length
    ? `${disabled.map((engine) => engine.displayName).join(", ")} ${disabled.length === 1 ? "is" : "are"} disabled.`
    : "";
  if (enabled.length === 0) {
    return {
      label: "Inactive",
      severity: "default",
      detail: `${disabledSummary || "All configured providers are disabled by the operator."} Enable a provider to run work.`,
    };
  }
  const detail = [
    `${available.length} of ${enabled.length} enabled ${enabled.length === 1 ? "engine" : "engines"} ready.`,
    availableSummary,
    unavailableSummary,
    disabledSummary,
  ].filter(Boolean).join(" ");

  if (unavailable.length > 0) return { label: "Needs attention", severity: "warning", detail };
  return { label: "Engine ready", severity: "success", detail };
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

export interface RuntimeSelection {
  model: string;
  effort: string;
}

/** Resolve inherited settings to concrete provider options before rendering or dispatch. */
export function resolveRuntimeSelection(
  engine: EngineDto | undefined,
  preferences: Pick<WorkspacePreferencesDto, "engineDefaults"> | undefined,
  project?: Pick<ProjectDto, "defaultEngine" | "defaultModel" | "defaultEffort">,
  explicit?: { model?: string; effort?: string },
): RuntimeSelection {
  if (!engine) return { model: "", effort: "" };
  const global = preferences?.engineDefaults?.[engine.id];
  const projectApplies = project?.defaultEngine === engine.id;
  const modelCandidates = [
    explicit?.model,
    projectApplies ? project?.defaultModel : undefined,
    global?.model,
    engine.defaultModel,
    engine.models.find((option) => option.id)?.id,
  ];
  const model = modelCandidates.find((candidate) => Boolean(candidate) && modelSelectionIsCompatible(engine, candidate!)) ?? "";
  const modelDefaultEffort = engine.models.find((option) => option.id === model)?.defaultEffort;
  const effortCandidates = [
    explicit?.effort,
    projectApplies ? project?.defaultEffort : undefined,
    global?.effort,
    modelDefaultEffort,
    engine.defaultEffort,
    effortOptionsForModel(engine, model)[0]?.id,
  ];
  const effort = effortCandidates.find((candidate) => Boolean(candidate) && effortSelectionIsCompatible(engine, model, candidate!)) ?? "";
  return { model, effort };
}
