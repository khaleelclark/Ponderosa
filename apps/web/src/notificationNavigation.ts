import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type { Route } from "./routing.js";
import { notificationTechnicalFocusId } from "./technicalFocus.js";

/** A repeated explicit navigation may target the same already-mounted Chat. */
export function revealNotificationDecision(item: Pick<WorkspaceNotificationDto, 'kind' | 'decision'>): void {
  if (item.kind !== 'decision' || !item.decision?.id) return;
  requestAnimationFrame(() => {
    const target = document.getElementById(`decision:${item.decision!.id}`);
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
      target.querySelector('summary')?.focus({ preventScroll: true });
    }
  });
}

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
      ...(item.kind === 'decision' && item.decision?.id ? { focusMessageId: `decision:${item.decision.id}` }
        : item.communicationEventId ? { focusMessageId: item.communicationEventId } : {}),
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
