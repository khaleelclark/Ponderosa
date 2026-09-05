export function createClientId(prefix = "", fallback?: () => string): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? fallback?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}${value}`;
}

// Module state is scoped to one loaded browser page and is not cloned with
// sessionStorage when a browser duplicates or restores a tab.
const PAGE_CLIENT_ID = createClientId("page:");

export function pageClientId(): string {
  return PAGE_CLIENT_ID;
}

/**
 * Identifies one mounted visit to one durable draft surface. The page prefix
 * keeps the existing server compatibility contract, while the fresh suffix
 * prevents an abandoned A -> B -> A write chain from claiming the later A.
 */
export function draftSurfaceClientId(): string {
  return `${PAGE_CLIENT_ID}:draft:${createClientId()}`;
}
