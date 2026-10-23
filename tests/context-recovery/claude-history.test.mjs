import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import Fastify from 'fastify';
import { AgentStore } from '@ponderosa/agents';
import { PONDEROSA_HISTORY_TOOL } from '@ponderosa/core';
import { encodeSessionTools, decodeSessionTools } from '../../packages/engines/dist/ponderosa-mcp-contract.js';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { createProviderDynamicToolHandler } from '../../apps/server/dist/routes/provider-dynamic-tool-handler.js';
import { registerAgentRuntimeToolRoutes } from '../../apps/server/dist/routes/agent-runtime-tools.js';
import { providerDynamicTools } from '../../apps/server/dist/runtime-selection.js';
const bridge = fileURLToPath(new URL('../../packages/engines/dist/ponderosa-mcp.js', import.meta.url));
const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');
const source = ts.createSourceFile('executor.ts', readFileSync(new URL('../../apps/server/src/routes/provider-run-executor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let environment;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'environment' && node.initializer?.getText(source).includes('PONDEROSA_AGENT_MESSAGE_URL:')) environment = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source); assert.ok(environment);
function runEnvironment(base, token) {
  return vm.runInNewContext(ts.transpileModule(`globalThis.result = ${environment}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    agentMessageUrl: base + '/api/agent-messages', messageCapability: token, availableRuntimeTools: [PONDEROSA_HISTORY_TOOL],
  });
}
async function withHistory(t, work) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-claude-history-'));
  let store, app, passed = false;
  try {
    store = new AgentStore(root); app = Fastify();
    const project = store.createProject({ label: 'History fixture', hostPath: root, defaultEngine: 'claude' });
    const chat = store.createConversation(project.id, { title: 'Compacted history' });
    const agent = store.createAgent(project.id, { title: 'History reader', engine: 'claude', conversationId: chat.id });
    const other = store.createAgent(project.id, { title: 'Private other reader', engine: 'claude', conversationId: chat.id });
    const authored = (text, recipient = agent, owner = project) => {
      const event = { schemaVersion: 2, eventId: randomUUID(), projectId: owner.id, ...(owner.id === project.id ? { conversationId: chat.id } : {}),
        sender: { kind: 'user', userId: 'operator' }, intent: 'user_dm', audience: { kind: 'user_agent', userId: 'operator', agentId: recipient.id }, text, createdAt: new Date().toISOString() };
      store.appendCommunicationEvent(event); return event;
    };
    const older = Array.from({ length: 12 }, (_, i) => authored('Amber orchard archived fact ' + i + ' 😀'));
    const excluded = authored('Amber orchard already in current context');
    const foreign = authored('Amber orchard PRIVATE_OTHER_AGENT', other);
    const foreignProject = store.createProject({ label: 'Foreign project', hostPath: root, defaultEngine: 'claude' });
    const foreignChat = store.createConversation(foreignProject.id, { title: 'Foreign' });
    const foreignAgent = store.createAgent(foreignProject.id, { title: 'Foreign reader', engine: 'claude', conversationId: foreignChat.id });
    const crossProject = authored('Amber orchard PRIVATE_OTHER_PROJECT', foreignAgent, foreignProject);
    const boundary = store.communicationHistoryBoundary(project.id), newer = authored('Amber orchard NEW_AFTER_BOUNDARY');
    const token = 'owned-fake-history-capability', run = { runId: 'owned-run', executionId: 'owned-execution', messageCapability: token };
    const capability = { agentId: agent.id, runId: run.runId, conversationId: chat.id, historyRetrievalBoundary: boundary,
      historyRetrievalExcludedCommunicationEventIds: [excluded.eventId], availableToolNames: [PONDEROSA_HISTORY_TOOL.name] };
    const capabilities = new Map([[token, capability]]), activeRuns = new Map([[agent.id, run]]);
    let requests = 0; app.addHook('onRequest', async request => { if (request.url === '/api/agent-history') requests++; });
    registerAgentRuntimeToolRoutes(app, { store, assets: { pendingGeneratedArtifactImports: () => [] }, agentMessageCapabilities: capabilities, activeRuns,
      capabilityOwnsAuthoritativeRun: (c, r) => c.runId === r?.runId });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const env = runEnvironment(base, token);
    assert.equal(env.PONDEROSA_AGENT_HISTORY_URL, base + '/api/agent-history');
    const call = async (args, overrides = {}, name = 'history') => {
      const child = spawn(process.execPath, [bridge], { env: { PATH: process.env.PATH, ...env, PONDEROSA_AGENT_TOOL_DEFINITIONS: encodeSessionTools([PONDEROSA_HISTORY_TOOL]), ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
      const completion = once(child, 'close'); let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', value => stdout += value); child.stderr.setEncoding('utf8').on('data', value => stderr += value);
      const timer = setTimeout(() => child.kill(), 10000);
      try {
        child.stdin.end([JSON.stringify({ id: 1, method: 'tools/list' }), JSON.stringify({ id: 2, method: 'tools/call', params: { name, arguments: args } })].join('\n') + '\n');
        const [code, signal] = await completion; assert.equal(code, 0, stderr); assert.equal(signal, null);
        const rows = stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(rows.length, 2); return { listed: rows[0].result.tools, result: rows[1].result };
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await completion; } }
    };
    await work({ root, store, app, env, call, older, excluded, foreign, crossProject, newer, capability, capabilities, activeRuns, run, agent, requests: () => requests }); passed = true;
  } finally {
    await app?.close(); store?.close();
    if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic('Retained owned history fixture: ' + root);
  }
}
const text = response => response.result.content[0].text;
const data = response => { assert.equal(response.result.isError, false, text(response)); return JSON.parse(text(response)); };
test('Claude MCP retrieves bounded canonical old facts with frozen tail/cutoff and exact read neighborhoods', { timeout: 20000 }, t => withHistory(t, async f => {
  const response = await f.call({ action: 'search', query: 'Amber orchard', limit: 1 });
  assert.equal(response.listed[0].name, 'history'); const found = data(response);
  assert.equal(found.hits.length, 1); assert.equal(found.hasMore, true); assert.equal(found.untrustedHistoricalData, true); assert.ok(found.utf8Bytes <= 6000);
  assert.ok(!JSON.stringify(found).includes('PRIVATE_')); assert.ok(!JSON.stringify(found).includes('NEW_AFTER_BOUNDARY')); assert.ok(!JSON.stringify(found).includes('already in current context'));
  const exact = data(await f.call({ action: 'read', communicationEventId: f.older[5].eventId, before: 2, after: 2 }));
  assert.equal(exact.messages.length, 5); assert.equal(exact.messages[exact.requestedMessageIndex].text, f.older[5].text); assert.ok(exact.utf8Bytes <= 8000);
  const audit = f.store.readEvents(f.agent.id).filter(e => e.event.type === 'compaction_history_retrieval');
  assert.equal(audit.length, 2); assert.ok(audit.every(e => e.event.outcome === 'results'));
}));
test('history refuses other Agent/project messages, frozen tail and post-boundary IDs', { timeout: 20000 }, t => withHistory(t, async f => {
  for (const message of [f.foreign, f.crossProject, f.excluded, f.newer]) {
    const result = await f.call({ action: 'read', communicationEventId: message.eventId }); assert.equal(result.result.isError, true); assert.match(text(result), /not authorized|unavailable|compaction boundary/);
  }
  assert.equal(f.requests(), 4);
}));
test('server-issued history capability requires current Run, token, boundary and tool allowlist', { timeout: 20000 }, t => withHistory(t, async f => {
  const args = { action: 'search', query: 'Amber orchard' };
  for (const modify of [() => f.activeRuns.clear(), () => f.run.messageCapability = 'replaced', () => f.capability.runId = 'stale', () => delete f.capability.historyRetrievalBoundary, () => f.capability.availableToolNames = []]) {
    f.activeRuns.set(f.agent.id, f.run); f.run.messageCapability = f.env.PONDEROSA_AGENT_MESSAGE_TOKEN; f.capability.runId = 'owned-run';
    const boundary = f.store.communicationHistoryBoundary(f.agent.projectId); f.capability.historyRetrievalBoundary = boundary; f.capability.availableToolNames = [PONDEROSA_HISTORY_TOOL.name];
    modify(); const result = await f.call(args); assert.equal(result.result.isError, true); assert.match(text(result), /not authorized/);
  }
}));
test('missing MCP URL/token or unselected history never falls through to message route', { timeout: 20000 }, t => withHistory(t, async f => {
  let otherRequests = 0; f.app.server.on('request', request => { if (request.url !== '/api/agent-history') otherRequests++; });
  for (const overrides of [{ PONDEROSA_AGENT_HISTORY_URL: '' }, { PONDEROSA_AGENT_MESSAGE_TOKEN: '' }, { PONDEROSA_AGENT_TOOL_NAMES: '[]' }, { PONDEROSA_AGENT_TOOL_DEFINITIONS: '' }]) {
    const response = await f.call({ action: 'search', query: 'Amber orchard' }, overrides); assert.equal(response.result.isError, true); assert.match(text(response), /unavailable/);
  }
  const unsupported = await f.call({}, {}, 'message'); assert.equal(unsupported.result.isError, true); assert.equal(f.requests(), 0); assert.equal(otherRequests, 0);
}));
test('history malformed action, fields and neighborhood bounds reject without exposing content', { timeout: 20000 }, t => withHistory(t, async f => {
  for (const args of [{ action: 'read', communicationEventId: f.older[0].eventId, before: 3 }, { action: 'read', communicationEventId: f.older[0].eventId, after: -1 }, { action: 'read', communicationEventId: f.older[0].eventId, before: 0.5 }, { action: 'search', query: 'Amber orchard', agentId: 'other' }, ...[0, 9, 0.5, '1', null].map(limit => ({ action: 'search', query: 'Amber orchard', limit })), { action: 'anything', query: 'Amber orchard' }]) {
    const response = await f.call(args); assert.equal(response.result.isError, true); assert.ok(!text(response).includes('archived fact'));
  }
}));
test('actual Claude session child inherits history URL and selected MCP bridge configuration', { skip: process.platform === 'win32' || /\s/.test(process.execPath), timeout: 20000 }, t => withHistory(t, async f => {
  const executable = path.join(f.root, 'owned-claude'), output = path.join(f.root, 'bridge-result.json');
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');\nconst args=process.argv.slice(2),config=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.ponderosa;\nlet started=false;process.stdin.on('data',()=>{if(started)return;started=true;const child=spawn(config.command,config.args,{env:{...process.env,...config.env}});let stdout='';child.stdout.on('data',v=>stdout+=v);child.on('close',(code)=>{fs.writeFileSync(process.env.OWNED_HISTORY_OUTPUT,JSON.stringify({code,stdout,historyUrl:process.env.PONDEROSA_AGENT_HISTORY_URL}));process.exit(code??1);});child.stdin.end(JSON.stringify({id:7,method:'tools/call',params:{name:'history',arguments:{action:'search',query:'Amber orchard',limit:1}}})+'\\n');});\n`, { mode: 0o700 });
  const handles = []; let session;
  try {
    session = new ClaudeStreamSession({ bin: executable, cwd: f.root, agentId: f.agent.id, history: [], permissionMode: 'default', killGraceMs: 50, signal: new AbortController().signal,
      dynamicTools: [PONDEROSA_HISTORY_TOOL], environment: { ...f.env, OWNED_HISTORY_OUTPUT: output }, onRuntimeSpawned: handle => handles.push(handle) });
    let receipt; const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { try { receipt = JSON.parse(await readFile(output, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; } await delay(10); }
    assert.ok(receipt); assert.equal(receipt.code, 0); assert.equal(receipt.historyUrl, f.env.PONDEROSA_AGENT_HISTORY_URL);
    const response = JSON.parse(receipt.stdout.trim()); assert.equal(response.result.isError, false); assert.equal(JSON.parse(response.result.content[0].text).hits.length, 1);
  } finally { await session?.close(); await Promise.all(handles.map(handle => handle.close())); }
  assert.equal(handles.length, 1); assert.ok(handles.every(handle => !handle.isAlive()));
}));

test('Codex direct handler and Claude MCP share canonical history and revoked capability fences', { timeout: 20000 }, t => withHistory(t, async f => {
  const direct = createProviderDynamicToolHandler(f.app, [PONDEROSA_HISTORY_TOOL], f.env.PONDEROSA_AGENT_MESSAGE_TOKEN);
  const arguments_ = { action: 'read', communicationEventId: f.older[5].eventId, before: 0, after: 0 };
  const codex = await direct({ id: 'owned-call', name: PONDEROSA_HISTORY_TOOL.name, arguments: arguments_ });
  assert.equal(codex.success, true); assert.deepEqual(JSON.parse(codex.text), data(await f.call(arguments_)));
  f.activeRuns.clear();
  assert.equal((await direct({ id: 'revoked', name: PONDEROSA_HISTORY_TOOL.name, arguments: arguments_ })).success, false);
  assert.equal((await f.call(arguments_)).result.isError, true);
}));

test('Claude MCP accepts the real Local Memory catalog and only its exact selected definitions', () => {
  const tools = providerDynamicTools(true), memory = tools.filter(tool => tool.name.startsWith('ponderosa_local_memory_'));
  assert.equal(memory.length, 6);
  for (const selected of [tools, ...memory.map(tool => [tool])]) {
    assert.deepEqual(decodeSessionTools(encodeSessionTools(selected)), selected);
  }
  for (const invalid of [[...tools, tools[0]], [memory[0], memory[0]], [{...memory[0], name:'ponderosa_local_memory_delete_all'}], [{...memory[0], inputSchema:[]}]] ) {
    assert.throws(() => encodeSessionTools(invalid), /invalid MCP session tool definitions/);
  }
});

test('bundled Claude Local Memory bridge forwards selected search and refuses unselected or revoked calls', {timeout:20000}, async () => {
  const app = Fastify(), requests = [], selected = providerDynamicTools(true).filter(tool => tool.name === 'ponderosa_local_memory_search');
  let revoked = false;
  app.post('/api/agent-local-memory', async (request, reply) => {
    requests.push({authorization:request.headers.authorization, body:request.body});
    return revoked ? reply.code(401).send({error:'not authorized'}) : {matches:[]};
  });
  const base = await app.listen({host:'127.0.0.1',port:0});
  const call = async name => {
    const child = spawn(process.execPath,[bridge],{env:{PATH:process.env.PATH,PONDEROSA_AGENT_MESSAGE_URL:base+'/api/agent-messages',PONDEROSA_AGENT_MESSAGE_TOKEN:'owned-memory-test',PONDEROSA_AGENT_TOOL_DEFINITIONS:encodeSessionTools(selected)},stdio:['pipe','pipe','pipe']});
    const completion = once(child,'close');let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',v=>stdout+=v);child.stderr.setEncoding('utf8').on('data',v=>stderr+=v);
    const timer=setTimeout(()=>child.kill(),10000);
    try {
      child.stdin.end([JSON.stringify({id:1,method:'tools/list'}),JSON.stringify({id:2,method:'tools/call',params:{name,arguments:{query:'owned query',source:'chat',top_k:5}}})].join('\n')+'\n');
      const [code,signal]=await completion;assert.equal(code,0,stderr);assert.equal(signal,null);
      return Object.fromEntries(stdout.trim().split('\n').map(line=>JSON.parse(line)).map(row=>[row.id,row.result]));
    } finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill();await completion;}}
  };
  try {
    const ok=await call('local_memory_search');
    assert.deepEqual(ok[1].tools.map(tool=>tool.name),['local_memory_search']);assert.equal(ok[2].isError,false);
    assert.deepEqual(requests,[{authorization:'Bearer owned-memory-test',body:{query:'owned query',source:'chat',top_k:5,operation:'search'}}]);
    assert.equal((await call('local_memory_save'))[2].isError,true);assert.equal(requests.length,1);
    revoked=true;assert.equal((await call('local_memory_search'))[2].isError,true);assert.equal(requests.length,2);
  } finally {await app.close();}
});
