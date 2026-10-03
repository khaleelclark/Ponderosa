export interface HistoryWindowDto {
  limit: number;
  hasMore: boolean;
  /** Opaque keyset cursor for the next older page. Absent at the beginning of history. */
  cursor?: string;
}

/** A stable keyset page. Items are returned oldest-first for direct timeline prepend. */
export interface HistoryPageDto<T> {
  items: T[];
  history: HistoryWindowDto;
}

/** Manager-facing lifecycle vocabulary. Some runtimes cannot yet emit every state. */
export type AgentLifecycleStatus = "idle" | "running" | "stalled" | "interrupted" | "waiting" | "blocked" | "compacting" | "cancelled" | "completed" | "failed";
export type AgentRunStatus = Exclude<AgentLifecycleStatus, "idle">;

/** Current operator-facing state derived from canonical Run, coordination, and
 * Decision authority. `needs_decision` is not a provider Run state. */
export type AgentOperationalStatus = AgentLifecycleStatus | "needs_decision" | "preparing";

export type AgentLifecycleReason =
  | "no_active_work" | "active_run" | "work_item_waiting_approval" | "queued_delivery"
  | "awaiting_reports"
  | "work_item_completed" | "turn_completed" | "runtime_error"
  | "session_rollover_scheduled" | "agent_cancelled"
  | "execution_lease_expired" | "execution_interrupted" | "runtime_event_consumer_stalled"
  | "manager_report_missing";

/** Durable retry state for provider quota/capacity failures. The Activation IDs
 * remain stable while the scheduler backs off or an operator changes runtime settings. */
export interface ProviderBlockedWorkDto {
  classification: "capacity" | "rate_limit";
  activationIds: string[];
  retryEligible: boolean;
  blockedAt: string;
  nextRetryAt: string;
  deliveryFailures: number;
}

export type AgentOperationalReason =
  | AgentLifecycleReason
  | "pending_user_decision"
  | "run_preparing"
  | "provider_capacity_unavailable"
  | "provider_admission_blocked";

/** Payload-free, current admission observation. Not an execution result. */
export interface QueuedAdmissionBlockerDto {
  kind: "provider_disabled" | "authentication_unknown" | "authentication_required" | "provider_unavailable" | "host_resource_pressure";
  providerId: string;
  observedAt?: string;
  resourceAdmission?: import("./provider-engine.js").ResourceAdmissionDto;
  /** At most five minutes old; explicitly not current authentication authority. */
  lastKnownAuthentication?: { authenticated: boolean; observedAt: string };
}
