import { normalizedToolResult } from "./tool-result.js";
// Codex JSONL → normalized AgentEvent mapping. THE HEART OF THIS CHUNK.
//
// This is the only place in the codebase that knows Codex's event shapes
// (AGENTS.md invariant 2: normalize at the edge). Every `codex exec --json` line
// is one raw event; `mapCodexEvent` turns it into zero or more AgentEvents.
//
// Grounding (recorded from codex-cli 0.143.0):
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id","type":"command_execution","command",
//        "aggregated_output","exit_code","status"}}
//   {"type":"item.completed","item":{"id","type":"agent_message","text"}}
//   {"type":"item.completed","item":{"id","type":"file_change",
//        "changes":[{"path","kind":"add|update|delete"}],"status"}}
//   {"type":"turn.completed","usage":{"input_tokens","output_tokens",...}}
//   {"type":"error","message"} / {"type":"turn.failed","error":{"message"}}

import {
  classifyProviderFailure,
  type AgentEvent,
  type FileChangeKind,
  type ProviderErrorCode,
  type TokenUsage,
} from "@ponderosa/core";

/** Extra context the mapper needs that isn't in the raw event (e.g. the run cwd). */
export interface CodexMapContext {
  /** The run's working directory, attached to `command` events (SPEC §5). */
  cwd?: string;
}

// ─── Raw Codex event shapes (only the fields we consume) ─────────────────────

interface RawItemBase {
  id?: string;
  type?: string;
  status?: string;
}
interface RawAgentMessage extends RawItemBase {
  type: "agent_message";
  text?: string;
}
interface RawReasoning extends RawItemBase {
  // codex has used both "reasoning" and "agent_reasoning" across versions.
  type: "reasoning" | "agent_reasoning";
  text?: string;
  summary?: string;
}
interface RawCommandExecution extends RawItemBase {
  type: "command_execution";
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  signal?: string | null;
}
interface RawFileChange extends RawItemBase {
  type: "file_change";
  changes?: Array<{ path?: string; kind?: string }>;
}
interface RawMcpToolCall extends RawItemBase {
  type: "mcp_tool_call";
  server?: string;
  tool?: string;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  result?: unknown;
  error?: unknown;
}
interface RawWebSearch extends RawItemBase {
  type: "web_search";
  query?: string;
}

type RawItem =
  | RawAgentMessage
  | RawReasoning
  | RawCommandExecution
  | RawFileChange
  | RawMcpToolCall
  | RawWebSearch
  | RawItemBase;

interface RawEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string; code?: unknown; type?: unknown } | string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  item?: RawItem;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map Codex's file-change verbs to the normalized {@link FileChangeKind}. */
export function mapFileChangeKind(kind: string | undefined): FileChangeKind {
  switch (kind) {
    case "add":
    case "create":
    case "added":
      return "create";
    case "delete":
    case "removed":
      return "delete";
    case "update":
    case "modify":
    case "modified":
    case "edit":
    default:
      return "edit";
  }
}

function mapUsage(u: RawEvent["usage"]): TokenUsage | undefined {
  if (!u) return undefined;
  const inputTokens = u.input_tokens;
  const cachedInputTokens = u.cached_input_tokens;
  const outputTokens = u.output_tokens;
  const reasoningOutputTokens = u.reasoning_output_tokens;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  const usage: TokenUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = reasoningOutputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function errorMessage(e: RawEvent["error"], fallback: string): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return fallback;
}

export function providerErrorCodeFromDetail(
  detail: string,
  rawCode?: string,
): ProviderErrorCode | undefined {
  const structuredCategory = rawCode
    ? classifyProviderFailure("", rawCode)
    : "unknown";
  const category = structuredCategory === "unknown"
    ? classifyProviderFailure(detail)
    : structuredCategory;
  if (category === "authentication") return "authentication_failed";
  if (category === "rate_limit") return "rate_limit";
  if (category === "capacity") return "capacity";
  if (category === "context_length") return "context_length";
  if (category === "invalid_request") return "invalid_request";
  if (category === "unavailable") return "network";
  return undefined;
}

function providerErrorCode(error: RawEvent["error"], detail: string): ProviderErrorCode | undefined {
  const rawCode = error && typeof error === "object"
    ? typeof error.code === "string"
      ? error.code
      : typeof error.type === "string"
        ? error.type
        : undefined
    : undefined;
  return providerErrorCodeFromDetail(detail, rawCode);
}

export function codexErrorEvent(error: unknown, detail: string): Extract<AgentEvent, { type: "error" }> {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const value = record(error);
  const info = value?.codexErrorInfo;
  const variant = typeof info === "string" ? info : Object.keys(record(info) ?? {})[0];
  const status = record(record(info)?.[variant ?? ""])?.httpStatusCode;
  const httpStatusCode = Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? Number(status) : undefined;
  const structured: Record<string, ProviderErrorCode> = {
    contextwindowexceeded: "context_length", usagelimitexceeded: "rate_limit",
    unauthorized: "authentication_failed", badrequest: "invalid_request",
  };
  let code = structured[variant?.toLowerCase() ?? ""] ??
    (httpStatusCode === 429 ? "rate_limit" : httpStatusCode === 401 ? "authentication_failed"
      : httpStatusCode !== undefined && httpStatusCode >= 500 ? "network"
        : httpStatusCode !== undefined && httpStatusCode >= 400 && httpStatusCode < 500 ? "invalid_request" : undefined);
  // Parse only this bounded, known Codex envelope. Shared public classification
  // remains opaque to arbitrary JSON and never echoes provider prose.
  if ((!code || code === "invalid_request") && detail.length <= 2_048) {
    try {
      const body = record(JSON.parse(detail));
      const failure = record(body?.error);
      if (body?.status === 400 && failure?.type === "invalid_request_error" &&
          typeof failure.message === "string" && /^The '[a-z0-9][a-z0-9._-]{0,127}' model requires a newer version of Codex\. Please upgrade to the latest app or CLI and try again\.$/u.test(failure.message)) code = "client_upgrade_required";
    } catch { /* Ordinary provider detail is not a JSON envelope. */ }
  }
  code ??= providerErrorCode(error as RawEvent["error"], detail);
  const retryAfterMs = value?.retryAfterMs;
  return { type: "error", message: detail, category: classifyProviderFailure(detail, code), ...(code ? { code } : {}),
    ...(httpStatusCode !== undefined ? { httpStatusCode } : code === "client_upgrade_required" ? { httpStatusCode: 400 } : {}),
    ...(Number.isSafeInteger(retryAfterMs) && Number(retryAfterMs) >= 0 && Number(retryAfterMs) <= 86_400_000 ? { retryAfterMs: Number(retryAfterMs) } : {}),
  };
}

