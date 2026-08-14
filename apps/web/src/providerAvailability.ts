import type { EngineDto } from "@ponderosa/core";

export const MAX_PROVIDER_DIAGNOSTIC_CHARACTERS = 240;

function compact(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractJsonDiagnostic(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return compact(value) || undefined;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "reason", "code", "subtype", "type"]) {
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
  if (!withoutServerPrefix) return undefined;
  let extracted: string | undefined;
  try {
    extracted = extractJsonDiagnostic(JSON.parse(withoutServerPrefix));
  } catch {
    const structured = withoutServerPrefix.match(
      /["'](?:message|error|detail|reason|code|subtype|type)["']\s*:\s*["']([^"'\r\n]+)/iu,
    )?.[1];
    extracted = structured ? compact(structured) : /^(?:\{|\[)/u.test(withoutServerPrefix)
      ? undefined
      : compact(withoutServerPrefix);
  }
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

export function providerAvailabilityMessage(
  engine: Pick<EngineDto, "id" | "displayName" | "authentication" | "reachability">,
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
  return `${engine.displayName} access is unavailable. ${providerAccountHelp(engine)}, then test access.`;
}
