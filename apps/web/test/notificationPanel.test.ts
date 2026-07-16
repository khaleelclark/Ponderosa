import { describe, expect, it } from "vitest";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { groupNotificationsByChat } from "../src/components/NotificationPanel";

function notification(id: string, projectId: string, conversationId: string | undefined, createdAt: string): WorkspaceNotificationDto {
  return {
    id,
    projectId,
    ...(conversationId ? { conversationId } : {}),
    kind: "mentions",
    title: `Notification ${id}`,
    body: "Body",
    createdAt,
  };
}

describe("notification panel grouping", () => {
  it("groups by stable project/chat identity and keeps newest groups first", () => {
    const groups = groupNotificationsByChat([
      notification("old", "project-a", "chat-a", "2026-07-16T01:00:00.000Z"),
      notification("new", "project-b", "chat-b", "2026-07-16T03:00:00.000Z"),
      notification("same-chat", "project-a", "chat-a", "2026-07-16T02:00:00.000Z"),
      notification("project", "project-a", undefined, "2026-07-16T00:00:00.000Z"),
    ]);

    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
      ["new"],
      ["same-chat", "old"],
      ["project"],
    ]);
    expect(groups[1]).toMatchObject({ projectId: "project-a", conversationId: "chat-a" });
  });
});
