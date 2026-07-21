/** Resolve either a surface-local projected ID or its canonical communication ID. */
export function projectedMessageIdForFocus(
  messages: ReadonlyArray<{ id: string; communicationEventId?: string }>,
  focusId: string | undefined,
): string | undefined {
  if (!focusId) return undefined;
  return messages.find((message) => message.id === focusId || message.communicationEventId === focusId)?.id;
}

/** Mark an exact deep-linked message long enough to orient the user, without
 * leaving notification navigation looking like a persistent selection. */
export function highlightFocusedMessage(target: HTMLElement, durationMs = 2_400): () => void {
  target.dataset.notificationFocus = "true";
  const timer = globalThis.setTimeout(() => delete target.dataset.notificationFocus, durationMs);
  return () => {
    globalThis.clearTimeout(timer);
    delete target.dataset.notificationFocus;
  };
}
