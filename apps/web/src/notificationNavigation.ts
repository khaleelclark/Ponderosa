import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type { Route } from "./routing.js";

/** A notification belongs to its Chat when one is known, even if it also
 * identifies the Agent that authored the update or needs attention. */
export function notificationNavigationRoute(
  item: WorkspaceNotificationDto,
  availableProjectIds?: ReadonlySet<string>,
): Route | undefined {
  if (!item.projectId || (availableProjectIds && !availableProjectIds.has(item.projectId))) return undefined;
  const conversationId = item.conversationId
    ?? (item.action?.kind === "open_conversation" ? item.action.targetId : undefined);
  if (conversationId) {
    return {
      kind: "conversation",
      projectId: item.projectId,
      conversationId,
      ...(item.communicationEventId ? { focusMessageId: item.communicationEventId } : {}),
    };
  }
  const agentId = item.action?.kind === "open_agent" ? item.action.targetId : item.agentId;
  if (agentId) {
    return {
      kind: "agent",
      projectId: item.projectId,
      agentId,
      ...(item.category === "coordination" ? { view: "technical" } : {}),
    };
  }
  return { kind: "home" };
}
