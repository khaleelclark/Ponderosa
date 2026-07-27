import type {
  CreateTriggerRequest,
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
  const body = triggerObject(value, "Trigger body");
  exactTriggerFields(
    body,
    [
      "conversationId",
      "name",
      "instructions",
      "sourceKind",
      "sourceConfig",
      "enabled",
      "runBudget",
    ],
    "Trigger",
  );
  if (
    typeof body.conversationId !== "string" ||
    typeof body.name !== "string" ||
    typeof body.instructions !== "string"
  ) {
    throw new Error("conversationId, name, and instructions must be strings");
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
  const body = triggerObject(value, "Trigger patch");
  exactTriggerFields(
    body,
    ["name", "instructions", "sourceConfig", "enabled", "runBudget"],
    "Trigger patch",
  );
  if (body.name !== undefined && typeof body.name !== "string") {
    throw new Error("name must be a string");
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
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.instructions === undefined
      ? {}
      : { instructions: body.instructions }),
    ...(body.sourceConfig === undefined
      ? {}
      : { sourceConfig: triggerSourceConfig(sourceKind, body.sourceConfig) }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(runBudget === undefined ? {} : { runBudget }),
  };
}
