import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript');

// Execute the real modules; only browser APIs and React's scheduling are controlled.
function browser() {
  const timers = new Map(), intervals = new Map(); let id = 0;
  const window = Object.assign(new EventTarget(), {
    isSecureContext: true, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); },
    setInterval(fn) { intervals.set(++id, fn); return id; }, clearInterval(key) { intervals.delete(key); },
  });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: {} });
  const surface = { isConnected: true, hidden: false, parentElement: null, hasAttribute: () => false, getAttribute: () => null, getClientRects: () => [{ width: 20, height: 20 }] };
  const globals = { window, document, navigator: { language: 'en-US' }, Event, Error,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout };
  const modules = new Map();
  function load(name, imports = {}) {
    if (modules.has(name)) return modules.get(name);
    const exports = {}; modules.set(name, exports);
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/speech/' + name + '.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { ...globals, exports, require: key => { if (key in imports) return imports[key]; if (key.startsWith('./')) return load(key.slice(2)); assert.fail(key); } });
    return exports;
  }
  const accessibility = load('speechSurfaceAccessibility');
  return { window, document, surface, globals, load, accessibility, timers, intervals };
}
function playback() {
  const b = browser(), spoken = []; let cancels = 0;
  b.globals.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  b.window.speechSynthesis = { speak: u => spoken.push(u), cancel: () => cancels++, paused: false, pause() { this.paused = true; }, resume() { this.paused = false; } };
  const api = b.load('speechCoordinator', { './speechSurfaceAccessibility': b.accessibility });
  return { ...b, ...api, spoken, cancels: () => cancels, start: id => api.startSpeech(id, 'Exact spoken text', { speed: 1.25 }, () => b.surface) };
}
function dictation() {
  const b = browser(), instances = [], transcripts = [], settling = [], state = [], cleanups = [];
  let index = 0, mounted = false;
  const useState = initial => { const i = index++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next; }]; };
  const react = { useState, useRef: value => useState(() => ({ current: value }))[0], useCallback: fn => fn, useEffect(fn) { if (!mounted) cleanups.push(fn()); } };
  b.window.SpeechRecognition = class {
    constructor() { instances.push(this); this.aborts = 0; this.stops = 0; }
    start() {} stop() { this.stops++; } abort() { this.aborts++; }
  };
  const support = b.load('browserSpeech');
  const api = b.load('useDictation', { react, './browserSpeech': support, './speechSurfaceAccessibility': b.accessibility });
  const ref = { current: b.surface };
  const render = () => { index = 0; const result = api.useDictation(text => transcripts.push(text), value => settling.push(value), ref); mounted = true; return result; };
  return { ...b, render, instances, transcripts, settling, unmount() { for (const cleanup of cleanups) cleanup?.(); } };
}
const result = (text, isFinal = true) => ({ isFinal, 0: { transcript: text }, length: 1 });
const recognitionEvent = (...results) => ({ results, resultIndex: 0 });

