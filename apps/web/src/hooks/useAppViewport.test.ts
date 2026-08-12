import { describe, expect, it } from "vitest";
import { appViewportBlockSize } from "./useAppViewport";

describe("appViewportBlockSize", () => {
  it("uses the lower edge of a resized visual viewport", () => {
    expect(appViewportBlockSize({
      innerHeight: 844,
      visualViewport: { height: 492, offsetTop: 0, scale: 1 },
    })).toBe(492);
  });

  it("includes browser panning while the keyboard keeps an input visible", () => {
    expect(appViewportBlockSize({
      innerHeight: 844,
      visualViewport: { height: 492, offsetTop: 126, scale: 1 },
    })).toBe(618);
  });

  it("falls back to the layout viewport during pinch zoom", () => {
    expect(appViewportBlockSize({
      innerHeight: 844,
      visualViewport: { height: 300, offsetTop: 100, scale: 2 },
    })).toBe(844);
  });
});
