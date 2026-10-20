import test from 'node:test';
import assert from 'node:assert/strict';
import { publicProviderFailureEvent, providerRecoveryDelay, MAX_PROVIDER_RECOVERY_ATTEMPTS } from '@ponderosa/core';
import { mapCodexAppServerNotification, formatCodexRateLimits } from '../../packages/engines/dist/codex-app-server.js';
import { normalizeCodexProviderUsage } from '../../packages/engines/dist/provider-usage.js';
import { normalizeCodexProviderDiscovery } from '../../packages/engines/dist/capabilities.js';
import { CodexAdapter } from '../../packages/engines/dist/codex.js';
import { openCurrentMemoryDatabase } from '../../packages/agents/dist/state-admission.js';
import { CoordinationV3Store } from '../../packages/agents/dist/coordination-v3-store.js';
import { CoordinationV3ActivationFactory } from '../../packages/agents/dist/coordination-v3-activation-factory.js';
import { providerRecoveryAttempts } from '../../packages/agents/dist/coordination-v3-provider-recovery.js';
import { runtimeSelectionError, chatCreationRuntimeSelection } from '../../apps/server/dist/runtime-selection.js';

const upgrade = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error',
  message: "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } });

test('Codex structured errors retain actionable guidance, status and bounded delays without exposing provider prose', () => {
  for (const [error, category, code] of [
    [{ message: upgrade, codexErrorInfo: 'other' }, 'invalid_request', 'client_upgrade_required'],
    [{ message: upgrade, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } }, 'invalid_request', 'client_upgrade_required'],
    [{ message: 'private-fixture-detail', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, retryAfterMs: 9000 }, 'rate_limit', 'rate_limit'],
    [{ message: 'private-fixture-detail', codexErrorInfo: 'contextWindowExceeded' }, 'context_length', 'context_length'],
    [{ message: 'private-fixture-detail', codexErrorInfo: 'unauthorized' }, 'authentication', 'authentication_failed'],
    [{ message: 'private-fixture-detail', codexErrorInfo: 'badRequest' }, 'invalid_request', 'invalid_request'],
  ]) {
    const [mapped] = mapCodexAppServerNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error } } }, process.cwd());
    const visible = publicProviderFailureEvent(mapped);
    assert.equal(visible.category, category); assert.equal(visible.code, code); assert.equal(visible.terminalStatus, 'failed');
    assert.doesNotMatch(JSON.stringify(visible), /private-fixture-detail|requires a newer version/u);
    if (code === 'client_upgrade_required') { assert.match(visible.message, /CLI needs an update/u); assert.match(visible.remediation, /Update the provider CLI/u); assert.equal(visible.httpStatusCode, 400); }
    if (error.retryAfterMs) { assert.equal(visible.retryAfterMs, 9000); assert.equal(visible.httpStatusCode, 429); }
  }
  const [unknown] = mapCodexAppServerNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: '{"message":"private-fixture-detail HTTP 429"}' } } } }, process.cwd());
  assert.equal(publicProviderFailureEvent(unknown).category, 'unknown');
});

test('one recovery policy stops permanent failures and bounds temporary recovery with provider delays', () => {
  for (const category of ['authentication', 'invalid_request', 'context_length']) assert.equal(providerRecoveryDelay(category, 1), null);
  for (const category of ['rate_limit', 'capacity', 'unavailable']) {
    let prior = 0;
    for (let attempt = 1; attempt < MAX_PROVIDER_RECOVERY_ATTEMPTS; attempt++) {
      const delay = providerRecoveryDelay(category, attempt);
      assert.ok(delay >= 2000 * 2 ** (attempt - 1)); assert.ok(delay > prior); prior = delay;
    }
    assert.equal(providerRecoveryDelay(category, MAX_PROVIDER_RECOVERY_ATTEMPTS), null);
    assert.ok(providerRecoveryDelay(category, 1, true, 9000) >= 9000);
  }
  assert.equal(providerRecoveryDelay('unknown', 1, false), null);
  assert.equal(providerRecoveryDelay('rate_limit', NaN), null);
});

