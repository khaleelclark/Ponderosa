import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';
import { chromeBrowserDriverFactory, findBrowserExecutable } from '../dist/chrome-cdp-driver.js';
import { registerBrowserRoutes } from '../dist/routes/browsers.js';

test('real Chrome upload HTTP route reports a controlled conflict when closed during staging', { skip: !findBrowserExecutable(), timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'browser-upload-http-'));
  const body = Buffer.from('scoped fixture bytes');
  const source = join(root, 'source.txt');
  await fs.writeFile(source, body);
  const handle = await fs.open(source, 'r');
  const artifact = { id: 'artifact', path: 'fixture.txt', size: body.length, mediaType: 'text/plain', sha256: createHash('sha256').update(body).digest('hex') };
  const scope = { projectId: 'chat', agentId: 'browser', runId: 'shared' };
  let closes = 0;
  const manager = new BrowserSessionManager(root, chromeBrowserDriverFactory(root), () => {}, async () => ({ artifact,
    content: { readRange: () => handle.readFile(), close: async () => { closes++; await handle.close(); } } }));
  const fixture = createServer((_req, res) => res.end('<title>Upload</title><input id="file" type="file">'));
  const app = Fastify();
  registerBrowserRoutes(app, { projectExists: id => id === 'chat', projectDeletionInProgress: () => false,
    projectBrowserScope: () => scope, projectBrowserDto: (_id, dto) => dto, projectBrowserSessions: manager });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let paused = false;
  const mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (...args) => {
    if (!paused && String(args[0]).includes('/uploads')) { paused = true; entered.resolve(); await release.promise; }
    return mkdir(...args);
  });
  try {
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const session = await manager.open(scope, `http://127.0.0.1:${fixture.address().port}`, 'operator');
    const pending = app.inject({ method: 'POST', url: '/api/projects/chat/browser/upload', payload: { artifactId: artifact.id, selector: '#file', expectedControlEpoch: session.controlEpoch } });
    await entered.promise;
    await manager.close(scope);
    release.resolve();
    const response = await pending;
    assert.equal(response.statusCode, 409, response.body);
    assert.doesNotMatch(response.body, /TypeError|Cannot read properties/);
    assert.equal(closes, 1);
    await assert.rejects(handle.stat(), /closed|EBADF/i);
    assert.deepEqual(await fs.readdir(join(root, 'browser-sessions', session.id, 'uploads')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  } finally { release.resolve(); await app.close(); await manager.closeAll('test cleanup'); await handle.close().catch(() => {});
    await new Promise(resolve => fixture.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
