import {
  type AgentStreamEvent,
  type SseEventEnvelope,
} from "@ponderosa/core";
import type { StoredLogEvent } from "@ponderosa/agents";

function isAgentStreamEvent(event: StoredLogEvent["event"]): event is AgentStreamEvent {
  return event.type !== "user_message" && event.type !== "work_start";
}

function envelope(agentId: string, stored: StoredLogEvent, replayed = false): SseEventEnvelope | undefined {
  if (!isAgentStreamEvent(stored.event)) return undefined;
  return { agentId, seq: stored.seq, ts: stored.ts, event: stored.event, ...(replayed ? { replayed: true } : {}) };
}

const MAX_PENDING_SSE_EVENTS = 1_000;
const MAX_PENDING_SSE_BYTES = 2 * 1024 * 1024;

/** A false write result means Node accepted the frame but needs time to drain.
 * Keep subsequent frames bounded and ordered instead of destroying the stream
 * (which forces every live client to reconnect under ordinary bursts). */
class BoundedSseWriter {
  private readonly pending: string[] = [];
  private pendingBytes = 0;
  private blocked = false;
  private disposed = false;

  constructor(
    private readonly res: NodeJS.WritableStream,
    private readonly onFailure: () => void,
  ) {}

  write(name: string, id: number | undefined, data: unknown): boolean {
    if (this.disposed) return false;
    const frame = `${id === undefined ? "" : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_PENDING_SSE_BYTES) return false;
    if (this.blocked) {
      if (this.pending.length >= MAX_PENDING_SSE_EVENTS ||
          this.pendingBytes + bytes > MAX_PENDING_SSE_BYTES) return false;
      this.pending.push(frame);
      this.pendingBytes += bytes;
      return true;
    }
    try {
      if (!this.res.write(frame)) {
        this.blocked = true;
        this.res.once("drain", this.onDrain);
      }
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.res.off("drain", this.onDrain);
    this.pending.length = 0;
    this.pendingBytes = 0;
  }

  private readonly onDrain = (): void => {
    this.blocked = false;
    while (!this.disposed && this.pending.length > 0) {
      const frame = this.pending.shift()!;
      this.pendingBytes -= Buffer.byteLength(frame);
      try {
        if (!this.res.write(frame)) {
          this.blocked = true;
          this.res.once("drain", this.onDrain);
          return;
        }
      } catch {
        this.onFailure();
        return;
      }
    }
  };
}

export {
  isAgentStreamEvent,
  envelope,
  BoundedSseWriter,
};
