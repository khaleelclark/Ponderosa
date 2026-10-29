// The canonical agent log stores a SUPERSET of AgentEvent.
//
// SPEC §4's event log includes user turns ("user.message") as well as the engine's
// normalized stream. core's `AgentEvent` is deliberately the *engine* stream only,
// so here we widen it by exactly one variant: a user message. `AgentEvent` is a
// strict subset of `LogEvent`, so anything typed AgentEvent flows in unchanged and
// core stays untouched (no SPEC edit needed — this is an additive superset, not a
// redefinition of a core type).

import type { AgentEvent, AgentExecutionDeltaEvent, AgentOutputEvent, AgentCoordinationV3Dto, AssetDto, ContextRolloverTriggeredEvent } from "@ponderosa/core";
import type { AgentLifecycleReason, AgentRunStatus, AgentRunWakeCause } from "@ponderosa/core";

/** A human turn appended to the log when the user sends a message (SPEC §4). */
export interface UserMessageEvent {
  type: "user_message";
  communicationEventId?: string;
  text: string;
  attachments?: AssetDto[];
}

/** Clear a provider session while retaining the canonical agent history. */
export interface SessionResetEvent {
  type: "session_reset";
  reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover" | "tool_contract_changed" | "provider_root_exit" | "agent_cancelled";
}

/** Durable proof of the exact provider contract and artifact roots retained by
 * one accepted native session. A raw provider `session` event deliberately
 * clears this snapshot until the owning Run completes successfully. */
export interface SessionSnapshotEvent {
  type: "session_snapshot";
  sessionId: string;
  /** Run whose exact provider input opened or resumed this accepted snapshot. */
  executionId?: string;
  toolContractHash: string;
  artifactIds: string[];
}

/** One canonical acceptance boundary for a verified rollover candidate. The
 * projector switches the provider snapshot and consumes the exact handoff in
 * one SQLite transaction; raw provider session events never do either. */
export interface ContextRolloverSessionAcceptedEvent {
  type: "context_rollover_session_accepted";
  rolloverId: string;
  sessionId: string;
  toolContractHash: string;
  artifactIds: string[];
  handoffId: string;
  executionId: string;
}

/** Bounded working-state bridge supplied by the authoritative Run that asked
 * Ponderosa to replace its provider session. Canonical history remains the
 * source of truth. */
export interface ContinuationHandoffEvent {
  type: "continuation_handoff";
  handoffId: string;
  executionId: string;
  text: string;
}

/** Durable acknowledgement that a fresh provider session accepted the handoff.
 * Until this event exists, a failed fresh attempt may safely receive it again. */
export interface ContinuationHandoffConsumedEvent {
  type: "continuation_handoff_consumed";
  handoffId: string;
  executionId: string;
}

/** Direct Agent audit projection of one canonical communication event. */
export interface CommunicationProjectionEvent {
  type: "communication_projection";
  communicationEventId: string;
  text: string;
  role?: "user" | "assistant" | "system";
  attachments?: AssetDto[];
}

/** Durable, text-minimal audit evidence for one bounded compaction-history read. */
export interface CanonicalHistoryRetrievalEvent {
  type: "compaction_history_retrieval";
  source?: "canonical";
  executionId: string;
  runId: string;
  action: "search" | "read";
  query?: string;
  communicationEventId?: string;
  normalizedQuery?: string;
  querySha256: string;
  strategy?: "lexical";
  compactionCutoffOrdinal: number;
  outcome: "results" | "no_match" | "rejected";
  reason?: string;
  scannedMessages: number;
  eligibleMessages: number;
  matchedMessages: number;
  selected: Array<{
    communicationEventId: string;
    contentSha256: string;
    matchBasis?: "lexical";
    startCodePoint?: number;
    endCodePoint?: number;
    totalCodePoints?: number;
    complete?: boolean;
  }>;
  excludedCurrentContextEventIds: string[];
  responseUtf8Bytes: number;
  hasMore: boolean;
  durationMs: number;
}

/** Imported references and returned ranges remain separate from canonical
 * Communication IDs and rollover exclusions in the same Run audit stream. */
