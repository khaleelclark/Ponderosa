import { useState } from "react";
import type { PointerEvent, ReactNode } from "react";

import { formatMessageTimestamp } from "../messageTimestamp";

export function MessageTimestamp({
  value,
  align = "end",
  desktopOnly = false,
}: {
  value: string;
  align?: "start" | "end";
  desktopOnly?: boolean;
}): JSX.Element | null {
  const timestamp = formatMessageTimestamp(value);
  if (!timestamp) {
    return null;
  }

  return (
    <time
      className={`MuiTypography-root MuiTypography-caption message-timestamp${desktopOnly ? " message-timestamp-desktop" : ""}`}
      data-align={align}
      dateTime={timestamp.dateTime}
      title={timestamp.title}
    >
      {timestamp.label}
    </time>
  );
}

/** Keeps desktop metadata with actions and revealed mobile time beside its message. */
export function MessageActionsAndTimestamp({
  actionAlign = "start",
  actions,
  footer,
  mobileTimestampAlign = "start",
  mobileTimestampRevealed = false,
  status,
  value,
  showTimestamp = true,
}: {
  actionAlign?: "start" | "end";
  actions?: ReactNode;
  footer?: ReactNode;
  mobileTimestampAlign?: "start" | "end";
  mobileTimestampRevealed?: boolean;
  status?: ReactNode;
  value: string;
  showTimestamp?: boolean;
}): JSX.Element {
  const [touchRevealed, setTouchRevealed] = useState(false);
  const revealOnTouch = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") setTouchRevealed(true);
  };
  const actionButtons = <div className="MuiBox-root chat-message-action-buttons">{actions}</div>;
  return <div className={`MuiBox-root chat-message-actions${touchRevealed ? " revealed" : ""}`} onPointerDown={revealOnTouch}>
    {mobileTimestampRevealed ? <div className="MuiBox-root chat-message-mobile-time">
      <MessageTimestamp value={value} align={mobileTimestampAlign} />
    </div> : null}
    <div className="MuiStack-root chat-message-actions-row">
      {actionAlign === "start" ? actionButtons : null}
      {footer ? <div className="MuiBox-root chat-message-footer">{footer}</div> : <div className="MuiBox-root chat-message-footer-spacer" />}
      {actionAlign === "end" ? <div className="MuiStack-root chat-message-actions-end">
        {actionButtons}
        {status ? <div className="MuiBox-root chat-message-status chat-message-status-end">{status}</div> : showTimestamp ? <MessageTimestamp value={value} desktopOnly /> : null}
      </div> : status ? <div className="MuiBox-root chat-message-status">{status}</div> : showTimestamp ? <MessageTimestamp value={value} desktopOnly /> : null}
    </div>
    {status && showTimestamp ? <div className="MuiBox-root chat-message-status-time"><MessageTimestamp value={value} desktopOnly /></div> : null}
  </div>;
}
