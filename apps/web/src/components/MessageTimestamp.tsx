import { Box, Stack, Typography } from "@mui/material";
import { useState } from "react";
import type { PointerEvent, ReactNode } from "react";

export interface FormattedTimestamp {
  dateTime: string;
  label: string;
  title: string;
}

export interface TimestampFormatOptions {
  locale?: string;
  timeZone?: string;
}

/**
 * Keep chat time labels absolute: relative labels become inaccurate while an
 * open conversation is idle and obscure the calendar date at day boundaries.
 */
export function formatMessageTimestamp(
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

export function MessageTimestamp({ value }: { value: string }): JSX.Element | null {
  const timestamp = formatMessageTimestamp(value);
  if (!timestamp) {
    return null;
  }

  return (
    <Typography
      component="time"
      dateTime={timestamp.dateTime}
      title={timestamp.title}
      variant="caption"
      sx={{
        display: "block",
        color: "inherit",
        maxWidth: "100%",
        mt: 0,
        overflowWrap: "anywhere",
        textAlign: "end",
      }}
    >
      {timestamp.label}
    </Typography>
  );
}

/** Keeps every chat surface's timestamp after its message actions. */
export function MessageActionsAndTimestamp({
  actions,
  value,
}: {
  actions?: ReactNode;
  value: string;
}): JSX.Element {
  const [touchRevealed, setTouchRevealed] = useState(false);
  const revealOnTouch = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") setTouchRevealed(true);
  };
  return <Stack direction="row" spacing={0.25} className={touchRevealed ? "chat-message-actions revealed" : "chat-message-actions"} onPointerDown={revealOnTouch} sx={{ alignItems: "center", mt: 0.25, minHeight: 28, "& .MuiIconButton-root": { p: 0.35, minWidth: 28, minHeight: 28 }, "& .MuiSvgIcon-root": { fontSize: "1rem" } }}>
    <Box className="chat-message-action-buttons" sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>{actions}</Box>
    <Box sx={{ flex: 1 }} />
    <MessageTimestamp value={value} />
  </Stack>;
}
