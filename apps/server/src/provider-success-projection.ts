import type {
  EffortOption,
  EngineAuthStatus,
  EngineAvailabilityStatus,
  EngineCapabilities,
  EngineCommand,
  EngineComposerCapability,
  EngineMcpServer,
  EngineModelCatalog,
  EngineModelValidationResult,
  EngineModelOption,
  ModelOption,
  ProviderUsage,
  ProviderUsageWindow,
  ServiceTierOption,
  RuntimeCommandResult,
  RuntimeSteerResult,
} from "@ponderosa/core";
import { normalizeProviderFailureCategory } from "@ponderosa/core";
import { isProxy } from "node:util/types";

const MAX_CAPABILITY_ROWS = 1_000;
const MAX_MODEL_ROWS = 500;
const MAX_USAGE_WINDOWS = 100;
const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_LABEL_CHARACTERS = 1_024;
const MAX_DESCRIPTION_CHARACTERS = 8_192;
const MAX_PROJECTED_UTF8_BYTES = 256 * 1024;
const MAX_PROJECTED_NODES = 10_000;
const MAX_PROJECTED_DEPTH = 8;
const JSON_UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
type ProjectionBoundary =
  | "auth"
  | "availability"
  | "capabilities"
  | "usage"
  | "models"
  | "validation"
  | "command"
  | "steering"
  | "context_usage"
  | "session_identifier";

export class ProviderSuccessProjectionError extends Error {
  readonly restrictedDetail: string;

  constructor(boundary: ProjectionBoundary) {
    super("Provider returned invalid structured data.");
    this.name = "ProviderSuccessProjectionError";
    this.restrictedDetail = `${boundary} result did not match the closed provider schema`;
  }
}

function reject(boundary: ProjectionBoundary): never {
  throw new ProviderSuccessProjectionError(boundary);
}

class ProjectionBudget {
  private bytes = 0;
  private nodes = 0;

  constructor(private readonly boundary: ProjectionBoundary) {}

  node(depth: number): void {
    this.nodes += 1;
    // Reserve enough serialized overhead for the closed schema's longest key,
    // separators, and container punctuation. String payload bytes are charged
    // separately using their exact JSON encoding below.
    this.bytes += 32;
    if (this.nodes > MAX_PROJECTED_NODES || depth > MAX_PROJECTED_DEPTH) {
      reject(this.boundary);
    }
    if (this.bytes > MAX_PROJECTED_UTF8_BYTES) reject(this.boundary);
  }

  string(value: string, depth: number): void {
    this.node(depth);
    // Each source string is individually bounded before this call, so this
    // exact encoded-size check never constructs an unbounded aggregate copy.
    this.bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.bytes > MAX_PROJECTED_UTF8_BYTES) reject(this.boundary);
  }
}

function dataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): Map<string, unknown> {
  try {
    budget.node(depth);
    if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) reject(boundary);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) reject(boundary);
    const allowed = new Set(allowedKeys);
    const result = new Map<string, unknown>();
    for (const key of Object.getOwnPropertyNames(value)) {
      if (typeof key !== "string" || !allowed.has(key)) reject(boundary);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) reject(boundary);
      result.set(key, descriptor.value);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) reject(boundary);
    return result;
  } catch {
    return reject(boundary);
  }
}

function projectedArray<T>(
  value: unknown,
  limit: number,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
  project: (entry: unknown, depth: number) => T,
): T[] {
  try {
    budget.node(depth);
    if (value === null || typeof value !== "object" || isProxy(value) ||
        !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) reject(boundary);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const rawLength = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength)
      || rawLength < 0 || rawLength > limit) reject(boundary);
    const length = rawLength;
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length > 0) reject(boundary);
    if (keys.length !== length + 1 || !keys.includes("length")) reject(boundary);
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) reject(boundary);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) reject(boundary);
      result.push(project(descriptor.value, depth + 1));
    }
    return result;
  } catch {
    return reject(boundary);
  }
}

