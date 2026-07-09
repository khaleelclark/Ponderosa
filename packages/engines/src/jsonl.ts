// Robust JSONL parsing for a child process's stdout. Codex writes one JSON object
// per line, but a chunked stream can split a line across reads, and stray non-JSON
// noise can appear. This buffers across chunks and yields only parsed objects.

/**
 * Incremental line buffer. Feed it raw string chunks; it returns the complete
 * lines available so far and retains any partial trailing line for the next feed.
 * Pure and synchronous — the unit-testable core of the stream parser.
 */
export class LineBuffer {
  private buf = "";

  /** Append a chunk and return any newly-complete lines (without trailing \n). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx = this.buf.indexOf("\n");
    while (idx !== -1) {
      let line = this.buf.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF
      lines.push(line);
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf("\n");
    }
    return lines;
  }

  /** Return and clear any buffered partial line (call at end-of-stream). */
  flush(): string | undefined {
    const rest = this.buf;
    this.buf = "";
    const trimmed = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    return trimmed.length > 0 ? trimmed : undefined;
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
  chunks: AsyncIterable<string>,
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
