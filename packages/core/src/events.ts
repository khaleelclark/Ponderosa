// The normalized event model (SPEC §5). Every engine's runtime stream is mapped
// (inside packages/engines only) into this discriminated union, so the server,
// projectors, and UI all render uniformly and never see runtime-specific shapes.

import type { ProviderFailureCategory } from "./provider-failure-summary.js";
import type { ToolFailureCategory } from "./tool-failure.js";

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

export type BrowserControlOwner = "agent" | "operator";
export type BrowserSessionStatus = "opening" | "ready" | "closed" | "failed";
export type BrowserActionKind =
  | "navigate" | "click" | "type" | "key" | "scroll" | "inspect" | "control"
  | "page_open" | "page_activate" | "page_close" | "page_limit"
  | "upload" | "upload_cancel";
export type ProviderErrorCode =
  | "client_upgrade_required"
  | "invalid_request"
  | "invalid_model"
  | "model_not_found"
  | "authentication_failed"
  | "rate_limit"
  | "capacity"
  | "context_length"
  | "organization_policy"
  | "plan_entitlement"
  | "network"
  | "provider_error";

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
  | {
      /** Current provider-context occupancy, distinct from aggregate billing usage. */
      type: "context_usage";
      providerSessionId: string;
      /** Stable provider session generation; fresh sessions receive a new value. */
      providerSessionGeneration: string;
      usedTokens: number;
      aggregateTokens?: number;
      windowTokens?: number;
    }
  | {
      type: "context_rollover_seed_overflow";
      executionId: string;
      rolloverId: string;
      usedTokens: number;
      lowWaterMark: number;
      seedPromptUtf8Bytes: number;
      /** Canonical source-manifest counts identify which reconstructed sections dominated. */
      contextSections: Array<{ kind: string; count: number }>;
    }
  | {
      type: "context_rollover_completed";
      executionId: string;
      rolloverId: string;
      previousProviderSessionId: string;
      replacementProviderSessionId: string;
      startingOccupancy: number;
    }
  | { type: "work_start"; kind: "command" | "file_change" | "native_tool"; callId?: string } // internal work evidence (start or completion), never reply text or public telemetry
  | { type: "response_text"; providerTurnId: string; itemId: string;
      phase: "final_answer" | "commentary" | "unknown";
      kind: "start" | "delta" | "complete"; text: string } // candidate bytes; no audience or publication authority
  | { type: "text"; delta: string; presentation?: "progress" } // explicit public commentary; still Work log, never Communication
  | { type: "reasoning"; delta: string } // transient reasoning → Work log
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      output: string;
      /** Engine-normalized successful host voice authorization receipt, never audience authority. */
      voiceReplyStreamId?: string;
      isError?: boolean;
      failureCategory?: ToolFailureCategory;
      retryable?: boolean;
      /** Provider-supplied command outcome, not a Run terminal result. */
      exitCode?: number;
      signal?: string;
      /** Connector-local advice only; never authorizes write replay. */
      retryAfterMs?: number;
    }
  | { type: "command"; command: string; cwd: string; callId?: string } // → Run activity / Artifact
  | { type: "file_change"; path: string; kind: FileChangeKind; diff?: string; callId?: string } // → Artifact
  | { type: "test_result"; passed: boolean; summary: string } // → Artifact
  | {
      type: "browser_session";
      sessionId: string;
      executionId: string;
      status: BrowserSessionStatus;
      controlOwner: BrowserControlOwner;
      controlEpoch: number;
      url?: string;
      title?: string;
      reason?: string;
    }
  | {
      type: "browser_action";
      sessionId: string;
      executionId: string;
      actor: BrowserControlOwner;
      action: BrowserActionKind;
      summary: string;
      url?: string;
      /** Agent-declared external side effect for operator audit. */
      consequence?: "submission" | "purchase" | "message" | "account_change" | "other";
      /** Caller-generated retry identity; repeated attempts stay distinguishable. */
      attemptId?: string;
    }
  | {
      type: "browser_console";
      sessionId: string;
      executionId: string;
      level: "log" | "info" | "warning" | "error";
      text: string;
    }
  | {
      type: "browser_screenshot";
      sessionId: string;
      executionId: string;
      artifactId: string;
      path: string;
      width: number;
      height: number;
      size: number;
      sha256: string;
    }
  | { type: "work_item_update"; workItemId: string; status: WorkItemStatus; title?: string; executionId?: string }
  | {
      type: "turn_done";
      usage?: TokenUsage;
      /** Individual provider requests, when reported, for request-tiered pricing. */
      providerRequestUsage?: TokenUsage[];
    }
  | {
      type: "error";
      /** Explicit provider terminal evidence, never inferred from error prose. */
      terminalStatus?: "failed" | "interrupted" | "unknown";
      /** Finite code-owned public summary after the canonical append boundary. */
      message: string;
      code?: ProviderErrorCode;
      /** Structured provider response metadata, never inferred from prose. */
      httpStatusCode?: number;
      retryAfterMs?: number;
      category?: ProviderFailureCategory;
      /** Finite code-owned action paired with category and message. */
      remediation?: string;
    };

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
