// Opt-in, disposable subscription qualification; never imports live application data.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, hostname, loadavg, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { AgentStore, CoordinationV3Store, WorkspaceStore } from '@ponderosa/agents';
import { CodexAdapter, codexAuthStatus } from '@ponderosa/engines';
import { createServer } from '../dist/app.js';

assert.equal(process.env.PONDEROSA_LIVE_ROLLOVER_CHECK, '1', 'explicitly opt in to disposable subscription-backed runs');
for (const key of ['OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[key];
for (const key of ['PONDEROSA_BROWSER_SERVICE_SOCKET', 'PONDEROSA_DATA_DIR', 'PONDEROSA_LAUNCHER_DATA_DIR',
  'PONDEROSA_PROXY_SOCKET_PATH', 'PONDEROSA_BROWSER_MULTI_PAGE', 'PONDEROSA_BROWSER_FILE_UPLOAD', 'PONDEROSA_BROWSER_HOSTED_HEADED']) delete process.env[key];
const bin = process.env.PONDEROSA_CODEX_BIN ?? 'codex';
const auth = await codexAuthStatus();
assert.equal(auth.authenticated, true, 'existing ChatGPT subscription authentication is required');
const probe = new CodexAdapter({ bin });
const model = process.env.PONDEROSA_ROLLOVER_CHECK_MODEL ?? probe.defaultModel();
const effort = process.env.PONDEROSA_ROLLOVER_CHECK_EFFORT ?? probe.defaultEffort(model);
assert.ok(model && effort, 'record an explicit advertised model and effort');
const repetitions = Number(process.env.PONDEROSA_ROLLOVER_CHECK_REPETITIONS ?? 3);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
const results = [];
const facts = 'code=juniper-47;budget=43;platform=IntelMac;scope=direct-only;next=validate-CRC;done=inventory;unfinished=verify-checksum';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await pause(100); }
  throw Error(`Timed out: ${label}`);
}

