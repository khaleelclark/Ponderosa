interface FormattedTimestamp {
  dateTime: string;
  label: string;
  title: string;
}

// Reuse the tab's default locale/time zone instead of constructing two formatters per message.
let formatters: { label: Intl.DateTimeFormat; title: Intl.DateTimeFormat } | undefined;

/** Absolute Chat labels remain accurate across idle periods and day boundaries. */
export function formatMessageTimestamp(value: string): FormattedTimestamp | undefined {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return undefined;
  formatters ??= {
    label: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
    title: new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }),
  };
  return {
    dateTime: instant.toISOString(),
    label: formatters.label.format(instant),
    title: formatters.title.format(instant),
  };
}
