import test from 'node:test';
import assert from 'node:assert/strict';
import { withFixture } from '../shared/fixture.mjs';

test('check 31: provider status reads do not test access; explicit recheck probes only its selected provider', {
  timeout: 30000
}, t => withFixture(t, async f => {
  for (let i = 0; i < 2; i++) {
    const engines = f.ok(await f.api('GET', '/api/engines'));
    assert.ok(engines.some(x => x.id === 'codex'));
  }
  assert.deepEqual(f.providerProbes, [], 'Merely displaying status made a diagnostic provider request');
  assert.equal((await f.api('POST', '/api/engines/unknown-fixture-provider/recheck')).status, 404);
  assert.deepEqual(f.providerProbes, [], 'An unknown provider triggered another provider\'s probe');
  const checked = f.ok(await f.api('POST', '/api/engines/codex/recheck'));
  assert.equal(checked.id, 'codex');
  assert.deepEqual(f.providerProbes, [{ engineId: 'codex' }]);
  assert.equal(f.turns.length, 0, 'A provider diagnostic created Agent task work');
}));

import { publicProviderFailure, publicProviderFailureEvent, publicProviderFailureSummary, publicProviderFailureRemediation, outcomeCauseExplanation } from '@ponderosa/core';
import { mapClaudeEvent } from '../../packages/engines/dist/claude-events.js';
import { ClaudeModelCatalogProbe } from '../../packages/engines/dist/claude-models.js';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const input of [
  { detail: 'HTTP 429 Too many requests' },
  { code: 'rate_limit_error', detail: 'temporary throttle' },
  { category: 'rate_limit', detail: 'No allowance information' },
  { code: 'quota_exhausted', detail: 'Quota exhausted' },
  { detail: 'usage limit was reached' },
]) test('Q05 rate/quota evidence stays request-limited without asserting an account reset: ' + JSON.stringify(input), () => {
  const result = publicProviderFailure(input);
  assert.equal(result.category, 'rate_limit');
  assert.equal(result.summary, 'Provider limited the request.');
  assert.equal(result.remediation, 'Wait before retrying; check provider usage information for any reset time.');
  assert.equal(publicProviderFailureSummary(result.summary), result.summary);
  assert.equal(publicProviderFailureRemediation(result.summary), result.remediation);
});
test('Q05 structured capacity wins over incidental 429 text; unknown and secrets remain bounded', () => {
  const capacity = publicProviderFailure({ code: 'capacity', detail: 'HTTP 429 secret-fixture-token' });
  assert.equal(capacity.category, 'capacity'); assert.equal(capacity.summary, 'Provider is temporarily at capacity.');
  for (const detail of ['arbitrary secret-fixture-token', '{"error":"HTTP 429 secret-fixture-token"}', 'x'.repeat(3000), 'HTTP 429 \u200b secret-fixture-token']) {
    const failure = publicProviderFailure({ detail }); assert.equal(failure.category, 'unknown'); assert.doesNotMatch(JSON.stringify(failure), /secret-fixture-token/u);
  }
});
test('Q05 Claude mapped errors and public events retain throttle/capacity/unknown distinctions without leaking provider detail', () => {
  for (const [code, category] of [['rate_limit', 'rate_limit'], ['quota_exhausted', 'rate_limit'], ['overloaded_error', 'capacity'], ['unrecognized_failure', 'unknown']]) {
    const mapped = mapClaudeEvent({ type: 'assistant', error: code, message: { content: [{ type: 'text', text: 'secret-fixture-token' }] } })[0];
    assert.equal(mapped.type, 'error');
    const visible = publicProviderFailureEvent(mapped); assert.equal(visible.category, category); assert.doesNotMatch(JSON.stringify(visible), /secret-fixture-token/u);
    if (category === 'rate_limit') { assert.match(mapped.message, /^Claude limited the request/u); assert.equal(visible.message, 'Provider limited the request.'); }
  }
});
test('Q05 interrupted outcomes do not claim an account quota or completed work and preserve duplicate-work guidance', () => {
  for (const promptSubmissionState of ['not_injected', 'injecting', 'injected']) {
    const explanation = outcomeCauseExplanation({ code: 'provider_outcome_unknown', providerFailureCategory: 'rate_limit', promptSubmissionState });
    assert.match(explanation, /provider limited the request/u); assert.doesNotMatch(explanation, /reached a usage limit|account.*exhaust/u);
    assert.match(explanation, /retry could repeat work/u);
  }
});
test('Q05 real Claude validation boundary uses only a local fake executable and honest limited-request wording', { timeout: 30000, skip: process.platform === 'win32' || /\s/u.test(process.execPath) ? 'Fixture requires a POSIX shebang with a whitespace-free Node executable; normalization checks remain portable' : false }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-q05-validation-')); let passed = false;
  t.after(async () => { if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic('Retained owned fixture: ' + root); });
  const bin = path.join(root, 'fake-claude');
  await writeFile(bin, '#!' + process.execPath + '\n' + `const model=process.argv.at(-1); const error=model==='capacity'?'overloaded_error':'rate_limit'; console.log(JSON.stringify({type:'assistant',error})); console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:model==='quota'?'quota exhausted':'HTTP 429',errors:[]}));\n`);
  await chmod(bin, 0o700);
  const probe = new ClaudeModelCatalogProbe({ bin, killGraceMs: 100 });
  const handles = []; const context = { signal: new AbortController().signal, onRuntimeSpawned: handle => handles.push(handle) };
  try {
    for (const model of ['throttle', 'quota', 'capacity']) {
      const result = await probe.validate(root, model, context); assert.equal(result.valid, false); assert.equal(handles.at(-1).isAlive(), false, 'Validation returned before owned process exit');
      assert.equal(result.errorCode, model === 'capacity' ? 'capacity' : 'rate_limit');
      if (model === 'capacity') assert.match(result.error, /temporarily at capacity/u);
      else { assert.match(result.error, /limited the request/u); assert.doesNotMatch(result.error, /usage limit was reached|Wait for the limit to reset/u); }
    }
    assert.equal(handles.length, 3);
  } finally { await Promise.all(handles.map(handle => handle.close())); }
  assert.ok(handles.every(handle => !handle.isAlive()), 'Owned validation process remains alive');
  passed = true;
});

