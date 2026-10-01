// The SSE wire contract (SPEC §8 streaming). GET /api/agents/:id/stream emits one
// SSE message per event: the SSE `id:` field is the per-agent `seq`, so a client
// reconnecting with `Last-Event-ID` gets replay-from-seq then live tail, deduped
// by seq (critical for phones locking/unlocking).

import type { AgentEvent } from "./events.js";
import type { AgentExecutionDeltaEvent, AgentLifecycleReason, AgentRunStatus, AgentRunWakeCause, AgentOutputEvent, AgentCoordinationV3Dto, AssetDto, ContextRolloverTriggeredEvent } from "./dto.js";

/** Canonical agent events visible on the live wire, including server-owned records. */
export type AgentStreamEvent = Exclude<AgentEvent, { type: "text" | "reasoning" }>
  | AgentExecutionDeltaEvent
  | AgentOutputEvent
  | { type: "user_message"; communicationEventId?: string; text: string; attachments?: AssetDto[] }
  | { type: "session_reset"; reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover" | "tool_contract_changed" | "provider_root_exit" }
  | { type: "communication_projection"; communicationEventId: string; text: string; role?: "user" | "assistant" | "system"; attachments?: AssetDto[] }
  | { type: "coordination_v3_changed"; coordination: AgentCoordinationV3Dto }
  | ContextRolloverTriggeredEvent
  | { type: "agent_lifecycle"; status: AgentRunStatus; reason: AgentLifecycleReason; executionId: string; wakeCause?: AgentRunWakeCause };

/**
 * The JSON payload of a `data:` line on the event stream. Wraps a StoredEvent's
 * fields plus the agentId. The SSE `id:` line carries `seq` separately (used for
 * Last-Event-ID reconnect), and this envelope repeats it for convenience.
 */
export interface SseEventEnvelope {
  agentId: string;
  seq: number;
  ts: string;
  event: AgentStreamEvent;
  /** True for catch-up records written before the live subscription boundary. */
  replayed?: boolean;
}

/** Durable Agent-stream identity and high-water mark, sent before replay. */
export interface AgentStreamStatusDto {
  agentId: string;
  instanceId: string;
  cursor: number;
  reset: boolean;
  /** Refresh canonical projections and resume at cursor; oversized telemetry
   * remains in the audit log rather than being replayed on the live wire. */
  snapshot?: boolean;
}
