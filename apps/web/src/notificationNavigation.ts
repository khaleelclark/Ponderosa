import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type { Route } from "./routing.js";
import { notificationTechnicalFocusId } from "./technicalFocus.js";

/** Ordinary updates belong to their Chat; explicit recovery actions open the
 * exact Agent work surface that can resolve the blocker. */
export function notificationNavigationRoute(
  item: WorkspaceNotificationDto,
  availableProjectIds?: ReadonlySet<string>,
): Route | undefined {
  if (!item.projectId || (availableProjectIds && !availableProjectIds.has(item.projectId))) return undefined;
  if (item.kind === "operational" && item.action?.kind === "open_agent" && item.action.targetId) {
    const focus = notificationTechnicalFocusId(item);
    return { kind: "agent", projectId: item.projectId, agentId: item.action.targetId,
      view: "technical", ...(focus ? { technicalFocusId: focus } : {}) };
  }
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