function requiredString(
  record: Map<string, unknown>,
  key: string,
  limit: number,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): string {
  const value = record.get(key);
  if (
    typeof value !== "string"
    || value.length > limit
    || JSON_UNSAFE_CONTROL.test(value)
  ) reject(boundary);
  budget.string(value, depth);
  return value;
}

function optionalString(
  record: Map<string, unknown>,
  key: string,
  limit: number,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): string | undefined {
  if (!record.has(key) || record.get(key) === undefined) return undefined;
  return requiredString(record, key, limit, boundary, budget, depth);
}

function identifierString(
  record: Map<string, unknown>,
  key: string,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): string {
  const value = requiredString(
    record,
    key,
    MAX_IDENTIFIER_CHARACTERS,
    boundary,
    budget,
    depth,
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) reject(boundary);
  return value;
}

function optionalIdentifierString(
  record: Map<string, unknown>,
  key: string,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): string | undefined {
  if (!record.has(key) || record.get(key) === undefined) return undefined;
  return identifierString(record, key, boundary, budget, depth);
}

function requiredBoolean(
  record: Map<string, unknown>,
  key: string,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): boolean {
  const value = record.get(key);
  if (typeof value !== "boolean") reject(boundary);
  budget.node(depth);
  return value;
}

function optionalBoolean(
  record: Map<string, unknown>,
  key: string,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): boolean | undefined {
  if (!record.has(key) || record.get(key) === undefined) return undefined;
  return requiredBoolean(record, key, boundary, budget, depth);
}

function enumString<T extends string>(
  record: Map<string, unknown>,
  key: string,
  values: readonly T[],
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): T {
  const value = requiredString(record, key, MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth);
  if (!values.includes(value as T)) reject(boundary);
  return value as T;
}

function finiteNumber(
  record: Map<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  boundary: ProjectionBoundary,
  budget: ProjectionBudget,
  depth: number,
): number {
  const value = record.get(key);
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    reject(boundary);
  }
  budget.node(depth);
  return value;
}

function effort(
  value: unknown,
  budget: ProjectionBudget,
  depth: number,
  boundary: ProjectionBoundary = "capabilities",
): EffortOption {
  const record = dataRecord(value, ["id", "label"], boundary, budget, depth);
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, boundary, budget, depth + 1),
  };
}

function serviceTier(
  value: unknown,
  budget: ProjectionBudget,
  depth: number,
  boundary: ProjectionBoundary = "capabilities",
): ServiceTierOption {
  const record = dataRecord(value, ["id", "label", "description"], boundary, budget, depth);
  const description = optionalString(
    record, "description", MAX_DESCRIPTION_CHARACTERS, boundary, budget, depth + 1,
  );
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, boundary, budget, depth + 1),
    ...(description === undefined ? {} : { description }),
  };
}

