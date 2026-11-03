import test from 'node:test';
import assert from 'node:assert/strict';
import { withFixture, until } from '../shared/fixture.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from '../../apps/server/dist/app.js';
import { processBirthMarker } from '@ponderosa/engines';

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
import { mkdtemp, writeFile, chmod, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const input of [
  { detail: 'HTTP 429 Too many requests' },
  { code: 'rate_limit_error', detail: 'temporary throttle' },
  { category: 'rate_limit', detail: 'No allowance information' },
]) test('Q05 ambiguous limit evidence stays request-limited without asserting an account reset: ' + JSON.stringify(input), () => {
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
  for (const [code, category] of [['rate_limit', 'rate_limit'], ['quota_exhausted', 'quota_exhausted'], ['overloaded_error', 'capacity'], ['unrecognized_failure', 'unknown']]) {
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
      assert.equal(result.errorCode, model === 'capacity' ? 'capacity' : model === 'quota' ? 'quota_exhausted' : 'rate_limit');
      if (model === 'capacity') assert.match(result.error, /temporarily at capacity/u);
      else if (model === 'quota') assert.match(result.error, /usage limit reached/u);
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
import { runtimeSelectionError, providerRuntimeSessionContractHash, providerSessionContractHash, providerToolContractHash, communicationV3SessionPrompt, providerDynamicTools } from '../../apps/server/dist/runtime-selection.js';
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
  const plane = createEngineControlPlane({ engines, store, workspace, engineAuthStatuses: auth, engineAvailability: availability, providerUsage: {}, providerEnabled: () => enabled, applyOperatorModelOptions() {}, publishWorkspaceSince() {}, appendWorkspace() {}, activeRuns: new Map(), app, deletingProjectIds: new Set(), isClosed: () => false, providerProcessAuthority: { count:()=>0, register() { assert.fail('Unexpected provider process'); } } });
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
    applyOperatorModelOptions() {}, publishWorkspaceSince() {}, appendWorkspace() {}, activeRuns: new Map([['pinned-agent', { runtimeSession: { capabilities: async () => ({ steering: false, persistentSessions: true, commands: [], mcpServers: [], composerCapabilities: [], modelCatalog: old }) } }]]), app, deletingProjectIds: new Set(), isClosed: () => false, providerProcessAuthority: { count:()=>0, register() { assert.fail('Controlled inventory must not spawn a process'); } } });
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

test('deferred sign-in checks stay checking during host pressure and recover without authorizing stale credentials', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-01-01T00:00:00Z')});
  const app=Fastify({logger:false}),auth=new EngineAuthStatusCache();
  let reads=0,answer={authenticated:true},resources={state:'held',protected:true,reason:'host_resource_pressure'};
  const registration=defaultEngineRegistrations().find(r=>r.adapter.id==='claude');
  registration.isInstalled=()=>true;registration.authStatus=async()=>{reads++;return answer;};
  const plane=createEngineControlPlane({engines:new Map([['claude',registration]]),store:{listAgents:()=>[]},workspace:{getPreferences:()=>({})},engineAuthStatuses:auth,engineAvailability:{get(){},denial(){},servingBuildRevision:'test',servingInstanceId:'test'},providerUsage:{},providerEnabled:()=>true,applyOperatorModelOptions(){},publishWorkspaceSince(){},appendWorkspace(){},activeRuns:new Map(),app,deletingProjectIds:new Set(),isClosed:()=>false,providerProcessAuthority:{count:()=>0,register(){assert.fail('Unexpected provider process')}},resourceAdmission:{snapshot:()=>resources}});
  try {
    await auth.get('claude',registration.authStatus);t.mock.timers.tick(31000);
    const held=await plane.runtimeStatus('claude',registration);
    assert.equal(reads,1);assert.equal(held.authentication,'checking');assert.equal(held.intakeReady,false);
    assert.equal(held.authLastKnown.authenticated,true);assert.equal(held.resourceAdmission.state,'held');
    assert.match(held.authDetail,/deferred.*host resources/i);assert.match(held.availabilityDetail,/host resources/i);
    assert.equal(plane.runtimeAdmissionBlocker('claude',registration).kind,'host_resource_pressure');
    resources={state:'ready',protected:true,reason:'within_budget'};
    const recovered=await plane.runtimeStatus('claude',registration);
    assert.equal(reads,2);assert.equal(recovered.authentication,'authenticated');assert.equal(recovered.intakeReady,true);
    auth.invalidate('claude');answer={authenticated:false};
    const signedOut=await plane.runtimeStatus('claude',registration);
    assert.equal(signedOut.authentication,'unauthenticated');assert.equal(signedOut.intakeReady,false);assert.match(signedOut.authDetail,/required/);
    auth.invalidate('claude');answer={authenticated:false,status:'unknown',reason:'probe_pending'};
    const checking=await plane.runtimeStatus('claude',registration);
    assert.equal(checking.authentication,'checking');assert.match(checking.authDetail,/pending/);assert.equal(checking.intakeReady,false);
    auth.invalidate('claude');answer={authenticated:false,status:'unknown',reason:'timeout'};
    assert.equal((await plane.runtimeStatus('claude',registration)).authentication,'error');
    auth.invalidate('claude');resources={state:'ready',protected:true,reason:'within_budget'};
    let release,entered;const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
    registration.authStatus=async()=>{entered();await waiting;return {authenticated:true}};
    const pending=plane.runtimeStatus('claude',registration);await started;
    resources={state:'held',protected:true,reason:'host_resource_pressure'};release();
    const changed=await pending;assert.equal(changed.authentication,'authenticated');assert.equal(changed.intakeReady,false);
    assert.equal(changed.resourceAdmission.state,'held');assert.match(changed.availabilityDetail,/host resources/i);

  } finally {await app.close();}
});

