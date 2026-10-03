// Agent is the stable identity presented to the user. This module centralizes the
// user-facing status vocabulary so the Agents tab, sidebar, and detail view
// stay consistent. The underlying data model remains AgentDto/AgentDetailDto.

import type { AgentOperationalStatus, AgentDetailDto, AgentDto, AgentHealthDto, AgentOrganizationHealthDto } from "@ponderosa/core";

export interface AgentOrganizationRow {
  agent: AgentDto;
  depth: number;
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
  return agent.conversationId === conversationId;
}

export type AgentStatus = AgentOperationalStatus;

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
    return "needs_decision";
  }
  if (hints.error) {
    return "failed";
  }
  // Finished Runs are history, not the Agent's present availability. Current
  // problems come from the canonical health projection rather than a stale
  // terminal Run in a bounded detail payload.
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
    case "preparing":
      return "Preparing";
    case "stalled":
      return "Stalled";
    case "interrupted":
      return "Interrupted";
    case "waiting":
      return "Waiting";
    case "needs_decision":
      return "Needs decision";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "compacting":
      return "Refreshing context";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

export type AgentStatusConnection =
  | "connecting"
  | "live"
  | "reconnecting"
  | "stale"
  | "unavailable";

export interface AgentStatusPresentation {
  /** Compact visible label. */
  label: string;
  /** Full non-truncated label for controls and assistive technology. */
  accessibleLabel: string;
  /** Evidence detail suitable for a title or tooltip. */
  detail: string;
}

export function agentStatusPresentation(
  health: AgentHealthDto | AgentOrganizationHealthDto | undefined,
  options: {
    status?: AgentStatus;
    connectionStatus?: AgentStatusConnection;
    phaseEvidenceFresh?: boolean;
    agentNameForId?: (agentId: string) => string | undefined;
  } = {},
): AgentStatusPresentation {
  const status = options.status ?? health?.status ?? "idle";
  const blocker = health && "admissionBlocker" in health ? health.admissionBlocker : undefined;
  const coarseLabel = blocker && status === "blocked"
    ? blocker.kind === "host_resource_pressure" ? "Queued · host resources" : `Queued · ${blocker.providerId} ${blocker.kind === "provider_disabled" ? "disabled" : blocker.kind === "authentication_unknown" ? "authentication unknown" : blocker.kind === "authentication_required" ? "sign-in required" : "unavailable"}`
    : isProviderBlockedHealth(health)
    ? "Provider blocked"
    : agentStatusLabel(status);
  const coarse = {
    label: coarseLabel,
    accessibleLabel: `Agent status: ${coarseLabel}`,
    detail: blocker?.kind === "host_resource_pressure"
      ? `Waiting for host headroom; existing work is not cancelled. Last observation: ${blocker.observedAt ?? "unavailable"}.`
      : `Agent status: ${coarseLabel}`,
  };
  const phase = health?.phase;
  if (
    !phase
    || options.connectionStatus !== "live"
    || options.phaseEvidenceFresh !== true
    || health.status !== status
  ) {
    return coarse;
  }

  if (phase.kind === "running_command" || phase.kind === "using_tool") {
    if (status !== "running" || health.executionId !== phase.executionId) return coarse;
    const label = phase.kind === "running_command" ? "Running command" : "Using tool";
    const identities = [
      `Execution ${phase.executionId}`,
      phase.schedulerRunId ? `Run ${phase.schedulerRunId}` : undefined,
      `Call ${phase.callId}`,
    ].filter(Boolean).join("; ");
    return {
      label,
      accessibleLabel: `Agent status: ${label}`,
      detail: `Agent status: ${label}; ${identities}`,
    };
  }

  if (phase.kind === "stopping") {
    if (
      status !== "running"
      || health.runtimeOwnership !== "cancelling"
      || (phase.executionId && health.executionId !== phase.executionId)
    ) return coarse;
    const identities = [
      phase.executionId ? `Execution ${phase.executionId}` : undefined,
      phase.schedulerRunId ? `Run ${phase.schedulerRunId}` : undefined,
    ].filter(Boolean).join("; ");
    return {
      label: "Stopping",
      accessibleLabel: "Agent status: Stopping",
      detail: `Agent status: Stopping${identities ? `; ${identities}` : ""}`,
    };
  }

  if (phase.kind !== "waiting_on_request" && phase.kind !== "waiting_on_join") {
    return coarse;
  }
  if (
    status !== "waiting"
    || phase.dependencyCount < 1
    || phase.additionalDependencyCount < 0
  ) return coarse;
  const label = phase.dependencyCount > 1
    ? "Waiting on requests"
    : phase.counterpartyAgentIds.length
      ? "Waiting on Agent"
      : "Waiting on request";
  const identity = phase.kind === "waiting_on_join"
    ? [
        `Join ${phase.joinId}`,
        phase.requestIds.length ? `Requests ${phase.requestIds.join(", ")}` : undefined,
      ].filter(Boolean).join("; ")
    : `Request ${phase.requestId}`;
  const counterpartyNames = phase.counterpartyAgentIds
    .map(agentId => options.agentNameForId?.(agentId))
    .filter((name): name is string => Boolean(name));
  const counterparties = phase.counterpartyAgentIds.length
    ? `Agents ${phase.counterpartyAgentIds.map((agentId) => {
        const name = options.agentNameForId?.(agentId);
        return name ? `${name} (${agentId})` : agentId;
      }).join(", ")}`
    : undefined;
  const detail = [
    `Agent status: ${label}`,
    counterparties,
    identity,
    `${phase.dependencyCount} unresolved ${phase.dependencyCount === 1 ? "request" : "requests"}`,
  ].filter(Boolean).join("; ");
  const accessibleLabel = [
    `Agent status: ${label}`,
    counterpartyNames.length ? counterpartyNames.join(", ") : undefined,
  ].filter(Boolean).join("; ");
  return { label, accessibleLabel, detail };
}

/** Provider retry metadata may coexist with a newer active Run. Only the
 * authoritative health reason controls the visible status label. */
export function isProviderBlockedHealth(
  health: Pick<AgentHealthDto, "status" | "reason"> | undefined,
): boolean {
  return health?.status === "blocked" && health.reason === "provider_capacity_unavailable";
}

export function agentStatusColor(
  status: AgentStatus,
): "success" | "warning" | "info" | "error" | "default" {
  switch (status) {
    case "running":
    case "preparing":
    case "compacting":
      return "info";
    case "waiting":
    case "needs_decision":
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
