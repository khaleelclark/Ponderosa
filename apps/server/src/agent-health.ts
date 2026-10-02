import type {
  AgentDto,
  AgentHealthDto,
  AgentHealthProjectionDto,
  AgentLifecycleReason,
  AgentLifecycleStatus,
  AgentOperationalReason,
  AgentOperationalStatus,
  AgentPhaseDto,
  ProviderBlockedWorkDto,
  AgentRunDto,
} from "@ponderosa/core";

export interface ActiveRunObservation { startedAt: string; executionId?: string; schedulerRunId?: string; leaseExpiresAt?: string; ownershipState?: "running" | "stalled" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" }
export interface PreparingRunObservation {
  runId: string;
  status: string;
  leaseStartedAt: string;
  leaseExpiresAt: string;
  promptInjectionState: "not_injected" | "injecting" | "injected";
}
export interface QueuedDeliveryObservation { createdAt: string }
export interface AgentHealthProjectionInput {
  scope: AgentHealthProjectionDto["scope"];
  agents: AgentDto[];
  activeRuns: ReadonlyMap<string, ActiveRunObservation>;
  preparingRuns?: ReadonlyMap<string, PreparingRunObservation>;
  compactingAgents?: ReadonlyMap<string, string>;
  availability?: (agentId: string) => "running" | "runnable" | "waiting" | "idle";
  pendingDecisionAt?: (agentId: string) => string | undefined;
  providerBlocked?: (agentId: string) => ProviderBlockedWorkDto | undefined;
  admissionBlocker?: (agentId: string) => import("@ponderosa/core").QueuedAdmissionBlockerDto | undefined;
  executionPhase?: (
    agentId: string,
    executionId: string,
  ) => Extract<AgentPhaseDto, { kind: "running_command" | "using_tool" }> | undefined;
  waitingPhase?: (
    agentId: string,
  ) => Extract<AgentPhaseDto, { kind: "waiting_on_request" | "waiting_on_join" }> | undefined;
  latestEvent: (agentId: string) => StatusObservation | undefined;
  runs?: (agentId: string) => readonly AgentRunDto[];
  now?: string;
}
export interface StatusObservation { status: AgentLifecycleStatus; statusTimestamp: string; reason: AgentLifecycleReason; executionId?: string }

type OperationalObservation = {
  status: AgentOperationalStatus;
  statusTimestamp: string;
  reason: AgentOperationalReason;
  executionId?: string;
};

export function projectAgentHealth(input: AgentHealthProjectionInput): AgentHealthProjectionDto {
  const generatedAt = input.now ?? new Date().toISOString();
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
    const preparing = input.preparingRuns?.get(agent.id);
    const compactingAt = input.compactingAgents?.get(agent.id);
    const availability = input.availability?.(agent.id);
    const pendingDecisionAt = input.pendingDecisionAt?.(agent.id);
    const providerBlocked = input.providerBlocked?.(agent.id);
    const admissionBlocker = availability === "runnable" && !active && !preparing && !pendingDecisionAt && !compactingAt && !providerBlocked
      ? input.admissionBlocker?.(agent.id) : undefined;
    const latestEvent = input.latestEvent(agent.id);
    const runs = [...(input.runs?.(agent.id) ?? [])].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const summarizeRun = (run: AgentRunDto | undefined) => run ? ({
      runId: run.id, status: run.status, reason: run.reason,
      ...(run.wakeCause ? { wakeCause: run.wakeCause } : {}),
      updatedAt: run.updatedAt,
    }) : undefined;
    const latestRun = summarizeRun(runs.at(-1));
    const assignedWorkOutcome = summarizeRun([...runs].reverse().find((run) =>
      run.wakeCause !== "coordination" && run.wakeCause !== "collaboration"
    ));
    const activeEvent = active && latestEvent && latestEvent.statusTimestamp >= active.startedAt &&
      (latestEvent.executionId === active.executionId || latestEvent.statusTimestamp > active.startedAt)
      ? latestEvent : undefined;
    const managerAgentId = agent.managerAgentId && agentIds.has(agent.managerAgentId) ? agent.managerAgentId : undefined;
    let observation: OperationalObservation;
    if (pendingDecisionAt) observation = { status: "needs_decision", statusTimestamp: pendingDecisionAt, reason: "pending_user_decision" };
    else if (compactingAt) observation = { status: "compacting", statusTimestamp: compactingAt, reason: "session_rollover_scheduled" };
    else if (active?.ownershipState === "stalled") observation = { status: "stalled", statusTimestamp: active.startedAt, reason: "runtime_event_consumer_stalled" };
    else if (active?.ownershipState === "interrupted") observation = { status: "interrupted", statusTimestamp: active.startedAt, reason: "execution_interrupted" };
    else if (active?.leaseExpiresAt && active.leaseExpiresAt < generatedAt) {
      observation = { status: "blocked", statusTimestamp: active.leaseExpiresAt, reason: "execution_lease_expired" };
    }
    else if (active) observation = activeEvent && activeEvent.status !== "completed" && activeEvent.status !== "idle"
      ? activeEvent : { status: "running", statusTimestamp: active.startedAt, reason: "active_run" };
    else if (preparing) observation = preparing.promptInjectionState === "injected" || preparing.status === "running"
      ? { status: "running", statusTimestamp: preparing.leaseStartedAt, reason: "active_run" }
      : { status: "preparing", statusTimestamp: preparing.leaseStartedAt, reason: "run_preparing" };
    else if (providerBlocked) observation = {
      status: "blocked",
      statusTimestamp: providerBlocked.blockedAt,
      reason: "provider_capacity_unavailable",
    };
    else if (availability === "waiting") observation = { status: "waiting", statusTimestamp: agent.updatedAt, reason: "awaiting_reports" };
    else if (admissionBlocker) observation = { status: "blocked", statusTimestamp: admissionBlocker.observedAt ?? agent.updatedAt, reason: "provider_admission_blocked" };
    else observation = {
      status: "idle",
      statusTimestamp: agent.updatedAt,
      reason: availability === "runnable" ? "queued_delivery" : "no_active_work",
    };
    let phase: AgentPhaseDto | undefined;
    if (observation.status === "running" && active?.ownershipState === "cancelling") {
      phase = {
        kind: "stopping",
        observedAt: generatedAt,
        ...(active.executionId ? { executionId: active.executionId } : {}),
        ...(active.schedulerRunId ? { schedulerRunId: active.schedulerRunId } : {}),
      };
    } else if (
      observation.status === "running"
      && active?.executionId
      && (active.ownershipState === undefined || active.ownershipState === "running")
    ) {
      const evidence = input.executionPhase?.(agent.id, active.executionId);
      if (evidence?.executionId === active.executionId) {
        phase = {
          ...evidence,
          ...(active.schedulerRunId ? { schedulerRunId: active.schedulerRunId } : {}),
        };
      }
    } else if (observation.status === "waiting") {
      phase = input.waitingPhase?.(agent.id);
    }
    return {
      agentId: agent.id,
      ...(managerAgentId ? { managerAgentId } : {}),
      childAgentIds: [...(childIdsByParent.get(agent.id) ?? [])].sort(),
      ...observation,
      ...(admissionBlocker ? { admissionBlocker } : {}),
      ...(phase ? { phase } : {}),
      ...(active?.executionId ? { executionId: active.executionId } : {}),
      ...(preparing ? {
        schedulerRunId: preparing.runId,
        leaseStartedAt: preparing.leaseStartedAt,
        leaseExpiresAt: preparing.leaseExpiresAt,
        promptInjectionState: preparing.promptInjectionState,
      } : active?.leaseExpiresAt ? { leaseExpiresAt: active.leaseExpiresAt } : {}),
      ...(active?.ownershipState && ["running", "stalled", "cancelling", "interrupted"].includes(active.ownershipState)
        ? { runtimeOwnership: active.ownershipState as "running" | "stalled" | "cancelling" | "interrupted" } : {}),
      ...(active && (active.ownershipState === undefined || active.ownershipState === "running") && active.executionId
        ? { runtimeActivity: { state: "responding" as const, executionId: active.executionId, startedAt: active.startedAt } }
        : {}),
      ...(providerBlocked ? { providerBlocked } : {}),
      ...(latestRun ? { latestRun } : {}),
      ...(assignedWorkOutcome ? { assignedWorkOutcome } : {}),
      ...(["needs_decision", "blocked", "stalled", "interrupted"].includes(observation.status)
        ? { attention: {
            status: observation.status as "needs_decision" | "blocked" | "stalled" | "interrupted",
            reason: observation.reason,
            observedAt: observation.statusTimestamp,
          } }
        : {}),
    };
  });
  return { scope: input.scope, generatedAt, agents: agents.sort((a, b) => a.agentId.localeCompare(b.agentId)) };
}