test('Claude model test ignores custom MCP workflows without spending extra turns', { skip: process.platform === 'win32' || /\s/u.test(process.execPath) }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-model-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fake-claude'), handles = [];
  await writeFile(bin, '#!' + process.execPath + '\n' + `
    const args=process.argv.slice(2), prompt=args[args.indexOf('-p')+1];
    const safe=args.includes('--safe-mode') && prompt.includes('PONDEROSA_MODEL_READY') && prompt.includes('Do not use tools');
    if(args[args.indexOf('--model')+1]!=='sonnet' || args[args.indexOf('--tools')+1]!=='')process.exit(1);
    console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-sonnet-fixture'}));
    if(!safe)console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__chunking__get_recent'}]}}));
    console.log(JSON.stringify(safe?{type:'result',subtype:'success',is_error:false,result:'PONDEROSA_MODEL_READY'}:
      {type:'result',subtype:'error_max_turns',is_error:true,errors:['Reached maximum number of turns (1)']}));
  `);
  await chmod(bin, 0o700);
  const result = await new ClaudeModelCatalogProbe({ bin, killGraceMs: 100 }).validate(root, 'sonnet', {
    signal: new AbortController().signal, onRuntimeSpawned: handle => handles.push(handle),
  });
  assert.equal(result.valid, true);
  assert.equal(result.model.id, 'sonnet');
  assert.ok(handles.length && handles.every(handle => !handle.isAlive()), 'Probe must observe process exit');
});