function model(
  value: unknown,
  budget: ProjectionBudget,
  depth: number,
  boundary: ProjectionBoundary = "capabilities",
  requireCatalogMetadata = true,
): ModelOption | EngineModelOption {
  const record = dataRecord(value, [
    "id", "label", "isDefault", "efforts", "defaultEffort", "serviceTiers", "defaultServiceTier",
    "resolvedModel", "description", "kind", "supportedEffortLevels", "source",
    "validatedAt", "availability", "unavailableReason",
  ], boundary, budget, depth);
  const efforts = record.has("efforts") && record.get("efforts") !== undefined
    ? projectedArray(record.get("efforts"), 64, boundary, budget, depth + 1,
        (entry, entryDepth) => effort(entry, budget, entryDepth, boundary))
    : undefined;
  const serviceTiers = record.has("serviceTiers") && record.get("serviceTiers") !== undefined
    ? projectedArray(record.get("serviceTiers"), 64, boundary, budget, depth + 1,
        (entry, entryDepth) => serviceTier(entry, budget, entryDepth, boundary))
    : undefined;
  const supportedEffortLevels = record.has("supportedEffortLevels")
    && record.get("supportedEffortLevels") !== undefined
    ? projectedArray(record.get("supportedEffortLevels"), 64, boundary, budget, depth + 1,
      (entry, entryDepth) => {
        if (typeof entry !== "string"
          || entry.length > MAX_IDENTIFIER_CHARACTERS || JSON_UNSAFE_CONTROL.test(entry)) {
          reject(boundary);
        }
        budget.string(entry, entryDepth);
        return entry;
      })
    : undefined;
  const isDefault = optionalBoolean(record, "isDefault", boundary, budget, depth + 1);
  const description = optionalString(record, "description", MAX_DESCRIPTION_CHARACTERS, boundary, budget, depth + 1);
  const defaultEffort = optionalString(record, "defaultEffort", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1);
  const defaultServiceTier = optionalString(record, "defaultServiceTier", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1);
  const resolvedModel = optionalString(record, "resolvedModel", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1);
  const validatedAt = optionalString(record, "validatedAt", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1);
  const unavailableReason = optionalString(record, "unavailableReason", MAX_DESCRIPTION_CHARACTERS, boundary, budget, depth + 1);
  const kind = record.has("kind") && record.get("kind") !== undefined
    ? enumString(record, "kind", ["alias", "exact"] as const, boundary, budget, depth + 1)
    : undefined;
  const source = record.has("source") && record.get("source") !== undefined
    ? enumString(record, "source", ["provider-probe", "operator", "environment"] as const, boundary, budget, depth + 1)
    : undefined;
  if (requireCatalogMetadata && (kind === undefined || source === undefined)) reject(boundary);
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, boundary, budget, depth + 1),
    ...(kind === undefined ? {} : { kind }),
    ...(source === undefined ? {} : { source }),
    ...(efforts ? { efforts } : {}),
    ...(isDefault === undefined ? {} : { isDefault }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(serviceTiers ? { serviceTiers } : {}),
    ...(defaultServiceTier === undefined ? {} : { defaultServiceTier }),
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(description === undefined ? {} : { description }),
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
    ...(validatedAt === undefined ? {} : { validatedAt }),
    ...(record.has("availability") && record.get("availability") !== undefined
      ? { availability: enumString(record, "availability", ["available", "unavailable"] as const, boundary, budget, depth + 1) }
      : {}),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

function modelCatalog(
  value: unknown,
  budget: ProjectionBudget,
  depth: number,
  boundary: ProjectionBoundary = "capabilities",
): EngineModelCatalog {
  const record = dataRecord(value, ["models", "cliVersion", "configurationKey"], boundary, budget, depth);
  return {
    models: projectedArray(record.get("models"), MAX_MODEL_ROWS, boundary, budget, depth + 1,
      (entry, entryDepth) => model(entry, budget, entryDepth, boundary) as EngineModelOption),
    cliVersion: requiredString(record, "cliVersion", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1),
    configurationKey: requiredString(record, "configurationKey", MAX_IDENTIFIER_CHARACTERS, boundary, budget, depth + 1),
  };
}

function command(value: unknown, budget: ProjectionBudget, depth: number): EngineCommand {
  const record = dataRecord(value, [
    "name", "description", "source", "acceptsArguments", "insertText", "status",
    "unavailableReason", "invocation", "pluginName",
  ], "capabilities", budget, depth);
  const unavailableReason = optionalString(record, "unavailableReason", MAX_DESCRIPTION_CHARACTERS, "capabilities", budget, depth + 1);
  const pluginName = optionalString(record, "pluginName", MAX_LABEL_CHARACTERS, "capabilities", budget, depth + 1);
  return {
    name: requiredString(record, "name", MAX_IDENTIFIER_CHARACTERS, "capabilities", budget, depth + 1),
    description: requiredString(record, "description", MAX_DESCRIPTION_CHARACTERS, "capabilities", budget, depth + 1),
    source: enumString(record, "source", [
      "provider-advertised", "adapter-implemented", "skill", "plugin",
    ] as const, "capabilities", budget, depth + 1),
    acceptsArguments: requiredBoolean(record, "acceptsArguments", "capabilities", budget, depth + 1),
    insertText: requiredString(record, "insertText", MAX_LABEL_CHARACTERS, "capabilities", budget, depth + 1),
    status: enumString(record, "status", ["available", "unavailable"] as const, "capabilities", budget, depth + 1),
    invocation: enumString(record, "invocation", ["prompt", "runtime"] as const, "capabilities", budget, depth + 1),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(pluginName === undefined ? {} : { pluginName }),
  };
}

function mcpServer(value: unknown, budget: ProjectionBudget, depth: number): EngineMcpServer {
  const record = dataRecord(value, [
    "name", "configured", "initialization", "usable", "toolsDiscovered", "toolCount",
    "health", "detail",
  ], "capabilities", budget, depth);
  const detail = optionalString(record, "detail", MAX_DESCRIPTION_CHARACTERS, "capabilities", budget, depth + 1);
  return {
    name: requiredString(record, "name", MAX_LABEL_CHARACTERS, "capabilities", budget, depth + 1),
    configured: requiredBoolean(record, "configured", "capabilities", budget, depth + 1),
    initialization: enumString(record, "initialization", [
      "not_initialized", "initializing", "initialized", "failed",
    ] as const, "capabilities", budget, depth + 1),
    usable: requiredBoolean(record, "usable", "capabilities", budget, depth + 1),
    toolsDiscovered: requiredBoolean(record, "toolsDiscovered", "capabilities", budget, depth + 1),
    toolCount: finiteNumber(record, "toolCount", 0, 1_000_000, "capabilities", budget, depth + 1),
    health: enumString(record, "health", ["healthy", "unhealthy", "unknown"] as const, "capabilities", budget, depth + 1),
    ...(detail === undefined ? {} : { detail }),
  };
}

function composerCapability(value: unknown, budget: ProjectionBudget, depth: number): EngineComposerCapability {
  const record = dataRecord(value, [
    "id", "kind", "label", "description", "status", "insertText", "unavailableReason",
  ], "capabilities", budget, depth);
  const insertText = optionalString(record, "insertText", MAX_LABEL_CHARACTERS, "capabilities", budget, depth + 1);
  const unavailableReason = optionalString(record, "unavailableReason", MAX_DESCRIPTION_CHARACTERS, "capabilities", budget, depth + 1);
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, "capabilities", budget, depth + 1),
    kind: enumString(record, "kind", ["skill", "plugin", "connector"] as const, "capabilities", budget, depth + 1),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, "capabilities", budget, depth + 1),
    description: requiredString(record, "description", MAX_DESCRIPTION_CHARACTERS, "capabilities", budget, depth + 1),
    status: enumString(record, "status", ["available", "unavailable"] as const, "capabilities", budget, depth + 1),
    ...(insertText === undefined ? {} : { insertText }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

/** Copy a provider capability result into a closed, accessor-free DTO. */
export function projectProviderCapabilities(value: unknown): EngineCapabilities {
  const budget = new ProjectionBudget("capabilities");
  try {
    const record = dataRecord(value, [
      "steering", "persistentSessions", "sessionId", "selectedModel", "model",
      "catalogVersion", "modelCatalog", "commands", "mcpServers", "composerCapabilities",
    ], "capabilities", budget, 0);
    const sessionId = optionalIdentifierString(record, "sessionId", "capabilities", budget, 1);
    const selectedModel = optionalString(record, "selectedModel", MAX_IDENTIFIER_CHARACTERS, "capabilities", budget, 1);
    const activeModel = optionalString(record, "model", MAX_IDENTIFIER_CHARACTERS, "capabilities", budget, 1);
    const catalogVersion = optionalString(record, "catalogVersion", MAX_IDENTIFIER_CHARACTERS, "capabilities", budget, 1);
    return {
      steering: requiredBoolean(record, "steering", "capabilities", budget, 1),
      persistentSessions: requiredBoolean(record, "persistentSessions", "capabilities", budget, 1),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(selectedModel === undefined ? {} : { selectedModel }),
      ...(activeModel === undefined ? {} : { model: activeModel }),
      ...(catalogVersion === undefined ? {} : { catalogVersion }),
      ...(record.has("modelCatalog") && record.get("modelCatalog") !== undefined
        ? { modelCatalog: modelCatalog(record.get("modelCatalog"), budget, 1) }
        : {}),
      commands: projectedArray(record.get("commands"), MAX_CAPABILITY_ROWS, "capabilities", budget, 1,
        (entry, depth) => command(entry, budget, depth)),
      mcpServers: projectedArray(record.get("mcpServers"), MAX_CAPABILITY_ROWS, "capabilities", budget, 1,
        (entry, depth) => mcpServer(entry, budget, depth)),
      composerCapabilities: projectedArray(
        record.get("composerCapabilities"),
        MAX_CAPABILITY_ROWS,
        "capabilities",
        budget,
        1,
        (entry, depth) => composerCapability(entry, budget, depth),
      ),
    };
  } catch {
    return reject("capabilities");
  }
}

/** Copy adapter model choices into a closed, accessor-free DTO array. */
export function projectProviderModelOptions(value: unknown): ModelOption[] {
  const budget = new ProjectionBudget("models");
  return projectedArray(value, MAX_MODEL_ROWS, "models", budget, 0,
    (entry, depth) => model(entry, budget, depth, "models", false) as ModelOption);
}

/** Copy adapter effort choices into a closed, accessor-free DTO array. */
export function projectProviderEffortOptions(value: unknown): EffortOption[] {
  const budget = new ProjectionBudget("models");
  return projectedArray(value, 64, "models", budget, 0,
    (entry, depth) => effort(entry, budget, depth, "models"));
}

/** Copy a discovered model catalog before caching or returning it. */
export function projectProviderModelCatalog(value: unknown): EngineModelCatalog {
  const budget = new ProjectionBudget("models");
  return modelCatalog(value, budget, 0, "models");
}

/** Copy a provider validation success/failure before public policy projection. */
export function projectProviderModelValidation(value: unknown): EngineModelValidationResult {
  const budget = new ProjectionBudget("validation");
  const discriminator = dataRecord(value, ["valid", "model", "errorCode", "error"], "validation", budget, 0);
  const valid = requiredBoolean(discriminator, "valid", "validation", budget, 1);
  if (valid) {
    if (discriminator.has("errorCode") || discriminator.has("error")) reject("validation");
    return {
      valid: true,
      model: model(discriminator.get("model"), budget, 1, "validation") as EngineModelOption,
    };
  }
  if (discriminator.has("model")) reject("validation");
  return {
    valid: false,
    errorCode: enumString(discriminator, "errorCode", [
      "client_upgrade_required", "invalid_request",
      "invalid_model", "model_not_found", "authentication", "rate_limit", "capacity",
      "context_length", "organization_policy", "plan_entitlement", "network", "provider_error",
    ] as const, "validation", budget, 1),
    error: requiredString(discriminator, "error", MAX_DESCRIPTION_CHARACTERS, "validation", budget, 1),
  };
}

/** Validate adapter-owned identifiers before using them in cache keys or DTOs. */
export function projectProviderModelIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const budget = new ProjectionBudget("models");
  const record = new Map<string, unknown>([["value", value]]);
  return requiredString(record, "value", MAX_IDENTIFIER_CHARACTERS, "models", budget, 0);
}

