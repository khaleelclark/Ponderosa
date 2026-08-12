import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentStore } from "./store.js";

const stores: AgentStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("startup communication recovery", () => {
  test("rebuilds global chat once without refreshing unchanged replay placements", () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-startup-communication-"));
    directories.push(root);
    const dataDir = join(root, "data");
    const hostPath = join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });

    const store = new AgentStore(dataDir);
    stores.push(store);
    const project = store.createProject({
      label: "Startup communication recovery",
      hostPath,
      defaultEngine: "codex",
    });
    const conversationId = project.lastConversationId!;
    const eventId = "startup-recovery-message";
    const createdAt = "2026-08-12T00:00:00.000Z";
    store.appendCommunicationEvent({
      schemaVersion: 2,
      eventId,
      projectId: project.id,
      conversationId,
      sender: { kind: "user", userId: "local-user" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Search survives startup recovery",
      createdAt,
    });
    store.appendConversationMessage(
      conversationId,
      { role: "user", text: "Search survives startup recovery" },
      undefined,
      "main",
      undefined,
      undefined,
      eventId,
    );

    store.sqlite.exec(`
      CREATE TABLE startup_search_writes(count INTEGER NOT NULL);
      INSERT INTO startup_search_writes(count) VALUES (0);
      CREATE TRIGGER count_startup_search_insert
      AFTER INSERT ON chat_search_messages BEGIN
        UPDATE startup_search_writes SET count = count + 1;
      END;
      CREATE TRIGGER count_startup_search_update
      AFTER UPDATE ON chat_search_messages BEGIN
        UPDATE startup_search_writes SET count = count + 1;
      END;
    `);
    store.close();
    stores.pop();

    const reopened = new AgentStore(dataDir);
    stores.push(reopened);
    const writes = reopened.sqlite.prepare(
      "SELECT count FROM startup_search_writes",
    ).get() as { count: number };
    expect(writes.count).toBe(1);
    expect(reopened.getAllChatPage({ limit: 10 }).items.map((item) => item.communicationEventId))
      .toContain(eventId);
    expect(reopened.searchGlobalChats({ query: "survives", limit: 10 }).results)
      .toHaveLength(1);

    const projection = reopened.getCommunicationProjection(
      project.id,
      eventId,
      "conversation",
      conversationId,
    )!;
    reopened.sqlite.prepare(
      "DELETE FROM chat_search_messages WHERE communication_event_id = ?",
    ).run(eventId);
    expect(reopened.searchGlobalChats({ query: "survives", limit: 10 }).results)
      .toHaveLength(0);
    reopened.appendCommunicationProjection(project.id, projection);
    expect(reopened.searchGlobalChats({ query: "survives", limit: 10 }).results)
      .toHaveLength(1);
  });
});