import { defaultEngineRegistrations } from '@ponderosa/engines';
import { createRequire } from 'node:module';
import { createEngineControlPlane } from '../../apps/server/dist/engine-control-plane.js';
import { runtimeSelectionError } from '../../apps/server/dist/runtime-selection.js';
import { registerEngineRoutes } from '../../apps/server/dist/routes/engines.js';
import { EngineAuthStatusCache } from '../../apps/server/dist/engine-auth-cache.js';
const Fastify = createRequire(new URL('../../apps/server/package.json', import.meta.url))('fastify');

test('optional providers: presence checks exact executable paths and PATH, detect install/removal, and never probe an absent CLI', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-provider-presence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = path.join(root, 'not installed');
  const registrations = defaultEngineRegistrations({ PONDEROSA_CODEX_BIN: missing, PONDEROSA_CLAUDE_BIN: missing });
  for (const registration of registrations) {
    assert.equal(registration.isInstalled(), false);
    assert.deepEqual(await registration.authStatus({ onRuntimeSpawned() { assert.fail('Absent CLI spawned an auth helper'); } }), { authenticated: false });
  }
  await writeFile(missing, 'fixture'); await chmod(missing, 0o700);
  assert.ok(registrations.every(r => r.isInstalled()), 'Installing at a configured path must be detected without restart');
  await rm(missing);
  assert.ok(registrations.every(r => !r.isInstalled()));
  // Explicit missing configuration must never fall back to a different host binary.
  const binary = path.join(root, process.platform === 'win32' ? 'claude.EXE' : 'claude');
  await writeFile(binary, 'fixture'); await chmod(binary, 0o700);
  assert.equal(defaultEngineRegistrations({ PATH: root, PONDEROSA_CLAUDE_BIN: '' }).find(r => r.adapter.id === 'claude').isInstalled(), true);
  assert.equal(defaultEngineRegistrations({ PATH: root, PONDEROSA_CLAUDE_BIN: missing }).find(r => r.adapter.id === 'claude').isInstalled(), false);
  if (process.platform !== 'win32') {
    await chmod(binary, 0o600);
    assert.equal(defaultEngineRegistrations({ PATH: root, PONDEROSA_CLAUDE_BIN: '' }).find(r => r.adapter.id === 'claude').isInstalled(), false);
  }
});

