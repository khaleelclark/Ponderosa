import type { ConversationMessageDto } from "@ponderosa/core";

/** Follow the accepted DM's canonical delivery, never the latest agent message. */
export function voiceReply(
  sent: ConversationMessageDto,
  messages: ConversationMessageDto[],
  agentId: string,
): { text: string } | { error: string } | undefined {
  const receipts = sent.deliveryReceipts?.filter(item => item.targetAgentId === agentId) ?? [];
  if (!receipts.length) return undefined;
  if (receipts.length !== 1) return { error: "This turn has multiple deliveries. Continue in the Chat." };
  const receipt = receipts[0]!;
  if (["failed", "cancelled", "undelivered", "retry_exhausted", "unconfirmed"].includes(receipt.state)) {
    return { error: "This turn needs attention in the Chat. Voice conversation is paused." };
  }
  if (receipt.state !== "processed" && receipt.state !== "recovered") return undefined;
  const executionId = receipt.state === "recovered" ? receipt.recoveryExecutionId : receipt.executionId;
  if (!executionId) return undefined;
  const replies = messages.filter(message => message.conversationId === sent.conversationId &&
    message.role === "assistant" && message.communicationIntent === "user_dm" &&
    message.authorAgentId === agentId && message.executionId === executionId);
  if (!replies.length) return undefined;
  if (replies.length !== 1) return { error: "This turn has several replies. Continue in the Chat." };
  const reply = replies[0]!;
  // Artifact-backed communication text is a bounded projection, not the full answer.
  if (reply.document || !reply.text.trim()) {
    return { error: "The full reply is available in the Chat. Voice conversation is paused." };
  }
  return { text: reply.authoredText ?? reply.text };
}

/** A contiguous latest page must still contain the sent turn before claiming uniqueness. */
export function voiceReplyInWindow(messageId: string, messages: ConversationMessageDto[], agentId: string) {
  const sent = messages.find(item => item.id === messageId || item.communicationEventId === messageId);
  if (!sent) return { error: "This turn is outside the recent voice window. Continue in the Chat." };
  return voiceReply(sent, messages, agentId);
}