test('Claude probe start failures remain operation errors when process registration also refuses the helper', {timeout:15000,skip:process.platform==='win32'?'Covers POSIX asynchronous spawn failure; Windows launches behind the existing Job gate':false},async t=>{
 const {spawnSync}=await import('node:child_process');
 const root=await mkdtemp(path.join(tmpdir(),'ponderosa-probe-start-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const moduleUrl=new URL('../../packages/engines/dist/claude-models.js',import.meta.url).href;
 for(const method of ['discover','validate'])for(const refusesRegistration of [false,true]){
  const source=`
   import assert from 'node:assert/strict';
   import {ClaudeModelCatalogProbe} from ${JSON.stringify(moduleUrl)};
   const probe=new ClaudeModelCatalogProbe({bin:process.execPath,killGraceMs:50});
   const handles=[],context={signal:new AbortController().signal,onRuntimeSpawned(handle){handles.push(handle);if(${refusesRegistration})throw new Error('fixture registration refused missing identity');}};
   const operation=${JSON.stringify(method)}==='discover'?()=>probe.discover(${JSON.stringify(path.join(root,'missing-directory'))},context):()=>probe.validate(${JSON.stringify(path.join(root,'missing-directory'))},'fixture',context);
   await assert.rejects(operation);
   await Promise.all(handles.map(handle=>handle.close()));
   assert.ok(handles.every(handle=>!handle.isAlive()),'Failed helper left process authority alive');
   await new Promise(resolve=>setTimeout(resolve,30));
   console.log('failure reported; host survived');
  `;
  const result=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',source],{cwd:root,env:{...process.env,PONDEROSA_AGENT_SCOPE_MODE:''},encoding:'utf8',timeout:3000});
  assert.equal(result.status,0,`${method}, registration refuses=${refusesRegistration}: ${result.error?.message??result.stderr.slice(-1800)}`);
  assert.match(result.stdout,/failure reported; host survived/u);
 }
});


for (const engine of ['codex', 'claude']) test(`${engine}: reusable Agent Role creates idle once and updates only future session snapshots`, { timeout: 60000 }, t => withFixture(t, async f => {
  const chat = await f.createChat('Standing role fixture');
  const url = `/api/projects/${chat.projectId}/agents`;
  const body = { title: 'Reusable Reviewer', engine, conversationId: chat.id, role: 'Review Cafe\u0301\r\nCarefully', idempotencyKey: crypto.randomUUID() };
  const agent = f.ok(await f.api('POST', url, body));
  assert.equal(agent.role, 'Review Café\nCarefully');
  assert.equal(f.ok(await f.api('POST', url, body)).id, agent.id);
  assert.equal((await f.api('POST', url, { ...body, role: 'A different role' })).status, 409);
  const exported = f.ok(await f.api('GET', `/api/agents/${agent.id}/export?mode=template`));
  assert.equal(exported.agents[0].initialInstructions, agent.role, 'Export lost the explicit standing role');
  assert.equal(f.turns.length, 0, 'Standing setup dispatched task work');
  assert.equal((await f.detail(agent.id)).runs.length, 0);
  for (const role of [{ bad: true }, 'x'.repeat(8001)]) assert.equal((await f.api('PATCH', `/api/agents/${agent.id}`, { role })).status, 400);
  await f.send(agent.id, 'Perform first controlled task');
  const first = await f.settled(agent.id), before = first.runs.map(run => run.id);
  const firstInput = f.ok(await f.api('GET', `/api/runs/${first.runs[0].id}/provider-input?exact=1`));
  assert.match(firstInput.exactSystemPrompt, /Review Café\nCarefully/u);
  const session = await f.hold(agent.id);
  const active = (await f.detail(agent.id)).runs.find(run => !before.includes(run.id));
  const activeInput = f.ok(await f.api('GET', `/api/runs/${active.id}/provider-input?exact=1`));
  const changed = f.ok(await f.api('PATCH', `/api/agents/${agent.id}`, { role: 'Check Only Verified Evidence' }));
  assert.equal(changed.role, 'Check Only Verified Evidence');
  assert.deepEqual(f.ok(await f.api('GET', `/api/runs/${active.id}/provider-input?exact=1`)), activeInput, 'Role save rewrote accepted Run instructions');
  assert.equal((await session.tool('ponderosa_message', { text: 'Finished the owned task' })).success, true); session.finish();
  const completed = await f.settled(agent.id, before);
  await f.send(agent.id, 'Perform next controlled task');
  const next = await f.settled(agent.id, completed.runs.map(run => run.id));
  const nextRun = next.runs.find(run => !completed.runs.some(previous => previous.id === run.id));
  const nextInput = f.ok(await f.api('GET', `/api/runs/${nextRun.id}/provider-input?exact=1`));
  assert.match(nextInput.exactSystemPrompt, /Check Only Verified Evidence/u);
  assert.notEqual(nextInput.systemPromptHash, activeInput.systemPromptHash);
  f.ok(await f.api('PATCH', `/api/agents/${agent.id}`, { role: null }));
  const previous = next.runs.map(run => run.id);
  await f.send(agent.id, 'Perform task after clearing explicit role');
  const cleared = await f.settled(agent.id, previous), clearedRun = cleared.runs.find(run => !previous.includes(run.id));
  const clearedInput = f.ok(await f.api('GET', `/api/runs/${clearedRun.id}/provider-input?exact=1`));
  assert.doesNotMatch(clearedInput.exactSystemPrompt, /Agent standing role|Check Only Verified Evidence/u);
  await f.reopen();
  assert.equal((await f.detail(agent.id)).agent.role, undefined);
}, { diagnosticProvider: true }));


test('adding standing roles preserves existing creation fingerprints when no role was requested', { timeout: 30000 }, async t => {
  const { AgentStore } = await import('@ponderosa/agents');
  const { createHash } = await import('node:crypto');
  const { stableJson } = await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
  let store;
  await withFixture(t, async f => {
    const chat = await f.createChat('Existing creation identity');
    const idempotencyKey = crypto.randomUUID(), body = { title: 'Legacy Intent', engine: 'codex', conversationId: chat.id, idempotencyKey };
    const agent = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agents`, body));
    const oldPayload = { projectId: chat.projectId, title: body.title, engine: body.engine, conversationId: chat.id, model: null, effort: null, speed: null, initialMessage: null, draftAttachmentIds: [], draftOwnerId: null, presetId: null, managerAgentId: null, awaitResult: null, managementPermissions: null };
    const expected = createHash('sha256').update(stableJson(oldPayload)).digest('hex');
    assert.equal(store.sqlite.prepare('SELECT payload_hash FROM agent_creation_operations WHERE idempotency_key = ?').get(idempotencyKey).payload_hash, expected);
    assert.equal(f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agents`, body)).id, agent.id);
  }, { storeFactory: dataDir => (store = new AgentStore(dataDir)) });
});

