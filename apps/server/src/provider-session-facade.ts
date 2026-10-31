import { canonicalProviderFailureEvent, redactProviderDiagnostic } from "./provider-failure-event.js";
import { isProxy } from "node:util/types";
import {
  classifyProviderFailure,
  publicProviderFailure,
  type AgentEvent,
  type RuntimeProcessIdentity,
  type RuntimeProcessHandle,
  type RuntimeSession,
  type ProviderRootExitDetail,
} from "@ponderosa/core";
import { projectAgentEvent, preserveEngineSessionRecoverySignal } from "@ponderosa/engines";
import { guardedProviderExceptionStringProperty } from "./provider-exception-properties.js";
import {
  projectProviderCapabilities,
  projectProviderCommandResult,
  projectProviderContextUsage,
  projectProviderSessionIdentifier,
  projectProviderSteerResult,
} from "./provider-success-projection.js";

const INVALID_PROVIDER_STRUCTURE = "Provider returned invalid structured data.";
const MAX_PROTOTYPE_DEPTH = 12;
const MAX_RATE_LIMIT_LINES = 100;
const MAX_RATE_LIMIT_LINE_CHARACTERS = 1_024;
const UNSAFE_IDENTITY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const providerBoundaryErrors = new WeakSet<object>();
const providerCleanupFailures = new WeakMap<object, ProviderRuntimeBoundaryError>();

type PropertyKeyLike = string | symbol;

function target(value: unknown): object {
  if (value === null || typeof value !== "object") {
    throw new Error(INVALID_PROVIDER_STRUCTURE);
  }
  try {
    if (isProxy(value as object)) throw new Error(INVALID_PROVIDER_STRUCTURE);
  } catch {
    throw new Error(INVALID_PROVIDER_STRUCTURE);
  }
  return value as object;
}

/** Resolve a member only through data descriptors. Provider getters and Proxy
 * traps never run. Prototype methods remain valid because every traversed
 * prototype is independently proven non-Proxy and only its own descriptor is
 * inspected. */
function dataMember(value: unknown, property: PropertyKeyLike): unknown {
  let cursor: object | null = target(value);
  try {
    for (let depth = 0; cursor && depth < MAX_PROTOTYPE_DEPTH; depth += 1) {
      if (isProxy(cursor)) throw new Error(INVALID_PROVIDER_STRUCTURE);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        if (!("value" in descriptor)) throw new Error(INVALID_PROVIDER_STRUCTURE);
        return descriptor.value;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    throw new Error(INVALID_PROVIDER_STRUCTURE);
  }
  return undefined;
}

function method(value: unknown, property: PropertyKeyLike, required = true): ((...args: unknown[]) => unknown) | undefined {
  const candidate = dataMember(value, property);
  if (candidate === undefined && !required) return undefined;
  if (typeof candidate !== "function") throw new Error(INVALID_PROVIDER_STRUCTURE);
  return candidate as (...args: unknown[]) => unknown;
}

function plainIteratorResult(value: unknown): {
  done: boolean;
  value?: unknown;
} {
  const record = target(value);
  try {
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => key !== "done" && key !== "value")) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const doneDescriptor = Object.getOwnPropertyDescriptor(record, "done");
    const valueDescriptor = Object.getOwnPropertyDescriptor(record, "value");
    if (!doneDescriptor || !("value" in doneDescriptor) || typeof doneDescriptor.value !== "boolean") {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    if (valueDescriptor && !("value" in valueDescriptor)) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    if (!doneDescriptor.value && !valueDescriptor) throw new Error(INVALID_PROVIDER_STRUCTURE);
    return {
      done: doneDescriptor.value,
      ...(valueDescriptor ? { value: valueDescriptor.value } : {}),
    };
  } catch {
    throw new Error(INVALID_PROVIDER_STRUCTURE);
  }
}