export function commandOutcome(exitCode: unknown, signal: unknown): Pick<Extract<AgentEvent, { type: "tool_result" }>, "exitCode" | "signal" | "isError"> {
  const code = typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 2147483647 ? exitCode : undefined;
  const termination = typeof signal === "string" && /^SIG[A-Z0-9]{1,20}$/u.test(signal) ? signal : undefined;
  return {
    ...(code === undefined ? {} : { exitCode: code }),
    ...(termination === undefined ? {} : { signal: termination }),
    ...(code !== undefined && code !== 0 || termination ? { isError: true } : {}),
  };
}

// ─── The mapper ──────────────────────────────────────────────────────────────

/**
 * Map one raw Codex JSONL event into zero or more normalized {@link AgentEvent}s.
 *
 * Contract notes (documented, deliberate):
 * - Text/reasoning are emitted on `item.completed` (codex 0.143 emits the full
 *   message there, not streamed deltas). `item.updated` is ignored to avoid
 *   double-emitting. `delta` therefore carries the whole message; downstream
 *   treats it as "append this".
 * - A command emits `command` on `item.started` and `tool_result` (its output +
 *   exit code) on `item.completed`, producing a command→result timeline.
 * - A `file_change` emits one `file_change` per entry in `changes[]`.
 * - Unknown event/item types map to `[]` (forward-compatible; nothing is invented).
 */
export function mapCodexEvent(raw: unknown, ctx: CodexMapContext = {}): AgentEvent[] {
  if (raw === null || typeof raw !== "object") return [];
  const ev = raw as RawEvent;

  switch (ev.type) {
    case "thread.started":
      return ev.thread_id ? [{ type: "session", sessionId: ev.thread_id }] : [];

    case "turn.completed":
      return [{ type: "turn_done", usage: mapUsage(ev.usage) }];

    case "turn.failed":
      return [codexErrorEvent(ev.error, errorMessage(ev.error, "turn failed"))];

    case "error":
      return [codexErrorEvent(ev.error, ev.message ?? errorMessage(ev.error, "error"))];

    case "item.started":
      return mapItemStarted(ev.item, ctx);

    case "item.completed":
      return mapItemCompleted(ev.item, ctx);

    // turn.started, item.updated, and anything else: no normalized event.
    default:
      return [];
  }
}

function mapItemStarted(item: RawItem | undefined, ctx: CodexMapContext): AgentEvent[] {
  if (!item) return [];
  switch (item.type) {
    case "command_execution": {
      const it = item as RawCommandExecution;
      return [{
        type: "command",
        command: it.command ?? "",
        cwd: ctx.cwd ?? "",
        ...(it.id ? { callId: it.id } : {}),
      }];
    }
    case "mcp_tool_call": {
      const it = item as RawMcpToolCall;
      return [
        {
          type: "tool_call",
          id: it.id ?? "",
          name: it.name ?? it.tool ?? "mcp",
          input: it.arguments ?? it.input ?? null,
        },
      ];
    }
    default:
      return [];
  }
}

function mapItemCompleted(item: RawItem | undefined, _ctx: CodexMapContext): AgentEvent[] {
  if (!item) return [];
  switch (item.type) {
    case "agent_message": {
      const it = item as RawAgentMessage;
      return it.text ? [{ type: "text", delta: it.text }] : [];
    }
    case "reasoning":
    case "agent_reasoning": {
      const it = item as RawReasoning;
      const text = it.text ?? it.summary ?? "";
      return text ? [{ type: "reasoning", delta: text }] : [];
    }
    case "command_execution": {
      const it = item as RawCommandExecution;
      return [
        {
          type: "tool_result",
          id: it.id ?? "",
          output: it.aggregated_output ?? "",
          ...commandOutcome(it.exit_code, it.signal),
        },
      ];
    }
    case "file_change": {
      const it = item as RawFileChange;
      const changes = it.changes ?? [];
      return changes.map((c) => ({
        type: "file_change" as const,
        path: c.path ?? "",
        kind: mapFileChangeKind(c.kind),
        ...(it.id ? { callId: it.id } : {}),
      }));
    }
    case "mcp_tool_call": {
      const it = item as RawMcpToolCall;
      const isError = it.error != null;
      const value = it.result ?? it.error ?? null;
      const output = typeof value === "string" ? value : JSON.stringify(value);
      return [normalizedToolResult(it.id ?? "", output, isError)];
    }
    case "web_search": {
      const it = item as RawWebSearch;
      return [
        {
          type: "tool_call",
          id: it.id ?? "",
          name: "web_search",
          input: { query: it.query ?? "" },
        },
      ];
    }
    default:
      return [];
  }
}
