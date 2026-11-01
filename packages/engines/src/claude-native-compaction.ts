import type { RuntimeContextUsage } from "@ponderosa/core";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
const tokens = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;

/** One live native command, never a source Run or a cross-crash operation query. */
export class ClaudeNativeCompaction {
  readonly completion: Promise<boolean>;
  readonly usage: Promise<RuntimeContextUsage | undefined>;
  private complete!: (value: boolean) => void;
  private measured!: (value: RuntimeContextUsage | undefined) => void;
  private accepted = false;
  private boundary = false;
  private completed = false;
  private sessionValidated = false;
  private sessionModel?: string;
  private usageRequestId?: string;
  cancelled = false;
  inputSent = false;
  succeeded = false;

  constructor(readonly sessionId: string, readonly commandId: string) {
    this.completion = new Promise(resolve => { this.complete = resolve; });
    this.usage = new Promise(resolve => { this.measured = resolve; });
  }

  fail(): void {
    this.cancelled = true;
    this.succeeded = false;
    this.complete(false);
    this.measured(undefined);
  }

  requestUsage(id: string): boolean {
    if (this.cancelled || !this.completed || this.usageRequestId) return false;
    this.usageRequestId = id;
    return true;
  }

  observe(raw: unknown): void {
    const event = object(raw);
    if (!event || this.cancelled) return;
    if (event.type === "system" && event.subtype === "init") {
      if (event.session_id !== this.sessionId) this.fail();
      else if (typeof event.model === "string" && event.model.trim()) {
        if (this.sessionModel && this.sessionModel !== event.model) this.fail();
        else { this.sessionValidated = true; this.sessionModel = event.model; }
      } else this.fail();
      return;
    }
    if (this.succeeded) return;
    if (event.type === "control_response") {
      const response = object(event.response);
      if (!this.usageRequestId || response?.request_id !== this.usageRequestId) return;
      const usage = object(response.response);
      const usedTokens = usage?.totalTokens, windowTokens = usage?.rawMaxTokens;
      if (!this.completed || !this.sessionValidated || response.subtype !== "success" ||
          (event.session_id !== undefined && event.session_id !== this.sessionId) ||
          !tokens(usedTokens) || !tokens(windowTokens) || windowTokens === 0 ||
          usage?.model !== this.sessionModel) {
        this.fail(); return;
      }
      this.succeeded = true;
      this.measured({ usedTokens, windowTokens,
        providerSessionGeneration: this.sessionId });
      return;
    }
    if (!this.inputSent) return;
    if (event.type === "error" || event.type === "rate_limit_event" || event.type === "conversation_reset") {
      this.fail(); return;
    }
    if (event.session_id !== this.sessionId) {
      if (["result", "assistant", "user", "stream_event"].includes(String(event.type))) this.fail();
      return;
    }
    if (event.parent_tool_use_id != null) { this.fail(); return; }
    if (event.type === "user") {
      if (event.uuid === this.commandId && event.isReplay === true && object(event.message)?.role === "user") this.accepted = true;
      else this.fail();
      return;
    }
    if (event.type === "system" && event.subtype === "compact_boundary") {
      const metadata = object(event.compact_metadata);
      if (!this.accepted || !this.sessionValidated || this.completed || event.isReplay === true ||
          typeof event.uuid !== "string" || !event.uuid || this.boundary ||
          metadata?.trigger !== "manual" || !tokens(metadata.pre_tokens)) {
        this.fail(); return;
      }
      this.boundary = true;
      return;
    }
    if (event.type === "result") {
      const ids = event.user_message_uuids;
      if (!this.accepted || !this.sessionValidated || !this.boundary || this.completed ||
          event.isReplay === true || event.subtype !== "success" || event.is_error !== false ||
          event.local_command !== "compact" || event.user_message_uuid !== this.commandId ||
          (ids !== undefined && (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== this.commandId))) {
        this.fail(); return;
      }
      this.completed = true;
      this.complete(true);
    }
    // No authored text, pre_tokens, aggregate usage or process exit is proof.
  }
}