test('usage accepts legacy protocol and gives modern buckets priority without duplicates', () => {
  const primary = { usedPercent: 31, windowDurationMins: 300, resetsAt: 2000000000 };
  const legacy = { rateLimits: { primary } };
  assert.equal(normalizeCodexProviderUsage({}, legacy).windows[0].usedPercent, 31);
  assert.equal(formatCodexRateLimits(legacy).length, 1);
  const modern = { ...legacy, rateLimitsByLimitId: { codex: { primary: { ...primary, usedPercent: 72 } } } };
  const result = normalizeCodexProviderUsage({}, modern);
  assert.equal(result.windows.length, 1); assert.equal(result.windows[0].usedPercent, 72);
  assert.doesNotMatch(formatCodexRateLimits(modern).join(' '), /exhaust|limit reached/iu);
});

test('executing-client roster replaces foreign cache choices and retains model defaults, efforts and tiers', () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.listModels().some(m => m.id === 'gpt-5.6-sol'), false);
  const live = normalizeCodexProviderDiscovery({ cwd: process.cwd(), cliVersion: '0.143.0', models: { data: [
    { id: 'gpt-5.4', model: 'gpt-5.4', displayName: '5.4', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' },
    { id: 'gpt-5.5', model: 'gpt-5.5', displayName: '5.5', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', serviceTiers: [{ id: 'fast', name: 'Fast' }] },
  ] } }).modelCatalog;
  assert.equal(live.cliVersion, '0.143.0'); assert.equal(live.models[0].id, 'gpt-5.5');
  assert.equal(live.models[0].isDefault, true);
  assert.equal(live.models[0].defaultEffort, 'high'); assert.equal(live.models[0].serviceTiers[0].id, 'fast');
  const foreign = { ...adapter, listModels: () => [{ id: 'gpt-5.6-sol', label: 'Foreign cached choice' }], listEfforts: () => [], modelSpecificEfforts: true };
  assert.match(runtimeSelectionError(foreign, 'gpt-5.6-sol', undefined, live.models), /not available/u);
  assert.match(runtimeSelectionError(foreign, 'gpt-5.6-sol', undefined, []), /not available/u);
  const created = chatCreationRuntimeSelection(foreign, {}, undefined, live.models);
  assert.equal(created.model, 'gpt-5.5'); assert.equal(created.effort, 'high'); assert.equal(created.error, undefined);
  assert.equal(normalizeCodexProviderDiscovery({ cwd: process.cwd(), models: { data: [{}] } }).modelCatalog, undefined);
  const claude = { listModels: () => [], listEfforts: () => [{ id: 'medium', label: 'Medium' }], defaultModel: () => 'sonnet' };
  assert.equal(chatCreationRuntimeSelection(claude, {}, undefined, ['opus', 'sonnet'].map(id => ({ id, label: id }))).model, 'sonnet');
});

