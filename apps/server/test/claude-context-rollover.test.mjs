import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { AgentStore, CoordinationV3Store, WorkspaceStore } from '@ponderosa/agents';
import { ClaudeStreamSession } from '@ponderosa/engines';
import { providerEventStream } from '../dist/provider-session-facade.js';
import { evaluateContextRolloverPressure } from '../dist/context-rollover-pressure.js';
import { createServer } from '../dist/app.js';

const binary = fileURLToPath(new URL('../../../packages/engines/test/fixtures/claude-context-stream.mjs', import.meta.url));
test('raw Claude stream crosses strict production projection and requests one durable rollover', { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-rollover-')));
  const store = new AgentStore(directory);
  const session = new ClaudeStreamSession({ bin: binary, permissionMode: 'default', killGraceMs: 100,
    cwd: directory, history: [], signal: new AbortController().signal, onRuntimeSpawned() {} });
  try {
    const project = store.createProject({ label: 'Disposable', hostPath: directory, defaultEngine: 'claude' });
    const chat = store.createConversation(project.id, { title: 'Disposable' });
    const agent = store.createAgent(project.id, { title: 'Disposable', engine: 'claude', conversationId: chat.id });
    const coordination = new CoordinationV3Store(store.sqlite);
    await session.startTurn({ prompt: 'Isolated raw transport qualification', kind: 'system', clientMessageId: 'current' });
    const observations = [], events = [], rollovers = [];
    for await (const event of providerEventStream(session.events)) {
      events.push(event.type);
      if (event.type === 'context_usage') {
        observations.push(event);
        const pressure = evaluateContextRolloverPressure(event, { contextRolloverTokens: 150000, contextRolloverWindowFraction: 0.75 });
        assert.equal(pressure.shouldRequest, true);
        rollovers.push(coordination.requestContextRollover({ projectId: project.id, agentId: agent.id,
          oldProviderSessionId: event.providerSessionId, providerSessionGeneration: event.providerSessionGeneration,
          detectedOccupancy: event.usedTokens, threshold: pressure.threshold, lowWaterMark: pressure.lowWaterMark,
          sourceRunId: 'source', sourceActivationIds: [], compactionCutoffOrdinal: 1, compactionCutoffEventId: 'boundary',
          recentTail: [{ communicationEventId: 'boundary', contentSha256: 'a'.repeat(64) }],
          scopeKey: `conversation:${chat.id}`, conversationId: chat.id }));
      }
      if (event.type === 'turn_done') break;
    }
    assert.equal(observations.length, 1);
    assert.equal(observations[0].usedTokens, 150001);
    assert.ok(events.includes('text')); assert.equal(events.at(-1), 'turn_done');
    assert.equal(rollovers[0].created, true);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='context_rollover_handoff'").get().n, 1);
    assert.equal(session.contextUsage().usedTokens, 150001, 'aggregate and synthetic zero usage cannot replace occupancy');
  } finally { await session.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

async function waitFor(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${typeof description === 'function' ? description() : description}`);
}

for (const configuration of [
  { initialTelemetry: 'low' }, { initialTelemetry: 'unavailable' }, { initialTelemetry: 'low', cold: true },
  ...['missing', 'malformed', 'stale', 'subagent', 'replay', 'high'].map(replacementObservation => ({ initialTelemetry: 'low', replacementObservation })),
  { initialTelemetry: 'above', automatic: true },
  { initialTelemetry: 'low', cancelled: true }, { initialTelemetry: 'low', failedTeardown: true },
  ...['cwd', 'ref', 'hash', 'extra'].map(invalidEnvironment => ({ initialTelemetry: 'low', invalidEnvironment })),
]) {
  const { initialTelemetry, cold, replacementObservation, automatic, cancelled, failedTeardown, invalidEnvironment } = configuration;
  test(`actual ${automatic ? 'automatic rollover' : 'manual refresh'} route: ${initialTelemetry} initial telemetry, ${cold ? 'cold' : 'warm'}, ${invalidEnvironment ? `invalid environment ${invalidEnvironment}` : cancelled ? 'cancelled' : failedTeardown ? 'blocked teardown' : replacementObservation ?? 'valid'} replacement`, { timeout: 20000 }, async () => {
    const previousIdleLimit = process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
    process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = cold ? '0' : '1';
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-manual-route-')));
    const store = new AgentStore(directory);
    const workspace = new WorkspaceStore(directory);
    workspace.updatePreferences({ contextRolloverEnabled: Boolean(automatic) });
    const coordination = new CoordinationV3Store(store.sqlite);
    const project = store.createProject({ label: 'Disposable', hostPath: directory, defaultEngine: 'claude' });
    const chat = store.createConversation(project.id, { title: 'Disposable' });
    const agent = store.createAgent(project.id, { title: 'Disposable', engine: 'claude', conversationId: chat.id });
    const originalCommit = CoordinationV3Store.prototype.recordProviderInputAndCommitContextRolloverReplacement;
    if (invalidEnvironment) CoordinationV3Store.prototype.recordProviderInputAndCommitContextRolloverReplacement = function (input) {
      if (input.agentId !== agent.id) return originalCommit.call(this, input);
      const sourceManifest = structuredClone(input.sourceManifest);
      const environment = sourceManifest.sources.find(source => source.kind === 'environment');
      if (invalidEnvironment === 'cwd') sourceManifest.environmentFacts.cwd = '/different-working-copy';
      if (invalidEnvironment === 'ref') environment.ref = 'foreign-working-copy';
      if (invalidEnvironment === 'hash') environment.hash = 'a'.repeat(64);
      if (invalidEnvironment === 'extra') sourceManifest.environmentFacts.executables[0].unexpected = 'unhashed';
      return originalCommit.call(this, { ...input, sourceManifest });
    };
    const opened = [], snapshotsAtReplacement = [], failures = [];
    let closeAttempts = 0, allowTeardown = false;
    const reservation = createNetServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const adapter = { id: 'claude', displayName: 'Disposable', trustedSystemPromptChannel: 'system',
      listModels: () => [], listEfforts: () => [],
      async openSession(options) {
        const freshReplacement = opened.length > 0 && options.resumeSessionId === undefined;
        if (freshReplacement) {
          assert.equal(opened[0].isAlive(), false, 'old writable process must be observed closed first');
          snapshotsAtReplacement.push(store.resumeSessionState(agent.id)?.sessionId);
          assert.equal(options.resumeSessionId, undefined, 'replacement cannot resume the old generation');
        }
        const session = new ClaudeStreamSession({ ...options, bin: binary, permissionMode: 'default', killGraceMs: 100,
          environment: { ...options.environment, PONDEROSA_CLAUDE_FIXTURE_TOKENS: freshReplacement ? '8000' : automatic ? '150001' : '10000',
            PONDEROSA_CLAUDE_FIXTURE_REPLY: automatic ? '0' : '1',
            PONDEROSA_CLAUDE_FIXTURE_OBSERVATION: freshReplacement ? replacementObservation ?? 'valid' : 'valid',
            PONDEROSA_CLAUDE_FIXTURE_DELAY: freshReplacement && cancelled ? '500' : '',
            PONDEROSA_CLAUDE_FIXTURE_MISSING: initialTelemetry === 'unavailable' && !freshReplacement ? '1' : '0' } });
        if (failedTeardown && !opened.length) {
          const originalClose = session.close.bind(session);
          session.close = async () => {
            closeAttempts++;
            if (!allowTeardown) throw Error('Disposable observed teardown failure');
            return originalClose();
          };
        }
        opened.push(session); return session;
      } };
    const app = createServer({ dataDir: directory, store, agentBaseUrl: `http://127.0.0.1:${port}`, engines: [{ adapter, authStatus: async () => ({ authenticated: true }) }], logger: process.env.PONDEROSA_ROLLOVER_TEST_DEBUG === '1' ? { level: 'warn' } : false,
      communicationV3: { pollMs: 10 } });
    app.addHook('onSend', async (_request, reply, payload) => { if (reply.statusCode >= 400) failures.push(payload); });
    try {
      await app.listen({ host: '127.0.0.1', port });
      const send = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`, payload: {
        text: 'Disposable seed for manual refresh', idempotencyKey: 'seed' } });
      assert.ok([200, 202].includes(send.statusCode), send.body);
      await waitFor(() => store.resumeSessionState(agent.id) && (automatic || coordination.activeRunCount() === 0), () => JSON.stringify({ opened: opened.length,
        session: store.resumeSessionState(agent.id), events: store.readEvents(agent.id).slice(-5), runs: store.sqlite.prepare('SELECT status FROM scheduler_runs').all() }));
      const old = store.resumeSessionState(agent.id).sessionId;
      const response = automatic ? undefined : await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/compact` });
      if (response) assert.equal(response.statusCode, 200, response.body);
      const id = response?.json().rolloverId ?? (await waitFor(() => coordination.activeContextRollover(agent.id), 'automatic rollover')).id;
      const created = coordination.contextRollover(id);
      assert.equal(created.triggerKind, automatic ? 'automatic' : 'human');
      assert.equal(created.detectedOccupancy, initialTelemetry === 'above' ? 150001 : initialTelemetry === 'low' ? 10000 : undefined);
      if (failedTeardown) {
        await waitFor(() => closeAttempts > 0, 'old runtime teardown attempt');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(opened.length, 1, 'failed teardown must block fresh process startup');
        assert.equal(opened[0].isAlive(), true);
        assert.equal(store.resumeSessionState(agent.id).sessionId, old);
        assert.equal(coordination.contextRollover(id).replacementVerifiedAt, undefined);
        return;
      }
      if (cancelled) {
        const candidate = await waitFor(() => { const row = coordination.contextRollover(id); return row?.replacementSessionId && row; }, 'identified candidate');
        const stop = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/cancel`,
          payload: { targetRunId: candidate.replacementRunId, idempotencyKey: 'cancel-exact-candidate' } });
        assert.equal(stop.statusCode, 200, stop.body);
      }
      const completed = await waitFor(() => { const row = coordination.contextRollover(id); return ['completed', 'failed', 'outcome_unknown'].includes(row?.state) && row; }, () => JSON.stringify({ failures, rollover: coordination.contextRollover(id), events: store.readEvents(agent.id).slice(-5) }));
      if (replacementObservation || cancelled || invalidEnvironment) {
        assert.notEqual(completed.state, 'completed');
        assert.equal(completed.replacementVerifiedAt, undefined);
        assert.equal(completed.completionReason, undefined);
        assert.equal(store.resumeSessionState(agent.id).sessionId, old);
        if (replacementObservation === 'high') assert.equal(completed.failureSignal, 'seed_overflow');
        if (cancelled) assert.equal(completed.failureSignal, 'replacement_cancelled');
        if (invalidEnvironment) {
          assert.equal(opened.length, 1, 'invalid exact packet cannot open a candidate');
          assert.equal(completed.replacementAttempt, 0, 'atomic validation failure cannot commit a candidate input');
        }
        return;
      }
      assert.equal(completed.completionReason, 'replacement_verified');
      assert.ok(completed.replacementVerifiedAt); assert.notEqual(completed.replacementSessionId, old);
      assert.deepEqual(snapshotsAtReplacement, [old], 'accepted durable snapshot stays old until verification');
      assert.equal(store.resumeSessionState(agent.id).sessionId, completed.replacementSessionId);
      assert.equal(opened.length, cold ? 3 : 2);
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='context_rollover_handoff'").get().n, 1);
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='context_rollover_continuation'").get().n, 1);
    } finally {
      CoordinationV3Store.prototype.recordProviderInputAndCommitContextRolloverReplacement = originalCommit;
      allowTeardown = true;
      app.prepareForShutdown(); await app.close(); store.close(); await rm(directory, { recursive: true, force: true });
      if (previousIdleLimit === undefined) delete process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
      else process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = previousIdleLimit;
    }
  });
}
