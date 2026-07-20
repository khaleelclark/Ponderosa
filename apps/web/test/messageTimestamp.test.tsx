import { renderToStaticMarkup } from "react-dom/server";
import { createTheme, getContrastRatio } from "@mui/material/styles";
import { describe, expect, it } from "vitest";
import { formatMessageTimestamp, MessageActionsAndTimestamp, MessageTimestamp } from "../src/components/MessageTimestamp";
import { UserMessageLabel } from "../src/components/panes";

describe("message timestamps", () => {
  it("shows an absolute local date and time while preserving the exact instant", () => {
    expect(formatMessageTimestamp("2026-07-11T14:05:06.789Z", { locale: "en-US", timeZone: "UTC" })).toEqual({
      dateTime: "2026-07-11T14:05:06.789Z",
      label: "Jul 11, 2026, 2:05 PM",
      title: "Saturday, July 11, 2026 at 2:05:06 PM UTC",
    });
  });

  it("formats the same instant in the viewer's requested locale and timezone", () => {
    expect(formatMessageTimestamp("2026-01-01T00:30:00Z", { locale: "en-GB", timeZone: "America/Los_Angeles" })?.label)
      .toBe("31 Dec 2025, 16:30");
  });

  it("handles a daylight-saving transition without changing the machine instant", () => {
    const before = formatMessageTimestamp("2026-03-08T09:30:00Z", { locale: "en-US", timeZone: "America/Los_Angeles" });
    const after = formatMessageTimestamp("2026-03-08T10:30:00Z", { locale: "en-US", timeZone: "America/Los_Angeles" });

    expect(before?.label).toBe("Mar 8, 2026, 1:30 AM");
    expect(after?.label).toBe("Mar 8, 2026, 3:30 AM");
    expect(after?.dateTime).toBe("2026-03-08T10:30:00.000Z");
  });

  it("omits invalid values instead of emitting an invalid time element", () => {
    expect(formatMessageTimestamp("not-a-date", { locale: "en-US", timeZone: "UTC" })).toBeUndefined();
    expect(renderToStaticMarkup(<MessageTimestamp value="not-a-date" />)).toBe("");
  });

  it("renders visible text and native machine-readable time semantics", () => {
    const markup = renderToStaticMarkup(<MessageTimestamp value="2026-07-11T14:05:06.789Z" />);

    expect(markup).toContain("<time");
    // React's server serializer preserves the dateTime prop casing. HTML
    // attribute names are case-insensitive and browsers expose it as datetime.
    expect(markup).toMatch(/date[Tt]ime="2026-07-11T14:05:06\.789Z"/);
    expect(markup).toMatch(/>[^<]*2026[^<]*</);
    expect(markup).toContain("max-width:100%");
    expect(markup).toContain("overflow-wrap:anywhere");
    expect(markup).toContain("color:inherit");
    expect(markup).not.toContain("opacity:");
  });

  it("keeps the calendar date visible in compact Agent identity timestamps", () => {
    const markup = renderToStaticMarkup(<MessageTimestamp value="2026-07-11T14:05:06.789Z" compact />);

    expect(markup).toContain('data-compact="true"');
    expect(markup).toMatch(/>[^<]*2026[^<]*</);
    expect(markup).not.toMatch(/>\s*2:05 PM\s*</);
  });

  it("places the user's dated timestamp beside the identity just like an Agent message", () => {
    const markup = renderToStaticMarkup(<UserMessageLabel
      profile={{ displayName: "User", handle: "operator", avatarId: "default-user" }}
      createdAt="2026-07-11T14:05:06.789Z"
    />);

    expect(markup.indexOf("User")).toBeLessThan(markup.indexOf("<time"));
    expect(markup).toMatch(/<time[^>]*>[^<]*2026[^<]*<\/time>/);
  });

  it.each(["light", "dark"] as const)(
    "inherits timestamp colors with WCAG AA contrast in %s manager and agent bubbles",
    (mode) => {
      const theme = createTheme({ palette: { mode } });

      expect(getContrastRatio(theme.palette.primary.contrastText, theme.palette.primary.main)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(theme.palette.text.primary, theme.palette.background.paper)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("places the timestamp after the complete action region on every chat surface", () => {
    const markup = renderToStaticMarkup(
      <MessageActionsAndTimestamp
        value="2026-07-11T14:05:06.789Z"
        actions={<div><button>Reply</button><button>Reply Directly</button></div>}
      />,
    );

    expect(markup.indexOf("Reply")).toBeLessThan(markup.indexOf("Reply Directly"));
    expect(markup.indexOf("Reply Directly")).toBeLessThan(markup.indexOf("<time"));
  });

  it("keeps delivery status right of actions and the timestamp beneath it", () => {
    const markup = renderToStaticMarkup(
      <MessageActionsAndTimestamp
        value="2026-07-11T14:05:06.789Z"
        actions={<button>Copy</button>}
        status={<button>Processed by Cabrillo</button>}
      />,
    );
    expect(markup.indexOf("Copy")).toBeLessThan(markup.indexOf("Processed by Cabrillo"));
    expect(markup.indexOf("Processed by Cabrillo")).toBeLessThan(markup.indexOf("<time"));
  });
});
