const PREFIX = "ponderosa.chat.v1";

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function chatStateKey(
  kind: "draft" | "view" | "scroll" | "runtime",
  scope: string,
): string {
  return `${PREFIX}.${kind}.${scope}`;
}

export function readChatState(key: string): string | undefined {
  try {
    return storage()?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function readChatStateEntries(prefix: string): Array<[string, string]> {
  try {
    const target = storage();
    if (!target) return [];
    const entries: Array<[string, string]> = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = target.getItem(key);
      if (value !== null) entries.push([key, value]);
    }
    return entries;
  } catch {
    return [];
  }
}

export function writeChatState(key: string, value: string): boolean {
  try {
    const target = storage();
    if (!target) return false;
    if (value) target.setItem(key, value);
    else target.removeItem(key);
    return true;
  } catch {
    // Browsing remains usable when storage is unavailable or full.
    return false;
  }
}

export function readScrollPosition(key: string): number | undefined {
  const raw = readChatState(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
