export const MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS = 240;

const MAX_PROVIDER_FAILURE_INPUT_CHARACTERS = 64 * 1024;
const MAX_PROVIDER_FAILURE_DEPTH = 6;
const MAX_PROVIDER_FAILURE_ARRAY_ITEMS = 16;
const HUMAN_FAILURE_KEYS = ["message", "detail", "reason", "error"] as const;

function normalizeProviderText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\\u(?:200[b-f]|2060|feff)|\\x(?:ad)|%e2%80%(?:8b|8c|8d)|%ef%bb%bf/giu, "")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\\u002f|\\x2f|%2f/giu, "/")
    .replace(/\\u005c|\\x5c|%5c/giu, "\\")
    .replace(/\\u005f|\\x5f|%5f/giu, "_")
    .replace(/\\\//gu, "/")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function containsOpaqueHighEntropyBlob(value: string): boolean {
  const tokens = value.match(/[A-Za-z0-9+/_=-]{32,}/gu) ?? [];
  return tokens.some((token) => {
    const frequencies = new Map<string, number>();
    for (const character of token) {
      frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
    }
    if (frequencies.size < 10) return false;
    const entropy = [...frequencies.values()].reduce((total, count) => {
      const probability = count / token.length;
      return total - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.5;
  });
}

function containsRestrictedProviderData(value: string): boolean {
  return /\b(?:session[_-]?id|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|client[_-]?id)\b/iu.test(value)
    || /\b(?:password|passwd|pwd|token|secret|authorization|credential)s?\b\s*[:=]/iu.test(value)
    || /(?:^|[?&\s])(?:code|oauth[_-]?code|authorization[_-]?code|callback[_-]?code)\s*[:=]/iu.test(value)
    || /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(value)
    || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(value)
    || /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/u.test(value)
    || /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/iu.test(value)
    || /\beyJ[A-Za-z0-9+/_=-]{12,}/u.test(value)
    || /(?:^|[\s"'(=])(?:~\/|\/(?!\/)(?:(?:[^/\s"'<>]+\/)+[^/\s"'<>]*|(?:home|root|etc|var|tmp|opt|srv|mnt|private|run)(?:\/[^/\s"'<>]*)?))/u.test(value)
    || /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]+[^\\/\s"'<>]+(?:[\\/]+[^\\/\s"'<>]+)*|[\\/]{2}[^\\/\s"'<>]+[\\/]+[^\\/\s"'<>]+)/u.test(value)
    || /(?:^|[\s"'(=])(?:\.{0,2}[\\/]+)?(?:\.ssh|\.aws|\.codex|\.claude|\.config[\\/]+gh)[\\/]+[^\s"'<>]*/iu.test(value)
    || containsOpaqueHighEntropyBlob(value);
}

function malformedHumanFailure(value: string, depth: number): string | undefined {
  const match = value.match(
    /["'](?:message|detail|reason|error)["']\s*:\s*["']([^"'\r\n]+)/iu,
  );
  return match?.[1] ? extractProviderFailure(match[1], depth + 1) : undefined;
}

function extractProviderFailure(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const candidate = normalizeProviderText(value);
    if (!candidate || candidate.length > MAX_PROVIDER_FAILURE_INPUT_CHARACTERS) return undefined;
    if (/^(?:\{|\[|")/u.test(candidate)) {
      try {
        return extractProviderFailure(JSON.parse(candidate), depth + 1);
      } catch {
        return malformedHumanFailure(candidate, depth);
      }
    }
    return containsRestrictedProviderData(candidate) ? undefined : candidate;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_PROVIDER_FAILURE_ARRAY_ITEMS)) {
      const extracted = extractProviderFailure(item, depth + 1);
      if (extracted) return extracted;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of HUMAN_FAILURE_KEYS) {
    const extracted = extractProviderFailure(record[key], depth + 1);
    if (extracted) return extracted;
  }
  return undefined;
}

/** A bounded, fail-closed summary safe for DTOs, notifications, and model context. */
export function publicProviderFailureSummary(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const normalized = normalizeProviderText(detail);
  if (!normalized || normalized.length > MAX_PROVIDER_FAILURE_INPUT_CHARACTERS) return undefined;
  const extracted = extractProviderFailure(normalized);
  if (!extracted) return undefined;
  return extracted.length > MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS
    ? `${extracted.slice(0, MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS - 1)}…`
    : extracted;
}
