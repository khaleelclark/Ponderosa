import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageSenderLabel } from "../src/components/MessageSenderLabel";
import { directMessageSender } from "../src/messageSender";
import { ConversationMessage } from "../src/components/ConversationView";

describe("message sender identity", () => {
  it("names both sides of a direct conversation", () => {
    expect(directMessageSender("user", "Great Smoky Mountains")).toBe("You");
    expect(directMessageSender("assistant", "Great Smoky Mountains")).toBe("Great Smoky Mountains");
  });

  it("uses a stable fallback when an agent title is unavailable", () => {
    expect(directMessageSender("assistant", "   ")).toBe("Agent");
  });

  it("renders mixed-Unicode sender identity as ordinary selectable, copyable text", () => {
    const html = renderToStaticMarkup(createElement(MessageSenderLabel, {
      name: "مراجعة / проверка / 完了 <QA> & test",
    }));

    expect(html).toContain("data-message-sender");
    expect(html).toContain('dir="auto"');
    expect(html).toContain("user-select:text");
    expect(html).toContain("unicode-bidi:plaintext");
    expect(html).toContain("مراجعة / проверка / 完了 &lt;QA&gt; &amp; test");
    expect(html).not.toContain("aria-hidden");
  });

  it("keeps Project-chat identity navigation separate from the copyable sender label", () => {
    const html = renderToStaticMarkup(<ConversationMessage
      message={{
        id: "message-1", conversationId: "chat-1", role: "assistant", authorAgentId: "agent-1",
        text: "Finished.", createdAt: "2026-07-23T10:00:00.000Z",
      }}
      conversation="main"
      agentTitle={() => "Pinnacles"}
      agentIdForHandle={() => undefined}
      onOpenAgent={() => undefined}
      onMentionAgent={() => undefined}
      projectId="project-1"
    />);
    expect(html).toContain('aria-label="Pinnacles message"');
    expect(html).toContain('aria-label="Open agent Pinnacles from profile image"');
    expect(html).toContain('aria-label="Open agent Pinnacles from name"');
    expect(html).toContain('aria-label="Mention Pinnacles"');
    expect(html).toContain('data-message-sender="true"');
    expect(html).not.toContain("width:28px;height:28px");
  });
});
