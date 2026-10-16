/** Device storage is optional. Browsers can deny even access to the Storage getter. */
const memoryFallback = new Map<string, string>();
const memoryKey = (kind: "localStorage" | "sessionStorage", key: string) => `${kind}\0${key}`;

export function readBrowserStorage(kind: "localStorage" | "sessionStorage", key: string): string | null {
  const fallback = memoryFallback.get(memoryKey(kind, key));
  if (fallback !== undefined) return fallback;
  try { return typeof window === "undefined" ? null : window[kind].getItem(key); }
  catch { return null; }
}

export function writeBrowserStorage(kind: "localStorage" | "sessionStorage", key: string, value: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    window[kind].setItem(key, value);
    memoryFallback.delete(memoryKey(kind, key));
    return true;
  } catch { memoryFallback.set(memoryKey(kind, key), value); return false; }
}

export function removeBrowserStorage(kind: "localStorage" | "sessionStorage", key: string): void {
  memoryFallback.delete(memoryKey(kind, key));
  try { if (typeof window !== "undefined") window[kind].removeItem(key); }
  catch { /* Device storage is optional. */ }
}
