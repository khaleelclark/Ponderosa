import test from 'node:test';
import assert from 'node:assert/strict';
import { createResilientEventSource } from '../../apps/web/src/api/resilientEventSource.ts';

class Source extends EventTarget { closed = false; close() { this.closed = true; } }
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };
test('check 105: failed stream reconnects once; stale sources and closed subscriptions cannot reopen it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const sources = []; let openings = 0;
  const subscription = createResilientEventSource({ createSource: () => { const source = new Source(); sources.push(source); return source; }, configure: () => {}, onOpen: () => openings++, initialReconnectDelayMs: 1, maxReconnectDelayMs: 10, maxSilenceMs: 100 });
  t.after(() => subscription.close());
  sources[0].onerror(new Event('error')); await microtasks();
  assert.equal(sources[0].closed, true); t.mock.timers.tick(10);
  assert.equal(sources.length, 2);
  sources[0].onopen(new Event('open')); assert.equal(openings, 0);
  sources[0].onerror(new Event('error')); await microtasks(); t.mock.timers.tick(10);
  assert.equal(sources.length, 2);
  sources[1].onopen(new Event('open')); assert.equal(openings, 1);
  subscription.close(); t.mock.timers.tick(1000); await microtasks();
  assert.equal(sources.length, 2); assert.equal(sources[1].closed, true);
});
test('check 105: a silently stale stream is closed and replaced without requiring browser reload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const sources = [];
  const subscription = createResilientEventSource({ createSource: () => { const source = new Source(); sources.push(source); return source; }, configure: () => {}, initialReconnectDelayMs: 1, maxSilenceMs: 20 });
  t.after(() => subscription.close());
  t.mock.timers.tick(20); await microtasks(); assert.equal(sources[0].closed, true);
  t.mock.timers.tick(10); assert.equal(sources.length, 2);
});

function lifecycle(t) {
  const saved = new Map(['document', 'window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget(), navigator = { onLine: true };
  for (const [key, value] of Object.entries({ document, window, navigator })) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return { hide() { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }, show() { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); }, online(value) { navigator.onLine = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); } };
}

test('mobile suspension preserves useful hidden streams and resumes once; old callbacks and focus churn cannot duplicate retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const life = lifecycle(t), sources = [], fences = []; let errors = 0;
  let finishProbe;
  const subscription = createResilientEventSource({ createSource: () => { const source = new Source(); sources.push(source); return source; }, configure: (_source, current) => fences.push(current), onError: () => errors++, probeRateLimit: () => new Promise(resolve => { finishProbe = resolve; }) });
  t.after(() => subscription.close());
  life.hide(); t.mock.timers.tick(90_000); await microtasks();
  assert.equal(errors, 0); assert.equal(sources[0].closed, false, 'background call stream remains usable');
  life.show(); life.hide(); life.show(); life.online(true); t.mock.timers.tick(10_000);
  assert.equal(errors, 1); assert.equal(fences[0](), false); assert.equal(sources.length, 1, 'one outstanding rate-limit probe owns recovery');
  finishProbe(); await microtasks(); t.mock.timers.tick(500);
  assert.equal(sources.length, 2); assert.equal(fences[1](), true);
  subscription.close(); assert.equal(fences[1](), false);
  life.hide(); life.show(); t.mock.timers.tick(90_000); await microtasks(); assert.equal(sources.length, 2);
});

test('offline suppresses attempts and online reuses one bounded retry loop; genuine foreground silence still expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const life = lifecycle(t), sources = [];
  const subscription = createResilientEventSource({ createSource: () => { const source = new Source(); sources.push(source); return source; }, configure() {} });
  t.after(() => subscription.close());
  life.online(false); await microtasks(); t.mock.timers.tick(90_000); assert.equal(sources.length, 1);
  life.online(true); life.online(true); t.mock.timers.tick(500); assert.equal(sources.length, 2);
  sources[1].onopen(new Event('open')); t.mock.timers.tick(44_999); assert.equal(sources[1].closed, false);
  t.mock.timers.tick(1); await microtasks(); assert.equal(sources[1].closed, true);
  t.mock.timers.tick(1000); assert.equal(sources.length, 3);
});

test('warning grace counts a continuous foreground interval and disposes all callbacks', async t => {
  const { createForegroundTimer } = await import('../../apps/web/src/queryVisibility.ts');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const life = lifecycle(t); let warnings = 0;
  const timer = createForegroundTimer(() => warnings++, 8_000); t.after(() => timer.dispose());
  timer.start(); t.mock.timers.tick(7_999); life.hide(); t.mock.timers.tick(90_000); assert.equal(warnings, 0);
  life.show(); t.mock.timers.tick(7_999); assert.equal(warnings, 0); t.mock.timers.tick(1); assert.equal(warnings, 1);
  life.hide(); life.show(); timer.clear(); t.mock.timers.tick(8_000); assert.equal(warnings, 1);
  timer.start(); timer.dispose(); life.hide(); life.show(); t.mock.timers.tick(8_000); assert.equal(warnings, 1);
});
