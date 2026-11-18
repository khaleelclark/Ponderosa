import type { AgentEvent } from "@ponderosa/core";

/** Ponderosa's model for Claude agents that select none, and for its access check. */
export const CLAUDE_DEFAULT_MODEL = "sonnet";

/** Offered Claude models, in the order the access check tries them. */
export const CLAUDE_PROBE_MODELS = [CLAUDE_DEFAULT_MODEL, "opus", "haiku"] as const;

/**
 * Claude Code may otherwise answer on a fallback model when the selected one
 * is unavailable or refuses. The selected model must answer or the Run fails.
 */
export const CLAUDE_MODEL_ENVIRONMENT = { CLAUDE_CODE_NO_MODEL_FALLBACK: "1" } as const;

const ALIASES = new Set(["fable", "opus", "sonnet", "haiku"]);
const base = (id: string) => id.trim().replace(/\[1m\]$/iu, "");

/**
 * Whether the model Claude reported is the one Ponderosa selected.
 * Undefined when the selection cannot be verified from Claude's report.
 * ponytail: provider-specific IDs (Bedrock, Vertex, gateways) are not verified;
 * add their reported-ID mapping here if those deployments need the same check.
 */
export function claudeModelMatches(
  selected: string | undefined,
  answered: string,
  environment: Readonly<Record<string, string | undefined>> = {},
): boolean | undefined {
  const id = selected ? base(selected) : "";
  if (!id) return undefined;
  const alias = id.toLowerCase();
  const pinned = ALIASES.has(alias) ? environment[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`]?.trim() : undefined;
  const exact = pinned ? base(pinned) : id;
  const reported = base(answered);
  if (!pinned && ALIASES.has(alias)) return reported.startsWith(`claude-${alias}-`);
  if (!pinned && !exact.startsWith("claude-")) return undefined;
  // Claude may report a dated snapshot of the exact ID it was given.
  return reported === exact || new RegExp(`^${exact.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-\\d{8}$`, "u").test(reported);
}

/**
 * Stops a Run when Claude resolves or answers with a model other than the
 * selected one. Each init pins the exact model it resolved; top-level replies
 * must then come from that model, so a same-family fallback is caught too.
 */
export function claudeModelGuard(
  selected: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = {},
): (raw: unknown) => Extract<AgentEvent, { type: "error" }> | undefined {
  let resolved: string | undefined;
  return raw => {
    const event = raw && typeof raw === "object" ? raw as { type?: unknown; subtype?: unknown; model?: unknown; parent_tool_use_id?: unknown; message?: { model?: unknown } } : undefined;
    const init = event?.type === "system" && event.subtype === "init";
    const answered = init ? event.model
      : event?.type === "assistant" && event.parent_tool_use_id === null ? event.message?.model : undefined;
    // Claude labels its own locally generated notices "<synthetic>".
    if (typeof answered !== "string" || !answered.trim() || answered === "<synthetic>") return undefined;
    const matches = !init && resolved !== undefined ? base(answered) === resolved : claudeModelMatches(selected, answered, environment) !== false;
    if (matches) {
      if (init) resolved = base(answered);
      return undefined;
    }
    return { type: "error", code: "invalid_model", category: "invalid_request",
      message: `Claude ${init ? "started" : "answered"} with ${answered.slice(0, 200)} instead of the selected ${String(selected).slice(0, 200)}. The Run was stopped so a different model is never used silently.` };
  };
}
