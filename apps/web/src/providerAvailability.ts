import {
  MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS,
  publicProviderFailureSummary,
  type EngineDto,
} from "@ponderosa/core";

export const MAX_PROVIDER_DIAGNOSTIC_CHARACTERS = MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS;

/**
 * Provider failures may contain a complete JSON result/session envelope. Keep
 * that envelope out of ordinary UI while retaining one bounded useful field.
 */
export function providerAvailabilityDiagnostic(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const withoutServerPrefix = detail.replace(/^provider rejected runtime access:\s*/iu, "").trim();
  return publicProviderFailureSummary(withoutServerPrefix);
}

function providerAccountHelp(engine: Pick<EngineDto, "id" | "displayName">): string {
  if (engine.id === "claude") return "Check the Claude subscription and Claude Code sign-in";
  if (engine.id === "codex") return "Check the ChatGPT subscription and Codex sign-in";
  return `Check the ${engine.displayName} subscription and sign-in`;
}

type ProviderAvailabilityCategory = "authentication" | "limit" | "capacity" | "unknown";

function providerAvailabilityCategory(detail: string | undefined): ProviderAvailabilityCategory {
  const value = detail ?? "";
  if (/unauthori[sz]ed|authentication|sign.?in|oauth|credential|subscription (?:access|expired)|organization has disabled/iu.test(value)) {
    return "authentication";
  }
  if (/rate.?limit|too many requests|\b429\b|session.?limit|usage.?limit|quota (?:is )?(?:exhausted|reached)|hit (?:your |the )?limit|limit resets?/iu.test(value)) {
    return "limit";
  }
  if (/selected model is at capacity|model.*capacity|overloaded|no capacity|resource exhausted/iu.test(value)) {
    return "capacity";
  }
  return "unknown";
}

export function providerAvailabilityMessage(
  engine: Pick<EngineDto, "id" | "displayName" | "authentication" | "reachability" | "availabilityDetail" | "authDetail">,
): string {
  if (engine.authentication === "checking" || engine.reachability === "checking") {
    return `${engine.displayName} availability is still being checked.`;
  }
  if (engine.authentication === "unauthenticated") {
    return `${engine.displayName} is not signed in. Sign in on this host, then refresh provider status.`;
  }
  if (engine.authentication === "error") {
    return `${engine.displayName} sign-in status could not be checked. Verify its CLI is available on this host, then refresh provider status.`;
  }
  const category = providerAvailabilityCategory(engine.availabilityDetail ?? engine.authDetail);
  if (category === "authentication") {
    return `${engine.displayName} access is unavailable. ${providerAccountHelp(engine)}, then test access.`;
  }
  if (category === "limit") {
    return `${engine.displayName} access is temporarily unavailable because its usage limit was reached. Test access again after the provider limit resets.`;
  }
  if (category === "capacity") {
    return `${engine.displayName} is temporarily unavailable because the provider is at capacity. Test access again shortly.`;
  }
  return `${engine.displayName} access is unavailable. Test access again; if it still fails, check the provider logs for details.`;
}