test('absent or disabled provider discovery/recheck creates no helpers; reinstall recovers without restarting or rerouting', async () => {
  const app = Fastify({ logger: false });
  let installed = false, enabled = true, discoveries = 0, probes = 0, authReads = 0;
  const project = { id: 'presence-project', hostPath: process.cwd() };
  const registration = defaultEngineRegistrations({ PONDEROSA_CLAUDE_BIN: '/__ponderosa_absent_provider__/claude' }).find(r => r.adapter.id === 'claude');
  registration.isInstalled = () => installed;
  registration.authStatus = async () => { authReads++; return { authenticated: true }; }; // stale profile must not override absence
  registration.availabilityProbe = async () => { probes++; return { available: true }; };
  registration.adapter.discoverModelCatalog = async () => { discoveries++; return { models: [], cliVersion: 'fixture', configurationKey: 'fixture' }; };
  registration.adapter.capabilities = async () => { discoveries++; return { steering: false, persistentSessions: false, commands: [], mcpServers: [], composerCapabilities: [] }; };
  registration.adapter.validateModel = async () => { discoveries++; return { valid: true }; };
  const engines = new Map([['claude', registration]]), auth = new EngineAuthStatusCache();
  const availability = { get: () => undefined, denial: () => undefined, record: x => x, servingBuildRevision: 'fixture', servingInstanceId: 'fixture' };
  const workspace = { cursor: () => 0, getPreferences: () => ({ providerAvailability: { claude: enabled } }) };
  const store = { getProject: id => id === project.id ? project : undefined, listAgents: () => [] };
  const plane = createEngineControlPlane({ engines, store, workspace, engineAuthStatuses: auth, engineAvailability: availability, providerUsage: {}, providerEnabled: () => enabled, applyOperatorModelOptions() {}, publishWorkspaceSince() {}, appendWorkspace() {}, activeRuns: new Map(), app, deletingProjectIds: new Set(), isClosed: () => false, providerProcessAuthority: { register() { assert.fail('Unexpected provider process'); } } });
  registerEngineRoutes(app, { engines, store, workspace, engineDto: plane.engineDto, authStatuses: auth, availability, discoverModelCatalog: plane.discoverEngineModelCatalog, validateModel: plane.validateEngineModel, discoverCapabilities: plane.discoverEngineCapabilities, readCapabilities: plane.readEngineCapabilities, projectDeletionInProgress: () => false, publishWorkspaceSince() {}, notifyScheduler() {}, createOperationalNotification() {}, resolveOperationalNotification() {} });
  try {
    for (const scenario of ['absent', 'disabled']) {
      installed = scenario === 'disabled'; enabled = scenario !== 'disabled';
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await app.inject({ method: 'GET', url: '/api/projects/presence-project/engine-models/claude' });
        assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'PROVIDER_INACTIVE');
        const capabilities = await app.inject({ method: 'GET', url: '/api/projects/presence-project/engine-capabilities?refresh=1' });
        assert.equal(capabilities.statusCode, 200); assert.equal(capabilities.json()[0].discovered, false); // no invented successful discovery
        const validate = await app.inject({ method: 'POST', url: '/api/projects/presence-project/engine-models/claude/validate', payload: { modelId: 'fixture' } });
        assert.equal(validate.statusCode, 409);
        const recheck = await app.inject({ method: 'POST', url: '/api/engines/claude/recheck' }); assert.equal(recheck.statusCode, 200); assert.equal(recheck.json().intakeReady, false);
      }
    }
    assert.equal(discoveries, 0); assert.equal(probes, 0); assert.equal(authReads, 0, 'Absent and disabled providers must not start authentication helpers');
    installed = false; enabled = true;
    const absent = await plane.engineDto(registration);
    assert.equal(absent.installed, false); assert.equal(absent.intakeReady, false); assert.equal(absent.reachability, 'unverified');
    assert.equal(plane.runtimeAdmissionBlocker('claude', registration).kind, 'provider_unavailable');
    const reads = authReads;
    await plane.engineDto(registration); assert.equal(authReads, reads, 'Repeated absent-provider status reads must not authenticate');
    installed = true;
    const present = await plane.engineDto(registration); assert.equal(present.installed, true); assert.equal(present.intakeReady, true);
    const catalog = await app.inject({ method: 'GET', url: '/api/projects/presence-project/engine-models/claude' }); assert.equal(catalog.statusCode, 200); assert.equal(discoveries, 1);
    await app.inject({ method: 'POST', url: '/api/engines/claude/recheck' }); assert.equal(probes, 1);
    installed = false;
    assert.equal((await plane.engineDto(registration)).intakeReady, false, 'Cached authentication/catalog must not authorize a removed executable');
    assert.equal(plane.engineModelCatalogDiscoveryAuthorities.size, 0); assert.equal(plane.engineCapabilityDiscoveryAuthorities.size, 0);
  } finally { await plane.drainEngineModelCatalogDiscoveries(); await plane.drainEngineCapabilityDiscoveries(); await app.close(); }
});

