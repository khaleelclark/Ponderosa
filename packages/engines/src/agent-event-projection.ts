import type {
  AgentEvent,
  ProviderErrorCode,
  ProviderFailureCategory,
  TokenUsage,
  ToolFailureCategory,
} from "@ponderosa/core";
import { isProxy } from "node:util/types";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 16;
const MAX_ROWS = 10_000;
const MAX_IDENTIFIER = 1_024;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u;

const ERROR_CODES = [
  "invalid_model", "model_not_found", "authentication_failed", "rate_limit", "capacity",
  "context_length", "organization_policy", "plan_entitlement", "network", "provider_error",
] as const satisfies readonly ProviderErrorCode[];
const FAILURE_CATEGORIES = [
  "authentication", "rate_limit", "capacity", "context_length", "invalid_request",
  "unavailable", "unknown",
] as const satisfies readonly ProviderFailureCategory[];
const TOOL_FAILURE_CATEGORIES = [
  "operation_not_provided", "temporary_connection_failure", "authentication_required",
  "permission_denied", "invalid_input", "permanent_failure",
] as const satisfies readonly ToolFailureCategory[];

export class AgentEventProjectionError extends Error {
  readonly code = "invalid_agent_event";

  constructor() {
    super("Provider returned an invalid runtime event.");
    this.name = "AgentEventProjectionError";
  }
}

function reject(): never {
  throw new AgentEventProjectionError();
}

function encodedStringBytes(value: string): number {
  let bytes = Buffer.byteLength(value, "utf8") + 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x09 || code === 0x0a || code === 0x0d) bytes += 1;
  }
  return bytes;
}

class Budget {
  private bytes = 0;
  private nodes = 0;

  node(depth: number, overhead = 32): void {
    this.nodes += 1;
    this.bytes += overhead;
    if (this.nodes > MAX_NODES || depth > MAX_DEPTH || this.bytes > MAX_BYTES) reject();
  }

  string(value: string, depth: number): void {
    this.node(depth, 0);
    this.bytes += encodedStringBytes(value);
    if (this.bytes > MAX_BYTES) reject();
  }
}

type DataRecord = Map<string, unknown>;

function record(value: unknown, allowed: readonly string[], budget: Budget, depth: number): DataRecord {
  try {
    budget.node(depth);
    if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) reject();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) reject();
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length) reject();
    const allowedSet = new Set(allowed);
    const result = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== "string" || !allowedSet.has(key)) reject();
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) reject();
      result.set(key, descriptor.value);
    }
    return result;
  } catch {
    return reject();
  }
}

function array<T>(
  value: unknown,
  budget: Budget,
  depth: number,
  project: (entry: unknown, depth: number) => T,
  maxRows = MAX_ROWS,
): T[] {
  try {
    budget.node(depth);
    if (!Array.isArray(value) || isProxy(value) || Reflect.getPrototypeOf(value) !== Array.prototype) reject();
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maxRows) reject();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) reject();
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) reject();
      result.push(project(descriptor.value, depth + 1));
    }
    return result;
  } catch {
    return reject();
  }
}

function string(record: DataRecord, key: string, budget: Budget, depth: number, max = MAX_BYTES): string {
  const value = record.get(key);
  if (typeof value !== "string" || value.length > max || UNSAFE_CONTROL.test(value)) reject();
  budget.string(value, depth);
  return value;
}

function optionalString(record: DataRecord, key: string, budget: Budget, depth: number, max = MAX_BYTES): string | undefined {
  return !record.has(key) || record.get(key) === undefined ? undefined : string(record, key, budget, depth, max);
}

function identifier(record: DataRecord, key: string, budget: Budget, depth: number): string {
  const value = string(record, key, budget, depth, MAX_IDENTIFIER);
  if (!SAFE_IDENTIFIER.test(value)) reject();
  return value;
}

function optionalIdentifier(record: DataRecord, key: string, budget: Budget, depth: number): string | undefined {
  return !record.has(key) || record.get(key) === undefined ? undefined : identifier(record, key, budget, depth);
}

function boolean(record: DataRecord, key: string, budget: Budget, depth: number): boolean {
  const value = record.get(key);
  if (typeof value !== "boolean") reject();
  budget.node(depth);
  return value;
}

function optionalBoolean(record: DataRecord, key: string, budget: Budget, depth: number): boolean | undefined {
  return !record.has(key) || record.get(key) === undefined ? undefined : boolean(record, key, budget, depth);
}

function integer(record: DataRecord, key: string, budget: Budget, depth: number, minimum = 0): number {
  const value = record.get(key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) reject();
  budget.node(depth);
  return value;
}

