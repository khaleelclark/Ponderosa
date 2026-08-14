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

export function providerUnavailableNotificationBody(detail: string | undefined): string {
  const safeDetail = publicProviderFailureSummary(detail)
    ?? publicProviderFailureCategorySummary(detail);
  return `${safeDetail ?? "The provider rejected runtime access."} Queued work is held until access is explicitly rechecked or a successful authorized Run proves recovery.`;
}
