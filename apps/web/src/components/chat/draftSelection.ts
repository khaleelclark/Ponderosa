import { readBrowserStorage, writeBrowserStorage } from "../../browserStorage.js";

export interface DraftSelection { text: string; start: number; end: number }
const selectionKey = (key: string) => `${key}.selection.v1`;

export function readDraftSelection(key: string | undefined): DraftSelection | undefined {
  if (!key) return undefined;
  try {
    const value = JSON.parse(readBrowserStorage("sessionStorage", selectionKey(key)) ?? "null");
    return value && typeof value.text === "string" && Number.isSafeInteger(value.start) &&
      Number.isSafeInteger(value.end) && value.start >= 0 && value.end >= 0
      ? { text: value.text, start: Math.min(value.start, value.text.length), end: Math.min(value.end, value.text.length) }
      : undefined;
  } catch { return undefined; }
}

export function writeDraftSelection(key: string | undefined, value: DraftSelection): void {
  if (key) writeBrowserStorage("sessionStorage", selectionKey(key), JSON.stringify(value));
}