test('Q03 support detection distinguishes HTTPS, missing APIs and browser failures', () => {
  const b = browser(), api = b.load('browserSpeech');
  assert.match(api.dictationUnavailableReason(), /not supported/u);
  b.window.SpeechRecognition = class {};
  assert.equal(api.dictationUnavailableReason(), undefined);
  b.window.isSecureContext = false; assert.match(api.dictationUnavailableReason(), /HTTPS/u);
  assert.match(api.dictationErrorMessage('not-allowed'), /permission was denied/u);
  assert.match(api.dictationErrorMessage('audio-capture'), /microphone/u);
  assert.match(api.dictationErrorMessage('network'), /could not connect/u);
});
test('Q03 repeated final result history inserts each position once, retaining intentional repeated phrases', () => {
  const b = dictation(); b.render().start(); const r = b.instances[0];
  assert.equal(r.continuous, true); assert.equal(r.interimResults, false);
  r.onstart(); assert.equal(b.render().status, 'listening');
  r.onresult(recognitionEvent(result('hello'), result('hypothesis', false)));
  r.onresult(recognitionEvent(result('hello'), result('hello')));
  r.onresult(recognitionEvent(result('hello'), result('hello')));
  assert.deepEqual(b.transcripts, ['hello', 'hello']);
  b.unmount(); assert.equal(b.intervals.size, 0);
});
test('Q03 pause settles final text, resume fences saved callbacks, stop settles once', () => {
  const b = dictation(); b.render().start(); const old = b.instances[0], late = old.onresult;
  b.render().pause(); assert.equal(b.render().status, 'pausing');
  old.onresult(recognitionEvent(result('last words'))); old.onend();
  assert.equal(b.render().status, 'paused'); assert.equal(b.timers.size, 0);
  b.render().resume(); late(recognitionEvent(result('stale text')));
  const current = b.instances[1]; b.render().stop(); current.onend();
  assert.equal(b.render().status, 'stopped'); assert.deepEqual(b.transcripts, ['last words']);
  assert.deepEqual(b.settling, [true, false, true, false]); b.unmount();
});
for (const boundary of ['timeout', 'surface', 'pagehide', 'unmount', 'error']) test(`Q03 ${boundary} fences dictation callbacks and releases settling/resources`, () => {
  const b = dictation(); b.render().start(); const r = b.instances[0], late = r.onresult;
  if (boundary === 'timeout') { b.render().stop(); [...b.timers.values()][0](); }
  else if (boundary === 'surface') { b.surface.hidden = true; b.document.dispatchEvent(new Event('visibilitychange')); }
  else if (boundary === 'pagehide') b.window.dispatchEvent(new Event('pagehide'));
  else if (boundary === 'unmount') b.unmount();
  else r.onerror({ error: 'not-allowed' });
  late(recognitionEvent(result('must never insert')));
  assert.deepEqual(b.transcripts, []); assert.equal(b.settling.at(-1), false); assert.equal(b.intervals.size, 0); assert.equal(r.aborts, 1);
  if (boundary !== 'unmount') { assert.equal(b.render().status, 'error'); assert.match(b.render().error, /review the draft/u); b.unmount(); }
});
test('Q03 playback has one owner, exact speed/text, and stale callbacks cannot stop its replacement', () => {
  const b = playback(); b.start('first'); const old = b.spoken[0], lateEnd = old.onend, lateError = old.onerror;
  b.start('second'); assert.equal(b.cancels(), 1); assert.equal(b.spoken[1].rate, 1.25); assert.equal(b.spoken[1].text, 'Exact spoken text');
  lateEnd(); lateError(); b.stopSpeech('first'); assert.equal(b.speechSnapshot().ownerId, 'second'); assert.equal(b.cancels(), 1);
  b.releaseSpeechSurface('second'); assert.equal(b.speechSnapshot().status, 'stopped'); assert.equal(b.intervals.size, 0);
});
test('Q03 delayed playback start cannot undo an explicit pause', async () => {
  const b = playback(); b.start('owner'); b.pauseSpeech(); b.spoken[0].onstart();
  assert.equal(b.speechSnapshot().status, 'paused'); await b.resumeSpeech(); assert.equal(b.speechSnapshot().status, 'speaking'); b.stopSpeech();
});
test('Q03 browser pause refusal reports an error and releases ownership instead of throwing from a UI callback', () => {
  const b = playback(); b.start('owner'); const late = b.spoken[0].onstart;
  b.window.speechSynthesis.pause = () => { throw Error('Browser pause refused'); };
  assert.doesNotThrow(() => b.pauseSpeech()); assert.equal(b.speechSnapshot().status, 'error'); assert.equal(b.intervals.size, 0);
  late(); assert.equal(b.speechSnapshot().status, 'error'); b.start('retry'); assert.equal(b.speechSnapshot().ownerId, 'retry'); b.stopSpeech();
});
for (const boundary of ['hidden', 'pagehide', 'resume-error']) test(`Q03 playback ${boundary} releases its owner and ignores late completion`, async () => {
  const b = playback(); b.start('owner'); const late = b.spoken[0].onend;
  if (boundary === 'hidden') { b.document.visibilityState = 'hidden'; b.document.dispatchEvent(new Event('visibilitychange')); }
  else if (boundary === 'pagehide') b.window.dispatchEvent(new Event('pagehide'));
  else { b.pauseSpeech(); b.window.speechSynthesis.resume = () => { throw Error('Browser resume refused'); }; await b.resumeSpeech(); }
  assert.equal(b.speechSnapshot().status, boundary === 'resume-error' ? 'error' : 'stopped'); assert.equal(b.intervals.size, 0); assert.equal(b.cancels(), 1);
  late(); assert.equal(b.cancels(), 1);
});