function turnStartResult(value: unknown): { turnId: string } {
  const record = target(value);
  try {
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null ||
        Reflect.ownKeys(record).some((key) => key !== "turnId")) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const turnId = dataMember(record, "turnId");
    return { turnId: projectProviderSessionIdentifier(turnId) };
  } catch {
    throw new Error(INVALID_PROVIDER_STRUCTURE);
  }
}

function rateLimitLines(value: unknown): string[] {
  const array = target(value);
  try {
    if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const length = dataMember(array, "length");
    if (!Number.isSafeInteger(length) || (length as number) < 0 ||
        (length as number) > MAX_RATE_LIMIT_LINES) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const keys = Reflect.ownKeys(array);
    if (keys.length !== (length as number) + 1 || !keys.includes("length")) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const result: string[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" ||
          descriptor.value.length > MAX_RATE_LIMIT_LINE_CHARACTERS ||
          UNSAFE_IDENTITY_CONTROL.test(descriptor.value)) {
        throw new Error(INVALID_PROVIDER_STRUCTURE);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    throw new Error(INVALID_PROVIDER_STRUCTURE);
  }
}

function processIdentity(value: unknown): RuntimeProcessIdentity | undefined {
  if (value === undefined) return undefined;
  const record = target(value);
  try {
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(INVALID_PROVIDER_STRUCTURE);
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => key !== "pid" && key !== "pgid" && key !== "birthMarker" && key !== "scope")) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const pid = dataMember(record, "pid");
    const pgid = dataMember(record, "pgid");
    const birthMarker = dataMember(record, "birthMarker");
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 ||
        !Number.isSafeInteger(pgid) || (pgid as number) <= 0 ||
        typeof birthMarker !== "string" || birthMarker.length === 0 ||
        birthMarker.length > 512 || UNSAFE_IDENTITY_CONTROL.test(birthMarker)) {
      throw new Error(INVALID_PROVIDER_STRUCTURE);
    }
    const scope = dataMember(record, "scope");
    let scopeIdentity: RuntimeProcessIdentity["scope"];
    if (scope !== undefined) {
      const scoped = target(scope);
      if (![Object.prototype, null].includes(Object.getPrototypeOf(scoped)) || Reflect.ownKeys(scoped).some(key => key !== "unit" && key !== "authorityId")) throw Error(INVALID_PROVIDER_STRUCTURE);
      const unit = dataMember(scoped, "unit"), authorityId = dataMember(scoped, "authorityId");
      if (typeof unit !== "string" || !/^ponderosa-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.scope$/u.test(unit) || typeof authorityId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(authorityId)) throw Error(INVALID_PROVIDER_STRUCTURE);
      scopeIdentity = { unit, authorityId };
    }
    return { pid: pid as number, pgid: pgid as number, birthMarker, ...(scopeIdentity ? { scope: scopeIdentity } : {}) };
  } catch {
    throw new Error(INVALID_PROVIDER_STRUCTURE);
  }
}

export class ProviderRuntimeBoundaryError extends Error {
  readonly operation: string;
  readonly restrictedDetail: string;
  readonly code?: string;
  readonly category: ReturnType<typeof classifyProviderFailure>;

  constructor(operation: string, cause: unknown) {
    const detail = guardedProviderExceptionStringProperty(cause, "message")
      ?? "provider exception detail was not safely readable";
    const code = guardedProviderExceptionStringProperty(cause, "code")
      ?? guardedProviderExceptionStringProperty(cause, "errorCode");
    const categories = [
      guardedProviderExceptionStringProperty(cause, "category"),
      guardedProviderExceptionStringProperty(cause, "failureCategory"),
      code,
    ];
    const category = categories
      .map((candidate) => classifyProviderFailure("", candidate))
      .find((candidate) => candidate !== "unknown")
      ?? classifyProviderFailure(detail);
    const publicFailure = publicProviderFailure({ detail, category, code });
    super(publicFailure.summary);
    this.name = "ProviderRuntimeBoundaryError";
    this.operation = operation;
    this.restrictedDetail = redactProviderDiagnostic(detail);
    this.code = code;
    this.category = category;
    providerBoundaryErrors.add(this);
  }
}

