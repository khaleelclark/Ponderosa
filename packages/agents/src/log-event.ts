// The canonical agent log stores a SUPERSET of AgentEvent.
//
// SPEC §4's event log includes user turns ("user.message") as well as the engine's
// normalized stream. core's `AgentEvent` is deliberately the *engine* stream only,
// so here we widen it by exactly one variant: a user message. `AgentEvent` is a
// strict subset of `LogEvent`, so anything typed AgentEvent flows in unchanged and
// core stays untouched (no SPEC edit needed — this is an additive superset, not a
// redefinition of a core type).

import type { AgentEvent, AgentExecutionDeltaEvent, AgentOutputEvent, AgentCoordinationV3Dto, ImageAttachmentDto } from "@ponderosa/core";
import type { AgentLifecycleReason, AgentRunStatus, AgentRunWakeCause } from "@ponderosa/core";

/** A human turn appended to the log when the user sends a message (SPEC §4). */
export interface UserMessageEvent {
  type: "user_message";
  communicationEventId?: string;
  text: string;
  replyTo?: import("@ponderosa/core").MessageReferenceDto;
  attachments?: ImageAttachmentDto[];
}

/** Clear a provider session while retaining the canonical agent history. */
export interface SessionResetEvent {
  type: "session_reset";
  reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover";
}

/** Direct Agent audit projection of one canonical communication event. */
export interface CommunicationProjectionEvent {
  type: "communication_projection";
  communicationEventId: string;
  text: string;
  role?: "user" | "assistant" | "system";
  attachments?: ImageAttachmentDto[];
}

/** Durable manager-facing lifecycle transition for ordinary agents. */
export interface AgentLifecycleEvent {
  type: "agent_lifecycle";
  status: AgentRunStatus;
  reason: AgentLifecycleReason;
  executionId: string;
  /** Structural activation cause, recorded only on the running transition. */
  wakeCause?: AgentRunWakeCause;
  /** Requested runtime identity captured when the run starts. */
  model?: string;
  effort?: string;
}

/** Live telemetry mirror of authoritative SQLite V3 coordination state. */
export interface CoordinationV3ChangedEvent {
  type: "coordination_v3_changed";
  coordination: AgentCoordinationV3Dto;
}

/** Provider-created output copied into stable Ponderosa-managed storage. */
export interface GeneratedArtifactEvent {
  type: "generated_artifact";
  /** New captures use a Project-stable id; absent only on legacy events. */
  artifactId?: string;
  executionId: string;
  path: string;
  sourcePath: string;
  name: string;
  mediaType: string;
  size: number;
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

/** Anything that can be appended to an agent's `events.jsonl`. */
export type LogEvent = UserMessageEvent | SessionResetEvent | CommunicationProjectionEvent | AgentLifecycleEvent | CoordinationV3ChangedEvent | GeneratedArtifactEvent | ArtifactVisibilityEvent |
  AgentOutputEvent | TurnDoneLogEvent | Exclude<AgentEvent, { type: "text" | "reasoning" | "turn_done" }> | AgentExecutionDeltaEvent;

/** One line of `events.jsonl`: a LogEvent stamped with a per-agent seq + ts. */
export interface StoredLogEvent {
  /** Monotonic per-agent sequence number, starting at 1. */
  seq: number;
  /** ISO-8601 timestamp when appended. Used as the row timestamp on projection so
   *  a rebuild reproduces byte-identical rows (never Date.now() in a projector). */
  ts: string;
  event: LogEvent;
}
