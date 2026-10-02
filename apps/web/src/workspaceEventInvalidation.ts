import type { WorkspaceEvent } from "@ponderosa/core";

/** Chat mutations (including passive edits) and unread changes refresh search. */
export function workspaceEventInvalidatesGlobalSearch(
  event: WorkspaceEvent,
): boolean {
  return event.type === "conversation_changed" ||
    event.type === "notification_changed";
}

/** Messages is a canonical communication projection. Refresh it only for
 * workspace events that can add or change one of its communication rows. */
export function workspaceEventInvalidatesAllChat(
  event: WorkspaceEvent,
): boolean {
  return event.type === "conversation_changed" ||
    event.type === "message_delivery_changed" ||
    (event.type === "notification_changed" && Boolean(event.decisionId)) ||
    (event.type === "agent_event" && (event.category === "message" || event.category === "lifecycle"));
}

/** Metadata for open-call transitions refreshes the bounded public projection;
 * never inspect task input/output or reasoning to invent an activity. */
export function workspaceEventUpdatesLiveProgress(event: WorkspaceEvent): boolean {
  return event.type === "agent_event" && (event.category === "progress" ||
    (event.category === "task" && event.conversationIds.length > 0 && ["command", "tool_call", "tool_result"].includes(event.eventType)));
}
