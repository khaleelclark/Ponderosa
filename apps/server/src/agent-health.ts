import type { AgentHealthDto, AgentHealthProjectionDto, AgentLifecycleReason, AgentLifecycleStatus, ThreadDto } from "@ponderosa/core";
import type { StoredLogEvent } from "@ponderosa/threads";

export interface ActiveRunObservation { startedAt: string; executionId?: string; leaseExpiresAt?: string; ownershipState?: "running" | "stalled" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" }
export interface QueuedDeliveryObservation { createdAt: string }
export interface AgentHealthProjectionInput {
  scope: AgentHealthProjectionDto["scope"];
  threads: ThreadDto[];
  activeRuns: ReadonlyMap<string, ActiveRunObservation>;
  compactingAgents?: ReadonlyMap<string, string>;
  queuedDeliveries: (threadId: string) => QueuedDeliveryObservation[];
  events: (threadId: string) => StoredLogEvent[];
  now?: string;
}
interface StatusObservation { status: AgentLifecycleStatus; statusTimestamp: string; reason: AgentLifecycleReason }

function eventObservation(events: StoredLogEvent[], after?: string): StatusObservation | undefined {
  const candidates = after ? events.filter((item) => item.ts >= after) : events;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index]!;
    if (item.event.type === "error") return { status: "failed", statusTimestamp: item.ts, reason: "runtime_error" };
    if (item.event.type === "agent_lifecycle") return {
      status: item.event.status === "completed" ? "idle" : item.event.status,
      statusTimestamp: item.ts,
      reason: item.event.reason,
    };
    if (item.event.type === "task_update" && item.event.status === "waiting_approval") return { status: "waiting", statusTimestamp: item.ts, reason: "task_waiting_approval" };
    if (item.event.type === "turn_done") return { status: "idle", statusTimestamp: item.ts, reason: "turn_completed" };
    if (item.event.type === "task_update" && item.event.status === "done") return { status: "idle", statusTimestamp: item.ts, reason: "task_completed" };
  }
  return undefined;
}

export function projectAgentHealth(input: AgentHealthProjectionInput): AgentHealthProjectionDto {
  const threadIds = new Set(input.threads.map((thread) => thread.id));
  const childIdsByParent = new Map<string, Set<string>>();
  for (const thread of input.threads) {
    if (!thread.managerAgentId || !threadIds.has(thread.managerAgentId)) continue;
    const children = childIdsByParent.get(thread.managerAgentId) ?? new Set<string>();
    children.add(thread.id);
    childIdsByParent.set(thread.managerAgentId, children);
  }

  const agents: AgentHealthDto[] = input.threads.map((thread) => {
    const active = input.activeRuns.get(thread.id);
    const compactingAt = input.compactingAgents?.get(thread.id);
    const queued = input.queuedDeliveries(thread.id)[0];
    const events = input.events(thread.id);
    const activeEvent = active ? eventObservation(events, active.startedAt) : undefined;
    const managerAgentId = thread.managerAgentId && threadIds.has(thread.managerAgentId) ? thread.managerAgentId : undefined;
    let observation: StatusObservation;
    if (compactingAt) observation = { status: "compacting", statusTimestamp: compactingAt, reason: "session_rollover_scheduled" };
    else if (active?.ownershipState === "stalled") observation = { status: "stalled", statusTimestamp: active.startedAt, reason: "runtime_event_consumer_stalled" };
    else if (active?.ownershipState === "interrupted") observation = { status: "interrupted", statusTimestamp: active.startedAt, reason: "execution_interrupted" };
    else if (active?.leaseExpiresAt && active.leaseExpiresAt < (input.now ?? new Date().toISOString())) {
      observation = { status: "blocked", statusTimestamp: active.leaseExpiresAt, reason: "execution_lease_expired" };
    }
    else if (active) observation = activeEvent && activeEvent.status !== "completed" && activeEvent.status !== "idle"
      ? activeEvent : { status: "running", statusTimestamp: active.startedAt, reason: "active_run" };
    else if (queued) observation = { status: "waiting", statusTimestamp: queued.createdAt, reason: "queued_delivery" };
    else observation = eventObservation(events) ?? { status: "idle", statusTimestamp: thread.updatedAt, reason: "no_active_work" };
    return {
      agentId: thread.id,
      ...(managerAgentId ? { managerAgentId } : {}),
      childAgentIds: [...(childIdsByParent.get(thread.id) ?? [])].sort(),
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
