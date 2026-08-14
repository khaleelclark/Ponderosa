import {
  publicProviderFailureCategorySummary,
  publicProviderFailureSummary,
} from "@ponderosa/core";

export const publicProviderAvailabilityDetail = publicProviderFailureSummary;
export { publicProviderFailureCategorySummary };

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
