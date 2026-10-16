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
