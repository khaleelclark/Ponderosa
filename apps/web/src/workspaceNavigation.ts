import type {
  AgentDto,
  AgentHealthDto,
  AgentLifecycleStatus,
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

export interface WorkspaceChatRow {
  conversation: ConversationDto;
  project: ProjectDto;
  unread: number;
}

export interface WorkspaceAgentRow {
  agent: AgentDto;
  project: ProjectDto;
  status: AgentLifecycleStatus;
}

const activeStatus = (status: AgentLifecycleStatus): boolean => status === "running" || status === "compacting";

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
    notification.conversationId === conversationId && !notification.readAt && (notification.status ?? "open") === "open"));
}

export function workspaceChats(
  snapshots: WorkspaceProjectSnapshot[],
  notifications: WorkspaceNotificationDto[],
  limit?: number,
): WorkspaceChatRow[] {
  const unread = unreadByConversation(notifications);
  const rows = snapshots.flatMap(({ project, conversations }) => conversations
    .filter((conversation) => !conversation.archived)
    .map((conversation) => ({ conversation, project, unread: unread.get(conversation.id) ?? 0 })));
  rows.sort((a, b) => b.conversation.updatedAt.localeCompare(a.conversation.updatedAt)
    || a.project.label.localeCompare(b.project.label)
    || a.conversation.id.localeCompare(b.conversation.id));
  return limit === undefined ? rows : rows.slice(0, limit);
}

export function workspaceAgents(snapshots: WorkspaceProjectSnapshot[]): WorkspaceAgentRow[] {
  const rows = snapshots.flatMap(({ project, agents, health }) => {
    const statusById = new Map(health.map((entry) => [entry.agentId, entry.status]));
    return agents
      .filter((agent) => !agent.archived)
      .map((agent) => ({ agent, project, status: statusById.get(agent.id) ?? "idle" as const }));
  });
  return rows.sort((a, b) => Number(activeStatus(b.status)) - Number(activeStatus(a.status))
    || b.agent.updatedAt.localeCompare(a.agent.updatedAt)
    || a.agent.title.localeCompare(b.agent.title)
    || a.agent.id.localeCompare(b.agent.id));
}

export function workspaceCounts(
  snapshots: WorkspaceProjectSnapshot[],
  notifications: WorkspaceNotificationDto[],
): { running: number; unread: number } {
  return {
    running: workspaceAgents(snapshots).filter((row) => activeStatus(row.status)).length,
    unread: notifications.filter((notification) => !notification.readAt).length,
  };
}

export function currentProjectSnapshot(
  snapshots: WorkspaceProjectSnapshot[],
  projectId: string | undefined,
): WorkspaceProjectSnapshot | undefined {
  return projectId ? snapshots.find(({ project }) => project.id === projectId) : undefined;
}

export function projectDisambiguator(project: ProjectDto, projects: ProjectDto[]): string {
  const duplicateLabel = projects.some((candidate) => candidate.id !== project.id && candidate.label.localeCompare(project.label, undefined, { sensitivity: "base" }) === 0);
  return duplicateLabel ? `${project.label} · ${project.hostPath}` : project.label;
}

export function projectContextLabel(project: ProjectDto, title: string, projects: ProjectDto[] = [project]): string {
  return `${title} · ${projectDisambiguator(project, projects)}`;
}
