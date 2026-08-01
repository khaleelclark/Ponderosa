import { describe, expect, it, vi } from "vitest";
import { subscribeWebPushRecovery, webPushEnableBlockReason } from "../src/pushNotifications";

describe("Browser Push recovery", () => {
  it("keeps recoverable states explained while rechecking when Settings regains focus", () => {
    expect(webPushEnableBlockReason({
      kind: "permission_denied",
      message: "Permission is blocked.",
    })).toBe("Permission is blocked.");

    const listener = vi.fn();
    const unsubscribe = subscribeWebPushRecovery(listener);
    window.dispatchEvent(new Event("focus"));

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    window.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
