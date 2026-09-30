import assert from "node:assert/strict";
import test from "node:test";
import { searchProjectedChatMessages } from "../dist/index.js";

test("sidebar grouping returns distinct Chats before applying the five-Chat ceiling", () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    project: { id: "project", label: "Project" },
    chat: { kind: "conversation", id: "chat-" + (index < 20 ? 0 : index - 19), title: "Untitled" },
    messageId: "message-" + index, timestamp: new Date(1_000_000 - index * 1000).toISOString(),
    text: "Our marketing plan", author: { kind: "user", label: "User" }, unread: false,
  }));
  const result = searchProjectedChatMessages(candidates, { query: "marketing", limit: 5, maxScannedMessages: 30, distinctChats: true });
  assert.equal(result.results.length, 5);
  assert.equal(new Set(result.results.map(item => item.chat.id)).size, 5);
  assert.equal(result.results[0].messageId, "message-0");
  assert.deepEqual(result.results[0].highlights, [{ start: 4, length: 9 }]);
  assert.equal(searchProjectedChatMessages(candidates, { query: "marketing", limit: 5, maxScannedMessages: 10, distinctChats: true }).truncated, true);
});
