import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBrowserRoutes } from '../dist/routes/browsers.js';
import { BrowserProfileAuthority } from '../dist/browser-profile-authority.js';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';

test('chat browser opens manual-capable, remembers explicit profile choice and never replaces an existing session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unified-browser-'));
  const profiles = new BrowserProfileAuthority(root);
  const app = Fastify();
  let existing, launches = [];
  const scope = projectId => ({ projectId, agentId: `project-browser:${projectId}`, runId: `project:${projectId}` });
  registerBrowserRoutes(app, {
    projectExists: id => id === 'chat', projectDeletionInProgress: () => false,
    browserProfiles: profiles, projectBrowserScope: scope, projectBrowserDto: (_, value) => value,
    projectBrowserSessions: {
      get: () => existing,
      open: async (...args) => { launches.push(args); return existing = { id: 'same-browser', status: 'ready', manualControl: 'manual' }; },
    },
  });
  const open = payload => app.inject({ method: 'POST', url: '/api/projects/chat/browser', payload });
  try {
    assert.equal((await open({ url: 'file:///etc/passwd', rememberSignIns: true })).statusCode, 400);
    assert.equal(profiles.listProfiles('chat').length, 0, 'invalid navigation does not create a profile');
    const unrelated = profiles.createProfile('chat', 'Chat browser');
    const first = await open({ url: 'https://example.test', rememberSignIns: true });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(launches[0][4], true);
    assert.equal(launches[0][1], 'https://example.test');
    const identity = profiles.description(scope('chat')).profileId;
    assert.ok(identity);
    assert.notEqual(identity, unrelated.id, 'display names do not authorize reuse of a different profile');
    assert.equal((await open({ rememberSignIns: false })).json().id, 'same-browser');
    assert.equal(launches.length, 1);
    assert.equal(profiles.description(scope('chat')).profileId, identity, 'opening an existing session cannot switch its profile');
    existing = undefined;
    assert.equal((await open({})).statusCode, 200);
    assert.equal(profiles.description(scope('chat')).profileId, identity, 'reopening keeps the saved profile');
    assert.equal((await app.inject('/api/projects/chat/browser/preferences')).json().rememberSignIns, true);
    existing = undefined;
    assert.equal((await open({ rememberSignIns: false })).statusCode, 200);
    assert.equal(profiles.description(scope('chat')).profileMode, 'disposable');
    assert.ok(profiles.getProfile('chat', identity), 'temporary browsing never deletes remembered data');
    profiles.renameProfile('chat', identity, 'My saved browser');
    existing = undefined;
    assert.equal((await open({ rememberSignIns: true })).statusCode, 200);
    assert.equal(profiles.description(scope('chat')).profileId, identity, 'temporary mode and profile renaming do not lose saved identity');
    assert.equal((await app.inject('/api/projects/foreign/browser/preferences')).statusCode, 404);
  } finally { await app.close(); profiles.db.close(); await rm(root, { recursive: true, force: true }); }
});

test('manual opening passes an HTTP URL to native Chrome without connecting automation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manual-start-url-'));
  let launch, alive = true;
  const manager = new BrowserSessionManager(root, async (_id, _console, _publish, _event, options) => {
    launch = options;
    return { isAlive: () => alive, close: async () => { alive = false; }, manualState: () => 'manual',
      navigate: async () => { assert.fail('manual launch must not navigate through automation'); },
      pages: async () => ({ activePageId: 'manual', pages: [{ pageId: 'manual', url: 'about:blank', title: 'Browser', active: true }] }),
    };
  }, () => {});
  try {
    const session = await manager.open({ projectId: 'chat', agentId: 'browser', runId: 'shared' }, 'https://example.test/start', 'operator', undefined, true);
    assert.equal(session.manualControl, 'manual');
    assert.equal(launch.initialUrl, 'https://example.test/start');
    assert.equal(launch.nativeManual, true);
  } finally { await manager.closeAll('test'); await rm(root, { recursive: true, force: true }); }
});
