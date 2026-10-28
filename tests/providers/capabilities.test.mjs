import test from 'node:test';
import assert from 'node:assert/strict';
import { composerCapabilities, parseCodexMcpList } from '@ponderosa/engines';
import { discoverCliMcps, parseCodexMcpDiscovery } from '../../packages/engines/dist/capabilities.js';

test('check 24: configured but unusable MCP is not presented as an available composer connector', () => {
  const configured = parseCodexMcpList(JSON.stringify([{ name: 'fixture', enabled: true }]));
  assert.equal(configured[0].configured, true); assert.equal(configured[0].usable, false);
  assert.deepEqual(composerCapabilities([], [], configured, '$'), []);
});
test('check 25: provider failure prose does not become a configured MCP server', () => {
  assert.deepEqual(parseCodexMcpList('Error: authentication failed while listing MCP servers'), []);
});


test('MCP discovery preserves JSON configured/disabled state without claiming usability', () => {
  const entries = parseCodexMcpList(JSON.stringify([
    { name: 'enabled', enabled: true, transport: { type: 'stdio', command: 'fixture' } },
    { name: 'disabled', enabled: false, disabled_reason: 'Fixture policy' },
    { name: 'disabled-default', enabled: false },
  ]));
  assert.deepEqual(entries.map(x => x.name), ['enabled', 'disabled', 'disabled-default']);
  assert.ok(entries.every(x => x.configured && !x.usable && !x.toolsDiscovered && x.initialization === 'not_initialized'));
  assert.equal(entries[1].detail, 'Fixture policy');
  assert.equal(entries[2].detail, 'Disabled in the provider configuration');
  assert.deepEqual(parseCodexMcpDiscovery('[]'), []);
  assert.deepEqual(parseCodexMcpDiscovery('No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.'), []);
});

test('MCP discovery accepts supported legacy transport tables and retains disabled reasons', () => {
  const legacy = 'Name  Command  Args  Env\nfixture  node  --fixture  -';
  assert.equal(parseCodexMcpDiscovery(legacy)[0].name, 'fixture');
  const tables = 'Name  Command  Args  Env  Cwd  Status  Auth\nlocal  node  --fixture  -  -  enabled  Unsupported\n\nName  Url  Bearer Token Env Var  Status  Auth\nremote  https://fixture.invalid  -  disabled: Fixture policy  Unsupported';
  const entries = parseCodexMcpDiscovery(tables);
  assert.deepEqual(entries.map(x => x.name), ['local', 'remote']);
  assert.ok(entries.every(x => x.configured && !x.usable));
  assert.equal(entries[1].detail, 'Fixture policy');
  const header=['Name','Command','Args','Env','Cwd','Status','Auth'];
  const row=['with-spaces','node','one  two','-','-','enabled','Unsupported'];
  const widths=header.map((cell,index)=>Math.max(cell.length,row[index].length));
  const render=cells=>cells.map((cell,index)=>cell.padEnd(widths[index])).join('  ');
  assert.equal(parseCodexMcpDiscovery(render(header)+'\n'+render(row))[0].name,'with-spaces');
});

test('diagnostic prose, malformed JSON and malformed table rows are never successful MCP inventories', () => {
  for (const output of ['Error: authentication failed while listing MCP servers', 'Warning: discovery unavailable', 'No MCP servers configured because authentication failed',
    '', '{bad', '{}', '[null]', '[{"name":"Error: authentication failed"}]', '[{"name":""}]', '[{"name":"fixture","enabled":"false"}]',
    'fixture  node  --fixture  -', 'Name  Command  Args  Env\nError:  authentication failed',
    'Name  Command  Args  Env\nError:  authentication  failed  now']) {
    assert.deepEqual(parseCodexMcpList(output), [], output);
    assert.throws(() => parseCodexMcpDiscovery(output), /invalid inventory/, output);
  }
});

