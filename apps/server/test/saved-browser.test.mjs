import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';
import { BrowserProfileAuthority } from '../dist/browser-profile-authority.js';
import { registerBrowserRoutes } from '../dist/routes/browsers.js';
import { registerAgentRuntimeToolRoutes } from '../dist/routes/agent-runtime-tools.js';
import { createBrowserAuthority } from '../dist/browser-authority.js';

test('promotion keeps browser identity, survives source deletion, and grants only an explicitly selected cross-chat run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-browser-'));
  const profiles = new BrowserProfileAuthority(root);
  profiles.setChatRememberSignIns('source', 'project-browser:source', true);
  const profileId = profiles.description({ projectId: 'source', agentId: 'project-browser:source' }).profileId;
  let alive = true, launched = 0, events;
  let pages = { activePageId: 'original', pages: [{ pageId: 'original', url: 'https://example.test/draft', title: 'Draft', active: true }] };
  const manager = new BrowserSessionManager(root, async (_id, _console, _publish, onPageEvent) => {
    launched++; events = onPageEvent;
    return { manualState: () => 'automation', isAlive: () => alive, close: async () => { alive = false; }, pages: async () => pages,
      newPage: async () => pages = { activePageId: 'new', pages: [...pages.pages, { pageId: 'new', url: 'about:blank', title: 'New', active: true }] },
      pageInfo: async () => ({ url: 'https://example.test/draft', title: 'Draft' }), inspect: async () => 'draft', cancelPendingFileChooser: async () => {},
    };
  }, () => {}, undefined, profiles);
  const scope = id => ({ projectId: id, agentId: `project-browser:${id}`, runId: `project:${id}` });
  const grants = new Map();
  const app = Fastify();
  let sourceExists = true;
  registerBrowserRoutes(app, {
    browserProfiles: profiles, projectBrowserSessions: manager,
    projectExists: id => id === 'other' || (id === 'source' && sourceExists), projectDeletionInProgress: () => false,
    agentExists: (id, agent) => id === 'other' && agent === 'chosen', agentDeletionInProgress: () => false,
    projectBrowserScope: scope, projectBrowserDto: (_id, value) => value,
    getProjectBrowserGrant: id => grants.get(id), setProjectBrowserGrant: (id, value) => grants.set(id, value), deleteProjectBrowserGrant: id => grants.delete(id),
    activeProjectBrowserController: () => undefined,
  });
  const run = { runId: 'run', conversationId: 'conversation', messageCapability: 'token' };
  registerAgentRuntimeToolRoutes(app, {
    store: { getAgent: id => ({ id, projectId: 'other' }) }, activeRuns: new Map([['chosen', run]]),
    agentMessageCapabilities: new Map([['token', { agentId: 'chosen' }]]), projectBrowserSessions: manager, projectBrowserGrants: grants,
    browserSessions: { newPage: () => assert.fail('must not use a replacement private browser'), get: () => undefined },
    projectBrowserScope: scope, capabilityOwnsAuthoritativeRun: (_cap, current) => current === run,
    deletingAgentIds: new Set(), deletingProjectIds: new Set(), assets: { pendingGeneratedArtifactImports: () => [] },
  });
  try {
    const first = await manager.open(scope('source'), undefined, 'operator', undefined, true);
    const promotion = { method: 'POST', url: '/api/projects/source/browser/promote', payload: { sessionId: first.id, expectedControlEpoch: first.controlEpoch, confirmInstanceSharing: true } };
    assert.equal((await app.inject({ ...promotion, payload: { ...promotion.payload, confirmInstanceSharing: false } })).statusCode, 400);
    assert.equal((await app.inject({ ...promotion, payload: { ...promotion.payload, expectedControlEpoch: -1 } })).statusCode, 409);
    const response = await app.inject(promotion);
    assert.equal(response.statusCode, 200, response.body);
    let saved = response.json();
    assert.equal(saved.id, first.id); assert.equal(saved.projectId, 'saved-browser');
    assert.equal(saved.pages[0].id, 'original'); assert.equal(launched, 1);
    assert.equal(manager.get(scope('source').agentId), undefined);
    await manager.closeProject('source', 'test-source-deletion');
    profiles.deleteProject('source'); sourceExists = false;
    assert.equal(alive, true); assert.ok(profiles.getProfile('saved-browser', profileId));
    assert.equal((await app.inject('/api/projects/saved-browser/browser')).json().id, first.id);
    events({ type: 'page_open', pageId: 'popup', pages: { activePageId: 'popup', pages: [...pages.pages, { pageId: 'popup', url: 'https://example.test', title: 'Popup', active: true }] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.get(scope('saved-browser').agentId).pages.length, 2, 'page events still reach the promoted session');
    const ungranted = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer token' }, payload: { operation: 'new_page' } });
    assert.equal(ungranted.statusCode, 404, 'knowing a saved browser exists does not grant an Agent access');
    const access = { method: 'PUT', url: '/api/projects/saved-browser/browser/control', payload: { owner: 'agent', agentId: 'chosen', controllerProjectId: 'other', currentOrNext: true, expectedControlEpoch: saved.controlEpoch } };
    assert.equal((await app.inject({ ...access, payload: { ...access.payload, controllerProjectId: 'foreign' } })).statusCode, 404);
    assert.equal((await app.inject(access)).statusCode, 200);
    manager.bindNextRun(scope('saved-browser'), 'chosen', 'run', 'conversation');
    const created = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer token' }, payload: { operation: 'new_page' } });
    assert.equal(created.statusCode, 200, created.body); assert.equal(created.json().session.id, first.id);
    assert.equal(grants.get('saved-browser').agentId, 'chosen'); assert.equal(launched, 1);
    await assert.rejects(manager.promote(scope('saved-browser'), scope('another'), first.id, manager.get(scope('saved-browser').agentId).controlEpoch, () => assert.fail()), /control/);
  } finally { await app.close(); await manager.closeAll('test'); profiles.db.close(); await rm(root, { recursive: true, force: true }); }
});