import {EngineAvailabilityStore} from '../../apps/server/dist/engine-availability-store.js';
import {ProviderProcessAuthority} from '../../apps/server/dist/provider-process-authority.js';
import {openCurrentMemoryDatabase} from '../../packages/agents/dist/state-admission.js';
test('transient provider denials expire for owned revalidation but older success never overwrites newer denial',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'availability-revalidation-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let evidence=new EngineAvailabilityStore(root),started=new Date(Date.now()-120000).toISOString(),observed=new Date(Date.now()-70000).toISOString();
 evidence.record({engineId:'codex',available:false,failureCategory:'unavailable',source:'operator_probe',observedAt:observed});
 evidence=new EngineAvailabilityStore(root);assert.equal(evidence.denial('codex'),undefined);
 const stale=evidence.record({engineId:'codex',available:true,source:'provider_run',operationStartedAt:started});assert.equal(stale.available,false);assert.equal(evidence.get('codex').observedAt,observed);
 evidence.record({engineId:'codex',available:true,source:'operator_probe',operationStartedAt:new Date().toISOString()});assert.equal(evidence.get('codex').available,true);
 for(const failureCategory of ['authentication','quota_exhausted','invalid_request']){evidence.record({engineId:'codex',available:false,failureCategory,source:'operator_probe',observedAt:observed});assert.ok(evidence.denial('codex'));}
});
test('native diagnostic handles remain owned blockers after failed cleanup and clear only on observed exit',async t=>{
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());const owner=new ProviderProcessAuthority(db,'owned-native-test'),platform=Object.getOwnPropertyDescriptor(process,'platform');
 let alive=true,fail=true,closes=0;const handle={isAlive:()=>alive,close:async()=>{closes++;if(fail)throw Error('Controlled native cleanup failure');alive=false}};
 try{Object.defineProperty(process,'platform',{...platform,value:'win32'});owner.register(handle,{purpose:'codex availability diagnostic'});}finally{Object.defineProperty(process,'platform',platform)}
 assert.equal(owner.count({purpose:'codex availability diagnostic'}),1);await assert.rejects(owner.terminatePurpose('codex availability diagnostic'),/pending/);assert.equal(owner.count(),1);
 owner.pruneExited();assert.equal(owner.count(),1);fail=false;await owner.terminateDiagnostics();assert.equal(owner.count(),0);assert.equal(closes,2);
});

import {providerSessionFacade,projectProviderRootExitDetail,ProviderRuntimeBoundaryError} from '../../apps/server/dist/provider-session-facade.js';
test('provider exit evidence and resume validation cross only closed data boundaries',()=>{
 const raw={engineAgentId:'session',events:{async *[Symbol.asyncIterator](){}},isAlive:()=>true,close:async()=>{},startTurn:async()=>({turnId:'t'}),steer:async()=>({status:'not_active'}),interrupt:async()=>{},validatesResumeBeforeTurn:true};
 assert.equal(providerSessionFacade(raw).validatesResumeBeforeTurn,true);
 let getterCalls=0;const invalid=Object.defineProperty({},'terminalEvent',{get(){getterCalls++;return {type:'error',message:'forged'}}});
 assert.throws(()=>projectProviderRootExitDetail(invalid));assert.equal(getterCalls,0);
 const detail=projectProviderRootExitDetail({outputDraining:false,exitCode:0,terminalEvent:{type:'error',category:'quota_exhausted',message:'Exact harmless root detail; api_key=SYNTHETIC_ROOT_SECRET',quotaResetAt:'2030-01-01T00:00:00.000Z'}});
 assert.equal(detail.terminalEvent.category,'quota_exhausted');assert.equal(detail.terminalEvent.quotaResetAt,'2030-01-01T00:00:00.000Z');assert.match(detail.terminalEvent.message,/Exact harmless root detail/);assert.doesNotMatch(detail.terminalEvent.message,/SYNTHETIC_ROOT_SECRET/);
});

test('native persistent runtime aliases retain one root and cancellation never targets its previous Run',async t=>{
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());const owner=new ProviderProcessAuthority(db,'native-alias'),platform=Object.getOwnPropertyDescriptor(process,'platform'),lifetime={};
 let closed=0;const first={isAlive:()=>closed===0,close:async()=>{closed++}},alias={isAlive:()=>true,close:async()=>{throw Error('Must retain the actual spawn-time owner')}};
 try{Object.defineProperty(process,'platform',{...platform,value:'win32'});owner.register(first,{purpose:'persistent provider runtime',runId:'old'},lifetime);owner.register(alias,{purpose:'persistent provider runtime',runId:'new'},lifetime);}finally{Object.defineProperty(process,'platform',platform)}
 assert.equal(owner.count(),1);assert.equal(owner.count({runId:'old'}),0);assert.equal(owner.count({runId:'new'}),1);await owner.terminateRun('old');assert.equal(closed,0);await owner.terminateRun('new');assert.equal(closed,1);assert.equal(owner.count(),0);
});

import {createRuntimeAuthority} from '../../apps/server/dist/runtime-authority.js';
test('two-phase root exit preserves the first causal observation instead of attributing cleanup as a crash cause',async()=>{
 for(const hostOperation of [undefined,'failed resume replacement']){
  const identity={},audit=[],failures=[],run={runId:'run',executionId:'run',v3SchedulerRunId:'run',v3FencingToken:1,generation:1,persistentRuntimeIdentity:identity,messageCapability:'capability',controller:new AbortController()};
  const runtime={identity,session:{isAlive:()=>false,close:async()=>{}}},authority={oneShots:new Map(),retryAttempt:0,...(hostOperation?{closing:{runtime,reason:hostOperation}}:{reusable:runtime})};
  const activeRuns=new Map([['agent',run]]),agentMessageCapabilities=new Map([['capability',{}]]);
  const owner=createRuntimeAuthority({runtimeAuthorities:new Map([['agent',authority]]),activeRuns,agentMessageCapabilities,organizationEnvelopeStates:new Map(),scheduledSessionRollovers:new Map(),
   store:{getAgent:()=>({projectId:'project'}),appendEvent:(_id,event)=>{audit.push(event);return {event}}},coordinationV3:{ownsRunForCleanup:()=>true,agentSnapshot:()=>({activeRun:{promptInjectionState:'injected'}}),failRun:value=>failures.push(value)},coordinationV3WorkerId:'owned',
   runtimeAuthority:()=>authority,reusableRuntime:()=>authority.reusable,openingRuntime:()=>authority.opening,closingRuntime:()=>authority.closing,pruneRuntimeAuthority(){},clearAgentResumeSession(){},closeRunBrowser:async()=>{},closeLinkPreviewsForAgent(){},publish(){},publishMessageDeliveryChanged(){},resolveOperationalNotification(){},notifyScheduler(){},logError(){},transitionRun:()=>true,clearRunLeaseTimer(){},clearRunLivenessTimer(){},isClosed:()=>false});
  owner.persistentRootExited('agent',identity,{exitCode:1,outputDraining:true});assert.equal(failures.length,0);
  owner.persistentRootExited('agent',identity,{exitCode:1});
  if(hostOperation){assert.equal(failures.length,0);assert.equal(run.controller.signal.aborted,false)}
  else {assert.equal(failures.length,1);assert.equal(audit.at(-1).runtimeObservation.origin,'not_established');assert.equal(audit.at(-1).runtimeObservation.hostOperation,undefined);assert.equal(run.controller.signal.aborted,true)}
  await authority.closing?.operation;
 }
});