function memoryRecovery(t) {
  const db = openCurrentMemoryDatabase(); t.after(() => db.close());
  const now = new Date(Date.now() + 60_000).toISOString();
  db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES (?,?,?,?)').run('project', 'Controlled', '/fixture', now);
  db.prepare('INSERT INTO agents(id,project_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES (?,?,?,?,?,?,?,?)')
    .run('agent', 'project', 'Controlled', 'Controlled', 'codex', now, now, '{}');
  const factory = new CoordinationV3ActivationFactory(db, {});
  db.prepare('INSERT INTO runtime_communications(id,project_id,sender_json,intent,audience_json,payload_json,payload_hash,actionable,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('communication', 'project', '{"kind":"user","userId":"local-operator"}', 'user_dm', '{"kind":"user_agent","userId":"local-operator","agentId":"agent"}', '{}', 'fixture', 1, now);
  const root = factory.create({ projectId: 'project', agentId: 'agent', scopeKey: 'agent:agent', kind: 'human_message', priority: 100,
    dedupeKey: 'fixture-root', dispatchPolicy: 'next_run', promptClass: 'human', payload: { replyAuthority: { intent: 'direct_to_user' } },
    sourceKind: 'communication', sourceId: 'communication', now });
  let store = new CoordinationV3Store(db);
  const restart = () => { store = new CoordinationV3Store(db); return store; };
  const lease = time => store.leaseNextRun({ workerId: 'worker', now: time });
  const fail = (run, time, accepted, category, extra = {}) => {
    store.markRunStarted(run.runId, run.fencingToken, time);
    if (accepted) {
      store.preparePromptInjection({ injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken, prompt: "Controlled provider input", now: time });
      store.markPromptSubmitted({ injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken, now: time });
      store.acknowledgePromptInjection({ injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken, now: time });
    }
    return store.failRun({ runId: run.runId, fencingToken: run.fencingToken, workerId: 'worker', sameRunResumable: false,
      failureKind: category, now: time, ...extra });
  };
  return { db, now, root, restart, lease, fail, store: () => store };
}

for (const phase of ['mixed', 'preaccept', 'accepted', 'reversed']) for (const category of ['rate_limit', 'capacity', 'unavailable']) test(`durable six-attempt budget: ${category}, ${phase}`, t => {
  const f = memoryRecovery(t); let time = f.now;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const run = f.lease(time); assert.ok(run, `Attempt ${attempt} missing`);
    assert.equal(providerRecoveryAttempts(f.db, run.runId, run.activationIds[0]), attempt);
    f.fail(run, time, phase === 'accepted' || (phase === 'mixed' && attempt % 2 === 0) || (phase === 'reversed' && attempt % 2 === 1), category);
    assert.equal(JSON.parse(f.db.prepare('SELECT provider_failure_json FROM scheduler_runs WHERE id=?').get(run.runId).provider_failure_json).category, category);
    const pending = f.db.prepare("SELECT id,available_at FROM agent_activations WHERE state IN ('pending','retry_pending')").all();
    if (attempt === 6) { assert.equal(pending.length, 0); break; }
    assert.equal(pending.length, 1);
    assert.ok(Date.parse(pending[0].available_at) >= Date.parse(time) + 2000 * 2 ** (attempt - 1));
    assert.equal(f.lease(new Date(Date.parse(pending[0].available_at) - 1).toISOString()), undefined);
    f.restart();
    assert.equal(f.db.prepare('SELECT available_at FROM agent_activations WHERE id=?').get(pending[0].id).available_at, pending[0].available_at);
    time = pending[0].available_at;
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n, 6);
  const root = f.db.prepare('SELECT state,terminal_outcome FROM agent_activations WHERE id=?').get(f.root);
  assert.equal(root.terminal_outcome, 'retry_exhausted');
  const [receipt] = f.store().deliveryReceiptsForCommunication('project', 'communication');
  assert.equal(receipt.attemptCount, 6); assert.equal(receipt.state, 'retry_exhausted');
});

for (const accepted of [false, true]) for (const category of ['authentication', 'invalid_request', 'context_length']) test(`permanent ${category}, accepted=${accepted}, holds work and permits one explicit retry`, t => {
  const f = memoryRecovery(t), run = f.lease(f.now); assert.ok(run);
  f.fail(run, f.now, accepted, category);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM agent_activations WHERE state IN ('pending','retry_pending')").get().n, 0);
  assert.equal(f.db.prepare('SELECT terminal_outcome FROM agent_activations WHERE id=?').get(f.root).terminal_outcome, 'permanent_failure');
  const receipts = f.store().deliveryReceiptsForCommunication('project', 'communication');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].state, accepted ? 'run_unconfirmed' : 'failed');
  assert.equal(receipts[0].canRetry, true); assert.equal(Boolean(receipts[0].retryMayDuplicate), accepted);
  const retry = f.store().retryMessageDelivery({ projectId: 'project', activationId: f.root, idempotencyKey: 'explicit-retry', now: f.now });
  assert.equal(retry.accepted, true, JSON.stringify(retry));
  assert.equal(f.store().retryMessageDelivery({ projectId: 'project', activationId: f.root, idempotencyKey: 'explicit-retry', now: f.now }).replayed, true);
  const next = f.lease(f.now); assert.ok(next);
  assert.equal(providerRecoveryAttempts(f.db, next.runId, next.activationIds[0]), 1);
});

test('missing-reply recovery still works for successful silent turns and stops after six without a timer loop', t => {
  const f = memoryRecovery(t); let time = f.now;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const run = f.lease(time); assert.ok(run);
    f.store().markRunStarted(run.runId, run.fencingToken, time);
    f.store().preparePromptInjection({ injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken, prompt: "Controlled provider input", now: time });
    f.store().markPromptSubmitted({ injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken, now: time });
    f.store().acknowledgePromptInjection({ injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken, now: time });
    f.store().completeRun(run.runId, run.fencingToken, time);
    const pending = f.db.prepare("SELECT available_at FROM agent_activations WHERE state IN ('pending','retry_pending')").all();
    if (attempt < 6) { assert.equal(pending.length, 1); time = pending[0].available_at; }
    else assert.equal(pending.length, 0);
  }
});

import { withFixture } from '../shared/fixture.mjs';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverCodexAppServerCapabilities } from '../../packages/engines/dist/codex-app-server.js';

