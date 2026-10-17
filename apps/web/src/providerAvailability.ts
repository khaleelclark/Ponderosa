import {
  classifyProviderFailure,
  publicProviderFailure,
  type EngineDto,
  type ProviderFailureCategory,
} from "@ponderosa/core";

function providerAvailabilityCategory(
  detail: string | undefined,
  structuredCategory: ProviderFailureCategory | undefined,
): ProviderFailureCategory {
  return classifyProviderFailure(detail ?? "", structuredCategory);
}

export function providerAvailabilityMessage(
  engine: Pick<EngineDto, "id" | "displayName" | "enabled" | "authentication" | "reachability" | "availabilityDetail" | "availabilityCategory" | "authDetail" | "resourceAdmission">,
): string {
  if (engine.enabled === false) {
    return `${engine.displayName} is disabled. Enable it in Settings or choose another provider.`;
  }
  if (engine.resourceAdmission?.state === "held") return `${engine.displayName} is waiting for host resources. Accepted work remains queued and will resume automatically when headroom recovers.`;
  if (engine.authentication === "checking" || engine.reachability === "checking") {
    return `${engine.displayName} availability is still being checked.`;
  }
  if (engine.authentication === "unauthenticated") {
    return `${engine.displayName} is not signed in. Sign in on this host, then refresh provider status.`;
  }
  if (engine.authentication === "error") {
    return `${engine.displayName} sign-in status could not be checked. Verify its CLI is available on this host, then refresh provider status.`;
  }
  const detail = engine.availabilityDetail ?? engine.authDetail;
  const category = providerAvailabilityCategory(detail, engine.availabilityCategory);
  const failure = publicProviderFailure({ detail, category });
  return `${engine.displayName} access is unavailable. ${failure.remediation}`;
}
