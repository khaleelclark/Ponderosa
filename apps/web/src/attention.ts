import type { WorkspaceNotificationDto } from "@ponderosa/core";

export function isOpenAttention(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open" && (
    item.kind === "decision" || item.severity === "attention" || item.severity === "urgent"
  );
}

export function visibleNotification(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open" && (!item.readAt || isOpenAttention(item));
}

export function scopedAttention(notifications: WorkspaceNotificationDto[], scope: {
  projectId?: string;
  conversationId?: string;
  agentId?: string;
  conversationAgentIds?: string[];
} = {}): WorkspaceNotificationDto[] {
  const conversationAgentIds = new Set(scope.conversationAgentIds ?? []);
  return notifications.filter((item) => isOpenAttention(item)
    && (!scope.projectId || item.projectId === scope.projectId)
    && (!scope.conversationId
      || item.conversationId === scope.conversationId
      || item.conversationIds?.includes(scope.conversationId)
      || item.agentIds?.some((agentId) => conversationAgentIds.has(agentId))
      || Boolean(item.agentId && conversationAgentIds.has(item.agentId)))
    && (!scope.agentId
      || item.agentId === scope.agentId
      || item.agentIds?.includes(scope.agentId)
      || (item.action?.kind === "open_agent" && item.action.targetId === scope.agentId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}
