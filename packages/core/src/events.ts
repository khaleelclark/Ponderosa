// The normalized event model (SPEC §5). Every engine's runtime stream is mapped
// (inside packages/engines only) into this discriminated union, so the server,
// projectors, and UI all render uniformly and never see runtime-specific shapes.

/**
 * Status of an engine-reported work item inside an agent run.
 */
export type WorkItemStatus = "running" | "waiting_approval" | "done";

/** Kind of change applied to a file, for `file_change` events → Artifacts. */
export type FileChangeKind = "create" | "edit" | "delete";

/** Optional token accounting reported at the end of a turn. */
export interface TokenUsage {
  inputTokens?: number;
  /** Input tokens served from a provider cache; included in inputTokens. */
  cachedInputTokens?: number;
  /** Input tokens written to a provider cache; included in inputTokens. */
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  /** Reasoning tokens reported by providers that expose them; included in outputTokens. */
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

/**
 * The normalized agent event union — SPEC §5, verbatim in shape.
 *
 * Server routing (SPEC §5): `text`/`reasoning` → execution-scoped Work log;
 * `command`/`file_change`/`test_result` → Run activity & Artifacts; `session` → the
 * agent's active session id. Runtime output never implies communication scope.
 * This union is the single contract between engines and everything downstream;
 * changing it requires a SPEC edit (AGENTS.md).
 */
export type AgentEvent =
  | { type: "session"; sessionId: string } // persist for resume
  | { type: "text"; delta: string } // ordinary response delta → Work log
  | { type: "reasoning"; delta: string } // transient reasoning → Work log
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "command"; command: string; cwd: string } // → Run activity / Artifact
  | { type: "file_change"; path: string; kind: FileChangeKind; diff?: string } // → Artifact
  | { type: "test_result"; passed: boolean; summary: string } // → Artifact
  | { type: "work_item_update"; workItemId: string; status: WorkItemStatus; title?: string; executionId?: string }
  | { type: "turn_done"; usage?: TokenUsage }
  | { type: "error"; message: string };

/** The literal `type` discriminants of {@link AgentEvent}. */
export type AgentEventType = AgentEvent["type"];

/**
 * One line of an agent's append-only event log (`events.jsonl`, SPEC §4/§7).
 * `seq` is monotonic per agent and doubles as the SSE event id for reconnect
 * dedupe (SPEC §8 streaming contract). The log is the canonical source of truth;
 * SQLite projections are rebuildable from it.
 */
export interface StoredEvent {
  /** Monotonic per-agent sequence number, starting at 1. */
  seq: number;
  /** ISO-8601 timestamp when the event was appended. */
  ts: string;
  /** The normalized event. */
  event: AgentEvent;
}
