import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browserTouchScrollDelta, mergeBrowserScrollInputs, normalizeBrowserWheelDelta } from "../src/browserInteraction";

describe("interactive browser input", () => {
  it("normalizes browser wheel modes and respects the server input bound", () => {
    expect(normalizeBrowserWheelDelta(3, 1, 720)).toBe(96);
    expect(normalizeBrowserWheelDelta(2, 2, 720)).toBe(1_440);
    expect(normalizeBrowserWheelDelta(10_000, 0, 720)).toBe(4_000);
  });

  it("coalesces wheel input instead of dropping movement during an in-flight request", () => {
    expect(mergeBrowserScrollInputs(
      { kind: "scroll", deltaX: 20, deltaY: 300 },
      { kind: "scroll", deltaX: -5, deltaY: 250 },
    )).toEqual({ kind: "scroll", deltaX: 15, deltaY: 550 });
  });

  it("turns touch dragging into page scrolling", () => {
    expect(browserTouchScrollDelta(300, 260)).toBe(80);
    expect(browserTouchScrollDelta(260, 300)).toBe(-80);
  });

  it("uses the same bounded queue and touch-safe viewport in Project and Run browser tabs", () => {
    for (const file of ["BrowserPanel.tsx", "ProjectBrowserDialog.tsx"]) {
      const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8");
      expect(source).toContain("mergeBrowserScrollInputs");
      expect(source).toContain("queuedScroll.current");
      expect(source).toContain("onPointerMove");
      expect(source).toContain("touchAction:");
      expect(source).toContain("1_500");
    }
    const runBrowser = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");
    expect(runBrowser).toContain('className="ponderosa-scroll"');
    expect(runBrowser).toContain('overflowY: "auto"');
  });
});