test('cross-chat Run completion releases saved browser control without closing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-browser-release-'));
  let alive = true;
  const run = { runId: 'run', conversationId: 'conversation' };
  const authority = createBrowserAuthority({
    dataDir: root, store: { getAgent: id => ({ id, projectId: 'other-chat' }) }, activeRuns: new Map([['chosen', run]]),
    publish: () => {}, logWarn: () => {}, persistRuntimeEvent: async () => undefined,
    providerProcessAuthority: { register: () => {} }, browserAdmissionAllowed: () => true,
    driverFactory: async () => ({ isAlive: () => alive, close: async () => { alive = false; }, pages: async () => ({ activePageId: 'tab', pages: [{ pageId: 'tab', url: 'https://example.test', title: 'Saved', active: true }] }), cancelPendingFileChooser: async () => {} }),
  });
  const scope = authority.projectBrowserScope('saved-browser');
  try {
    const first = await authority.projectBrowserSessions.open(scope, undefined, 'operator');
    authority.projectBrowserGrants.set('saved-browser', { agentId: 'chosen', runId: 'run' });
    await authority.projectBrowserSessions.setControl(scope, 'agent', first.controlEpoch);
    await authority.closeRunBrowser('chosen', run, 'completed');
    assert.equal(alive, true);
    assert.equal(authority.projectBrowserSessions.get(scope.agentId).id, first.id);
    assert.equal(authority.projectBrowserSessions.get(scope.agentId).controlOwner, 'operator');
    assert.equal(authority.projectBrowserGrants.has('saved-browser'), false);
  } finally { await authority.projectBrowserSessions.closeAll('test'); await authority.browserSessions.closeAll('test'); authority.browserProfiles.db.close(); await rm(root, { recursive: true, force: true }); }
});
