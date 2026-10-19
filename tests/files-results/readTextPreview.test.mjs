// Run with Node 24: node --test tests/files-results/readTextPreview.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readTextPreview } from '../../apps/web/src/components/filePreview/readTextPreview.ts';

test('text downloads preview as data, with bounded UTF-8 and safe URL handling', async t => {
  const originalFetch=globalThis.fetch;
  const originalWindow=globalThis.window;
  globalThis.window={ location:{ origin:'https://preview.test' } };
  t.after(()=>{globalThis.fetch=originalFetch;globalThis.window=originalWindow;});
  const signal=new AbortController().signal;
  const text='line one\n\n<script>not executable</script> 😀\nlast line';
  globalThis.fetch=async (url, init)=>{
    assert.equal(url,'https://preview.test/api/asset/download');
    assert.equal(init.redirect,'error');
    assert.equal(init.signal,signal);
    return new Response(text,{headers:{'content-disposition':'attachment; filename=test.md'}});
  };
  assert.deepEqual(await readTextPreview('/api/asset/download',signal),{content:text,truncated:false});
  await assert.rejects(readTextPreview('https://other.test/api/asset',signal),/Invalid/);
  await assert.rejects(readTextPreview('javascript:alert(1)',signal),/Invalid/);
  globalThis.fetch=async()=>new Response(null,{status:404});
  await assert.rejects(readTextPreview('/api/missing',signal),/404/);
  const limit=2*1024*1024;
  let cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('a'.repeat(limit-1)+'😀tail')); },
    cancel(){cancelled=true;},
  }));
  const bounded=await readTextPreview('/api/large',signal);
  assert.equal(bounded.truncated,true);
  assert.equal(bounded.content,'a'.repeat(limit-1));
  assert.equal(cancelled,true);
  globalThis.fetch=async()=>new Response('a'.repeat(limit));
  assert.equal((await readTextPreview('/api/exact',signal)).truncated,false);
});

const { readPdfText } = await import('../../apps/web/src/components/filePreview/readPdfPreview.ts');
function pdfChunks(chunks, close = true) {
  let reason;
  const stream = new ReadableStream({ start(controller) {
    for (const items of chunks) controller.enqueue({ items });
    if (close) controller.close();
  }, cancel(value) { reason = value; } });
  return { stream, reason: () => reason };
}
for (const [name, chunks, expected] of [
  ['empty page', [], ''], ['normal chunks', [[{ str: 'café' }], [{ str: '東京 🌲' }]], 'café 東京 🌲'],
  ['exact character boundary', [[{ str: 'x'.repeat(64_000) }]], 'x'.repeat(64_000)],
  ['exact item boundary', [Array.from({ length: 2048 }, () => ({ str: 'a' }))], Array(2048).fill('a').join(' ')],
]) test(`PDF text completeness: ${name}`, async () => {
  const { stream } = pdfChunks(chunks);
  assert.deepEqual(await readPdfText(stream, new AbortController().signal), { text: expected, truncated: false });
  assert.equal(stream.locked, false);
});
for (const split of [false, true]) test(`PDF item limit discloses omitted content ${split ? 'in next chunk' : 'in same chunk'} and cancels with Error`, async () => {
  const items = Array.from({ length: 2048 }, () => ({ str: 'a' }));
  const f = pdfChunks(split ? [items, [{ str: 'omitted' }]] : [[...items, { str: 'omitted' }]], false);
  const result = await readPdfText(f.stream, new AbortController().signal);
  assert.deepEqual(result, { text: Array(2048).fill('a').join(' '), truncated: true });
  assert.ok(f.reason() instanceof Error);
  assert.equal(f.stream.locked, false);
});
test('PDF character limit discloses partial text and never leaves a split surrogate', async () => {
  const f = pdfChunks([[{ str: 'x'.repeat(63_999) + '😀tail' }]], false);
  assert.deepEqual(await readPdfText(f.stream, new AbortController().signal), { text: 'x'.repeat(63_999), truncated: true });
  assert.ok(f.reason() instanceof Error); assert.equal(f.stream.locked, false);
});
test('PDF text extraction preserves failure and abort causes while cancelling pending reads and releasing locks', async () => {
  const failure = new Error('Owned extraction failed');
  const failed = new ReadableStream({ start(controller) { controller.error(failure); } });
  await assert.rejects(readPdfText(failed, new AbortController().signal), error => error === failure);
  assert.equal(failed.locked, false);
  const abort = new AbortController(), f = pdfChunks([], false);
  const pending = readPdfText(f.stream, abort.signal);
  abort.abort(failure);
  await assert.rejects(pending, error => error === failure);
  assert.equal(f.reason(), failure); assert.equal(f.stream.locked, false);
});

