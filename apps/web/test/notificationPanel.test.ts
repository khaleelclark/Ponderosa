import { describe, expect, it } from "vitest";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { filterNotifications, groupNotificationsByProject } from "../src/components/NotificationPanel";
import { createPonderosaTheme } from "../src/theme";

function luminance(color: string): number {
  const channels = color.match(/[\da-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

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
  it("groups by stable Project identity and keeps newest groups first", () => {
    const groups = groupNotificationsByProject([
      notification("old", "project-a", "chat-a", "2026-07-16T01:00:00.000Z"),
      notification("new", "project-b", "chat-b", "2026-07-16T03:00:00.000Z"),
      notification("same-chat", "project-a", "chat-a", "2026-07-16T02:00:00.000Z"),
      notification("project", "project-a", undefined, "2026-07-16T00:00:00.000Z"),
    ]);

    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
      ["new"],
      ["same-chat", "old", "project"],
    ]);
    expect(groups[1]).toMatchObject({ projectId: "project-a" });
  });

  it("keeps Mentions as a separate exact-kind filter", () => {
    const mention = notification("mention", "project-a", "chat-a", "2026-07-16T01:00:00.000Z");
    const response = { ...notification("response", "project-a", "chat-a", "2026-07-16T02:00:00.000Z"), kind: "direct_responses" as const };
    expect(filterNotifications([mention, response], "mentions")).toEqual([mention]);
    expect(filterNotifications([mention, response], "all")).toEqual([mention, response]);
  });

  it.each(["light", "dark"] as const)("keeps the project label readable in %s mode", (mode) => {
    const theme = createPonderosaTheme(mode);
    expect(contrastRatio(theme.palette.text.secondary, theme.palette.action.hover)).toBeGreaterThanOrEqual(4.5);
  });
});
