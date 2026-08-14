import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openDb } from "./db.js";
import { AgentChatSearchReadModel } from "./store-chat-search-read-model.js";

const clients: Database.Database[] = [];
afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

describe("bounded global Chat recent lookup", () => {
  test("includes bounded empty recent conversations in unread point lookup", () => {
    const sqlite = openDb(":memory:").client;
    clients.push(sqlite);
    sqlite.prepare(`
      INSERT INTO projects (id, label, host_path, created_at, default_engine)
      VALUES ('project-recent', 'Recent', '/tmp/recent', '2026-08-14T00:00:00.000Z', 'codex')
    `).run();
    for (let index = 0; index < 25; index += 1) {
      sqlite.prepare(`
        INSERT INTO conversations (id, project_id, title, created_at, updated_at)
        VALUES (?, 'project-recent', ?, '2026-08-14T00:00:00.000Z', ?)
      `).run(
        `conversation-${index}`,
        `Conversation ${index}`,
        `2026-08-14T00:00:${String(index).padStart(2, "0")}.000Z`,
      );
    }
    const notificationState = vi.fn((input: {
      communicationEventIds: readonly string[];
      conversationIds: readonly string[];
    }) => ({
      unreadCommunicationEventIds: [],
      unreadConversationCounts: Object.fromEntries(
        input.conversationIds.map((id) => [id, id === "conversation-24" ? 3 : 0]),
      ),
    }));

    const result = new AgentChatSearchReadModel(sqlite).searchGlobalChats({
      query: "",
      recentLimit: 10,
      notificationState,
    });

    expect(notificationState).toHaveBeenCalledOnce();
    const input = notificationState.mock.calls[0]![0];
    expect(input.communicationEventIds).toEqual([]);
    expect(input.conversationIds).toHaveLength(10);
    expect(input.conversationIds).toContain("conversation-24");
    expect(result.recentChats[0]).toMatchObject({
      chat: { id: "conversation-24" },
      unreadCount: 3,
    });
  });
});
