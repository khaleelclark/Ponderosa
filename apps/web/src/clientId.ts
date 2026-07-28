export function createClientId(prefix = "", fallback?: () => string): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? fallback?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}${value}`;
}
