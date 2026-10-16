/** Resolve either a surface-local projected ID or its canonical communication ID. */
export function projectedMessageIdForFocus(
  messages: ReadonlyArray<{ id: string; communicationEventId?: string }>,
  focusId: string | undefined,
): string | undefined {
  if (!focusId) return undefined;
  return messages.find((message) => message.id === focusId || message.communicationEventId === focusId)?.id;
}

/** Scroll an exact deep-linked message inside its chat region without moving
 * overflow-hidden workspace ancestors. Element.scrollIntoView() scrolls every
 * containing scroll box, which can translate the complete chat surface and
 * expose an empty block below it. */
export function scrollFocusedMessageIntoView(
  target: HTMLElement,
  behavior: ScrollBehavior = "smooth",
): void {
  const container = target.closest<HTMLElement>(".chat-scroll-region");
  if (!container) {
    target.scrollIntoView({ behavior, block: "center" });
    return;
  }

  const targetRect = target.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const targetTop =
    container.scrollTop + targetRect.top - containerRect.top;
  const centeredOffset =
    targetRect.height < container.clientHeight
      ? (container.clientHeight - targetRect.height) / 2
      : 0;
  container.scrollTo({
    top: targetTop - centeredOffset,
    behavior,
  });
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
