import { useEffect, useRef, useState } from "react";

/** A browser can remain open without continuously consuming preview traffic. */
export function useBrowserSurfaceFocus(active: boolean, focusOnMount = false) {
  const root = useRef<HTMLDivElement>(null);
  const engaged = useRef(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      engaged.current = false;
      setFocused(false);
      setVisible(false);
      return;
    }
    const surface = () => root.current?.closest('[role="dialog"]') ?? root.current;
    const pageVisible = () => document.visibilityState === "visible";
    const syncFocus = () => {
      setVisible(pageVisible());
      setFocused(pageVisible() && document.hasFocus() && engaged.current);
    };
    const onEngagement = (event: Event) => {
      engaged.current = Boolean(surface()?.contains(event.target as Node));
      syncFocus();
    };
    document.addEventListener("focusin", onEngagement);
    document.addEventListener("pointerdown", onEngagement, true);
    document.addEventListener("visibilitychange", syncFocus);
    window.addEventListener("focus", syncFocus);
    window.addEventListener("blur", syncFocus);
    if (focusOnMount) {
      root.current?.focus({ preventScroll: true });
      // Opening the browser is itself an intentional foreground action. Some
      // dialog hosts leave BODY active until their focus transition settles.
      engaged.current = true;
    } else engaged.current = Boolean(surface()?.contains(document.activeElement));
    syncFocus();
    return () => {
      document.removeEventListener("focusin", onEngagement);
      document.removeEventListener("pointerdown", onEngagement, true);
      document.removeEventListener("visibilitychange", syncFocus);
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
    };
  }, [active, focusOnMount]);
  return { root, focused, visible };
}