test('a successful sign-in observation survives a separate diagnostic cleanup failure without authorizing intake',{timeout:15000,skip:process.platform==='win32'||/\s/.test(process.execPath)?'POSIX inert executable fixture; status projection remains portable':false},async t=>{
 const {codexAuthStatus}=await import('../../packages/engines/dist/auth.js');
 const root=await mkdtemp(path.join(tmpdir(),'auth-cleanup-observation-')),bin=path.join(root,'fake-codex');let handle;
 t.after(async()=>{await rm(root,{recursive:true,force:true})});
 await writeFile(bin,'#!'+process.execPath+'\nconsole.log("Logged in using ChatGPT");\n',{mode:0o700});
 const result=await codexAuthStatus({PONDEROSA_CODEX_BIN:bin,PATH:process.env.PATH},{onRuntimeSpawned:spawned=>{handle=spawned;const close=handle.close.bind(handle);handle.close=async()=>{await close();throw Error('Controlled cleanup receipt failure')}}});
 assert.equal(handle.isAlive(),false);assert.equal(result.authenticated,true);assert.equal(result.diagnosticFailure,'cleanup_failed');
 const cache=new EngineAuthStatusCache();await cache.get('codex',async()=>result);assert.equal(cache.snapshot('codex').authenticated,true);assert.equal(cache.snapshot('codex').diagnosticFailure,'cleanup_failed');
});



for (const phase of ['before-probe', 'before-spawn']) test(`shutdown fences and drains diagnostic operations delayed ${phase}`, { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'diagnostic-shutdown-'));
  let release, entered = false, calls = 0, child, exited, app;
  const gate = new Promise(resolve => { release = resolve; });
  const original = ProviderProcessAuthority.prototype.terminatePurpose;
  ProviderProcessAuthority.prototype.terminatePurpose = async function(purpose) {
    if (phase === 'before-probe' && !entered && purpose === 'codex authentication diagnostic') { entered = true; await gate; }
    return original.call(this, purpose);
  };
  try {
    app = createServer({ dataDir: root, logger: false, engines: [{
      adapter: { id: 'codex', displayName: 'Owned diagnostic', listModels: () => [], listEfforts: () => [], defaultModel: () => '', defaultEffort: () => '' },
      isInstalled: () => true,
      authStatus: async options => {
        calls++; entered = true; await gate;
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
        exited = once(child, 'exit'); await once(child, 'spawn');
        const identity = { pid: child.pid, pgid: child.pid, birthMarker: processBirthMarker(child.pid) };
        const handle = { processIdentity: identity, isAlive: () => child.exitCode === null && child.signalCode === null,
          close: async () => { if (handle.isAlive()) process.kill(-child.pid, 'SIGTERM'); await exited; } };
        options.onRuntimeSpawned(handle);
        return { authenticated: true };
      },
    }] });
    await app.ready();
    const request = app.inject({ url: '/api/engines' });
    await until(() => entered, 'owned diagnostic entered'); await request;
    app.prepareForShutdown(); let finished = false;
    const closing = app.close().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(finished, false, 'Storage must remain owned while diagnostic admission or spawning is pending');
    release(); await closing;
    assert.equal(calls, phase === 'before-probe' ? 0 : 1);
    if (child) assert.ok(child.exitCode !== null || child.signalCode !== null, 'Late registered diagnostic survived shutdown');
  } finally {
    release(); ProviderProcessAuthority.prototype.terminatePurpose = original;
    if (child && child.exitCode === null && child.signalCode === null) { process.kill(-child.pid, 'SIGTERM'); await exited; }
    await app?.close(); await rm(root, { recursive: true, force: true });
  }
});

import { canonicalProviderFailureEvent } from '../../apps/server/dist/provider-failure-event.js';
import { redactPortableDiagnostic } from '../../apps/server/dist/portable-secrets.js';

const marker = 'HARMLESS_CAUSE_14_19_BROKEN_WIDGET_731';
const secret = 'SYNTHETIC_CREDENTIAL_731';
const cause = `${marker} transport rejected widget 731; 日本語 café 🦄; api_key=${secret}`;

test('canonical diagnostics retain Unicode/cause, redact shared known fields and refuse uninspectable text explicitly', () => {
  for (const text of [cause, `${marker} Authorization: Bearer ${secret}`, `${marker} OPENAI_API_KEY="${secret}"`,
    `${marker} credentials={"nested": ["${secret}"]}`, JSON.stringify({ marker, env: JSON.stringify({ ANTHROPIC_API_KEY: secret }) }),
    `${marker} env=${JSON.stringify(JSON.stringify({ api_key: secret }))}`, `${marker} https://example.invalid/?api_key=${secret}`]) {
    const event = canonicalProviderFailureEvent({ type: 'error', message: text, code: 'provider_error' });
    assert.equal(event.category, 'unknown'); assert.ok(event.message.startsWith('Provider execution failed.\n'));
    assert.ok(event.message.includes(marker)); assert.ok(!event.message.includes(secret), event.message);
    assert.equal(canonicalProviderFailureEvent(event).message, event.message);
  }
  assert.match(canonicalProviderFailureEvent({ type:'error', message:cause }).message, /日本語 café 🦄/);
  assert.match(redactPortableDiagnostic('a'.repeat(4*1024*1024+1)), /omitted.*limit/);
  assert.match(redactPortableDiagnostic(JSON.stringify(JSON.stringify('['.repeat(100)+'0'+']'.repeat(100)))), /omitted.*limit/);
  const thrown = new ProviderRuntimeBoundaryError('controlled provider operation', new Error(cause));
  assert.ok(thrown.restrictedDetail.includes(marker)); assert.ok(!thrown.restrictedDetail.includes(secret));
  const root = projectProviderRootExitDetail({ stderr: cause, terminalEvent:{type:'error',message:cause} });
  assert.ok(root.terminalEvent.message.includes(marker)); assert.ok(!JSON.stringify(root).includes(secret));
});

test('unknown streamed cause survives canonical storage, bounded API and server reopen with no named credential on disk', {timeout:30000}, async t => {
  await withFixture(t, async f => {
    const chat=await f.createChat('Exact provider cause'),agent=await f.createIdleAgent(chat,'Controlled failure');
    const diagnostic=cause+'\n'+'長'.repeat(20000)+' END_OF_COMPLETE_DIAGNOSTIC';
    f.plans.set(agent.id,[{run:s=>s.events.push({type:'error',code:'provider_error',message:diagnostic})}]);
    await f.send(agent.id,'One controlled failure');
    await until(async()=>{const d=await f.detail(agent.id);return d.runs.length&&d.runs.every(r=>!['running','preparing'].includes(r.status))?d:false},'failed Run');
    const inspect = async () => {
      const detail=await f.detail(agent.id);
      const error=detail.activity.find(a=>a.event.type==='error');
      assert.equal(detail.runs[0].status,'failed'); assert.ok(error.event.message.includes(marker));
      assert.ok(error.event.message.includes('日本語 café 🦄'));
      assert.equal(error.event.message,canonicalProviderFailureEvent({type:'error',code:'provider_error',message:diagnostic}).message,'Complete validated diagnostic, including its tail, remains available');
      const page=f.ok(await f.api('GET',`/api/agents/${agent.id}/history/activity?limit=1`));
      assert.ok(JSON.stringify(page).includes(marker));
      for(const suffix of ['', '/history/runOutput','/history/activity','/history/runs','/runs','/history/workItems']) {
        const response=await f.api('GET','/api/agents/'+agent.id+suffix);assert.equal(response.status,200);
        assert.ok(!JSON.stringify(response).includes(secret));
      }
      assert.ok(!JSON.stringify(await f.api('GET','/api/conversations/'+chat.id)).includes(secret));
      return error;
    };
    const before=await inspect();
    let durable=false;
    const scan=async dir=>{for(const item of await readdir(dir,{withFileTypes:true})){
      const name=path.join(dir,item.name);if(item.isDirectory())await scan(name);else{
        const bytes=await readFile(name);assert.ok(!bytes.includes(Buffer.from(secret)),name);
        if(item.name==='events.jsonl'&&bytes.includes(Buffer.from(marker)))durable=true;
      }
    }};
    await scan(f.dataDir);assert.equal(durable,true,'canonical event journal must retain the cause');
    const count=f.turns.length;await f.reopen();const after=await inspect();assert.equal(after.event.message,before.event.message);
    assert.equal(f.turns.length,count,'inspection/reopen does not replay provider work');await scan(f.dataDir);
  });
});