/** Copy a runtime command result before HTTP/event/persistence use. */
export function projectProviderCommandResult(value: unknown): RuntimeCommandResult {
  if (value === undefined) return {};
  const budget = new ProjectionBudget("command");
  const record = dataRecord(value, ["message", "contextUsage", "outcome"], "command", budget, 0);
  const outcome = record.has("outcome") ? enumString(record, "outcome", ["completed", "failed", "outcome_unknown"] as const, "command", budget, 1) : undefined;
  let message = optionalString(record, "message", MAX_DESCRIPTION_CHARACTERS, "command", budget, 1);
  let contextUsage: ReturnType<typeof projectProviderContextUsage>;
  try { contextUsage = record.has("contextUsage") ? projectProviderContextUsage(record.get("contextUsage")) : undefined; }
  catch {
    // The command has already been invoked; unusable optional telemetry cannot
    // invite replay of that operation or become trusted usage evidence.
    message = "Command was invoked; updated context telemetry is invalid. Do not repeat the command solely to refresh telemetry.";
  }
  return { ...(message === undefined ? {} : { message }), ...(outcome ? { outcome } : {}), ...(contextUsage ? { contextUsage } : {}) };
}

/** Copy authentication probe output before it enters the shared auth cache. */
export function projectProviderAuthStatus(value: unknown): EngineAuthStatus {
  const budget = new ProjectionBudget("auth");
  const record = dataRecord(value, ["authenticated", "detail", "status", "reason", "source", "diagnosticFailure"], "auth", budget, 0);
  const detail = optionalString(record, "detail", MAX_DESCRIPTION_CHARACTERS, "auth", budget, 1);
  const status = optionalString(record, "status", 16, "auth", budget, 1);
  const authenticated = requiredBoolean(record, "authenticated", "auth", budget, 1);
  if (status !== undefined && (status !== "unknown" || authenticated)) reject("auth");
  const reason = optionalString(record, "reason", 32, "auth", budget, 1);
  const source = optionalString(record, "source", 32, "auth", budget, 1);
  const diagnosticFailure=optionalString(record,"diagnosticFailure",32,"auth",budget,1);
  if(diagnosticFailure!==undefined&&diagnosticFailure!=='cleanup_failed')reject('auth');
  if (reason !== undefined && (status !== "unknown" || !["timeout", "spawn_failed", "malformed", "cleanup_failed", "probe_failed", "probe_pending"].includes(reason))) reject("auth");
  if (source !== undefined && !["cli_status", "subscription_presence"].includes(source)) reject("auth");
  return {
    authenticated,
    ...(diagnosticFailure ? { diagnosticFailure: diagnosticFailure as "cleanup_failed" } : {}),
    ...(reason ? { reason: reason as EngineAuthStatus["reason"] } : {}),
    ...(source ? { source: source as EngineAuthStatus["source"] } : {}),
    ...(status === "unknown" ? { status } : {}),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Copy an availability probe result before evidence, notifications, or HTTP use. */
export function projectProviderAvailabilityStatus(value: unknown): EngineAvailabilityStatus {
  const budget = new ProjectionBudget("availability");
  const record = dataRecord(
    value,
    ["available", "failureCategory", "detail"],
    "availability",
    budget,
    0,
  );
  const detail = optionalString(
    record,
    "detail",
    MAX_DESCRIPTION_CHARACTERS,
    "availability",
    budget,
    1,
  );
  const category = record.has("failureCategory") && record.get("failureCategory") !== undefined
    ? normalizeProviderFailureCategory(requiredString(
        record,
        "failureCategory",
        MAX_IDENTIFIER_CHARACTERS,
        "availability",
        budget,
        1,
      ))
    : undefined;
  return {
    available: requiredBoolean(record, "available", "availability", budget, 1),
    ...(category === undefined ? {} : { failureCategory: category }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Copy a steering acknowledgement before scheduler decisions or persistence. */
export function projectProviderSteerResult(value: unknown): RuntimeSteerResult {
  const budget = new ProjectionBudget("steering");
  const record = dataRecord(value, ["status", "turnId", "reason"], "steering", budget, 0);
  const status = enumString(record, "status", [
    "accepted", "not_active", "not_steerable", "unsupported",
  ] as const, "steering", budget, 1);
  if (status === "accepted") {
    if (record.has("reason")) reject("steering");
    const turnId = optionalIdentifierString(
      record,
      "turnId",
      "steering",
      budget,
      1,
    );
    return { status, ...(turnId === undefined ? {} : { turnId }) };
  }
  if (record.has("turnId")) reject("steering");
  const reason = optionalString(
    record,
    "reason",
    MAX_DESCRIPTION_CHARACTERS,
    "steering",
    budget,
    1,
  );
  return { status, ...(reason === undefined ? {} : { reason }) };
}

export interface ProjectedProviderContextUsage {
  usedTokens: number;
  windowTokens?: number;
  aggregateTokens?: number;
  providerSessionGeneration?: string;
  requestOutputIncluded?: boolean;
}

/** Copy a synchronous session usage snapshot before rollover decisions. */
export function projectProviderContextUsage(value: unknown): ProjectedProviderContextUsage | undefined {
  if (value === undefined) return undefined;
  const budget = new ProjectionBudget("context_usage");
  const record = dataRecord(value, [
    "usedTokens", "windowTokens", "aggregateTokens", "providerSessionGeneration", "requestOutputIncluded",
  ], "context_usage", budget, 0);
  const optionalTokenCount = (key: "windowTokens" | "aggregateTokens"): number | undefined =>
    record.has(key) && record.get(key) !== undefined
      ? finiteNumber(record, key, 0, Number.MAX_SAFE_INTEGER, "context_usage", budget, 1)
      : undefined;
  const requestOutputIncluded = optionalBoolean(record, "requestOutputIncluded", "context_usage", budget, 1);
  const windowTokens = optionalTokenCount("windowTokens");
  const aggregateTokens = optionalTokenCount("aggregateTokens");
  const providerSessionGeneration = optionalIdentifierString(
    record,
    "providerSessionGeneration",
    "context_usage",
    budget,
    1,
  );
  return {
    usedTokens: finiteNumber(
      record,
      "usedTokens",
      0,
      Number.MAX_SAFE_INTEGER,
      "context_usage",
      budget,
      1,
    ),
    ...(windowTokens === undefined ? {} : { windowTokens }),
    ...(aggregateTokens === undefined ? {} : { aggregateTokens }),
    ...(providerSessionGeneration === undefined ? {} : { providerSessionGeneration }),
    ...(requestOutputIncluded === undefined ? {} : { requestOutputIncluded }),
  };
}

/** Validate one provider-owned opaque session identifier. */
export function projectProviderSessionIdentifier(value: unknown): string {
  const budget = new ProjectionBudget("session_identifier");
  const record = new Map<string, unknown>([["value", value]]);
  return identifierString(
    record,
    "value",
    "session_identifier",
    budget,
    0,
  );
}

function usageWindow(value: unknown, budget: ProjectionBudget, depth: number): ProviderUsageWindow {
  const record = dataRecord(value, ["id", "label", "usedPercent", "resetsAt"], "usage", budget, depth);
  const resetsAt = optionalString(record, "resetsAt", MAX_IDENTIFIER_CHARACTERS, "usage", budget, depth + 1);
  return {
    id: requiredString(record, "id", MAX_IDENTIFIER_CHARACTERS, "usage", budget, depth + 1),
    label: requiredString(record, "label", MAX_LABEL_CHARACTERS, "usage", budget, depth + 1),
    ...(record.has("usedPercent") && record.get("usedPercent") !== undefined
      ? { usedPercent: finiteNumber(record, "usedPercent", 0, 100, "usage", budget, depth + 1) }
      : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** Copy a provider usage result into a closed, accessor-free DTO. */
export function projectProviderUsage(value: unknown, expectedProvider: string): ProviderUsage {
  const budget = new ProjectionBudget("usage");
  try {
    const record = dataRecord(value, [
      "provider", "windows", "accountLabel", "source", "fetchedAt", "stale",
    ], "usage", budget, 0);
    const provider = requiredString(record, "provider", MAX_IDENTIFIER_CHARACTERS, "usage", budget, 1);
    if (provider !== expectedProvider) reject("usage");
    const accountLabel = optionalString(record, "accountLabel", MAX_LABEL_CHARACTERS, "usage", budget, 1);
    const stale = optionalBoolean(record, "stale", "usage", budget, 1);
    return {
      provider,
      windows: projectedArray(record.get("windows"), MAX_USAGE_WINDOWS, "usage", budget, 1,
        (entry, depth) => usageWindow(entry, budget, depth)),
      ...(accountLabel === undefined ? {} : { accountLabel }),
      source: enumString(record, "source", ["provider-command", "provider-rpc"] as const, "usage", budget, 1),
      fetchedAt: requiredString(record, "fetchedAt", MAX_IDENTIFIER_CHARACTERS, "usage", budget, 1),
      ...(stale === undefined ? {} : { stale }),
    };
  } catch {
    return reject("usage");
  }
}
