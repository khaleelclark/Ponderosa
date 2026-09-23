import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBrowserService, BrowserServiceClient } from '../dist/browser-service.js';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';
import { AgentStore } from '@ponderosa/agents';
import { createServer } from '../dist/app.js';

test('supervised browser survives application shutdown with draft intact and stale application fenced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-'));
  const socket = path.join(root, 'service.sock');
  let text = '', launched = 0, closed = 0;
  const page = { pageId: 'draft', url: 'https://example.test', title: 'Draft', active: true, isNew: false, closable: false };
  const service = await startBrowserService(socket, root, async () => {
    launched++;
    return { isAlive: () => true, manualState: () => 'automation', controlRevision: () => 1,
      pages: async () => ({ activePageId: 'draft', pages: [page] }),
      pageInfo: async () => page, type: async value => { text += value; return page; },
      inspect: async () => text, cancelPendingFileChooser: async () => {}, close: async () => { closed++; },
    };
  });
  const scope = { projectId: 'chat', agentId: 'project-browser:chat', runId: 'project:chat' };
  try {
    const firstClient = new BrowserServiceClient(socket); await firstClient.claim();
    const first = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => firstClient.driver(id, event, launch), () => {});
    const opened = await first.open(scope, undefined, 'operator', undefined, true);
    await first.operatorInput(scope, { kind: 'type', text: 'unsaved draft', expectedControlEpoch: opened.controlEpoch });
    await first.closeAll('deployment_drain');
    assert.equal(first.authorityStatus(true).active, 0);
    // An abandoned deploy must leave the original browser usable.
    await first.operatorInput(scope, { kind: 'type', text: ' after aborted drain', expectedControlEpoch: first.get(scope.agentId).controlEpoch });
    await first.closeAll('server_shutdown');
    assert.equal(closed, 0);
    const nextClient = new BrowserServiceClient(socket);
    const ids = await nextClient.claim();
    const next = new BrowserSessionManager(root, () => assert.fail('must not launch'), () => {});
    await next.restoreRetained(ids, (id, _console, _spawned, event) => nextClient.driver(id, event, undefined, true));
    const restored = next.get(scope.agentId);
    assert.equal(restored.id, opened.id);
    assert.equal(restored.controlOwner, 'operator');
    assert.ok(restored.controlEpoch > opened.controlEpoch);
    await assert.rejects(firstClient.driver(opened.id, undefined, undefined, true), /lease expired/);
    await next.operatorInput(scope, { kind: 'type', text: ' continued', expectedControlEpoch: restored.controlEpoch });
    assert.equal(text, 'unsaved draft after aborted drain continued');
    assert.equal(launched, 1);
    await next.close(scope);
    assert.equal(closed, 1);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('a new application waits for an opening browser to be safely fenced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-opening-fence-'));
  const socket = path.join(root, 'service.sock');
  let release, began, closed = 0;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = await startBrowserService(socket, root, async () => {
    began(); await gate;
    return { isAlive: () => true, close: async () => { closed++; } };
  });
  try {
    const first = new BrowserServiceClient(socket); await first.claim();
    const opening = first.driver(randomUUID());
    const rejected = assert.rejects(opening, /lease changed/);
    await started;
    const next = new BrowserServiceClient(socket);
    const claimed = next.claim();
    await new Promise(resolve => setTimeout(resolve, 20)); release();
    assert.deepEqual(await claimed, []); await rejected;
    assert.equal(closed, 1);
    await assert.rejects(startBrowserService(socket, root, async () => assert.fail()), /already running/);
  } finally { release(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('broker refuses replacement, unsupported methods, and reuse of an in-use profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-'));
  const socket = path.join(root, 'service.sock');
  const service = await startBrowserService(socket, root, async () => ({ isAlive: () => true, manualState: () => 'automation', close: async () => {}, cancelPendingFileChooser: async () => {} }));
  try {
    const client = new BrowserServiceClient(socket); await client.claim();
    const id = randomUUID(), profileId = randomUUID();
    const launch = { retainProfile: true, profileDir: path.join(root, 'browser-profiles', profileId) };
    const driver = await client.driver(id, undefined, launch);
    await assert.rejects(client.driver(id, undefined, launch), /already exists/);
    await assert.rejects(client.driver(randomUUID(), undefined, launch), /already in use/);
    assert.equal(driver.evaluate, undefined);
    await driver.close();
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('missing retained browser is shown as failed without silently starting a replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-loss-'));
  const socket = path.join(root, 'service.sock');
  const service = await startBrowserService(socket, root, async () => ({ isAlive: () => true,
    pages: async () => ({ pages: [] }), cancelPendingFileChooser: async () => {}, close: async () => {} }));
  const scope = { projectId: 'chat', agentId: 'project-browser:chat', runId: 'project:chat' };
  try {
    const client = new BrowserServiceClient(socket); await client.claim();
    const first = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => client.driver(id, event, launch), () => {});
    const opened = await first.open(scope, undefined, 'operator', undefined, true);
    await first.closeAll('server_shutdown');
    const next = new BrowserSessionManager(root, () => assert.fail('must not replace'), () => {});
    await next.restoreRetained([], () => assert.fail('must not adopt missing browser'));
    assert.equal(next.get(scope.agentId).id, opened.id);
    assert.equal(next.get(scope.agentId).status, 'failed');
    assert.match(next.get(scope.agentId).failure, /unsaved forms/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('full server shutdown and startup reconnect the shared browser without inherited control', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-server-restart-'));
  const dataDir = path.join(root, 'state');
  const socket = path.join(root, 'service.sock');
  const previous = process.env.PONDEROSA_BROWSER_SERVICE_SOCKET;
  let launched = 0, closed = 0, text = '';
  const page = { pageId: 'draft', url: 'https://example.test', title: 'Draft', active: true };
  const service = await startBrowserService(socket, dataDir, async () => {
    launched++;
    return { isAlive: () => true, manualState: () => 'automation', controlRevision: () => 1,
      pages: async () => ({ activePageId: 'draft', pages: [page] }), pageInfo: async () => page,
      type: async value => { text += value; return page; }, cancelPendingFileChooser: async () => {}, close: async () => { closed++; } };
  });
  process.env.PONDEROSA_BROWSER_SERVICE_SOCKET = socket;
  let app;
  try {
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: 'Browser restart', hostPath: root, defaultEngine: 'codex' });
    app = createServer({ dataDir, store, engines: [], logger: false });
    await app.ready();
    const url = `/api/projects/${project.id}/browser`;
    const response = await app.inject({ method: 'POST', url, payload: { rememberSignIns: true } });
    assert.equal(response.statusCode, 200, response.body);
    const opened = response.json();
    const input = await app.inject({ method: 'POST', url: url + '/input', payload: { kind: 'type', text: 'draft', expectedControlEpoch: opened.controlEpoch } });
    assert.equal(input.statusCode, 200, input.body);
    app.prepareForShutdown(); await app.close();
    assert.equal(closed, 0);
    app = createServer({ dataDir, engines: [], logger: false });
    await app.ready();
    const restored = (await app.inject(url)).json();
    assert.equal(restored.id, opened.id);
    assert.equal(restored.controlOwner, 'operator');
    assert.equal(restored.nextRunAgentId, undefined);
    assert.ok(restored.controlEpoch > opened.controlEpoch);
    const continued = await app.inject({ method: 'POST', url: url + '/input', payload: { kind: 'type', text: '-continued', expectedControlEpoch: restored.controlEpoch } });
    assert.equal(continued.statusCode, 200, continued.body);
    assert.equal(text, 'draft-continued'); assert.equal(launched, 1);
    const ended = await app.inject({ method: 'DELETE', url });
    assert.equal(ended.statusCode, 200, ended.body); assert.equal(closed, 1);
  } finally {
    if (app) { app.prepareForShutdown(); await app.close(); }
    if (previous === undefined) delete process.env.PONDEROSA_BROWSER_SERVICE_SOCKET; else process.env.PONDEROSA_BROWSER_SERVICE_SOCKET = previous;
    await service.close(); await rm(root, { recursive: true, force: true });
  }
});
