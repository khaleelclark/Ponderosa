import { describe, expect, it } from "vitest";
import { isChatNearBottom, replyFallbackText, scrollChatToBottom } from "../src/components/panes";

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

describe("replyFallbackText", () => {
  it("keeps quoted context and degrades gracefully when unavailable", () => {
    expect(replyFallbackText("  original context  ")).toBe("original context");
    expect(replyFallbackText("   ")).toBe("Original message unavailable");
  });
});
