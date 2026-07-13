import type { AgentDto } from "@ponderosa/core";

export function activeCollaborationRecipients(agents: AgentDto[]): AgentDto[] {
  return agents.filter((agent) => !agent.archived);
}

export function retainActiveRecipientIds(selectedIds: Iterable<string>, agents: AgentDto[]): string[] {
  const activeIds = new Set(activeCollaborationRecipients(agents).map((agent) => agent.id));
  return [...new Set(selectedIds)].filter((id) => activeIds.has(id));
}

/** Resolve the #everyone UX into the same immutable stable-ID payload as manual selection. */
export function allActiveRecipientIds(agents: AgentDto[]): string[] {
  return activeCollaborationRecipients(agents).map((agent) => agent.id);
}
