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
