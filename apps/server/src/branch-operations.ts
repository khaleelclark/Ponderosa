import type Database from "better-sqlite3";
import type { BranchExecutionDto, BranchOperationalSummaryDto } from "@ponderosa/core";

type Row = Record<string, any>;
export interface ProviderIntakeStatus {
  enabled?: boolean;
  authentication: "checking" | "authenticated" | "unauthenticated" | "error";
  intakeReady: boolean;
  reachability?: "unverified" | "checking" | "reachable" | "degraded";
  availabilityCategory?: string;
  availabilityDetail?: string;
}
type ProviderStatus = (engineId: string) => Promise<ProviderIntakeStatus | undefined>;

/** A bounded operator projection of canonical Branch, Request, Run, and provider intake state. */
export async function branchOperationalSummary(
  db: Database.Database,
  execution: BranchExecutionDto,
  providerStatus?: ProviderStatus,
): Promise<BranchOperationalSummaryDto> {
  const now = new Date().toISOString();
  const steps = db.prepare("SELECT id,state FROM branch_step_executions WHERE execution_id=?").all(execution.id) as Row[];
  const attempts = db.prepare(
    "SELECT a.id,a.step_execution_id,a.number,a.state,a.available_at,a.updated_at,a.error," +
    "r.id request_id,r.state request_state,r.created_at request_created_at,r.recipient_agent_id agent_id," +
    "ag.title agent_title,ag.active_engine engine_id " +
    "FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id " +
    "LEFT JOIN coordination_requests r ON r.id=a.request_id LEFT JOIN agents ag ON ag.id=r.recipient_agent_id " +
    "WHERE s.execution_id=? AND NOT EXISTS (SELECT 1 FROM branch_attempts newer WHERE newer.step_execution_id=a.step_execution_id AND newer.number>a.number)"
  ).all(execution.id) as Row[];
  const mapPaths = db.prepare(
    "SELECT p.state FROM branch_map_items m JOIN branch_map_invocations mi ON mi.id=m.map_invocation_id " +
    "JOIN branch_paths p ON p.id=m.path_id WHERE mi.execution_id=?"
  ).all(execution.id) as Row[];
  const pendingGates = (db.prepare(
    "SELECT COUNT(*) count FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id " +
    "WHERE s.execution_id=? AND g.state='waiting'"
  ).get(execution.id) as Row).count as number;
  const waitingAttempts = ["queued", "running", "waiting"].includes(execution.state)
    ? attempts.filter(a => a.state === "waiting" && a.request_id && a.request_state !== "outcome_unknown")
    : [];
  const engineIds = [...new Set(waitingAttempts.map(a => a.engine_id).filter((id): id is string => typeof id === "string"))];
  const engines = new Map(await Promise.all(engineIds.map(async id => {
    try { return [id, await providerStatus?.(id)] as const; }
    catch { return [id, { authentication: "error" as const, intakeReady: false }] as const; }
  })));
  const agentIds = [...new Set(waitingAttempts.map(a => a.agent_id).filter((id): id is string => typeof id === "string"))];
  const activeRuns = waitingAttempts.length ? db.prepare(
    "SELECT sr.id,sr.agent_id,a.kind,a.payload_json FROM scheduler_runs sr " +
    "LEFT JOIN scheduler_run_activations ra ON ra.run_id=sr.id " +
    "LEFT JOIN agent_activations a ON a.id=ra.activation_id " +
    "WHERE sr.status IN ('leased','running') AND sr.terminal_at IS NULL"
  ).all() as Row[] : [];
  const runByAgent = new Map<string, Row>();
  const attachedRequests = new Set<string>();
  for (const row of activeRuns) {
    runByAgent.set(row.agent_id, row);
    if (row.kind === "coordination_request" && row.payload_json) {
      try {
        const requestId = JSON.parse(row.payload_json).requestId;
        if (typeof requestId === "string") attachedRequests.add(requestId);
      } catch { /* An invalid activation cannot become Request attachment evidence. */ }
    }
  }
  const retryByRequest = new Map<string, Row>();
  const retryStatement = db.prepare(
    "SELECT json_extract(payload_json,'$.requestId') request_id,available_at,provider_failure_category " +
    "FROM agent_activations WHERE agent_id=? AND kind='coordination_request' AND state='retry_pending' " +
    "ORDER BY available_at,id"
  );
  for (const agentId of agentIds) for (const row of retryStatement.all(agentId) as Row[]) {
    if (typeof row.request_id === "string" && !retryByRequest.has(row.request_id)) retryByRequest.set(row.request_id, row);
  }
  const classifiedWaits = waitingAttempts.map(a => {
    const provider = engines.get(a.engine_id);
    const retry = retryByRequest.get(a.request_id);
    const run = runByAgent.get(a.agent_id);
    let state: BranchOperationalSummaryDto["agentWaits"][number]["state"] = "waiting_agent";
    let label = "Waiting for Agent";
    let reason: string | undefined;
    let nextRetryAt: string | undefined;
    if (a.request_state === "awaiting_answer") {
      state = "waiting_human"; label = "Agent needs an answer";
    } else if (a.request_state === "waiting_dependency") {
      state = "waiting_dependency"; label = "Agent waiting on another task";
    } else if (a.request_state === "in_progress" || attachedRequests.has(a.request_id)) {
      state = "agent_running"; label = "Agent work in progress";
    } else if (run) {
      state = "agent_busy"; label = "Agent busy - queued"; reason = "Another Run is active for this Agent.";
    } else if (provider && provider.enabled === false) {
      state = "provider_attention"; label = "Provider paused"; reason = "Provider intake is disabled in settings.";
    } else if (provider && provider.authentication !== "authenticated") {
      state = "provider_attention"; label = "Provider needs attention"; reason = "Check provider sign-in and configuration in Settings.";
    } else if (retry) {
      state = retry.provider_failure_category === "rate_limit" || retry.provider_failure_category === "capacity"
        ? "provider_retry" : "retry_pending";
      label = state === "provider_retry" ? "Provider retry scheduled" : "Retry scheduled";
      nextRetryAt = retry.available_at;
      reason = retry.provider_failure_category === "rate_limit"
        ? "Provider quota is unavailable; the Request remains queued for retry."
        : retry.provider_failure_category === "capacity"
          ? "Provider capacity is unavailable; the Request remains queued for retry."
          : "This Request remains queued for retry.";
    } else if (provider && !provider.intakeReady) {
      state = "provider_unavailable"; label = "Provider unavailable - queued for recovery";
      reason = provider.availabilityDetail || "The Request remains queued until provider access recovers.";
    }
    return {
      requestId: a.request_id as string, agentId: a.agent_id as string,
      agentName: a.agent_title || "Agent", engineId: a.engine_id || undefined,
      state, label, since: a.request_created_at || a.updated_at,
      ...(reason ? { reason } : {}),
      ...(nextRetryAt ? { nextRetryAt } : {}),
    };
  });
  const count = (state: string) => steps.filter(row => row.state === state).length;
  const unknown = attempts.filter(a => a.state === "outcome_unknown" || a.request_state === "outcome_unknown").length;
  const retrying = attempts.filter(a => a.number > 1 && ["prepared", "leased", "running", "waiting"].includes(a.state)).length;
  const scheduledRetries = attempts.filter(a => a.number > 1 && a.state === "prepared" && a.available_at && a.available_at > now).length;
  const humanRequests = classifiedWaits.filter(a => a.state === "waiting_human").length;
  const counts = {
    completed: count("completed"),
    running: count("running") + count("leased"),
    retrying,
    failed: count("failed"),
    waitingAgent: waitingAttempts.length,
    waitingHuman: pendingGates + humanRequests,
    needsReconciliation: unknown,
    mapItems: mapPaths.length,
    mapSettled: mapPaths.filter(row => ["arrived", "failed", "canceled"].includes(row.state)).length,
  };
  let state: BranchOperationalSummaryDto["state"];
  let label: string;
  if (execution.state === "completed") { state = "completed"; label = "Completed"; }
  else if (execution.state === "failed") { state = "failed"; label = "Failed"; }
  else if (execution.state === "canceled") { state = "canceled"; label = "Canceled"; }
  else if (execution.state === "skipped") { state = "skipped"; label = "Skipped"; }
  else if (execution.state === "merged") { state = "merged"; label = "Merged into another execution"; }
  else if (unknown) { state = "needs_reconciliation"; label = "Needs reconciliation"; }
  else if (classifiedWaits.some(wait => wait.state === "provider_attention")) { state = "provider_attention"; label = "Provider needs attention"; }
  else if (classifiedWaits.some(wait => wait.state === "provider_unavailable")) { state = "provider_unavailable"; label = "Provider unavailable"; }
  else if (pendingGates || humanRequests) { state = "waiting_human"; label = "Waiting on a person"; }
  else if (classifiedWaits.some(wait => wait.state === "provider_retry" || wait.state === "retry_pending") || scheduledRetries) { state = "retrying"; label = "Retry scheduled"; }
  else if (counts.running) { state = "running"; label = "Running normally"; }
  else if (waitingAttempts.length) { state = "waiting_agent"; label = "Waiting for Agent"; }
  else if (execution.state === "queued") { state = "queued"; label = execution.budgetWait ? "Waiting for automatic execution budget" : "Queued"; }
  else { state = "blocked"; label = "Waiting for other work"; }
  const agentWaits = classifiedWaits.slice(0, 100);
  return { executionId: execution.id, state, label, observedAt: now, counts, agentWaits, additionalAgentWaits: Math.max(0, classifiedWaits.length - agentWaits.length) };
}
