import { describe, expect, it } from "vitest";
import { createPonderosaTheme, ponderosaColorTokens } from "../src/theme";

describe("Ponderosa visual system", () => {
  it("uses bright natural surfaces in light mode", () => {
    const theme = createPonderosaTheme("light");

    expect(theme.palette.background.default).toBe("#FFFFFF");
    expect(theme.palette.background.paper).toBe("#FFFFFF");
    expect(theme.palette.text.primary).toBe("#10231C");
    expect(theme.palette.text.secondary).toBe("#53645D");
    expect(theme.palette.divider).toBe("#CDD5D1");
    expect(theme.palette.action.hover).toBe("#E1E6E3");
    expect(ponderosaColorTokens.light.sidebar).toBe("#E7ECE9");
  });

  it("uses layered forest-at-dusk surfaces without terminal black or neon green", () => {
    const theme = createPonderosaTheme("dark");

    expect(theme.palette.background.default).toBe("#121816");
    expect(theme.palette.background.paper).toBe("#1B2523");
    expect(theme.palette.text.primary).toBe("#E6E7DF");
    expect(theme.palette.text.secondary).toBe("#B2BBB4");
    expect(theme.palette.divider).toBe("#354542");
    expect(theme.palette.action.hover).toBe("#2B3735");
    expect(theme.palette.action.selected).toBe("#273633");
    expect(ponderosaColorTokens.dark.sidebar).toBe("#17221E");
    expect(theme.palette.background.default).not.toBe("#000000");
  });

  it("reserves semantic colors for agent state", () => {
    const theme = createPonderosaTheme("dark");

    expect(theme.palette.success.main).toBe("#57C77A");
    expect(theme.palette.warning.main).toBe("#D8B85A");
    expect(theme.palette.error.main).toBe("#D66A5C");
  });
});