test('embedded encoded credential spans share one recursive budget and preserve surrounding prose', () => {
  const prefix='HARMLESS_REVIEW_942 日本語 café 🦄 ',tail=' HARMLESS_EXACT_TAIL';
  const value='SYNTHETIC_SECRET_INDEPENDENT_942';
  for (const field of ['OPENAI_API_KEY','api_key']) {
    const encode=JSON.stringify;
    for (const body of [encode({[field]:value, safe:'雪'}),encode(encode({[field]:value,safe:'雪'})),
      encode(encode(encode({[field]:value,safe:'雪'}))),
      encode({message:'nested prose '+encode(encode({[field]:value})),safe:'雪'}),
      encode(encode(field+'='+value))]) {
      const input=prefix+body+tail,output=canonicalProviderFailureEvent({type:'error',code:'provider_error',message:input}).message;
      assert.ok(!output.includes(value),output);assert.ok(output.includes(prefix));assert.ok(output.endsWith(tail));
      assert.equal(canonicalProviderFailureEvent({type:'error',code:'provider_error',message:output}).message,output);
    }
    assert.equal(redactPortableDiagnostic(prefix+encode(encode({[field]:value,safe:'雪'}))+tail),prefix+encode(encode({safe:'雪'}))+tail);
  }
  const safe=prefix+JSON.stringify(JSON.stringify({safe:'雪'}))+tail;
  assert.equal(redactPortableDiagnostic(safe),safe,'Unchanged encoded span/prose retains exact bytes');
  const span=JSON.stringify(JSON.stringify(JSON.stringify({safe:'x'.repeat(500000)})));
  assert.equal(redactPortableDiagnostic(prefix+span+tail),prefix+span+tail,'One span is below the inspection budget');
  assert.match(redactPortableDiagnostic(prefix+Array(6).fill(span).join(' ')+tail),/omitted.*inspection limit/,'Separate spans cannot reset the shared budget');
  assert.match(redactPortableDiagnostic(prefix+'['.repeat(66)+'0'+']'.repeat(66)+tail),/omitted.*inspection limit/);
});

test('encoded known provider fields after prose stay absent from canonical storage/API after reopen', {timeout:30000}, async t => {
  await withFixture(t, async f => {
    const marker='HARMLESS_REVIEW_942',value='SYNTHETIC_SECRET_INDEPENDENT_942';
    const chat=await f.createChat('Embedded encoded provider cause'),agents=[];
    for(const field of ['OPENAI_API_KEY','api_key']) {
      const agent=await f.createIdleAgent(chat,'Controlled '+field),message=marker+' '+JSON.stringify(JSON.stringify({[field]:value}));
      f.plans.set(agent.id,[{run:s=>s.events.push({type:'error',code:'provider_error',message})}]);
      await f.send(agent.id,'Controlled error');
      await until(async()=>{const d=await f.detail(agent.id);return d.runs.length&&d.runs.every(r=>!['running','preparing'].includes(r.status))},'encoded terminal');
      agents.push(agent);
    }
    const inspect=async()=>{
      for(const agent of agents){
        const d=await f.detail(agent.id);const event=d.activity.find(row=>row.event.type==='error').event;
        assert.ok(event.message.includes(marker));assert.equal(event.message,'Provider execution failed.\n'+marker+' '+JSON.stringify(JSON.stringify({})));
        for(const suffix of ['', '/history/activity?limit=1','/history/runOutput','/history/runs','/runs','/history/workItems']){
          const response=await f.api('GET','/api/agents/'+agent.id+suffix);assert.equal(response.status,200);assert.ok(!JSON.stringify(response).includes(value));
        }
      }
      const response=await f.api('GET','/api/conversations/'+chat.id);assert.equal(response.status,200);assert.ok(!JSON.stringify(response).includes(value));
      let canonical=0,database=0;
      const scan=async dir=>{for(const item of await readdir(dir,{withFileTypes:true})){
        const filename=path.join(dir,item.name);if(item.isDirectory())await scan(filename);else{
          const bytes=await readFile(filename);assert.ok(!bytes.includes(Buffer.from(value)),filename);
          if(item.name==='events.jsonl'&&bytes.includes(Buffer.from(marker)))canonical++;
          if(/\.(?:db|sqlite)(?:-wal)?$/.test(item.name))database++;
        }
      }};
      await scan(f.dataDir);assert.equal(canonical,2);assert.ok(database>0,'Scan includes real SQLite/WAL files');
    };
    await inspect();const turns=f.turns.length;await f.reopen();await inspect();assert.equal(f.turns.length,turns,'No provider replay');
  });
});


test('malformed encoded known assignments redact finite truncation/escape/nesting matrix without losing safe prose', () => {
  const prefix='HARMLESS_MALFORMED_CAUSE 日本語 café 🦄 ',tail=' HARMLESS_EXACT_TAIL';
  const value='SYNTHETIC_MALFORMED_942';
  let cases=0;
  for(const field of ['OPENAI_API_KEY','api_key']) for(let layers=1;layers<=5;layers++) {
    let body=JSON.stringify({[field]:value,safe:'雪'});
    for(let i=1;i<layers;i++)body=JSON.stringify(body);
    const variants=[body.slice(0,-1),body.slice(0,-2),"'"+body.slice(1,-1)+"'",'{bad,'+body,'['+body];
    for(const malformed of variants) {
      const input=prefix+malformed+tail,output=redactPortableDiagnostic(input);
      assert.ok(!output.includes(value),JSON.stringify({layers,malformed,output}));
      assert.ok(output.startsWith(prefix));assert.ok(output.endsWith(tail));
      assert.equal(redactPortableDiagnostic(output),output);cases++;
    }
    const safe=prefix+JSON.stringify(JSON.stringify({safe:'雪'})).slice(0,-1)+tail;
    assert.equal(redactPortableDiagnostic(safe),safe,'Harmless malformed text is unchanged');
  }
  assert.equal(cases,50);
  for(const field of ['OPENAI_API_KEY','api_key']) {
    const broken='cause \\"'+field+'\\": \\"'+value;
    const output=redactPortableDiagnostic(broken);
    assert.ok(!output.includes(value));assert.match(output,/omitted: unterminated credential value/);
  }
});

