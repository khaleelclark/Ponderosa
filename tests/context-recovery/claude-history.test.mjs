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
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import { withFixture, until } from '../shared/fixture.mjs';
import { PONDEROSA_HISTORY_TOOL } from '@ponderosa/core';
import { encodeSessionTools } from '../../packages/engines/dist/ponderosa-mcp-contract.js';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { createProviderDynamicToolHandler } from '../../apps/server/dist/routes/provider-dynamic-tool-handler.js';
import { registerAgentRuntimeToolRoutes } from '../../apps/server/dist/routes/agent-runtime-tools.js';
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
    const token = 'owned-fake-history-capability', run = { runId: 'owned-run', executionId: 'owned-execution', messageCapability: token, conversationId: chat.id, controller: new AbortController() };
    const capability = { agentId: agent.id, runId: run.runId, conversationId: chat.id, historyRetrievalBoundary: boundary,
      historyRetrievalExcludedCommunicationEventIds: [excluded.eventId], availableToolNames: [PONDEROSA_HISTORY_TOOL.name] };
    const capabilities = new Map([[token, capability]]), activeRuns = new Map([[agent.id, run]]);
    const deletingProjectIds = new Set(), deletingAgentIds = new Set(), deletingConversationIds = new Set();
    let requests = 0; app.addHook('onRequest', async request => { if (request.url === '/api/agent-history') requests++; });
    registerAgentRuntimeToolRoutes(app, { store, assets: { pendingGeneratedArtifactImports: () => [] }, agentMessageCapabilities: capabilities, activeRuns, deletingProjectIds, deletingAgentIds, deletingConversationIds,
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
    await work({ root, store, app, project, chat, other, deletingProjectIds, deletingAgentIds, deletingConversationIds, env, call, older, excluded, foreign, crossProject, newer, capability, capabilities, activeRuns, run, agent, requests: () => requests }); passed = true;
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

test('ordinary accepted boundary supports complete Unicode chunks, concise direct reads and lifecycle fences', {timeout:20000}, t=>withHistory(t,async f=>{
 const body='BEGIN canonical 🧭\0\n'+('東京 😀 \"line\"\n'.repeat(2400))+'END';
 const event={schemaVersion:2,eventId:randomUUID(),projectId:f.project.id,conversationId:f.chat.id,sender:{kind:'user',userId:'operator'},intent:'user_dm',audience:{kind:'user_agent',userId:'operator',agentId:f.agent.id},text:body,createdAt:new Date().toISOString()};
 f.store.appendCommunicationEvent(event);f.capability.historyRetrievalBoundary=f.store.communicationHistoryBoundary(f.project.id);
 const call=async arguments_=>{const r=await f.app.inject({method:'POST',url:'/api/agent-history',headers:{authorization:'Bearer '+f.run.messageCapability},payload:arguments_});assert.equal(r.statusCode,200,r.body);return r.json()};
 let continuation,offset=0,reconstructed='';
 do{const page=await call({action:'read',communicationEventId:event.eventId,before:0,after:0,...(continuation?{continuation}:{})}),message=page.messages[0];
  assert.equal(Buffer.byteLength(JSON.stringify(page)),page.utf8Bytes);assert.ok(page.utf8Bytes<=8000);assert.equal(message.startCodePoint,offset);assert.ok(message.endCodePoint>offset);assert.equal(message.totalCodePoints,[...body].length);
  reconstructed+=message.text;offset=message.endCodePoint;continuation=message.continuation;
 }while(continuation);
 assert.equal(reconstructed,body);assert.equal(offset,[...body].length);
 const direct=f.store.readCompactionHistory({agentId:f.agent.id,communicationEventId:f.older[0].eventId,excludedCommunicationEventIds:new Set(),before:0,after:0});assert.equal(direct.response.messages[0].complete,true);
 const routed=f.store.createConversation(f.project.id,{title:'Routed Chat'});f.run.conversationId=routed.id;f.capability.conversationId=routed.id;
 assert.equal((await call({action:'read',communicationEventId:event.eventId,before:0,after:0})).messages[0].communicationEventId,event.eventId);
 f.deletingConversationIds.add(routed.id);
 const denied=await f.app.inject({method:'POST',url:'/api/agent-history',headers:{authorization:'Bearer '+f.run.messageCapability},payload:{action:'read',communicationEventId:event.eventId}});assert.equal(denied.statusCode,403);
 const audits=f.store.readEvents(f.agent.id).filter(row=>row.event.type==='compaction_history_retrieval'&&row.event.action==='read'&&row.event.communicationEventId===event.eventId);
 assert.equal(audits[0].event.selected[0].complete,false);assert.equal(audits[0].event.selected[0].startCodePoint,0);
}));

test('40-message omission reaches the actual prompt and a discarded session cannot hide its older history', {timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Canonical context'),agent=await f.createIdleAgent(chat,'Retained reader');
  const authored=(text,number)=>{const event={schemaVersion:2,eventId:randomUUID(),projectId:chat.projectId,conversationId:chat.id,sender:{kind:'user',userId:'local-operator'},intent:'user_dm',audience:{kind:'user_agent',userId:'local-operator',agentId:agent.id},text,createdAt:new Date(Date.now()-100000+number*10).toISOString()};store.appendCommunicationEvent(event);store.appendEvent(agent.id,{type:'communication_projection',communicationEventId:event.eventId,text:event.text,role:'user'});return event};
  const older=authored('Unique amber compass secret retained fact',0);
  await f.send(agent.id,'Read initial context');await f.settled(agent.id);const oldSession=f.turns.at(-1).sessionId;
  for(let index=1;index<=45;index++)authored('Recent bounded private item '+index,index);
  f.ok(await f.api('PATCH','/api/workspace/preferences',{globalInstructions:'Genuine new instruction for a fresh canonical context'}));
  const session=await f.hold(agent.id);assert.notEqual(session.engineAgentId,oldSession);assert.match(f.turns.at(-1).input.prompt,/BOUNDED HISTORICAL CONTEXT.*Additional older/s);
  const found=f.ok(await f.tool(session,'ponderosa_history',{action:'search',query:'Unique amber compass'}));assert.ok(found.hits.some(hit=>hit.communicationEventId===older.eventId));
  const exact=f.ok(await f.tool(session,'ponderosa_history',{action:'read',communicationEventId:older.eventId,before:0,after:0}));assert.equal(exact.messages[0].text,older.text);
  const before=f.turns.length;session.finish();await until(async()=>!(await f.detail(agent.id)).runs.some(run=>run.status==='running'),'settled retained turn');
  // Cosmetic profile changes preserve the compatible accepted session.
  const prefs=f.ok(await f.api('GET','/api/workspace/preferences'));f.ok(await f.api('PATCH','/api/workspace/preferences',{profile:{avatarId:prefs.profile.avatarId==='river'?'sunset':'river',handle:'#'+prefs.profile.handle.toUpperCase(),displayName:' '+prefs.profile.displayName+' '}}));
  const previous=(await f.detail(agent.id)).runs.map(run=>run.id);await f.send(agent.id,'Compatible continuation');await f.settled(agent.id,previous);assert.equal(f.turns.at(-1).sessionId,session.engineAgentId);
  const count=f.turns.length,prior=(await f.detail(agent.id)).runs.map(run=>run.id),coordination=new CoordinationV3Store(store.sqlite);
  coordination.coordinate({projectId:chat.projectId,conversationId:chat.id,actorScope:'user:local-operator',idempotencyKey:'same-scope-new-request',requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'A new compatible Request'}}]});
  await until(()=>f.turns.length>count,'new compatible Request turn');await f.settled(agent.id,prior);assert.equal(f.turns.at(-1).sessionId,session.engineAgentId,'A new Request alone must not reset compatible working context');
 },{storeFactory:root=>store=new AgentStore(root)});
});

