/** Compact display text only; the canonical message and its links stay intact. */
export function markdownPreviewText(value: string): string {
  return value
    .replace(/```[^\n]*\n?([\s\S]*?)```/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<https?:\/\/([^>]+)>/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gmu, "")
    .replace(/(?<!\w)(?:\*\*|__|~~)|(?:\*\*|__|~~)(?!\w)/gu, "")
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/gu, "$2")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\s+/gu, " ").trim();
}
