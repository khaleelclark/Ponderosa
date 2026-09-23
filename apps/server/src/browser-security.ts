const MAX_NAVIGATION_URL = 2_048;
const SENSITIVE_QUERY_NAME = /(?:^|[_-])(?:access|auth|authorization|bearer|code|credential|jwt|key|oauth|password|policy|refresh|secret|session|sig|signature|signed|sso|state|ticket|token)(?:$|[_-])/i;
const SENSITIVE_COMPACT_QUERY_NAMES = new Set([
  "accesstoken", "apikey", "authorizationcode", "awsaccesskeyid", "clientsecret",
  "idtoken", "keypairid", "oauthcode", "refreshtoken", "relaystate", "samlrequest",
  "samlresponse", "sessiontoken", "sharedaccesssignature",
]);
const SENSITIVE_TEXT_ASSIGNMENT = /(\b(?:access[_ -]?token|refresh[_ -]?token|id[_ -]?token|session[_ -]?token|authorization[_ -]?code|oauth[_ -]?code|client[_ -]?secret|api[_ -]?key|password|token)\b\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#]+)/gi;
const BEARER_CREDENTIAL = /(\bbearer\s+)([a-z0-9._~+/=-]{8,})/gi;

export class BrowserSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 503 | 504 = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

export function validateBrowserUrl(value: string): string {
  if (!value || value.length > MAX_NAVIGATION_URL) {
    throw new BrowserSessionError("browser URL must contain 1 to 2048 characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserSessionError("browser URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserSessionError("browser navigation accepts only http(s) URLs");
  }
  if (parsed.username || parsed.password) {
    throw new BrowserSessionError("credentialed browser URLs are not allowed");
  }
  return parsed.toString();
}

function isSensitiveQueryName(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_QUERY_NAME.test(name) || SENSITIVE_COMPACT_QUERY_NAMES.has(compact) ||
    compact.startsWith("xamz") || compact.startsWith("xgoog");
}

export interface RedactedBrowserUrl {
  url: string;
  /** Undefined when replay could repeat an OAuth callback, token, or signed URL. */
  replayUrl?: string;
}

/**
 * Browser URLs cross a canonical persistence and operator-display boundary.
 * Fragments never cross it. Known credential-bearing query values are visibly
 * redacted, and any URL containing one becomes non-replayable.
 */
export function redactBrowserUrl(value: string): RedactedBrowserUrl {
  if (value.length > MAX_NAVIGATION_URL) return { url: "redacted-browser-url" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: "invalid-browser-url" };
  }
  if (parsed.protocol === "about:" && parsed.pathname === "blank") return { url: "about:blank", replayUrl: "about:blank" };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { url: `${parsed.protocol}redacted` };
  // The current page URL is untrusted: a redirect may introduce userinfo even
  // though direct navigation rejects it. Never display, persist, or replay it.
  let sensitive = Boolean(parsed.username || parsed.password);
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (!isSensitiveQueryName(name)) continue;
    sensitive = true;
    parsed.searchParams.set(name, "[REDACTED]");
  }
  return {
    url: parsed.toString(),
    ...(!sensitive ? { replayUrl: parsed.toString() } : {}),
  };
}

function splitTrailingUrlPunctuation(candidate: string): { url: string; suffix: string } {
  let end = candidate.length;
  while (end > 0) {
    const trailing = candidate[end - 1]!;
    if (/[.,!?;:\]}]/u.test(trailing)) {
      end -= 1;
      continue;
    }
    if (trailing === ")") {
      const prefix = candidate.slice(0, end);
      const openings = (prefix.match(/\(/gu) ?? []).length;
      const closings = (prefix.match(/\)/gu) ?? []).length;
      if (closings > openings) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return { url: candidate.slice(0, end), suffix: candidate.slice(end) };
}

export function redactBrowserText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"'\x60]+/gi, (candidate) => {
      const { url, suffix } = splitTrailingUrlPunctuation(candidate);
      return redactBrowserUrl(url).url + suffix;
    })
    .replace(BEARER_CREDENTIAL, "$1[REDACTED]")
    .replace(SENSITIVE_TEXT_ASSIGNMENT, (match, prefix: string, credential: string) =>
      /^(?:\[REDACTED\]|%5Bredacted%5D)$/i.test(credential) ? match : `${prefix}[REDACTED]`);
}

export function redactPageInfo<T extends { url: string; title: string }>(info: T): T & { replayUrl?: string } {
  const redacted = redactBrowserUrl(info.url);
  return {
    ...info,
    url: redacted.url,
    title: redactBrowserText(info.title),
    ...(redacted.replayUrl ? { replayUrl: redacted.replayUrl } : {}),
  };
}

export function redactSnapshot(snapshot: string): string {
  try {
    const redactValue = (value: unknown, key?: string): unknown => {
      if (typeof value === "string") {
        return key === "url" ? redactBrowserUrl(value).url : redactBrowserText(value);
      }
      if (Array.isArray(value)) return value.map((item) => redactValue(item));
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
      }
      return value;
    };
    return JSON.stringify(redactValue(JSON.parse(snapshot)), null, 2);
  } catch {
    return redactBrowserText(snapshot);
  }
}

interface SnapshotBounds {
  truncated: true;
  originalCharacters: number;
  stringLimit: number;
  arrayLimit: number;
}

function boundedSnapshotValue(value: unknown, stringLimit: number, arrayLimit: number): unknown {
  if (typeof value === "string") {
    if (value.length <= stringLimit) return value;
    return stringLimit > 0 ? `${value.slice(0, Math.max(0, stringLimit - 1))}…` : "";
  }
  if (Array.isArray(value)) {
    return value.slice(0, arrayLimit).map((item) => boundedSnapshotValue(item, stringLimit, arrayLimit));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      boundedSnapshotValue(child, stringLimit, arrayLimit),
    ]));
  }
  return value;
}

/**
 * Redact and bound an inspect result without slicing serialized JSON. The
 * truncation marker lets models distinguish a complete snapshot from a
 * bounded preview while every return value remains parseable JSON.
 */
export function boundBrowserSnapshot(snapshot: string, maxCharacters: number): string {
  const redacted = redactSnapshot(snapshot);
  if (redacted.length <= maxCharacters) return redacted;

  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted);
  } catch {
    parsed = { text: redacted };
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { snapshot: parsed };
  const originalCharacters = redacted.length;
  const encode = (stringLimit: number, arrayLimit: number): string => JSON.stringify({
    ...boundedSnapshotValue(root, stringLimit, arrayLimit) as Record<string, unknown>,
    _ponderosa: {
      truncated: true,
      originalCharacters,
      stringLimit,
      arrayLimit,
    } satisfies SnapshotBounds,
  });

  for (const arrayLimit of [80, 40, 20, 10, 5, 1, 0]) {
    if (encode(0, arrayLimit).length > maxCharacters) continue;
    let low = 0;
    let high = maxCharacters;
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      if (encode(candidate, arrayLimit).length <= maxCharacters) low = candidate;
      else high = candidate - 1;
    }
    return encode(low, arrayLimit);
  }

  // The normal 16k budget can always fit the structured form above. Keep a
  // valid, explicit envelope even if a caller supplies an unusually tiny cap.
  const minimal = JSON.stringify({ _ponderosa: { truncated: true, originalCharacters } });
  return minimal.length <= maxCharacters ? minimal : "{}";
}
