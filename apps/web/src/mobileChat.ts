import { useCallback, useEffect, useRef, useState } from "react";

const MOBILE_COMPOSER_SCROLL_DELTA = 3;

export function mobileOperationalStatus(state: string): string {
  if (["completed", "satisfied", "applied", "processed", "delivered", "recovered"].includes(state)) return "✅ Processed";
  if (["leased", "running", "activated", "recovering"].includes(state)) return "🔄 Active";
  if (["open", "pending", "queued", "waiting"].includes(state)) return "⏳ Waiting";
  if (["failed", "blocked", "cancelled", "expired", "outcome_unknown"].includes(state)) return "⚠️ Needs attention";
  return `• ${state.replaceAll("_", " ")}`;
}

export function mobileComposerHiddenAfterScroll({
  currentTop,
  hidden,
  nearBottom,
  previousTop,
}: {
  currentTop: number;
  hidden: boolean;
  nearBottom: boolean;
  previousTop: number;
}): boolean {
  if (nearBottom) return false;
  if (currentTop <= previousTop - MOBILE_COMPOSER_SCROLL_DELTA) return true;
  if (currentTop >= previousTop + MOBILE_COMPOSER_SCROLL_DELTA) return false;
  return hidden;
}

export function useMobileComposerAutoHide(enabled: boolean): {
  composerHidden: boolean;
  onChatScroll(element: Pick<HTMLElement, "scrollTop">, nearBottom: boolean): void;
  revealComposer(): void;
} {
  const previousTop = useRef<number>();
  const [composerHidden, setComposerHidden] = useState(false);

  useEffect(() => {
    previousTop.current = undefined;
    if (!enabled) setComposerHidden(false);
  }, [enabled]);

  const onChatScroll = useCallback((element: Pick<HTMLElement, "scrollTop">, nearBottom: boolean) => {
    const currentTop = element.scrollTop;
    const previous = previousTop.current;
    previousTop.current = currentTop;
    if (!enabled) return;
    setComposerHidden((hidden) => previous === undefined
      ? !nearBottom
      : mobileComposerHiddenAfterScroll({ currentTop, hidden, nearBottom, previousTop: previous }));
  }, [enabled]);

  const revealComposer = useCallback(() => {
    previousTop.current = undefined;
    setComposerHidden(false);
  }, []);

  return { composerHidden, onChatScroll, revealComposer };
}
