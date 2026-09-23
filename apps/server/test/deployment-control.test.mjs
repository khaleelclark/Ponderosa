import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentControl } from '../dist/deployment-control.js';

test('deployment snapshot identifies the exact browser authority blocking restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ponderosa-deployment-control-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const browserBlocker = {
    kind: 'run_browser',
    reason: 'launch opening',
    projectId: 'project-1',
    agentId: 'agent-1',
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'opening',
  };
  const emptyBrowser = {
    authorityStatus: () => ({ openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 }),
    authorityBlockers: () => [],
    closeAll: async () => {},
  };
  const blockedBrowser = {
    authorityStatus: () => ({ openings: 1, active: 0, pendingCleanup: 0, retainedFailures: 0 }),
    authorityBlockers: () => [browserBlocker],
    closeAll: async () => {},
  };
  const control = createDeploymentControl({
    server: { closeIdleConnections() {} },
    log: { warn() {}, error() {} },
  }, {
    dataDir,
    startDrained: true,
    store: {
      listPendingProjectDeletions: () => [],
      listPendingProjectDeletionReceipts: () => [],
      listPendingAgentDeletionReceipts: () => [],
    },
    coordinationV3: { activeRunCount: () => 0 },
    activeRuns: new Map(),
    runtimeAuthorities: new Map(),
    liveSseClosures: new Set(),
    projectBrowserGrants: new Map(),
    browserSessions: blockedBrowser,
    projectBrowserSessions: emptyBrowser,
    providerUsage: { pendingCount: () => 0 },
    setClosed() {},
    pendingRuntimeAuthorityCount: () => 0,
    teardownPersistentRuntimeInBackground() {},
  });

  const snapshot = control.snapshot();
  assert.equal(snapshot.readyForRestart, false);
  assert.equal(snapshot.browserAuthorities, 1);
  assert.deepEqual(snapshot.blockers, [browserBlocker]);
});

test('deployment snapshot explains a scheduler Run lease absent from local memory', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ponderosa-deployment-scheduler-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const emptyBrowser = {
    authorityStatus: () => ({ openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 }),
    authorityBlockers: () => [],
    closeAll: async () => {},
  };
  const control = createDeploymentControl({
    server: { closeIdleConnections() {} },
    log: { warn() {}, error() {} },
  }, {
    dataDir,
    startDrained: true,
    store: {
      listPendingProjectDeletions: () => [],
      listPendingProjectDeletionReceipts: () => [],
      listPendingAgentDeletionReceipts: () => [],
    },
    coordinationV3: { activeRunCount: () => 1 },
    activeRuns: new Map(),
    runtimeAuthorities: new Map(),
    liveSseClosures: new Set(),
    projectBrowserGrants: new Map(),
    browserSessions: emptyBrowser,
    projectBrowserSessions: emptyBrowser,
    providerUsage: { pendingCount: () => 0 },
    setClosed() {},
    pendingRuntimeAuthorityCount: () => 0,
    teardownPersistentRuntimeInBackground() {},
  });

  const snapshot = control.snapshot();
  assert.equal(snapshot.readyForRestart, false);
  assert.deepEqual(snapshot.blockers, [{
    kind: 'run',
    reason: '1 active scheduler Run lease(s); 0 represented by this process',
    status: 'scheduler',
  }]);
});
