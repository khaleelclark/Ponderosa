import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimedChatLiveBanner } from "../src/components/chat/ChatLiveBanner";

afterEach(() => {
  vi.useRealTimers();
});

describe("TimedChatLiveBanner", () => {
  it("uses the live-status pill and disappears after three seconds", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <TimedChatLiveBanner onDismiss={onDismiss}>
        Direct message sent to Spruce.
      </TimedChatLiveBanner>,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Direct message sent to Spruce.",
    );
    act(() => vi.advanceTimersByTime(2_999));
    expect(screen.queryByRole("status")).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
