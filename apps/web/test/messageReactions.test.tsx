import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EmojiReactionPicker, isSingleEmoji, userReactionMessage } from "../src/components/EmojiReactionPicker";
import { MasterChatMessage } from "../src/components/MasterChatView";

const renderMessage = (authorThreadId?: string) => renderToStaticMarkup(<MasterChatMessage
  message={{
    id: "m1",
    masterChatId: "room",
    role: authorThreadId ? "assistant" : "user",
    text: "Result",
    createdAt: "2026-07-12T00:00:00.000Z",
    authorThreadId,
    communicationEventId: authorThreadId ? "communication-1" : undefined,
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

  it("accepts any single emoji grapheme and creates the exact private notification text", () => {
    for (const emoji of ["👍", "🧑🏽‍🚀", "🇯🇵", "1️⃣"]) expect(isSingleEmoji(emoji)).toBe(true);
    for (const invalid of ["", "ok", "👍👍", "👍 thanks"]) expect(isSingleEmoji(invalid)).toBe(false);
    expect(userReactionMessage("🧑🏽‍🚀")).toBe("the user reacted with 🧑🏽‍🚀");
  });

  it("shows the user's emoji on the reacted-to message", () => {
    const html = renderToStaticMarkup(<MasterChatMessage
      message={{
        id: "m1", communicationEventId: "communication-1", masterChatId: "room", role: "assistant",
        text: "Result", createdAt: "2026-07-12T00:00:00.000Z", authorThreadId: "olympic",
        reactions: [{ emoji: "🧑🏽‍🚀", count: 1, reactedByCurrentActor: true, reactors: [{ kind: "manager" }] }],
      }}
      conversation="main" agentTitle={() => "Olympic"} agentIdForHandle={() => undefined}
      onOpenAgent={vi.fn()} onReply={vi.fn()} onDirectReply={vi.fn()} onReact={vi.fn()}
    />);
    expect(html).toContain('aria-label="Message reactions"');
    expect(html).toContain("🧑🏽‍🚀");
  });
});
