import { describe, expect, it } from "vitest";
import { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, LineBuffer, parseJsonLine, parseJsonlChunks } from "../src/jsonl.js";

describe("LineBuffer", () => {
  it("splits complete lines and retains a partial trailing line", () => {
    const lb = new LineBuffer();
    expect(lb.push('{"a":1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    // partial "{"c" is buffered, no line yet
    expect(lb.push(':3}\n')).toEqual(['{"c":3}']);
  });

  it("handles a JSON object split across many chunks", () => {
    const lb = new LineBuffer();
    expect(lb.push('{"ty')).toEqual([]);
    expect(lb.push('pe":"thre')).toEqual([]);
    expect(lb.push('ad.started"}')).toEqual([]);
    expect(lb.push("\n")).toEqual(['{"type":"thread.started"}']);
  });

  it("tolerates CRLF line endings", () => {
    const lb = new LineBuffer();
    expect(lb.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it("flush returns a trailing partial line without a newline", () => {
    const lb = new LineBuffer();
    lb.push('{"a":1}');
    expect(lb.flush()).toBe('{"a":1}');
    expect(lb.flush()).toBeUndefined();
  });

  it("rejects a record by UTF-8 bytes before buffering the complete frame", () => {
    const lb = new LineBuffer(8);
    expect(lb.push("€€")).toEqual([]);
    expect(() => lb.push("€\n")).toThrow(JsonlRecordLimitError);
    expect(lb.flush()).toBeUndefined();
  });
});

describe("parseJsonLine", () => {
  it("parses a JSON object", () => {
    expect(parseJsonLine('{"x":1}')).toEqual({ x: 1 });
  });
  it("returns undefined for blank lines", () => {
    expect(parseJsonLine("   ")).toBeUndefined();
  });
  it("returns undefined for non-JSON noise (interleaved log text)", () => {
    expect(parseJsonLine("Reading additional input from stdin...")).toBeUndefined();
  });
  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(parseJsonLine('{"x":')).toBeUndefined();
  });
});

describe("parseJsonlChunks", () => {
  it("yields parsed objects and skips noise, across chunk boundaries", async () => {
    async function* chunks(): AsyncIterable<string> {
      yield '{"type":"a"}\nReading additional input...\n{"type":';
      yield '"b"}\n{"type":"c"}';
    }
    const out: unknown[] = [];
    for await (const v of parseJsonlChunks(chunks())) out.push(v);
    expect(out).toEqual([{ type: "a" }, { type: "b" }, { type: "c" }]);
  });

  it("stops pulling an oversized partial live record at the hard byte limit", async () => {
    let chunksSupplied = 0;
    async function* chunks(): AsyncIterable<Buffer> {
      while (chunksSupplied < 1_000) {
        chunksSupplied += 1;
        yield Buffer.alloc(64 * 1024, 0x78);
      }
    }
    const consume = async () => {
      for await (const _ of parseJsonlChunks(chunks())) { /* no complete records */ }
    };
    await expect(consume()).rejects.toMatchObject({ limitBytes: JSONL_MAX_RECORD_BYTES });
    expect(chunksSupplied).toBe((JSONL_MAX_RECORD_BYTES / (64 * 1024)) + 1);
  });
});
