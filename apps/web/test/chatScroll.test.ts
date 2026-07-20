import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  ChatMessageBody,
  individualChatSenderLabel,
  chatMessageLayoutKey,
  isLongChatMessage,
  isChatNearBottom,
  replyFallbackText,
  revealChatScrollbar,
  ScrollToLatestButton,
  scrollChatToBottom,
} from "../src/components/panes";

afterEach(() => vi.useRealTimers());

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

  it("offers an explicit return to the latest message only after scrolling away", () => {
    expect(renderToStaticMarkup(createElement(ScrollToLatestButton, { visible: true, onClick: vi.fn() }))).toContain('aria-label="Jump to latest message"');
    expect(renderToStaticMarkup(createElement(ScrollToLatestButton, { visible: false, onClick: vi.fn() }))).toBe("");
  });

  it("keeps a stable layout key across cache-array refreshes and changes it only for rendered growth", () => {
    const message = { id: "message-1", text: "Hello", createdAt: "2026-07-18T00:00:00.000Z" };
    expect(chatMessageLayoutKey([message])).toBe(chatMessageLayoutKey([{ ...message }]));
    expect(chatMessageLayoutKey([message, { ...message, id: "message-2" }])).not.toBe(chatMessageLayoutKey([message]));
    expect(chatMessageLayoutKey([{ ...message, text: "Hello again" }])).not.toBe(chatMessageLayoutKey([message]));
  });
});

describe("scrollbar activity", () => {
  it("reveals the reserved scrollbar while scrolling and softens it after activity stops", () => {
    vi.useFakeTimers();
    const classes = new Set<string>();
    const viewport = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    } as unknown as HTMLElement;

    revealChatScrollbar(viewport);
    expect(classes.has("is-scrolling")).toBe(true);

    vi.advanceTimersByTime(699);
    expect(classes.has("is-scrolling")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(classes.has("is-scrolling")).toBe(false);
  });

  it("extends scrollbar visibility when scrolling continues", () => {
    vi.useFakeTimers();
    const classes = new Set<string>();
    const viewport = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    } as unknown as HTMLElement;

    revealChatScrollbar(viewport);
    vi.advanceTimersByTime(500);
    revealChatScrollbar(viewport);
    vi.advanceTimersByTime(500);
    expect(classes.has("is-scrolling")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(classes.has("is-scrolling")).toBe(false);
  });
});

describe("long message presentation", () => {
  it("waits for the doubled display-only boundaries before progressive disclosure", () => {
    expect(isLongChatMessage("short answer")).toBe(false);
    expect(isLongChatMessage("x".repeat(6_400))).toBe(false);
    expect(isLongChatMessage("x".repeat(6_401))).toBe(true);
    expect(isLongChatMessage("🌲".repeat(6_400))).toBe(false);
    expect(isLongChatMessage("🌲".repeat(6_401))).toBe(true);
    expect(isLongChatMessage(Array.from({ length: 72 }, (_, index) => `line ${index}`).join("\n"))).toBe(false);
    expect(isLongChatMessage(Array.from({ length: 73 }, (_, index) => `line ${index}`).join("\n"))).toBe(true);
    expect(renderToStaticMarkup(createElement(ChatMessageBody, { text: "x".repeat(6_401) }))).toContain("Show Full Message");
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
