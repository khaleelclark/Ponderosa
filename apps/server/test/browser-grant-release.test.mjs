import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createBrowserAuthority } from '../dist/browser-authority.js';
import { registerAgentRuntimeToolRoutes } from '../dist/routes/agent-runtime-tools.js';

async function fixture(projectId = 'chat') {
  const root = await mkdtemp(join(tmpdir(), 'browser-grant-release-'));
  const run = { runId: 'run', conversationId: 'chat', messageCapability: 'token' };
  const activeRuns = new Map([['agent', run]]);
  let alive = true;
  let draft = 'Unpublished browser-local work';
  let cancelFailures = 0;
  const authority = createBrowserAuthority({
    dataDir: root,
    store: { getAgent: id => id === 'agent' ? { id, projectId: 'chat', title: 'Agent' } : undefined },
    activeRuns, publish: () => {}, logWarn: () => {}, persistRuntimeEvent: async () => undefined,
    providerProcessAuthority: { register: () => {} }, browserAdmissionAllowed: () => true,
    driverFactory: async () => ({
      isAlive: () => alive,
      close: async () => { alive = false; draft = ''; },
      pages: async () => ({ activePageId: 'draft', pages: [{ pageId: 'draft', url: 'https://example.test/draft', title: 'Draft', active: true }] }),
      cancelPendingFileChooser: async () => {
        if (cancelFailures > 0) { cancelFailures -= 1; throw new Error('injected chooser cleanup failure'); }
      },
    }),
  });
  const scope = authority.projectBrowserScope(projectId);
  const opened = await authority.projectBrowserSessions.open(scope, undefined, 'operator');
  const grant = { agentId: 'agent', runId: run.runId };
  authority.projectBrowserGrants.set(projectId, grant);
  await authority.projectBrowserSessions.setControl(scope, 'agent', opened.controlEpoch);
  return {
    authority, scope, run, activeRuns, grant,
    setCancelFailures: count => { cancelFailures = count; },
    alive: () => alive, draft: () => draft,
    async cleanup() {
      await authority.projectBrowserSessions.closeAll('test');
      await authority.browserSessions.closeAll('test');
      authority.browserProfiles.db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const projectId of ['chat', 'saved-browser']) {
  test(`${projectId} Run settlement accepts a concurrent operator handoff without closing the draft`, async () => {
    const f = await fixture(projectId);
    try {
      const manager = f.authority.projectBrowserSessions;
      const original = manager.setControl.bind(manager);
      let raced = false;
      manager.setControl = async (scope, owner, epoch) => {
        if (owner === 'operator' && !raced) {
          raced = true;
          await original(scope, 'operator', manager.get(scope.agentId).controlEpoch);
        }
        return original(scope, owner, epoch);
      };
      await f.authority.closeRunBrowser('agent', f.run, 'run_completed');
      assert.equal(raced, true);
      assert.equal(f.alive(), true);
      assert.equal(f.draft(), 'Unpublished browser-local work');
      assert.equal(manager.get(f.scope.agentId).controlOwner, 'operator');
      assert.equal(f.authority.projectBrowserGrants.has(projectId), false);
    } finally { await f.cleanup(); }
  });
}

test('failed chooser cleanup fences and retains a saved browser until a retry finishes', async () => {
  const f = await fixture('saved-browser');
  try {
    f.setCancelFailures(2);
    await assert.rejects(f.authority.closeRunBrowser('agent', f.run, 'run_completed'), /injected chooser cleanup failure/);
    const manager = f.authority.projectBrowserSessions;
    const current = manager.get(f.scope.agentId);
    assert.equal(current.controlOwner, 'operator', 'Agent input was fenced before asynchronous cleanup');
    assert.equal(f.authority.projectBrowserGrants.get('saved-browser'), f.grant);
    assert.equal(f.alive(), true);
    assert.equal(f.draft(), 'Unpublished browser-local work');
    assert.equal(manager.authorityStatus(true).pendingCleanup, 1);
    assert.equal(manager.authorityStatus(true).retainedFailures, 1);
    await assert.rejects(manager.setControl(f.scope, 'agent', current.controlEpoch), /pending operator handoff/);
    await f.authority.closeRunBrowser('agent', f.run, 'run_completed');
    assert.equal(manager.get(f.scope.agentId).controlOwner, 'operator');
    assert.equal(manager.authorityStatus(true).pendingCleanup, 0);
    assert.equal(manager.authorityStatus(true).retainedFailures, 0);
    assert.equal(f.authority.projectBrowserGrants.has('saved-browser'), false);
    assert.equal(f.alive(), true);
    assert.equal(f.draft(), 'Unpublished browser-local work');
  } finally { await f.cleanup(); }
});

test('failed explicit release retains its exact grant for Run-settlement recovery', async () => {
  const f = await fixture();
  const app = Fastify();
  registerAgentRuntimeToolRoutes(app, {
    store: { getAgent: id => id === 'agent' ? { id, projectId: 'chat', title: 'Agent' } : undefined },
    activeRuns: f.activeRuns,
    agentMessageCapabilities: new Map([['token', { agentId: 'agent' }]]),
    browserProfiles: f.authority.browserProfiles,
    browserSessions: f.authority.browserSessions,
    projectBrowserSessions: f.authority.projectBrowserSessions,
    projectBrowserGrants: f.authority.projectBrowserGrants,
    projectBrowserScope: f.authority.projectBrowserScope,
    capabilityOwnsAuthoritativeRun: (_cap, run) => run === f.run,
    deletingAgentIds: new Set(), deletingProjectIds: new Set(),
    assets: { pendingGeneratedArtifactImports: () => [] },
  });
  try {
    f.setCancelFailures(1);
    const response = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer token' }, payload: { operation: 'close' } });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'browser_handoff_incomplete', response.body);
    assert.equal(f.authority.projectBrowserGrants.get('chat'), f.grant);
    assert.equal(f.authority.projectBrowserSessions.get(f.scope.agentId).controlOwner, 'agent');
    assert.equal(f.alive(), true);
    await f.authority.closeRunBrowser('agent', f.run, 'run_completed');
    assert.equal(f.authority.projectBrowserGrants.has('chat'), false);
    assert.equal(f.authority.projectBrowserSessions.get(f.scope.agentId).controlOwner, 'operator');
    assert.equal(f.alive(), true);
    assert.equal(f.draft(), 'Unpublished browser-local work');
  } finally { await app.close(); await f.cleanup(); }
});
