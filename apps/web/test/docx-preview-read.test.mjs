import assert from "node:assert/strict";
import test from "node:test";
import { DOCX_PREVIEW_LIMITS, readDocxDocumentXml, readDocxPreview } from "../src/components/filePreview/readDocxPreview.js";
import { basicDocxXml, docxFixture } from "./fixtures/docx-fixture.mjs";

test("DOCX preview reads only the main XML from stored and deflated ZIP packages", async () => {
  for (const compressed of [true, false]) {
    const bytes = docxFixture(basicDocxXml, { compressed });
    assert.equal(await readDocxDocumentXml(bytes, new AbortController().signal), basicDocxXml);
  }
});

test("DOCX preview rejects damaged, ambiguous and oversized package metadata", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readDocxDocumentXml(new Uint8Array(3), signal), /damaged/u);
  await assert.rejects(readDocxDocumentXml(docxFixture().subarray(0, -1), signal), /damaged/u);
  await assert.rejects(readDocxDocumentXml(docxFixture(basicDocxXml, { duplicate: true }), signal), /damaged/u);
  await assert.rejects(readDocxDocumentXml(docxFixture(basicDocxXml, { declaredSize: DOCX_PREVIEW_LIMITS.xmlBytes + 1 }), signal), /too large/u);
  const corrupt = docxFixture(basicDocxXml, { compressed: false });
  corrupt[corrupt.indexOf(Buffer.from("DOCX preview heading"))] ^= 1;
  await assert.rejects(readDocxDocumentXml(corrupt, signal), /damaged/u);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readDocxDocumentXml(docxFixture(), aborted.signal), { name: "AbortError" });
});

test("a tiny false-size compressed bomb is cancelled at the output limit", async (t) => {
  const NativeInflater = globalThis.DecompressionStream;
  let cancelled = false, output = 0;
  globalThis.DecompressionStream = class {
    constructor(format) {
      const native = new NativeInflater(format), reader = native.readable.getReader();
      this.writable = native.writable;
      this.readable = new ReadableStream({ async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else { output += chunk.value.length; controller.enqueue(chunk.value); }
      }, cancel() { cancelled = true; return reader.cancel(); } }, { highWaterMark: 0 });
    }
  };
  t.after(() => { globalThis.DecompressionStream = NativeInflater; });
  const bytes = docxFixture("x".repeat(8 * 1024 * 1024), { declaredSize: 1 });
  assert.ok(bytes.length < 16_000);
  await assert.rejects(readDocxDocumentXml(bytes, new AbortController().signal), /too large/u);
  assert.equal(cancelled, true);
  assert.ok(output < 4 * 1024 * 1024, `cancelled before all eight MiB were inflated (${output})`);
});

test("Word preview fetch refuses external URLs, handles errors and cancels an aborted body", async (t) => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  globalThis.window = { location: { origin: "https://ponderosa.test" } };
  t.after(() => { globalThis.window = oldWindow; globalThis.fetch = oldFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(docxFixture()); };
  assert.equal(await readDocxPreview("/api/docx", new AbortController().signal), basicDocxXml);
  await assert.rejects(readDocxPreview("https://external.test/docx", new AbortController().signal), /Invalid/u);
  await assert.rejects(readDocxPreview("/not-api/docx", new AbortController().signal), /Invalid/u);
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  await assert.rejects(readDocxPreview("/api/docx", new AbortController().signal), /404/u);
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const abort = new AbortController(), pending = readDocxPreview("/api/docx", abort.signal);
  await new Promise(resolve => setTimeout(resolve, 5)); abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});
