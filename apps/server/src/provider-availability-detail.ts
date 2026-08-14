import { publicProviderFailureSummary } from "@ponderosa/core";
import { classifyProviderFailure } from "@ponderosa/engines";

export const publicProviderAvailabilityDetail = publicProviderFailureSummary;

export function publicProviderFailureCategorySummary(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const kind = classifyProviderFailure(detail);
  if (kind === "authentication" || /subscription (?:expired|inactive)/iu.test(detail)) {
    return "Provider authentication was rejected.";
  }
  if (kind === "rate_limit") return "Provider usage limit was reached.";
  if (kind === "capacity") return "Provider is temporarily at capacity.";
  return undefined;
}

export interface PublicProviderErrorResponse {
  error: string;
  category: "provider_error";
  remediation: string;
}

export function publicProviderExceptionResponse(
  error: unknown,
  fallback = "Provider runtime information could not be read.",
): PublicProviderErrorResponse {
  const detail = error instanceof Error ? error.message : undefined;
  const summary = publicProviderFailureCategorySummary(detail) ?? fallback;
  const remediation = summary === "Provider authentication was rejected."
    ? "Check the provider subscription and sign-in, then retry."
    : summary === "Provider usage limit was reached."
      ? "Wait for the provider usage limit to reset, then retry."
      : summary === "Provider is temporarily at capacity."
        ? "Retry when provider capacity is available."
        : "Review the restricted server logs, then retry the provider operation.";
  return { error: summary, category: "provider_error", remediation };
}

export function providerUnavailableNotificationBody(detail: string | undefined): string {
  const safeDetail = publicProviderFailureSummary(detail)
    ?? publicProviderFailureCategorySummary(detail);
  return `${safeDetail ?? "The provider rejected runtime access."} Queued work is held until access is explicitly rechecked or a successful authorized Run proves recovery.`;
}
