import { useCallback, useEffect, useRef, useState } from "react";

export function mobileOperationalStatus(state: string): string {
  if (["completed", "satisfied", "applied", "processed", "delivered", "recovered"].includes(state)) return "✅ Processed";
  if (["leased", "running", "activated", "recovering"].includes(state)) return "🔄 Active";
  if (["open", "pending", "queued", "waiting"].includes(state)) return "⏳ Waiting";
  if (["failed", "blocked", "cancelled", "expired", "outcome_unknown"].includes(state)) return "⚠️ Needs attention";
  return `• ${state.replaceAll("_", " ")}`;
}

export type MobileComposerScrollAction = "hide" | "show" | "none";

export function mobileComposerScrollAction({
  mobileViewport,
  hidden,
  initialized,
  transitionActive,
  nearBottom,
  previousScrollTop,
  scrollTop,
}: {
  mobileViewport: boolean;
  hidden: boolean;
  initialized: boolean;
  transitionActive: boolean;
  nearBottom: boolean;
  previousScrollTop: number;
  scrollTop: number;
}): MobileComposerScrollAction {
  if (!mobileViewport || transitionActive) return "none";
  if (!initialized) return nearBottom ? "none" : "hide";
  if (hidden) return nearBottom ? "show" : "none";
  return !nearBottom && scrollTop < previousScrollTop - 1 ? "hide" : "none";
}

/**
 * A transition-fenced mobile composer controller. Visibility changes resize the
 * chat viewport, so their resulting scroll events must not be mistaken for new
 * user intent or the composer oscillates between hidden and visible.
 */
export function useMobileComposerAutoHide(mobileViewport: boolean): {
  hidden: boolean;
  observeScroll(element: HTMLElement, nearBottom: boolean): void;
  showAtLatest(element?: HTMLElement | null): void;
  finishTransition(): void;
  reset(): void;
} {
  const [hidden, setHiddenState] = useState(false);
  const hiddenRef = useRef(false);
  const initializedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const scrollElementRef = useRef<HTMLElement>();
  const transitionRef = useRef<"hiding" | "showing">();
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const setHidden = useCallback((next: boolean) => {
    hiddenRef.current = next;
    setHiddenState(next);
  }, []);

  const clearTransition = useCallback(() => {
    if (unlockTimerRef.current !== undefined) globalThis.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = undefined;
    transitionRef.current = undefined;
  }, []);

  const beginTransition = useCallback((phase: "hiding" | "showing") => {
    transitionRef.current = phase;
    if (unlockTimerRef.current !== undefined) globalThis.clearTimeout(unlockTimerRef.current);
    // Reduced-motion users do not emit transitionend, so always provide a release.
    unlockTimerRef.current = globalThis.setTimeout(clearTransition, 300);
  }, [clearTransition]);

  const reset = useCallback(() => {
    clearTransition();
    initializedRef.current = false;
    lastScrollTopRef.current = 0;
    scrollElementRef.current = undefined;
    setHidden(false);
  }, [clearTransition, setHidden]);

  useEffect(() => {
    if (!mobileViewport) reset();
    return clearTransition;
  }, [clearTransition, mobileViewport, reset]);

  const observeScroll = useCallback((element: HTMLElement, nearBottom: boolean) => {
    scrollElementRef.current = element;
    const scrollTop = element.scrollTop;
    const action = mobileComposerScrollAction({
      mobileViewport,
      hidden: hiddenRef.current,
      initialized: initializedRef.current,
      transitionActive: transitionRef.current !== undefined,
      nearBottom,
      previousScrollTop: lastScrollTopRef.current,
      scrollTop,
    });
    lastScrollTopRef.current = scrollTop;
    initializedRef.current = true;
    if (action === "hide") {
      beginTransition("hiding");
      setHidden(true);
    } else if (action === "show") {
      beginTransition("showing");
      setHidden(false);
    }
  }, [beginTransition, mobileViewport, setHidden]);

  const showAtLatest = useCallback((element?: HTMLElement | null) => {
    const target = element ?? scrollElementRef.current;
    if (target) {
      scrollElementRef.current = target;
      target.scrollTop = target.scrollHeight;
      lastScrollTopRef.current = target.scrollTop;
    }
    initializedRef.current = true;
    if (hiddenRef.current) beginTransition("showing");
    setHidden(false);
  }, [beginTransition, setHidden]);

  const finishTransition = useCallback(() => {
    const target = scrollElementRef.current;
    if (transitionRef.current === "showing" && target) {
      target.scrollTop = target.scrollHeight;
      lastScrollTopRef.current = target.scrollTop;
    }
    // Keep the fence through the scroll event caused by the final re-anchor.
    globalThis.requestAnimationFrame(() => clearTransition());
  }, [clearTransition]);

  return { hidden, observeScroll, showAtLatest, finishTransition, reset };
}
