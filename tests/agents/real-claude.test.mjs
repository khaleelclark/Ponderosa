import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Uses the existing native account/profile only when explicitly requested.
const enabled = process.env.PONDEROSA_REGRESSION_REAL_CLAUDE === '1';
test('real Claude sends one private READY message and drains its owned runtimes', {
  timeout: 300000,
  skip: !enabled ? 'Set PONDEROSA_REGRESSION_REAL_CLAUDE=1 with existing permitted Claude access' : false,
}, async t => {
  const { defaultEngineRegistrations } = await import('@ponderosa/engines');
  const { deriveCommunicationBehavior } = await import('@ponderosa/core');
  const { createServer } = await import('../../apps/server/dist/app.js');
  const { until } = await import('../shared/fixture.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-real-claude-'));
  const working = path.join(root, 'working'), handles = [], submissions = [];
  let app, passed = false;
  t.after(async () => {
    let drained = false;
    try {
      if (app) { app.prepareForShutdown(); await app.close(); }
      for (const handle of handles) {
        assert.equal(handle.isAlive(), false, 'Owned Claude runtime remains alive');
        const pgid = handle.processIdentity?.pgid;
        if (pgid) assert.throws(() => process.kill(-pgid, 0), error => error.code === 'ESRCH', 'Owned Claude process group remains alive');
      }
      drained = true;
    } finally {
      t.diagnostic(`Claude submissions: ${JSON.stringify(submissions)}; observed shutdown of ${handles.length} owned runtime(s)`);
      if (passed && drained) await rm(root, { recursive: true, force: true });
      else t.diagnostic(`Failed real-Claude fixture retained: ${root}`);
    }
  });
  await mkdir(working);

  // Configure the native MCP callback before dispatch. Never use the default
  // service endpoint: unlike Codex, Claude's managed tools call back over HTTP.
  const reservation = createNetServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  assert.notEqual(port, 8787);
  const baseUrl = `http://127.0.0.1:${port}`, messageUrl = `${baseUrl}/api/agent-messages`;
  const registration = defaultEngineRegistrations(process.env).find(value => value.adapter.id === 'claude');
  assert.ok(registration); assert.equal(registration.isInstalled(), true, 'Existing Claude CLI is required');
  const observe = options => ({ ...options, onRuntimeSpawned: handle => {
    if (!handles.includes(handle)) handles.push(handle);
    options?.onRuntimeSpawned?.(handle);
  } });
  const native = registration.adapter, adapter = Object.create(native);
  // Include any native discovery/auth helpers in the same observed drain oracle.
  for (const method of ['discoverModelCatalog', 'capabilities', 'validateModel']) {
    adapter[method] = (...args) => { const index = method === 'validateModel' ? 2 : 1; args[index] = observe(args[index]); return native[method](...args); };
  }
  adapter.openSession = async options => {
    assert.equal(await realpath(options.cwd), await realpath(working));
    assert.equal(options.environment?.PONDEROSA_AGENT_MESSAGE_URL, messageUrl, 'Native callback must target this fixture');
    const session = await native.openSession(observe(options));
    for (const method of ['startTurn', 'steer']) {
      const original = session[method].bind(session);
      session[method] = async input => { submissions.push(method); return original(input); };
    }
    return session;
  };
  app = createServer({ dataDir: path.join(root, 'data'), logger: false, allowedBrowseRoots: [root], agentBaseUrl: baseUrl,
    engines: [{ ...registration, adapter, authStatus: options => registration.authStatus(observe(options)),
      availabilityProbe: options => registration.availabilityProbe(observe(options)) }],
    communicationV3: { pollMs: 100, maxConcurrentRuns: 1 } });
  assert.equal(await app.listen({ host: '127.0.0.1', port }), baseUrl);
  assert.equal(app.server.address().port, port);
  t.diagnostic(`Owned Claude callback: ${messageUrl}`);
  const api = async (method, url, payload, headers = {}) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `HTTP ${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const chat = await api('POST', '/api/chats', { label: 'Native Claude READY regression', hostPath: working, defaultEngine: 'claude' }, { 'idempotency-key': randomUUID() });
  const project = await api('GET', `/api/projects/${chat.projectId}`);
  assert.equal(await realpath(project.hostPath), await realpath(working));
  const agent = await api('POST', `/api/projects/${chat.projectId}/agents`, { title: 'Synthetic READY', engine: 'claude', conversationId: chat.id, idempotencyKey: randomUUID() });
  const nonce = `READY:${randomUUID()}`;
  await api('POST', `/api/agents/${agent.id}/messages`, { text: `Call exactly once the Ponderosa communication tool ponderosa_message with intent direct_to_user and text exactly ${nonce}. This is your complete task. End the turn after that one call. Do not use files, shell, browser, network, connectors, provider-native helpers, or create/contact Agents.`, idempotencyKey: randomUUID() });
  const detail = await until(async () => {
    const value = await api('GET', `/api/agents/${agent.id}`);
    return value.runs.length && value.runs.every(run => !['running', 'preparing', 'queued'].includes(run.status)) ? value : false;
  }, 'real Claude READY result', 150000);
  assert.equal(detail.runs.length, 1); assert.ok(detail.runs.every(run => run.status === 'completed'));
  assert.deepEqual(submissions, ['startTurn']);

  const jsonl = async filename => (await readFile(filename, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const authored = await jsonl(path.join(root, 'data', 'projects', chat.projectId, 'communication-events.jsonl'));
  const replies = authored.filter(event => event.sender.agentId === agent.id);
  assert.equal(replies.length, 1); assert.equal(replies[0].text, nonce);
  assert.equal(replies[0].intent, 'user_dm'); assert.equal(replies[0].audience.kind, 'user_agent'); assert.equal(replies[0].audience.agentId, agent.id);
  assert.ok(detail.messages.some(message => message.role === 'assistant' && message.text === nonce && message.communicationEventId === replies[0].eventId), 'Private Agent READY projection is missing');
  assert.equal(deriveCommunicationBehavior(replies[0]).contextPolicy, 'local_only');
  assert.ok(!authored.some(event => event.intent === 'broadcast' && event.text.includes(nonce)), 'READY became an organizational Broadcast');
  const conversation = await api('GET', `/api/conversations/${chat.id}`);
  // Operator Chat intentionally renders DMs; its presentation must preserve scope.
  const operatorRows = conversation.messages.filter(message => message.communicationEventId === replies[0].eventId);
  assert.equal(operatorRows.length, 1);
  for (const message of operatorRows) {
    assert.equal(message.communicationIntent, 'user_dm'); assert.equal(message.authoredText, nonce);
    assert.deepEqual(message.directMessageAgents.map(value => value.id), [agent.id]);
  }
  assert.equal((await api('GET', `/api/projects/${chat.projectId}/agents`)).length, 1);

  const audit = (await jsonl(path.join(root, 'data', 'projects', chat.projectId, 'agents', agent.id, 'events.jsonl'))).map(row => row.event);
  const activity = audit.filter(event => ['tool_call', 'command', 'file_change'].includes(event.type));
  const managed = activity.filter(event => event.type === 'tool_call' && event.name === 'mcp__ponderosa__message');
  const discovery = activity.filter(event => event.type === 'tool_call' && event.name === 'ToolSearch' && event.input.query === 'select:mcp__ponderosa__message');
  assert.equal(managed.length, 1); assert.equal(activity.length, managed.length + discovery.length, 'Unrelated native tool activity');
  assert.equal(managed[0].input.intent, 'direct_to_user'); assert.equal(managed[0].input.text, nonce);
  const receipts = audit.filter(event => event.type === 'tool_result' && event.id === managed[0].id);
  assert.equal(receipts.length, 1); assert.ok(!receipts[0].isError); assert.equal(JSON.parse(receipts[0].output).eventId, replies[0].eventId);
  const turns = audit.filter(event => event.type === 'turn_done').length;
  t.diagnostic(`Claude Runs=${detail.runs.length}; turn_done=${turns}; managed message calls=${managed.length}; native ToolSearch discoveries=${discovery.length}`);
  assert.equal(turns, 1);
  passed = true;
});
