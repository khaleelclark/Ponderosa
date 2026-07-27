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
    readonly statusCode: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
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

export function redactBrowserText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => redactBrowserUrl(candidate).url)
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
