import { isProxy } from "node:util/types";

const EXCEPTION_PROPERTY_TARGET_TYPES = new Set(["function", "object"]);
const MAX_EXCEPTION_PROPERTY_CHARACTERS = 8_192;
const UNSAFE_EXCEPTION_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/** Read one adapter exception field without trusting its prototype or traps. */
export function guardedProviderExceptionStringProperty(
  error: unknown,
  property:
    | "message"
    | "code"
    | "errorCode"
    | "category"
    | "failureCategory"
    | "restrictedDetail",
): string | undefined {
  if (error === null || !EXCEPTION_PROPERTY_TARGET_TYPES.has(typeof error)) return undefined;
  try {
    if (isProxy(error as object)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, property);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const value = descriptor.value;
    return typeof value === "string" &&
      value.length <= MAX_EXCEPTION_PROPERTY_CHARACTERS &&
      !UNSAFE_EXCEPTION_CONTROL.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve readable provider detail only for restricted internal logging. */
export function restrictedProviderExceptionLogDetail(error: unknown): string {
  return guardedProviderExceptionStringProperty(error, "restrictedDetail")
    ?? guardedProviderExceptionStringProperty(error, "message")
    ?? "provider exception detail was not safely readable";
}

interface InternalExceptionDiagnostic {
  kind: string; code?: string; frames: string[]; cause?: InternalExceptionDiagnostic;
}
/** Internal call sites and native error classes only; never exception text or input. */
export function restrictedInternalExceptionDiagnostic(error: unknown, depth = 0): InternalExceptionDiagnostic {
  const result: InternalExceptionDiagnostic = { kind: "Unknown", frames: [] };
  if (error === null || !EXCEPTION_PROPERTY_TARGET_TYPES.has(typeof error) || isProxy(error as object)) return result;
  try {
    const prototype = Object.getPrototypeOf(error);
    for (const type of [Error, TypeError, ReferenceError, RangeError, SyntaxError, URIError, EvalError]) {
      if (prototype === type.prototype) result.kind = type.name;
    }
    const code = guardedProviderExceptionStringProperty(error, "code");
    if (code && /^(?:ERR_|SQLITE_)[A-Z_]{1,50}$/u.test(code)) result.code = code;
    const stack = Object.getOwnPropertyDescriptor(error, "stack");
    if (stack && "value" in stack && typeof stack.value === "string" && stack.value.length <= 32_768) {
      const message=guardedProviderExceptionStringProperty(error,"message");
      const header=message===undefined?undefined:`${result.kind}: ${message}\n`;
      // Strip the entire message, including any forged call sites in its newlines.
      const frames=header&&stack.value.startsWith(header)?stack.value.slice(header.length):'';
      result.frames = frames.split("\n").slice(0, 16).flatMap((line: string) => {
        const frame = line.match(/(?:apps\/server|packages\/(?:agents|core|engines|native-host))\/(?:src|dist)\/[A-Za-z0-9_./-]{1,180}:\d{1,8}:\d{1,6}/u)?.[0];
        return frame ? [frame] : [];
      }).slice(0, 6);
    }
    const cause = Object.getOwnPropertyDescriptor(error, "cause");
    if (depth < 2 && cause && "value" in cause && cause.value !== error) {
      result.cause = restrictedInternalExceptionDiagnostic(cause.value, depth + 1);
    }
  } catch { /* Diagnostics must not replace the original failure. */ }
  return result;
}
