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

export type AgentLifecycleReason =
  | "no_active_work" | "active_run" | "work_item_waiting_approval" | "queued_delivery"
  | "awaiting_reports"
  | "work_item_completed" | "turn_completed" | "runtime_error"
  | "session_rollover_scheduled" | "agent_cancelled"
  | "execution_lease_expired" | "execution_interrupted" | "runtime_event_consumer_stalled"
  | "manager_report_missing";
