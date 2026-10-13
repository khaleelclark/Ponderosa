export function createClientId(prefix = "", fallback?: () => string): string {
  let value: string | undefined = globalThis.crypto?.randomUUID?.() ?? fallback?.();
  // randomUUID requires HTTPS; getRandomValues also works on private-LAN HTTP.
  if (value === undefined && globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  value ??= `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  return `${prefix}${value}`;
}

// Module state is scoped to one loaded browser page and is not cloned with
// sessionStorage when a browser duplicates or restores a tab.
const PAGE_CLIENT_ID = createClientId("page:");

/**
 * Identifies one mounted visit to one durable draft surface. The page prefix
 * keeps the existing server compatibility contract, while the fresh suffix
 * prevents an abandoned A -> B -> A write chain from claiming the later A.
 */
export function draftSurfaceClientId(): string {
  return `${PAGE_CLIENT_ID}:draft:${createClientId()}`;
}
