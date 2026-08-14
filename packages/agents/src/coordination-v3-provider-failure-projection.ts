import { publicProviderFailureSummary } from "@ponderosa/core";

export function publicActivationDeliveryError(input: {
  lastDeliveryError: string | null;
  providerFailureCategory?: string | null;
  hasProviderFailure?: boolean;
}): string | undefined {
  if (!input.lastDeliveryError) return undefined;
  if (input.providerFailureCategory || input.hasProviderFailure) {
    return publicProviderFailureSummary(
      undefined,
      input.providerFailureCategory ?? "unknown",
    ) ?? "Provider execution failed.";
  }
  return input.lastDeliveryError;
}
