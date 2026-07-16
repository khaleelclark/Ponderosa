/** Resolve either a surface-local projected ID or its canonical communication ID. */
export function projectedMessageIdForFocus(
  messages: ReadonlyArray<{ id: string; communicationEventId?: string }>,
  focusId: string | undefined,
): string | undefined {
  if (!focusId) return undefined;
  return messages.find((message) => message.id === focusId || message.communicationEventId === focusId)?.id;
}
