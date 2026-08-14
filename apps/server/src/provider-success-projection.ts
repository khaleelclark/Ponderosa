import type {
  EffortOption,
  EngineCapabilities,
  EngineCommand,
  EngineComposerCapability,
  EngineMcpServer,
  EngineModelCatalog,
  EngineModelOption,
  ProviderUsage,
  ProviderUsageWindow,
  ServiceTierOption,
} from "@ponderosa/core";

const MAX_CAPABILITY_ROWS = 1_000;
const MAX_MODEL_ROWS = 500;
const MAX_USAGE_WINDOWS = 100;
const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_LABEL_CHARACTERS = 1_024;
const MAX_DESCRIPTION_CHARACTERS = 8_192;
const JSON_UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export class ProviderSuccessProjectionError extends Error {
  readonly restrictedDetail: string;

  constructor(boundary: "capabilities" | "usage") {
    super("Provider returned invalid structured data.");
    this.name = "ProviderSuccessProjectionError";
    this.restrictedDetail = `${boundary} result did not match the closed provider schema`;
  }
}

function reject(boundary: "capabilities" | "usage"): never {
  throw new ProviderSuccessProjectionError(boundary);
}

function dataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  boundary: "capabilities" | "usage",
): Map<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) reject(boundary);
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) reject(boundary);
    const allowed = new Set(allowedKeys);
    const result = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) reject(boundary);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) reject(boundary);
      result.set(key, descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof ProviderSuccessProjectionError) throw error;
    return reject(boundary);
  }
}

function dataArray(
  value: unknown,
  limit: number,
  boundary: "capabilities" | "usage",
): unknown[] {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) reject(boundary);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const rawLength = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength)
      || rawLength < 0 || rawLength > limit) reject(boundary);
    const length = rawLength;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) reject(boundary);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) reject(boundary);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) reject(boundary);
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof ProviderSuccessProjectionError) throw error;
    return reject(boundary);
  }
}

function requiredString(
  record: Map<string, unknown>,
  key: string,
  limit: number,
  boundary: "capabilities" | "usage",
): string {
  const value = record.get(key);
  if (
    typeof value !== "string"
    || value.length > limit
    || JSON_UNSAFE_CONTROL.test(value)
  ) reject(boundary);
  return value;
}

function optionalString(
  record: Map<string, unknown>,
  key: string,
  limit: number,
  boundary: "capabilities" | "usage",
): string | undefined {
  if (!record.has(key) || record.get(key) === undefined) return undefined;
  return requiredString(record, key, limit, boundary);
}

function requiredBoolean(
  record: Map<string, unknown>,
  key: string,
  boundary: "capabilities" | "usage",
): boolean {
  const value = record.get(key);
  if (typeof value !== "boolean") reject(boundary);
  return value;
}

function optionalBoolean(
  record: Map<string, unknown>,
  key: string,
  boundary: "capabilities" | "usage",
): boolean | undefined {
  if (!record.has(key) || record.get(key) === undefined) return undefined;
  return requiredBoolean(record, key, boundary);
}

function enumString<T extends string>(
  record: Map<string, unknown>,
  key: string,
  values: readonly T[],
  boundary: "capabilities" | "usage",
): T {
  const value = requiredString(record, key, MAX_IDENTIFIER_CHARACTERS, boundary);
  if (!values.includes(value as T)) reject(boundary);
  return value as T;
}

function finiteNumber(
  record: Map<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  boundary: "capabilities" | "usage",
): number {
  const value = record.get(key);
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    reject(boundary);
  }
  return value;
}

function effort(value: unknown): EffortOption {
  const record = dataRecord(value, ["id", "label"], "capabilities");
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, "capabilities"),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, "capabilities"),
  };
}

function serviceTier(value: unknown): ServiceTierOption {
  const record = dataRecord(value, ["id", "label", "description"], "capabilities");
  const description = optionalString(record, "description", MAX_DESCRIPTION_CHARACTERS, "capabilities");
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, "capabilities"),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, "capabilities"),
    ...(description === undefined ? {} : { description }),
  };
}