for (const providers of [[], ['codex'], ['claude'], ['codex', 'claude']]) {
  test('fresh server supports installed provider set: ' + (providers.join('+') || 'neither'), { timeout: 30000 }, t => withFixture(t, async f => {
    const roster = f.ok(await f.api('GET', '/api/engines'));
    assert.deepEqual(roster.filter(x => x.intakeReady).map(x => x.id).sort(), [...providers].sort());
    for (const engine of roster) assert.equal(engine.installed, providers.includes(engine.id));
    const response = await f.api('GET', '/api/diagnostics/ready');
    assert.equal(response.status, providers.length ? 200 : 503);
    const ready = response.body;
    assert.equal(ready.checks.runtimes.ok, providers.length > 0);
    assert.match(ready.checks.runtimes.detail, new RegExp(`${providers.length} of ${providers.length} installed`));
    assert.deepEqual(f.providerProbes, []);
    assert.equal(f.turns.length, 0);
    if (providers.length) {
      const engine = providers[0];
      const chat = f.ok(await f.api('POST', '/api/chats', { label: 'Single-provider install', defaultEngine: engine }, { 'idempotency-key': crypto.randomUUID() }));
      const agent = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agents`, { title: 'Installed provider', engine, conversationId: chat.id, initialMessage: 'Controlled task', idempotencyKey: crypto.randomUUID(), awaitResult: true }));
      await f.settled(agent.id);
      assert.equal((await f.detail(agent.id)).agent.activeEngine, engine, 'Existing stable provider selection must not be rerouted');
      assert.ok(f.turns.length > 0, 'Installed provider must execute controlled work');
    }
  }, { diagnosticProvider: true, providerInstalled: id => providers.includes(id) }));
}


test('retained session inventory cannot replace a newly installed CLI catalog or its admission choices', async () => {
  const app = Fastify({ logger: false });
  let version = '0.143.0', discoveries = 0;
  const model = id => ({ id, label: id, kind: 'alias', source: 'provider-probe', efforts: [{ id: 'high', label: 'High' }] });
  const old = { models: [model('old-model')], cliVersion: version, configurationKey: version };
  const project = { id: 'upgrade-project', hostPath: process.cwd() };
  const registration = defaultEngineRegistrations().find(r => r.adapter.id === 'codex');
  registration.isInstalled = () => true;
  registration.authStatus = async () => ({ authenticated: true });
  registration.adapter.modelCatalogConfigurationKey = () => version;
  registration.adapter.discoverModelCatalog = async () => { discoveries++; return { models: [model(version === old.cliVersion ? 'old-model' : 'new-model')], cliVersion: version, configurationKey: version }; };
  const plane = createEngineControlPlane({ engines: new Map([['codex', registration]]), store: { getProject: () => project, listAgents: () => [{ id: 'pinned-agent', activeEngine: 'codex', model: 'old-model' }] }, workspace: {},
    engineAuthStatuses: new EngineAuthStatusCache(), engineAvailability: { get() {}, denial() {}, servingBuildRevision: 'fixture', servingInstanceId: 'fixture' }, providerUsage: {}, providerEnabled: () => true,
    applyOperatorModelOptions() {}, publishWorkspaceSince() {}, appendWorkspace() {}, activeRuns: new Map([['pinned-agent', { runtimeSession: { capabilities: async () => ({ steering: false, persistentSessions: true, commands: [], mcpServers: [], composerCapabilities: [], modelCatalog: old }) } }]]), app, deletingProjectIds: new Set(), isClosed: () => false, providerProcessAuthority: { register() { assert.fail('Controlled inventory must not spawn a process'); } } });
  try {
    assert.equal((await plane.engineDto(registration)).models[0].id, 'old-model');
    version = '0.159.2';
    assert.equal((await plane.engineDto(registration, true)).models[0].id, 'new-model');
    const current = await plane.discoverEngineModelCatalog(project, registration.adapter, false);
    assert.equal(current.cliVersion, version);
    assert.equal(current.models[0].id, 'new-model');
    assert.equal(plane.cachedModelOptions(registration.adapter, project.id)[0].id, 'new-model');
    assert.equal(runtimeSelectionError(registration.adapter, 'new-model', 'high', plane.cachedModelOptions(registration.adapter, project.id)), undefined);
    assert.equal(discoveries, 3, 'Host refresh and project discovery must use the current adapter inventory');
    assert.equal(old.models[0].id, 'old-model', 'Refreshing choices must not mutate the retained session');
  } finally { await plane.drainEngineModelCatalogDiscoveries(); await app.close(); }
});
