import type {TriggerSourceConfig,TriggerSourceKind} from "@ponderosa/core";
import {validatedObject,exactObjectFields} from "./object-validation.js";
export function triggerSourceConfig(
  kind: TriggerSourceKind,
  value: unknown,
): TriggerSourceConfig {
  const config = validatedObject(value, "sourceConfig");
  if (kind === "schedule") {
    const scheduleKind = config.scheduleKind;
    if (scheduleKind === "once") {
      exactObjectFields(config, ["scheduleKind", "at"], "one-time schedule");
      if (typeof config.at !== "string") {
        throw new Error("one-time schedule at must be a string");
      }
    } else if (scheduleKind === "interval") {
      exactObjectFields(
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
      exactObjectFields(
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
    exactObjectFields(config, ["replayWindowSeconds"], "webhook config");
    if (
      config.replayWindowSeconds !== undefined &&
      typeof config.replayWindowSeconds !== "number"
    ) {
      throw new Error("replayWindowSeconds must be a number");
    }
  } else if(kind==='filesystem') {
    exactObjectFields(
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
  if(!['schedule','webhook','filesystem'].includes(kind))throw new Error('Unknown Branch trigger source');
  return config as unknown as TriggerSourceConfig;
}