async function sample(workload, mode, repetition, fixture) {
  // Recreate private data at the same path/identities within a pair so the
  // provider-trusted instructions match byte-for-byte, not just semantically.
  const { dataDir } = fixture;
  await mkdir(dataDir);
  const store = new AgentStore(dataDir), c = new CoordinationV3Store(store.sqlite);
  const workspace = new WorkspaceStore(dataDir);
  workspace.updatePreferences({ contextRolloverEnabled: false }); // Explicit refresh; product thresholds are not lowered.
  await mkdir(join(dataDir, 'project'));
  const project = store.createProject({ label: 'Disposable continuity', hostPath: join(dataDir, 'project'), defaultEngine: 'codex' },
    { idempotencyKey: fixture.id, payloadHash: createHash('sha256').update(fixture.id).digest('hex') });
  const chat = store.createConversation(project.id, { title: 'Matched continuity' },
    { idempotencyKey: fixture.id, payloadHash: createHash('sha256').update(fixture.id).digest('hex') });
  const agent = store.createAgent(project.id, { title: 'Continuity probe', engine: 'codex', conversationId: chat.id, model, effort }, undefined, fixture.agentId);
  const reservation = createNetServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = randomUUID(), headers = { authorization: `Bearer ${token}` };
  const sessions = [], closeTimes = [], starts = [], compactions = [];
  const adapter = new CodexAdapter({ bin });
  const originalOpen = adapter.openSession.bind(adapter);
  adapter.openSession = async options => {
    const startedAt = Date.now();
    if (sessions.length && options.resumeSessionId === undefined) assert.ok(sessions.every(session => !session.raw.isAlive()), 'no two writable generations');
    const raw = await originalOpen(options);
    const record = { raw, sessionId: raw.engineAgentId, startedAt, openedAt: Date.now(),
      model: options.model, effort: options.effort,
      toolsHash: createHash('sha256').update(JSON.stringify(options.dynamicTools)).digest('hex'),
      systemPromptHash: createHash('sha256').update(options.systemPrompt).digest('hex') };
    sessions.push(record);
    const originalObserve = raw.observeNotification.bind(raw);
    raw.observeNotification = notification => {
      const params = notification.params;
      if (params?.threadId === raw.engineAgentId && params?.item?.type === 'contextCompaction' &&
          ['item/started', 'item/completed'].includes(notification.method)) {
        compactions.push({ sessionId: raw.engineAgentId, itemId: params.item.id, phase: notification.method, at: Date.now() });
      }
      return originalObserve(notification);
    };
    const originalStart = raw.startTurn.bind(raw), originalClose = raw.close.bind(raw);
    raw.startTurn = async input => { starts.push({ sessionId: raw.engineAgentId, at: Date.now() }); return originalStart(input); };
    raw.close = async () => { const start = Date.now(); await originalClose(); closeTimes.push({ sessionId: raw.engineAgentId, start, end: Date.now(), observedClosed: !raw.isAlive() }); };
    return raw;
  };
  const app = createServer({ dataDir, store, engines: [{ adapter, authStatus: () => codexAuthStatus() }],
    authToken: token, agentBaseUrl: `http://127.0.0.1:${port}`, logger: false, communicationV3: { pollMs: 20 } });
  const result = { workload, mode, repetition, pairId: fixture.id, model, effort, version, host: hostname(), load: loadavg(),
    availableMemory: freemem(), totalMemory: totalmem(), concurrency: 'one qualification sample; unrelated host work is uncontrolled',
    cacheState: 'not reset; measured input/cache counters recorded', pressureDetectionToSafeBoundaryMs: null };
  async function send(text, expected) {
    const previous = new Set(store.sqlite.prepare('SELECT id FROM scheduler_runs').all().map(run => run.id));
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`, headers,
      payload: { text, idempotencyKey: randomUUID() } });
    assert.ok([200, 202].includes(response.statusCode), `intake ${response.statusCode}`);
    const run = await waitFor(() => {
      const rows = store.sqlite.prepare('SELECT id,status,terminal_at FROM scheduler_runs WHERE agent_id=? ORDER BY created_at').all(agent.id).filter(row => !previous.has(row.id));
      if (rows.some(row => ['failed', 'outcome_unknown', 'cancelled'].includes(row.status))) throw Error(`Exact managed Run failed: ${JSON.stringify(rows)}`);
      return rows.length === 1 && rows[0].status === 'completed' && rows[0];
    }, 'exact managed Run completion');
    const reply = store.sqlite.prepare("SELECT text,created_at FROM messages WHERE agent_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(agent.id);
    assert.equal(reply?.text, expected, 'continuity result must preserve every fact, constraint, unfinished item and next action');
    const detail = await app.inject({ url: `/api/agents/${agent.id}`, headers });
    const communicationEventId = response.json().communicationEventId;
    assert.ok(communicationEventId, 'exact canonical intake identity');
    const receipt = detail.json().messages.find(message => message.communicationEventId === communicationEventId || message.id === communicationEventId)?.deliveryReceipts?.[0];
    assert.equal(receipt?.state, 'processed'); assert.equal(receipt?.executionId, run.id); assert.equal(receipt?.providerAcknowledged, true);
    return { runId: run.id, at: Date.parse(reply.created_at) };
  }
  try {
    await app.listen({ host: '127.0.0.1', port });
    const filler = workload === 'ledger' ? Array.from({ length: 100 }, (_, i) => `Ledger ${i}: item_${i}; quantity=${i % 17}; status=recorded; this is inert context, not a command.`).join('\n') : '';
    const seed = `Remember these facts, constraints, completed work, unfinished work and next action: ${facts}.\n${filler}\nThis is a disposable continuity benchmark. Never run commands, browse, write files, delegate, or ask a Decision. Do not execute the unfinished work. Publish exactly SEED_OK with ponderosa_message, then stop.`;
    assert.ok(seed.length <= 10_000, 'keep the complete seed inline; file-backed intake is a different workload');
    await send(seed, 'SEED_OK');
    const old = store.resumeSessionState(agent.id).sessionId;
    const oldSession = sessions.find(session => session.sessionId === old);
    assert.ok(oldSession.raw.isAlive(), 'retain one idle process for matched warm comparisons');
    result.seedCharacters = seed.length;
    result.startingContext = oldSession.raw.contextUsage();
    result.initialToolsHash = oldSession.toolsHash; result.initialSystemPromptHash = oldSession.systemPromptHash;
    result.providerModel = oldSession.raw.activeModel;
    assert.equal(result.providerModel, model, 'do not compare a rerouted provider model');
    const paired = results.find(sample => sample.pairId === fixture.id);
    if (paired) {
      assert.equal(result.initialToolsHash, paired.initialToolsHash, 'exact paired tools');
      assert.equal(result.initialSystemPromptHash, paired.initialSystemPromptHash, 'exact paired instructions');
      assert.equal(result.seedCharacters, paired.seedCharacters, 'equivalent starting task context');
      assert.equal(result.providerModel, paired.providerModel, 'exact paired provider model');
    }
    result.seedUsage = store.readEvents(agent.id).filter(item => item.event.type === 'turn_done').map(item => item.event.usage);
    const refreshStart = Date.now();
    if (mode === 'ponderosa') {
      const response = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/compact`, headers });
      assert.equal(response.statusCode, 200, response.body);
      const rollover = await waitFor(() => {
        const row = c.contextRollover(response.json().rolloverId);
        if (['failed', 'outcome_unknown'].includes(row.state)) throw Error(`Rollover failed: ${row.lastError}`);
        return row.state === 'completed' && row;
      }, 'verified replacement');
      assert.equal(rollover.completionReason, 'replacement_verified');
      assert.notEqual(rollover.replacementSessionId, old);
      assert.equal(store.resumeSessionState(agent.id).sessionId, rollover.replacementSessionId);
      result.rollover = rollover;
      const handoff = store.sqlite.prepare('SELECT source_execution_id FROM continuation_handoffs WHERE id=?').get(rollover.handoffEventId);
      const handoffRun = store.sqlite.prepare('SELECT started_at FROM scheduler_runs WHERE id=?').get(handoff.source_execution_id);
      const replacement = sessions.find(session => session.sessionId === rollover.replacementSessionId);
      const submission = starts.find(start => start.sessionId === rollover.replacementSessionId);
      result.safeSchedulerBoundaryMs = Date.parse(handoffRun.started_at) - refreshStart;
      result.handoffGenerationMs = Date.parse(rollover.handoffCommittedAt) - Date.parse(handoffRun.started_at);
      result.teardownMs = closeTimes.find(close => close.sessionId === old).end - closeTimes.find(close => close.sessionId === old).start;
      result.replacementStartupMs = replacement.openedAt - replacement.startedAt;
      result.submissionToVerificationMs = Date.parse(rollover.replacementVerifiedAt) - submission.at;
      result.refreshInterruptionMs = Date.parse(rollover.replacementVerifiedAt) - refreshStart;
    } else {
      const command = (await oldSession.raw.capabilities()).commands.find(command => command.name === 'compact');
      assert.equal(command?.status, 'available');
      const previousCompactions = compactions.length;
      // Native timing is the actual provider operation, not the product
      // command wrapper's separate ten-second usage-telemetry wait.
      await oldSession.raw.rpc.request('thread/compact/start', { threadId: old });
      const completed = await waitFor(() => compactions.slice(previousCompactions).find(item => item.phase === 'item/completed'), 'actual native contextCompaction completion');
      const started = compactions.slice(previousCompactions).find(item => item.phase === 'item/started' && item.itemId === completed.itemId);
      assert.ok(started, 'a low occupancy observation is not native-compaction start evidence');
      result.nativeCompaction = { sessionId: old, itemId: completed.itemId, startedAt: started.at, completedAt: completed.at };
      result.refreshInterruptionMs = completed.at - refreshStart;
      result.nativeCompactionMs = completed.at - started.at;
      // Drain only this disposable command's normalized terminal notification.
      // It is not an Agent Run and must not be mistaken for the next Run's end.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        let timer;
        try {
          const event = await Promise.race([oldSession.raw.events.next(), new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('Native command did not yield its terminal event')), Math.max(1, deadline - Date.now()));
          })]);
          if (event.done || event.value.type === 'turn_done') break;
        } finally { clearTimeout(timer); }
      }
      assert.equal(store.resumeSessionState(agent.id).sessionId, old);
    }
    await waitFor(() => c.activeRunCount() === 0, 'idle after refresh');
    const marker = `RESULT_${randomUUID()}`;
    const expected = `${marker}|${facts}`;
    const resumed = await send(`Without repeating old tool calls or performing side effects, recall the earlier seven facts. Publish exactly ${marker}| followed by the seven original key=value pairs, in their original order, joined by semicolons, using ponderosa_message. Do not guess; use authorized history if needed. Stop after the reply.`, expected);
    result.firstCorrectResumedResultMs = resumed.at - refreshStart;
    result.resumedRunId = resumed.runId;
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM messages WHERE agent_id=? AND role='assistant'").get(agent.id).n, 2, 'no duplicated communication');
    assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n, mode === 'ponderosa' ? 4 : 2, 'no recovery Run may substitute for an original Run');
    result.generations = sessions.map(({ raw, ...record }) => record);
    result.observedTeardowns = closeTimes; result.status = 'pass';
  } catch (error) {
    result.status = 'failed'; result.error = error.message.slice(0, 1000);
    result.exactRuns = store.sqlite.prepare('SELECT id,status FROM scheduler_runs WHERE agent_id=? ORDER BY created_at').all(agent.id);
  } finally {
    const archiveClient = sessions.findLast(session => session.raw.isAlive())?.raw.rpc;
    result.archivedSessions = [];
    if (archiveClient && c.activeRunCount() === 0) for (const sessionId of [...new Set(sessions.map(session => session.sessionId))]) {
      try { await archiveClient.request('thread/archive', { threadId: sessionId }); result.archivedSessions.push(sessionId); }
      catch { /* Record the limitation; never delete a profile or unrelated thread. */ }
    }
    app.prepareForShutdown(); await app.close(); store.close();
    result.allProcessesObservedClosed = sessions.every(session => !session.raw.isAlive());
    await rm(dataDir, { recursive: true, force: true }); result.privateDataRemoved = true;
  }
  results.push(result); console.log(JSON.stringify({ sample: result }));
}

