import type { EngineDto } from "@ponderosa/core";

export const MAX_PROVIDER_DIAGNOSTIC_CHARACTERS = 240;
const MAX_PROVIDER_DIAGNOSTIC_INPUT_CHARACTERS = 64 * 1024;
const MAX_PROVIDER_DIAGNOSTIC_DEPTH = 6;
const MAX_PROVIDER_DIAGNOSTIC_ARRAY_ITEMS = 16;
const HUMAN_DIAGNOSTIC_KEYS = ["message", "detail", "reason", "error"] as const;

function compact(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsSensitiveProviderData(value: string): boolean {
  const normalized = value.replaceAll('\\"', '"').replaceAll("\\'", "'");
  return /\b(?:session[_-]?id|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)\b/iu.test(normalized)
    || /\b(?:session|token|secret|authorization|credential)s?\b\s*[:=]/iu.test(normalized)
    || /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/iu.test(normalized)
    || /\bsk-[A-Za-z0-9_-]{8,}/u.test(normalized)
    || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u.test(normalized);
}

function malformedHumanDiagnostic(value: string, depth: number): string | undefined {
  const match = value.match(
    /["'](?:message|detail|reason|error)["']\s*:\s*["']([^"'\r\n]+)/iu,
  );
  return match?.[1] ? extractJsonDiagnostic(match[1], depth + 1) : undefined;
}

function extractJsonDiagnostic(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_PROVIDER_DIAGNOSTIC_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const candidate = compact(value);
    if (!candidate || candidate.length > MAX_PROVIDER_DIAGNOSTIC_INPUT_CHARACTERS) return undefined;
    if (/^(?:\{|\[|")/u.test(candidate)) {
      try {
        return extractJsonDiagnostic(JSON.parse(candidate), depth + 1);
      } catch {
        return malformedHumanDiagnostic(candidate, depth);
      }
    }
    return containsSensitiveProviderData(candidate) ? undefined : candidate;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_PROVIDER_DIAGNOSTIC_ARRAY_ITEMS)) {
      const extracted = extractJsonDiagnostic(item, depth + 1);
      if (extracted) return extracted;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of HUMAN_DIAGNOSTIC_KEYS) {
    const extracted = extractJsonDiagnostic(record[key], depth + 1);
    if (extracted) return extracted;
  }
  return undefined;
}

/**
 * Provider failures may contain a complete JSON result/session envelope. Keep
 * that envelope out of ordinary UI while retaining one bounded useful field.
 */
export function providerAvailabilityDiagnostic(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const withoutServerPrefix = detail.replace(/^provider rejected runtime access:\s*/iu, "").trim();
  if (!withoutServerPrefix || withoutServerPrefix.length > MAX_PROVIDER_DIAGNOSTIC_INPUT_CHARACTERS) return undefined;
  const extracted = extractJsonDiagnostic(withoutServerPrefix);
  if (!extracted) return undefined;
  return extracted.length > MAX_PROVIDER_DIAGNOSTIC_CHARACTERS
    ? `${extracted.slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARACTERS - 1)}…`
    : extracted;
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
