import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('real Codex and Claude each recall fresh Chat and global facts in one managed search', {
  timeout: 600000,
  skip: process.env.PONDEROSA_REGRESSION_REAL_MEMORY !== '1' ? 'Set PONDEROSA_REGRESSION_REAL_MEMORY=1 with permitted native Codex/Claude and qualified Chroma/models' : false,
}, async t => {
  const chromaBin = process.env.PONDEROSA_TEST_CHROMA_BIN, modelDir = process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR;
  assert.ok(chromaBin && modelDir, 'Explicit qualified Chroma binary and local model directory are required');
  const { defaultEngineRegistrations, spawnContainedCli, runtimeProcessHandle } = await import('@ponderosa/engines');
  const { deriveCommunicationBehavior } = await import('@ponderosa/core');
  const { createServer } = await import('../../apps/server/dist/app.js');
  const { localMemoryFor } = await import('../../apps/server/dist/local-memory.js');
  const { until } = await import('../shared/fixture.mjs');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ponderosa-native-recall-'))), working = path.join(root, 'working');
  const handles = [], submissions = [], searches = [], summary = { root, providers: [], passed: false };
  const previous = { TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  let app, chromaHandle, chromaLog;
  t.after(async () => {
    let error;
    try { if (app) { app.prepareForShutdown(); await app.close(); } } catch (caught) { error = caught; }
    try { if (chromaHandle) await chromaHandle.close(); } catch (caught) { error ??= caught; }
    try {
      summary.runtimes = handles.map(handle => ({ alive: handle.isAlive(), identity: handle.processIdentity }));
      for (const handle of handles) {
        assert.equal(handle.isAlive(), false, 'Owned native/Chroma runtime remains alive');
        const pgid = handle.processIdentity?.pgid;
        if (pgid) assert.throws(() => process.kill(-pgid, 0), caught => caught.code === 'ESRCH', 'Owned process group remains alive');
      }
    } catch (caught) { error ??= caught; }
    if (chromaLog) await new Promise(resolve => chromaLog.end(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    summary.cleanupPassed = !error; summary.submissions = submissions;
    if (error) summary.cleanupError = String(error);
    await writeFile(path.join(root, 'qualification.json'), JSON.stringify(summary, null, 2));
    t.diagnostic(`Native recall providers=${JSON.stringify(summary.providers)}; submissions=${JSON.stringify(submissions)}; owned roots drained=${!error} (${handles.length})`);
    if (summary.passed && !error) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed native memory fixture retained: ${root}`);
    if (error) throw error;
  });
  for (const directory of ['working', 'tmp', 'cache', 'chroma-home']) await mkdir(path.join(root, directory));
  process.env.TMPDIR = path.join(root, 'tmp'); process.env.XDG_CACHE_HOME = path.join(root, 'cache');
  // Native HOME/auth stays unchanged. Only the separate disposable Chroma child
  // receives an empty HOME; no credentials, profiles or live memory are copied.
  const freePort = async () => {
    const server = createNetServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
  };
  const chromaPort = await freePort(), chromaUrl = `http://127.0.0.1:${chromaPort}`;
  const spawned = spawnContainedCli({ bin: chromaBin, args: ['run', '--path', path.join(root, 'chroma'), '--host', '127.0.0.1', '--port', String(chromaPort)], cwd: root,
    env: { PATH: process.env.PATH, HOME: path.join(root, 'chroma-home'), TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, ANONYMIZED_TELEMETRY: 'False' }, stdin: 'ignore' });
  chromaHandle = runtimeProcessHandle(spawned.child, { label: 'Disposable recall Chroma', termGraceMs: 3000 }, spawned.authority); handles.push(chromaHandle);
  chromaLog = createWriteStream(path.join(root, 'chroma.log'));
  for (const stream of [spawned.child.stdout, spawned.child.stderr]) stream?.pipe(chromaLog, { end: false });
  await until(async () => { assert.equal(spawned.child.exitCode, null, 'Owned Chroma exited'); try { return (await fetch(`${chromaUrl}/api/v2/heartbeat`)).ok; } catch { return false; } }, 'owned Chroma heartbeat', 30000);
  const port = await freePort(); assert.notEqual(port, 8787);
  const baseUrl = `http://127.0.0.1:${port}`, messageUrl = `${baseUrl}/api/agent-messages`;
  const query = `Qualification atlas ${randomUUID()}`, chatCode = `chat-${randomUUID()}`, globalCode = `global-${randomUUID()}`;
  const chatFact = `${query}. The Chat code is ${chatCode}.`, globalFact = `${query}. The global code is ${globalCode}.`;
  const observe = options => ({ ...options, onRuntimeSpawned: handle => { if (!handles.includes(handle)) handles.push(handle); options?.onRuntimeSpawned?.(handle); } });
  const assertBlind = value => { const text = JSON.stringify(value); assert.ok(!text.includes(chatCode) && !text.includes(globalCode), 'Seeded answers leaked into initial native input'); };
  const registrations = defaultEngineRegistrations(process.env).filter(value => ['codex', 'claude'].includes(value.adapter.id)).map(registration => {
    assert.equal(registration.isInstalled(), true, `Existing ${registration.adapter.id} CLI is required`);
    const native = registration.adapter, adapter = Object.create(native);
    for (const method of ['discoverModelCatalog', 'capabilities', 'validateModel']) if (typeof native[method] === 'function') adapter[method] = (...args) => { const index = method === 'validateModel' ? 2 : 1; args[index] = observe(args[index]); return native[method](...args); };
    adapter.openSession = async options => {
      assert.equal(await realpath(options.cwd), working); assert.equal(options.environment?.PONDEROSA_AGENT_MESSAGE_URL, messageUrl);
      assertBlind({ history: options.history, systemPrompt: options.systemPrompt });
      const session = await native.openSession(observe(options));
      for (const method of ['startTurn', 'steer']) { const original = session[method].bind(session); session[method] = async input => { assert.equal(method, 'startTurn', 'No native steering is authorized'); assert.ok(!submissions.some(value => value.engine === native.id), 'Only one native turn per engine is authorized'); assertBlind(input); submissions.push({ engine: native.id, method }); return original(input); }; }
      return session;
    };
    return { ...registration, adapter, authStatus: options => registration.authStatus(observe(options)), availabilityProbe: options => registration.availabilityProbe(observe(options)) };
  });
  assert.deepEqual(registrations.map(value => value.adapter.id).sort(), ['claude', 'codex']);
  app = createServer({ dataDir: path.join(root, 'data'), logger: false, allowedBrowseRoots: [root], engines: registrations, agentBaseUrl: baseUrl,
    communicationV3: { pollMs: 100, maxConcurrentRuns: 1 }, localMemory: { chromaUrl, collectionPrefix: `native_recall_${randomUUID().replaceAll('-', '')}`, modelDir, stateDirectory: path.join(root, 'policy'), provision: true } });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/api/agent-local-memory') searches.push({ input: request.body, status: reply.statusCode, output: typeof payload === 'string' ? JSON.parse(payload) : payload });
    return payload;
  });
  assert.equal(await app.listen({ host: '127.0.0.1', port }), baseUrl); assert.equal(app.server.address().port, port);
  summary.callback = messageUrl; summary.chromaUrl = chromaUrl; summary.query = query;
  const api = async (method, url, payload, headers = {}) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `HTTP ${response.statusCode}: ${response.body}`); return response.json();
  };
  const chat = await api('POST', '/api/chats', { label: 'Native memory recall', hostPath: working, defaultEngine: 'codex' }, { 'idempotency-key': randomUUID() });
  assert.equal(await realpath((await api('GET', `/api/projects/${chat.projectId}`)).hostPath), working);
  const memory = localMemoryFor(app); assert.ok(memory); await memory.ready();
  // Reuse the host's public core operation under explicit synthetic operator
  // authority. AuthorityStorage stamps provenance and real ONNX embeds both facts.
  const seed = async (scope, text) => memory.core.database.run({ chatId: chat.id, actor: { kind: 'user', id: memory.principalId }, runId: `fixture-seed:${randomUUID()}`, fenceToken: 'fixture-seed', sourceType: 'user_statement', readChat: true, readGlobal: scope === 'global', writeScope: scope, visibility: 'team', guard: async () => {} }, () => memory.core.open(scope).call('store', { text, source_type: 'user_statement' }));
  const chatSeed = await seed(`chat:${chat.id}`, chatFact), globalSeed = await seed('global', globalFact);
  assert.equal(chatSeed.stored, true); assert.equal(globalSeed.stored, true);
  await api('PUT', `/api/local-memory/grants/${chat.id}`, { readGlobal: true, expectedRevision: 0 });
  summary.seeds = [{ scope: `chat:${chat.id}`, id: chatSeed.chunk_id, text: chatFact }, { scope: 'global', id: globalSeed.chunk_id, text: globalFact }];
  const jsonl = async filename => (await readFile(filename, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  for (const engine of ['codex', 'claude']) {
    const agent = await api('POST', `/api/projects/${chat.projectId}/agents`, { title: `Native ${engine} recall`, engine, conversationId: chat.id, idempotencyKey: randomUUID() });
    const before = searches.length;
    await api('POST', `/api/agents/${agent.id}/messages`, { text: `Call ponderosa_local_memory_search exactly once with query ${JSON.stringify(query)} and top_k 20, omitting source so both authorized Chat and global memory are searched together. Read the two returned facts. Then call ponderosa_message exactly once with intent direct_to_user and text RECALL|<Chat code>|<global code>, replacing the placeholders with the codes found only in those results. End the turn. If either call errors, stop without retry. Do not guess, issue another search, save/update/forget memory, use files, shell, browser, network, other connectors, provider-native helpers, or create/contact Agents.`, idempotencyKey: randomUUID() });
    const detail = await until(async () => { const value = await api('GET', `/api/agents/${agent.id}`); return value.runs.length && value.runs.every(run => !['preparing', 'running', 'queued'].includes(run.status)) ? value : false; }, `native ${engine} recall`, 150000);
    assert.equal(detail.runs.length, 1); assert.equal(detail.runs[0].status, 'completed');
    assert.deepEqual(submissions.filter(value => value.engine === engine).map(value => value.method), ['startTurn']);
    const calls = searches.slice(before); assert.equal(calls.length, 1); assert.equal(calls[0].status, 200);
    assert.equal(calls[0].input.operation, 'search'); assert.equal(calls[0].input.query, query); assert.equal(calls[0].input.top_k, 20); assert.ok(!Object.hasOwn(calls[0].input, 'source'));
    const rows = calls[0].output.structuredContent.result; assert.ok(Array.isArray(rows));
    for (const expected of summary.seeds) assert.ok(rows.some(row => row.memory_scope === expected.scope && row.chunk_id === expected.id && row.text === expected.text), 'Combined native search did not return both exact seeded sources');
    const audit = (await jsonl(path.join(root, 'data', 'projects', chat.projectId, 'agents', agent.id, 'events.jsonl'))).map(row => row.event);
    const activity = audit.filter(event => ['tool_call', 'command', 'file_change'].includes(event.type));
    const name = operation => engine === 'claude' ? `mcp__ponderosa__${operation}` : `ponderosa_${operation}`;
    const searchCalls = activity.filter(event => event.type === 'tool_call' && event.name === name('local_memory_search'));
    const messageCalls = activity.filter(event => event.type === 'tool_call' && event.name === name('message'));
    const discovery = activity.filter(event => event.type === 'tool_call' && event.name === 'ToolSearch' && typeof event.input.query === 'string' && event.input.query.startsWith('select:') && event.input.query.slice(7).split(/[\s,]+/).every(value => ['mcp__ponderosa__local_memory_search', 'mcp__ponderosa__message'].includes(value)));
    assert.equal(searchCalls.length, 1); assert.equal(messageCalls.length, 1); assert.equal(activity.length, 2 + discovery.length, 'Unrelated native tool activity');
    assert.equal(searchCalls[0].input.query, query); assert.ok(!Object.hasOwn(searchCalls[0].input, 'source'));
    for (const call of [...searchCalls, ...messageCalls]) { const results = audit.filter(event => event.type === 'tool_result' && event.id === call.id); assert.equal(results.length, 1); assert.ok(!results[0].isError); }
    const expected = `RECALL|${chatCode}|${globalCode}`;
    const authored = await jsonl(path.join(root, 'data', 'projects', chat.projectId, 'communication-events.jsonl'));
    const replies = authored.filter(event => event.sender.agentId === agent.id); assert.equal(replies.length, 1); assert.equal(replies[0].text, expected);
    assert.equal(replies[0].intent, 'user_dm'); assert.equal(replies[0].audience.kind, 'user_agent'); assert.equal(replies[0].audience.agentId, agent.id); assert.equal(deriveCommunicationBehavior(replies[0]).contextPolicy, 'local_only');
    assert.ok(detail.messages.some(message => message.communicationEventId === replies[0].eventId && message.text === expected));
    assert.ok(!authored.some(event => event.intent === 'broadcast' && (event.text.includes(chatCode) || event.text.includes(globalCode))));
    const turns = audit.filter(event => event.type === 'turn_done').length; assert.equal(turns, 1);
    summary.providers.push({ engine, runId: detail.runs[0].id, searches: 1, returnedScopes: rows.map(row => row.memory_scope), managedMessages: 1, discoveries: discovery.length, nativeTopKType: typeof searchCalls[0].input.top_k, hostTopK: calls[0].input.top_k, hostResultKeys: Object.keys(calls[0].output).sort(), resultRowKeys: [...new Set(rows.flatMap(Object.keys))].sort(), turns });
  }
  assert.equal(submissions.length, 2); assert.equal(searches.length, 2);
  summary.passed = true;
});