export interface ImportedHistoryRetrievalEvent {
  type: "compaction_history_retrieval";
  source: "imported";
  executionId: string;
  runId: string;
  action: "search" | "read";
  archiveVersion: string;
  query?: string;
  reference?: string;
  normalizedQuery?: string;
  querySha256: string;
  strategy?: "lexical";
  outcome: "results" | "no_match" | "rejected";
  reason?: string;
  scannedMessages: number;
  eligibleMessages: number;
  matchedMessages: number;
  selected: Array<{
    reference: string;
    contentSha256: string;
    startCodePoint?: number;
    endCodePoint?: number;
  }>;
  responseUtf8Bytes: number;
  hasMore: boolean;
  durationMs: number;
}

export type CompactionHistoryRetrievalEvent = CanonicalHistoryRetrievalEvent | ImportedHistoryRetrievalEvent;

/** Durable manager-facing lifecycle transition for ordinary agents. */
export interface AgentLifecycleEvent {
  type: "agent_lifecycle";
  status: AgentRunStatus;
  reason: AgentLifecycleReason;
  executionId: string;
  /** Structural activation cause, recorded only on the running transition. */
  wakeCause?: AgentRunWakeCause;
  /** Requested runtime identity captured when the run starts. */
  engine?: string;
  model?: string;
  effort?: string;
  /** Diagnostic evidence only; never an admission, retry, or completion authority. */
  runtimeObservation?: {
    runId: string;
    fencingToken?: number;
    runtimeGeneration: number;
    providerSessionGeneration?: string;
    process?: { pid: number; pgid?: number; birthMarker?: string };
    terminalEventObserved: boolean;
    terminalStatus?: "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
    rootExit?: { exitCode?: number; signal?: string };
    hostOperation?: string;
    origin: "host_operation_observed" | "not_established";
  };
}

/** Live telemetry mirror of authoritative SQLite V3 coordination state. */
export interface CoordinationV3ChangedEvent {
  type: "coordination_v3_changed";
  coordination: AgentCoordinationV3Dto;
}

/** Provider-created output copied into stable Ponderosa-managed storage. */
export interface GeneratedArtifactEvent {
  type: "generated_artifact";
  artifactId: string;
  executionId: string;
  path: string;
  sourcePath: string;
  name: string;
  mediaType: string;
  size: number;
  /** Immutable digest of the already-published Project-owned bytes. */
  sha256: string;
  visibility: "project" | "published";
  pinned?: boolean;
}

export interface ArtifactVisibilityEvent {
  type: "artifact_visibility";
  artifactId: string;
  visibility: "project" | "published";
  pinned: boolean;
}

/** Runtime completion enriched by the server with its canonical execution id. */
export type TurnDoneLogEvent = Extract<AgentEvent, { type: "turn_done" }> & { executionId?: string };

/** Host-owned binding for fresh native-command telemetry, never provider input. */
export type ContextUsageLogEvent = Extract<AgentEvent, { type: "context_usage" }> & {
  providerCommand?: { name: "compact"; executionId: string; fencingToken: number; invocationId: string };
};

/** Anything that can be appended to an agent's `events.jsonl`. */
export type LogEvent = import("@ponderosa/core").MemoryChangedEvent | import("@ponderosa/core").VoiceReplyEvent | UserMessageEvent | SessionResetEvent | SessionSnapshotEvent | ContextRolloverSessionAcceptedEvent | ContinuationHandoffEvent | ContinuationHandoffConsumedEvent | CommunicationProjectionEvent | CompactionHistoryRetrievalEvent | AgentLifecycleEvent | CoordinationV3ChangedEvent | GeneratedArtifactEvent | ArtifactVisibilityEvent |
  AgentOutputEvent | TurnDoneLogEvent | ContextRolloverTriggeredEvent | ContextUsageLogEvent |
  (Extract<AgentEvent, { type: "work_start" }> & { executionId: string }) | Exclude<AgentEvent, { type: "text" | "reasoning" | "turn_done" | "response_text" | "work_start" | "context_usage" }> | AgentExecutionDeltaEvent;

/** One line of `events.jsonl`: a LogEvent stamped with a per-agent seq + ts. */
export interface StoredLogEvent {
  /** Monotonic per-agent sequence number, starting at 1. */
  seq: number;
  /** ISO-8601 timestamp when appended. Used as the row timestamp on projection so
   *  a rebuild reproduces byte-identical rows (never Date.now() in a projector). */
  ts: string;
  event: LogEvent;
}
