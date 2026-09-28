import { Box, Button } from "@mui/material";
import type { ReactNode } from "react";

/** Seeing a card is not the same as reviewing it. Keep the New marker until the
 * operator explicitly marks this exact notification reviewed. */
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
  return <Box
    data-notification-id={notificationId}
  >
    {children}
    {!acknowledged ? <Button size="small" onClick={event => {
      event.stopPropagation();
      onAcknowledge([notificationId]);
    }} sx={{ ml: 1, mb: 0.5 }}>Mark reviewed</Button> : null}
  </Box>;
}
