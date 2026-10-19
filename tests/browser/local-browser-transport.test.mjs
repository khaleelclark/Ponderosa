import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalBrowserHub } from '../../apps/server/dist/local-browser-hub.js';

// Exercise retained host transport, not the currently disabled new-pairing HTTP route.
test('checks 96, 99: retained local transport rejects reused grants, wrong tokens and other Chat ownership', async () => {
  const hub = new LocalBrowserHub(), code = hub.pairing('chat-a').code;
  const grant = hub.claim(code, { url: 'https://fixture.invalid', title: 'Owned synthetic window' });
  assert.throws(() => hub.claim(code, { url: 'https://fixture.invalid', title: 'Replay' }), error => error.statusCode === 401);
  await assert.rejects(hub.poll(grant.connection.id, 'wrong-token'), error => error.statusCode === 401);
  assert.throws(() => hub.factory('chat-b', grant.connection.id), error => error.statusCode === 409);
  assert.throws(() => new LocalBrowserHub().factory('chat-a', grant.connection.id), error => error.statusCode === 409);
});

test('checks 99, 102: local pause rejects an interrupted command and resume cannot apply its old result', { timeout: 10000 }, async () => {
  const hub = new LocalBrowserHub(), grant = hub.claim(hub.pairing('chat').code, { url: 'https://fixture.invalid', title: 'Owned synthetic window' });
  const id = grant.connection.id, token = grant.token, driver = await hub.factory('chat', id)('session', () => {}, () => {});
  const interrupted = driver.navigate('https://fixture.invalid/first');
  const rejected = assert.rejects(interrupted, error => error.statusCode === 409);
  const first = await hub.poll(id, token); assert.equal(first.action, 'navigate');
  hub.state(id, token, true, 1); await rejected;
  assert.throws(() => hub.result(id, token, first.id, {}, false), error => error.statusCode === 409);
  assert.throws(() => hub.state(id, token, false, 1), error => error.statusCode === 409);
  await assert.rejects(driver.navigate('https://fixture.invalid/blocked'), error => error.statusCode === 409);
  hub.state(id, token, false, 2);
  const next = driver.navigate('https://fixture.invalid/second'), command = await hub.poll(id, token);
  assert.notEqual(command.id, first.id); assert.equal(command.args.url, 'https://fixture.invalid/second');
  hub.result(id, token, command.id, { url: 'https://fixture.invalid/second', title: 'Second', width: 1280, height: 720 }, false);
  const info = await hub.poll(id, token); assert.equal(info.action, 'info');
  hub.result(id, token, info.id, { url: 'https://fixture.invalid/second', title: 'Second', width: 1280, height: 720 }, false);
  await next;
  const closing = driver.close(), disconnect = await hub.poll(id, token);
  assert.equal(disconnect.action, 'disconnect'); hub.result(id, token, disconnect.id, null, false); await closing;
});

