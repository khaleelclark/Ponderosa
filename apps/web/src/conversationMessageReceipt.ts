import type { ConversationDetailDto, ConversationMessageDto } from "@ponderosa/core";
import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys.js";

/** Publish only server-confirmed messages; recovery acknowledgements are not messages. */
export async function publishConversationMessageReceipt(
  client: QueryClient,
  conversationId: string,
  message: ConversationMessageDto | undefined,
): Promise<void> {
  if (!message || message.conversationId !== conversationId) return;
  const filter: QueryFilters = {
    queryKey: queryKeys.conversations.detailPrefix(conversationId),
    // Only detail(id, limit) contains messages; delivery receipts share the prefix.
    predicate: ({ queryKey }) => queryKey.length === 3 && typeof queryKey[2] === "number",
  };
  try {
    // A pre-send read must not overwrite the acknowledged message after publication.
    await client.cancelQueries(filter);
    client.setQueriesData<ConversationDetailDto>(filter, detail => {
      if (!detail || detail.messages.some(item => item.id === message.id ||
          (message.communicationEventId && item.communicationEventId === message.communicationEventId))) return detail;
      return { ...detail, messages: [...detail.messages, message].sort((a, b) =>
        (a.canonicalOrderKey ?? a.createdAt).localeCompare(b.canonicalOrderKey ?? b.createdAt) || a.id.localeCompare(b.id),
      ) };
    });
  } catch (error) {
    // The server already accepted this message. A projection failure is not a send failure.
    console.error("Message accepted, but conversation cache update failed; refreshing.", error);
    try {
      await client.invalidateQueries(filter);
    } catch (refreshError) {
      console.error("Accepted-message conversation refresh failed.", refreshError);
    }
  }
}
