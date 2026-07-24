export function createClientId(prefix = "", fallback?: () => string): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? fallback?.()
    ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}${value}`;
}
