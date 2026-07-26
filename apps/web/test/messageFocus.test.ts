import { describe, expect, it, vi } from "vitest";
import {
  projectedMessageIdForFocus,
  scrollFocusedMessageIntoView,
} from "../src/messageFocus";

describe("message focus", () => {
  it("resolves canonical communication IDs to projected messages", () => {
    expect(
      projectedMessageIdForFocus(
        [
          { id: "projected-1", communicationEventId: "communication-1" },
          { id: "projected-2" },
        ],
        "communication-1",
      ),
    ).toBe("projected-1");
  });

  it("scrolls only the chat region for a focused message", () => {
    const scrollTo = vi.fn();
    const container = {
      clientHeight: 600,
      scrollTop: 120,
      scrollTo,
      getBoundingClientRect: () => ({ top: 100 }),
    };
    const scrollIntoView = vi.fn();
    const target = {
      closest: vi.fn(() => container),
      getBoundingClientRect: () => ({ top: 400, height: 100 }),
      scrollIntoView,
    };

    scrollFocusedMessageIntoView(target as unknown as HTMLElement);

    expect(target.closest).toHaveBeenCalledWith(".chat-scroll-region");
    expect(scrollTo).toHaveBeenCalledWith({
      top: 170,
      behavior: "smooth",
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("aligns a message taller than the chat region to the top", () => {
    const scrollTo = vi.fn();
    const container = {
      clientHeight: 600,
      scrollTop: 120,
      scrollTo,
      getBoundingClientRect: () => ({ top: 100 }),
    };
    const target = {
      closest: vi.fn(() => container),
      getBoundingClientRect: () => ({ top: 400, height: 900 }),
      scrollIntoView: vi.fn(),
    };

    scrollFocusedMessageIntoView(
      target as unknown as HTMLElement,
      "auto",
    );

    expect(scrollTo).toHaveBeenCalledWith({
      top: 420,
      behavior: "auto",
    });
  });

  it("falls back to browser scrolling outside a chat region", () => {
    const scrollIntoView = vi.fn();
    const target = {
      closest: vi.fn(() => null),
      scrollIntoView,
    };

    scrollFocusedMessageIntoView(target as unknown as HTMLElement);

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });
});
