import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfPreview, readPdfText } from '../src/components/filePreview/readPdfPreview.js';
import { backgroundCooldownRemaining } from '../src/api/backgroundCooldown.js';

test('PDF bytes stay scoped, bounded, abortable and release the reader', async () => {
  const previous = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { location: { origin: 'https://ponderosa.test' } };
  const signal = new AbortController().signal;
  let fetched = 0, cancelled = 0, released = 0, chunks = [];
  const reader = { read: async () => chunks.length ? { value: chunks.shift(), done: false } : { done: true },
    cancel: async () => { cancelled++; }, releaseLock: () => { released++; } };
  globalThis.fetch = async (url, options) => {
    fetched++;
    assert.equal(url, 'https://ponderosa.test/api/assets/pdf');
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    return { ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader } };
  };
  try {
    await assert.rejects(readPdfPreview('https://outside.test/file.pdf', signal), /Invalid PDF/);
    await assert.rejects(readPdfPreview('/public.pdf', signal), /Invalid PDF/);
    assert.equal(fetched, 0);
    chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    assert.deepEqual(await readPdfPreview('/api/assets/pdf', signal), new Uint8Array([1, 2, 3]));
    assert.equal(cancelled, 1); assert.equal(released, 1);
    chunks = [new Uint8Array(80 * 1024 * 1024 + 1)];
    await assert.rejects(readPdfPreview('/api/assets/pdf', signal), /80 MiB/);
    assert.equal(cancelled, 2); assert.equal(released, 2);
    reader.read = async () => { throw new DOMException('Aborted', 'AbortError'); };
    await assert.rejects(readPdfPreview('/api/assets/pdf', signal), { name: 'AbortError' });
    assert.equal(cancelled, 3); assert.equal(released, 3);
    globalThis.fetch = async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '5' }) });
    await assert.rejects(readPdfPreview('/api/assets/pdf', signal), /429/);
    assert.ok(backgroundCooldownRemaining() > 4500);
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Length': String(81 * 1024 * 1024) }), body: { cancel: reader.cancel } });
    await assert.rejects(readPdfPreview('/api/assets/pdf', signal), /80 MiB/);
    assert.equal(cancelled, 4);
  } finally { globalThis.window = previous.window; globalThis.fetch = previous.fetch; }
});

function compressedTextPdf() {
  const text = 'x'.repeat(92);
  const stream = deflateSync(Array.from({ length: 10_000 }, (_, i) => `BT /F1 12 Tf 20 ${20 + i % 100 * 12} Td (${text}) Tj ET`).join('\n'));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 1400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')])];
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = parts[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    parts.push(part); length += part.length;
  }
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

test('small compressed PDF text stops streaming early instead of accumulating the amplified page', async () => {
  const bytes = compressedTextPdf();
  assert.ok(bytes.length < 15_000);
  const task = getDocument({ data: bytes, useSystemFonts: true, useWasm: false });
  try {
    const document = await task.promise, page = await document.getPage(1);
    // Demonstrate the reported amplification only in this disposable regression.
    const baseline = await page.getTextContent();
    assert.ok(baseline.items.length >= 10_000);
    assert.ok(baseline.items.reduce((total, item) => total + (item.str?.length ?? 0), 0) >= 920_000);
    const reader = page.streamTextContent().getReader();
    let received = 0, cancellations = 0, releases = 0;
    const bounded = await readPdfText({ getReader: () => ({
      read: async () => { const chunk = await reader.read(); received += chunk.value?.items.length ?? 0; return chunk; },
      cancel: async reason => { cancellations++; await reader.cancel(reason); },
      releaseLock: () => { releases++; reader.releaseLock(); },
    }) }, new AbortController().signal);
    assert.equal(bounded.length, 64_000);
    assert.ok(received < 2048, `cancel before consuming the whole page: ${received} items received`);
    assert.equal(cancellations, 1); assert.equal(releases, 1);
  } finally { await task.destroy(); }
});

test('PDF text item ceiling cancels the reader and retains only bounded text', async () => {
  let pulls = 0, cancellations = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue({ items: Array.from({ length: 100 }, () => ({ str: 'x' })) }); },
    cancel() { cancellations++; } }, { highWaterMark: 0 });
  const text = await readPdfText(stream, new AbortController().signal);
  assert.equal(text.split(' ').length, 2048);
  assert.equal(pulls, 21); assert.equal(cancellations, 1); assert.equal(stream.locked, false);
});

test('page change or extraction deadline cancels a pending text read and releases its lock', async () => {
  for (const reason of ['page change', 'deadline']) {
    let cancellations = 0;
    const stream = new ReadableStream({ pull() {}, cancel() { cancellations++; } });
    const controller = new AbortController();
    const pending = readPdfText(stream, controller.signal);
    const timeout = setTimeout(() => controller.abort(new DOMException(reason, 'AbortError')), 20);
    try { await assert.rejects(pending, { name: 'AbortError', message: reason }); }
    finally { clearTimeout(timeout); }
    assert.equal(cancellations, 1); assert.equal(stream.locked, false);
  }
});
