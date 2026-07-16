import type { ConversationDto } from "@ponderosa/core";

/** Keep duplicate user-chosen chat names readable without changing canonical titles. */
export function conversationDisplayTitle(
  conversation: ConversationDto,
  conversations: readonly ConversationDto[],
): string {
  const title = conversation.title.trim() || "Untitled chat";
  const duplicates = conversations
    .filter((candidate) => (candidate.title.trim() || "Untitled chat") === title)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (duplicates.length < 2) return title;
  const index = duplicates.findIndex((candidate) => candidate.id === conversation.id);
  return `${title} · ${index >= 0 ? index + 1 : "?"}`;
}
