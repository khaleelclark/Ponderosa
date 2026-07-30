import { useCallback, useEffect, useRef, useState } from "react";

export function mobileOperationalStatus(state: string): string {
  if (["completed", "satisfied", "applied", "processed", "delivered", "recovered"].includes(state)) return "✅ Processed";
  if (["leased", "running", "activated", "recovering"].includes(state)) return "🔄 Active";
  if (["open", "pending", "queued", "waiting"].includes(state)) return "⏳ Waiting";
  if (["failed", "blocked", "cancelled", "expired", "outcome_unknown"].includes(state)) return "⚠️ Needs attention";
  return `• ${state.replaceAll("_", " ")}`;
}

const MOBILE_COMPOSER_HIDE_TRAVEL = 24;
const MOBILE_COMPOSER_TRUE_BOTTOM = 8;
const MOBILE_COMPOSER_SHOW_DELAY = 100;
const MOBILE_SCROLL_INTENT_WINDOW = 1_200;
const MOBILE_VIEWPORT_SETTLE_DELAY = 300;

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
  const showTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const viewportSettleTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const viewportResizeUntilRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const upwardTravelRef = useRef(0);
  const detachScrollIntentRef = useRef<() => void>();

  const setHidden = useCallback((next: boolean) => {
    hiddenRef.current = next;
    setHiddenState(next);
  }, []);

  const clearTransition = useCallback(() => {
    if (unlockTimerRef.current !== undefined) globalThis.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = undefined;
    transitionRef.current = undefined;
  }, []);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== undefined) {
      globalThis.clearTimeout(showTimerRef.current);
    }
    showTimerRef.current = undefined;
  }, []);

  const clearViewportSettle = useCallback(() => {
    if (viewportSettleTimerRef.current !== undefined) {
      globalThis.clearTimeout(viewportSettleTimerRef.current);
    }
    viewportSettleTimerRef.current = undefined;
    viewportResizeUntilRef.current = 0;
  }, []);

  const detachScrollIntent = useCallback(() => {
    detachScrollIntentRef.current?.();
    detachScrollIntentRef.current = undefined;
    userScrollIntentUntilRef.current = 0;
  }, []);

  const beginTransition = useCallback((phase: "hiding" | "showing") => {
    transitionRef.current = phase;
    if (unlockTimerRef.current !== undefined) globalThis.clearTimeout(unlockTimerRef.current);
    // Reduced-motion users do not emit transitionend, so always provide a release.
    unlockTimerRef.current = globalThis.setTimeout(clearTransition, 300);
  }, [clearTransition]);

  const reset = useCallback(() => {
    clearTransition();
    clearShowTimer();
    clearViewportSettle();
    detachScrollIntent();
    initializedRef.current = false;
    lastScrollTopRef.current = 0;
    scrollElementRef.current = undefined;
    upwardTravelRef.current = 0;
    setHidden(false);
  }, [
    clearShowTimer,
    clearTransition,
    clearViewportSettle,
    detachScrollIntent,
    setHidden,
  ]);

  useEffect(() => {
    if (!mobileViewport) reset();
    return () => {
      clearTransition();
      clearShowTimer();
      clearViewportSettle();
      detachScrollIntent();
    };
  }, [
    clearShowTimer,
    clearTransition,
    clearViewportSettle,
    detachScrollIntent,
    mobileViewport,
    reset,
  ]);

  useEffect(() => {
    if (!mobileViewport || typeof window === "undefined") return;
    const markViewportResize = () => {
      clearShowTimer();
      upwardTravelRef.current = 0;
      viewportResizeUntilRef.current =
        Date.now() + MOBILE_VIEWPORT_SETTLE_DELAY;
      if (viewportSettleTimerRef.current !== undefined) {
        globalThis.clearTimeout(viewportSettleTimerRef.current);
      }
      viewportSettleTimerRef.current = globalThis.setTimeout(() => {
        viewportSettleTimerRef.current = undefined;
        viewportResizeUntilRef.current = 0;
      }, MOBILE_VIEWPORT_SETTLE_DELAY);
    };
    window.visualViewport?.addEventListener("resize", markViewportResize);
    window.addEventListener("resize", markViewportResize);
    return () => {
      window.visualViewport?.removeEventListener("resize", markViewportResize);
      window.removeEventListener("resize", markViewportResize);
    };
  }, [clearShowTimer, mobileViewport]);

  const observeScrollIntent = useCallback((element: HTMLElement) => {
    if (scrollElementRef.current === element && detachScrollIntentRef.current) {
      return;
    }
    detachScrollIntent();
    scrollElementRef.current = element;
    const markIntent = () => {
      userScrollIntentUntilRef.current =
        Date.now() + MOBILE_SCROLL_INTENT_WINDOW;
    };
    element.addEventListener("pointerdown", markIntent, { passive: true });
    element.addEventListener("touchstart", markIntent, { passive: true });
    element.addEventListener("touchmove", markIntent, { passive: true });
    element.addEventListener("wheel", markIntent, { passive: true });
    detachScrollIntentRef.current = () => {
      element.removeEventListener("pointerdown", markIntent);
      element.removeEventListener("touchstart", markIntent);
      element.removeEventListener("touchmove", markIntent);
      element.removeEventListener("wheel", markIntent);
    };
  }, [detachScrollIntent]);

  const showAfterStableBottom = useCallback((element: HTMLElement) => {
    if (showTimerRef.current !== undefined) return;
    const check = () => {
      showTimerRef.current = undefined;
      const distanceFromBottom =
        element.scrollHeight - element.clientHeight - element.scrollTop;
      if (
        !mobileViewport ||
        !hiddenRef.current ||
        scrollElementRef.current !== element ||
        distanceFromBottom > MOBILE_COMPOSER_TRUE_BOTTOM
      ) {
        return;
      }
      if (
        transitionRef.current !== undefined ||
        Date.now() < viewportResizeUntilRef.current
      ) {
        showTimerRef.current = globalThis.setTimeout(
          check,
          MOBILE_COMPOSER_SHOW_DELAY,
        );
        return;
      }
      beginTransition("showing");
      setHidden(false);
    };
    showTimerRef.current = globalThis.setTimeout(
      check,
      MOBILE_COMPOSER_SHOW_DELAY,
    );
  }, [beginTransition, mobileViewport, setHidden]);

  const observeScroll = useCallback((element: HTMLElement, nearBottom: boolean) => {
    observeScrollIntent(element);
    const scrollTop = element.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    const initialized = initializedRef.current;
    lastScrollTopRef.current = scrollTop;
    initializedRef.current = true;
    if (!mobileViewport) return;
    if (!initialized) {
      if (!nearBottom) {
        beginTransition("hiding");
        setHidden(true);
      }
      return;
    }
    if (Date.now() < viewportResizeUntilRef.current) {
      clearShowTimer();
      upwardTravelRef.current = 0;
      return;
    }
    const distanceFromBottom =
      element.scrollHeight - element.clientHeight - scrollTop;
    if (hiddenRef.current) {
      upwardTravelRef.current = 0;
      if (distanceFromBottom <= MOBILE_COMPOSER_TRUE_BOTTOM) {
        showAfterStableBottom(element);
      } else {
        clearShowTimer();
      }
      return;
    }
    clearShowTimer();
    if (transitionRef.current !== undefined || nearBottom) {
      upwardTravelRef.current = 0;
      return;
    }
    const upwardDelta = previousScrollTop - scrollTop;
    if (
      upwardDelta <= 0 ||
      Date.now() > userScrollIntentUntilRef.current
    ) {
      upwardTravelRef.current = 0;
      return;
    }
    upwardTravelRef.current += upwardDelta;
    if (upwardTravelRef.current < MOBILE_COMPOSER_HIDE_TRAVEL) return;
    upwardTravelRef.current = 0;
    const activeElement =
      typeof document === "undefined" ? undefined : document.activeElement;
    if (
      typeof HTMLElement !== "undefined" &&
      activeElement instanceof HTMLElement &&
      activeElement.closest(".ponderosa-composer")
    ) {
      activeElement.blur();
    }
    beginTransition("hiding");
    setHidden(true);
  }, [
    beginTransition,
    clearShowTimer,
    mobileViewport,
    observeScrollIntent,
    setHidden,
    showAfterStableBottom,
  ]);

  const showAtLatest = useCallback((element?: HTMLElement | null) => {
    const target = element ?? scrollElementRef.current;
    clearShowTimer();
    upwardTravelRef.current = 0;
    if (target) {
      observeScrollIntent(target);
      target.scrollTop = target.scrollHeight;
      lastScrollTopRef.current = target.scrollTop;
    }
    initializedRef.current = true;
    if (hiddenRef.current) beginTransition("showing");
    setHidden(false);
  }, [
    beginTransition,
    clearShowTimer,
    observeScrollIntent,
    setHidden,
  ]);

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
