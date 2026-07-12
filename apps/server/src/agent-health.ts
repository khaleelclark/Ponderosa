import type { AgentHealthDto, AgentHealthProjectionDto, AgentLifecycleReason, AgentLifecycleStatus, SubagentRunDto, ThreadDto } from "@ponderosa/core";
import type { StoredLogEvent } from "@ponderosa/threads";

export interface ActiveRunObservation { startedAt: string; executionId?: string; leaseExpiresAt?: string }
export interface QueuedDeliveryObservation { createdAt: string }
export interface AgentHealthProjectionInput {
  scope: AgentHealthProjectionDto["scope"];
  threads: ThreadDto[];
  delegations: SubagentRunDto[];
  activeRuns: ReadonlyMap<string, ActiveRunObservation>;
  compactingAgents?: ReadonlyMap<string, string>;
  queuedDeliveries: (threadId: string) => QueuedDeliveryObservation[];
  events: (threadId: string) => StoredLogEvent[];
  now?: string;
}
interface StatusObservation { status: AgentLifecycleStatus; statusTimestamp: string; reason: AgentLifecycleReason }

function delegationObservation(run: SubagentRunDto): StatusObservation {
  switch (run.status) {
    case "queued": return { status: "waiting", statusTimestamp: run.updatedAt, reason: "delegation_queued" };
    case "running": return { status: "running", statusTimestamp: run.startedAt ?? run.updatedAt, reason: "active_run" };
    case "awaiting_disposition": return { status: "waiting", statusTimestamp: run.updatedAt, reason: "delegation_awaiting_disposition" };
    case "blocked": return { status: "blocked", statusTimestamp: run.updatedAt, reason: "delegation_blocked" };
    case "cancelled": return { status: "cancelled", statusTimestamp: run.updatedAt, reason: "delegation_cancelled" };
    case "completed": return { status: "completed", statusTimestamp: run.updatedAt, reason: "delegation_completed" };
    case "failed": return { status: "failed", statusTimestamp: run.failure?.occurredAt ?? run.updatedAt, reason: "delegation_failed" };
  }
}

function eventObservation(events: StoredLogEvent[], after?: string): StatusObservation | undefined {
  const candidates = after ? events.filter((item) => item.ts >= after) : events;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index]!;
    if (item.event.type === "error") return { status: "failed", statusTimestamp: item.ts, reason: "runtime_error" };
    if (item.event.type === "agent_lifecycle") return {
      status: item.event.status, statusTimestamp: item.ts, reason: item.event.reason,
    };
    if (item.event.type === "task_update" && item.event.status === "waiting_approval") return { status: "waiting", statusTimestamp: item.ts, reason: "task_waiting_approval" };
    if (item.event.type === "turn_done") return { status: "completed", statusTimestamp: item.ts, reason: "turn_completed" };
    if (item.event.type === "task_update" && item.event.status === "done") return { status: "completed", statusTimestamp: item.ts, reason: "task_completed" };
  }
  return undefined;
}

export function projectAgentHealth(input: AgentHealthProjectionInput): AgentHealthProjectionDto {
  const threadIds = new Set(input.threads.map((thread) => thread.id));
  const runsByChild = new Map<string, SubagentRunDto[]>();
  const childIdsByParent = new Map<string, Set<string>>();
  for (const run of input.delegations) {
    if (!run.childThreadId || !threadIds.has(run.childThreadId)) continue;
    runsByChild.set(run.childThreadId, [...(runsByChild.get(run.childThreadId) ?? []), run]);
    if (run.parentThreadId && threadIds.has(run.parentThreadId)) {
      const children = childIdsByParent.get(run.parentThreadId) ?? new Set<string>();
      children.add(run.childThreadId);
      childIdsByParent.set(run.parentThreadId, children);
    }
  }

  const agents: AgentHealthDto[] = input.threads.map((thread) => {
    const run = [...(runsByChild.get(thread.id) ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const active = input.activeRuns.get(thread.id);
    const compactingAt = input.compactingAgents?.get(thread.id);
    const queued = input.queuedDeliveries(thread.id)[0];
    const events = input.events(thread.id);
    const activeEvent = active ? eventObservation(events, active.startedAt) : undefined;
    const parentAgentId = run?.parentThreadId && threadIds.has(run.parentThreadId) ? run.parentThreadId : undefined;
    let observation: StatusObservation;
    if (compactingAt) observation = { status: "compacting", statusTimestamp: compactingAt, reason: "session_rollover_scheduled" };
    else if (active?.leaseExpiresAt && active.leaseExpiresAt < (input.now ?? new Date().toISOString())) {
      observation = { status: "blocked", statusTimestamp: active.leaseExpiresAt, reason: "execution_lease_expired" };
    }
    else if (active) observation = activeEvent && activeEvent.status !== "completed" && activeEvent.status !== "idle"
      ? activeEvent : { status: "running", statusTimestamp: active.startedAt, reason: "active_run" };
    else if (queued) observation = { status: "waiting", statusTimestamp: queued.createdAt, reason: "queued_delivery" };
    else if (run) observation = delegationObservation(run);
    else observation = eventObservation(events) ?? { status: "idle", statusTimestamp: thread.updatedAt, reason: "no_active_work" };
    return {
      agentId: thread.id,
      ...(parentAgentId ? { parentAgentId } : {}),
      childAgentIds: [...(childIdsByParent.get(thread.id) ?? [])].sort(),
      ...observation,
      ...(active?.executionId ? { executionId: active.executionId } : {}),
      ...(active?.leaseExpiresAt ? { leaseExpiresAt: active.leaseExpiresAt } : {}),
    };
  });
  return { scope: input.scope, generatedAt: input.now ?? new Date().toISOString(), agents: agents.sort((a, b) => a.agentId.localeCompare(b.agentId)) };
}
