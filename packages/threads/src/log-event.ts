// The canonical thread log stores a SUPERSET of AgentEvent.
//
// SPEC §4's event log includes user turns ("user.message") as well as the engine's
// normalized stream. core's `AgentEvent` is deliberately the *engine* stream only,
// so here we widen it by exactly one variant: a user message. `AgentEvent` is a
// strict subset of `LogEvent`, so anything typed AgentEvent flows in unchanged and
// core stays untouched (no SPEC edit needed — this is an additive superset, not a
// redefinition of a core type).

import type { AgentEvent } from "@ponderosa/core";

/** A human turn appended to the log when the user sends a message (SPEC §4). */
export interface UserMessageEvent {
  type: "user_message";
  text: string;
  replyTo?: import("@ponderosa/core").MessageReferenceDto;
}

/** Anything that can be appended to a thread's `events.jsonl`. */
export type LogEvent = UserMessageEvent | AgentEvent;

/** One line of `events.jsonl`: a LogEvent stamped with a per-thread seq + ts. */
export interface StoredLogEvent {
  /** Monotonic per-thread sequence number, starting at 1. */
  seq: number;
  /** ISO-8601 timestamp when appended. Used as the row timestamp on projection so
   *  a rebuild reproduces byte-identical rows (never Date.now() in a projector). */
  ts: string;
  event: LogEvent;
}