export function isProviderRuntimeBoundaryError(
  value: unknown,
): value is ProviderRuntimeBoundaryError {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? providerBoundaryErrors.has(value as object)
    : false;
}

/** Consume a secondary provider cleanup failure retained against the primary
 * boundary error. The primary classification and remediation remain the
 * canonical failure; this secondary evidence is restricted to server logs. */
export function takeProviderRuntimeCleanupFailure(
  value: unknown,
): ProviderRuntimeBoundaryError | undefined {
  if (!isProviderRuntimeBoundaryError(value)) return undefined;
  const cleanupFailure = providerCleanupFailures.get(value);
  if (cleanupFailure) providerCleanupFailures.delete(value);
  return cleanupFailure;
}

function boundaryError(operation: string, error: unknown): ProviderRuntimeBoundaryError {
  return isProviderRuntimeBoundaryError(error)
    ? error
    : new ProviderRuntimeBoundaryError(operation, error);
}

export async function providerRuntimeOperation<T>(
  operation: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    throw boundaryError(operation, error);
  }
}

export function providerRuntimeValue<T>(operation: string, callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    throw boundaryError(operation, error);
  }
}

/** Wrap one provider event source before its iterator or IteratorResult fields
 * are inspected. Every yielded value is projected to the canonical AgentEvent
 * schema inside this boundary. */
export function providerEventStream(
  source: unknown,
  operation = "read provider event stream",
): AsyncIterable<AgentEvent> {
  let sourceTarget: object;
  let iteratorFactory: ((...args: unknown[]) => unknown) | undefined;
  try {
    sourceTarget = target(source);
    iteratorFactory = method(sourceTarget, Symbol.asyncIterator);
  } catch (error) {
    throw boundaryError(operation, error);
  }
  return Object.freeze({
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      let iterator: object;
      let next: (...args: unknown[]) => unknown;
      let finish: ((...args: unknown[]) => unknown) | undefined;
      try {
        iterator = target(Reflect.apply(iteratorFactory!, sourceTarget, []));
        next = method(iterator, "next")!;
        finish = method(iterator, "return", false);
      } catch (error) {
        throw boundaryError(operation, error);
      }
      let naturallyExhausted = false;
      let primaryFailure: ProviderRuntimeBoundaryError | undefined;
      try {
        while (true) {
          const rawResult = await providerRuntimeOperation(operation, () => Reflect.apply(next, iterator, []));
          let result: ReturnType<typeof plainIteratorResult>;
          try {
            result = plainIteratorResult(rawResult);
          } catch (error) {
            throw boundaryError(operation, error);
          }
          if (result.done) {
            naturallyExhausted = true;
            return;
          }
          try {
            const event = projectAgentEvent(result.value);
            yield event.type === "error"
              ? preserveEngineSessionRecoverySignal(event, canonicalProviderFailureEvent(event))
              : event;
          } catch (error) {
            throw boundaryError("project provider event", error);
          }
        }
      } catch (error) {
        primaryFailure = boundaryError(operation, error);
        throw primaryFailure;
      } finally {
        if (finish && !naturallyExhausted) {
          try {
            await providerRuntimeOperation(
              `${operation} cleanup`,
              () => Reflect.apply(finish!, iterator, []),
            );
          } catch (error) {
            const cleanupFailure = boundaryError(`${operation} cleanup`, error);
            if (!primaryFailure) throw cleanupFailure;
            providerCleanupFailures.set(primaryFailure, cleanupFailure);
          }
        }
      }
    },
  });
}

/** Copy root-exit observations through the same closed provider boundary as
 * streamed events. Accessors/proxies cannot smuggle terminal authority. */
