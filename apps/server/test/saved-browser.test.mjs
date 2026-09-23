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
import { AgentStore, WorkspaceStore } from '@ponderosa/agents';
import { createServer } from '../dist/app.js';

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

test('explicit saved-browser authorization survives Run completion and authority restart, then revocation fences access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-browser-access-'));
  let alive = true, manual = 'automation', launched = 0;
  const activeRuns = new Map();
  const runOne = { runId: 'run-one', conversationId: 'chat', messageCapability: 'one' };
  const runTwo = { runId: 'run-two', conversationId: 'chat', messageCapability: 'two' };
  activeRuns.set('chosen', runOne);
  const authority = createBrowserAuthority({
    dataDir: root,
    store: { getAgent: id => id === 'chosen' ? { id, projectId: 'chat', title: 'Chosen' } : undefined, appendEvent: () => ({}) },
    activeRuns, publish: () => {}, logWarn: () => {}, persistRuntimeEvent: async () => undefined,
    providerProcessAuthority: { register: () => {} }, browserAdmissionAllowed: () => true,
    driverFactory: async () => {
      launched++;
      const savedInstance = launched === 1;
      let instanceAlive = true;
      return { manualState: () => manual, isAlive: () => instanceAlive, close: async () => { instanceAlive = false; if (savedInstance) alive = false; },
        pauseAutomation: async () => { manual = 'manual'; },
        pages: async () => ({ activePageId: 'tab', pages: [{ pageId: 'tab', url: 'https://example.test', title: 'Fixture', active: true }] }),
        pageInfo: async () => ({ url: 'https://example.test', title: 'Fixture' }), inspect: async () => 'fixture snapshot',
        cancelPendingFileChooser: async () => {},
      };
    },
  });
  const profiles = authority.browserProfiles;
  const profile = profiles.createProfile('source', 'Signed in');
  profiles.promoteSavedBrowser('source', profile.id);
  profiles.setSavedBrowserAccess('chat', 'chosen', true);
  assert.equal(profiles.db.pragma('user_version', { simple: true }), 1, 'additive access must not break rollback to the previous authority');
  const savedScope = authority.projectBrowserScope('saved-browser');
  const first = await authority.projectBrowserSessions.open(savedScope, undefined, 'operator');
  const capabilities = new Map([['one', { agentId: 'chosen' }], ['two', { agentId: 'chosen' }]]);
  const app = Fastify();
  registerAgentRuntimeToolRoutes(app, {
    store: { getAgent: id => id === 'chosen' ? { id, projectId: 'chat', title: 'Chosen' } : undefined },
    activeRuns, agentMessageCapabilities: capabilities, browserProfiles: profiles,
    browserSessions: authority.browserSessions, projectBrowserSessions: authority.projectBrowserSessions,
    projectBrowserGrants: authority.projectBrowserGrants, projectBrowserScope: authority.projectBrowserScope,
    capabilityOwnsAuthoritativeRun: () => true, deletingAgentIds: new Set(), deletingProjectIds: new Set(),
    assets: { pendingGeneratedArtifactImports: () => [] },
  });
  registerBrowserRoutes(app, {
    browserProfiles: profiles, browserSessions: authority.browserSessions, projectBrowserSessions: authority.projectBrowserSessions,
    projectExists: id => id === 'chat', projectDeletionInProgress: () => false,
    agentExists: (projectId, agentId) => projectId === 'chat' && agentId === 'chosen', agentDeletionInProgress: () => false,
    projectBrowserScope: authority.projectBrowserScope, projectBrowserDto: authority.projectBrowserDto,
    getProjectBrowserGrant: id => authority.projectBrowserGrants.get(id),
    setProjectBrowserGrant: (id, grant) => authority.projectBrowserGrants.set(id, grant),
    deleteProjectBrowserGrant: id => authority.projectBrowserGrants.delete(id),
    activeProjectBrowserController: (_projectId, agentId) => agentId === 'chosen' ? { grant: { agentId, runId: activeRuns.get(agentId)?.runId }, privateScope: () => undefined } : undefined,
  });
  const open = async token => app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: `Bearer ${token}` }, payload: { operation: 'open', browser: 'saved' } });
  try {
    const firstUse = await open('one');
    assert.equal(firstUse.statusCode, 200, firstUse.body);
    assert.equal(firstUse.json().session.id, first.id);
    assert.equal(firstUse.json().snapshot, 'fixture snapshot');
    await authority.closeRunBrowser('chosen', runOne, 'completed');
    assert.equal(alive, true);
    assert.equal(authority.projectBrowserSessions.get(savedScope.agentId).controlOwner, 'operator');
    activeRuns.set('chosen', runTwo);
    const temporaryScope = { projectId: 'chat', agentId: 'chosen', runId: runTwo.runId, conversationId: 'chat' };
    await authority.browserSessions.open(temporaryScope);
    assert.equal((await app.inject('/api/projects/chat/agents/chosen/browser-location')).json().kind, 'run', 'View browser follows the active temporary browser over an idle authorized saved browser');
    await authority.browserSessions.close(temporaryScope, 'test-switch');
    const secondUse = await open('two');
    assert.equal(secondUse.statusCode, 200, secondUse.body);
    assert.equal(secondUse.json().session.id, first.id);
    assert.equal(launched, 2, 'only the separate temporary browser launched a new process');
    const yielded = await authority.projectBrowserSessions.setControl(savedScope, 'operator', authority.projectBrowserSessions.get(savedScope.agentId).controlEpoch);
    authority.projectBrowserGrants.delete('saved-browser');
    const displaced = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer two' }, payload: { operation: 'inspect' } });
    assert.equal(displaced.statusCode, 409, displaced.body);
    assert.equal(displaced.json().code, 'saved_browser_control_changed');
    authority.projectBrowserGrants.set('saved-browser', { agentId: 'chosen', runId: runTwo.runId });
    await authority.projectBrowserSessions.setControl(savedScope, 'agent', yielded.controlEpoch);
    manual = 'manual';
    const manualInspect = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer two' }, payload: { operation: 'inspect' } });
    assert.equal(manualInspect.statusCode, 409, 'manual takeover is an actionable conflict, not HTTP 500');
    assert.match(manualInspect.json().error, /manual control/i);
    manual = 'automation';
    const location = await app.inject('/api/projects/chat/agents/chosen/browser-location');
    assert.equal(location.json().kind, 'saved');
    const revoke = await app.inject({ method: 'PUT', url: '/api/projects/chat/saved-browser-access/chosen', payload: { allowed: false } });
    assert.equal(revoke.statusCode, 200, revoke.body);
    assert.equal(authority.projectBrowserGrants.has('saved-browser'), false);
    assert.equal(manual, 'manual', 'revocation disconnects automation without closing Chrome');
    assert.equal(alive, true);
    const denied = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer two' }, payload: { operation: 'inspect' } });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().code, 'saved_browser_access_revoked');
    const reopened = new BrowserProfileAuthority(root);
    assert.equal(reopened.hasSavedBrowserAccess('chat', 'chosen'), false);
    reopened.setSavedBrowserAccess('chat', 'chosen', true);
    reopened.db.close();
    const again = new BrowserProfileAuthority(root);
    assert.equal(again.hasSavedBrowserAccess('chat', 'chosen'), true, 'authorization persists independently of a Run');
    again.db.close();
  } finally { await app.close(); await authority.projectBrowserSessions.closeAll('test'); await authority.browserSessions.closeAll('test'); if (profiles.db.open) profiles.db.close(); await rm(root, { recursive: true, force: true }); }
});

