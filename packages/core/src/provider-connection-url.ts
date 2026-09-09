const MAX_PROVIDER_CONNECTION_URL_LENGTH = 4_096;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase();
  return normalized === "localhost" || normalized === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(normalized);
}

/** Validate provider-authored connection links at every process boundary. */
export function safeProviderConnectionUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PROVIDER_CONNECTION_URL_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(normalized) ||
      !/^https?:\/\//iu.test(normalized)) return undefined;
  try {
    const url = new URL(normalized);
    if (url.username || url.password) return undefined;
    if (url.protocol === "https:") return url.href;
    return url.protocol === "http:" && isLoopbackHost(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
