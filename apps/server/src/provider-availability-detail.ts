import {
  publicProviderFailureCategorySummary,
  publicProviderFailureSummary,
} from "@ponderosa/core";

export const publicProviderAvailabilityDetail = publicProviderFailureSummary;
export { publicProviderFailureCategorySummary };

export function providerUnavailableNotificationBody(detail: string | undefined): string {
  const safeDetail = publicProviderFailureSummary(detail)
    ?? publicProviderFailureCategorySummary(detail);
  return `${safeDetail ?? "The provider rejected runtime access."} Queued work is held until access is explicitly rechecked or a successful authorized Run proves recovery.`;
}