test('View browser follows the active borrower, not another authorized Agent or a next-Run reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-browser-location-'));
  const profiles = new BrowserProfileAuthority(root);
  const profile = profiles.createProfile('chat', 'Signed in');
  profiles.promoteSavedBrowser('chat', profile.id);
  profiles.setSavedBrowserAccess('chat', 'agent-a', true);
  profiles.setSavedBrowserAccess('chat', 'agent-b', true);
  const grants = new Map([['saved-browser', { agentId: 'agent-b', runId: 'run-b' }]]);
  const savedSession = { projectId: 'saved-browser', status: 'ready', nextRunAgentId: 'agent-a' };
  const app = Fastify();
  registerBrowserRoutes(app, {
    browserProfiles: profiles,
    browserSessions: { get: () => undefined },
    projectBrowserSessions: { get: id => id === 'project-browser:saved-browser' ? savedSession : undefined },
    projectExists: id => id === 'chat', projectDeletionInProgress: () => false,
    agentExists: (projectId, agentId) => projectId === 'chat' && ['agent-a', 'agent-b'].includes(agentId),
    agentDeletionInProgress: () => false,
    projectBrowserScope: id => ({ projectId: id, agentId: `project-browser:${id}`, runId: `project:${id}` }),
    getProjectBrowserGrant: id => grants.get(id),
    activeProjectBrowserController: () => undefined,
  });
  try {
    assert.equal((await app.inject('/api/projects/chat/agents/agent-a/browser-location')).json().kind, 'none');
    assert.equal((await app.inject('/api/projects/chat/agents/agent-b/browser-location')).json().kind, 'saved');
    grants.delete('saved-browser');
    assert.equal((await app.inject('/api/projects/chat/agents/agent-a/browser-location')).json().kind, 'none');
    assert.equal((await app.inject('/api/projects/chat/agents/agent-b/browser-location')).json().kind, 'none');
  } finally { await app.close(); profiles.db.close(); await rm(root, { recursive: true, force: true }); }
});