const catalog = (id, effort = 'high') => ({ models: [{ id, label: id, kind: 'alias', source: 'provider-probe',
  efforts: [{ id: effort, label: effort }], defaultEffort: effort }], cliVersion: '0.143.0', configurationKey: 'default' });

test('cold first-Chat creation bootstraps inventory; project catalogs replace the host roster without changing a saved tuple', { timeout: 30000 }, t => {
  const calls = [];
  return withFixture(t, async f => {
    const chat = await f.createChat('Cold creation');
    assert.equal(calls.length, 1, 'Creation requires no prior status request');
    assert.equal(chat.defaultModel, 'host-model');
    const projectModels = f.ok(await f.api('GET', `/api/projects/${chat.projectId}/engine-models/codex`));
    assert.equal(projectModels.models[0].id, 'project-model');
    const agent = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agents`, {
      title: 'Pinned before refresh', engine: 'codex', model: 'project-model', effort: 'high', conversationId: chat.id,
      idempotencyKey: crypto.randomUUID(),
    }));
    // A later roster omission must not silently switch this existing Agent.
    calls.push('omit');
    f.ok(await f.api('GET', `/api/projects/${chat.projectId}/engine-models/codex?refresh=1`));
    await f.send(agent.id, 'Preserve selected runtime'); await f.settled(agent.id);
    assert.equal(f.turns.at(-1).input.model, 'project-model');
    assert.equal(f.turns.at(-1).input.effort, 'high');
    const second = await f.createChat('Another cold project');
    assert.equal(second.defaultModel, 'host-model', 'A Project roster must not contaminate host admission');
  }, { modelCatalog: async cwd => { calls.push(cwd); return catalog(calls.includes('omit') ? 'replacement' : calls.length === 1 ? 'host-model' : 'project-model'); } });
});

for (const scenario of ['empty', 'malformed-first', 'malformed-later', 'malformed-cursor', 'repeated']) test(`RPC inventory distinguishes known-empty from incomplete pagination: ${scenario}`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-model-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true })); const handles = [];
  await writeFile(path.join(root, 'app-server'), `
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);if(m.id===undefined)return;
      let result={data:[],nextCursor:null};
      if(m.method==='initialize')result={userAgent:'ponderosa/0.143.0 (Ubuntu 26.4.0; x86_64) unknown (ponderosa; 1.0.0)'};
      if(m.method==='model/list'){
        const scenario=${JSON.stringify(scenario)};
        if(scenario==='malformed-first'||(scenario==='malformed-later'&&m.params.cursor))result={};
        else if(scenario!=='empty')result={data:[{id:'actual'}],nextCursor:scenario==='malformed-cursor'?42:'page-2'};
      }
      console.log(JSON.stringify({id:m.id,result}));
    });
  `);
  try {
    const result = await discoverCodexAppServerCapabilities({ bin: process.execPath, cwd: root, sandboxMode: 'read-only',
      signal: new AbortController().signal, killGraceMs: 50, configuredMcps: [], timeoutMs: 5000,
      onRuntimeSpawned: handle => handles.push(handle) });
    if (scenario === 'empty') { assert.deepEqual(result.modelCatalog.models, []); assert.equal(result.modelCatalog.cliVersion, '0.143.0'); }
    else assert.equal(result.modelCatalog, undefined);
    assert.ok(handles.every(handle => !handle.isAlive()));
  } finally { await Promise.all(handles.map(handle => handle.close())); }
});

for (const auth of ['subscription', 'api-key', 'unknown']) test(`selected Codex model test enforces subscription auth and exact selection: ${auth}`, { timeout: 15000,
  skip: process.platform === 'win32' || /\s/u.test(process.execPath) ? 'Owned executable fixture requires a POSIX shebang' : false }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-model-check-')); const handles = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex');
  await writeFile(bin, '#!' + process.execPath + '\n' + `
    const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},JSON.stringify(args)+'\\n');
    if(args[0]==='login')console.log(${JSON.stringify(auth === 'subscription' ? 'Logged in using ChatGPT' : auth === 'api-key' ? 'Logged in using an API key' : 'unrecognized response')});
    else {console.log(JSON.stringify({type:'turn.failed',error:{message:${JSON.stringify(upgrade)},codexErrorInfo:'other'}}));process.exitCode=1;}
  `); await chmod(bin, 0o700);
  try {
    const result = await new CodexAdapter({ bin, killGraceMs: 50 }).validateModel(root, 'gpt-5.6-sol', {
      signal: new AbortController().signal, onRuntimeSpawned: handle => handles.push(handle) });
    const calls = (await readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(result.valid, false);
    assert.equal(calls.length, auth === 'subscription' ? 2 : 1, 'No inference under rejected authentication');
    if (auth === 'subscription') { assert.ok(calls[1].includes('gpt-5.6-sol')); assert.match(result.error, /CLI needs an update/u); }
    assert.ok(handles.every(handle => !handle.isAlive()));
  } finally { await Promise.all(handles.map(handle => handle.close())); }
});

test('provider advisory delay persists through failure and repeated recovery keeps its original due time', t => {
  const f = memoryRecovery(t), run = f.lease(f.now);
  f.fail(run, f.now, true, 'rate_limit', { failureDetail: { phase: 'turn', promptInjectionState: 'injected', retryAfterMs: 90000, httpStatusCode: 429 } });
  const row = f.db.prepare("SELECT id,available_at FROM agent_activations WHERE kind='required_reply_recovery'").get();
  assert.ok(Date.parse(row.available_at) >= Date.parse(f.now) + 90000);
  f.restart().requiredReplyAuthority.recoverPending(run.runId, f.now);
  assert.deepEqual(f.db.prepare("SELECT id,available_at FROM agent_activations WHERE kind='required_reply_recovery'").all(), [row]);
});


test('transient refresh failure retains cached inventory and cold Chat admission without spawning again', { timeout: 30000 }, t => {
  let calls = 0, failing = false;
  return withFixture(t, async f => {
    const first = await f.createChat('Cached'); assert.equal(first.defaultModel, 'live');
    const [left, right] = await Promise.all([f.api('GET', `/api/projects/${first.projectId}/engine-models/codex`), f.api('GET', `/api/projects/${first.projectId}/engine-models/codex`)]);
    f.ok(left); f.ok(right); assert.equal(calls, 2, 'Concurrent discovery must coalesce');
    failing = true;
    assert.equal((await f.api('GET', `/api/projects/${first.projectId}/engine-models/codex?refresh=1`)).status, 503);
    const retained = f.ok(await f.api('GET', `/api/projects/${first.projectId}/engine-models/codex`));
    assert.equal(retained.models[0].id, 'live'); assert.equal(calls, 3);
    f.ok(await f.api('POST', '/api/engines/codex/recheck'));
    const afterFailure = calls;
    const [engine] = f.ok(await f.api('GET', '/api/engines'));
    assert.equal(engine.models[0].id, 'live'); assert.equal(engine.defaultModel, 'live');
    assert.equal((await f.createChat('Still usable')).defaultModel, 'live');
    assert.equal(calls, afterFailure, 'Failure cooldown must retain the roster without another helper');
  }, { modelCatalog: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); if (failing) throw new Error('Controlled refresh unavailable'); return catalog('live'); } });
});

test('a reused Codex session can select Fast then Standard without changing ordinary-turn billing tier', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-fast-rpc-')); const handles = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app-server'), `
    const fs=require('node:fs');const seen={args:process.argv.slice(2),requests:[]};
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);if(m.id===undefined)return;seen.requests.push(m);fs.writeFileSync('seen.json',JSON.stringify(seen));
      const result=m.method==='initialize'?{userAgent:'ponderosa/0.143.0 (Ubuntu 26.4.0; x86_64) unknown (ponderosa; 1.0.0)'}:m.method==='turn/start'?{turn:{id:'turn'}}:{thread:{id:'thread'},model:'fixture'};
      console.log(JSON.stringify({id:m.id,result}));
    });
  `);
  const session = await new CodexAdapter({ bin: process.execPath, killGraceMs: 50 }).openSession({ cwd: root, model: 'fixture', history: [],
    signal: new AbortController().signal, onRuntimeSpawned: handle => handles.push(handle) });
  try {
    for (const speed of ['standard', 'fast', 'standard']) await session.startTurn({ prompt: 'Fixture', speed });
    const seen = JSON.parse(await readFile(path.join(root, 'seen.json'), 'utf8'));
    assert.ok(seen.args.includes('features.fast_mode=true'));
    assert.equal(seen.requests.find(r => r.method === 'thread/start').params.serviceTier, null);
    assert.deepEqual(seen.requests.filter(r => r.method === 'turn/start').map(r => r.params.serviceTier), [null, 'fast', null]);
  } finally { await session.close(); }
  assert.ok(handles.every(handle => !handle.isAlive()));
});
