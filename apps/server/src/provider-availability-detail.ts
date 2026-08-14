const MAX_PUBLIC_PROVIDER_DETAIL_CHARACTERS = 240;
const MAX_PROVIDER_DETAIL_INPUT_CHARACTERS = 64 * 1024;
const MAX_PROVIDER_DETAIL_DEPTH = 6;
const MAX_PROVIDER_DETAIL_ARRAY_ITEMS = 16;
const HUMAN_DETAIL_KEYS = ["message", "detail", "reason", "error"] as const;

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

function malformedHumanDetail(value: string, depth: number): string | undefined {
  const match = value.match(
    /["'](?:message|detail|reason|error)["']\s*:\s*["']([^"'\r\n]+)/iu,
  );
  return match?.[1] ? extractJsonDetail(match[1], depth + 1) : undefined;
}

function extractJsonDetail(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_PROVIDER_DETAIL_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const candidate = compact(value);
    if (!candidate || candidate.length > MAX_PROVIDER_DETAIL_INPUT_CHARACTERS) return undefined;
    if (/^(?:\{|\[|")/u.test(candidate)) {
      try {
        return extractJsonDetail(JSON.parse(candidate), depth + 1);
      } catch {
        return malformedHumanDetail(candidate, depth);
      }
    }
    return containsSensitiveProviderData(candidate) ? undefined : candidate;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_PROVIDER_DETAIL_ARRAY_ITEMS)) {
      const extracted = extractJsonDetail(item, depth + 1);
      if (extracted) return extracted;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of HUMAN_DETAIL_KEYS) {
    const extracted = extractJsonDetail(record[key], depth + 1);
    if (extracted) return extracted;
  }
  return undefined;
}

/** Keep provider result/session envelopes in canonical evidence, not public DTOs. */
export function publicProviderAvailabilityDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const trimmed = detail.trim();
  if (!trimmed || trimmed.length > MAX_PROVIDER_DETAIL_INPUT_CHARACTERS) return undefined;
  const extracted = extractJsonDetail(trimmed);
  if (!extracted) return undefined;
  return extracted.length > MAX_PUBLIC_PROVIDER_DETAIL_CHARACTERS
    ? `${extracted.slice(0, MAX_PUBLIC_PROVIDER_DETAIL_CHARACTERS - 1)}…`
    : extracted;
}

export function providerUnavailableNotificationBody(detail: string | undefined): string {
  const safeDetail = publicProviderAvailabilityDetail(detail);
  return `${safeDetail ?? "The provider rejected runtime access."} Queued work is held until access is explicitly rechecked or a successful authorized Run proves recovery.`;
}
