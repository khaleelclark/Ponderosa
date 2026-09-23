import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';

const scope = { projectId: 'project', agentId: 'agent', conversationId: 'chat', runId: 'run' };
const page = { pageId: 'page', url: 'about:blank', title: '', active: true, isNew: false, closable: false };

test('manager construction does not start residue recovery that outlives teardown', async () => {
  const roots = await Promise.all(Array.from({ length: 12 }, () => mkdtemp(path.join(tmpdir(), 'browser-construction-'))));
  const managers = roots.map(root => new BrowserSessionManager(root, async () => assert.fail('no browser should open'), () => {}));
  try {
    await Promise.all(managers.map(manager => manager.closeAll('test cleanup')));
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(roots.filter(existsSync), []);
  } finally {
    await Promise.all(managers.map(manager => manager.closeAll('test cleanup')));
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test('deployment drain cancels a stalled Run browser launch and closes authority published during cancellation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-drain-opening-'));
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let closed = 0;
  const manager = new BrowserSessionManager(root, async (_id, _console, publish, _event, launch) => {
    began();
    await new Promise((resolve, reject) => {
      const cancel = () => {
        const handle = {
          isAlive: () => closed === 0,
          close: async () => { closed++; },
        };
        publish(handle, { complete: true, coversReturnedDriver: true });
        reject(new Error('cancelled by deployment drain'));
      };
      if (launch?.signal?.aborted) cancel();
      else launch?.signal?.addEventListener('abort', cancel, { once: true });
    });
    return assert.fail('cancelled launch must not return a driver');
  }, () => {});
  try {
    const opening = manager.open(scope);
    const rejected = assert.rejects(opening, /cancelled|closed while it was opening/i);
    await started;
    assert.equal(manager.authorityStatus().openings, 1);
    assert.deepEqual(manager.authorityBlockers('run_browser'), [{
      kind: 'run_browser',
      reason: 'launch opening',
      projectId: 'project',
      agentId: 'agent',
      runId: 'run',
      sessionId: manager.get('agent').id,
      status: 'opening',
    }]);
    await manager.closeAll('deployment_drain');
    await rejected;
    assert.equal(closed, 1);
    assert.deepEqual(manager.authorityStatus(), { openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 });
  } finally {
    await manager.closeAll('test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

test('deployment drain closes a ready Run browser even when its driver supports suspend', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-drain-run-'));
  let closed = 0, suspended = 0;
  const manager = new BrowserSessionManager(root, async () => ({
    isAlive: () => closed === 0,
    pages: async () => ({ activePageId: 'page', pages: [page] }),
    close: async () => { closed++; },
    suspend: async () => { suspended++; },
  }), () => {});
  try {
    await manager.open(scope);
    assert.match(manager.authorityBlockers('run_browser')[0].reason, /live browser authority/);
    await manager.closeAll('deployment_drain');
    assert.equal(closed, 1);
    assert.equal(suspended, 0);
    assert.deepEqual(manager.authorityStatus(), { openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 });
  } finally {
    await manager.closeAll('test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

test('deployment drain retains only an explicitly shared Project browser', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-drain-project-'));
  let closed = 0, suspended = 0;
  const projectScope = { projectId: 'project', agentId: 'project-browser:project', runId: 'project:project' };
  const manager = new BrowserSessionManager(root, async () => ({
    isAlive: () => closed === 0,
    pages: async () => ({ activePageId: 'page', pages: [page] }),
    cancelPendingFileChooser: async () => {},
    close: async () => { closed++; },
    suspend: async () => { suspended++; },
  }), () => {}, undefined, undefined, () => true, true);
  try {
    await manager.open(projectScope);
    await manager.closeAll('deployment_drain');
    assert.equal(manager.get(projectScope.agentId).status, 'ready');
    assert.equal(closed, 0);
    assert.equal(suspended, 0);
    assert.equal(manager.authorityStatus(true).active, 0);
    await manager.closeAll('server_shutdown');
    assert.equal(suspended, 1);
    assert.equal(closed, 0);
  } finally {
    await manager.closeAll('test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