test('accepted session tail evidence never promotes a later authored revision', {timeout:30000},async t=>{
 let store;await withFixture(t,async f=>{
  const chat=await f.createChat('Revision continuity'),agent=await f.createAgent(chat,'Revision reader');
  const ids=store.acceptedProviderSessionCommunicationEventIds(agent.id);assert.ok(ids?.length,'Fixture requires fully submitted canonical input');
  const id=ids.find(id=>store.getCommunicationEvent(chat.projectId,id)?.sender.kind==='user');assert.ok(id);
  const original=store.getCommunicationEvent(chat.projectId,id);store.appendCommunicationRevision({schemaVersion:1,eventId:randomUUID(),projectId:chat.projectId,conversationId:chat.id,targetEventId:id,kind:'edit',sender:original.sender,text:'Newer revision that this provider never received',idempotencyKey:'passive-edit',createdAt:new Date().toISOString()});
  assert.equal(store.acceptedProviderSessionCommunicationEventIds(agent.id).includes(id),false);
 },{storeFactory:root=>store=new AgentStore(root)});
});

test('queued input cannot certify an edited revision that was not submitted', { timeout: 30000 }, async t => {
  let store;
  await withFixture(t, async f => {
    const chat = await f.createChat('Queued revision proof'), agent = await f.createIdleAgent(chat, 'Queue reader');
    const first = await f.hold(agent.id), before = f.turns.length;
    const queued = await f.send(agent.id, 'Original queued input', { activeRunDelivery: 'queue' });
    const original = store.getCommunicationEvent(chat.projectId, queued.communicationEventId);
    assert.ok(original);
    const newer = 'Distinct later revision not submitted with the frozen queued input';
    store.appendCommunicationRevision({ schemaVersion: 1, eventId: randomUUID(), projectId: chat.projectId, conversationId: chat.id,
      targetEventId: original.eventId, kind: 'edit', sender: original.sender, text: newer, idempotencyKey: 'queued-revision', createdAt: new Date().toISOString() });
    f.plans.set(agent.id, [{ hold: true }]); first.finish();
    await until(() => f.turns.length > before, 'queued frozen input');
    const session = f.sessions.get(agent.id);
    assert.ok(f.turns.at(-1).input.prompt.includes('Original queued input'));
    assert.equal(f.turns.at(-1).input.prompt.includes(newer), false);
    assert.equal(store.acceptedProviderSessionCommunicationEventIds(agent.id).includes(original.eventId), false, 'Unsubmitted revision must remain retrievable');
    const retrieved = f.ok(await f.tool(session, 'ponderosa_history', { action: 'read', communicationEventId: original.eventId, before: 0, after: 0 }));
    assert.equal(retrieved.messages[0].text, newer);
    session.finish();
  }, { storeFactory: root => store = new AgentStore(root) });
});