test('unauthorized saved-browser open creates one bounded approval instead of silently opening a temporary browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-browser-request-'));
  const profiles = new BrowserProfileAuthority(root);
  const profile = profiles.createProfile('source', 'Signed in');
  profiles.promoteSavedBrowser('source', profile.id);
  const app = Fastify();
  let decisions = 0, privateOpens = 0;
  let recordedDecision;
  const workspace = {
    cursor: () => 0,
    createDecision: input => {
      decisions++;
      assert.equal(input.mode, 'approval');
      assert.equal(input.blocking, true);
      assert.deepEqual(input.approvalScope, { kind: 'saved_browser', profileId: profile.id, projectId: 'chat', agentId: 'chosen' });
      return recordedDecision ??= { ...input, id: 'decision-one', status: 'pending' };
    },
    createNotification: () => {},
  };
  const run = { runId: 'run-one', conversationId: 'chat', messageCapability: 'token' };
  registerAgentRuntimeToolRoutes(app, {
    store: { getAgent: () => ({ id: 'chosen', title: 'Chosen', projectId: 'chat' }) },
    activeRuns: new Map([['chosen', run]]), agentMessageCapabilities: new Map([['token', { agentId: 'chosen' }]]),
    browserProfiles: profiles, workspace, publishWorkspaceSince: () => {}, browserSessions: { get: () => undefined, open: async () => { privateOpens++; } },
    projectBrowserSessions: { get: () => undefined, claimNextRun: async () => false }, projectBrowserGrants: new Map(),
    projectBrowserScope: id => ({ projectId: id, agentId: `project-browser:${id}`, runId: `project:${id}` }),
    capabilityOwnsAuthoritativeRun: () => true, deletingAgentIds: new Set(), deletingProjectIds: new Set(),
    assets: { pendingGeneratedArtifactImports: () => [] },
  });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/agent-browser', headers: { authorization: 'Bearer token' }, payload: { operation: 'open', browser: 'saved' } });
    assert.equal(result.statusCode, 202, result.body);
    assert.equal(result.json().decisionId, 'decision-one');
    assert.equal(decisions, 1);
    assert.equal(privateOpens, 0);
    assert.equal(recordedDecision.approvalScope.profileId, profile.id);
  } finally { await app.close(); profiles.db.close(); await rm(root, { recursive: true, force: true }); }
});

