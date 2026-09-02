import type { WorkspaceNotificationDto } from "@ponderosa/core";

export function isOpenAttention(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open" && (
    item.kind === "decision" || item.kind === "operational" || item.severity === "attention" || item.severity === "urgent"
  );
}

export function isUnacknowledgedAction(item: WorkspaceNotificationDto): boolean {
  return isOpenAttention(item) && !item.acknowledgedAt;
}

export function visibleNotification(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open";
}

export function isUnreadNotificationUpdate(item: WorkspaceNotificationDto): boolean {
  return visibleNotification(item) && !isOpenAttention(item) && !item.readAt;
}

export function notificationSummary(notifications: WorkspaceNotificationDto[]): {
  openActionCount: number;
  unacknowledgedActionCount: number;
  unreadUpdateCount: number;
} {
  return notifications.reduce((summary, item) => {
    if (isOpenAttention(item)) {
      summary.openActionCount += 1;
      if (!item.acknowledgedAt) summary.unacknowledgedActionCount += 1;
    }
    else if (isUnreadNotificationUpdate(item)) summary.unreadUpdateCount += 1;
    return summary;
  }, { openActionCount: 0, unacknowledgedActionCount: 0, unreadUpdateCount: 0 });
}

/** A Project-scoped notification has no actionable destination after its
 * Project leaves the canonical Project collection. */
export function notificationsForAvailableProjects(
  notifications: WorkspaceNotificationDto[],
  projectIds: ReadonlySet<string>,
): WorkspaceNotificationDto[] {
  return notifications.filter(item =>
    !item.projectId || projectIds.has(item.projectId)
  );
}

export function scopedAttention(notifications: WorkspaceNotificationDto[], scope: {
  projectId?: string;
  conversationId?: string;
  agentId?: string;
} = {}): WorkspaceNotificationDto[] {
  return notifications.filter((item) => isOpenAttention(item)
    && (!scope.projectId || item.projectId === scope.projectId)
    && (!scope.conversationId
      || item.conversationId === scope.conversationId
      || item.conversationIds?.includes(scope.conversationId))
    && (!scope.agentId
      || item.agentId === scope.agentId
      || item.agentIds?.includes(scope.agentId)
      || (item.action?.kind === "open_agent" && item.action.targetId === scope.agentId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}
