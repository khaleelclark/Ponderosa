import {
  publicProviderFailure,
  publicProviderFailureCategorySummary,
  publicProviderFailureSummary,
  type ProviderFailureCategory,
} from "@ponderosa/core";
import { guardedProviderExceptionStringProperty } from "./provider-exception-properties.js";

export const publicProviderAvailabilityDetail = publicProviderFailureSummary;
export { publicProviderFailureCategorySummary };

export interface PublicProviderErrorResponse {
  error: string;
  category: "provider_error";
  remediation: string;
}

export function publicProviderExceptionResponse(
  error: unknown,
  category?: ProviderFailureCategory,
): PublicProviderErrorResponse {
  const detail = guardedProviderExceptionStringProperty(error, "message");
  const failure = publicProviderFailure({ detail, category });
  return { error: failure.summary, category: "provider_error", remediation: failure.remediation };
}

export function providerUnavailableNotificationBody(
  detail: string | undefined,
  category?: ProviderFailureCategory,
): string {
  const failure = publicProviderFailure({ detail, category });
  return `${failure.summary} ${failure.remediation} Queued work is held until access is explicitly rechecked or a successful authorized Run proves recovery.`;
}