// Execute the real extension worker/popup with controlled Chrome await points;
// no browser profile, pairing grant or provider account is used by these races.
const { readFileSync } = await import('node:fs');
const { createRequire } = await import('node:module');
const { execFileSync } = await import('node:child_process');
const vm = await import('node:vm');
const ts = createRequire(new URL('../../apps/browser-extension/package.json', import.meta.url))('typescript');
function extension(relative, mocks = {}, globals = {}, footer = '') {
  const file = `apps/browser-extension/src/${relative}.ts`;
  const source = process.env.PONDEROSA_EXTENSION_BASELINE_REF
    ? execFileSync('git', ['show', `${process.env.PONDEROSA_EXTENSION_BASELINE_REF}:${file}`], { encoding: 'utf8' })
    : readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const context = vm.createContext({ exports: {}, console, Error, URL, AbortSignal, setTimeout, clearTimeout,
    ...globals, require(name) { assert.ok(name in mocks, name); return mocks[name]; } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText + '\n' + footer, context);
  return context;
}
const policy = extension('policy').exports;
function workerFixture() {
  const listeners = {}, calls = [], tab = { id: 1, windowId: 2, url: 'https://fixture.invalid/', active: true };
  let gate, time = 1000, detachFails = false, blockedHeldResponse = false;
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const wait = async name => { if (gate?.name === name) { const held = gate; gate = undefined; held.enter(); await held.promise; return true; } };
  const chrome = { runtime: { id: 'owned', onMessage: event('message') },
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    action: { setBadgeText: async () => {} }, windows: { onRemoved: event('windowRemoved') },
    tabs: { query: async () => { await wait('query'); return [tab, { ...tab, id: 2, active: false }]; },
      get: async id => { await wait('get'); return { ...tab, id }; },
      create: async () => { calls.push(['create']); return { ...tab, id: 3 }; },
      update: async id => { calls.push(['activate', id]); return { ...tab, id }; },
      remove: async id => { calls.push(['remove', id]); },
      onUpdated: event('updated'), onRemoved: event('removed'), onDetached: event('detached') },
    debugger: { onDetach: event('debuggerDetach'), attach: async () => { await wait('attach'); },
      detach: async () => { await wait('detach'); listeners.debuggerDetach({ tabId: 2 }); if (detachFails) throw new Error('Owned detach failure'); },
      sendCommand: async (target, method, params) => { calls.push([method, target.tabId, params?.url]); const held = await wait('cdp'); return { result: { value: { blocked: Boolean(held && blockedHeldResponse) } } }; } } };
  const context = extension('worker', { './policy.js': policy, './uploads.js': { upload() { throw Error('Unexpected upload'); }, clearUploads() {} } },
    { chrome, Date: { now: () => time }, fetch: async () => ({ ok: true, json: async () => ({}) }) },
    'globalThis.probe={setConnection:c=>connection=c,execute,pause,resume,stop,initialized};');
  const connection = { server: 'https://fixture.invalid', token: 'owned-fake-token', id: 'owned', tabId: 1, windowId: 2,
    attached: [], paused: false, epoch: 1, deadline: 2000 };
  context.probe.setConnection(connection);
  return { ...context.probe, connection, calls, listeners,
    hold(name) { let enter, release; const entered = new Promise(r => enter = r), promise = new Promise(r => release = r); gate = { name, enter, promise }; return { entered, release }; },
    expire() { time = 3000; }, blockHeldResponse() { blockedHeldResponse = true; }, failDetach(value) { detachFails = value; },
    command(action, args = {}) { return { id: 'owned-command', action, args, connectionEpoch: connection.epoch, expiresAt: time + 1000 }; } };
}
for (const [action, hold] of [['navigate', 'get'], ['newPage', 'query'], ['activatePage', 'get'], ['closePage', 'get'], ['pointer', 'cdp'], ['fill', 'cdp'], ['scroll', 'cdp'], ['key', 'cdp'], ['capture', 'cdp']]) {
  test(`F08: ${action} cannot cross Pause/Resume while waiting for ${hold}`, { timeout: 5000 }, async () => {
    const f = workerFixture(); await f.initialized;
    const gate = f.hold(hold);
    const operation = f.execute(f.connection, f.command(action, { url: 'https://fixture.invalid/old', pageId: '2', x: 10, y: 10, text: 'owned', deltaX: 0, deltaY: 10, key: 'Enter' }));
    const rejected = assert.rejects(operation, /expired|paused/);
    await gate.entered; await f.pause(f.connection); await f.resume(f.connection); gate.release(); await rejected;
    assert.ok(!f.calls.some(([method]) => ['Page.navigate', 'create', 'activate', 'remove', 'Input.insertText', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Page.captureScreenshot'].includes(method)));
    await f.execute(f.connection, f.command('navigate', { url: 'https://fixture.invalid/new', pageId: '2' }));
    assert.deepEqual(f.calls.find(([method]) => method === 'Page.navigate'), ['Page.navigate', 2, 'https://fixture.invalid/new']);
    await f.stop();
  });
}
test('F08: a replaced connection and an expired command cannot mutate a tab', async () => {
  for (const reason of ['replacement', 'expiry']) {
    const f = workerFixture(); await f.initialized; const gate = f.hold('get');
    const operation = f.execute(f.connection, f.command('navigate', { url: 'https://fixture.invalid/stale' }));
    const rejected = assert.rejects(operation, /expired|Disconnected/);
    await gate.entered;
    if (reason === 'replacement') f.setConnection({ ...f.connection }); else f.expire();
    gate.release(); await rejected;
    assert.ok(!f.calls.some(([method]) => method === 'Page.navigate'));
    f.setConnection(f.connection); await f.stop();
  }
});
test('F09: failed debugger detach retains revoked ownership and permits a disconnect retry', async () => {
  const f = workerFixture(); await f.initialized; f.connection.attached = [1]; f.failDetach(true);
  await assert.rejects(f.stop(), /Could not confirm disconnection/);
  assert.equal(f.connection.revoked, true); assert.deepEqual([...f.connection.attached], [1]);
  const status = () => new Promise(resolve => f.listeners.message({ action: 'status' }, { id: 'owned', url: 'chrome-extension://owned/popup.html' }, resolve));
  const retained = await status(); assert.equal(retained.connected, true); assert.equal(retained.revoked, true);
  assert.match(retained.error, /Close the connected window|retry disconnect/);
  f.failDetach(false); await f.stop(); assert.equal((await status()).connected, false);
  assert.equal(f.listeners.message({ action: 'resume' }, { id: 'foreign' }, () => { throw Error('Untrusted sender'); }), false);
});
test('F09: popup discloses failed disconnect and keeps a usable retry', async () => {
  const elements = new Map(['status', 'connect', 'disconnect', 'pause', 'resume'].map(id => [id, { disabled: false, hidden: false, textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } }]));
  let revoked = false, connected = true, failure = true;
  const error = 'Could not confirm disconnection. Close the connected window to stop access.';
  extension('popup', { './policy.js': policy }, { document: { querySelector: selector => elements.get(selector.slice(1)) },
    chrome: { runtime: { sendMessage: async ({ action }) => {
      if (action === 'disconnect') { if (failure) { revoked = true; return { error }; } connected = false; }
      return { connected, revoked, site: 'window 2' };
    } } } });
  await new Promise(resolve => setImmediate(resolve));
  await elements.get('disconnect').listeners.click();
  assert.match(elements.get('status').textContent, /Could not confirm disconnection/);
  assert.equal(elements.get('connect').disabled, true); assert.equal(elements.get('disconnect').disabled, false);
  assert.equal(elements.get('disconnect').textContent, 'Retry disconnect'); assert.equal(elements.get('resume').hidden, true);
  failure = false; await elements.get('disconnect').listeners.click();
  assert.equal(elements.get('disconnect').hidden, true); assert.equal(elements.get('connect').disabled, false);
});

test('F08: a pending debugger attach is detached by Pause before Resume', async () => {
  const f = workerFixture(); await f.initialized; const gate = f.hold('attach');
  const operation = f.execute(f.connection, f.command('navigate', { url: 'https://fixture.invalid/stale' }));
  const rejected = assert.rejects(operation, /paused|expired/);
  await gate.entered;
  const pausing = f.pause(f.connection); gate.release(); await pausing; await f.resume(f.connection); await rejected;
  assert.ok(!f.calls.some(([method]) => method === 'Page.navigate'));
  await f.stop(); assert.deepEqual([...f.connection.attached], []);
});
test('F08: a stale authentication response cannot pause the resumed epoch', async () => {
  const f = workerFixture(); await f.initialized; const gate = f.hold('cdp'); f.blockHeldResponse();
  const operation = f.execute(f.connection, f.command('navigate', { url: 'https://fixture.invalid/stale' }));
  const rejected = assert.rejects(operation, /expired/);
  await gate.entered; await f.pause(f.connection); await f.resume(f.connection); gate.release(); await rejected;
  assert.equal(f.connection.paused, false); await f.stop();
});

for (const transition of ['pause', 'stop']) for (const failure of [false, true]) {
  test(`F09: ${transition} observes an in-flight detach: failure=${failure}`, { timeout: 5000 }, async () => {
    const f = workerFixture(); await f.initialized; f.connection.attached = [2]; f.failDetach(failure);
    const gate = f.hold('detach');
    const closing = f.execute(f.connection, f.command('closePage', { pageId: '2' }));
    const closed = assert.rejects(closing, /Owned detach failure|paused|expired/);
    await gate.entered;
    let settled = false;
    const operation = f[transition](f.connection).finally(() => { settled = true; });
    const result = failure ? assert.rejects(operation, /Owned detach failure|Could not confirm disconnection/) : operation;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Teardown confirmed before pending detach settled');
    const pending = await new Promise(resolve => f.listeners.message({ action: 'status' }, { id: 'owned', url: 'chrome-extension://owned/popup.html' }, resolve));
    assert.equal(pending.connected, true);
    assert.match(pending.error, transition === 'pause' ? /Pausing browser access.*Wait/ : /Could not confirm disconnection/);
    assert.deepEqual([...f.connection.attached], [2]);
    gate.release(); await result; await closed;
    assert.deepEqual([...f.connection.attached], failure ? [2] : []);
    if (failure && transition === 'pause') await f.stop().catch(() => {});
    f.failDetach(false); await f.stop();
    assert.deepEqual([...f.connection.attached], []);
  });
}