function model(value: unknown): EngineModelOption {
  const record = dataRecord(value, [
    "id", "label", "efforts", "defaultEffort", "serviceTiers", "defaultServiceTier",
    "resolvedModel", "description", "kind", "supportedEffortLevels", "source",
    "validatedAt", "availability", "unavailableReason",
  ], "capabilities");
  const efforts = record.has("efforts") && record.get("efforts") !== undefined
    ? dataArray(record.get("efforts"), 64, "capabilities").map(effort)
    : undefined;
  const serviceTiers = record.has("serviceTiers") && record.get("serviceTiers") !== undefined
    ? dataArray(record.get("serviceTiers"), 64, "capabilities").map(serviceTier)
    : undefined;
  const supportedEffortLevels = record.has("supportedEffortLevels")
    && record.get("supportedEffortLevels") !== undefined
    ? dataArray(record.get("supportedEffortLevels"), 64, "capabilities").map((entry) => {
        if (typeof entry !== "string"
          || entry.length > MAX_IDENTIFIER_CHARACTERS || JSON_UNSAFE_CONTROL.test(entry)) {
          reject("capabilities");
        }
        return entry;
      })
    : undefined;
  const description = optionalString(record, "description", MAX_DESCRIPTION_CHARACTERS, "capabilities");
  const defaultEffort = optionalString(record, "defaultEffort", MAX_IDENTIFIER_CHARACTERS, "capabilities");
  const defaultServiceTier = optionalString(record, "defaultServiceTier", MAX_IDENTIFIER_CHARACTERS, "capabilities");
  const resolvedModel = optionalString(record, "resolvedModel", MAX_IDENTIFIER_CHARACTERS, "capabilities");
  const validatedAt = optionalString(record, "validatedAt", MAX_IDENTIFIER_CHARACTERS, "capabilities");
  const unavailableReason = optionalString(record, "unavailableReason", MAX_DESCRIPTION_CHARACTERS, "capabilities");
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, "capabilities"),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, "capabilities"),
    kind: enumString(record, "kind", ["alias", "exact"] as const, "capabilities"),
    source: enumString(record, "source", ["provider-probe", "operator", "environment"] as const, "capabilities"),
    ...(efforts ? { efforts } : {}),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(serviceTiers ? { serviceTiers } : {}),
    ...(defaultServiceTier === undefined ? {} : { defaultServiceTier }),
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(description === undefined ? {} : { description }),
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
    ...(validatedAt === undefined ? {} : { validatedAt }),
    ...(record.has("availability") && record.get("availability") !== undefined
      ? { availability: enumString(record, "availability", ["available", "unavailable"] as const, "capabilities") }
      : {}),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

function modelCatalog(value: unknown): EngineModelCatalog {
  const record = dataRecord(value, ["models", "cliVersion", "configurationKey"], "capabilities");
  return {
    models: dataArray(record.get("models"), MAX_MODEL_ROWS, "capabilities").map(model),
    cliVersion: requiredString(record, "cliVersion", MAX_IDENTIFIER_CHARACTERS, "capabilities"),
    configurationKey: requiredString(record, "configurationKey", MAX_IDENTIFIER_CHARACTERS, "capabilities"),
  };
}

function command(value: unknown): EngineCommand {
  const record = dataRecord(value, [
    "name", "description", "source", "acceptsArguments", "insertText", "status",
    "unavailableReason", "invocation", "pluginName",
  ], "capabilities");
  const unavailableReason = optionalString(record, "unavailableReason", MAX_DESCRIPTION_CHARACTERS, "capabilities");
  const pluginName = optionalString(record, "pluginName", MAX_LABEL_CHARACTERS, "capabilities");
  return {
    name: requiredString(record, "name", MAX_IDENTIFIER_CHARACTERS, "capabilities"),
    description: requiredString(record, "description", MAX_DESCRIPTION_CHARACTERS, "capabilities"),
    source: enumString(record, "source", [
      "provider-advertised", "adapter-implemented", "skill", "plugin",
    ] as const, "capabilities"),
    acceptsArguments: requiredBoolean(record, "acceptsArguments", "capabilities"),
    insertText: requiredString(record, "insertText", MAX_LABEL_CHARACTERS, "capabilities"),
    status: enumString(record, "status", ["available", "unavailable"] as const, "capabilities"),
    invocation: enumString(record, "invocation", ["prompt", "runtime"] as const, "capabilities"),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(pluginName === undefined ? {} : { pluginName }),
  };
}

function mcpServer(value: unknown): EngineMcpServer {
  const record = dataRecord(value, [
    "name", "configured", "initialization", "usable", "toolsDiscovered", "toolCount",
    "health", "detail",
  ], "capabilities");
  const detail = optionalString(record, "detail", MAX_DESCRIPTION_CHARACTERS, "capabilities");
  return {
    name: requiredString(record, "name", MAX_LABEL_CHARACTERS, "capabilities"),
    configured: requiredBoolean(record, "configured", "capabilities"),
    initialization: enumString(record, "initialization", [
      "not_initialized", "initializing", "initialized", "failed",
    ] as const, "capabilities"),
    usable: requiredBoolean(record, "usable", "capabilities"),
    toolsDiscovered: requiredBoolean(record, "toolsDiscovered", "capabilities"),
    toolCount: finiteNumber(record, "toolCount", 0, 1_000_000, "capabilities"),
    health: enumString(record, "health", ["healthy", "unhealthy", "unknown"] as const, "capabilities"),
    ...(detail === undefined ? {} : { detail }),
  };
}

