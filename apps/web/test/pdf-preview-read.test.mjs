import assert from 'node:assert/strict';
import test from 'node:test';
import { readPdfPreview } from '../src/components/filePreview/readPdfPreview.js';
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