for (const managed of [false, true]) test('CLI MCP '+(managed ? 'managed' : 'ordinary')+' discovery reports failures and separates stderr from inventory', async () => {
  const handles = [], controller = new AbortController();
  const lifecycle = managed ? { signal: controller.signal, onRuntimeSpawned: h => handles.push(h) } : undefined;
  const invoke = script => discoverCliMcps(process.execPath, ['-e', script], process.cwd(), parseCodexMcpDiscovery, lifecycle);
  const result = await invoke('process.stdout.write(JSON.stringify([{name:"fixture",enabled:true}]));process.stderr.write("Warning: fixture diagnostic");');
  assert.equal(result[0].name, 'fixture'); assert.equal(result[0].usable, false);
  assert.deepEqual(await invoke('process.stdout.write("[]");process.stderr.write("Warning: fixture diagnostic");'), []);
  await assert.rejects(invoke('process.stdout.write("[]");process.stderr.write("Error: authentication failed");process.exitCode=7;'), /MCP discovery failed/);
  await assert.rejects(invoke('process.stdout.write("Error: authentication failed while listing MCP servers");'), /invalid inventory/);
  await assert.rejects(invoke('process.stdout.write("{malformed");'), /invalid inventory/);
  await assert.rejects(discoverCliMcps('nonexistent-fixture-cli-'+process.pid, [], process.cwd(), parseCodexMcpDiscovery, lifecycle), /MCP discovery failed/);
  assert.ok(handles.every(handle => !handle.isAlive()), 'Discovery retained a live owned root');
});

test('aborted managed MCP discovery reports cancellation and observes owned root exit', async () => {
  const controller = new AbortController(), handles = [];
  const task = discoverCliMcps(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), parseCodexMcpDiscovery, {
    signal: controller.signal, onRuntimeSpawned: handle => { handles.push(handle); queueMicrotask(() => controller.abort()); },
  });
  await assert.rejects(task, /MCP discovery aborted/);
  assert.ok(handles.every(handle => !handle.isAlive()));
});

test('Codex occupancy and capacity observations stay with their exact provider thread', async () => {
  const { CodexAppServerSession } = await import('../../packages/engines/dist/codex-app-server.js');
  const session = Object.create(CodexAppServerSession.prototype);
  session.engineAgentId = 'owned-generation';
  let observed = 0;
  session.contextUsageGate = { observe: () => observed++ };
  session.nativeCommandNotifications = new WeakSet();
  const usage = threadId => ({ method: 'thread/tokenUsage/updated', params: {
    threadId, turnId: 'turn', tokenUsage: { total: { totalTokens: 900000 },
      last: { totalTokens: 1200 }, modelContextWindow: 200000 },
  } });
  for (const id of ['foreign-generation', undefined]) session.observeNotification(usage(id));
  assert.equal(session.contextUsage(), undefined);
  assert.equal(observed, 0);
  session.observeNotification(usage('owned-generation'));
  assert.deepEqual(session.contextUsage(), { usedTokens: 1200, aggregateTokens: 900000,
    windowTokens: 200000, providerSessionGeneration: 'owned-generation' });
  assert.equal(observed, 1);
  session.observeNotification(usage('foreign-generation'));
  assert.equal(session.contextUsage().usedTokens, 1200);
  assert.equal(observed, 1);
});


test('Claude context includes actual request-local output while missing output stays an explicit partial checkpoint', async () => {
  const { ClaudeContextUsage } = await import('../../packages/engines/dist/claude-context-usage.js');
  const { projectAgentEvent } = await import('../../packages/engines/dist/agent-event-projection.js');
  const { projectProviderContextUsage } = await import('../../apps/server/dist/provider-success-projection.js');
  const observations = new ClaudeContextUsage('owned-claude-generation');
  observations.beginTurn('submission');
  observations.observe({ type: 'user', uuid: 'submission', session_id: 'owned-claude-generation', parent_tool_use_id: null, message: { role: 'user' } });
  const assistant = (id, usage) => ({ type: 'assistant', session_id: 'owned-claude-generation', parent_tool_use_id: null,
    message: { role: 'assistant', id, model: 'fixture', usage } });
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 30 };
  assert.equal(observations.observe({ type: 'result', session_id: 'owned-claude-generation', usage: { input_tokens: 900000, output_tokens: 900000 } }), undefined);
  const measured = observations.observe(assistant('request-one', usage));
  assert.equal(measured.usedTokens, 160); assert.equal(measured.requestOutputIncluded, true);
  assert.equal(projectAgentEvent(measured).requestOutputIncluded, true);
  assert.deepEqual(projectProviderContextUsage(observations.contextUsage()), {
    usedTokens: 160, providerSessionGeneration: 'owned-claude-generation', requestOutputIncluded: true,
  });
  assert.equal(observations.observe(assistant('request-one', { ...usage, output_tokens: 99999 })), undefined, 'Replayed request cannot change occupancy');
  const partial = observations.observe(assistant('request-two', { input_tokens: 11, cache_read_input_tokens: 101, cache_creation_input_tokens: 21 }));
  assert.equal(partial.usedTokens, 133); assert.equal(partial.requestOutputIncluded, false);
  assert.equal(observations.contextUsage().requestOutputIncluded, false);
  for (const output_tokens of [-1, 1.5, '30', Number.POSITIVE_INFINITY]) {
    assert.equal(observations.observe(assistant('bad-' + output_tokens, { ...usage, output_tokens })), undefined);
  }
  assert.equal(observations.contextUsage().usedTokens, 133);
});


