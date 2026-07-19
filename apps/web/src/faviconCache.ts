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
  /** Internal deterministic test hook for unused-entry LRU mutations. */
  onUnusedEntryLruOperation?: (cache: "positive" | "negative", operation: "touch" | "evict") => void;
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
  lruPrevious?: FaviconEntry;
  lruNext?: FaviconEntry;
  inUnusedLru: boolean;
}

interface FaviconFailure {
  identity: string;
  expiresAt: number;
  src: Promise<string>;
  lastUsedAt: number;
  lruPrevious?: FaviconFailure;
  lruNext?: FaviconFailure;
  inUnusedLru: boolean;
}

interface UnusedLruNode<T> {
  lruPrevious?: T;
  lruNext?: T;
  inUnusedLru: boolean;
}

/**
 * The maps are the lookup authority; this list contains only entries safe to
 * evict. Keeping it separate means a release never has to inspect active
 * consumers or sort the whole cache just to find the least-recently-used item.
 */
class UnusedEntryLru<T extends UnusedLruNode<T>> {
  private newest?: T;
  private oldest?: T;
  private count = 0;

  constructor(private readonly onOperation?: (operation: "touch" | "evict") => void) {}

  get size(): number { return this.count; }

  touch(entry: T): void {
    this.remove(entry);
    entry.lruNext = this.newest;
    if (this.newest) this.newest.lruPrevious = entry;
    else this.oldest = entry;
    this.newest = entry;
    entry.inUnusedLru = true;
    this.count += 1;
    this.onOperation?.("touch");
  }

  remove(entry: T): void {
    if (!entry.inUnusedLru) return;
    if (entry.lruPrevious) entry.lruPrevious.lruNext = entry.lruNext;
    else this.newest = entry.lruNext;
    if (entry.lruNext) entry.lruNext.lruPrevious = entry.lruPrevious;
    else this.oldest = entry.lruPrevious;
    entry.lruPrevious = undefined;
    entry.lruNext = undefined;
    entry.inUnusedLru = false;
    this.count -= 1;
  }

  takeOldest(): T | undefined {
    const entry = this.oldest;
    if (!entry) return undefined;
    this.remove(entry);
    this.onOperation?.("evict");
    return entry;
  }
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
  const unusedResources = new UnusedEntryLru<FaviconEntry>((operation) => options.onUnusedEntryLruOperation?.("positive", operation));
  const unusedFailures = new UnusedEntryLru<FaviconFailure>((operation) => options.onUnusedEntryLruOperation?.("negative", operation));

  const retire = (entry: FaviconEntry) => {
    if (resources.get(entry.identity) === entry) resources.delete(entry.identity);
    unusedResources.remove(entry);
    if (entry.objectUrl) {
      revokeObjectUrl(entry.objectUrl);
      entry.objectUrl = undefined;
    }
  };

  const removeFailure = (failure: FaviconFailure) => {
    if (failures.get(failure.identity) === failure) failures.delete(failure.identity);
    unusedFailures.remove(failure);
  };

  const trimUnusedResources = () => {
    while (unusedResources.size > maxEntries) {
      const candidate = unusedResources.takeOldest();
      if (!candidate) return;
      retire(candidate);
    }
  };

  const trimUnusedFailures = () => {
    while (unusedFailures.size > maxEntries) {
      const candidate = unusedFailures.takeOldest();
      if (!candidate) return;
      removeFailure(candidate);
    }
  };

  const rememberFailure = (identity: string, rejected?: Promise<string>) => {
    const failure = rejected ?? Promise.reject(new Error("favicon unavailable"));
    // The rejection is intentionally retained for the short negative window.
    // Attach a handler so a failed image with no remaining mounted consumer is
    // not reported as an unhandled rejection by the browser/test runtime.
    void failure.catch(() => undefined);
    const previous = failures.get(identity);
    if (previous) removeFailure(previous);
    const entry: FaviconFailure = { identity, expiresAt: now() + negativeTtlMs, src: failure, lastUsedAt: now(), inUnusedLru: false };
    failures.set(identity, entry);
    unusedFailures.touch(entry);
    trimUnusedFailures();
  };

  const handle = (entry: FaviconEntry): FaviconResource => {
    unusedResources.remove(entry);
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
          unusedResources.touch(entry);
          trimUnusedResources();
        }
      },
    };
  };

  return {
    acquire(identity) {
      let entry = resources.get(identity);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) {
        resources.delete(identity);
        if (entry.consumers === 0) retire(entry);
        entry = undefined;
      }
      if (entry) return handle(entry);

      const failure = failures.get(identity);
      if (failure) {
        if (failure.expiresAt <= now()) {
          removeFailure(failure);
        } else {
          failure.lastUsedAt = now();
          unusedFailures.touch(failure);
          return { src: failure.src, release() {} };
        }
      }

      entry = {
        identity,
        src: Promise.resolve(""),
        consumers: 0,
        lastUsedAt: now(),
        invalid: false,
        inUnusedLru: false,
      };
      entry.src = fetchFavicon(faviconEndpoint(identity)).then(async (response) => {
        if (!response.ok) throw new Error("favicon unavailable");
        const objectUrl = createObjectUrl(await response.blob());
        entry!.objectUrl = objectUrl;
        entry!.expiresAt = now() + positiveTtlMs;
        if (entry!.invalid || entry!.consumers === 0 || resources.get(identity) !== entry) retire(entry!);
        // A response that completed after its final consumer unmounted is not
        // retained; the release path already protected any still-live entry.
        return objectUrl;
      }).catch((error: unknown) => {
        retire(entry!);
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
