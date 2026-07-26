import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightFocusedMessage } from "../src/messageFocus";

describe("notification message focus", () => {
  afterEach(() => vi.useRealTimers());

  it("adds and then removes the temporary focus marker", () => {
    vi.useFakeTimers();
    const target = { dataset: {} } as HTMLElement;
    highlightFocusedMessage(target, 1200);
    expect(target.dataset.notificationFocus).toBe("true");
    vi.advanceTimersByTime(1200);
    expect(target.dataset.notificationFocus).toBeUndefined();
  });
});
