import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { ApprovedChromeConnection } from '../dist/approved-chrome-connection.js';

test('approved browser disconnect discards commands without closing browser and permits a new attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approved-chrome-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const commands = []; let resolveReceived;
  const received = new Promise(resolve => { resolveReceived = resolve; });
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); commands.push(message.method);
    if (message.method === 'Test.pending') { resolveReceived(); return; }
    socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
  }));
  let first, second;
  try {
    await writeFile(join(root, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/abc-123\n`);
    first = await ApprovedChromeConnection.connect(root);
    assert.deepEqual(await first.send('Test.ready'), { ok: true });
    await assert.rejects(first.send('Browser.close'), /explicit lifecycle/);
    let closes = 0; first.onClose(() => closes++);
    const pending = first.send('Test.pending');
    const rejected = assert.rejects(pending, /discarded/);
    await received; first.disconnect(); first.disconnect(); await rejected;
    assert.equal(closes, 1);
    await assert.rejects(first.send('Test.stale'), /disconnected/);
    second = await ApprovedChromeConnection.connect(root);
    assert.deepEqual(await second.send('Test.resumed'), { ok: true });
    assert.deepEqual(commands, ['Test.ready', 'Test.pending', 'Test.resumed']);
  } finally {
    first?.disconnect(); second?.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});

test('approved connection accepts only a bounded loopback endpoint from its owned profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approved-chrome-validation-'));
  try {
    for (const content of ['9222\nws://evil.test', '65536\n/devtools/browser/a', '9222\n/devtools/browser/a?token=secret', 'x'.repeat(513)]) {
      await writeFile(join(root, 'DevToolsActivePort'), content);
      await assert.rejects(ApprovedChromeConnection.connect(root), /Enable remote debugging/);
    }
    await rm(join(root, 'DevToolsActivePort'));
    await writeFile(join(root, 'elsewhere'), '9222\n/devtools/browser/a');
    await symlink(join(root, 'elsewhere'), join(root, 'DevToolsActivePort'));
    await assert.rejects(ApprovedChromeConnection.connect(root), /Enable remote debugging/);
    await assert.rejects(ApprovedChromeConnection.connect('relative'), /owned browser profile/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(ApprovedChromeConnection.connect(root, { signal: controller.signal }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('approval cancellation closes the waiting transport without retrying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approved-chrome-cancel-'));
  let upgradeSocket;
  const { createServer } = await import('node:http');
  const server = createServer();
  const upgraded = new Promise(resolve => server.on('upgrade', (_request, socket) => { upgradeSocket = socket; resolve(); }));
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    await writeFile(join(root, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/abc\n`);
    const controller = new AbortController();
    const connecting = ApprovedChromeConnection.connect(root, { signal: controller.signal });
    const rejected = assert.rejects(connecting, /cancelled/);
    await upgraded; controller.abort(); await rejected;
  } finally { upgradeSocket?.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