test('responding to a real saved-browser Decision persists access and rejects stale identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-browser-decision-'));
  let store = new AgentStore(root);
  const workspace = new WorkspaceStore(root);
  const profiles = new BrowserProfileAuthority(root);
  const project = store.createProject({ label: 'Approval fixture', hostPath: root, defaultEngine: 'codex' });
  const conversation = store.createConversation(project.id, { title: 'Chat' });
  const agent = store.createAgent(project.id, { title: 'Browser agent', engine: 'codex', conversationId: conversation.id });
  const source = profiles.createProfile(project.id, 'Signed in');
  profiles.promoteSavedBrowser(project.id, source.id);
  const makeDecision = (key, profileId) => workspace.createDecision({
    projectId: project.id, conversationId: conversation.id, agentId: agent.id,
    question: 'Allow this Agent to use the saved browser?', mode: 'approval', blocking: true,
    options: [{ id: 'approve', label: 'Allow' }, { id: 'decline', label: 'Not now' }],
    allowOther: false, idempotencyKey: key,
    approvalScope: { kind: 'saved_browser', profileId, projectId: project.id, agentId: agent.id },
  });
  const accepted = makeDecision('saved-browser-accepted', source.id);
  const rejected = makeDecision('saved-browser-stale', 'stale-profile');
  const retry = makeDecision('saved-browser-retry', source.id);
  const recovery = makeDecision('saved-browser-recovery', source.id);
  let app;
  try {
    app = createServer({ dataDir: root, store, engines: [], logger: false });
    await app.ready();
    const stale = await app.inject({ method: 'POST', url: `/api/decisions/${rejected.id}/respond`, payload: { optionId: 'approve' } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), false);
    const originalResolve = WorkspaceStore.prototype.resolveDecision;
    WorkspaceStore.prototype.resolveDecision = function (id, response) {
      if (id === accepted.id) throw new Error('injected Decision persistence failure');
      return originalResolve.call(this, id, response);
    };
    try {
      const failed = await app.inject({ method: 'POST', url: `/api/decisions/${accepted.id}/respond`, payload: { optionId: 'approve' } });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), false, 'an uncommitted Decision never enables access');
      assert.equal((await app.inject(`/api/decisions?status=pending`)).json().some(item => item.id === accepted.id), true);
    } finally { WorkspaceStore.prototype.resolveDecision = originalResolve; }
    const granted = await app.inject({ method: 'POST', url: `/api/decisions/${accepted.id}/respond`, payload: { optionId: 'approve' } });
    assert.equal(granted.statusCode, 200, granted.body);
    assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), true);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/saved-browser-access` })).json().agentIds, [agent.id]);
    const revoked = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/saved-browser-access/${agent.id}`, payload: { allowed: false } });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal((await app.inject({ method: 'POST', url: `/api/decisions/${accepted.id}/respond`, payload: { optionId: 'approve' } })).statusCode, 409);
    assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), false, 'replaying an approved Decision cannot undo revocation');
    const originalApply = BrowserProfileAuthority.prototype.applySavedBrowserApproval;
    BrowserProfileAuthority.prototype.applySavedBrowserApproval = function (id, ...rest) {
      if (id === retry.id || id === recovery.id) throw new Error('injected access persistence failure');
      return originalApply.call(this, id, ...rest);
    };
    try {
      const failed = await app.inject({ method: 'POST', url: `/api/decisions/${retry.id}/respond`, payload: { optionId: 'approve' } });
      assert.equal(failed.statusCode, 503, failed.body);
      assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), false, 'a resolved but unapplied approval does not enable access');
      assert.equal((await app.inject('/api/decisions?status=resolved')).json().some(item => item.id === retry.id), true);
    } finally { BrowserProfileAuthority.prototype.applySavedBrowserApproval = originalApply; }
    const retried = await app.inject({ method: 'POST', url: `/api/decisions/${retry.id}/respond`, payload: { optionId: 'approve' } });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), true, 'retry reconciles the resolved Decision');
    assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/saved-browser-access/${agent.id}`, payload: { allowed: false } })).statusCode, 200);
    BrowserProfileAuthority.prototype.applySavedBrowserApproval = function (id, ...rest) {
      if (id === recovery.id) throw new Error('injected access persistence failure');
      return originalApply.call(this, id, ...rest);
    };
    try {
      const failed = await app.inject({ method: 'POST', url: `/api/decisions/${recovery.id}/respond`, payload: { optionId: 'approve' } });
      assert.equal(failed.statusCode, 503, failed.body);
      assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), false);
    } finally { BrowserProfileAuthority.prototype.applySavedBrowserApproval = originalApply; }
    app.prepareForShutdown();
    await app.close();
    store = new AgentStore(root);
    app = createServer({ dataDir: root, store, engines: [], logger: false });
    await app.ready();
    assert.equal(profiles.hasSavedBrowserAccess(project.id, agent.id), true, 'startup reconciles an approved but unapplied Decision');
  } finally {
    if (app) { app.prepareForShutdown(); await app.close(); }
    profiles.db.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

test('saved-browser revocation discards queued Agent input before it reaches Chrome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-browser-fence-'));
  let finishFirst, startedFirst, clicks = 0, manual = 'automation';
  const firstStarted = new Promise(resolve => { startedFirst = resolve; });
  const firstFinished = new Promise(resolve => { finishFirst = resolve; });
  const manager = new BrowserSessionManager(root, async () => ({
    manualState: () => manual, isAlive: () => true, close: async () => {},
    pauseAutomation: async () => { manual = 'manual'; }, cancelPendingFileChooser: async () => {},
    pages: async () => ({ activePageId: 'tab', pages: [{ pageId: 'tab', url: 'https://example.test', title: 'Fixture', active: true }] }),
    pageInfo: async () => ({ url: 'https://example.test', title: 'Fixture' }),
    click: async () => { clicks++; startedFirst(); await firstFinished; return { url: 'https://example.test', title: 'Fixture' }; },
  }), () => {});
  const scope = { projectId: 'saved-browser', agentId: 'project-browser:saved-browser', runId: 'project:saved-browser' };
  try {
    const opened = await manager.open(scope, undefined, 'operator');
    await manager.setControl(scope, 'agent', opened.controlEpoch);
    const first = manager.act(scope, { action: 'click', selector: '#first' });
    await firstStarted;
    const queued = manager.act(scope, { action: 'click', selector: '#second' });
    await manager.revokeAgentControl(scope);
    finishFirst();
    await assert.rejects(first, /control changed|manual control/i);
    await assert.rejects(queued, /control changed|manual control/i);
    assert.equal(clicks, 1);
  } finally { finishFirst?.(); await manager.closeAll('test'); await rm(root, { recursive: true, force: true }); }
});