function nativeCompactSession() {
  const session = Object.create(CodexAppServerSessionForTest.prototype);
  session.engineAgentId = 'compact-owned-generation';
  session.contextUsageGate = new ContextUsageGateForTest();
  session.nativeCommandNotifications = new WeakSet();
  session.latestContextUsage = { usedTokens: 160000, modelContextWindow: 200000 };
  session.capabilities = async () => ({ commands: [{ name: 'compact', invocation: 'runtime', status: 'available' }] });
  session.rpc = { request: async () => ({}), close: async () => {} };
  session.usageByTurnId = new Map(); session.providerRequestUsageByTurnId = new Map(); session.usageCheckpointsByTurnId = new Map();
  session.seedHistory = []; session.cwd = '/owned-fixture';
  return session;
}
const { CodexAppServerSession: CodexAppServerSessionForTest, ContextUsageObservationGate: ContextUsageGateForTest } = await import('../../packages/engines/dist/codex-app-server.js');
const compactNotice = (session, method, params) => session.observeNotification({ method, params: { threadId: session.engineAgentId, ...params } });
const compactTurn = (session, status = 'completed') => {
  compactNotice(session, 'turn/started', { turn: { id: 'owned-native-turn' } });
  compactNotice(session, 'item/started', { turnId: 'owned-native-turn', item: { type: 'contextCompaction', id: 'owned-native-item' } });
  compactNotice(session, 'item/completed', { turnId: 'owned-native-turn', item: { type: 'contextCompaction', id: 'owned-native-item' } });
  compactNotice(session, 'turn/completed', { turn: { id: 'owned-native-turn', status } });
};
const compactUsage = (session, turnId = 'owned-native-turn', threadId = session.engineAgentId) => compactNotice(session, 'thread/tokenUsage/updated', {
  threadId, turnId, tokenUsage: { last: { totalTokens: 25000 }, modelContextWindow: 200000 },
});

