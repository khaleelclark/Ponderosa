import { describe, expect, it } from "vitest";
import {
  BROWSER_FRAME_ACTIVE_INTERVAL_MS,
  BROWSER_FRAME_ACTIVE_WINDOW_MS,
  BROWSER_FRAME_IDLE_INTERVAL_MS,
  browserFrameRefreshDelay,
  browserTouchScrollDelta,
  createBrowserFrameScheduler,
  mergeBrowserScrollInputs,
  normalizeBrowserWheelDelta,
} from "../src/browserInteraction";

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

  it("serializes capture and decode work while adapting cadence after interaction", async () => {
    let now = 10_000;
    let captures = 0;
    let activeCaptures = 0;
    let maximumActiveCaptures = 0;
    const releases: Array<() => void> = [];
    const timers: Array<{ callback: () => void; delay: number; cancelled?: boolean }> = [];
    const scheduler = createBrowserFrameScheduler({
      now: () => now,
      capture: async () => {
        captures += 1;
        activeCaptures += 1;
        maximumActiveCaptures = Math.max(maximumActiveCaptures, activeCaptures);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeCaptures -= 1;
      },
      setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length - 1; },
      clearTimer: (timer) => { if (timers[timer]) timers[timer]!.cancelled = true; },
    });
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

    scheduler.setVisible(true);
    expect(captures).toBe(1);
    scheduler.requestInteractionRefresh();
    expect(captures).toBe(1);
    releases.shift()!();
    await flush();
    expect(timers.at(-1)).toMatchObject({ delay: 0 });
    timers.at(-1)!.callback();
    expect(captures).toBe(2);
    releases.shift()!();
    await flush();
    expect(timers.at(-1)).toMatchObject({ delay: BROWSER_FRAME_ACTIVE_INTERVAL_MS });
    expect(maximumActiveCaptures).toBe(1);

    now += BROWSER_FRAME_ACTIVE_WINDOW_MS + 1;
    timers.at(-1)!.callback();
    releases.shift()!();
    await flush();
    expect(timers.at(-1)).toMatchObject({ delay: BROWSER_FRAME_IDLE_INTERVAL_MS });
    scheduler.setVisible(false);
    expect(timers.at(-1)?.cancelled).toBe(true);
    scheduler.dispose();
  });

  it("uses a deterministic active and idle refresh policy", () => {
    expect(browserFrameRefreshDelay(999, 1_000)).toBe(BROWSER_FRAME_ACTIVE_INTERVAL_MS);
    expect(browserFrameRefreshDelay(1_000, 1_000)).toBe(BROWSER_FRAME_IDLE_INTERVAL_MS);
  });

});
