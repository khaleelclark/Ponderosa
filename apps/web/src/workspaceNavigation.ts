import type {
  AgentDto,
  AgentHealthDto,
  ConversationDto,
  ProjectDto,
  WorkspaceNotificationDto,
} from "@ponderosa/core";

export interface WorkspaceProjectSnapshot {
  project: ProjectDto;
  conversations: ConversationDto[];
  agents: AgentDto[];
  health: AgentHealthDto[];
}

const ORDINARY_MESSAGE_NOTIFICATION_KINDS = new Set<WorkspaceNotificationDto["kind"]>([
  "direct_responses",
  "everyone",
  "broadcasts",
]);

const IMPORTANT_MESSAGE_NOTIFICATION_KINDS = new Set<WorkspaceNotificationDto["kind"]>([
  "direct_responses",
  "everyone",
]);

export interface UnreadNotificationProjection {
  importantCount: number;
  ordinaryCount: number;
  totalCount: number;
}

export function isOrdinaryMessageNotification(notification: WorkspaceNotificationDto): boolean {
  return ORDINARY_MESSAGE_NOTIFICATION_KINDS.has(notification.kind);
}

function isOpenActionNotification(notification: WorkspaceNotificationDto): boolean {
  return notification.kind === "decision" ||
    notification.kind === "operational" ||
    notification.severity === "attention" ||
    notification.severity === "urgent";
}

function unreadProjectionKind(
  notification: WorkspaceNotificationDto,
): "important" | "ordinary" | undefined {
  if ((notification.status ?? "open") !== "open" || notification.kind === "collaboration") {
    return undefined;
  }
  if (isOpenActionNotification(notification)) {
    return notification.acknowledgedAt ? undefined : "important";
  }
  if (notification.readAt || !isOrdinaryMessageNotification(notification)) return undefined;
  return IMPORTANT_MESSAGE_NOTIFICATION_KINDS.has(notification.kind)
    ? "important"
    : "ordinary";
}

/** Count canonical notification identities once even when the same item is
 * projected into several navigation and overview surfaces. */
export function unreadNotificationProjection(
  notifications: readonly WorkspaceNotificationDto[],
): UnreadNotificationProjection {
  const importantIds = new Set<string>();
  const ordinaryIds = new Set<string>();
  for (const notification of notifications) {
    const kind = unreadProjectionKind(notification);
    if (kind === "important") importantIds.add(notification.id);
    else if (kind === "ordinary") ordinaryIds.add(notification.id);
  }
  for (const id of importantIds) ordinaryIds.delete(id);
  return {
    importantCount: importantIds.size,
    ordinaryCount: ordinaryIds.size,
    totalCount: importantIds.size + ordinaryIds.size,
  };
}

export function unreadProjectionForProject(
  notifications: readonly WorkspaceNotificationDto[],
  projectId: string,
): UnreadNotificationProjection {
  return unreadNotificationProjection(
    notifications.filter((notification) => notification.projectId === projectId),
  );
}

export function notificationProjectsToConversation(
  notification: WorkspaceNotificationDto,
  conversationId: string,
): boolean {
  return notification.conversationId === conversationId ||
    Boolean(notification.conversationIds?.includes(conversationId));
}

export function unreadProjectionForConversation(
  notifications: readonly WorkspaceNotificationDto[],
  conversationId: string,
): UnreadNotificationProjection {
  return unreadNotificationProjection(
    notifications.filter((notification) =>
      notificationProjectsToConversation(notification, conversationId)),
  );
}

export function unreadProjectionsByConversation(
  notifications: readonly WorkspaceNotificationDto[],
): Map<string, UnreadNotificationProjection> {
  const notificationsByConversation = new Map<string, WorkspaceNotificationDto[]>();
  for (const notification of notifications) {
    const conversationIds = new Set([
      ...(notification.conversationId ? [notification.conversationId] : []),
      ...(notification.conversationIds ?? []),
    ]);
    for (const conversationId of conversationIds) {
      const projected = notificationsByConversation.get(conversationId) ?? [];
      projected.push(notification);
      notificationsByConversation.set(conversationId, projected);
    }
  }
  return new Map([...notificationsByConversation].map(([conversationId, projected]) => [
    conversationId,
    unreadNotificationProjection(projected),
  ]));
}

export function unreadByConversation(notifications: WorkspaceNotificationDto[]): Map<string, number> {
  return new Map([...unreadProjectionsByConversation(notifications)].flatMap(
    ([conversationId, projection]) => projection.totalCount
      ? [[conversationId, projection.totalCount] as const]
      : [],
  ));
}

export function projectDisambiguator(
  project: Pick<ProjectDto, "id" | "label" | "hostPath">,
  projects: ProjectDto[],
): string {
  const duplicateLabel = projects.some((candidate) => candidate.id !== project.id && candidate.label.localeCompare(project.label, undefined, { sensitivity: "base" }) === 0);
  return duplicateLabel ? `${project.label} · ${project.hostPath}` : project.label;
}
