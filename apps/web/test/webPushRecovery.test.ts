import { describe, expect, it, vi } from "vitest";
import { subscribeWebPushRecovery, webPushEnableBlockReason } from "../src/pushNotifications";

describe("Browser Push recovery", () => {
  it("keeps recoverable states explained while rechecking when Settings regains focus", () => {
    vi.useFakeTimers();
    expect(webPushEnableBlockReason({
      kind: "permission_denied",
      message: "Permission is blocked.",
    })).toBe("Permission is blocked.");

    const listener = vi.fn();
    const unsubscribe = subscribeWebPushRecovery(listener);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    vi.runAllTimers();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    window.dispatchEvent(new Event("focus"));
    vi.runAllTimers();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
