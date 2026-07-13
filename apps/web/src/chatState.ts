const PREFIX = "ponderosa.chat.v1";

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function chatStateKey(kind: "draft" | "view" | "scroll", scope: string): string {
  return `${PREFIX}.${kind}.${scope}`;
}

export function readChatState(key: string): string | undefined {
  try {
    return storage()?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeChatState(key: string, value: string): void {
  try {
    if (value) storage()?.setItem(key, value);
    else storage()?.removeItem(key);
  } catch {
    // Browsing remains usable when storage is unavailable or full.
  }
}

export function readScrollPosition(key: string): number | undefined {
  const raw = readChatState(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
