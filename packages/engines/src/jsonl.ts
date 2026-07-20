// Robust JSONL parsing for a child process's stdout. Codex writes one JSON object
// per line, but a chunked stream can split a line across reads, and stray non-JSON
// noise can appear. This buffers across chunks and yields only parsed objects.

export const JSONL_MAX_RECORD_BYTES = 4 * 1024 * 1024;

export class JsonlRecordLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`JSONL record exceeded the ${limitBytes}-byte limit`);
    this.name = "JsonlRecordLimitError";
  }
}

/**
 * Incremental line buffer. Feed it raw string chunks; it returns the complete
 * lines available so far and retains any partial trailing line for the next feed.
 * Pure and synchronous — the unit-testable core of the stream parser.
 */
export class LineBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxRecordBytes = JSONL_MAX_RECORD_BYTES) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new Error("JSONL record limit must be a positive safe integer");
    }
  }

  /** Append a chunk and return any newly-complete lines (without trailing \n). */
  push(chunk: string | Buffer): string[] {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const lines: string[] = [];
    let offset = 0;
    while (offset < input.length) {
      const newline = input.indexOf(0x0a, offset);
      const end = newline === -1 ? input.length : newline;
      const segmentBytes = end - offset;
      if (this.bytes + segmentBytes > this.maxRecordBytes) {
        this.clear();
        throw new JsonlRecordLimitError(this.maxRecordBytes);
      }
      if (newline === -1) {
        if (segmentBytes > 0) {
          // Copy only the bounded partial record. Do not retain an arbitrary
          // provider-owned backing buffer containing unrelated later output.
          this.chunks.push(Buffer.from(input.subarray(offset, end)));
          this.bytes += segmentBytes;
        }
        break;
      }
      const complete = this.chunks.length === 0
        ? input.subarray(offset, end)
        : Buffer.concat([...this.chunks, input.subarray(offset, end)], this.bytes + segmentBytes);
      let line = complete.toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF
      lines.push(line);
      this.clear();
      offset = newline + 1;
    }
    return lines;
  }

  /** Return and clear any buffered partial line (call at end-of-stream). */
  flush(): string | undefined {
    if (this.bytes === 0) return undefined;
    const rest = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.bytes);
    this.clear();
    let trimmed = rest.toString("utf8");
    if (trimmed.endsWith("\r")) trimmed = trimmed.slice(0, -1);
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}

/**
 * Parse a single line as JSON. Returns `undefined` for blank lines or non-JSON
 * noise (interleaved log text) rather than throwing — the caller skips those.
 */
export function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  // Fast reject obvious non-JSON noise so we don't try/catch on every log line.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Turn an async iterable of string chunks into an async iterable of parsed JSON
 * values, handling partial lines and skipping non-JSON noise.
 */
export async function* parseJsonlChunks(
  chunks: AsyncIterable<string | Buffer>,
): AsyncIterable<unknown> {
  const lb = new LineBuffer();
  for await (const chunk of chunks) {
    for (const line of lb.push(chunk)) {
      const parsed = parseJsonLine(line);
      if (parsed !== undefined) yield parsed;
    }
  }
  const tail = lb.flush();
  if (tail !== undefined) {
    const parsed = parseJsonLine(tail);
    if (parsed !== undefined) yield parsed;
  }
}
