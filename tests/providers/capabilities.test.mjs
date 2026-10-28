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

test('existing provider inventories retain bounded tool names/descriptions without changing usability or exact counts',async()=>{
 const {normalizeCodexProviderDiscovery,normalizeClaudeInitCapabilities}=await import('../../packages/engines/dist/capabilities.js');
 const {projectProviderCapabilities}=await import('../../apps/server/dist/provider-success-projection.js');
 const codex=normalizeCodexProviderDiscovery({cwd:process.cwd(),mcpStatuses:{data:[{name:'records',tools:{lookup:{name:'lookup',description:'Look up a record'}}}]}});
 assert.deepEqual(projectProviderCapabilities(codex).mcpServers[0].tools,[{name:'lookup',description:'Look up a record'}]);
 const claude=normalizeClaudeInitCapabilities({type:'system',subtype:'init',mcp_servers:[{name:'records',status:'connected'}],tools:[{name:'mcp__records__lookup',description:'Claude record lookup'},'mcp__records__list']});
 assert.deepEqual(projectProviderCapabilities(claude).mcpServers[0].tools,[{name:'mcp__records__lookup',description:'Claude record lookup'},{name:'mcp__records__list'}]);
 const inventory=Object.fromEntries(Array.from({length:1000},(_,i)=>['tool_'+i,{description:'x'.repeat(2000)}]));
 const large=projectProviderCapabilities(normalizeCodexProviderDiscovery({cwd:process.cwd(),mcpStatuses:{data:[{name:'large',tools:inventory},{name:'next',tools:inventory}]}}));
 assert.equal(large.mcpServers[0].toolCount,1000);assert.equal(large.mcpServers[1].toolCount,1000);assert.ok(large.mcpServers[0].tools.length>0&&large.mcpServers[0].tools.length<1000);assert.equal(large.mcpServers[1].tools.length,0);assert.ok(large.mcpServers.every(s=>s.usable));
 for(const name of ['a'.repeat(513),'bad\0name']){const normalized=projectProviderCapabilities(normalizeCodexProviderDiscovery({cwd:process.cwd(),mcpStatuses:{data:[{name:'odd',tools:{[name]:{description:'Diagnostic only'}}}]}}));assert.equal(normalized.mcpServers[0].toolCount,1);assert.equal(normalized.mcpServers[0].usable,true);assert.deepEqual(normalized.mcpServers[0].tools,[])}
 const oddDescription=projectProviderCapabilities(normalizeCodexProviderDiscovery({cwd:process.cwd(),mcpStatuses:{data:[{name:'odd',tools:{lookup:{description:'bad\0description'},unicode:{description:'🌲'.repeat(1000)}}}]}}));assert.deepEqual(oddDescription.mcpServers[0].tools[0],{name:'lookup'});assert.ok(oddDescription.mcpServers[0].tools[1].description.length<=513);
 const bad=structuredClone(codex);bad.mcpServers[0].tools[0].extra='invalid';assert.throws(()=>projectProviderCapabilities(bad),/invalid structured data/);
 let accessed=false;const getter=structuredClone(codex);Object.defineProperty(getter.mcpServers[0].tools[0],'description',{get(){accessed=true;return'unsafe'}});assert.throws(()=>projectProviderCapabilities(getter),/invalid structured data/);assert.equal(accessed,false);
 const wrong=structuredClone(codex);wrong.mcpServers[0].tools[0].description={nested:'bad'};assert.throws(()=>projectProviderCapabilities(wrong),/invalid structured data/);
});


test('Codex occupancy and capacity observations stay with their exact provider thread', async () => {
  const { CodexAppServerSession } = await import('../../packages/engines/dist/codex-app-server.js');
  const session = Object.create(CodexAppServerSession.prototype);
  session.engineAgentId = 'owned-generation';
  let observed = 0;
  session.contextUsageGate = { observe: () => observed++ };
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


test('native Codex compact returns only gate-proven fresh telemetry and keeps RPC success when telemetry is absent', async () => {
  const { CodexAppServerSession, ContextUsageObservationGate } = await import('../../packages/engines/dist/codex-app-server.js');
  const { projectProviderCommandResult } = await import('../../apps/server/dist/provider-success-projection.js');
  for (const observed of [true, false]) {
    const session = Object.create(CodexAppServerSession.prototype);
    session.engineAgentId = 'compact-owned-generation';
    session.contextUsageGate = new ContextUsageObservationGate();
    session.latestContextUsage = { usedTokens: 160000, modelContextWindow: 200000 };
    session.capabilities = async () => ({ commands: [{ name: 'compact', invocation: 'runtime', status: 'available' }] });
    let compactRpcs = 0;
    session.rpc = { request: async (method, input) => {
      assert.equal(method, 'thread/compact/start'); assert.equal(input.threadId, session.engineAgentId); compactRpcs++;
      if (observed) session.observeNotification({ method: 'thread/tokenUsage/updated', params: {
        threadId: session.engineAgentId, tokenUsage: { last: { totalTokens: 25000 }, modelContextWindow: 200000 },
      } });
    } };
    if (!observed) session.contextUsageGate.waitAfter = async () => { throw Error('controlled optional telemetry timeout'); };
    const result = projectProviderCommandResult(await session.invokeCommand('compact'));
    assert.equal(compactRpcs, 1);
    if (observed) assert.deepEqual(result.contextUsage, { usedTokens: 25000, windowTokens: 200000, providerSessionGeneration: session.engineAgentId });
    else { assert.equal(result.contextUsage, undefined); assert.match(result.message, /completed.*unavailable.*not repeat/i); }
  }
  const malformed = projectProviderCommandResult({ contextUsage: { usedTokens: 'invalid' } });
  assert.equal(malformed.contextUsage, undefined); assert.match(malformed.message, /completed.*invalid.*not repeat/i);
});
