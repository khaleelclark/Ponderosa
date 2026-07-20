import type { AgentHealthDto, AgentHealthProjectionDto, AgentLifecycleReason, AgentLifecycleStatus, AgentDto } from "@ponderosa/core";

export interface ActiveRunObservation { startedAt: string; executionId?: string; leaseExpiresAt?: string; ownershipState?: "running" | "stalled" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" }
export interface QueuedDeliveryObservation { createdAt: string }
export interface AgentHealthProjectionInput {
  scope: AgentHealthProjectionDto["scope"];
  agents: AgentDto[];
  activeRuns: ReadonlyMap<string, ActiveRunObservation>;
  compactingAgents?: ReadonlyMap<string, string>;
  availability?: (agentId: string) => "running" | "runnable" | "waiting" | "idle";
  latestEvent: (agentId: string) => StatusObservation | undefined;
  now?: string;
}
export interface StatusObservation { status: AgentLifecycleStatus; statusTimestamp: string; reason: AgentLifecycleReason; executionId?: string }

export function projectAgentHealth(input: AgentHealthProjectionInput): AgentHealthProjectionDto {
  const agentIds = new Set(input.agents.map((agent) => agent.id));
  const childIdsByParent = new Map<string, Set<string>>();
  for (const agent of input.agents) {
    if (!agent.managerAgentId || !agentIds.has(agent.managerAgentId)) continue;
    const children = childIdsByParent.get(agent.managerAgentId) ?? new Set<string>();
    children.add(agent.id);
    childIdsByParent.set(agent.managerAgentId, children);
  }

  const agents: AgentHealthDto[] = input.agents.map((agent) => {
    const active = input.activeRuns.get(agent.id);
    const compactingAt = input.compactingAgents?.get(agent.id);
    const availability = input.availability?.(agent.id);
    const latestEvent = input.latestEvent(agent.id);
    const activeEvent = active && latestEvent && latestEvent.statusTimestamp >= active.startedAt &&
      (latestEvent.executionId === active.executionId || latestEvent.statusTimestamp > active.startedAt)
      ? latestEvent : undefined;
    const managerAgentId = agent.managerAgentId && agentIds.has(agent.managerAgentId) ? agent.managerAgentId : undefined;
    let observation: StatusObservation;
    if (compactingAt) observation = { status: "compacting", statusTimestamp: compactingAt, reason: "session_rollover_scheduled" };
    else if (active?.ownershipState === "stalled") observation = { status: "stalled", statusTimestamp: active.startedAt, reason: "runtime_event_consumer_stalled" };
    else if (active?.ownershipState === "interrupted") observation = { status: "interrupted", statusTimestamp: active.startedAt, reason: "execution_interrupted" };
    else if (active?.leaseExpiresAt && active.leaseExpiresAt < (input.now ?? new Date().toISOString())) {
      observation = { status: "blocked", statusTimestamp: active.leaseExpiresAt, reason: "execution_lease_expired" };
    }
    else if (active) observation = activeEvent && activeEvent.status !== "completed" && activeEvent.status !== "idle"
      ? activeEvent : { status: "running", statusTimestamp: active.startedAt, reason: "active_run" };
    else if (availability === "waiting" || availability === "runnable") observation = { status: "waiting", statusTimestamp: agent.updatedAt, reason: availability === "waiting" ? "awaiting_reports" : "queued_delivery" };
    else observation = latestEvent ?? { status: "idle", statusTimestamp: agent.updatedAt, reason: "no_active_work" };
    return {
      agentId: agent.id,
      ...(managerAgentId ? { managerAgentId } : {}),
      childAgentIds: [...(childIdsByParent.get(agent.id) ?? [])].sort(),
      ...observation,
      ...(active?.executionId ? { executionId: active.executionId } : {}),
      ...(active?.leaseExpiresAt ? { leaseExpiresAt: active.leaseExpiresAt } : {}),
      ...(active?.ownershipState && ["running", "stalled", "cancelling", "interrupted"].includes(active.ownershipState)
        ? { runtimeOwnership: active.ownershipState as "running" | "stalled" | "cancelling" | "interrupted" } : {}),
      ...(active && (active.ownershipState === undefined || active.ownershipState === "running") && active.executionId
        ? { runtimeActivity: { state: "responding" as const, executionId: active.executionId, startedAt: active.startedAt } }
        : {}),
    };
  });
  return { scope: input.scope, generatedAt: input.now ?? new Date().toISOString(), agents: agents.sort((a, b) => a.agentId.localeCompare(b.agentId)) };
}