test('malformed encoded known provider fields after prose stay absent from canonical storage/API after reopen', {timeout:30000}, async t => {
  await withFixture(t, async f => {
    const marker='HARMLESS_REVIEW_942',value='SYNTHETIC_SECRET_INDEPENDENT_942';
    const chat=await f.createChat('Embedded encoded provider cause'),agents=[];
    for(const field of ['OPENAI_API_KEY','api_key']) {
      const agent=await f.createIdleAgent(chat,'Controlled '+field),message=marker+' '+JSON.stringify(JSON.stringify({[field]:value})).slice(0,-1)+' 日本語 🦄 HARMLESS_EXACT_TAIL';
      f.plans.set(agent.id,[{run:s=>s.events.push({type:'error',code:'provider_error',message})}]);
      await f.send(agent.id,'Controlled error');
      await until(async()=>{const d=await f.detail(agent.id);return d.runs.length&&d.runs.every(r=>!['running','preparing'].includes(r.status))},'encoded terminal');
      agents.push(agent);
    }
    const inspect=async()=>{
      for(const agent of agents){
        const d=await f.detail(agent.id);const event=d.activity.find(row=>row.event.type==='error').event;
        assert.ok(event.message.includes(marker));assert.ok(event.message.endsWith(' 日本語 🦄 HARMLESS_EXACT_TAIL'));assert.ok(!event.message.includes(value));
        for(const suffix of ['', '/history/activity?limit=1','/history/runOutput','/history/runs','/runs','/history/workItems']){
          const response=await f.api('GET','/api/agents/'+agent.id+suffix);assert.equal(response.status,200);assert.ok(!JSON.stringify(response).includes(value));
        }
      }
      const response=await f.api('GET','/api/conversations/'+chat.id);assert.equal(response.status,200);assert.ok(!JSON.stringify(response).includes(value));
      let canonical=0,database=0;
      const scan=async dir=>{for(const item of await readdir(dir,{withFileTypes:true})){
        const filename=path.join(dir,item.name);if(item.isDirectory())await scan(filename);else{
          const bytes=await readFile(filename);assert.ok(!bytes.includes(Buffer.from(value)),filename);
          if(item.name==='events.jsonl'&&bytes.includes(Buffer.from(marker)))canonical++;
          if(/\.(?:db|sqlite)(?:-wal)?$/.test(item.name))database++;
        }
      }};
      await scan(f.dataDir);assert.equal(canonical,2);assert.ok(database>0,'Scan includes real SQLite/WAL files');
    };
    await inspect();const turns=f.turns.length;await f.reopen();await inspect();assert.equal(f.turns.length,turns,'No provider replay');
  });
});

import { parseCodexLoginStatus, claudeAuthStatus } from '../../packages/engines/dist/auth.js';
import { projectProviderAuthStatus } from '../../apps/server/dist/provider-success-projection.js';

test('Bible25 configured API and subscription status is truthful and never returns key/token output', async () => {
  for (const [text, mode] of [
    ['Logged in using ChatGPT', 'subscription'],
    ['Logged in using an API key - SYNTHETIC_PRIVATE_KEY', 'api'],
    ['Authenticated with access token: SYNTHETIC_PRIVATE_KEY', 'api'],
  ]) {
    const status = projectProviderAuthStatus(parseCodexLoginStatus(text));
    assert.equal(status.authenticated, true); assert.equal(status.billingMode, mode);
    assert.doesNotMatch(JSON.stringify(status), /SYNTHETIC_PRIVATE_KEY/);
  }
  for (const text of ['not authenticated with API key', 'API key rejected', 'No access token', 'Error: logged in using an API key', 'Error: logged in using ChatGPT', 'ChatGPT authenticated but access rejected', 'Logged in using ChatGPT\nAuthentication failed', '']) {
    const status = parseCodexLoginStatus(text);
    assert.equal(status.authenticated, false); assert.equal(status.status, 'unknown');
  }
  // The native CLI owns precedence. A configured environment key alone is
  // neither authenticated-mode evidence nor a reason to bypass its status.
  const dir = await mkdtemp(path.join(tmpdir(), 'ponderosa-native-auth-'));
  const bin = path.join(dir, 'claude');
  try {
    await writeFile(bin, '#!' + process.execPath + '\n' +
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["auth", "status"])) process.exit(9);\n' +
      'process.stdout.write(JSON.stringify({loggedIn:true,authMethod:"oauth_token",email:"SYNTHETIC_PRIVATE_ID"}));\n');
    await chmod(bin, 0o700);
    const status = await claudeAuthStatus({ PONDEROSA_CLAUDE_BIN: bin,
      ANTHROPIC_API_KEY: 'SYNTHETIC_PRIVATE_KEY', CLAUDE_CODE_OAUTH_TOKEN: 'SYNTHETIC_OTHER_TOKEN' });
    assert.equal(status.authenticated, true); assert.equal(status.billingMode, 'subscription');
    assert.equal(status.source, 'cli_status');
    assert.doesNotMatch(JSON.stringify(projectProviderAuthStatus(status)), /SYNTHETIC_PRIVATE/);
    assert.throws(() => projectProviderAuthStatus({ authenticated: true, billingMode: 'SYNTHETIC_PRIVATE_KEY' }));
    await writeFile(bin, '#!' + process.execPath + '\nprocess.stdout.write(JSON.stringify({loggedIn:false,authMethod:"none"})); process.exitCode=1;\n');
    const signedOut = await claudeAuthStatus({ PONDEROSA_CLAUDE_BIN: bin, ANTHROPIC_API_KEY: 'SYNTHETIC_PRIVATE_KEY' });
    assert.equal(signedOut.authenticated, false); assert.equal(signedOut.status, undefined);
    assert.equal(signedOut.billingMode, undefined); assert.match(signedOut.detail, /sign in/);
  } finally { await rm(dir, { recursive: true, force: true }); }

});

