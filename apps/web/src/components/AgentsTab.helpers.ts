import type { AgentDto, ConversationDto } from "@ponderosa/core";
import type { AgentStatus } from "../agents";

export type StatusFilter = AgentStatus;

export function resolveAgentRelationshipParent(
  agent: AgentDto,
  relationshipAgents: readonly AgentDto[],
): AgentDto | undefined {
  if (!agent.managerAgentId) return undefined;
  return relationshipAgents.find(candidate =>
    candidate.id === agent.managerAgentId && candidate.projectId === agent.projectId,
  );
}

export function resolveAgentConversation(
  agent: AgentDto,
  conversations: readonly ConversationDto[],
  scopeConversationId?: string,
): ConversationDto | undefined {
  const conversationId = scopeConversationId
    ? agent.conversationId === scopeConversationId
      ? scopeConversationId
      : undefined
    : agent.conversationId;
  if (!conversationId) return undefined;
  return conversations.find(conversation =>
    conversation.id === conversationId && conversation.projectId === agent.projectId,
  );
}

const STATUS_FILTERS: Array<{
  value: StatusFilter;
  label: string;
}> = [
  { value: "running", label: "Running" },
  { value: "preparing", label: "Preparing" },
  { value: "waiting", label: "Waiting" },
  { value: "needs_decision", label: "Needs decision" },
  { value: "blocked", label: "Blocked" },
  { value: "stalled", label: "Stalled" },
  { value: "interrupted", label: "Interrupted" },
  { value: "compacting", label: "Refreshing context" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "completed", label: "Completed" },
  { value: "idle", label: "Idle" },
];

export function agentStatusFilterOptions(
  agents: AgentDto[],
  statusByAgentId: ReadonlyMap<string, AgentStatus>,
): Array<{ value: StatusFilter | "all"; label: string; count: number }> {
  const counts = agents.reduce(
    (result, agent) => {
      result.status[statusByAgentId.get(agent.id) ?? "idle"] += 1;
      return result;
    },
    {
      status: {
        running: 0,
        preparing: 0,
        stalled: 0,
        interrupted: 0,
        waiting: 0,
        needs_decision: 0,
        blocked: 0,
        compacting: 0,
        cancelled: 0,
        completed: 0,
        failed: 0,
        idle: 0,
      } satisfies Record<AgentStatus, number>,
    },
  );
  return [
    { value: "all", label: "All", count: agents.length },
    ...STATUS_FILTERS.map(option => ({
      ...option,
      count: counts.status[option.value],
    })),
  ];
}

export function matchesAgentStatusFilters(
  _agent: Pick<AgentDto, "conversationId">,
  status: AgentStatus,
  selected: readonly StatusFilter[],
): boolean {
  if (selected.length === 0) return true;
  return selected.some(filter => status === filter);
}

export function agentHierarchyContextIds(
  agents: readonly AgentDto[],
  matchingAgentIds: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const result = new Set(matchingAgentIds);
  for (const id of matchingAgentIds) {
    let parentId = byId.get(id)?.managerAgentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      result.add(parentId);
      parentId = byId.get(parentId)?.managerAgentId;
    }
  }
  return result;
}

export function agentHasCollapsedAncestor(
  agent: AgentDto,
  agentsById: ReadonlyMap<string, AgentDto>,
  collapsedAgentIds: ReadonlySet<string>,
): boolean {
  let parentId = agent.managerAgentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (collapsedAgentIds.has(parentId)) return true;
    seen.add(parentId);
    parentId = agentsById.get(parentId)?.managerAgentId;
  }
  return false;
}
