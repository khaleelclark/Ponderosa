import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import { createServer } from '../dist/app.js';
import { RESOURCE_ADMISSION_DEFAULTS } from '../dist/resource-admission.js';

// Real monitor/HTTP/store/scheduler boundaries with controlled observations:
// lowering reserve cannot override independent PSI or recovery hysteresis.
test('production admission retains exact work across reopening and two healthy observations despite low-reserve I/O pressure', { timeout: 15000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'resource-http-'))), MiB = 1024 ** 2, timeline = [];
  let store = new AgentStore(root), app, agentId, starts = 0, authChecks = 0;
  let clock = Date.now(), phase = 'initial reserve hold', io = 0, shuttingDown = false;
  const record = (kind, details = {}) => {
    if (timeline.length < 160) timeline.push({ kind, phase, wallTime: new Date().toISOString(), resourceClock: clock, ...details });
  };
  const adapter = { id: 'codex', displayName: 'Disposable', trustedSystemPromptChannel: 'developer', listModels: () => [], listEfforts: () => [],
    seed: async function* () { record('provider_start', { operation: 'seed', starts: ++starts }); yield { type: 'turn_done' }; },
    continue: async function* () { record('provider_start', { operation: 'continue', starts: ++starts }); yield { type: 'turn_done' }; } };
  const rows = (table, columns, where) => store.sqlite.prepare(`SELECT ${columns} FROM ${table} WHERE ${where} LIMIT 20`).all(agentId);
  const capture = async label => {
    const engine = (await app.inject('/api/engines')).json()[0];
    const metrics = (await app.inject('/api/communication-v3/metrics')).json();
    const readiness = (await app.inject('/api/ready')).json();
    record('admission_snapshot', { label, starts, authChecks, shuttingDown, resource: engine.resourceAdmission,
      provider: { authentication: engine.authentication, intakeReady: engine.intakeReady, enabled: engine.enabled, availability: engine.availability },
      scheduler: metrics.scheduler, deploymentDrain: readiness.deploymentDrain,
      activations: agentId ? rows('agent_activations', 'id,kind,state,scope_key,available_at,delivery_failures,last_delivery_error,terminal_outcome,steering_wait_reason', 'agent_id=?') : [],
      runs: agentId ? rows('scheduler_runs', 'id,status,scope_key,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,started_at,terminal_at,side_effects_fenced_at', 'agent_id=?') : [],
      injections: agentId ? rows('scheduler_prompt_injections', 'id,run_id,state,prompt_hash,submitted_at,acknowledged_at', 'run_id IN (SELECT id FROM scheduler_runs WHERE agent_id=?)') : [],
      operations: agentId ? rows('provider_operation_outbox', 'id,run_id,operation,state,attempts,available_at,claimed_by,claimed_at,last_error', 'run_id IN (SELECT id FROM scheduler_runs WHERE agent_id=?)') : [] });
    return { engine, metrics };
  };
  const open = async reserveBytes => {
    shuttingDown = false;
    record('open', { reserveBytes, startupBytes: MiB, defaults: RESOURCE_ADMISSION_DEFAULTS,
      pressure: { holdMemoryPercent: 5, holdIoPercent: 10, recoverMemoryPercent: 1, recoverIoPercent: 2, recoveryHeadroom: 1.25 } });
    app = createServer({ dataDir: root, store, engines: [{ adapter, authStatus: async () => {
      record('authentication', { authChecks: ++authChecks }); return { authenticated: true }; } }], logger: false,
      resourceAdmission: { reserveBytes, startupBytes: MiB }, communicationV3: { pollMs: 20 },
      resourceAdmissionObservation: { platform: 'linux', now: () => clock, sample: async () => {
        const sample = { availableBytes: 512 * MiB, memoryFullPercent: 0, ioFullPercent: io, source: 'linux_host_and_cgroup' };
        record('observation', sample); return sample; } } });
    await app.ready();
  };
  const close = async () => {
    if (app) { shuttingDown = true; record('shutdown_requested'); app.prepareForShutdown();
      try { await capture('after shutdown request'); }
      catch (error) { record('diagnostic_error', { error: String(error).slice(0, 500) }); }
      finally { await app.close(); app = undefined; record('server_closed'); } }
    store.close(); record('store_closed');
  };
  const wait = async (label, predicate) => {
    record('wait', { label });
    for (let i = 0; i < 100; i++) { // The original five-second wait is unchanged.
      if (await predicate()) { await capture(`${label}: observed`); return; }
      if (i % 20 === 0) await capture(`${label}: iteration ${i}`);
      await delay(50);
    }
    await capture(`${label}: deadline`);
    throw Error(`expected resource/scheduler transition was not observed: ${label}`);
  };
  try {
    const project = store.createProject({ label: 'Disposable', hostPath: root, defaultEngine: 'codex' });
    const chat = store.createConversation(project.id, { title: 'Disposable' });
    await open(1024 ** 4);
    await wait('initial hold', async () => (await app.inject('/api/engines')).json()[0].resourceAdmission.state === 'held');
    const accepted = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/agents`, payload: {
      title: 'Pending', engine: 'codex', conversationId: chat.id, initialMessage: 'Exact original opening message; do not prepend anything.', idempotencyKey: 'exact-opening' } });
    assert.equal(accepted.statusCode, 200, accepted.body); agentId = accepted.json().id;
    await delay(200); assert.equal(starts, 0); assert.equal(new CoordinationV3Store(store.sqlite).activeRunCount(), 0);
    const before = store.sqlite.prepare('SELECT id,state,delivery_failures,payload_json FROM agent_activations WHERE agent_id=?').all(agentId);
    assert.ok(before.length); assert.ok(before.every(row => row.state === 'pending' && row.delivery_failures === 0));
    await close(); store = new AgentStore(root); phase = 'low reserve but independent I/O hold'; io = 11; await open(MiB);
    // Reproduce the old fixture's invalid expectation without stressing a host.
    await assert.rejects(wait('low reserve cannot override I/O pressure', () => starts === 1), /transition was not observed/);
    assert.equal(starts, 0); assert.equal(new CoordinationV3Store(store.sqlite).activeRunCount(), 0);
    const held = await capture('no admission or preparation while held');
    assert.equal(held.engine.resourceAdmission.state, 'held'); assert.equal(held.engine.intakeReady, false);
    assert.equal(held.metrics.scheduler.claimedRuns, 0);
    phase = 'healthy observation one'; io = 0; clock += 2000;
    await wait('first healthy sample', async () => (await app.inject('/api/engines')).json()[0].resourceAdmission.ioFullPercent === 0);
    assert.equal(starts, 0); assert.equal((await capture('hysteresis remains held')).engine.resourceAdmission.state, 'held');
    phase = 'healthy observation two'; clock += 2000;
    await wait('same exact activation starts once', () => starts === 1);
    await wait('original Run completes', () => store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE agent_id=?').all(agentId).some(row => row.status === 'completed'));
    const after = store.sqlite.prepare('SELECT id,delivery_failures,payload_json FROM agent_activations WHERE agent_id=?').all(agentId);
    assert.deepEqual(after.map(row => ({ id: row.id, payload: row.payload_json })), before.map(row => ({ id: row.id, payload: row.payload_json })));
    assert.ok(after.every(row => row.delivery_failures === 0));
    assert.deepEqual(store.sqlite.prepare('SELECT status,fencing_token FROM scheduler_runs WHERE agent_id=?').all(agentId), [{ status: 'completed', fencing_token: 1 }]);
    assert.equal(starts, 1);
  } catch (error) {
    record('unexpected_failure', { error: String(error).slice(0, 500) });
    if (app) try { await capture('unexpected failure'); } catch (diagnostic) { record('diagnostic_error', { error: String(diagnostic).slice(0, 500) }); }
    throw error;
  }
  finally {
    try { await close(); } finally {
      console.log(JSON.stringify({ qualification: 'controlled Linux observations; not host-pressure or live-provider qualification', timeline }));
      await rm(root, { recursive: true, force: true });
    }
  }
});
