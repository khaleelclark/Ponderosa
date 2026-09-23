import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createHostedDesktopAccess } from '../dist/hosted-desktop-access.js';

test('desktop capabilities bind origin and epoch, are single-use, expire and revoke live input', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-access-'));
  const socketPath = join(root, 'rfb.sock');
  let alive = true, input = '';
  const desktop = netServer(socket => { socket.write('RFB 003.008\n'); socket.on('data', bytes => { input += bytes.toString(); socket.write(bytes); }); });
  desktop.listen(socketPath); await once(desktop, 'listening');
  const server = httpServer();
  const broker = createHostedDesktopAccess(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const resolveSocket = () => { if (!alive) throw new Error('revoked'); return socketPath; };
  const rejectUpgrade = async (protocols, selectedOrigin = origin) => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/api/hosted-browser/desktop`, protocols, { origin: selectedOrigin });
      ws.on('error', () => {});
      ws.once('open', () => { ws.terminate(); reject(new Error('Unauthorized upgrade accepted')); });
      ws.once('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); ws.terminate(); resolve(); });
    });
  };
  try {
    await rejectUpgrade(['binary']);
    const ticket = broker.issue(origin, resolveSocket);
    await rejectUpgrade(['binary', ticket.protocol], 'http://evil.test');
    const ws = new WebSocket(origin.replace('http:', 'ws:') + ticket.path, ['binary', ticket.protocol], { origin });
    const greeting = once(ws, 'message');
    await once(ws, 'open');
    assert.match((await greeting)[0].toString(), /^RFB/);
    const echo = once(ws, 'message'); ws.send(Buffer.from('input'));
    assert.equal((await echo)[0].toString(), 'input'); assert.equal(input, 'input');
    await rejectUpgrade(['binary', ticket.protocol]);
    const ended = once(ws, 'close'); alive = false;
    await ended;
    assert.throws(() => broker.issue(origin, resolveSocket), /revoked/);
    alive = true;
    const expired = broker.issue(origin, resolveSocket);
    const now = Date.now; Date.now = () => now() + 31_000;
    try { await rejectUpgrade(['binary', expired.protocol]); } finally { Date.now = now; }
  } finally {
    broker.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => desktop.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
