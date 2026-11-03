import { randomUUID } from "node:crypto";

/** One reader owns responses; timeout is uncertain, never permission to replay. */
export class ClaudeControls {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  uncertain = false;
  constructor(private readonly write: (frame: unknown) => Promise<void>,
    private readonly sessionId?: () => string) {}

  async request(request: Record<string, unknown>): Promise<unknown> {
    if (this.uncertain || this.pending.size >= 16) throw new Error("Claude controls unavailable or uncertain");
    const requestId = `ponderosa-control-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.uncertain = true;
        reject(new Error("Claude control outcome is unknown; do not retry"));
      }, 10_000);
      this.pending.set(requestId, { resolve, reject, timer });
      void this.write({ type: "control_request", request_id: requestId, request }).catch(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(requestId); this.uncertain = true;
        pending.reject(new Error("Claude control transport failed; outcome unknown"));
      });
    });
  }

  observe(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const envelope = raw as {type?: unknown; session_id?: unknown; response?: {request_id?: unknown; subtype?: unknown; response?: unknown; error?: unknown}};
    if (envelope.type !== "control_response" || typeof envelope.response?.request_id !== "string") return false;
    const response = envelope.response;
    const pending = this.pending.get(response.request_id as string);
    if (!pending) return false;
    clearTimeout(pending.timer); this.pending.delete(response.request_id as string);
    if (this.sessionId && envelope.session_id !== undefined && envelope.session_id !== this.sessionId()) {
      this.uncertain = true; pending.reject(new Error("Claude control session changed")); return true;
    }
    if (response.subtype === "success") pending.resolve(response.response);
    else if (response.subtype === "error") {
      // Keep the native cause for the existing host diagnostic/redaction path.
      // A correlated rejection is definite; it never authorizes mutation replay.
      pending.reject(new Error(typeof response.error === "string" && response.error.trim()
        ? `Claude rejected native control: ${response.error}` : "Claude rejected native control"));
    }
    else { this.uncertain = true; pending.reject(new Error("Malformed Claude control acknowledgement; outcome unknown")); }
    return true;
  }

  close(): void {
    this.uncertain = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error("Claude controls closed"));
    }
    this.pending.clear();
  }
}
