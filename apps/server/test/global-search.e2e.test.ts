import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { createServer } from "../src/app.js";

describe("global chat search end to end", () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

  it("searches canonical messages across projects and returns unread/recent deep-link data", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-global-search-"));
    cleanup.push(dataDir);
    const store = new AgentStore(dataDir);
    const workspace = new WorkspaceStore(dataDir);
    const seeded: Array<{ projectId: string; conversationId: string; messageId: string }> = [];

    for (const [label, text] of [["Alpha", "Shared launch checklist"], ["Beta", "Launch verification notes"]] as const) {
      const project = store.createProject({ label, hostPath: `/${label.toLocaleLowerCase()}` });
      const conversationId = project.lastConversationId!;
      const eventId = randomUUID();
      store.appendCommunicationEvent({
        eventId,
        schemaVersion: 1,
        projectId: project.id,
        conversationId,
        sender: { kind: "user", userId: "local-operator" },
        intent: "broadcast",
        audience: { kind: "organization", organizationId: project.id },
        text,
        createdAt: new Date().toISOString(),
      });
      const message = store.appendConversationMessage(conversationId, { text }, undefined, "main", undefined, undefined, eventId)!;
      seeded.push({ projectId: project.id, conversationId, messageId: message.id });
    }
    workspace.createNotification({
      projectId: seeded[0]!.projectId,
      conversationId: seeded[0]!.conversationId,
      communicationEventId: seeded[0]!.messageId,
      kind: "project_responses",
      title: "Unread launch update",
      body: "Shared launch checklist",
    });

    const app = createServer({ dataDir, store, engines: [], logger: false });
    try {
      const recent = (await app.inject({ method: "GET", url: "/api/search" })).json<{
        results: Array<{ messageId: string; unread: boolean }>;
        recentChats: Array<{ project: { label: string }; unreadCount: number }>;
      }>();
      expect(recent.results).toEqual([expect.objectContaining({ messageId: seeded[0]!.messageId, unread: true })]);
      expect(recent.recentChats.map((item) => item.project.label)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
      expect(recent.recentChats.find((item) => item.project.label === "Alpha")?.unreadCount).toBe(1);

      const searched = (await app.inject({ method: "GET", url: "/api/search?q=launch" })).json<{
        results: Array<{ project: { label: string }; chat: { kind: string; id: string }; messageId: string }>;
      }>();
      expect(searched.results.map((result) => result.project.label)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
      expect(searched.results).toContainEqual(expect.objectContaining({
        chat: { kind: "conversation", id: seeded[1]!.conversationId, title: expect.any(String) },
        messageId: seeded[1]!.messageId,
      }));
    } finally {
      await app.close();
    }
  });
});
