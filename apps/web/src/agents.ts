// Agent is the stable identity presented to the user. This module centralizes the
// user-facing status vocabulary so the Agents tab, sidebar, and detail view
// stay consistent. The underlying data model remains AgentDto/AgentDetailDto.

import type { AgentLifecycleStatus, AgentRunDto, AgentDetailDto, AgentDto, AgentHealthDto } from "@ponderosa/core";

export interface AgentOrganizationRow {
  agent: AgentDto;
  depth: number;
}

/** Keep deep hierarchy cues inside a fixed-width roster instead of widening it. */
export function agentRosterIndent(depth: number): number {
  return Math.min(Math.max(depth, 0), 3) * 2;
}

/** Stable parent-first roster order. Missing/cyclic parentage fails closed to top level. */
export function orderedAgentOrganization(agents: AgentDto[]): AgentOrganizationRow[] {
  const active = agents.filter((agent) => !agent.archived);
  const byId = new Map(active.map((agent) => [agent.id, agent]));
  const children = new Map<string, AgentDto[]>();
  const roots: AgentDto[] = [];
  const hasSafeParentChain = (agent: AgentDto): boolean => {
    const seen = new Set<string>([agent.id]);
    let parentId = agent.managerAgentId;
    while (parentId) {
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return false;
      parentId = parent.managerAgentId;
    }
    return Boolean(agent.managerAgentId);
  };
  for (const agent of active) {
    const parentId = agent.managerAgentId;
    if (!parentId || !hasSafeParentChain(agent)) roots.push(agent);
    else children.set(parentId, [...(children.get(parentId) ?? []), agent]);
  }
  const sort = (items: AgentDto[]) => items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const rows: AgentOrganizationRow[] = [];
  const visited = new Set<string>();
  const visit = (agent: AgentDto, depth: number) => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    rows.push({ agent, depth });
    for (const child of sort([...(children.get(agent.id) ?? [])])) visit(child, depth + 1);
  };
  for (const root of sort(roots)) visit(root, 0);
  for (const agent of sort(active.filter((candidate) => !visited.has(candidate.id)))) visit(agent, 0);
  return rows;
}

export function agentBelongsToConversation(agent: AgentDto, conversationId: string): boolean {
  return agent.conversationIds.includes(conversationId);
}

export type AgentStatus = AgentLifecycleStatus;

export interface AgentLiveHints {
  /** Live SSE run in progress for this agent. */
  running?: boolean;
  /** The last streamed event was an error. */
  error?: boolean;
}

/**
 * Derive the coarse agent status shown in lists and filters from the agent's
 * canonical runs plus any live-stream hints. Live hints win over projected state so
 * a running agent reads as running the instant the stream reports it.
 */
export function deriveAgentStatus(
  detail: AgentDetailDto | undefined,
  hints: AgentLiveHints = {},
): AgentStatus {
  if (hints.running) {
    return "running";
  }
  const runs = detail?.runs ?? [];
  if (runs.some((run) => run.status === "running")) {
    return "running";
  }
  if ((detail?.workItems ?? []).some((item) => item.status === "waiting_approval")) {
    return "waiting";
  }
  if (hints.error) {
    return "failed";
  }
  const latest = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (latest && ["failed", "cancelled", "interrupted", "blocked", "stalled"].includes(latest.status)) return latest.status;
  return "idle";
}

/**
 * Merge the canonical health projection with roster-backed detail. Health may
 * contain a just-created managed agent before the roster query refreshes, so it
 * must seed the map instead of merely decorating agents already in the roster.
 */
export function mergeAgentStatuses(
  agents: AgentDto[],
  health: AgentHealthDto[],
  detailByAgentId: Map<string, AgentDetailDto | undefined>,
): Map<string, AgentStatus> {
  const statuses = new Map<string, AgentStatus>(health.map((agent) => [agent.agentId, agent.status]));
  for (const agent of agents) {
    if (!statuses.has(agent.id)) statuses.set(agent.id, deriveAgentStatus(detailByAgentId.get(agent.id)));
  }
  return statuses;
}

export function agentStatusLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "stalled":
      return "Stalled";
    case "interrupted":
      return "Interrupted";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "compacting":
      return "Compacting";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

export function agentStatusColor(
  status: AgentStatus,
): "success" | "warning" | "info" | "error" | "default" {
  switch (status) {
    case "running":
    case "compacting":
      return "info";
    case "waiting":
      return "warning";
    case "completed":
      return "success";
    case "blocked":
    case "failed":
    case "stalled":
    case "interrupted":
      return "error";
    default:
      return "default";
  }
}

/** Short current-run or waiting-approval line for an agent row. */
export function agentActivity(detail: AgentDetailDto | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const activeRun = [...detail.runs]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .find((run: AgentRunDto) => run.status === "running");
  if (activeRun) {
    return activeRun.title;
  }
  const waitingItem = detail.workItems.find((item) => item.status === "waiting_approval");
  return waitingItem?.title;
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
