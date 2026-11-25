const PREFIX = "ponderosa.chat.v1";

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function chatStateKey(
  kind: "draft" | "view" | "scroll",
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

export interface ChatReadingAnchor {
  messageId: string;
  orderKey: string;
  offset: number;
}

export function conversationScrollKey(conversationId: string, view: "main" | "collaboration"): string {
  return chatStateKey("scroll", `conversation.${conversationId}.${view}`);
}

export function readChatScrollPosition(key: string): { top?: number; anchor?: ChatReadingAnchor } {
  const raw = readChatState(key);
  if (raw === undefined) return {};
  const top = Number(raw);
  if (Number.isFinite(top) && top >= 0) return { top };
  try {
    const saved = JSON.parse(raw);
    if (!Number.isFinite(saved?.top) || saved.top < 0) return {};
    const anchor = saved.anchor;
    return {
      top: saved.top,
      anchor: typeof anchor?.messageId === "string" && typeof anchor.orderKey === "string" &&
        Number.isFinite(anchor.offset) ? anchor : undefined,
    };
  } catch {
    return {};
  }
}

export function readScrollPosition(key: string): number | undefined {
  return readChatScrollPosition(key).top;
}
