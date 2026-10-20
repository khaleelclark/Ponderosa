import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');

function fixture() {
  const frames = new Map(), listeners = new Map(), observers = [], exports = {};
  let frameId = 0, height = 800;
  const root = { getBoundingClientRect: () => ({ width: 400, height: 200 }) };
  const element = { closest: () => root, getBoundingClientRect: () => ({ width: 400, height }) };
  const resize = [];
  const events = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/notificationVisibility.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports,
    window: { ...events, requestAnimationFrame: fn => (frames.set(++frameId, fn), frameId), cancelAnimationFrame: id => frames.delete(id) },
    document: events,
    IntersectionObserver: class {
      observes = 0; unobserves = 0; disconnected = false;
      constructor(callback, options) { Object.assign(this, { callback, options }); observers.push(this); }
      observe(target) { assert.equal(target, element); this.observes++; }
      unobserve(target) { assert.equal(target, element); this.unobserves++; }
      disconnect() { this.disconnected = true; }
    },
    ResizeObserver: class { constructor(callback) { resize.push(callback); } observe() {} disconnect() {} },
  });
  const visible = [], stop = exports.observeNotificationVisibility(element, value => visible.push(value));
  return { observers, visible, stop, frames, listeners,
    entry(intersects, width = 400, height = 100) {
      observers.at(-1).callback([{ isIntersecting: intersects, boundingClientRect: element.getBoundingClientRect(), intersectionRect: { width, height }, rootBounds: root.getBoundingClientRect() }]);
    },
    scroll() { listeners.get('scroll')?.(); },
    flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
    resize() { height = 1600; resize[0](); },
  };
}

test('offscreen messages stay natively observed without per-scroll frame work', () => {
  const f = fixture(); f.entry(false);
  for (let i = 0; i < 120; i++) { f.scroll(); f.flush(); }
  assert.equal(f.frames.size, 0);
  assert.equal(f.observers[0].observes, 1);
  assert.equal(f.observers[0].unobserves, 0);
  assert.deepEqual(f.visible, [false]);
  f.stop();
});

test('entering, partial clipping, exact half visibility and leaving retain the read predicate', () => {
  const f = fixture(); f.entry(false); f.entry(true, 199, 100);
  assert.equal(f.visible.at(-1), false);
  for (let i = 0; i < 10; i++) f.scroll();
  assert.equal(f.frames.size, 1, 'one recheck per intersecting message per frame');
  f.flush(); assert.equal(f.observers[0].unobserves, 1);
  f.entry(true, 200, 100); assert.equal(f.visible.at(-1), true);
  f.entry(true, 200, 99); assert.equal(f.visible.at(-1), false);
  f.entry(false); f.scroll(); assert.equal(f.frames.size, 0);
  f.stop();
});

test('resizing rebuilds the native threshold; cleanup cancels pending rechecks and listeners', () => {
  const f = fixture(), initial = f.observers[0];
  f.entry(true); f.resize();
  assert.equal(initial.disconnected, true);
  assert.notEqual(f.observers[1].options.threshold, initial.options.threshold);
  f.entry(true); f.scroll(); assert.equal(f.frames.size, 1);
  f.stop(); assert.equal(f.frames.size, 0); assert.equal(f.listeners.size, 0);
  assert.equal(f.observers[1].disconnected, true);
});
