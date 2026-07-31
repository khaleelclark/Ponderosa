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
  "project_responses",
  "mentions",
  "all_messages",
  "everyone",
  "broadcasts",
]);

export function isOrdinaryMessageNotification(notification: WorkspaceNotificationDto): boolean {
  return ORDINARY_MESSAGE_NOTIFICATION_KINDS.has(notification.kind);
}

export function unreadByConversation(notifications: WorkspaceNotificationDto[]): Map<string, number> {
  const unread = new Map<string, number>();
  for (const notification of notifications) {
    if (notification.readAt || (notification.status ?? "open") !== "open" || !notification.conversationId) continue;
    unread.set(notification.conversationId, (unread.get(notification.conversationId) ?? 0) + 1);
  }
  return unread;
}

export function hasUnreadConversationNotifications(
  notifications: WorkspaceNotificationDto[],
  conversationId: string | undefined,
): boolean {
  return Boolean(conversationId && notifications.some((notification) =>
    notification.conversationId === conversationId && !notification.readAt && (notification.status ?? "open") === "open" &&
    isOrdinaryMessageNotification(notification)));
}

export function projectDisambiguator(
  project: Pick<ProjectDto, "id" | "label" | "hostPath">,
  projects: ProjectDto[],
): string {
  const duplicateLabel = projects.some((candidate) => candidate.id !== project.id && candidate.label.localeCompare(project.label, undefined, { sensitivity: "base" }) === 0);
  return duplicateLabel ? `${project.label} · ${project.hostPath}` : project.label;
}
