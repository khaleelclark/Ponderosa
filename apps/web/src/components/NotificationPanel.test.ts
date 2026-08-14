import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { describe, expect, test } from "vitest";
import { notificationNavigationRoute } from "./NotificationPanel";

const notification = {
  id: "notification-1",
  projectId: "project-1",
  conversationId: "conversation-1",
  communicationEventId: "message-1",
  kind: "direct_responses",
  title: "Agent replied",
  body: "Finished.",
  createdAt: "2026-08-14T00:00:00.000Z",
} satisfies WorkspaceNotificationDto;

describe("notification navigation", () => {
  test("does not create a dead route for a deleted Project notification", () => {
    expect(notificationNavigationRoute(
      notification,
      new Set(["project-2"]),
    )).toBeUndefined();
  });

  test("preserves navigation for an available Project notification", () => {
    expect(notificationNavigationRoute(
      notification,
      new Set(["project-1"]),
    )).toEqual({
      kind: "conversation",
      projectId: "project-1",
      conversationId: "conversation-1",
      focusMessageId: "message-1",
    });
  });
});
