import { Box } from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

/** An action is reviewed only after this exact card is at least half visible in
 * a foreground document, or the operator deliberately focuses/activates it. */
export function NotificationAcknowledgementBoundary({
  notificationId,
  acknowledged,
  onAcknowledge,
  children,
}: {
  notificationId: string;
  acknowledged: boolean;
  onAcknowledge(notificationIds: readonly string[]): void;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>();
  const onAcknowledgeRef = useRef(onAcknowledge);
  onAcknowledgeRef.current = onAcknowledge;
  useEffect(() => {
    const element = ref.current;
    if (acknowledged || !element || typeof IntersectionObserver === "undefined") return;
    let atLeastHalfVisible = false;
    const report = () => {
      if (atLeastHalfVisible && document.visibilityState === "visible" && document.hasFocus()) {
        onAcknowledgeRef.current([notificationId]);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      atLeastHalfVisible = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5);
      report();
    }, { threshold: 0.5 });
    observer.observe(element);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [acknowledged, notificationId]);
  const acknowledge = () => {
    if (!acknowledged && document.visibilityState === "visible") {
      onAcknowledge([notificationId]);
    }
  };
  return <Box
    ref={ref}
    data-notification-id={notificationId}
    onFocusCapture={acknowledge}
    onClickCapture={acknowledge}
  >{children}</Box>;
}
