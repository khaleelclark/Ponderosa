import type { MessageDto } from '@ponderosa/core';

/** This is a presentation filter over canonical communication, never a second chat log. */
export function pineconeMessages(messages: MessageDto[], spokespersonId: string): MessageDto[] {
  return messages.filter(message => message.communicationIntent !== 'collaboration' && (
    message.role === 'user' && message.communicationIntent === 'user_dm' ||
    message.role === 'assistant' && message.authorAgentId === spokespersonId
  ));
}

export function pineconeDraftKey(branchId: string, spokespersonId: string): string {
  return `ponderosa.pinecone.draft:${branchId}:${spokespersonId}`;
}