export function projectProviderRootExitDetail(value: unknown): ProviderRootExitDetail | undefined {
  if (value === undefined) return undefined;
  const raw = target(value);
  const detail: ProviderRootExitDetail = {};
  for (const key of ["exitCode", "signal", "stderr", "outputDraining", "terminalEvent"] as const) {
    const member = dataMember(raw, key);
    if (member === undefined) continue;
    if (key === "exitCode") {
      if (member !== null && (typeof member !== "number" || !Number.isSafeInteger(member))) throw new Error(INVALID_PROVIDER_STRUCTURE);
      detail.exitCode = member as number | null;
    } else if (key === "signal") {
      if (member !== null && (typeof member !== "string" || member.length > 64)) throw new Error(INVALID_PROVIDER_STRUCTURE);
      detail.signal = member as string | null;
    } else if (key === "stderr") {
      if (typeof member !== "string" || member.length > 8192) throw new Error(INVALID_PROVIDER_STRUCTURE);
      detail.stderr = redactProviderDiagnostic(member);
    } else if (key === "outputDraining") {
      if (typeof member !== "boolean") throw new Error(INVALID_PROVIDER_STRUCTURE);
      detail.outputDraining = member;
    } else {
      const event = projectAgentEvent(member);
      if (event.type !== "error") throw new Error(INVALID_PROVIDER_STRUCTURE);
      detail.terminalEvent = preserveEngineSessionRecoverySignal(event, canonicalProviderFailureEvent(event));
    }
  }
  return detail;
}

/** Copy a provider-returned RuntimeSession into one closed, code-owned facade.
 * Downstream consumers can use ordinary property access only on this facade;
 * all provider members were captured through non-Proxy data descriptors. */
