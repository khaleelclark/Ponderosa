import { Tooltip, type TooltipProps } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

// The latest sidebar trigger owns both the visible tooltip and any pending open.
let dismissCurrent: (() => void) | undefined;

export function SidebarTooltip(props: TooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const dispose = useRef<() => void>();
  const hovered = useRef(false);
  const focused = useRef(false);
  const dismiss = useCallback(() => {
    dispose.current?.();
    dispose.current = undefined;
    if (dismissCurrent === dismiss) dismissCurrent = undefined;
    setOpen(false);
  }, []);

  useEffect(() => () => {
    dispose.current?.();
    if (dismissCurrent === dismiss) dismissCurrent = undefined;
  }, [dismiss]);

  const show = (trigger: HTMLElement, touchPointer?: number) => {
    if (dismissCurrent === dismiss && touchPointer === undefined) return;
    dismissCurrent?.();
    dismissCurrent = dismiss;

    let shown = false;
    let leaveTimer: number | undefined;
    const timer = window.setTimeout(() => {
      shown = true;
      setOpen(true);
    }, touchPointer === undefined ? 100 : 700);
    const observer = new IntersectionObserver(([entry]) => {
      if (entry && (!entry.isIntersecting || getComputedStyle(trigger).visibility === "hidden")) dismiss();
    });
    observer.observe(trigger);
    const listeners = new AbortController();
    document.addEventListener("pointerdown", event => {
      if (!trigger.contains(event.target as Node)) dismiss();
    }, { capture: true, signal: listeners.signal });
    if (touchPointer !== undefined) {
      document.addEventListener("pointerup", event => {
        if (event.pointerId !== touchPointer) return;
        if (shown) leaveTimer = window.setTimeout(dismiss, 1500);
        else dismiss();
      }, { capture: true, signal: listeners.signal });
      document.addEventListener("pointercancel", event => {
        if (event.pointerId === touchPointer) dismiss();
      }, { capture: true, signal: listeners.signal });
    }
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      dismiss();
      event.stopPropagation();
    }, { capture: true, signal: listeners.signal });
    dispose.current = () => {
      window.clearTimeout(timer);
      window.clearTimeout(leaveTimer);
      observer.disconnect();
      observer.takeRecords();
      listeners.abort();
    };
  };
  const leave = () => {
    if (!hovered.current && !focused.current) dismiss();
  };

  return <Tooltip {...props} open={open} disableHoverListener disableFocusListener disableTouchListener disableInteractive
    slotProps={{ ...props.slotProps, transition: { timeout: 0 } }}
    onPointerDown={event => {
      if (event.pointerType === "touch") show(event.currentTarget, event.pointerId);
    }}
    onPointerEnter={event => {
      if (event.pointerType === "touch") return;
      hovered.current = true;
      show(event.currentTarget);
    }}
    onPointerLeave={event => {
      if (event.pointerType === "touch") return;
      hovered.current = false;
      leave();
    }}
    onFocus={event => {
      if (!event.currentTarget.matches(":focus-visible") || document.documentElement.hasAttribute("data-pointer-focus")) return;
      focused.current = true;
      show(event.currentTarget);
    }}
    onBlur={() => {
      focused.current = false;
      leave();
    }}
  />;
}
