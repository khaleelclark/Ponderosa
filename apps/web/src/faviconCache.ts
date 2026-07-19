export type FaviconFetcher = (input: string) => Promise<Response>;

export interface FaviconResource {
  src: Promise<string>;
  release(): void;
}

export interface FaviconResourceCacheOptions {
  now?: () => number;
  maxEntries?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

/**
 * This identity intentionally matches the server's favicon target: a favicon
 * belongs to a public HTTPS host, never to an individual documentation page.
 */
export function faviconIdentity(href: string): string | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  const hostname = url.hostname.toLowerCase();
  const isIpAddress = hostname.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  if (
    url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !hostname || hostname === "localhost" || hostname.endsWith(".local") || isIpAddress
  ) return undefined;
  return `https://${hostname}/favicon.ico`;
}

export function faviconEndpoint(identity: string): string {
  return `/api/link-favicon?url=${encodeURIComponent(identity)}`;
}

interface FaviconEntry {
  identity: string;
  src: Promise<string>;
  objectUrl?: string;
  expiresAt?: number;
  consumers: number;
  lastUsedAt: number;
  invalid: boolean;
}

interface FaviconFailure {
  expiresAt: number;
  src: Promise<string>;
  lastUsedAt: number;
}

/**
 * A page-scoped cache with a 128-entry LRU for unused successful icons and a
 * one-hour positive TTL matching the server response. Mounted images hold a
 * reference, so an eviction or expiry never revokes a URL still in use. A
 * failed request or decode is shared for at most the server's 60-second
 * failure horizon, then it is retried. Failed entries have their own capped
 * LRU using that same entry budget, so a burst of hostile unique hosts cannot
 * grow the negative cache for even its short lifetime.
 */
export function createFaviconResourceCache(fetchFavicon: FaviconFetcher, options: FaviconResourceCacheOptions = {}): {
  acquire(identity: string): FaviconResource;
  markFailed(identity: string, source?: string): void;
} {
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, options.maxEntries ?? 128);
  const positiveTtlMs = options.positiveTtlMs ?? 60 * 60 * 1000;
  const negativeTtlMs = options.negativeTtlMs ?? 60 * 1000;
  const createObjectUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
  const revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
  const resources = new Map<string, FaviconEntry>();
  const failures = new Map<string, FaviconFailure>();

  const retire = (entry: FaviconEntry) => {
    if (resources.get(entry.identity) === entry) resources.delete(entry.identity);
    if (entry.objectUrl) {
      revokeObjectUrl(entry.objectUrl);
      entry.objectUrl = undefined;
    }
  };

  const prune = () => {
    const current = now();
    for (const [identity, failure] of failures) {
      if (failure.expiresAt <= current) failures.delete(identity);
    }
    for (const entry of resources.values()) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= current && entry.consumers === 0) retire(entry);
    }
  };

  const trim = () => {
    prune();
    while (resources.size > maxEntries) {
      const candidate = [...resources.values()]
        .filter((entry) => entry.consumers === 0)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) return;
      retire(candidate);
    }
  };

  const trimFailures = () => {
    prune();
    while (failures.size > maxEntries) {
      const candidate = [...failures.entries()]
        .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) return;
      failures.delete(candidate[0]);
    }
  };

  const rememberFailure = (identity: string, rejected?: Promise<string>) => {
    const failure = rejected ?? Promise.reject(new Error("favicon unavailable"));
    // The rejection is intentionally retained for the short negative window.
    // Attach a handler so a failed image with no remaining mounted consumer is
    // not reported as an unhandled rejection by the browser/test runtime.
    void failure.catch(() => undefined);
    failures.set(identity, { expiresAt: now() + negativeTtlMs, src: failure, lastUsedAt: now() });
    trimFailures();
  };

  const handle = (entry: FaviconEntry): FaviconResource => {
    entry.consumers += 1;
    entry.lastUsedAt = now();
    let released = false;
    return {
      src: entry.src,
      release() {
        if (released) return;
        released = true;
        entry.consumers -= 1;
        entry.lastUsedAt = now();
        if (entry.consumers !== 0) return;
        if (entry.invalid || resources.get(entry.identity) !== entry || (entry.expiresAt !== undefined && entry.expiresAt <= now())) {
          retire(entry);
        } else {
          trim();
        }
      },
    };
  };

  return {
    acquire(identity) {
      prune();
      let entry = resources.get(identity);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) {
        resources.delete(identity);
        if (entry.consumers === 0) retire(entry);
        entry = undefined;
      }
      if (entry) return handle(entry);

      const failure = failures.get(identity);
      if (failure) {
        failure.lastUsedAt = now();
        return { src: failure.src, release() {} };
      }

      entry = {
        identity,
        src: Promise.resolve(""),
        consumers: 0,
        lastUsedAt: now(),
        invalid: false,
      };
      entry.src = fetchFavicon(faviconEndpoint(identity)).then(async (response) => {
        if (!response.ok) throw new Error("favicon unavailable");
        const objectUrl = createObjectUrl(await response.blob());
        entry!.objectUrl = objectUrl;
        entry!.expiresAt = now() + positiveTtlMs;
        if (entry!.invalid || entry!.consumers === 0 || resources.get(identity) !== entry) retire(entry!);
        else trim();
        return objectUrl;
      }).catch((error: unknown) => {
        if (resources.get(identity) === entry) resources.delete(identity);
        rememberFailure(identity, entry!.src);
        throw error;
      });
      resources.set(identity, entry);
      return handle(entry);
    },
    markFailed(identity, source) {
      const entry = resources.get(identity);
      if (!entry || (source && entry.objectUrl !== source)) return;
      entry.invalid = true;
      resources.delete(identity);
      rememberFailure(identity);
      if (entry.consumers === 0) retire(entry);
    },
  };
}

const faviconResources = createFaviconResourceCache((input) => fetch(input));

export function acquireFavicon(identity: string): FaviconResource {
  return faviconResources.acquire(identity);
}

export function markFaviconFailed(identity: string, source?: string): void {
  faviconResources.markFailed(identity, source);
}
