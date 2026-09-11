import type { ConversationDetailDto, ConversationMessageDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys.js";

/** Publish only server-confirmed messages; recovery acknowledgements are not messages. */
export async function publishConversationMessageReceipt(
  client: QueryClient,
  conversationId: string,
  message: ConversationMessageDto | undefined,
): Promise<void> {
  if (!message || message.conversationId !== conversationId) return;
  const filter = { queryKey: queryKeys.conversations.detailPrefix(conversationId) };
  // A pre-send read must not overwrite the acknowledged message after publication.
  await client.cancelQueries(filter);
  client.setQueriesData<ConversationDetailDto>(filter, detail => {
    if (!detail || detail.messages.some(item => item.id === message.id ||
        (message.communicationEventId && item.communicationEventId === message.communicationEventId))) return detail;
    return { ...detail, messages: [...detail.messages, message].sort((a, b) =>
      (a.canonicalOrderKey ?? a.createdAt).localeCompare(b.canonicalOrderKey ?? b.createdAt) || a.id.localeCompare(b.id),
    ) };
  });
}