// Run the real PDF component's render and page effect with controlled PDF.js,
// canvas and timer boundaries; no browser/provider or second preview algorithm.
const { createRequire } = await import('node:module');
const { readFileSync } = await import('node:fs');
const vm = await import('node:vm');
const pdfRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const React = pdfRequire('react'), ts = pdfRequire('typescript');
const { renderToStaticMarkup } = pdfRequire('react-dom/server');
const pdfFile = new URL('../../apps/web/src/components/filePreview/PdfPreview.tsx', import.meta.url);
const pdfCode = ts.transpileModule(readFileSync(pdfFile, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText.replaceAll('import.meta.url', JSON.stringify(pdfFile.href));
function pdfComponent({ text, stream = () => pdfChunks([[{ str: 'page text' }]]).stream, reader = readPdfText } = {}) {
  const updates = new Map(), effects = [], timers = new Map();
  const canvas = { style: {} };
  const page = { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }), streamTextContent: stream };
  const slots = [{ numPages: 2, getPage: async () => page }, 1, undefined, false, text, 0, 640];
  let state = 0, ref = 0;
  const exports = {};
  const componentReact = { ...React,
    useState: () => { const key = state++; return [slots[key], next => updates.set(key, typeof next === 'function' ? next(slots[key]) : next)]; },
    useRef: initial => ({ current: ref++ === 0 ? canvas : initial && typeof initial === 'object' && 'expires' in initial
      ? { page: 1, expires: Date.now() + 30_000, pending: true } : initial }),
    useEffect: effect => effects.push(effect), useId: () => 'owned-pdf-text',
  };
  vm.runInNewContext(pdfCode, { exports, URL, AbortController, Date, window: { devicePixelRatio: 1 },
    setTimeout: callback => { const key = {}; timers.set(key, callback); return key; }, clearTimeout: key => timers.delete(key),
    require: name => name === 'react' ? componentReact : name === './readPdfPreview' ? { readPdfText: reader }
      : name.startsWith('pdfjs-dist/') ? { GlobalWorkerOptions: {} } : pdfRequire(name),
  }, { filename: pdfFile.pathname });
  let tree;
  function Probe() { tree = exports.default({ url: '/api/owned/preview', title: 'Owned PDF' }); return tree; }
  const html = renderToStaticMarkup(React.createElement(Probe));
  return { html, updates, effects, timers, canvas };
}
for (const [text, message] of [
  [{ text: 'bounded page text', truncated: true }, 'text preview is incomplete'],
  ['unavailable', 'could not be extracted'],
  [{ text: '', truncated: false }, 'No text was found on this PDF page'],
]) test('PDF component discloses ' + message + ' and associates it with the canvas', () => {
  const f = pdfComponent({ text });
  assert.match(f.html, new RegExp(message));
  assert.match(f.html, /aria-describedby="owned-pdf-text"/);
  assert.match(f.html, /id="owned-pdf-text"/);
  assert.match(f.html, /Open or Download/);
  assert.match(f.html, /<canvas/);
  assert.ok(f.html.indexOf(message) < f.html.indexOf("<canvas"), "Disclosure stays above a tall page canvas");
});
test('PDF complete and pending text do not falsely disclose a failure or partial page', () => {
  for (const text of [undefined, { text: 'Complete page text', truncated: false }]) {
    const f = pdfComponent({ text });
    assert.doesNotMatch(f.html, /text preview is incomplete|could not be extracted|No text was found/);
    if (text) assert.match(f.html, /Complete page text/);
  }
});
const flushPdf = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
for (const synchronous of [false, true]) test(`PDF text ${synchronous ? 'stream creation throw' : 'stream rejection'} preserves painted canvas and discloses unavailable`, async () => {
  const f = pdfComponent({ stream: () => {
    if (synchronous) throw Error('Owned synchronous text error');
    return new ReadableStream({ start(controller) { controller.error(new Error('Owned text failure')); } });
  } });
  const cleanup = f.effects[2](); await flushPdf();
  assert.equal(f.updates.get(3), false, 'Painted canvas remains visible');
  assert.equal(f.updates.get(4), 'unavailable');
  assert.equal(f.updates.has(2), false, 'Text failure does not become a visual page error');
  assert.equal(f.timers.size, 0); cleanup();
});
test('PDF text deadline discloses unavailable after paint and fences a late completion', async () => {
  let resolve;
  const f = pdfComponent({ reader: () => new Promise(done => { resolve = done; }) });
  const cleanup = f.effects[2](); await flushPdf();
  assert.equal(f.updates.get(3), false);
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  assert.equal(f.updates.get(4), 'unavailable');
  resolve({ text: 'too late', truncated: false }); await flushPdf();
  assert.equal(f.updates.get(4), 'unavailable'); cleanup();
});
test('PDF page replacement aborts extraction, clears its deadline, and rejects late text', async () => {
  let resolve, signal;
  const f = pdfComponent({ reader: (_stream, current) => { signal = current; return new Promise(done => { resolve = done; }); } });
  const cleanup = f.effects[2](); await flushPdf(); cleanup();
  assert.equal(signal.aborted, true); assert.equal(f.timers.size, 0);
  resolve({ text: 'old page text', truncated: true }); await flushPdf();
  assert.equal(f.updates.get(4), undefined);
});
for (const aborting of [false, true]) test(`PDF ${aborting ? 'abort' : 'partial text'} waits for native closure without requiring a transport cancellation acknowledgement`, async () => {
  let cancelled;
  const stream = new ReadableStream({
    start(controller) { if (!aborting) controller.enqueue({ items: [{ str: 'x'.repeat(64_001) }] }); },
    cancel(reason) { cancelled = reason; return new Promise(() => {}); },
  });
  const controller = new AbortController(), reason = new Error('Owned extraction abort');
  const pending = readPdfText(stream, controller.signal).catch(error => ({ error }));
  if (aborting) controller.abort(reason);
  let timeout;
  const result = await Promise.race([pending, new Promise(resolve => { timeout = setTimeout(() => resolve('still pending'), 100); })]);
  clearTimeout(timeout);
  if (aborting) assert.equal(result.error, reason);
  else assert.deepEqual(result, { text: 'x'.repeat(64_000), truncated: true });
  assert.ok(cancelled instanceof Error);
  assert.equal(stream.locked, false);
});
