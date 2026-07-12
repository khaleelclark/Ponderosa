import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EmojiReactionPicker, isSingleEmoji, userReactionDirectMessage, userReactionMessage } from "../src/components/EmojiReactionPicker";
import { MasterChatMessage } from "../src/components/MasterChatView";

const renderMessage = (authorThreadId?: string) => renderToStaticMarkup(<MasterChatMessage
  message={{
    id: "m1",
    masterChatId: "room",
    role: authorThreadId ? "assistant" : "user",
    text: "Result",
    createdAt: "2026-07-12T00:00:00.000Z",
    authorThreadId,
  }}
  conversation="main"
  agentTitle={() => "Olympic"}
  agentIdForHandle={() => undefined}
  onOpenAgent={vi.fn()}
  onReply={vi.fn()}
  onDirectReply={vi.fn()}
  onReact={vi.fn()}
/>);

describe("user emoji reactions", () => {
  it("offers reactions only on agent-authored messages", () => {
    expect(renderMessage("olympic")).toContain('aria-label="React to Olympic with an emoji"');
    expect(renderMessage()).not.toContain("with an emoji");
  });

  it("accepts any single emoji grapheme and creates the exact direct-message text", () => {
    for (const emoji of ["👍", "🧑🏽‍🚀", "🇯🇵", "1️⃣"]) expect(isSingleEmoji(emoji)).toBe(true);
    for (const invalid of ["", "ok", "👍👍", "👍 thanks"]) expect(isSingleEmoji(invalid)).toBe(false);
    expect(userReactionMessage("🧑🏽‍🚀")).toBe("the user reacted with 🧑🏽‍🚀");
    expect(userReactionDirectMessage("author-agent", "🧑🏽‍🚀", "request-1")).toEqual({
      text: "the user reacted with 🧑🏽‍🚀",
      recipients: [{ agentId: "author-agent" }],
      idempotencyKey: "request-1",
    });
  });

  it("does not expose reaction state or agent reaction controls", () => {
    const html = renderToStaticMarkup(<EmojiReactionPicker recipientName="Olympic" onReact={vi.fn()} />);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("reaction count");
    expect(html).toContain("React to Olympic with an emoji");
  });
});
