import { Box, Stack, Typography } from "@mui/material";
import { useState } from "react";
import type { PointerEvent, ReactNode } from "react";

interface FormattedTimestamp {
  dateTime: string;
  label: string;
  title: string;
}

interface TimestampFormatOptions {
  locale?: string;
  timeZone?: string;
}

/**
 * Keep chat time labels absolute: relative labels become inaccurate while an
 * open conversation is idle and obscure the calendar date at day boundaries.
 */
function formatMessageTimestamp(
  value: string,
  options: TimestampFormatOptions = {},
): FormattedTimestamp | undefined {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    return undefined;
  }

  const commonOptions = options.timeZone ? { timeZone: options.timeZone } : {};
  return {
    dateTime: instant.toISOString(),
    label: new Intl.DateTimeFormat(options.locale, {
      ...commonOptions,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(instant),
    title: new Intl.DateTimeFormat(options.locale, {
      ...commonOptions,
      dateStyle: "full",
      timeStyle: "long",
    }).format(instant),
  };
}

export function MessageTimestamp({
  value,
  compact = false,
  align = "end",
  desktopOnly = false,
}: {
  value: string;
  compact?: boolean;
  align?: "start" | "end";
  desktopOnly?: boolean;
}): JSX.Element | null {
  const timestamp = formatMessageTimestamp(value);
  if (!timestamp) {
    return null;
  }

  return (
    <Typography
      component="time"
      dateTime={timestamp.dateTime}
      data-compact={compact ? "true" : undefined}
      title={timestamp.title}
      variant="caption"
      sx={{
        display: desktopOnly ? { xs: "none", sm: "block" } : "block",
        color: "inherit",
        maxWidth: "100%",
        mt: 0,
        overflowWrap: "anywhere",
        textAlign: align,
      }}
    >
      {timestamp.label}
    </Typography>
  );
}

/** Keeps desktop metadata with actions and revealed mobile time beside its message. */
export function MessageActionsAndTimestamp({
  actions,
  footer,
  mobileTimestampAlign = "start",
  mobileTimestampRevealed = false,
  status,
  value,
  showTimestamp = true,
}: {
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
  return <Box className={touchRevealed ? "chat-message-actions revealed" : "chat-message-actions"} onPointerDown={revealOnTouch} sx={{ mt: 0.25, minWidth: 0, minHeight: { xs: 44, sm: 28 }, "& .MuiIconButton-root": { p: { xs: 1, sm: 0.35 }, minWidth: { xs: 44, sm: 28 }, minHeight: { xs: 44, sm: 28 } }, "& .MuiSvgIcon-root": { fontSize: "1rem" } }}>
    {mobileTimestampRevealed ? <Box data-mobile-message-timestamp sx={{ display: { xs: "block", sm: "none" }, color: "text.secondary", mb: 0.25 }}>
      <MessageTimestamp value={value} compact align={mobileTimestampAlign} />
    </Box> : null}
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ alignItems: "flex-start", minWidth: 0, minHeight: { xs: 44, sm: 28 } }}>
      <Box className="chat-message-action-buttons" sx={{ display: "flex", flexShrink: 0, minWidth: 0, flexWrap: "wrap", alignItems: "center", gap: 0.25 }}>{actions}</Box>
      {footer ? <Box sx={{ flex: 1, minWidth: 0 }}>{footer}</Box> : <Box sx={{ flex: 1 }} />}
      {status ? <Box sx={{ display: "flex", minWidth: 0, justifyContent: "flex-end" }}>{status}</Box> : showTimestamp ? <MessageTimestamp value={value} desktopOnly /> : null}
    </Stack>
    {status && showTimestamp ? <Box sx={{ color: "text.secondary", mt: 0.1 }}><MessageTimestamp value={value} desktopOnly /></Box> : null}
  </Box>;
}
