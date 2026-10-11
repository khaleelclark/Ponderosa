import type {
  CreateTriggerRequest,
  ReviewedTriggerDefinition,
  RunTriggerRequest,
  TriggerSourceConfig,
  TriggerSourceKind,
  UpdateTriggerRequest,
} from "@ponderosa/core";

export function triggerObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactTriggerFields(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(
      `unknown ${label} field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

export function triggerSourceConfig(
  kind: TriggerSourceKind,
  value: unknown,
): TriggerSourceConfig {
  const config = triggerObject(value, "sourceConfig");
  if (kind === "schedule") {
    const scheduleKind = config.scheduleKind;
    if (scheduleKind === "once") {
      exactTriggerFields(config, ["scheduleKind", "at"], "one-time schedule");
      if (typeof config.at !== "string") {
        throw new Error("one-time schedule at must be a string");
      }
    } else if (scheduleKind === "interval") {
      exactTriggerFields(
        config,
        ["scheduleKind", "everyMs", "startsAt"],
        "interval schedule",
      );
      if (
        typeof config.everyMs !== "number" ||
        typeof config.startsAt !== "string"
      ) {
        throw new Error(
          "interval everyMs must be a number and startsAt must be a string",
        );
      }
    } else if (scheduleKind === "cron") {
      exactTriggerFields(
        config,
        ["scheduleKind", "expression", "timezone"],
        "cron schedule",
      );
      if (
        typeof config.expression !== "string" ||
        typeof config.timezone !== "string"
      ) {
        throw new Error("cron expression and timezone must be strings");
      }
    } else {
      throw new Error("invalid scheduleKind");
    }
  } else if (kind === "webhook") {
    exactTriggerFields(config, ["replayWindowSeconds"], "webhook config");
    if (
      config.replayWindowSeconds !== undefined &&
      typeof config.replayWindowSeconds !== "number"
    ) {
      throw new Error("replayWindowSeconds must be a number");
    }
  } else {
    exactTriggerFields(
      config,
      ["include", "exclude", "quietMs", "maxWindowMs"],
      "filesystem config",
    );
    for (const field of ["include", "exclude"] as const) {
      if (
        config[field] !== undefined &&
        (!Array.isArray(config[field]) ||
          !(config[field] as unknown[]).every((item) => typeof item === "string"))
      ) {
        throw new Error(`${field} must be an array of strings`);
      }
    }
    for (const field of ["quietMs", "maxWindowMs"] as const) {
      if (config[field] !== undefined && typeof config[field] !== "number") {
        throw new Error(`${field} must be a number`);
      }
    }
  }
  return config as unknown as TriggerSourceConfig;
}

export function parseCreateTrigger(value: unknown): CreateTriggerRequest {
  const body = triggerObject(value, "Automation body");
  exactTriggerFields(
    body,
    [
      "conversationId",
      "targetAgentId",
      "name",
      "instructions",
      "sourceKind",
      "sourceConfig",
      "enabled",
      "runBudget",
    ],
    "Automation",
  );
  if (
    typeof body.conversationId !== "string" ||
    typeof body.targetAgentId !== "string" ||
    typeof body.name !== "string" ||
    typeof body.instructions !== "string"
  ) {
    throw new Error("conversationId, targetAgentId, name, and instructions must be strings");
  }
  if (
    body.sourceKind !== "schedule" &&
    body.sourceKind !== "webhook" &&
    body.sourceKind !== "filesystem"
  ) {
    throw new Error("sourceKind must be schedule, webhook, or filesystem");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const runBudget =
    body.runBudget === undefined
      ? undefined
      : triggerObject(body.runBudget, "runBudget");
  if (runBudget) {
    exactTriggerFields(runBudget, ["limit", "period"], "runBudget");
    if (
      !Number.isSafeInteger(runBudget.limit) ||
      !["day", "week", "month", "lifetime"].includes(String(runBudget.period))
    ) {
      throw new Error(
        "runBudget requires an integer limit and day, week, month, or lifetime period",
      );
    }
  }
  return {
    conversationId: body.conversationId,
    targetAgentId: body.targetAgentId,
    name: body.name,
    instructions: body.instructions,
    sourceKind: body.sourceKind,
    sourceConfig: triggerSourceConfig(body.sourceKind, body.sourceConfig),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(runBudget
      ? {
          runBudget:
            runBudget as unknown as NonNullable<
              CreateTriggerRequest["runBudget"]
            >,
        }
      : {}),
  };
}

export function parseUpdateTrigger(
  value: unknown,
  sourceKind: TriggerSourceKind,
): UpdateTriggerRequest {
  const body = triggerObject(value, "Automation patch");
  exactTriggerFields(
    body,
    ["conversationId", "targetAgentId", "name", "instructions", "sourceConfig", "enabled", "runBudget", "reviewedDefinition"],
    "Automation patch",
  );
  if (body.name !== undefined && typeof body.name !== "string") {
    throw new Error("name must be a string");
  }
  if (body.conversationId !== undefined && typeof body.conversationId !== "string") {
    throw new Error("conversationId must be a string");
  }
  if (body.targetAgentId !== undefined && typeof body.targetAgentId !== "string") {
    throw new Error("targetAgentId must be a string");
  }
  if (
    body.instructions !== undefined &&
    typeof body.instructions !== "string"
  ) {
    throw new Error("instructions must be a string");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  let runBudget: UpdateTriggerRequest["runBudget"] | undefined;
  if (body.runBudget === null) {
    runBudget = null;
  } else if (body.runBudget !== undefined) {
    const parsed = triggerObject(body.runBudget, "runBudget");
    exactTriggerFields(parsed, ["limit", "period"], "runBudget");
    if (
      !Number.isSafeInteger(parsed.limit) ||
      !["day", "week", "month", "lifetime"].includes(String(parsed.period))
    ) {
      throw new Error(
        "runBudget requires an integer limit and day, week, month, or lifetime period",
      );
    }
    runBudget =
      parsed as unknown as NonNullable<UpdateTriggerRequest["runBudget"]>;
  }
  return {
    ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
    ...(body.targetAgentId === undefined ? {} : { targetAgentId: body.targetAgentId }),
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.instructions === undefined
      ? {}
      : { instructions: body.instructions }),
    ...(body.sourceConfig === undefined
      ? {}
      : { sourceConfig: triggerSourceConfig(sourceKind, body.sourceConfig) }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(runBudget === undefined ? {} : { runBudget }),
    ...(Object.hasOwn(body, "reviewedDefinition") ? { reviewedDefinition: parseReviewedTriggerDefinition(body.reviewedDefinition) } : {}),
  };
}

/** A present guard must be complete; malformed guards never fall back to legacy behavior. */
export function parseReviewedTriggerDefinition(value: unknown): ReviewedTriggerDefinition {
  const body = triggerObject(value, "reviewedDefinition");
  const fields = ["id", "projectId", "conversationId", "targetAgentId", "branchId", "name", "instructions", "sourceKind", "sourceConfig", "enabled", "fullAccess", "runBudget"];
  exactTriggerFields(body, fields, "reviewedDefinition");
  if (fields.some(key => !Object.hasOwn(body, key))) throw new Error("reviewedDefinition must contain every authority field");
  for (const key of ["id", "projectId", "conversationId", "name"]) {
    if((key==='projectId'||key==='conversationId')&&body[key]===''&&body.projectId===''&&body.conversationId===''&&typeof body.branchId==='string'&&body.branchId.trim()&&body.targetAgentId===null)continue;
    if (typeof body[key] !== "string" || !String(body[key]).trim()) throw new Error(`reviewedDefinition ${key} must be a nonempty string`);
  }
  if (typeof body.instructions !== "string" || !body.instructions.trim() || body.instructions.length > 20_000 || String(body.name).length > 120) throw new Error("invalid reviewedDefinition name or instructions");
  for (const key of ["targetAgentId", "branchId"]) {
    if (body[key] !== null && (typeof body[key] !== "string" || !String(body[key]).trim())) throw new Error(`reviewedDefinition ${key} must be a nonempty string or null`);
  }
  if ((body.targetAgentId === null) === (body.branchId === null)) throw new Error("reviewedDefinition requires one destination");
  if (typeof body.enabled !== "boolean" || body.fullAccess !== true) throw new Error("invalid reviewedDefinition authority");
  if (body.sourceKind !== "schedule" && body.sourceKind !== "webhook" && body.sourceKind !== "filesystem") throw new Error("invalid reviewedDefinition sourceKind");
  const config = triggerSourceConfig(body.sourceKind, body.sourceConfig);
  const required = body.sourceKind === "webhook" ? ["replayWindowSeconds"] : body.sourceKind === "filesystem" ? ["include", "exclude", "quietMs", "maxWindowMs"] : config && "scheduleKind" in config && config.scheduleKind === "once" ? ["scheduleKind", "at"] : config && "scheduleKind" in config && config.scheduleKind === "interval" ? ["scheduleKind", "everyMs", "startsAt"] : ["scheduleKind", "expression", "timezone"];
  if (required.some(key => !Object.hasOwn(config, key))) throw new Error("reviewedDefinition sourceConfig must be complete");
  if (body.runBudget !== null) {
    const budget = triggerObject(body.runBudget, "reviewedDefinition runBudget");
    exactTriggerFields(budget, ["limit", "period"], "reviewedDefinition runBudget");
    if (!Number.isSafeInteger(budget.limit) || Number(budget.limit) < 1 || Number(budget.limit) > 1_000_000 || !["day", "week", "month", "lifetime"].includes(String(budget.period))) throw new Error("invalid reviewedDefinition runBudget");
  }
  return body as unknown as ReviewedTriggerDefinition;
}

export function parseRunTrigger(value: unknown): RunTriggerRequest {
  const body = value === undefined ? {} : triggerObject(value, "Automation run");
  exactTriggerFields(body, ["confirmDisabled", "reviewedDefinition"], "Automation run");
  if (body.confirmDisabled !== undefined && typeof body.confirmDisabled !== "boolean") throw new Error("confirmDisabled must be a boolean");
  return {
    ...(body.confirmDisabled === undefined ? {} : { confirmDisabled: body.confirmDisabled }),
    ...(Object.hasOwn(body, "reviewedDefinition") ? { reviewedDefinition: parseReviewedTriggerDefinition(body.reviewedDefinition) } : {}),
  };
}