for (const stopped of [false, true]) test(`Q03 new playback resumes the browser after a paused ${stopped ? 'stopped' : 'replaced'} owner`, () => {
  const b = playback(); b.start('first'); b.pauseSpeech(); assert.equal(b.window.speechSynthesis.paused, true);
  if (stopped) b.stopSpeech('first'); // Native cancel deliberately preserves the browser's paused state.
  b.start('next'); assert.equal(b.window.speechSynthesis.paused, false); assert.equal(b.speechSnapshot().ownerId, 'next');
  assert.equal(b.speechSnapshot().status, 'loading'); b.spoken.at(-1).onstart(); assert.equal(b.speechSnapshot().status, 'speaking'); b.stopSpeech();
});
test('Q03 a refused browser reset does not queue a new utterance or retain ownership', () => {
  const b = playback(); b.start('first'); b.pauseSpeech(); b.window.speechSynthesis.resume = () => { throw Error('Reset refused'); };
  assert.doesNotThrow(() => b.start('next')); assert.equal(b.spoken.length, 1); assert.equal(b.speechSnapshot().status, 'error'); assert.equal(b.intervals.size, 0);
});

test('Q03 stop from the loading notification cannot register abandoned speech monitors', () => {
  const b = playback(), unsubscribe = b.subscribeSpeech(() => { if (b.speechSnapshot().status === 'loading') b.stopSpeech('owner'); });
  b.start('owner'); unsubscribe(); assert.equal(b.speechSnapshot().status, 'stopped'); assert.equal(b.intervals.size, 0); assert.equal(b.spoken.length, 0);
});
test('Q03 a newer owner started from Stop feedback cannot be overwritten by the older start', () => {
  const b = playback(); b.start('first');
  const unsubscribe = b.subscribeSpeech(() => { if (b.speechSnapshot().status === 'stopped' && b.speechSnapshot().ownerId === 'first') b.start('newest'); });
  b.start('older'); unsubscribe(); assert.equal(b.speechSnapshot().ownerId, 'newest'); assert.equal(b.spoken.length, 2); assert.equal(b.intervals.size, 1);
  b.stopSpeech(); assert.equal(b.intervals.size, 0);
});


test('screen-reader speech status resolves to one pixel rather than a full-size scroll overflow box', () => {
  const { visuallyHiddenSpeechStatusSx } = browser().load('speechStyles');
  const css = require('@mui/material/styles').createTheme().unstable_sx(visuallyHiddenSpeechStatusSx);
  assert.equal(css.width, '1px');
  assert.equal(css.height, '1px');
  assert.equal(css.margin, '-1px');
  assert.equal(css.position, 'absolute');
  assert.equal(css.clip, 'rect(0 0 0 0)', 'Keep live status announcements available without showing them');
});


test('ordinary Read Aloud preserves long text and supplementary Unicode without imposing the voice stream limit', () => {
  for (const text of ['Ordinary message. '.repeat(700), '😀'.repeat(6000)]) {
    const b = playback();
    b.startSpeech('owner', text, { speed: 1 }, () => b.surface);
    assert.equal(b.spoken.length, 1);
    assert.equal(b.spoken[0].text, text);
    assert.equal(b.speechSnapshot().status, 'loading');
    b.spoken[0].onstart(); b.spoken[0].onend();
    assert.equal(b.speechSnapshot().status, 'stopped');
    assert.equal(b.intervals.size, 0);
  }
});
