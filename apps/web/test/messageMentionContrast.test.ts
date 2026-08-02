import { getContrastRatio } from "@mui/material/styles";
import { describe, expect, it } from "vitest";
import { messageMentionSx } from "../src/components/chat/ChatMessages";
import { createPonderosaTheme } from "../src/theme";

describe("message mention contrast", () => {
  it("uses theme tokens with readable contrast in light and dark modes", () => {
    expect(messageMentionSx.color).toBe("primary.main");
    expect(messageMentionSx.bgcolor).toBe("action.selected");

    for (const mode of ["light", "dark"] as const) {
      const theme = createPonderosaTheme(mode);
      expect(getContrastRatio(
        theme.palette.primary.main,
        theme.palette.action.selected,
      )).toBeGreaterThanOrEqual(4.5);
    }
  });
});
