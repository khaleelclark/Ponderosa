import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';
import { ChromeCdpDriver } from '../dist/chrome-cdp-driver.js';

test('native display is independent of automation and server-selects read-only viewing during agent control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-display-authority-'));
  const scope = { projectId: 'chat', agentId: 'browser', runId: 'persistent' };
  let state = 'manual', revision = 0, resized;
  const driver = {
    isAlive: () => true, close: async () => {}, manualState: () => state,
    controlRevision: () => revision, manualSocket: readOnly => readOnly ? '/private/view.sock' : '/private/input.sock',
    resizeDesktop: async size => { resized = size; },
    cancelPendingFileChooser: async () => {}, pages: async () => ({ pages: [] }),
  };
  const manager = new BrowserSessionManager(root, async () => driver, () => {});
  try {
    let session = await manager.open(scope, undefined, 'operator', undefined, true);
    assert.equal(session.capabilities.nativeDisplay, true);
    assert.equal(manager.manualDesktopSocket(scope, session.id, session.controlEpoch), '/private/input.sock');
    await manager.resizeDesktop(scope, session.id, session.controlEpoch, { width: 390, height: 700 });
    assert.deepEqual(resized, { width: 390, height: 700 });
    state = 'automation'; revision++;
    session = manager.get(scope.agentId);
    assert.equal(manager.manualDesktopSocket(scope, session.id, session.controlEpoch), '/private/input.sock');
    const previousEpoch = session.controlEpoch;
    session = await manager.setControl(scope, 'agent', previousEpoch);
    assert.throws(() => manager.manualDesktopSocket(scope, session.id, previousEpoch), /access changed/);
    assert.equal(manager.manualDesktopSocket(scope, session.id, session.controlEpoch), '/private/view.sock');
    await assert.rejects(manager.resizeDesktop(scope, session.id, session.controlEpoch, { width: 800, height: 600 }), /control changed/);
    session = await manager.setControl(scope, 'operator', session.controlEpoch);
    assert.equal(manager.manualDesktopSocket(scope, session.id, session.controlEpoch), '/private/input.sock');
  } finally { await manager.closeAll('test cleanup'); await rm(root, { recursive: true, force: true }); }
});

for (const { label, multiPage, tabCount } of [
  { label: 'single-page', multiPage: false, tabCount: 2 },
  { label: '30-tab', multiPage: true, tabCount: 31 },
]) test(`resuming an over-capacity ${label} manual browser never closes existing tabs`, async () => {
  const previousMultiPage = process.env.PONDEROSA_BROWSER_MULTI_PAGE;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.PONDEROSA_BROWSER_MULTI_PAGE = multiPage ? '1' : '0';
  const commands = [];
  const connection = {
    send: async method => {
      commands.push(method);
      if (method === 'Target.getTargets') return {
        targetInfos: Array.from({ length: tabCount }, (_, index) => ({ type: 'page', targetId: String(index) })),
      };
      return {};
    },
    onEvent: () => () => {},
    onClose: () => () => {},
  };
  try {
    await assert.rejects(ChromeCdpDriver.attachOwned({}, {}, connection, '/unused', () => {}, () => {}, {}), /remains open in manual mode/);
    assert.deepEqual(commands, ['Target.getTargets']);
  } finally {
    if (previousMultiPage === undefined) delete process.env.PONDEROSA_BROWSER_MULTI_PAGE;
    else process.env.PONDEROSA_BROWSER_MULTI_PAGE = previousMultiPage;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('hosted manual handoff fences automation and desktop access without replacing the browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-manual-handoff-'));
  let state = 'manual', revision = 0, alive = true, launches = 0, resume;
  const scope = { projectId: 'chat', agentId: 'browser', runId: 'persistent' };
  const pages = { activePageId: 'draft', pages: [{ pageId: 'draft', url: 'https://example.test/application', title: 'Draft', active: true, isNew: false, closable: false }] };
  const driver = {
    isAlive: () => alive, close: async () => { alive = false; },
    manualState: () => state, controlRevision: () => revision,
    manualSocket: () => '/private/desktop.sock', pages: async () => pages,
    cancelPendingFileChooser: async () => {},
    pauseAutomation: async () => { state = 'manual'; revision++; },
    resumeAutomation: async () => {
      state = 'connecting'; revision++;
      await new Promise(resolve => { resume = resolve; });
      state = 'automation'; revision++;
    },
  };
  const manager = new BrowserSessionManager(root, async (_id, _log, _spawn, _page, options) => {
    assert.equal(options.nativeManual, true); launches++; return driver;
  }, () => {});
  try {
    let session = await manager.open(scope, undefined, 'operator', undefined, true);
    assert.equal(session.manualControl, 'manual');
    assert.equal(manager.manualDesktopSocket(scope, session.id, session.controlEpoch), '/private/desktop.sock');
    assert.throws(() => manager.manualDesktopSocket(scope, 'different-session', session.controlEpoch), /access changed/);
    await assert.rejects(manager.setControl(scope, 'agent', session.controlEpoch), /Resume automation/);
    await assert.rejects(manager.reconnect(scope), /keep this manual browser/);
    const oldEpoch = session.controlEpoch;
    const pending = manager.resumeHostedAutomation(scope, oldEpoch);
    assert.throws(() => manager.manualDesktopSocket(scope, session.id, oldEpoch), /access changed/);
    await assert.rejects(manager.resumeHostedAutomation(scope, oldEpoch), /control changed/);
    resume(); session = await pending;
    assert.equal(session.manualControl, 'automation');
    assert.equal(session.controlOwner, 'operator');
    assert.throws(() => manager.manualDesktopSocket(scope, session.id, session.controlEpoch), /not active/);
    session = await manager.setControl(scope, 'agent', session.controlEpoch);
    state = 'manual'; revision++;
    session = manager.get(scope.agentId);
    assert.equal(session.controlOwner, 'operator', 'unexpected automation disconnection restores usable operator access');
    assert.equal(session.privateSignIn, false, 'unexpected disconnect does not opt into private sign-in');
    assert.equal(manager.manualDesktopSocket(scope, session.id, session.controlEpoch), '/private/desktop.sock');
    session = await manager.pauseHostedAutomation(scope, session.controlEpoch);
    assert.equal(session.manualControl, 'manual');
    assert.equal(session.privateSignIn, true);
    await assert.rejects(manager.resumeHostedAutomation(scope, session.controlEpoch, true), /Private sign-in/);
    assert.equal(state, 'manual', 'automatic connection cannot override private sign-in');
    assert.equal(session.controlOwner, 'operator');
    assert.equal(launches, 1);
    assert.equal(alive, true);
    assert.equal(session.activePageId, 'draft');
    await assert.rejects(manager.pauseHostedAutomation(scope, oldEpoch), /control changed/);
    const returning = manager.resumeHostedAutomation(scope, session.controlEpoch);
    resume(); session = await returning;
    assert.equal(session.privateSignIn, false);
    assert.equal(session.controlOwner, 'operator');
  } finally { await manager.closeAll('test cleanup'); await rm(root, { recursive: true, force: true }); }
});
