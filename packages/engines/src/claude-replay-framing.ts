import { createHash } from "node:crypto";
import { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, LineBuffer, parseJsonLine } from "./jsonl.js";

// 160 MiB admitted binary + base64 expansion + bounded text/envelope headroom.
const MAX_MEDIA_RECORD_BYTES = 224 * 1024 * 1024;
const ENVELOPE_HEADROOM = 1024 * 1024;
// Native JSON object key ordering is not part of the submitted content identity.
function digest(value: unknown): string {
  const hash = createHash("sha256");
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      hash.update("[");
      for (const child of item) { visit(child); hash.update(","); }
      hash.update("]");
    } else if (item !== null && typeof item === "object") {
      hash.update("{");
      for (const key of Object.keys(item).sort()) {
        hash.update(JSON.stringify(key)); hash.update(":");
        visit((item as Record<string, unknown>)[key]); hash.update(",");
      }
      hash.update("}");
    } else { hash.update(JSON.stringify(item) ?? "undefined"); }
  };
  visit(value);
  return hash.digest("hex");
}

/** Only exact expected user media echoes may exceed the ordinary output limit. */
export class ClaudeReplayFraming {
  private readonly pending = new Map<string, { digest: string; limit: number }>();
  constructor(private readonly sessionId: string, private readonly onAccepted?: (id:string)=>void) {}

  expect(id: string, message: unknown, frameBytes: number): void {
    if (this.pending.has(id) || this.pending.size >= 32) throw new Error("Claude media replay window is full or duplicated");
    const limit = Math.max(JSONL_MAX_RECORD_BYTES, frameBytes + ENVELOPE_HEADROOM);
    if (limit > MAX_MEDIA_RECORD_BYTES) throw new Error("Claude media frame exceeds its bounded replay budget");
    this.pending.set(id, { digest: digest(message), limit });
  }
  forget(id: string): void { this.pending.delete(id); }
  clear(): void { this.pending.clear(); }

  private limit(): number {
    return Math.max(JSONL_MAX_RECORD_BYTES, ...Array.from(this.pending.values(), entry => entry.limit));
  }
  private record(line: string): unknown {
    const size = Buffer.byteLength(line, "utf8");
    const raw = parseJsonLine(line);
    const event = raw as { type?: unknown; uuid?: unknown; session_id?: unknown; isReplay?: unknown;
      parent_tool_use_id?: unknown; message?: { role?: unknown; content?: unknown } } | undefined;
    const expected = typeof event?.uuid === "string" ? this.pending.get(event.uuid) : undefined;
    if (expected && event?.type === "user" && event.isReplay === true &&
        event.session_id === this.sessionId && event.parent_tool_use_id == null &&
        event.message?.role === "user" && digest(event.message) === expected.digest && size <= expected.limit) {
      this.pending.delete(event.uuid as string);
      this.onAccepted?.(event.uuid as string);
      // Preserve the receipt envelope; no raw image/PDF bytes reach event mappers.
      return { type: "user", uuid: event.uuid, session_id: event.session_id, parent_tool_use_id: null, isReplay: true,
        message: { role: "user", content: [] } };
    }
    if (expected && event?.type === "user" && event.isReplay === true) {
      throw new Error("Claude media replay did not match the submitted input");
    }
    if (size > JSONL_MAX_RECORD_BYTES) throw new JsonlRecordLimitError(JSONL_MAX_RECORD_BYTES);
    return raw;
  }

  async *parse(chunks: AsyncIterable<string | Buffer>): AsyncIterable<unknown> {
    let line: LineBuffer | undefined;
    try {
      for await (const chunk of chunks) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        let offset = 0;
        while (offset < data.length) {
          line ??= new LineBuffer(this.limit());
          const newline = data.indexOf(0x0a, offset);
          const end = newline === -1 ? data.length : newline + 1;
          for (const complete of line.push(data.subarray(offset, end))) {
            const raw = this.record(complete);
            if (raw !== undefined) yield raw;
          }
          if (newline !== -1) line = undefined;
          offset = end;
        }
      }
      const tail = line?.flush();
      if (tail !== undefined) {
        const raw = this.record(tail);
        if (raw !== undefined) yield raw;
      }
    } finally { this.clear(); }
  }
}
