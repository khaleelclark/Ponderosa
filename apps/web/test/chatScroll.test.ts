import { describe, expect, it } from "vitest";
import {
  individualChatSenderLabel,
  isLongChatMessage,
  isChatNearBottom,
  replyFallbackText,
  scrollChatToBottom,
} from "../src/components/panes";

describe("scrollChatToBottom", () => {
  it("positions a chat viewport at the end of its content", () => {
    const viewport = { scrollHeight: 840, scrollTop: 125 };

    scrollChatToBottom(viewport);

    expect(viewport.scrollTop).toBe(840);
  });

  it("keeps following messages while the reader is near the bottom", () => {
    expect(isChatNearBottom({ clientHeight: 500, scrollHeight: 1_000, scrollTop: 460 })).toBe(true);
  });

  it("stops following messages when the reader scrolls up", () => {
    expect(isChatNearBottom({ clientHeight: 500, scrollHeight: 1_000, scrollTop: 400 })).toBe(false);
  });
});

describe("long message presentation", () => {
  it("identifies long prose and heavily structured messages for progressive disclosure", () => {
    expect(isLongChatMessage("short answer")).toBe(false);
    expect(isLongChatMessage("x".repeat(1_601))).toBe(true);
    expect(isLongChatMessage(Array.from({ length: 19 }, (_, index) => `line ${index}`).join("\n"))).toBe(true);
  });
});

describe("replyFallbackText", () => {
  it("keeps quoted context and degrades gracefully when unavailable", () => {
    expect(replyFallbackText("  original context  ")).toBe("original context");
    expect(replyFallbackText("   ")).toBe("Original message unavailable");
  });
});

describe("individualChatSenderLabel", () => {
  it("identifies messages sent by the current user", () => {
    expect(individualChatSenderLabel("user", "Great Smoky Mountains")).toBe("You");
  });

  it("uses the full agent title without truncating copyable identity", () => {
    const longTitle = "Agent — accessibility review / проверка / 完了 status with a very long delegated name";

    expect(individualChatSenderLabel("assistant", longTitle)).toBe(longTitle);
  });

  it("trims incidental whitespace and provides an accessible fallback", () => {
    expect(individualChatSenderLabel("assistant", "  Yellowstone  ")).toBe("Yellowstone");
    expect(individualChatSenderLabel("assistant", "   ")).toBe("Agent");
  });
});
