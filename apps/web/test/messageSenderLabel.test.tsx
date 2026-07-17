import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageSenderLabel } from "../src/components/MessageSenderLabel";
import { directMessageSender } from "../src/messageSender";

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

  it("keeps team-chat navigation separate from the copyable sender label", () => {
    const source = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
    expect(source).toContain('<MessageSenderLabel name={fromManager ? operatorProfile?.displayName ?? "You" : agentTitle(message.authorAgentId)} />');
    expect(source).toContain('component="article"');
    expect(source).toContain('aria-label={`${fromManager ? operatorProfile?.displayName ?? "You" : agentTitle(message.authorAgentId)} message`}');
    expect(source).toContain("aria-label={`Open agent ${agentTitle(message.authorAgentId)}`}");
    expect(source).toContain("minWidth: 44, minHeight: 44");
  });
});