function composerCapability(value: unknown): EngineComposerCapability {
  const record = dataRecord(value, [
    "id", "kind", "label", "description", "status", "insertText", "unavailableReason",
  ], "capabilities");
  const insertText = optionalString(record, "insertText", MAX_LABEL_CHARACTERS, "capabilities");
  const unavailableReason = optionalString(record, "unavailableReason", MAX_DESCRIPTION_CHARACTERS, "capabilities");
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, "capabilities"),
    kind: enumString(record, "kind", ["skill", "plugin", "connector"] as const, "capabilities"),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, "capabilities"),
    description: requiredString(record, "description", MAX_DESCRIPTION_CHARACTERS, "capabilities"),
    status: enumString(record, "status", ["available", "unavailable"] as const, "capabilities"),
    ...(insertText === undefined ? {} : { insertText }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

/** Copy a provider capability result into a closed, accessor-free DTO. */
export function projectProviderCapabilities(value: unknown): EngineCapabilities {
  try {
    const record = dataRecord(value, [
      "steering", "persistentSessions", "sessionId", "selectedModel", "model",
      "catalogVersion", "modelCatalog", "commands", "mcpServers", "composerCapabilities",
    ], "capabilities");
    const sessionId = optionalString(record, "sessionId", MAX_IDENTIFIER_CHARACTERS, "capabilities");
    const selectedModel = optionalString(record, "selectedModel", MAX_IDENTIFIER_CHARACTERS, "capabilities");
    const activeModel = optionalString(record, "model", MAX_IDENTIFIER_CHARACTERS, "capabilities");
    const catalogVersion = optionalString(record, "catalogVersion", MAX_IDENTIFIER_CHARACTERS, "capabilities");
    return {
      steering: requiredBoolean(record, "steering", "capabilities"),
      persistentSessions: requiredBoolean(record, "persistentSessions", "capabilities"),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(selectedModel === undefined ? {} : { selectedModel }),
      ...(activeModel === undefined ? {} : { model: activeModel }),
      ...(catalogVersion === undefined ? {} : { catalogVersion }),
      ...(record.has("modelCatalog") && record.get("modelCatalog") !== undefined
        ? { modelCatalog: modelCatalog(record.get("modelCatalog")) }
        : {}),
      commands: dataArray(record.get("commands"), MAX_CAPABILITY_ROWS, "capabilities").map(command),
      mcpServers: dataArray(record.get("mcpServers"), MAX_CAPABILITY_ROWS, "capabilities").map(mcpServer),
      composerCapabilities: dataArray(
        record.get("composerCapabilities"),
        MAX_CAPABILITY_ROWS,
        "capabilities",
      ).map(composerCapability),
    };
  } catch (error) {
    if (error instanceof ProviderSuccessProjectionError) throw error;
    return reject("capabilities");
  }
}

function usageWindow(value: unknown): ProviderUsageWindow {
  const record = dataRecord(value, ["id", "label", "usedPercent", "resetsAt"], "usage");
  const resetsAt = optionalString(record, "resetsAt", MAX_IDENTIFIER_CHARACTERS, "usage");
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, "usage"),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, "usage"),
    ...(record.has("usedPercent") && record.get("usedPercent") !== undefined
      ? { usedPercent: finiteNumber(record, "usedPercent", 0, 100, "usage") }
      : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** Copy a provider usage result into a closed, accessor-free DTO. */
export function projectProviderUsage(value: unknown, expectedProvider: string): ProviderUsage {
  try {
    const record = dataRecord(value, [
      "provider", "windows", "accountLabel", "source", "fetchedAt", "stale",
    ], "usage");
    const provider = requiredString(record, "provider", MAX_IDENTIFIER_CHARACTERS, "usage");
    if (provider !== expectedProvider) reject("usage");
    const accountLabel = optionalString(record, "accountLabel", MAX_LABEL_CHARACTERS, "usage");
    const stale = optionalBoolean(record, "stale", "usage");
    return {
      provider,
      windows: dataArray(record.get("windows"), MAX_USAGE_WINDOWS, "usage").map(usageWindow),
      ...(accountLabel === undefined ? {} : { accountLabel }),
      source: enumString(record, "source", ["provider-command", "provider-rpc"] as const, "usage"),
      fetchedAt: requiredString(record, "fetchedAt", MAX_IDENTIFIER_CHARACTERS, "usage"),
      ...(stale === undefined ? {} : { stale }),
    };
  } catch (error) {
    if (error instanceof ProviderSuccessProjectionError) throw error;
    return reject("usage");
  }
}
