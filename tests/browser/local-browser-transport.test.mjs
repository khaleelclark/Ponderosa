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
