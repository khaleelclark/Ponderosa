import type { AgentHealthDto, WorkspaceActivityCountDto } from "./dto.js";

export type AgentDisplayStatus = "working" | "waiting" | "needs_decision" | "recovering" | "error" | "idle";
export const AGENT_DISPLAY_STATUS_LABELS: Record<AgentDisplayStatus, string> = {
  working: "Working", waiting: "Waiting", needs_decision: "Needs decision",
  recovering: "Recovering", error: "Error", idle: "Idle",
};

/** Present canonical current health; historical Run outcomes are not availability. */
export function agentDisplayStatus(health: Pick<AgentHealthDto, "status"> & Partial<Pick<AgentHealthDto, "reason" | "executionId">>): AgentDisplayStatus {
  switch (health.status) {
    case "needs_decision": return "needs_decision";
    case "running": return health.executionId ? "working" : "waiting";
    case "compacting": return "recovering";
    case "preparing": case "waiting": return "waiting";
    case "blocked": return health.reason === "provider_admission_blocked" || health.reason === "provider_capacity_unavailable" ? "waiting" : "error";
    case "failed": case "stalled": case "interrupted": return "error";
    default: return "idle";
  }
}

/** Counts and aggregate status use the same current-health classification as Agent labels. */
export function summarizeWorkspaceActivity(
  health: ReadonlyArray<AgentHealthDto | undefined>,
  confirmedAt?: string,
): WorkspaceActivityCountDto {
  const counts: WorkspaceActivityCountDto = {
    status: "idle", activeCount: 0, runningCount: 0, refreshingCount: 0, waitingCount: 0,
    recoveryCount: 0, attentionCount: 0, decisionCount: 0, errorCount: 0, idleCount: 0, unknownCount: 0,
  };
  for (const agent of health) {
    if (!agent) { counts.unknownCount++; continue; }
    switch (agentDisplayStatus(agent)) {
      case "working": counts.runningCount++; break;
      case "waiting": counts.waitingCount++; break;
      case "recovering": counts.recoveryCount++; break;
      case "needs_decision": counts.decisionCount++; break;
      case "error": counts.errorCount++; break;
      case "idle": counts.idleCount++; break;
    }
    if (agent.status === "preparing" || agent.status === "compacting") counts.refreshingCount++;
  }
  counts.attentionCount = counts.decisionCount + counts.errorCount;
  counts.activeCount = counts.runningCount + counts.waitingCount + counts.recoveryCount + counts.attentionCount;
  counts.status = counts.errorCount ? "error" : counts.decisionCount ? "needs_decision"
    : counts.recoveryCount ? "recovering" : counts.runningCount ? "working"
    : counts.waitingCount ? "waiting" : counts.unknownCount ? "unknown" : "idle";
  if (!counts.unknownCount && confirmedAt) counts.lastConfirmedAt = confirmedAt;
  return counts;
}