export function providerSessionFacade(value: unknown): RuntimeSession {
  let raw: object;
  let engineAgentId: string;
  let events: AsyncIterable<AgentEvent>;
  let identity: RuntimeProcessIdentity | undefined;
  let validatesResumeBeforeTurn: boolean | undefined;
  let isAliveMethod: (...args: unknown[]) => unknown;
  let closeMethod: (...args: unknown[]) => unknown;
  let startTurnMethod: (...args: unknown[]) => unknown;
  let steerMethod: (...args: unknown[]) => unknown;
  let interruptMethod: (...args: unknown[]) => unknown;
  let contextUsageMethod: ((...args: unknown[]) => unknown) | undefined;
  let rateLimitStatusMethod: ((...args: unknown[]) => unknown) | undefined;
  let capabilitiesMethod: ((...args: unknown[]) => unknown) | undefined;
  let invokeCommandMethod: ((...args: unknown[]) => unknown) | undefined;
  try {
    raw = target(value);
    engineAgentId = projectProviderSessionIdentifier(dataMember(raw, "engineAgentId"));
    identity = processIdentity(dataMember(raw, "processIdentity"));
    events = providerEventStream(dataMember(raw, "events"));
    const validation = dataMember(raw, "validatesResumeBeforeTurn");
    if (validation !== undefined && typeof validation !== "boolean") throw new Error(INVALID_PROVIDER_STRUCTURE);
    validatesResumeBeforeTurn = validation as boolean | undefined;
    isAliveMethod = method(raw, "isAlive")!;
    closeMethod = method(raw, "close")!;
    startTurnMethod = method(raw, "startTurn")!;
    steerMethod = method(raw, "steer")!;
    interruptMethod = method(raw, "interrupt")!;
    contextUsageMethod = method(raw, "contextUsage", false);
    rateLimitStatusMethod = method(raw, "rateLimitStatus", false);
    capabilitiesMethod = method(raw, "capabilities", false);
    invokeCommandMethod = method(raw, "invokeCommand", false);
  } catch (error) {
    throw boundaryError("project provider session", error);
  }

  const facade: RuntimeSession = {
    engineAgentId,
    events,
    ...(validatesResumeBeforeTurn !== undefined ? { validatesResumeBeforeTurn } : {}),
    ...(identity ? { processIdentity: identity } : {}),
    isAlive(): boolean {
      let alive: unknown;
      try { alive = Reflect.apply(isAliveMethod, raw, []); }
      catch (error) { throw boundaryError("read provider session liveness", error); }
      if (typeof alive !== "boolean") throw boundaryError("read provider session liveness", new Error(INVALID_PROVIDER_STRUCTURE));
      return alive;
    },
    close: async () => { await providerRuntimeOperation("close provider session", () => Reflect.apply(closeMethod, raw, [])); },
    startTurn: async (input) => {
      const value = await providerRuntimeOperation(
        "start provider turn",
        () => Reflect.apply(startTurnMethod, raw, [input]),
      );
      try { return turnStartResult(value); }
      catch (error) { throw boundaryError("project provider turn start", error); }
    },
    steer: async (input) => {
      const value = await providerRuntimeOperation(
        "steer provider turn",
        () => Reflect.apply(steerMethod, raw, [input]),
      );
      try { return projectProviderSteerResult(value); }
      catch (error) { throw boundaryError("project provider steering result", error); }
    },
    interrupt: async () => { await providerRuntimeOperation("interrupt provider session", () => Reflect.apply(interruptMethod, raw, [])); },
    ...(contextUsageMethod ? {
      contextUsage: () => {
        try {
          return projectProviderContextUsage(Reflect.apply(contextUsageMethod!, raw, []));
        }
        catch (error) { throw boundaryError("read provider context usage", error); }
      },
    } : {}),
    ...(rateLimitStatusMethod ? {
      rateLimitStatus: async () => {
        const value = await providerRuntimeOperation(
          "read provider rate limits",
          () => Reflect.apply(rateLimitStatusMethod!, raw, []),
        );
        try { return rateLimitLines(value); }
        catch (error) { throw boundaryError("project provider rate limits", error); }
      },
    } : {}),
    ...(capabilitiesMethod ? {
      capabilities: async () => {
        const value = await providerRuntimeOperation(
          "read provider capabilities",
          () => Reflect.apply(capabilitiesMethod!, raw, []),
        );
        try { return projectProviderCapabilities(value); }
        catch (error) { throw boundaryError("project provider capabilities", error); }
      },
    } : {}),
    ...(invokeCommandMethod ? {
      invokeCommand: async (name, argumentsText) => {
        const value = await providerRuntimeOperation(
          "invoke provider command",
          () => Reflect.apply(invokeCommandMethod!, raw, [name, argumentsText]),
        );
        try { return projectProviderCommandResult(value); }
        catch (error) { throw boundaryError("project provider command result", error); }
      },
    } : {}),
  };
  return Object.freeze(facade);
}

/** Descriptor-safe facade for spawn-time handles published before an adapter
 * finishes opening its RuntimeSession. */
export function providerProcessHandleFacade(value: unknown): RuntimeProcessHandle {
  let raw: object;
  let identity: RuntimeProcessIdentity | undefined;
  let isAliveMethod: (...args: unknown[]) => unknown;
  let closeMethod: (...args: unknown[]) => unknown;
  try {
    raw = target(value);
    identity = processIdentity(dataMember(raw, "processIdentity"));
    isAliveMethod = method(raw, "isAlive")!;
    closeMethod = method(raw, "close")!;
  } catch (error) {
    throw boundaryError("project provider process handle", error);
  }
  return Object.freeze({
    ...(identity ? { processIdentity: identity } : {}),
    isAlive(): boolean {
      let alive: unknown;
      try { alive = Reflect.apply(isAliveMethod, raw, []); }
      catch (error) { throw boundaryError("read provider process liveness", error); }
      if (typeof alive !== "boolean") throw boundaryError("read provider process liveness", new Error(INVALID_PROVIDER_STRUCTURE));
      return alive;
    },
    close: async () => { await providerRuntimeOperation("close provider process", () => Reflect.apply(closeMethod, raw, [])); },
  });
}
