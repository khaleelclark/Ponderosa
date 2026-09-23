import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerBrowserRoutes } from '../dist/routes/browsers.js';
import { registerRequestSecurityHooks } from '../dist/server-request-hooks.js';

test('manual browser routes require operator credentials, same origin and exact session identity', async () => {
  const app = Fastify();
  registerRequestSecurityHooks(app, { opts: { authToken: 'operator-secret' }, v3DispatchKey: 'internal', agentMessageCapabilities: new Map([['agent-secret', { agentId: 'agent' }]]), deletingAgentIds: new Set(), validLauncherSession: () => false, artifactFilesystemError: () => undefined, isArtifactDependentWorkIntake: () => false, isPublicWebAssetRequest: () => false });
  let sockets = 0;
  registerBrowserRoutes(app, {
    projectExists: id => id === 'chat', projectDeletionInProgress: () => false,
    agentExists: (projectId, agentId) => projectId === 'chat' && agentId === 'chosen', agentDeletionInProgress: () => false,
    getProjectBrowserGrant: () => undefined, projectBrowserDto: (_projectId, value) => value,
    activeProjectBrowserController: () => undefined,
    projectBrowserScope: projectId => ({ projectId, agentId: 'browser', runId: 'persistent' }),
    projectBrowserSessions: {
      get: () => ({ id: 'session', status: 'ready' }),
      authorizeNextRun: (_scope, agentId, epoch) => { assert.equal(epoch, 2); return { id: 'session', nextRunAgentId: agentId }; },
      manualDesktopSocket: (_scope, id, epoch) => { assert.equal(id, 'session'); assert.equal(epoch, 2); sockets++; return '/private/desktop.sock'; },
    },
  });
  const request = { method: 'POST', url: '/api/projects/chat/browser/manual', payload: { action: 'ticket', sessionId: 'session', expectedControlEpoch: 2 } };
  try {
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal((await app.inject({ ...request, headers: { authorization: 'Bearer agent-secret' } })).statusCode, 401);
    const headers = { authorization: 'Bearer operator-secret', host: 'ponderosa.test', origin: 'http://ponderosa.test' };
    assert.equal((await app.inject({ ...request, headers: { ...headers, origin: 'http://evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ ...request, headers, payload: { ...request.payload, sessionId: 'stale' } })).statusCode, 409);
    assert.equal((await app.inject({ ...request, headers, payload: { ...request.payload, expectedControlEpoch: null } })).statusCode, 400);
    const ticket = await app.inject({ ...request, headers });
    assert.equal(ticket.statusCode, 200); assert.equal(ticket.headers['cache-control'], 'no-store');
    assert.equal(ticket.json().path, '/api/hosted-browser/desktop');
    assert.match(ticket.json().protocol, /^ponderosa\./);
    assert.equal(sockets, 1);
    assert.equal((await app.inject({ ...request, headers, payload: { action: 'open' } })).statusCode, 409, 'opening cannot replace a running browser');
    const allow = { method: 'PUT', url: '/api/projects/chat/browser/control', headers, payload: { owner: 'agent', agentId: 'chosen', nextRun: true, expectedControlEpoch: 2 } };
    const allowed = await app.inject(allow);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().nextRunAgentId, 'chosen');
    assert.equal((await app.inject({ ...allow, payload: { ...allow.payload, nextRun: undefined, currentOrNext: true } })).json().nextRunAgentId, 'chosen');
    assert.equal((await app.inject({ ...allow, payload: { ...allow.payload, agentId: 'foreign' } })).statusCode, 404);
  } finally { await app.close(); }
});
