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
