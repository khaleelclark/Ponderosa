import { Typography } from "@mui/material";

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
        maxWidth: "100%",
        mt: 0.5,
        opacity: 0.78,
        overflowWrap: "anywhere",
        textAlign: "end",
      }}
    >
      {timestamp.label}
    </Typography>
  );
}