test('Bible25 native authentication needs no billing selection and preserves Agent identity/history/settings', { timeout: 30000 }, t => {
  let mode = 'subscription';
  let validations = 0;
  return withFixture(t, async f => {
    const chat = await f.createChat('Native authentication preservation');
    const agent = await f.createAgent(chat, 'Persistent native-auth Agent');
    const before = await f.detail(agent.id);
    const beforeHistory = before.messages;
    assert.ok(beforeHistory.length > 0, 'Preservation requires populated history');
    const preferences = f.ok(await f.api('GET', '/api/workspace/preferences'));
    for (const selection of [{ codex: 'api' }, { codex: 'subscription' }, {}, null]) {
      assert.equal((await f.api('PATCH', '/api/workspace/preferences', { providerBillingModes: selection })).status, 400);
    }
    for (const nativeMode of ['api', 'subscription']) {
      const beforeObservation = await f.detail(agent.id);
      const turnsBeforeObservation = f.turns.length;
      mode = nativeMode;
      await f.reopen();
      const [ready] = f.ok(await f.api('GET', '/api/engines'));
      assert.equal(ready.billingMode, nativeMode);
      assert.equal(ready.authentication, 'authenticated');
      assert.equal(ready.intakeReady, true);
      assert.equal(Object.hasOwn(ready, 'selectedBillingMode'), false);
      assert.equal(Object.hasOwn(ready, 'billingModeMatches'), false);
      assert.equal(f.ok(await f.api('GET', '/api/workspace/preferences')).providerBillingModes, undefined);
      f.ok(await f.api('POST', '/api/engines/codex/recheck'));
      const validation = f.ok(await f.api('POST', '/api/projects/' + chat.projectId + '/engine-models/codex/validate', { modelId: 'fixture' }));
      assert.equal(validation.valid, true);
      assert.deepEqual((await f.detail(agent.id)).agent, beforeObservation.agent);
      assert.deepEqual(f.ok(await f.api('GET', '/api/workspace/preferences')), preferences);
      assert.equal(f.turns.length, turnsBeforeObservation, 'Authentication observation must not execute or replay work');
      const previous = await f.detail(agent.id);
      const previousSession = f.turns.at(-1).sessionId;
      await f.send(agent.id, 'Controlled native ' + nativeMode + ' successor');
      const done = await f.settled(agent.id, previous.runs.map(run => run.id));
      assert.equal(done.agent.id, before.agent.id);
      assert.equal(done.agent.title, before.agent.title);
      assert.equal(done.agent.model, before.agent.model);
      assert.equal(done.agent.activeEngine, before.agent.activeEngine);
      assert.notEqual(f.turns.at(-1).sessionId, previousSession, 'Observed mode change must retire the previous native session');
      for (const message of beforeHistory) assert.deepEqual(done.messages.find(item => item.id === message.id), message);
      assert.match(JSON.stringify(done.messages), new RegExp('Controlled native ' + nativeMode + ' successor'));
    }
    assert.equal(validations, 2);
    assert.equal(f.providerProbes.length, 2);
  }, {
    modelValidator: async () => { validations++; return { valid: true, model: { id: 'fixture', label: 'Fixture', kind: 'alias', source: 'provider-probe' } }; },
    providerAuthStatus: () => ({ authenticated: true, billingMode: mode, source: 'cli_status' }),
  });
});

test('Bible25 selector-removal compatibility accepts only the exact unchanged native contract', async () => {
  const { createHash } = await import('node:crypto');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const input = { runtimeSessionContractHash: 'provider-model-tools', speed: 'standard', billingMode: 'api',
    systemPromptHash: 'instructions', scopeKey: 'scope' };
  const old = digest({ runtimeSessionContractHash: input.runtimeSessionContractHash, speed: input.speed,
    expectedBillingMode: 'api', billingMode: 'api', systemPromptHash: input.systemPromptHash, scopeKey: input.scopeKey });
  assert.equal(providerRuntimeSessionContractHash(input, old), old);
  assert.notEqual(providerRuntimeSessionContractHash(input), old, 'New sessions must omit the obsolete selector');
  for (const change of [
    { billingMode: 'subscription' }, { billingMode: undefined }, { speed: 'fast' },
    { runtimeSessionContractHash: 'changed-provider-model-tools-or-permissions' },
    { systemPromptHash: 'changed-instructions' }, { scopeKey: 'other-scope' },
  ]) {
    assert.notEqual(providerRuntimeSessionContractHash({ ...input, ...change }, old), old);
  }
  const mismatchedSelection = digest({ runtimeSessionContractHash: input.runtimeSessionContractHash, speed: input.speed,
    expectedBillingMode: 'subscription', billingMode: 'api', systemPromptHash: input.systemPromptHash, scopeKey: input.scopeKey });
  assert.notEqual(providerRuntimeSessionContractHash(input, mismatchedSelection), mismatchedSelection);
  assert.equal(providerRuntimeSessionContractHash(input, 'unknown-old-hash'), providerRuntimeSessionContractHash(input));
});

