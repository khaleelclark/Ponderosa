import { randomUUID } from "node:crypto";
import type { NativeTaskStopOutcome } from "@ponderosa/core";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Uses the existing single reader. Success is acknowledgement, never task exit. */
export class ClaudeTaskStop {
  private readonly pending = new Map<string, (outcome: NativeTaskStopOutcome) => void>();
  constructor(private readonly sessionId: string) {}

  async stop(taskId: string, write: (frame: unknown) => Promise<void>): Promise<NativeTaskStopOutcome> {
    if (this.pending.size >= 100) throw new Error("Too many native task stop requests");
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<NativeTaskStopOutcome>(resolve => {
      this.pending.set(requestId, resolve);
      timer = setTimeout(() => resolve("unknown"), 15_000);
    });
    try {
      // Register before the write; neither timeout nor failed write is retried.
      void write({ type: "control_request", request_id: requestId,
        request: { subtype: "stop_task", task_id: taskId } }).catch(() => this.pending.get(requestId)?.("unknown"));
      return await result;
    } catch { return "unknown"; }
    finally { if (timer) clearTimeout(timer); this.pending.delete(requestId); }
  }

  observe(raw: unknown): boolean {
    const envelope = record(raw), response = record(envelope?.response);
    if (envelope?.type !== "control_response" || typeof response?.request_id !== "string") return false;
    const complete = this.pending.get(response.request_id);
    if (!complete) return false;
    complete(response.subtype === "success" && (envelope.session_id === undefined || envelope.session_id === this.sessionId)
      ? "acknowledged" : "unknown");
    return true;
  }

  close(): void {
    for (const complete of this.pending.values()) complete("unknown");
    this.pending.clear();
  }
}