function optionalInteger(record: DataRecord, key: string, budget: Budget, depth: number, minimum = 0): number | undefined {
  return !record.has(key) || record.get(key) === undefined ? undefined : integer(record, key, budget, depth, minimum);
}

function enumeration<T extends string>(
  record: DataRecord,
  key: string,
  values: readonly T[],
  budget: Budget,
  depth: number,
): T {
  const value = string(record, key, budget, depth, MAX_IDENTIFIER);
  if (!values.includes(value as T)) reject();
  return value as T;
}

function optionalEnumeration<T extends string>(
  record: DataRecord,
  key: string,
  values: readonly T[],
  budget: Budget,
  depth: number,
): T | undefined {
  return !record.has(key) || record.get(key) === undefined
    ? undefined
    : enumeration(record, key, values, budget, depth);
}

function jsonValue(value: unknown, budget: Budget, depth: number): unknown {
  if (value === null || typeof value === "boolean") {
    budget.node(depth);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject();
    budget.node(depth);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_BYTES || UNSAFE_CONTROL.test(value)) reject();
    budget.string(value, depth);
    return value;
  }
  if (Array.isArray(value)) return array(value, budget, depth, (entry, next) => jsonValue(entry, budget, next));
  if (value === null || typeof value !== "object") reject();
  try {
    budget.node(depth);
    if (isProxy(value)) reject();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) reject();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_ROWS) reject();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || key.length > MAX_IDENTIFIER || UNSAFE_CONTROL.test(key)) reject();
      budget.string(key, depth + 1);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) reject();
      Object.defineProperty(result, key, {
        value: jsonValue(descriptor.value, budget, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } catch {
    return reject();
  }
}

const USAGE_KEYS = [
  "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
  "reasoningOutputTokens", "totalTokens",
] as const;

function usage(value: unknown, budget: Budget, depth: number): TokenUsage {
  const source = record(value, USAGE_KEYS, budget, depth);
  const result: TokenUsage = {};
  for (const key of USAGE_KEYS) {
    const projected = optionalInteger(source, key, budget, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  const cachedInputTokens = result.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = result.cacheWriteInputTokens ?? 0;
  if (result.cachedInputTokens !== undefined || result.cacheWriteInputTokens !== undefined) {
    if (result.inputTokens === undefined) reject();
    const cachedTotal = cachedInputTokens + cacheWriteInputTokens;
    if (!Number.isSafeInteger(cachedTotal) || cachedTotal > result.inputTokens) reject();
  }
  if (result.reasoningOutputTokens !== undefined &&
      (result.outputTokens === undefined || result.reasoningOutputTokens > result.outputTokens)) reject();
  if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
    const computedTotal = result.inputTokens + result.outputTokens;
    if (!Number.isSafeInteger(computedTotal) ||
        (result.totalTokens !== undefined && result.totalTokens !== computedTotal)) reject();
  } else if (result.totalTokens !== undefined &&
      (result.inputTokens !== undefined && result.totalTokens < result.inputTokens ||
       result.outputTokens !== undefined && result.totalTokens < result.outputTokens)) reject();
  return result;
}

function exact(value: unknown, keys: readonly string[], budget: Budget): DataRecord {
  return record(value, ["type", ...keys], budget, 1);
}

/**
 * Build one accessor-free, closed AgentEvent immediately after an adapter
 * iterator yields. No provider-owned property may be inspected before this
 * boundary. Invalid events fail closed before persistence or scheduler use.
 */
export function projectAgentEvent(value: unknown): AgentEvent {
  const budget = new Budget();
  const envelope = record(value, ["type", ...new Set([
    "sessionId", "providerSessionId", "providerSessionGeneration", "usedTokens", "aggregateTokens", "windowTokens",
    "executionId", "rolloverId", "lowWaterMark", "seedPromptUtf8Bytes", "contextSections",
    "previousProviderSessionId", "replacementProviderSessionId", "startingOccupancy", "delta", "id", "name", "input",
    "output", "isError", "failureCategory", "retryable", "command", "cwd", "callId", "path", "kind", "diff", "passed", "summary", "status",
    "controlOwner", "controlEpoch", "url", "title", "reason", "actor", "action", "level", "text", "artifactId",
    "width", "height", "size", "sha256", "workItemId", "usage", "providerRequestUsage", "message", "code",
    "category", "remediation",
  ])], budget, 0);
  const type = enumeration(envelope, "type", [
    "session", "context_usage", "context_rollover_seed_overflow", "context_rollover_completed", "text", "reasoning",
    "tool_call", "tool_result", "command", "file_change", "test_result", "browser_session", "browser_action",
    "browser_console", "browser_screenshot", "work_item_update", "turn_done", "error",
  ] as const, budget, 1);

  switch (type) {
    case "session": {
      const row = exact(value, ["sessionId"], budget);
      return { type, sessionId: identifier(row, "sessionId", budget, 2) };
    }
    case "context_usage": {
      const row = exact(value, ["providerSessionId", "providerSessionGeneration", "usedTokens", "aggregateTokens", "windowTokens"], budget);
      const aggregateTokens = optionalInteger(row, "aggregateTokens", budget, 2);
      const windowTokens = optionalInteger(row, "windowTokens", budget, 2, 1);
      return {
        type,
        providerSessionId: identifier(row, "providerSessionId", budget, 2),
        providerSessionGeneration: identifier(row, "providerSessionGeneration", budget, 2),
        usedTokens: integer(row, "usedTokens", budget, 2),
        ...(aggregateTokens === undefined ? {} : { aggregateTokens }),
        ...(windowTokens === undefined ? {} : { windowTokens }),
      };
    }
    case "context_rollover_seed_overflow": {
      const row = exact(value, ["executionId", "rolloverId", "usedTokens", "lowWaterMark", "seedPromptUtf8Bytes", "contextSections"], budget);
      return {
        type,
        executionId: identifier(row, "executionId", budget, 2),
        rolloverId: identifier(row, "rolloverId", budget, 2),
        usedTokens: integer(row, "usedTokens", budget, 2),
        lowWaterMark: integer(row, "lowWaterMark", budget, 2),
        seedPromptUtf8Bytes: integer(row, "seedPromptUtf8Bytes", budget, 2),
        contextSections: array(row.get("contextSections"), budget, 2, (entry, depth) => {
          const section = record(entry, ["kind", "count"], budget, depth);
          return { kind: identifier(section, "kind", budget, depth + 1), count: integer(section, "count", budget, depth + 1) };
        }, 1_000),
      };
    }
    case "context_rollover_completed": {
      const row = exact(value, ["executionId", "rolloverId", "previousProviderSessionId", "replacementProviderSessionId", "startingOccupancy"], budget);
      return {
        type,
        executionId: identifier(row, "executionId", budget, 2),
        rolloverId: identifier(row, "rolloverId", budget, 2),
        previousProviderSessionId: identifier(row, "previousProviderSessionId", budget, 2),
        replacementProviderSessionId: identifier(row, "replacementProviderSessionId", budget, 2),
        startingOccupancy: integer(row, "startingOccupancy", budget, 2),
      };
    }
    case "text":
    case "reasoning": {
      const row = exact(value, ["delta"], budget);
      return { type, delta: string(row, "delta", budget, 2) };
    }
    case "tool_call": {
      const row = exact(value, ["id", "name", "input"], budget);
      return { type, id: identifier(row, "id", budget, 2), name: identifier(row, "name", budget, 2), input: jsonValue(row.get("input"), budget, 2) };
    }
    case "tool_result": {
      const row = exact(value, ["id", "output", "isError", "failureCategory", "retryable"], budget);
      const isError = optionalBoolean(row, "isError", budget, 2);
      const hasFailureCategory = row.has("failureCategory");
      const hasRetryable = row.has("retryable");
      if (hasFailureCategory !== hasRetryable) reject();
      const failureCategory = hasFailureCategory
        ? enumeration(row, "failureCategory", TOOL_FAILURE_CATEGORIES, budget, 2)
        : undefined;
      const retryable = hasRetryable ? boolean(row, "retryable", budget, 2) : undefined;
      if (failureCategory !== undefined && isError !== true) reject();
      return {
        type,
        id: identifier(row, "id", budget, 2),
        output: string(row, "output", budget, 2),
        ...(isError === undefined ? {} : { isError }),
        ...(failureCategory === undefined ? {} : { failureCategory, retryable: retryable! }),
      };
    }
    case "command": {
      const row = exact(value, ["command", "cwd", "callId"], budget);
      const callId = optionalIdentifier(row, "callId", budget, 2);
      return { type, command: string(row, "command", budget, 2), cwd: string(row, "cwd", budget, 2), ...(callId === undefined ? {} : { callId }) };
    }
    case "file_change": {
      const row = exact(value, ["path", "kind", "diff", "callId"], budget);
      const diff = optionalString(row, "diff", budget, 2);
      const callId = optionalIdentifier(row, "callId", budget, 2);
      return { type, path: string(row, "path", budget, 2), kind: enumeration(row, "kind", ["create", "edit", "delete"] as const, budget, 2), ...(diff === undefined ? {} : { diff }), ...(callId === undefined ? {} : { callId }) };
    }
    case "test_result": {
      const row = exact(value, ["passed", "summary"], budget);
      return { type, passed: boolean(row, "passed", budget, 2), summary: string(row, "summary", budget, 2) };
    }
    case "browser_session": {
      const row = exact(value, ["sessionId", "executionId", "status", "controlOwner", "controlEpoch", "url", "title", "reason"], budget);
      const url = optionalString(row, "url", budget, 2);
      const title = optionalString(row, "title", budget, 2);
      const reason = optionalString(row, "reason", budget, 2);
      return { type, sessionId: identifier(row, "sessionId", budget, 2), executionId: identifier(row, "executionId", budget, 2), status: enumeration(row, "status", ["opening", "ready", "closed", "failed"] as const, budget, 2), controlOwner: enumeration(row, "controlOwner", ["agent", "operator"] as const, budget, 2), controlEpoch: integer(row, "controlEpoch", budget, 2), ...(url === undefined ? {} : { url }), ...(title === undefined ? {} : { title }), ...(reason === undefined ? {} : { reason }) };
    }
    case "browser_action": {
      const row = exact(value, ["sessionId", "executionId", "actor", "action", "summary", "url"], budget);
      const url = optionalString(row, "url", budget, 2);
      return { type, sessionId: identifier(row, "sessionId", budget, 2), executionId: identifier(row, "executionId", budget, 2), actor: enumeration(row, "actor", ["agent", "operator"] as const, budget, 2), action: enumeration(row, "action", ["navigate", "click", "type", "key", "scroll", "inspect", "control"] as const, budget, 2), summary: string(row, "summary", budget, 2), ...(url === undefined ? {} : { url }) };
    }
    case "browser_console": {
      const row = exact(value, ["sessionId", "executionId", "level", "text"], budget);
      return { type, sessionId: identifier(row, "sessionId", budget, 2), executionId: identifier(row, "executionId", budget, 2), level: enumeration(row, "level", ["log", "info", "warning", "error"] as const, budget, 2), text: string(row, "text", budget, 2) };
    }
    case "browser_screenshot": {
      const row = exact(value, ["sessionId", "executionId", "artifactId", "path", "width", "height", "size", "sha256"], budget);
      const sha256 = identifier(row, "sha256", budget, 2);
      if (!/^[a-f0-9]{64}$/u.test(sha256)) reject();
      return { type, sessionId: identifier(row, "sessionId", budget, 2), executionId: identifier(row, "executionId", budget, 2), artifactId: identifier(row, "artifactId", budget, 2), path: string(row, "path", budget, 2), width: integer(row, "width", budget, 2, 1), height: integer(row, "height", budget, 2, 1), size: integer(row, "size", budget, 2, 0), sha256 };
    }
    case "work_item_update": {
      const row = exact(value, ["workItemId", "status", "title", "executionId"], budget);
      const title = optionalString(row, "title", budget, 2);
      const executionId = optionalIdentifier(row, "executionId", budget, 2);
      return { type, workItemId: identifier(row, "workItemId", budget, 2), status: enumeration(row, "status", ["running", "waiting_approval", "done"] as const, budget, 2), ...(title === undefined ? {} : { title }), ...(executionId === undefined ? {} : { executionId }) };
    }
    case "turn_done": {
      const row = exact(value, ["usage", "providerRequestUsage"], budget);
      const projectedUsage = row.has("usage") && row.get("usage") !== undefined ? usage(row.get("usage"), budget, 2) : undefined;
      const requests = row.has("providerRequestUsage") && row.get("providerRequestUsage") !== undefined
        ? array(row.get("providerRequestUsage"), budget, 2, (entry, depth) => usage(entry, budget, depth), 1_000)
        : undefined;
      return { type, ...(projectedUsage === undefined ? {} : { usage: projectedUsage }), ...(requests === undefined ? {} : { providerRequestUsage: requests }) };
    }
    case "error": {
      const row = exact(value, ["message", "code", "category", "remediation"], budget);
      const code = optionalEnumeration(row, "code", ERROR_CODES, budget, 2);
      const category = optionalEnumeration(row, "category", FAILURE_CATEGORIES, budget, 2);
      const remediation = optionalString(row, "remediation", budget, 2);
      return { type, message: string(row, "message", budget, 2), ...(code === undefined ? {} : { code }), ...(category === undefined ? {} : { category }), ...(remediation === undefined ? {} : { remediation }) };
    }
  }
}
