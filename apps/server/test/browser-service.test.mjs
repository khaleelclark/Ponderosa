import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBrowserService, BrowserServiceClient } from '../dist/browser-service.js';
import { BrowserDriverActionError } from '../dist/chrome-cdp-driver.js';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';
import { AgentStore } from '@ponderosa/agents';
import { createServer } from '../dist/app.js';

test('supervised browser survives application shutdown with draft intact and stale application fenced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-'));
  const socket = path.join(root, 'service.sock');
  let text = '', launched = 0, closed = 0, cancellations = 0;
  const page = { pageId: 'draft', url: 'https://example.test', title: 'Draft', active: true, isNew: false, closable: false };
  const service = await startBrowserService(socket, root, async () => {
    launched++;
    return { isAlive: () => true, manualState: () => 'automation', controlRevision: () => 1,
      pages: async () => ({ activePageId: 'draft', pages: [page] }),
      pageInfo: async () => page, type: async value => { text += value; return page; },
      inspect: async () => text, cancelPendingFileChooser: async () => { cancellations++; }, close: async () => { closed++; },
    };
  });
  const scope = { projectId: 'chat', agentId: 'project-browser:chat', runId: 'project:chat' };
  try {
    const firstClient = new BrowserServiceClient(socket); await firstClient.claim();
    const first = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => firstClient.driver(id, event, launch), () => {}, undefined, undefined, () => true, true);
    const opened = await first.open(scope, undefined, 'operator', undefined, true);
    await first.operatorInput(scope, { kind: 'type', text: 'unsaved draft', expectedControlEpoch: opened.controlEpoch });
    await first.closeAll('deployment_drain');
    assert.equal(first.authorityStatus(true).active, 0);
    // An abandoned deploy must leave the original browser usable.
    await first.operatorInput(scope, { kind: 'type', text: ' after aborted drain', expectedControlEpoch: first.get(scope.agentId).controlEpoch });
    assert.equal(first.authorityStatus(true).active, 1, 'new browser work must revoke restart readiness');
    await first.closeAll('server_shutdown');
    assert.equal(cancellations, 2, 'shutdown must recheck chooser cleanup after post-drain browser work');
    await first.closeAll('server_shutdown');
    assert.equal(closed, 0);
    const nextClient = new BrowserServiceClient(socket);
    const ids = await nextClient.claim();
    const next = new BrowserSessionManager(root, () => assert.fail('must not launch'), () => {}, undefined, undefined, () => true, true);
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
    const rejected = assert.rejects(opening, /lease changed|cancelled/);
    await started;
    const next = new BrowserServiceClient(socket);
    const claimed = next.claim();
    await new Promise(resolve => setTimeout(resolve, 20)); release();
    assert.deepEqual(await claimed, []); await rejected;
    assert.equal(closed, 1);
    await assert.rejects(startBrowserService(socket, root, async () => assert.fail()), /already running/);
  } finally { release(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('deployment drain cancels and joins a stalled shared-browser broker opening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-drain-'));
  const socket = path.join(root, 'service.sock');
  let release, began, aborted, closed = 0;
  const started = new Promise(resolve => { began = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = await startBrowserService(socket, root, async (_id, _console, _spawned, _event, launch) => {
    assert.ok(launch?.signal, 'broker factory receives the application launch signal');
    launch.signal.addEventListener('abort', aborted, { once: true });
    began();
    await gate;
    return {
      isAlive: () => true,
      pages: async () => ({ pages: [] }),
      close: async () => { closed++; },
    };
  });
  const scope = { projectId: 'chat', agentId: 'project-browser:chat', runId: 'project:chat' };
  try {
    const client = new BrowserServiceClient(socket); await client.claim();
    const manager = new BrowserSessionManager(root,
      (id, _console, _spawned, event, launch) => client.driver(id, event, launch),
      () => {}, undefined, undefined, () => true, true);
    const opening = manager.open(scope, undefined, 'operator', undefined, true);
    const rejected = assert.rejects(opening, /cancelled|closed/i);
    await started;
    let drained = false;
    const draining = manager.closeAll('deployment_drain').then(() => { drained = true; });
    await cancelled;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(drained, false, 'drain waits for broker-side factory settlement');
    release();
    await rejected;
    await draining;
    assert.equal(closed, 1, 'late broker publication is closed before drain completes');
    assert.deepEqual(manager.authorityStatus(true), { openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 });
    assert.deepEqual(manager.authorityBlockers('project_browser', true), []);
    const replacement = new BrowserServiceClient(socket);
    assert.deepEqual(await replacement.claim(), [], 'replacement application does not inherit the cancelled opening');
  } finally {
    release?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deployment drain remains blocked until repeated broker cleanup succeeds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-cleanup-retry-'));
  const socket = path.join(root, 'service.sock');
  let releaseFactory, began, aborted, secondCloseBegan, releaseSecondClose, closeAttempts = 0;
  const started = new Promise(resolve => { began = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const factoryGate = new Promise(resolve => { releaseFactory = resolve; });
  const atSecondClose = new Promise(resolve => { secondCloseBegan = resolve; });
  const secondCloseGate = new Promise(resolve => { releaseSecondClose = resolve; });
  const service = await startBrowserService(socket, root, async (_id, _console, _spawned, _event, launch) => {
    assert.ok(launch?.signal);
    launch.signal.addEventListener('abort', aborted, { once: true });
    began();
    await factoryGate;
    return {
      isAlive: () => true,
      pages: async () => ({ pages: [] }),
      close: async () => {
        closeAttempts++;
        if (closeAttempts === 1) throw new Error('injected broker cleanup failure one');
        if (closeAttempts === 2) {
          secondCloseBegan();
          await secondCloseGate;
          throw new Error('injected broker cleanup failure two');
        }
      },
    };
  });
  const scope = { projectId: 'chat', agentId: 'project-browser:chat', runId: 'project:chat' };
  try {
    const client = new BrowserServiceClient(socket); await client.claim();
    const manager = new BrowserSessionManager(root,
      (id, _console, _spawned, event, launch) => client.driver(id, event, launch),
      () => {}, undefined, undefined, () => true, true);
    const opening = manager.open(scope, undefined, 'operator', undefined, true);
    const rejected = assert.rejects(opening, /cancelled|closed/i);
    await started;
    let drained = false;
    const draining = manager.closeAll('deployment_drain').then(() => { drained = true; });
    await cancelled;
    releaseFactory();
    await atSecondClose;
    assert.equal(drained, false, 'application drain remains blocked after repeated broker cleanup failure');
    assert.ok(manager.authorityBlockers('project_browser', true).some(blocker => blocker.reason.includes('launch opening')));
    const sessionId = manager.get(scope.agentId).id;
    await assert.rejects(client.driver(sessionId, undefined, undefined, true), /unavailable/i,
      'the current lease cannot adopt a cancelled entry while cleanup is pending');
    const replacement = new BrowserServiceClient(socket);
    let claimed = false;
    const claim = replacement.claim().then(ids => { claimed = true; return ids; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(claimed, false, 'replacement claim joins the retained cleanup obligation');
    releaseSecondClose();
    await rejected;
    await draining;
    assert.deepEqual(await claim, []);
    assert.equal(closeAttempts, 3);
    assert.deepEqual(manager.authorityStatus(true), { openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 });
    assert.deepEqual(manager.authorityBlockers('project_browser', true), []);
  } finally {
    releaseFactory?.();
    releaseSecondClose?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
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
    const first = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => client.driver(id, event, launch), () => {}, undefined, undefined, () => true, true);
    const opened = await first.open(scope, undefined, 'operator', undefined, true);
    await first.closeAll('server_shutdown');
    const next = new BrowserSessionManager(root, () => assert.fail('must not replace'), () => {}, undefined, undefined, () => true, true);
    await next.restoreRetained([], () => assert.fail('must not adopt missing browser'));
    assert.equal(next.get(scope.agentId).id, opened.id);
    assert.equal(next.get(scope.agentId).status, 'failed');
    assert.match(next.get(scope.agentId).failure, /unsaved forms/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('confirmed deployment drain does not repeat broker chooser cleanup during shutdown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-drained-shutdown-'));
  const socket = path.join(root, 'service.sock');
  const page = { pageId: 'draft', url: 'https://example.test', title: 'Draft', active: true };
  let cancellations = 0;
  const service = await startBrowserService(socket, root, async () => ({
    isAlive: () => true,
    manualState: () => 'automation',
    pages: async () => ({ activePageId: 'draft', pages: [page] }),
    pageInfo: async () => page,
    cancelPendingFileChooser: async () => {
      cancellations++;
      if (cancellations > 1) throw new Error('redundant broker cleanup would block shutdown');
    },
    close: async () => {},
  }));
  const scope = { projectId: 'chat', agentId: 'project-browser:chat', runId: 'project:chat' };
  try {
    const firstClient = new BrowserServiceClient(socket);
    await firstClient.claim();
    const first = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => firstClient.driver(id, event, launch), () => {}, undefined, undefined, () => true, true);
    const opened = await first.open(scope, undefined, 'operator', undefined, true);
    await first.closeAll('deployment_drain');
    assert.equal(first.authorityStatus(true).active, 0);
    await first.closeAll('server_shutdown');
    assert.equal(cancellations, 1);
    const replacement = new BrowserServiceClient(socket);
    assert.deepEqual(await replacement.claim(), [opened.id]);
    const adopted = await replacement.driver(opened.id, () => {}, undefined, true);
    assert.equal((await adopted.pages()).activePageId, 'draft');
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('full server shutdown and startup reconnect the shared browser without inherited control', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-server-restart-'));
  const dataDir = path.join(root, 'state');
  const socket = path.join(root, 'service.sock');
  let launched = 0, closed = 0, cancellations = 0, text = '';
  const page = { pageId: 'draft', url: 'https://example.test', title: 'Draft', active: true };
  const service = await startBrowserService(socket, dataDir, async () => {
    launched++;
    return { isAlive: () => true, manualState: () => 'automation', controlRevision: () => 1,
      pages: async () => ({ activePageId: 'draft', pages: [page] }), pageInfo: async () => page,
      type: async value => { text += value; return page; }, cancelPendingFileChooser: async () => { cancellations++; }, close: async () => { closed++; } };
  });
  let app;
  try {
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: 'Browser restart', hostPath: root, defaultEngine: 'codex' });
    app = createServer({ dataDir, browserServiceSocket: socket, store, engines: [], logger: false });
    await app.ready();
    const url = `/api/projects/${project.id}/browser`;
    const response = await app.inject({ method: 'POST', url, payload: { rememberSignIns: true } });
    assert.equal(response.statusCode, 200, response.body);
    const opened = response.json();
    const input = await app.inject({ method: 'POST', url: url + '/input', payload: { kind: 'type', text: 'draft', expectedControlEpoch: opened.controlEpoch } });
    assert.equal(input.statusCode, 200, input.body);
    app.prepareForShutdown(); await app.close();
    assert.equal(closed, 0);
    assert.equal(cancellations, 1, 'an unprepared shutdown must still cancel the broker chooser');
    app = createServer({ dataDir, browserServiceSocket: socket, engines: [], logger: false });
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
    await service.close(); await rm(root, { recursive: true, force: true });
  }
});

test('embedded test server cannot claim an ambient live browser broker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-isolation-'));
  const socket = path.join(root, 'service.sock');
  const previousSocket = process.env.PONDEROSA_BROWSER_SERVICE_SOCKET;
  const previousDataDir = process.env.PONDEROSA_DATA_DIR;
  const service = await startBrowserService(socket, root, async () => ({
    isAlive: () => true,
    manualState: () => 'automation',
    pages: async () => ({ pages: [] }),
    cancelPendingFileChooser: async () => {},
    close: async () => {},
  }));
  let app;
  try {
    const owner = new BrowserServiceClient(socket);
    await owner.claim();
    const browserId = randomUUID();
    const driver = await owner.driver(browserId);
    process.env.PONDEROSA_BROWSER_SERVICE_SOCKET = socket;
    process.env.PONDEROSA_DATA_DIR = root;
    app = createServer({ dataDir: path.join(root, 'isolated-test-state'), engines: [], logger: false });
    await app.ready();
    assert.deepEqual(await driver.pages(), { pages: [] }, 'the original application lease remains valid');
    app.prepareForShutdown();
    await app.close();
    app = undefined;
    assert.deepEqual(await driver.pages(), { pages: [] }, 'test shutdown does not touch the broker');
    await driver.close();
  } finally {
    if (app) { app.prepareForShutdown(); await app.close(); }
    if (previousSocket === undefined) delete process.env.PONDEROSA_BROWSER_SERVICE_SOCKET;
    else process.env.PONDEROSA_BROWSER_SERVICE_SOCKET = previousSocket;
    if (previousDataDir === undefined) delete process.env.PONDEROSA_DATA_DIR;
    else process.env.PONDEROSA_DATA_DIR = previousDataDir;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser-service action reasons remain typed through IPC so stale pages are not HTTP 500s', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-service-errors-'));
  const socket = path.join(root, 'service.sock');
  const service = await startBrowserService(socket, root, async () => ({
    isAlive: () => true, manualState: () => 'automation',
    pages: async () => ({ activePageId: 'current', pages: [{ pageId: 'current', url: 'about:blank', title: 'Blank', active: true }] }),
    closePage: async () => { throw new BrowserDriverActionError('page_not_found'); },
    click: async () => { throw new BrowserDriverActionError('selector_ambiguous'); },
    fill: async () => { throw new BrowserDriverActionError('fill_unconfirmed'); },
    close: async () => {}, cancelPendingFileChooser: async () => {},
  }));
  const scope = { projectId: 'chat', agentId: 'project-browser:chat', runId: 'project:chat' };
  try {
    const client = new BrowserServiceClient(socket); await client.claim();
    const manager = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => client.driver(id, event, launch), () => {});
    const session = await manager.open(scope, undefined, 'operator', undefined, true);
    await assert.rejects(manager.closePage(scope, 'stale', 'operator', session.controlEpoch), error => {
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /page not found/i);
      return true;
    });
    await manager.setControl(scope, 'agent', session.controlEpoch);
    await assert.rejects(manager.act(scope, { action: 'click', selector: 'button[aria-label="Search"]' }), error => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'selector_ambiguous');
      assert.match(error.message, /unique selector/);
      return true;
    });
    await assert.rejects(manager.act(scope, { action: 'fill', selector: '#draft', text: 'sensitive input' }), error => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'fill_unconfirmed');
      assert.doesNotMatch(error.message, /sensitive input/);
      return true;
    });
    await manager.close(scope);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('snapshot requests fail promptly while Chrome approval occupies a browser queue', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-approval-queue-'));
  const socket = path.join(root, 'service.sock');
  let manual = 'manual', release, began, inspections = 0;
  const started = new Promise(resolve => { began = resolve; });
  const approval = new Promise(resolve => { release = resolve; });
  const service = await startBrowserService(socket, root, async () => ({
    isAlive: () => true, manualState: () => manual,
    resumeAutomation: async () => { manual = 'connecting'; began(); await approval; manual = 'automation'; },
    inspect: async () => { inspections++; return 'fixture'; },
    close: async () => {},
  }));
  try {
    const client = new BrowserServiceClient(socket); await client.claim();
    const driver = await client.driver(randomUUID());
    const connecting = driver.resumeAutomation();
    await started;
    const before = Date.now();
    await assert.rejects(driver.inspect(), /manual control|approval/i);
    assert.ok(Date.now() - before < 1000, 'inspect is not queued behind the approval handshake');
    assert.equal(inspections, 0);
    release(); await connecting;
    assert.equal(await driver.inspect(), 'fixture');
    await driver.close();
  } finally { release?.(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('an admitted Agent action is discarded if manual takeover occurs before execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-manual-fence-'));
  const socket = path.join(root, 'service.sock');
  let manual = 'automation', release, began, inspections = 0;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = await startBrowserService(socket, root, async () => ({
    isAlive: () => true, manualState: () => manual,
    pages: async () => { began(); await gate; return { pages: [] }; },
    inspect: async () => { inspections++; return 'fixture'; },
    close: async () => {},
  }));
  try {
    const client = new BrowserServiceClient(socket); await client.claim();
    const driver = await client.driver(randomUUID());
    const occupied = driver.pages(); await started;
    const queued = assert.rejects(driver.inspect(), /manual control|approval/i);
    await new Promise(resolve => setTimeout(resolve, 20));
    manual = 'manual'; release();
    await occupied; await queued;
    assert.equal(inspections, 0);
    await driver.close();
  } finally { release?.(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
