/** Shared long-text contract. "Character" means one Unicode code point in
 * both browser and server code; byte ceilings are always measured as UTF-8. */
export const INLINE_TEXT_MAX_CODE_POINTS = 10_000;
export const LONG_TEXT_MAX_UTF8_BYTES = 8 * 1024 * 1024;

export function unicodeCodePointLength(value: string): number {
  return [...value].length;
}

export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  return [...value].slice(0, Math.max(0, maximum)).join("");
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeCanonicalText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

/** Remove every current or stale steering identifier before any canonical
 * normalization, hashing, byte counting, persistence, or artifact creation. */
export function canonicalizeProviderText(value: string, steeringInjectionIds: Iterable<string> = []): string {
  let sanitized = value;
  const identifiers = [...new Set(steeringInjectionIds)]
    .filter((identifier) => identifier.length > 0)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  for (const identifier of identifiers) sanitized = sanitized.replaceAll(identifier, "[steering reference]");
  return normalizeCanonicalText(sanitized);
}

export function shouldBackTextWithArtifact(value: string): boolean {
  return unicodeCodePointLength(value) > INLINE_TEXT_MAX_CODE_POINTS;
}
