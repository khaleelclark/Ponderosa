import type {
  EffortOption,
  EngineDto,
  ProjectDto,
  ProjectEngineModelCatalogDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";

export function engineIsAvailable(engine: { authenticated: boolean; available: boolean; enabled?: boolean } | undefined): boolean {
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
export function selectedRunConfig(
  model: string,
  effort: string,
  speed?: string,
): { model?: string; effort?: string; speed?: string } {
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(speed ? { speed } : {}),
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

export function speedOptionsForModel(
  engine: EngineDto | undefined,
  model: string,
): RuntimeOption[] {
  const serviceTiers = engine?.models.find(option => option.id === model)
    ?.serviceTiers;
  if (!serviceTiers?.length) return [];
  return [
    { id: "standard", label: "Standard", detail: "Default speed" },
    ...serviceTiers.map(tier => ({
      id: tier.id,
      label: tier.label,
      ...(tier.description ? { detail: tier.description } : {}),
    })),
  ];
}

export function speedSelectionIsCompatible(
  engine: EngineDto | undefined,
  model: string,
  speed: string,
): boolean {
  if (!speed) return true;
  return speedOptionsForModel(engine, model).some(option => option.id === speed);
}

export interface RuntimeSelection {
  model: string;
  effort: string;
  speed?: string;
}

interface RuntimeOption {
  id: string;
  label: string;
  disabled?: boolean;
  detail?: string;
  group?: "Latest" | "Pinned";
}

export interface RuntimeControlState extends RuntimeSelection {
  speed: string;
  models: RuntimeOption[];
  efforts: RuntimeOption[];
  speeds: RuntimeOption[];
  ready: boolean;
}

export function enginesWithModelCatalog(
  engines: EngineDto[],
  catalog: ProjectEngineModelCatalogDto | undefined,
): EngineDto[] {
  if (!catalog) return engines;
  return engines.map((engine) => engine.id !== catalog.engineId
    ? engine
    : {
        ...engine,
        models: catalog.models.map((model) => ({
          ...model,
          ...(model.supportedEffortLevels
            ? { efforts: model.supportedEffortLevels.map((effort) => ({ id: effort, label: effort })) }
            : {}),
        })),
        modelCatalogKnown: true,
      });
}

function runtimeModelOption(
  engine: EngineDto,
  option: EngineDto["models"][number],
): RuntimeOption {
  const resolvedLabel = option.resolvedModel
    ? engine.models.find((candidate) => candidate.id === option.resolvedModel)?.label ?? option.resolvedModel
    : undefined;
  const pinned = option.kind === "exact";
  const unavailable = option.availability === "unavailable";
  const semantics = pinned
    ? `Pinned · stores ${option.id}`
    : option.kind === "alias"
      ? `Latest${resolvedLabel ? ` · currently resolves to ${resolvedLabel}` : ""} · stores ${option.id}`
      : undefined;
  return {
    id: option.id,
    label: option.label,
    ...(option.kind ? { group: pinned ? "Pinned" as const : "Latest" as const } : {}),
    ...(unavailable ? { disabled: true } : {}),
    ...((unavailable ? option.unavailableReason : semantics ?? option.description)
      ? { detail: unavailable ? `Unavailable · ${option.unavailableReason ?? "provider rejected this model"}` : semantics ?? option.description }
      : {}),
  };
}

/**
 * One canonical presentation state for creation dialogs, settings, presets, and
 * chat composers. Saved selections remain visible only when a provider has an
 * intentionally open catalog; closed catalogs fail back to advertised values.
 */
export function runtimeControlState(
  engine: EngineDto | undefined,
  selection: RuntimeSelection,
): RuntimeControlState {
  if (!engine) {
    return {
      ...selection,
      speed: selection.speed ?? "",
      models: [],
      efforts: [],
      speeds: [],
      ready: false,
    };
  }
  const advertisedModels = engine.models.filter((option) => option.id);
  const models = engine.modelCatalogKnown === false
    && selection.model
    && !advertisedModels.some((option) => option.id === selection.model)
    ? [...advertisedModels, { id: selection.model, label: `${selection.model} (saved selection)` }]
    : advertisedModels;
  const advertisedEfforts = effortOptionsForModel(engine, selection.model);
  const efforts = selection.effort
    && effortSelectionIsCompatible(engine, selection.model, selection.effort)
    && !advertisedEfforts.some((option) => option.id === selection.effort)
    ? [...advertisedEfforts, { id: selection.effort, label: `${selection.effort} (saved selection)` }]
    : advertisedEfforts;
  const speeds = speedOptionsForModel(engine, selection.model);
  const speed = selection.speed &&
    speedSelectionIsCompatible(engine, selection.model, selection.speed)
      ? selection.speed
      : speeds.find(option =>
          option.id === engine.models.find(model => model.id === selection.model)
            ?.defaultServiceTier
        )?.id ?? speeds[0]?.id ?? "";
  return {
    ...selection,
    speed,
    models: models.map((option) => runtimeModelOption(engine, option)),
    efforts,
    speeds,
    ready: engineIsAvailable(engine),
  };
}

export function runtimeSelectionAfterChange(
  engine: EngineDto | undefined,
  preferences: Pick<WorkspacePreferencesDto, "engineDefaults"> | undefined,
  project: Pick<ProjectDto, "defaultEngine" | "defaultModel" | "defaultEffort"> | undefined,
  current: RuntimeSelection,
  change: { model: string } | { effort: string } | { speed: string },
): RuntimeSelection {
  if ("model" in change) {
    const resolved = resolveRuntimeSelection(engine, preferences, project, {
      model: change.model,
      speed: current.speed,
    });
    return {
      model: change.model,
      effort: resolved.effort,
      speed: resolved.speed,
    };
  }
  if ("speed" in change) {
    return {
      ...current,
      speed: speedSelectionIsCompatible(
        engine,
        current.model,
        change.speed,
      )
        ? change.speed
        : "",
    };
  }
  return {
    model: current.model,
    effort: effortSelectionIsCompatible(engine, current.model, change.effort) ? change.effort : "",
    speed: current.speed,
  };
}

/** Resolve inherited settings to concrete provider options before rendering or dispatch. */
export function resolveRuntimeSelection(
  engine: EngineDto | undefined,
  preferences: Pick<WorkspacePreferencesDto, "engineDefaults"> | undefined,
  project?: Pick<ProjectDto, "defaultEngine" | "defaultModel" | "defaultEffort">,
  explicit?: { model?: string; effort?: string; speed?: string },
): RuntimeSelection {
  if (!engine) return { model: "", effort: "", speed: "" };
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
  const speeds = speedOptionsForModel(engine, model);
  const defaultSpeed = engine.models.find(option => option.id === model)
    ?.defaultServiceTier;
  const speed = [
    explicit?.speed,
    defaultSpeed,
    speeds[0]?.id,
  ].find(candidate =>
    Boolean(candidate) &&
    speedSelectionIsCompatible(engine, model, candidate!)
  ) ?? "";
  return { model, effort, speed };
}
