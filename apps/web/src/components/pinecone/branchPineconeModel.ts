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

/** Merge oldest-to-newest canonical pages; the newest projection owns receipts. */
export function mergePineconeHistory(pages: MessageDto[][]): MessageDto[] {
  const messages = new Map<string, MessageDto>();
  for (const page of pages) for (const message of page) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
