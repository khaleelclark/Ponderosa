import type { AgentEvent } from "@ponderosa/core";
import { mapClaudeAssistantUsage } from "./claude-events.js";

const MAX_TOKENS = 2_147_483_647;
const MAX_OBSERVED_REQUESTS = 4_096;
const MAX_PENDING_SUBMISSIONS = 64;

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u.test(value);
}

/** Occupancy is one main-session request, never the aggregate result usage.
 * Input includes uncached + cache-read + cache-creation tokens (Anthropic's
 * documented total input semantics). No output-token estimate is added. */
export class ClaudeContextUsage {
  private accepting = false;
  private readonly submissions = new Set<string>();
  private readonly observedRequests = new Set<string>();
  private latest?: number;

  constructor(private readonly sessionId: string) {}

  beginTurn(submissionId: string): void {
    this.accepting = false;
    this.submissions.clear();
    this.submit(submissionId);
  }

  submit(submissionId: string): void {
    if (this.submissions.size < MAX_PENDING_SUBMISSIONS) this.submissions.add(submissionId);
  }

  endTurn(): void {
    this.accepting = false;
    this.submissions.clear();
  }

  contextUsage(): { usedTokens: number; providerSessionGeneration: string } | undefined {
    return this.latest === undefined ? undefined : {
      usedTokens: this.latest,
      providerSessionGeneration: this.sessionId,
    };
  }

  observe(raw: unknown): Extract<AgentEvent, { type: "context_usage" }> | undefined {
    // The transport parses JSON, not provider-owned objects with accessors.
    if (!raw || typeof raw !== "object") return undefined;
    const event = raw as Record<string, unknown>;
    if (event.session_id !== this.sessionId || event.parent_tool_use_id !== null) return undefined;
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return undefined;
    // --replay-user-messages echoes accepted inputs with isReplay:true. Only
    // our exact current submission can unlock observations; old echoes cannot.
    if (event.type === "user" && message.role === "user" &&
        typeof event.uuid === "string" && this.submissions.delete(event.uuid)) {
      this.accepting = true;
      return undefined;
    }
    if (!this.accepting || event.type !== "assistant" || event.isReplay === true ||
        message.role !== "assistant" || !identifier(message.id) ||
        !identifier(message.model) || this.observedRequests.has(message.id) ||
        this.observedRequests.size >= MAX_OBSERVED_REQUESTS) return undefined;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") return undefined;
    const counters = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
    if (counters.some(value => typeof value !== "number" || !Number.isSafeInteger(value) ||
        value < 0 || value > MAX_TOKENS)) return undefined;
    const normalized = mapClaudeAssistantUsage(raw);
    const usedTokens = normalized?.inputTokens;
    if (usedTokens === undefined || usedTokens <= 0 || usedTokens > MAX_TOKENS) return undefined;
    // ponytail: retain at most 4096 identities per runtime, then fail closed
    // until replacement. A probabilistic/evicting cache could admit old replay.
    this.observedRequests.add(message.id);
    this.latest = usedTokens;
    return {
      type: "context_usage",
      providerSessionId: this.sessionId,
      providerSessionGeneration: this.sessionId,
      usedTokens,
    };
  }
}
