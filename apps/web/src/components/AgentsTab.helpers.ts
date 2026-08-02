import type { AgentDto } from "@ponderosa/core";
import type { AgentStatus } from "../agents";

export type StatusFilter = AgentStatus | "unassigned";

const STATUS_FILTERS: Array<{
  value: Exclude<StatusFilter, "all" | "unassigned">;
  label: string;
}> = [
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "needs_decision", label: "Needs decision" },
  { value: "blocked", label: "Blocked" },
  { value: "stalled", label: "Stalled" },
  { value: "interrupted", label: "Interrupted" },
  { value: "compacting", label: "Compacting" },
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
      if (agent.conversationIds.length === 0) result.unassigned += 1;
      return result;
    },
    {
      status: {
        running: 0,
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
      unassigned: 0,
    },
  );
  return [
    { value: "all", label: "All", count: agents.length },
    ...STATUS_FILTERS.map(option => ({
      ...option,
      count: counts.status[option.value],
    })),
    { value: "unassigned", label: "Unassigned", count: counts.unassigned },
  ];
}

export function matchesAgentStatusFilters(
  agent: Pick<AgentDto, "conversationIds">,
  status: AgentStatus,
  selected: readonly StatusFilter[],
): boolean {
  if (selected.length === 0) return true;
  return selected.some(filter =>
    filter === "unassigned"
      ? agent.conversationIds.length === 0
      : status === filter,
  );
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
