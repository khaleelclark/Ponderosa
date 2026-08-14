const EXCEPTION_PROPERTY_TARGET_TYPES = new Set(["function", "object"]);

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
    const value = Reflect.get(error as object, property);
    return typeof value === "string" ? value : undefined;
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