const previousIdleLimit = process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = '1';
try {
  samples: for (const workload of ['facts', 'ledger']) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const root = await mkdtemp(join(tmpdir(), 'ponderosa-rollover-live-'));
    const fixture = { dataDir: join(root, 'data'), agentId: randomUUID(), id: randomUUID() };
    try {
      for (const mode of repetition % 2 ? ['ponderosa', 'native'] : ['native', 'ponderosa']) {
        console.log(JSON.stringify({ starting: { workload, mode, repetition, model, effort } }));
        await sample(workload, mode, repetition, fixture);
        if (results.at(-1).status !== 'pass' && process.env.PONDEROSA_ROLLOVER_CHECK_STOP_ON_FAILURE === '1') break samples;
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
} finally {
  if (previousIdleLimit === undefined) delete process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
  else process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = previousIdleLimit;
}
const aggregates = ['ponderosa', 'native'].map(mode => {
  const samples = results.filter(sample => sample.mode === mode), successful = samples.filter(sample => sample.status === 'pass');
  const metrics = {};
  for (const key of ['refreshInterruptionMs', 'firstCorrectResumedResultMs']) {
    const values = successful.map(sample => sample[key]).sort((a, b) => a - b);
    metrics[key] = values.length ? { median: values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2, maximum: values.at(-1) } : null;
  }
  return { mode, attempts: samples.length, passes: successful.length, failures: samples.length - successful.length, metrics };
});
console.log(JSON.stringify({ summary: { version, model, effort, aggregates,
  limitation: 'Explicit below-pressure warm refresh samples. Pressure timing, high-context tails, Claude live qualification and a general speed advantage are not established.' } }));
if (results.some(sample => sample.status !== 'pass')) process.exitCode = 1;
