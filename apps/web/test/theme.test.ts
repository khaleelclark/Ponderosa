import { describe, expect, it } from "vitest";
import { createPonderosaTheme } from "../src/theme";

describe("Ponderosa visual system", () => {
  it("uses bright natural surfaces in light mode", () => {
    const theme = createPonderosaTheme("light");

    expect(theme.palette.background.default).toBe("#F7F9F8");
    expect(theme.palette.background.paper).toBe("#F2F5F3");
    expect(theme.palette.text.primary).toBe("#10231C");
    expect(theme.palette.text.secondary).toBe("#53645D");
    expect(theme.palette.divider).toBe("#CDD5D1");
    expect(theme.palette.action.hover).toBe("#E1E6E3");
  });

  it("uses layered forest-at-dusk surfaces without terminal black or neon green", () => {
    const theme = createPonderosaTheme("dark");

    expect(theme.palette.background.default).toBe("#101312");
    expect(theme.palette.background.paper).toBe("#1C211F");
    expect(theme.palette.text.primary).toBe("#E7E9E6");
    expect(theme.palette.text.secondary).toBe("#B4BAB6");
    expect(theme.palette.divider).toBe("#383F3C");
    expect(theme.palette.action.hover).toBe("#303633");
    expect(theme.palette.action.selected).toBe("#263A30");
    expect(theme.palette.background.default).not.toBe("#000000");
  });

  it("reserves semantic colors for agent state", () => {
    const theme = createPonderosaTheme("dark");

    expect(theme.palette.success.main).toBe("#57C77A");
    expect(theme.palette.warning.main).toBe("#D8B85A");
    expect(theme.palette.error.main).toBe("#D66A5C");
  });
});
