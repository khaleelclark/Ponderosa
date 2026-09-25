import { useEffect, useRef, useState } from "react";

/** A browser can remain open without continuously consuming preview traffic. */
export function useBrowserSurfaceFocus(active: boolean, focusOnMount = false) {
  const root = useRef<HTMLDivElement>(null);
  const engaged = useRef(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!active) {
      engaged.current = false;
      setFocused(false);
      return;
    }
    const surface = () => root.current?.closest('[role="dialog"]') ?? root.current;
    const visible = () => document.visibilityState === "visible" && document.hasFocus();
    const syncFocus = () => setFocused(visible() && engaged.current);
    const onFocusIn = (event: FocusEvent) => {
      engaged.current = Boolean(surface()?.contains(event.target as Node));
      syncFocus();
    };
    const onPointerDown = (event: PointerEvent) => {
      engaged.current = Boolean(surface()?.contains(event.target as Node));
      syncFocus();
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
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
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("visibilitychange", syncFocus);
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
    };
  }, [active, focusOnMount]);
  return { root, focused };
}
