import { describe, expect, it } from "vitest";
import { scrollChatToBottom } from "../src/components/panes";

describe("scrollChatToBottom", () => {
  it("positions a chat viewport at the end of its content", () => {
    const viewport = { scrollHeight: 840, scrollTop: 125 };

    scrollChatToBottom(viewport);

    expect(viewport.scrollTop).toBe(840);
  });
});
