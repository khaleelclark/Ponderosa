import { normalizedToolResult } from "./tool-result.js";
// Claude Code (`claude`) stream-json → normalized AgentEvent mapping.
//
// Like events.ts (Codex), this is the ONLY place that knows Claude Code's event
// shapes (AGENTS.md invariant 2). Driven by the subscription-authenticated
// `claude` CLI — never the Anthropic API, never an API key (invariant 1).
//
// Grounding (recorded from claude-code 2.1.x `--output-format stream-json`):
//   {"type":"system","subtype":"init","session_id":"...","cwd":"...","tools":[...]}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}], ...}}
//   {"type":"assistant","message":{"content":[{"type":"tool_use","id","name":"Bash",
//        "input":{"command":"..."}}]}}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...",
//        "content":"...","is_error":false}]}}
//   {"type":"result","subtype":"success","is_error":false,"result":"...","usage":{...}}
//   {"type":"rate_limit_event", ...}  (informational — ignored)

import {
  type AgentEvent,
  type FileChangeKind,
  type ProviderErrorCode,
  type TokenUsage,
} from "@ponderosa/core";
import type { CodexMapContext } from "./events.js";
import { claudeProviderErrorCode } from "./claude-models.js";

interface RawBlock {
  type?: string;
  text?: string;
  runOutput?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawMessage {
  model?: string;
  id?: string;
  content?: RawBlock[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

interface RawClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: RawMessage;
  result?: string;
  is_error?: boolean;
  error?: string;
  errors?: string[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function providerErrorMessage(code: ProviderErrorCode | undefined, detail: string): string {
  switch (code) {
    case "invalid_model":
      return `Claude rejected the selected model as invalid${detail ? `: ${detail}` : ""}`;
    case "model_not_found":
      return `Claude could not find or access the selected model${detail ? `: ${detail}` : ""}`;
    case "authentication_failed":
      return `Claude authentication failed${detail ? `: ${detail}` : ""}`;
    case "rate_limit":
      return `Claude usage limit was reached${detail ? `: ${detail}` : ""}`;
    case "capacity":
      return `Claude is at capacity${detail ? `: ${detail}` : ""}`;
    case "context_length":
      return `Claude context limit was reached${detail ? `: ${detail}` : ""}`;
    case "organization_policy":
      return `Claude organization policy rejected the request${detail ? `: ${detail}` : ""}`;
    case "plan_entitlement":
      return `The Claude plan rejected the selected model${detail ? `: ${detail}` : ""}`;
    case "network":
      return `Claude could not reach the provider${detail ? `: ${detail}` : ""}`;
    default:
      return detail || "claude run failed";
  }
}

/** Claude Code's file-mutating tools → a normalized {@link FileChangeKind}. */
function fileChangeKindForTool(tool: string): FileChangeKind {
  switch (tool) {
    case "Write":
      return "create";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Update":
    default:
      return "edit";
  }
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"]);

function mapUsage(u: RawClaudeEvent["usage"]): TokenUsage | undefined {
  if (!u) return undefined;
  const cachedInputTokens = u.cache_read_input_tokens;
  const cacheWriteInputTokens = u.cache_creation_input_tokens;
  const inputTokens = u.input_tokens !== undefined || cachedInputTokens !== undefined || u.cache_creation_input_tokens !== undefined
    ? (u.input_tokens ?? 0) + (cachedInputTokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    : undefined;
  const outputTokens = u.output_tokens;
  const usage: TokenUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (cacheWriteInputTokens !== undefined) usage.cacheWriteInputTokens = cacheWriteInputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Claude's result-event usage is the aggregate for the whole CLI turn. Context
 * occupancy instead comes from the most recent assistant message, whose usage
 * describes the single provider request that produced that message.
 */
export function mapClaudeAssistantUsage(raw: unknown): TokenUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const event = raw as RawClaudeEvent;
  return event.type === "assistant" ? mapUsage(event.message?.usage) : undefined;
}

/** Coerce a tool_result `content` (string | block[] | unknown) to plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : typeof b === "string"
            ? b
            : JSON.stringify(b),
      )
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * Map one Claude Code stream-json event into zero or more {@link AgentEvent}s.
 * Routing mirrors the Codex mapper so downstream (projectors, UI) is engine-agnostic.
 */
export function mapClaudeEvent(raw: unknown, ctx: CodexMapContext = {}): AgentEvent[] {
  if (raw === null || typeof raw !== "object") return [];
  const ev = raw as RawClaudeEvent;

  switch (ev.type) {
    case "system":
      return ev.subtype === "init" && ev.session_id
        ? [{ type: "session", sessionId: ev.session_id }]
        : [];

    case "assistant": {
      const mapped = mapAssistant(ev.message, ctx);
      if (!ev.error) return mapped;
      const detail = mapped
        .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
        .map((event) => event.delta)
        .join(" ")
        .trim();
      const code = claudeProviderErrorCode(ev.error, detail);
      return [{ type: "error", message: providerErrorMessage(code, detail), ...(code ? { code } : {}) }];
    }

    case "user":
      return mapUser(ev.message);

    case "result": {
      const out: AgentEvent[] = [];
      if (ev.is_error) {
        const detail = [
          ev.result ?? "",
          ...(ev.errors ?? []),
        ].filter(Boolean).join(" ").trim();
        const code = claudeProviderErrorCode(ev.error, detail);
        out.push({
          type: "error",
          message: providerErrorMessage(code, detail),
          ...(code ? { code } : {}),
        });
      }
      out.push({ type: "turn_done", usage: mapUsage(ev.usage) });
      return out;
    }

    // rate_limit_event, stream_event (partials, not requested), etc. → nothing.
    default:
      return [];
  }
}

function mapAssistant(message: RawMessage | undefined, ctx: CodexMapContext): AgentEvent[] {
  const blocks = message?.content ?? [];
  const out: AgentEvent[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (b.text && b.text.trim() !== "") out.push({ type: "text", delta: b.text });
        break;
      case "runOutput":
        if (b.runOutput && b.runOutput.trim() !== "")
          out.push({ type: "reasoning", delta: b.runOutput });
        break;
      case "tool_use": {
        const name = b.name ?? "";
        if (name === "Bash") {
          const command = String(b.input?.["command"] ?? "");
          out.push({ type: "command", command, cwd: ctx.cwd ?? "", ...(b.id ? { callId: b.id } : {}) });
        } else if (FILE_TOOLS.has(name)) {
          const path = String(b.input?.["file_path"] ?? b.input?.["path"] ?? "");
          out.push({ type: "file_change", path, kind: fileChangeKindForTool(name), ...(b.id ? { callId: b.id } : {}) });
        } else {
          out.push({
            type: "tool_call",
            id: b.id ?? "",
            name: name || "tool",
            input: b.input ?? null,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function mapUser(message: RawMessage | undefined): AgentEvent[] {
  const blocks = message?.content ?? [];
  const out: AgentEvent[] = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      const output = toolResultText(b.content);
      out.push(normalizedToolResult(b.tool_use_id ?? "", output, b.is_error === true));
    }
  }
  return out;
}
