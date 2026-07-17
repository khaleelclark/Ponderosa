import { describe, expect, it } from "vitest";
import { createPonderosaTheme } from "../src/theme";

function luminance(color: string): number {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Expected an opaque hex color, received ${color}`);
  const channels = match.slice(1).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe("dark theme contrast", () => {
  const theme = createPonderosaTheme("dark");
  const surfaces = [theme.palette.background.default, theme.palette.background.paper];

  it.each([
    ["primary text", theme.palette.text.primary],
    ["secondary text", theme.palette.text.secondary],
  ])("keeps %s at WCAG AA contrast on every surface", (_label, foreground) => {
    for (const background of surfaces) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ["muted and disabled text", theme.palette.text.disabled],
    ["focus and active accent", theme.palette.primary.light],
  ])("keeps %s distinguishable at the supplemental-content threshold", (_label, foreground) => {
    for (const background of surfaces) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
    }
  });

  it("allows quiet separators to recede behind content", () => {
    for (const background of surfaces) {
      expect(contrastRatio(theme.palette.divider, background)).toBeGreaterThan(1);
      expect(contrastRatio(theme.palette.divider, background)).toBeLessThan(3);
    }
  });

  it("uses the stricter threshold for automatic foreground selection", () => {
    expect(theme.palette.contrastThreshold).toBe(4.5);
  });
});