for (const mode of ['api', 'subscription']) test('Bible25 removing the selector resumes the existing ' + mode + ' native generation without reseeding', { timeout: 30000 }, async t => {
  const { AgentStore } = await import('@ponderosa/agents');
  const { createHash } = await import('node:crypto');
  const { PONDEROSA_HISTORY_TOOL } = await import('@ponderosa/core');
  let store;
  await withFixture(t, async f => {
    const chat = await f.createChat('Selector removal continuity');
    const agent = await f.createAgent(chat, 'Retained native generation');
    const before = await f.detail(agent.id);
    const retained = store.resumeSessionState(agent.id);
    const packet = store.acceptedProviderSessionInput(agent.id);
    const contract = packet.sourceManifest.normalRuntimeContract;
    // Stored JSON canonicalizes key order; hash the original runtime definitions.
    const originalTools = [...providerDynamicTools(), PONDEROSA_HISTORY_TOOL];
    assert.deepEqual(contract.dynamicTools, originalTools);
    const tools = providerToolContractHash(originalTools, communicationV3SessionPrompt());
    assert.equal(contract.capabilityRestrictions?.restrictedCapabilityIds.length ?? 0, 0);
    const input = {
      runtimeSessionContractHash: providerSessionContractHash(contract.engineId, contract.workingCopyId, contract.model, contract.effort, tools),
      speed: contract.speed, billingMode: mode, systemPromptHash: packet.systemPromptHash,
      scopeKey: store.sqlite.prepare('SELECT scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(packet.schedulerRunId, agent.id).scope_key,
    };
    assert.equal(providerRuntimeSessionContractHash(input), retained.toolContractHash, 'Fixture must reconstruct the exact complete current contract');
    const old = createHash('sha256').update(JSON.stringify({
      runtimeSessionContractHash: input.runtimeSessionContractHash, speed: input.speed,
      expectedBillingMode: mode, billingMode: mode, systemPromptHash: input.systemPromptHash, scopeKey: input.scopeKey,
    })).digest('hex');
    // Model the persisted pre-removal compatibility representation, preserving
    // its exact session, accepted Run, context and artifacts.
    store.appendEvent(agent.id, { type: 'session_snapshot', sessionId: retained.sessionId,
      executionId: packet.executionId, toolContractHash: old, artifactIds: retained.artifactIds });
    await f.reopen();
    await f.send(agent.id, 'Continue the retained native context');
    const after = await f.settled(agent.id, before.runs.map(run => run.id));
    const turn = f.turns.at(-1);
    assert.equal(turn.sessionId, retained.sessionId, 'Selector removal must resume the same native generation');
    assert.deepEqual(turn.history, [], 'A retained generation must receive no replacement seed');
    assert.equal(store.resumeSessionState(agent.id).toolContractHash, old);
    assert.equal(after.agent.id, before.agent.id);
    for (const message of before.messages) assert.deepEqual(after.messages.find(item => item.id === message.id), message);
  }, { storeFactory: dataDir => (store = new AgentStore(dataDir)),
    providerAuthStatus: () => ({ authenticated: true, billingMode: mode, source: 'cli_status' }) });
});

test('Bible25 both native harness probe launches preserve configured modes without putting credentials in argv or results', async () => {
  const { codexAvailabilityStatus, claudeAvailabilityStatus } = await import('../../packages/engines/dist/auth.js');
  for (const mode of ['api', 'subscription']) {
    for (const provider of ['codex', 'claude']) {
      const env = provider === 'claude' && mode === 'api' ? { ANTHROPIC_API_KEY: 'SYNTHETIC_NATIVE_KEY' } : {};
      const probe = provider === 'codex' ? codexAvailabilityStatus : claudeAvailabilityStatus;
      let calls = 0;
      const result = await probe(env, async (_bin, args, options) => {
        calls++;
        assert.doesNotMatch(JSON.stringify(args), /SYNTHETIC_NATIVE_KEY/);
        if (provider === 'claude' && mode === 'api') assert.equal(options.env.ANTHROPIC_API_KEY, 'SYNTHETIC_NATIVE_KEY');
        assert.equal(options.env.PONDEROSA_LAUNCHER_CONTROL_TOKEN, undefined);
        return { stderr: '', stdout: provider === 'claude'
          ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONDEROSA_RUNTIME_READY' })
          : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PONDEROSA_RUNTIME_READY' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) };
      }, async () => ({ authenticated: true, billingMode: mode, source: 'cli_status' }));
      assert.equal(calls, 1); assert.equal(result.available, true);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_NATIVE_KEY|subscription-backed/);
    }
  }
});


import { StderrTail } from '../../packages/engines/dist/stderr-tail.js';
import { PROVIDER_STDERR_DETAIL_LIMIT } from '@ponderosa/core';
for (const size of [8193, 20000]) test(`formatted stderr ${size} survives actual server root-exit projection`, () => {
 const tail = new StderrTail();
 const cause = ' final cause api_key=SYNTHETIC_TAIL_SECRET';
 tail.append('x'.repeat(size - cause.length) + cause);
 const detail = projectProviderRootExitDetail({stderr:tail.text(),exitCode:7,signal:'SIGTERM',outputDraining:true});
 assert.equal(detail.exitCode,7); assert.equal(detail.signal,'SIGTERM'); assert.equal(detail.outputDraining,true);
 assert.match(detail.stderr,new RegExp(`^\\[stderr truncated: ${size - 8192} UTF-16 code units omitted; retained tail follows\\]\\n`));
 assert.match(detail.stderr,/final cause/); assert.doesNotMatch(detail.stderr,/SYNTHETIC_TAIL_SECRET/);
 assert.ok(tail.text().length <= PROVIDER_STDERR_DETAIL_LIMIT);
});
test('Unicode cut and cumulative omission survive actual server root-exit projection', () => {
 const tail = new StderrTail();
 tail.append('ab😀' + 'x'.repeat(8191));
 let detail = projectProviderRootExitDetail({stderr:tail.text(),exitCode:2,signal:null});
 assert.match(detail.stderr,/^\[stderr truncated: 4 UTF-16 code units omitted; retained tail follows\]\nx/u);
 assert.doesNotMatch(detail.stderr,/[\uD800-\uDFFF]/u);
 tail.append('last cause');
 detail = projectProviderRootExitDetail({stderr:tail.text(),exitCode:2,signal:null});
 assert.match(detail.stderr,/^\[stderr truncated: 13 UTF-16 code units omitted;/u);
 assert.ok(detail.stderr.endsWith('last cause')); assert.equal(detail.exitCode,2); assert.equal(detail.signal,null);
});
test('root-exit diagnostic bound still rejects invalid provider data', () => {
 assert.doesNotThrow(()=>projectProviderRootExitDetail({stderr:'x'.repeat(PROVIDER_STDERR_DETAIL_LIMIT)}));
 for(const stderr of ['x'.repeat(PROVIDER_STDERR_DETAIL_LIMIT+1),42,null,{}]) {
  assert.throws(()=>projectProviderRootExitDetail({stderr,exitCode:7}));
 }
 assert.throws(()=>projectProviderRootExitDetail({stderr:'valid',exitCode:1.5}));
});

test('native availability holds unresolved auth cleanup and cancellation before any model request', async () => {
  const { codexAvailabilityStatus, claudeAvailabilityStatus } = await import('../../packages/engines/dist/auth.js');
  for (const probe of [codexAvailabilityStatus, claudeAvailabilityStatus]) {
    let calls = 0;
    const run = async () => { calls++; throw Error('No provider request should be started'); };
    const held = await probe({}, run, async () => ({ authenticated: true, diagnosticFailure: 'cleanup_failed' }));
    assert.equal(held.available, false); assert.equal(held.failureCategory, 'unavailable');
    assert.match(held.detail, /cleanup.*unconfirmed/);
    const controller = new AbortController();
    await assert.rejects(() => probe({}, run, async () => {
      controller.abort(); return { authenticated: true };
    }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
  }
});

test('direct Codex availability passes cancellation and exact spawned-process ownership to native auth', async () => {
  const { codexAvailabilityStatus } = await import('../../packages/engines/dist/auth.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'ponderosa-native-auth-cancel-'));
  const bin = path.join(dir, 'codex');
  const controller = new AbortController();
  let spawned = 0, modelRequests = 0;
  try {
    await writeFile(bin, '#!' + process.execPath + '\nsetInterval(() => {}, 1000);\n');
    await chmod(bin, 0o700);
    await assert.rejects(() => codexAvailabilityStatus({ PONDEROSA_CODEX_BIN: bin },
      async () => { modelRequests++; throw Error('Unexpected model request'); }, undefined, {
        signal: controller.signal,
        onRuntimeSpawned: () => { spawned++; controller.abort(); },
      }), { name: 'AbortError' });
    assert.equal(spawned, 1); assert.equal(modelRequests, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime question guidance permits the native bridge without duplicating questions or granting permissions',async()=>{
  const { communicationV3SessionPrompt }=await import('../../apps/server/dist/runtime-selection.js');
  const prompt=communicationV3SessionPrompt().join('\n');
  assert.match(prompt,/Supported provider-native AskUserQuestion\/request_user_input callbacks also reach the human/);
  assert.match(prompt,/do not ask the same question twice/);
  assert.match(prompt,/Questions never grant permissions/);
  assert.doesNotMatch(prompt,/only user-question path|never call a provider-native AskUserQuestion/);
});
