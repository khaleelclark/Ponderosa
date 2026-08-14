const MAX_PUBLIC_PROVIDER_DETAIL_CHARACTERS = 240;

function compact(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractJsonDetail(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return compact(value) || undefined;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "reason", "code", "subtype", "type"]) {
    const extracted = extractJsonDetail(record[key], depth + 1);
    if (extracted) return extracted;
  }
  return undefined;
}

/** Keep provider result/session envelopes in canonical evidence, not public DTOs. */
export function publicProviderAvailabilityDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const trimmed = detail.trim();
  if (!trimmed) return undefined;
  let extracted: string | undefined;
  try {
    extracted = extractJsonDetail(JSON.parse(trimmed));
  } catch {
    const structured = trimmed.match(
      /["'](?:message|error|detail|reason|code|subtype|type)["']\s*:\s*["']([^"'\r\n]+)/iu,
    )?.[1];
    extracted = structured ? compact(structured) : /^(?:\{|\[)/u.test(trimmed)
      ? undefined
      : compact(trimmed);
  }
  if (!extracted) return undefined;
  return extracted.length > MAX_PUBLIC_PROVIDER_DETAIL_CHARACTERS
    ? `${extracted.slice(0, MAX_PUBLIC_PROVIDER_DETAIL_CHARACTERS - 1)}…`
    : extracted;
}

export function providerUnavailableNotificationBody(detail: string | undefined): string {
  const safeDetail = publicProviderAvailabilityDetail(detail);
  return `${safeDetail ?? "The provider rejected runtime access."} Queued work is held until access is explicitly rechecked or a successful authorized Run proves recovery.`;
}