test('native Codex compact requires exact item and terminal completion before fresh telemetry', async () => {
  const session = nativeCompactSession(); let rpcs = 0, settled = false;
  session.lastCompletedTurnId = 'previous-turn';
  session.rpc.request = async (method, input) => { assert.equal(method, 'thread/compact/start'); assert.equal(input.threadId, session.engineAgentId); rpcs++; return {}; };
  const command = session.invokeCommand('compact').then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'The immediate RPC acknowledgement is not completion');
  compactUsage(session, 'previous-turn');
  compactNotice(session, 'turn/started', { turn: { id: 'previous-turn' } });
  compactNotice(session, 'item/completed', { turnId: 'previous-turn', item: { type: 'contextCompaction', id: 'old-item' } });
  compactNotice(session, 'turn/completed', { turn: { id: 'previous-turn', status: 'completed' } });
  compactNotice(session, 'turn/started', { threadId: 'foreign-thread', turn: { id: 'foreign-turn' } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  compactNotice(session, 'turn/started', { turn: { id: 'owned-native-turn' } });
  compactNotice(session, 'item/started', { turnId: 'owned-native-turn', item: { type: 'contextCompaction', id: 'owned-native-item' } });
  compactUsage(session); // Summarizer telemetry before completion is not post-Compact occupancy.
  compactNotice(session, 'item/completed', { turnId: 'owned-native-turn', item: { type: 'contextCompaction', id: 'wrong-item' } });
  compactNotice(session, 'turn/completed', { turn: { id: 'unrelated-turn', status: 'completed' } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  compactNotice(session, 'item/completed', { turnId: 'owned-native-turn', item: { type: 'contextCompaction', id: 'owned-native-item' } });
  compactNotice(session, 'turn/completed', { turn: { id: 'owned-native-turn', status: 'completed' } });
  compactUsage(session, 'foreign-turn'); compactUsage(session, 'owned-native-turn', 'foreign-thread');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'Unrelated or pre-completion usage is not fresh command proof');
  compactUsage(session);
  assert.deepEqual(await command, { outcome: 'completed', contextUsage: { usedTokens: 25000, windowTokens: 200000, providerSessionGeneration: session.engineAgentId } });
  assert.equal(rpcs, 1);
});

for (const mode of ['no_ack', 'ack_only', 'completed_no_usage', 'missing_item']) test(`native Codex compact reports ${mode} honestly without replay`, async () => {
  const session = nativeCompactSession(); let rpcs = 0;
  session.rpc.request = () => {
    rpcs++;
    if (mode === 'no_ack') return new Promise(() => {});
    if (mode === 'completed_no_usage') compactTurn(session);
    if (mode === 'missing_item') {
      compactNotice(session, 'turn/started', { turn: { id: 'owned-native-turn' } });
      compactNotice(session, 'turn/completed', { turn: { id: 'owned-native-turn', status: 'completed' } });
      compactUsage(session);
    }
    return Promise.resolve({});
  };
  session.contextUsageGate.waitAfter = async () => { throw Error('Controlled native observation deadline'); };
  const result = await session.invokeCommand('compact');
  assert.equal(result.contextUsage, undefined); assert.match(result.message, /do not repeat/i); assert.equal(rpcs, 1);
  assert.equal(result.outcome, mode === 'completed_no_usage' ? 'completed' : 'outcome_unknown');
  if (mode !== 'completed_no_usage') assert.doesNotMatch(result.message, /compaction completed/i);
  if (mode === 'ack_only' || mode === 'no_ack') {
    await assert.rejects(session.invokeCommand('compact'), /already in progress/);
    await assert.rejects(session.startTurn({ prompt: 'Do not overlap native work' }), /still in progress/);
    assert.equal(rpcs, 1);
  }
});

test('post-item compact telemetry waits for its exact successful terminal turn', async () => {
  const session = nativeCompactSession(); let settled = false;
  const pending = session.invokeCommand('compact').then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  compactNotice(session, 'turn/started', { turn: { id: 'owned-native-turn' } });
  compactNotice(session, 'item/started', { turnId: 'owned-native-turn', item: { type: 'contextCompaction', id: 'owned-native-item' } });
  compactNotice(session, 'item/completed', { turnId: 'owned-native-turn', item: { type: 'contextCompaction', id: 'owned-native-item' } });
  compactUsage(session); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  compactNotice(session, 'turn/completed', { turn: { id: 'owned-native-turn', status: 'completed' } });
  const result = await pending; assert.equal(result.outcome, 'completed'); assert.equal(result.contextUsage.usedTokens, 25000);
});

for (const status of ['failed', 'interrupted', 'unknown']) test(`native Codex compact preserves ${status} terminal outcome`, async () => {
  const session = nativeCompactSession(); session.rpc.request = async () => { compactTurn(session, status); return {}; };
  const result = await session.invokeCommand('compact');
  assert.equal(result.outcome, status === 'unknown' ? 'outcome_unknown' : 'failed'); assert.equal(result.contextUsage, undefined); assert.match(result.message, /do not repeat/i);
});

test('native Codex compact shutdown wakes the existing wait without claiming completion', async () => {
  const session = nativeCompactSession(); let closed = 0; session.rpc.close = async () => { closed++; };
  const pending = session.invokeCommand('compact'); await new Promise(resolve => setImmediate(resolve));
  await session.close(); const result = await pending;
  assert.equal(closed, 1); assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.contextUsage, undefined);
});

test('two completed native compacts cannot finish or charge the next warm ordinary turn', async () => {
  const session = nativeCompactSession(), queue = []; let compacts = 0;
  const emit = (method, params) => { const n = { method, params: { threadId: session.engineAgentId, ...params } }; session.observeNotification(n); queue.push(n); };
  session.rpc.notifications = { async *[Symbol.asyncIterator]() { yield* queue; } };
  session.rpc.request = async method => {
    if (method === 'turn/start') return { turn: { id: 'ordinary-followup' } };
    assert.equal(method, 'thread/compact/start'); const turnId = 'native-' + ++compacts, id = 'compact-item-' + compacts;
    emit('turn/started', { turn: { id: turnId } });
    emit('item/started', { turnId, item: { id, type: 'contextCompaction' } });
    emit('item/completed', { turnId, item: { id, type: 'contextCompaction' } });
    emit('thread/tokenUsage/updated', { turnId, tokenUsage: { last: { inputTokens: 24000, outputTokens: 1000, totalTokens: 25000 },
      total: { inputTokens: compacts * 24000, outputTokens: compacts * 1000, totalTokens: compacts * 25000 }, modelContextWindow: 200000 } });
    emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
    return {};
  };
  assert.equal((await session.invokeCommand('compact')).outcome, 'completed');
  assert.equal((await session.invokeCommand('compact')).outcome, 'completed');
  await session.startTurn({ prompt: 'A separate ordinary task' });
  emit('turn/started', { turn: { id: 'ordinary-followup' } });
  emit('thread/tokenUsage/updated', { turnId: 'ordinary-followup', tokenUsage: { last: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
    total: { inputTokens: 48900, outputTokens: 2100, totalTokens: 51000 }, modelContextWindow: 200000 } });
  emit('turn/completed', { turn: { id: 'ordinary-followup', status: 'completed' } });
  const events = []; for await (const event of session.eventStream()) events.push(event);
  const terminals = events.filter(event => event.type === 'turn_done');
  assert.equal(terminals.length, 1, 'Native completion is never the next Agent Run completion');
  assert.equal(terminals[0].usage.totalTokens, 1000, 'Native usage is not billed to later ordinary work');
  assert.equal(events.filter(event => event.type === 'context_usage').length, 1);
});

test('native command outcome stays closed and invalid telemetry cannot imply completion', async () => {
  const { projectProviderCommandResult } = await import('../../apps/server/dist/provider-success-projection.js');
  assert.equal(projectProviderCommandResult({ outcome: 'outcome_unknown' }).outcome, 'outcome_unknown');
  assert.throws(() => projectProviderCommandResult({ outcome: 'invented' }));
  const malformed = projectProviderCommandResult({ outcome: 'completed', contextUsage: { usedTokens: 'invalid' } });
  assert.equal(malformed.contextUsage, undefined); assert.match(malformed.message, /invoked.*invalid.*not repeat/i);
});

test('sparse and future Codex native work invalidates context estimates without exposing payloads', async () => {
  const { mapCodexAppServerNotification, projectAgentEvent } = await import('@ponderosa/engines');
  const { envelope } = await import('../../apps/server/dist/sse.js');
  const fences = events => events.some(e => ['work_start', 'tool_call', 'tool_result', 'command', 'file_change'].includes(e.type));
  const map = (method, item) => mapCodexAppServerNotification({ method, params: { item } }, '/fixture');
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
    'functionCallOutput', 'webSearch', 'imageView', 'collabToolCall', 'enteredReviewMode',
    'exitedReviewMode', 'hookPrompt', 'sleep', 'imageGeneration', 'futureNativeTool']) {
    for (const method of ['item/started', 'item/completed']) {
      const events = map(method, { type, id: 'owned', text: 'PRIVATE NATIVE BYTES' });
      assert.ok(fences(events), `${type} ${method} cannot be counted as known plain text`);
      for (const event of events) {
        assert.deepEqual(projectAgentEvent(event), event);
        if (event.type === 'work_start') {
          assert.ok(!JSON.stringify(event).includes('PRIVATE NATIVE BYTES'));
          assert.equal(envelope('owned-agent', { seq: 1, ts: '2026-10-27T00:00:00Z', event: { ...event, executionId: 'owned-run' } }), undefined);
        }
      }
    }
  }
  for (const item of [undefined, null, [], 'private raw', {}, { type: 7 }]) assert.ok(fences(map('item/started', item)));
  for (const type of ['agentMessage', 'reasoning', 'plan', 'userMessage', 'contextCompaction']) {
    assert.equal(fences(map('item/started', { type, id: 'passive' })), false);
  }
  const ordinary = map('item/started', { type: 'commandExecution', id: 'cmd', command: 'inert' });
  assert.deepEqual(ordinary.filter(e => e.type !== 'work_start'), [{ type: 'command', command: 'inert', cwd: '/fixture', callId: 'cmd' }]);
  assert.deepEqual(map('item/completed', { type: 'fileChange', id: 'edit', changes: [{ path: 'fixture.txt', kind: 'edit', diff: 'inert' }] }).filter(e => e.type !== 'work_start'),
    [{ type: 'file_change', path: 'fixture.txt', kind: 'edit', diff: 'inert', callId: 'edit' }]);
});

test('internal native-work projection rejects payloads and accessor fields', async () => {
  const { projectAgentEvent } = await import('@ponderosa/engines');
  assert.deepEqual(projectAgentEvent({ type: 'work_start', kind: 'native_tool' }), { type: 'work_start', kind: 'native_tool' });
  for (const patch of [{ text: 'private' }, { itemType: 'webSearch' }, { kind: 'future' }]) {
    assert.throws(() => projectAgentEvent({ type: 'work_start', kind: 'native_tool', ...patch }));
  }
  let reads = 0;
  assert.throws(() => projectAgentEvent({ type: 'work_start', kind: 'native_tool', get callId() { reads++; return 'secret'; } }));
  assert.equal(reads, 0);
});
