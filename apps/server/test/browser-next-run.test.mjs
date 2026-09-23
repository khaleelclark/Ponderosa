import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';
import Fastify from 'fastify';
import { registerAgentRuntimeToolRoutes } from '../dist/routes/agent-runtime-tools.js';
test('next-run permission binds one agent, one run and one conversation and cannot carry forward', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-browser-run-'));
  let alive = true;
  let newTabs = 0;
  const driver = { isAlive: () => alive, close: async () => { alive = false; }, pageInfo: async () => ({ url: 'https://example.test', title: 'Signed in' }), inspect: async () => 'Signed-in fixture', cancelPendingFileChooser: async () => {}, pages: async () => ({ activePageId: 'tab', pages: [{ pageId: 'tab', url: 'https://example.test', title: 'Signed in', active: true }] }) };
  const manager = new BrowserSessionManager(root, async () => driver, () => {});
  driver.newPage = async () => { newTabs++; return { activePageId: 'new-tab', pages: [{ pageId: 'tab', url: 'https://example.test', title: 'Signed in', active: false }, { pageId: 'new-tab', url: 'about:blank', title: 'New tab', active: true }] }; };
  const scope = { projectId: 'chat', agentId: 'shared', runId: 'persistent' };
  try {
    let session = await manager.open(scope, undefined, 'operator');
    session = manager.authorizeNextRun(scope, 'chosen', session.controlEpoch);
    assert.equal(session.nextRunAgentId, 'chosen');
    manager.bindNextRun(scope, 'other', 'run-other', 'conversation');
    assert.equal(await manager.claimNextRun(scope, 'other', 'run-other', 'conversation'), false);
    manager.bindNextRun(scope, 'chosen', 'run-one', 'conversation');
    assert.equal(await manager.claimNextRun(scope, 'chosen', 'run-one', 'different'), false);
    assert.equal(await manager.claimNextRun(scope, 'chosen', 'run-one', 'conversation'), true);
    assert.equal(manager.get(scope.agentId).controlOwner, 'agent');
    assert.equal(await manager.claimNextRun(scope, 'chosen', 'run-one', 'conversation'), false);
    session = await manager.setControl(scope, 'operator', manager.get(scope.agentId).controlEpoch);
    session = manager.authorizeNextRun(scope, 'chosen', session.controlEpoch);
    manager.bindNextRun(scope, 'chosen', 'run-two', 'conversation');
    manager.expireNextRun(scope, 'chosen', 'run-two');
    manager.bindNextRun(scope, 'chosen', 'run-three', 'conversation');
    assert.equal(await manager.claimNextRun(scope, 'chosen', 'run-three', 'conversation'), false);
    session = manager.authorizeNextRun(scope, 'chosen', manager.get(scope.agentId).controlEpoch);
    manager.bindNextRun(scope, 'chosen', 'run-four', 'conversation');
    manager.bindNextRun(scope, 'chosen', 'run-five', 'conversation');
    assert.equal(await manager.claimNextRun(scope, 'chosen', 'run-five', 'conversation'), false);
    manager.authorizeNextRun(scope, 'chosen', manager.get(scope.agentId).controlEpoch);
    manager.bindNextRun(scope, 'chosen', 'run-six', 'conversation');
    const grants = new Map();
    const run = { runId: 'run-six', conversationId: 'conversation', messageCapability: 'chosen-token' };
    const app = Fastify();
    registerAgentRuntimeToolRoutes(app, {
      store: { getAgent: id => ({ id, projectId: 'chat' }) },
      activeRuns: new Map([['chosen', run]]), agentMessageCapabilities: new Map([['chosen-token', { agentId: 'chosen' }]]),
      projectBrowserSessions: manager, projectBrowserGrants: grants,
      browserSessions: { inspect: () => { throw new Error('Wrong private browser selected'); } },
      projectBrowserScope: id => id === 'chat' ? scope : { projectId: id, agentId: `project-browser:${id}`, runId: `project:${id}` },
      capabilityOwnsAuthoritativeRun: (_capability, current) => current === run,
      deletingAgentIds: new Set(), deletingProjectIds: new Set(),
      assets: { pendingGeneratedArtifactImports: () => [] },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer chosen-token' }, payload: { operation: 'inspect' } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().session.id, session.id);
      assert.equal(grants.get('chat').runId, 'run-six');
      const created = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer chosen-token' }, payload: { operation: 'new_page' } });
      assert.equal(created.statusCode, 200, created.body);
      assert.equal(created.json().session.id, session.id);
      assert.equal(created.json().pages.pages.length, 2);
      assert.equal(created.json().pages.activePageId, 'new-tab');
      assert.equal(newTabs, 1);
      await manager.setControl(scope, 'operator', manager.get(scope.agentId).controlEpoch);
      const blocked = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer chosen-token' }, payload: { operation: 'new_page' } });
      assert.equal(blocked.statusCode, 409);
      assert.equal(newTabs, 1, 'operator takeover prevents agent tab creation');
    } finally { await app.close(); }
    assert.equal(alive, true, 'authorization changes never restart the signed-in browser');
  } finally { await manager.closeAll('test'); await rm(root, { recursive: true, force: true }); }
});
