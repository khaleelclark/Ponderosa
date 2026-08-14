import { describe, expect, test } from "vitest";
import {
  highlightedSearchSnippet,
  searchProjectedChatMessages,
  type ProjectedChatSearchCandidate,
} from "./chat-search.js";

function candidate(index: number, text: string): ProjectedChatSearchCandidate {
  return {
    project: { id: "project-a", label: "Project A" },
    chat: { kind: "conversation", id: "conversation-a", title: "Project chat" },
    messageId: `message-${index}`,
    communicationEventId: `communication-${index}`,
    author: { kind: "user", label: "User" },
    timestamp: `2026-08-12T00:00:${String(index).padStart(2, "0")}.000Z`,
    text,
    unread: false,
  };
}

describe("bounded literal chat search", () => {
  test.each([
    ["%", "literal % percent"],
    ["_", "literal _ underscore"],
    ["\\", "literal \\ backslash"],
  ])("matches %s literally", (query, matchingText) => {
    const searched = searchProjectedChatMessages([
      candidate(1, "ordinary message"),
      candidate(2, matchingText),
    ], { query, limit: 10, maxScannedMessages: 10 });

    expect(searched.results.map(result => result.messageId)).toEqual(["message-2"]);
    expect(searched.results[0]?.highlights).toEqual([{ start: 8, length: 1 }]);
  });

  test("bounds newest-first reads and reports truncation without disturbing sort", () => {
    const searched = searchProjectedChatMessages(
      Array.from({ length: 20 }, (_, index) => candidate(index, `matching ${index}`)),
      { query: "matching", limit: 3, maxScannedMessages: 5 },
    );

    expect(searched.scannedMessages).toBe(5);
    expect(searched.truncated).toBe(true);
    expect(searched.results.map(result => result.messageId)).toEqual([
      "message-19",
      "message-18",
      "message-17",
    ]);
  });

  test("keeps empty-query unread behavior and recent snippets literal", () => {
    const unread = { ...candidate(2, "100% ready_\\"), unread: true };
    const searched = searchProjectedChatMessages([
      candidate(1, "read"),
      unread,
    ], { query: "", limit: 10, maxScannedMessages: 10 });

    expect(searched.results.map(result => result.messageId)).toEqual(["message-2"]);
    expect(highlightedSearchSnippet(unread.text, "")).toEqual({
      snippet: "100% ready_\\",
      highlights: [],
    });
  });
});
