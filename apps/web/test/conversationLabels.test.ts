import { describe, expect, it } from "vitest";
import type { ConversationDto } from "@ponderosa/core";
import { conversationDisplayTitle } from "../src/conversationLabels";

function chat(id: string, title: string, createdAt: string): ConversationDto {
  return { id, projectId: "project", title, createdAt, updatedAt: createdAt, archived: false };
}

describe("conversationDisplayTitle", () => {
  it("keeps unique titles untouched and numbers duplicate titles chronologically", () => {
    const chats = [chat("newer", "New Chat", "2026-02-02T00:00:00Z"), chat("older", "New Chat", "2026-01-01T00:00:00Z"), chat("other", "Review", "2026-01-03T00:00:00Z")];
    expect(conversationDisplayTitle(chats[0]!, chats)).toBe("New Chat · 2");
    expect(conversationDisplayTitle(chats[1]!, chats)).toBe("New Chat · 1");
    expect(conversationDisplayTitle(chats[2]!, chats)).toBe("Review");
  });
});
