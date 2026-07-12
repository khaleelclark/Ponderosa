// The SSE wire contract (SPEC §8 streaming). GET /api/threads/:id/stream emits one
// SSE message per event: the SSE `id:` field is the per-thread `seq`, so a client
// reconnecting with `Last-Event-ID` gets replay-from-seq then live tail, deduped
// by seq (critical for phones locking/unlocking).

import type { AgentEvent } from "./events.js";
import type { AgentLifecycleReason, AgentLifecycleStatus, ImageAttachmentDto, MessageReferenceDto } from "./dto.js";

/** Canonical thread events visible on the live wire, including server-owned records. */
export type ThreadStreamEvent = AgentEvent
  | { type: "user_message"; communicationEventId?: string; text: string; replyTo?: MessageReferenceDto; attachments?: ImageAttachmentDto[] }
  | { type: "session_reset"; reason: "explicit_compaction" | "resume_compaction_failed" }
  | { type: "communication_projection"; communicationEventId: string; text: string; role?: "user" | "assistant" | "system"; attachments?: ImageAttachmentDto[] }
  | { type: "agent_lifecycle"; status: AgentLifecycleStatus; reason: AgentLifecycleReason; executionId?: string };

/**
 * The JSON payload of a `data:` line on the event stream. Wraps a StoredEvent's
 * fields plus the threadId. The SSE `id:` line carries `seq` separately (used for
 * Last-Event-ID reconnect), and this envelope repeats it for convenience.
 */
export interface SseEventEnvelope {
  threadId: string;
  seq: number;
  ts: string;
  event: ThreadStreamEvent;
}

/**
 * The named SSE event types the server sends. `event: message` carries an
 * {@link SseEventEnvelope}; `event: heartbeat` is a periodic keep-alive with no
 * meaningful payload; `event: done` signals the run ended (client may stop tailing).
 */
export type SseEventName = "message" | "heartbeat" | "done";

/** The keep-alive payload (SPEC §8: heartbeats keep phone connections warm). */
export interface SseHeartbeat {
  ts: string;
}
