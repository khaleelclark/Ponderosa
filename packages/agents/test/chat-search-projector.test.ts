import { describe, expect, it } from "vitest";
import { highlightedSearchSnippet, searchProjectedChatMessages, type ProjectedChatSearchCandidate } from "../src/chat-search.js";

function candidate(id: string, text: string, timestamp: string, unread = false): ProjectedChatSearchCandidate {
  return {
    project: { id: "project", label: "Project" },
    chat: { kind: "conversation", id: "chat", title: "Chat" },
    messageId: id,
    author: { kind: "user", label: "User" },
    timestamp,
    text,
    unread,
  };
}

describe("global chat search projection", () => {
  it("returns safe snippet ranges around every visible case-insensitive match", () => {
    const result = highlightedSearchSnippet(`${"prefix ".repeat(40)}Needle then needle after`, "NEEDLE");
    expect(result.snippet.startsWith("…")).toBe(true);
    expect(result.highlights).toHaveLength(2);
    expect(result.highlights.map((range) => result.snippet.slice(range.start, range.start + range.length).toLocaleLowerCase())).toEqual(["needle", "needle"]);
  });

  it("bounds the scan to newest projected messages and reports truncation", () => {
    const result = searchProjectedChatMessages([
      candidate("old", "needle old", "2026-01-01T00:00:00.000Z"),
      candidate("new", "needle new", "2026-01-03T00:00:00.000Z"),
      candidate("middle", "needle middle", "2026-01-02T00:00:00.000Z"),
    ], { query: "needle", limit: 10, maxScannedMessages: 2 });
    expect(result.results.map((item) => item.messageId)).toEqual(["new", "middle"]);
    expect(result.scannedMessages).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("uses an empty query for unread messages only", () => {
    const result = searchProjectedChatMessages([
      candidate("read", "read message", "2026-01-02T00:00:00.000Z"),
      candidate("unread", "unread message", "2026-01-01T00:00:00.000Z", true),
    ], { query: "", limit: 10, maxScannedMessages: 10 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ messageId: "unread", unread: true, highlights: [] });
  });
});
