/** Display only: canonical Markdown and link destinations are never modified. */
export function markdownPreviewText(value: string): string {
  return value
    .replace(/```[^\n]*\n?([\s\S]*?)```/gu, "$1")
    // Also recover labels from legacy notifications cut off inside a link URL.
    .replace(/!?\[([^\]]*)\]\([^)]*(?:\)|$)/gu, "$1")
    .replace(/<https?:\/\/([^>]+)>/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gmu, "")
    .replace(/(?<!\w)(?:\*\*|__|~~)|(?:\*\*|__|~~)(?!\w)/gu, "")
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/gu, "$2")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\s+/gu, " ").trim();
}

export function notificationPreviewText(value: string): string {
  return markdownPreviewText(value).slice(0, 240).replace(/[\uD800-\uDBFF]$/u, "");
}
