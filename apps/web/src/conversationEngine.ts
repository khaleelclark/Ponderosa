import type {
  EffortOption,
  EngineDto,
  ProjectDto,
  ProjectEngineModelCatalogDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";

export function engineIsAuthenticated(engine: Pick<EngineDto, "authentication"> | undefined): boolean {
  return engine?.authentication === "authenticated";
}

export function engineIsAvailable(engine: Pick<EngineDto, "authentication" | "intakeReady" | "enabled" | "installed"> | undefined): boolean {
  return Boolean(engine && engine.enabled !== false && engine.installed !== false && engineIsAuthenticated(engine) && engine.intakeReady);
}

export function engineUnavailableReason(
  engine: Pick<EngineDto, "authentication" | "intakeReady" | "enabled" | "installed">,
): string | undefined {
  if (engine.installed === false) return "Not installed";
  if (engine.enabled === false) return "Disabled";
  if (engine.authentication === "checking") return "Checking Sign-In";
  if (engine.authentication === "error") return "Sign-In Check Failed";
  if (engine.authentication !== "authenticated") return "Sign-In Needed";
  if (!engine.intakeReady) return "Provider Unavailable";
  return undefined;
}

export function engineCanDiscover(engine: Pick<EngineDto, "authentication" | "enabled" | "installed"> | undefined): boolean {
  return Boolean(engine && engine.enabled !== false && engine.installed !== false && engineIsAuthenticated(engine));
}

/** Shared creation/import default: never choose arbitrarily among providers. */
export function soleAvailableEngineId(engines: readonly EngineDto[]): string | undefined {
  const available = engines.filter(engineIsAvailable);
  return available.length === 1 ? available[0]!.id : undefined;
}

/** An operator-disabled provider is intentionally inactive, not unhealthy. */
export function engineCanTestAccess(engine: Pick<EngineDto, "authentication" | "intakeReady" | "enabled" | "installed" | "reachability">): boolean {
  return engine.enabled !== false && engine.installed !== false && engineIsAuthenticated(engine) &&
    (!engine.intakeReady || engine.reachability !== "reachable");
}

export function engineStatusPresentation(engine: Pick<EngineDto, "authentication" | "intakeReady" | "enabled" | "installed" | "reachability" | "resourceAdmission">): {
  label: "Checking" | "Reachable" | "Intake ready" | "Needs attention" | "Inactive" | "Host resources";
  color: "success" | "warning" | "default";
} {
  if (engine.enabled === false || engine.installed === false) return { label: "Inactive", color: "default" };
  if (engine.resourceAdmission?.state === "held") return { label: "Host resources", color: "warning" };
  if (engine.authentication === "checking" || engine.reachability === "checking") {
    return { label: "Checking", color: "default" };
  }
  if (engine.reachability === "reachable") return { label: "Reachable", color: "success" };
  return engine.intakeReady
    ? { label: "Intake ready", color: "success" }
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

  const enabled = engines.filter((engine) => engine.enabled !== false && engine.installed !== false);
  const available = enabled.filter(engineIsAvailable);
  const unavailable = enabled.filter((engine) => !engineIsAvailable(engine));
  const disabled = engines.filter((engine) => engine.enabled === false);
  const missing = engines.filter((engine) => engine.installed === false);
  const missingSummary = missing.length ? `${missing.map(engine => engine.displayName).join(", ")} ${missing.length === 1 ? "is" : "are"} not installed.` : "";
  const availableSummary = available.length
    ? `${available.map((engine) => engine.displayName).join(", ")} ${available.length === 1 ? "is" : "are"} ready.`
    : "No enabled engine can currently run work.";
  const unavailableSummary = unavailable.map((engine) => {
    const held = engine.resourceAdmission?.state === "held";
    const state = held ? "waiting for host resources" : engine.authentication === "checking" ? "still checking"
      : engine.authentication === "authenticated" ? "unavailable"
      : engine.authentication === "error" ? "status unavailable"
      : "not signed in";
    const detail = conciseAvailabilityDetail(held ? engine.resourceAdmission?.reason : engine.availabilityDetail ?? engine.authDetail);
    const sentence = `${engine.displayName} is ${state}${detail ? `: ${detail}` : ""}`;
    return /[.!?…]$/u.test(sentence) ? sentence : `${sentence}.`;
  }).join(" ");
  const disabledSummary = disabled.length
    ? `${disabled.map((engine) => engine.displayName).join(", ")} ${disabled.length === 1 ? "is" : "are"} disabled.`
    : "";
  if (enabled.length === 0) {
    return {
      label: "Inactive",
      severity: "default",
      detail: `${[missingSummary, disabledSummary].filter(Boolean).join(" ")} ${missing.length ? "Install and sign in to Codex or Claude" : "Enable a provider"} to run work.`,
    };
  }
  const detail = [
    `${available.length} of ${enabled.length} enabled ${enabled.length === 1 ? "engine" : "engines"} ready.`,
    availableSummary,
    unavailableSummary,
    disabledSummary,
    missingSummary,
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
  const efforts = engine.models.find((option) => option.id === model)?.efforts ?? engine.efforts;
  if (engine.id !== "claude") return efforts;
  return efforts.map((option) => ({
    ...option,
    label: option.id === "xhigh"
      ? "Extra high"
      : `${option.id.charAt(0).toUpperCase()}${option.id.slice(1)}`,
  }));
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
    { id: "standard", label: "Normal", detail: "Default speed" },
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
  catalog: ProjectEngineModelCatalogDto | ProjectEngineModelCatalogDto[] | undefined,
): EngineDto[] {
  if (!catalog) return engines;
  if (Array.isArray(catalog)) return catalog.reduce((current, entry) => enginesWithModelCatalog(current, entry), engines);
  return engines.map(engine => {
    if (engine.id !== catalog.engineId || (engine.cliVersion && engine.cliVersion !== catalog.cliVersion)) return engine;
    const defaultModel = catalog.models.find(model => model.isDefault)
      ?? catalog.models.find(model => model.id === engine.defaultModel)
      ?? catalog.models.find(model => model.id);
    return {
      ...engine,
      defaultModel: defaultModel?.id,
      defaultEffort: defaultModel?.defaultEffort ?? engine.defaultEffort,
      cliVersion: catalog.cliVersion,
      modelCatalogFetchedAt: catalog.fetchedAt,
      models: catalog.models.map(model => ({
        ...model,
        ...(model.supportedEffortLevels
          ? { efforts: model.supportedEffortLevels.map(effort => ({ id: effort, label: effort })) }
          : {}),
      })),
      modelCatalogKnown: true,
    };
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
      effort: current.effort,
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
