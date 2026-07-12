// The normalized event model (SPEC §5). Every engine's runtime stream is mapped
// (inside packages/engines only) into this discriminated union, so the server,
// projectors, and UI all render uniformly and never see runtime-specific shapes.

/**
 * Status of a Task (an execution unit in the Tasks pane). SPEC §2/§12 name three
 * states; encoded here as JSON-safe snake_case identifiers.
 * (Decision recorded in CONTRACTS.md — kept minimal, extend only via a SPEC edit.)
 */
export type TaskStatus = "running" | "waiting_approval" | "done";

/** Kind of change applied to a file, for `file_change` events → Artifacts. */
export type FileChangeKind = "create" | "edit" | "delete";

/** Optional token accounting reported at the end of a turn. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * The normalized agent event union — SPEC §5, verbatim in shape.
 *
 * Server routing (SPEC §5): `text`/`reasoning` → execution-scoped Thinking;
 * `command`/`file_change`/`test_result` → Tasks & Artifacts; `session` → the
 * thread's active session id. Runtime output never implies communication scope.
 * This union is the single contract between engines and everything downstream;
 * changing it requires a SPEC edit (AGENTS.md).
 */
export type AgentEvent =
  | { type: "session"; sessionId: string } // persist for resume
  | { type: "text"; delta: string } // ordinary response delta → Thinking
  | { type: "reasoning"; delta: string } // transient reasoning → Thinking
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "command"; command: string; cwd: string } // → Task/Artifact
  | { type: "file_change"; path: string; kind: FileChangeKind; diff?: string } // → Artifact
  | { type: "test_result"; passed: boolean; summary: string } // → Artifact
  | { type: "task_update"; taskId: string; status: TaskStatus; title?: string }
  | { type: "turn_done"; usage?: TokenUsage }
  | { type: "error"; message: string };

/** The literal `type` discriminants of {@link AgentEvent}. */
export type AgentEventType = AgentEvent["type"];

/**
 * One line of a thread's append-only event log (`events.jsonl`, SPEC §4/§7).
 * `seq` is monotonic per thread and doubles as the SSE event id for reconnect
 * dedupe (SPEC §8 streaming contract). The log is the canonical source of truth;
 * SQLite projections are rebuildable from it.
 */
export interface StoredEvent {
  /** Monotonic per-thread sequence number, starting at 1. */
  seq: number;
  /** ISO-8601 timestamp when the event was appended. */
  ts: string;
  /** The normalized event. */
  event: AgentEvent;
}
