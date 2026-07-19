export type FaviconFetcher = (input: string) => Promise<Response>;

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

/** Page-lifetime positive and negative favicon cache. */
export function createFaviconResourceCache(fetchFavicon: FaviconFetcher): {
  load(identity: string): Promise<string>;
  markFailed(identity: string): void;
} {
  const resources = new Map<string, Promise<string>>();
  const failed = new Set<string>();
  return {
    load(identity) {
      if (failed.has(identity)) return Promise.reject(new Error("favicon unavailable"));
      let resource = resources.get(identity);
      if (!resource) {
        resource = fetchFavicon(faviconEndpoint(identity)).then(async (response) => {
          if (!response.ok) throw new Error("favicon unavailable");
          return URL.createObjectURL(await response.blob());
        }).catch((error: unknown) => {
          failed.add(identity);
          throw error;
        });
        resources.set(identity, resource);
      }
      return resource;
    },
    markFailed(identity) {
      failed.add(identity);
    },
  };
}

const faviconResources = createFaviconResourceCache((input) => fetch(input));

export function loadFavicon(identity: string): Promise<string> {
  return faviconResources.load(identity);
}

export function markFaviconFailed(identity: string): void {
  faviconResources.markFailed(identity);
}
