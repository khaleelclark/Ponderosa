import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directMessageSender } from "../src/messageSender";

describe("message sender identity", () => {
  it("names both sides of a direct conversation", () => {
    expect(directMessageSender("user", "Great Smoky Mountains")).toBe("You");
    expect(directMessageSender("assistant", "Great Smoky Mountains")).toBe("Great Smoky Mountains");
  });

  it("uses a stable fallback when an agent title is unavailable", () => {
    expect(directMessageSender("assistant", "   ")).toBe("Agent");
  });

  it("renders sender identity as ordinary selectable, screen-reader-visible text", () => {
    const source = readFileSync(new URL("../src/components/MessageSenderLabel.tsx", import.meta.url), "utf8");
    expect(source).toContain("data-message-sender");
    expect(source).toContain('userSelect: "text"');
    expect(source).toContain('overflowWrap: "anywhere"');
    expect(source).not.toContain("aria-hidden");
  });

  it("keeps team-chat navigation separate from the copyable sender label", () => {
    const source = readFileSync(new URL("../src/components/MasterChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain('<MessageSenderLabel name={fromManager ? "You" : agentTitle(message.authorThreadId)} />');
    expect(source).toContain("aria-label={`Open agent ${agentTitle(message.authorThreadId)}`}");
    expect(source).toContain("minWidth: 44, minHeight: 44");
  });
});
