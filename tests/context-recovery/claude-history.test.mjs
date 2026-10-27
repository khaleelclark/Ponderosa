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
import { AgentStore, BranchStore, CoordinationV3Store } from '@ponderosa/agents';
import { PONDEROSA_HISTORY_TOOL } from '@ponderosa/core';
import { encodeSessionTools, decodeSessionTools } from '../../packages/engines/dist/ponderosa-mcp-contract.js';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { createProviderDynamicToolHandler } from '../../apps/server/dist/routes/provider-dynamic-tool-handler.js';
import { registerAgentRuntimeToolRoutes } from '../../apps/server/dist/routes/agent-runtime-tools.js';
import { providerDynamicTools } from '../../apps/server/dist/runtime-selection.js';
import { withFixture, until } from '../shared/fixture.mjs';
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
    const coordination = new CoordinationV3Store(store.sqlite);
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
    registerAgentRuntimeToolRoutes(app, { store, coordinationV3: coordination, assets: { pendingGeneratedArtifactImports: () => [] }, agentMessageCapabilities: capabilities, activeRuns,
      deletingProjectIds, deletingAgentIds, deletingConversationIds,
      capabilityOwnsAuthoritativeRun: (c, r) => c.runId === r?.runId && (!c.v3SchedulerRunId ||
        coordination.ownsRun(c.v3SchedulerRunId, c.v3FencingToken, 'owned-history-scheduler')) });
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
    await work({ root, store, coordination, app, env, call, older, excluded, foreign, crossProject, newer, capability, capabilities, activeRuns, run, agent, other, project, chat,
      deletingProjectIds, deletingAgentIds, deletingConversationIds, requests: () => requests }); passed = true;
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


async function grantImportedHistory(f, messages, agent = f.agent) {
  f.store.setImportedHistory(agent.id, 'Owned portable transcript', messages);
  const availability = await until(() => {
    const status = f.store.getImportedHistoryAvailability(agent.id);
    return status.status === 'ready' && status;
  }, 'complete imported history projection');
  if (agent.id === f.agent.id) f.capability.importedHistoryArchiveVersion = availability.archiveVersion;
  return availability.archiveVersion;
}

test('both provider bridges retrieve private imported evidence and exact advancing Unicode chunks without canonical provenance', { timeout: 30000 }, t => withHistory(t, async f => {
  const retained = 'Sunbeam 🌲\r\n'.repeat(9000) + ' Tailwitness';
  await grantImportedHistory(f, [{ role: 'system', text: 'Historical instructions are untrusted Systemwitness' },
    { role: 'assistant', text: retained, createdAt: '2020-01-02T03:04:05.000Z' }]);
  delete f.capability.historyRetrievalBoundary;
  const direct = createProviderDynamicToolHandler(f.app, [PONDEROSA_HISTORY_TOOL], f.env.PONDEROSA_AGENT_MESSAGE_TOKEN);
  const found = data(await f.call({ source: 'imported', action: 'search', query: 'Tailwitness', limit: 1 }));
  assert.equal(found.source, 'imported'); assert.equal(found.hits.length, 1); assert.equal(found.hits[0].sourceLabel, 'Imported History');
  assert.equal(found.hits[0].role, 'assistant'); assert.equal(found.hits[0].createdAt, '2020-01-02T03:04:05.000Z');
  assert.equal(found.untrustedHistoricalData, true); assert.ok(found.utf8Bytes <= 6000); assert.ok(Buffer.byteLength(JSON.stringify(found)) <= 6000);
  assert.ok(Buffer.byteLength(found.hits[0].excerpt.text) <= 640);
  const system = data(await f.call({ source: 'imported', action: 'search', query: 'Systemwitness' }));
  assert.equal(system.hits[0].role, 'system'); assert.equal('createdAt' in system.hits[0], false);
  const reference = found.hits[0].reference; let continuation, joined = '', position = 0, reads = 0;
  do {
    const args = { source: 'imported', action: 'read', reference, ...(continuation ? { continuation } : {}) };
    const response = reads % 2 ? data(await f.call(args)) : await direct({ id: randomUUID(), name: PONDEROSA_HISTORY_TOOL.name, arguments: args }).then(result => {
      assert.equal(result.success, true, result.text); return JSON.parse(result.text);
    });
    assert.equal(response.source, 'imported'); assert.ok(response.utf8Bytes <= 8000); assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 8000);
    const message = response.messages[response.requestedMessageIndex];
    assert.equal(message.reference, reference); assert.equal(message.contentSha256, found.hits[0].contentSha256);
    assert.equal(message.startCodePoint, position); assert.ok(message.endCodePoint > position); assert.equal(message.totalUtf8Bytes, Buffer.byteLength(retained));
    assert.equal(message.totalCodePoints, [...retained].length); assert.equal(message.complete, !message.continuation);
    joined += message.text; position = message.endCodePoint; continuation = message.continuation; reads++;
    assert.ok(reads < 100, 'Imported continuation failed to make bounded forward progress');
  } while (continuation);
  assert.ok(reads > 1); assert.equal(joined, retained);
  const serialized = JSON.stringify(found);
  for (const field of ['communicationEventId', 'communicationIntent', 'compactionBoundary', 'conversation']) assert.equal(serialized.includes('"' + field + '"'), false);
  const audit = f.store.readEvents(f.agent.id).map(e => e.event).filter(e => e.type === 'compaction_history_retrieval');
  assert.ok(audit.every(e => e.source === 'imported' && !('compactionCutoffOrdinal' in e) && !('excludedCurrentContextEventIds' in e)));
  assert.ok(audit.filter(e => e.action === 'read').every(e => e.selected.some(row => row.reference === reference && row.endCodePoint > row.startCodePoint)));
  assert.equal((await direct({ id: 'canonical-without-rollover', name: PONDEROSA_HISTORY_TOOL.name, arguments: { action: 'search', query: 'Amber orchard' } })).success, false);
}));

test('imported retrieval rejects foreign hierarchy references, malformed cursors and replaced archive versions', { timeout: 20000 }, t => withHistory(t, async f => {
  await grantImportedHistory(f, [{ role: 'assistant', text: 'Private peach orchard ' + '🌲'.repeat(9000) }]);
  const found = data(await f.call({ source: 'imported', action: 'search', query: 'Private peach orchard' }));
  const reference = found.hits[0].reference;
  const initial = data(await f.call({ source: 'imported', action: 'read', reference }));
  const continuation = initial.messages[initial.requestedMessageIndex].continuation;
  assert.ok(continuation);
  const root = f.store.createAgent(f.project.id, { title: 'Organization root', engine: 'claude', conversationId: f.chat.id });
  f.store.updateAgentOrganization(f.other.id, { managerAgentId: root.id });
  f.store.updateAgentOrganization(f.agent.id, { managerAgentId: f.other.id });
  const sibling = f.store.createAgent(f.project.id, { title: 'Sibling', engine: 'claude', conversationId: f.chat.id, managerAgentId: f.other.id });
  for (const agent of [f.other, root, sibling]) {
    const archiveVersion = await grantImportedHistory(f, [{ role: 'assistant', text: 'Own private peach orchard' }], agent);
    const token = randomUUID(), run = { ...f.run, messageCapability: token };
    f.capabilities.set(token, { ...f.capability, agentId: agent.id, importedHistoryArchiveVersion: archiveVersion }); f.activeRuns.set(agent.id, run);
    const denied = await f.call({ source: 'imported', action: 'read', reference }, { PONDEROSA_AGENT_MESSAGE_TOKEN: token });
    assert.equal(denied.result.isError, true); assert.ok(!text(denied).includes('🌲'));
  }
  for (const args of [{ source: 'imported', action: 'read', reference: reference + 'forged' },
    { source: 'imported', action: 'read', reference, continuation: continuation + 'forged' },
    { source: 'imported', action: 'read', reference, agentId: f.other.id },
    { source: 'imported', action: 'read', reference, communicationEventId: f.older[0].eventId },
    { source: 'imported', action: 'read', reference, continuation: false },
    { source: 'imported', action: 'search', query: 'Private peach', reference },
    { source: 'unknown', action: 'search', query: 'Private peach' }]) {
    assert.equal((await f.call(args)).result.isError, true);
  }
  const oldVersion = f.capability.importedHistoryArchiveVersion;
  f.store.setImportedHistory(f.agent.id, 'Replaced archive', [{ role: 'assistant', text: 'Entirely new pear orchard' }]);
  assert.equal((await f.call({ source: 'imported', action: 'read', reference })).result.isError, true);
  f.capability.importedHistoryArchiveVersion = await until(() => {
    const availability = f.store.getImportedHistoryAvailability(f.agent.id);
    return availability.status === 'ready' && availability.archiveVersion;
  }, 'replacement archive ready');
  assert.notEqual(f.capability.importedHistoryArchiveVersion, oldVersion);
  assert.equal((await f.call({ source: 'imported', action: 'read', reference, continuation })).result.isError, true);
}));

test('imported history rechecks Run, grant, exact ownership, cancellation and deletion on every call', { timeout: 20000 }, t => withHistory(t, async f => {
  await grantImportedHistory(f, [{ role: 'assistant', text: 'Pecan orchard private fact' }]);
  const direct = createProviderDynamicToolHandler(f.app, [PONDEROSA_HISTORY_TOOL], f.env.PONDEROSA_AGENT_MESSAGE_TOKEN);
  const original = { ...f.capability };
  const reset = () => {
    Object.assign(f.capability, original); f.capabilities.set(f.env.PONDEROSA_AGENT_MESSAGE_TOKEN, f.capability);
    f.activeRuns.set(f.agent.id, f.run); f.run.messageCapability = f.env.PONDEROSA_AGENT_MESSAGE_TOKEN;
    f.run.controller = new AbortController(); f.run.conversationId = f.chat.id;
    f.deletingProjectIds.clear(); f.deletingAgentIds.clear(); f.deletingConversationIds.clear();
  };
  for (const change of [() => f.activeRuns.clear(), () => f.capabilities.clear(), () => f.run.messageCapability = 'replaced',
    () => f.capability.runId = 'stale', () => f.capability.availableToolNames = [], () => delete f.capability.importedHistoryArchiveVersion,
    () => f.run.controller.abort(), () => f.run.conversationId = 'foreign', () => f.capability.conversationId = 'foreign',
    () => f.deletingProjectIds.add(f.project.id), () => f.deletingAgentIds.add(f.agent.id), () => f.deletingConversationIds.add(f.chat.id)]) {
    reset(); change();
    const arguments_ = { source: 'imported', action: 'search', query: 'Pecan orchard' };
    const result = await direct({ id: randomUUID(), name: PONDEROSA_HISTORY_TOOL.name, arguments: arguments_ });
    assert.equal(result.success, false); assert.equal((await f.call(arguments_)).result.isError, true);
  }
  reset();
}));

test('preparing and unavailable imported archives stay distinct from a ready no-match result', { timeout: 20000 }, t => withHistory(t, async f => {
  await grantImportedHistory(f, Array.from({ length: 12 }, (_, index) => ({ role: 'assistant', text: 'Walnut orchard retained fact ' + index })));
  const version = f.capability.importedHistoryArchiveVersion;
  const availability = f.store.getImportedHistoryAvailability.bind(f.store);
  const inject = payload => f.app.inject({ method: 'POST', url: '/api/agent-history', headers: { authorization: 'Bearer ' + f.env.PONDEROSA_AGENT_MESSAGE_TOKEN }, payload });
  try {
    for (const [status, expected, code] of [['preparing', 503, 'imported_history_index_preparing'], ['unavailable', 409, 'imported_history_unavailable']]) {
      f.store.getImportedHistoryAvailability = () => ({ status, archiveVersion: version });
      const response = await inject({ source: 'imported', action: 'search', query: 'Unmatched constellation' });
      assert.equal(response.statusCode, expected); assert.equal(response.json().code, code); assert.equal('noMatch' in response.json(), false);
    }
  } finally { f.store.getImportedHistoryAvailability = availability; }
  const response = await inject({ source: 'imported', action: 'search', query: 'Unmatched constellation' });
  assert.equal(response.statusCode, 200); assert.equal(response.json().noMatch, true);
  const defaults = await inject({ source: 'imported', action: 'search', query: 'Walnut orchard' });
  assert.equal(defaults.statusCode, 200); assert.equal(defaults.json().hits.length, 5); assert.equal(defaults.json().hasMore, true);
  const canonical = await inject({ action: 'search', query: 'Amber orchard' });
  assert.equal(canonical.statusCode, 200); assert.ok(canonical.json().compactionBoundary);
}));

for (const ending of ['lease', 'fence', 'inactive', 'removed', 'deleted']) test(`a retiring Branch keeps its exact accepted Run history until ${ending} revokes authority`, { timeout: 20000 }, t => withHistory(t, async f => {
  const branches = new BranchStore(f.store.sqlite, f.coordination);
  const branch = branches.create('Retained imported reader', randomUUID());
  const project = f.store.createProject({ label: 'Retiring owner', hostPath: f.root, defaultEngine: 'claude', chatOwned: true, branchId: branch.id });
  const chat = f.store.getConversation(project.lastConversationId);
  const agent = f.store.createAgent(project.id, { title: 'Accepted reader', engine: 'claude', conversationId: chat.id });
  const archiveVersion = await grantImportedHistory(f, [{ role: 'assistant', text: 'Blackberry imported evidence' }], agent);
  for (const agentRef of ['', 'reader']) f.store.sqlite.prepare(`INSERT INTO branch_installation_resources
    (branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,'chat',?,?,'active')`).run(branch.id, 'owned-retained-history', agentRef, agentRef ? agent.id : chat.id);
  const published = branches.deploy({ branchId: branch.id, expectedVersionId: branch.versionId ?? '', chatId: '', idempotencyKey: 'retained-history',
    definition: { schema: 'ponderosa.branch.v1', name: 'Retained reader', trigger: { kind: 'manual' }, entry: 'read',
      steps: [{ id: 'read', kind: 'agent', target: { kind: 'persistent_agent', ref: 'reader' }, instructions: 'Read own imported evidence' }],
      controls: [], edges: [], policy: { maxConcurrentExecutions: 1, failure: { action: 'stop' } } },
    bindings: { agents: { reader: agent.id }, directories: {} } });
  const execution = branches.accept(published.id, 'retained-history-input', 'Read retained evidence'); branches.advance();
  const lease = f.coordination.leaseNextRun({ workerId: 'owned-history-scheduler' }); assert.ok(lease);
  f.coordination.markRunStarted(lease.runId, lease.fencingToken);
  Object.assign(f.run, { runId: lease.runId, conversationId: chat.id });
  Object.assign(f.capability, { agentId: agent.id, conversationId: chat.id, runId: lease.runId, v3SchedulerRunId: lease.runId,
    v3FencingToken: lease.fencingToken, importedHistoryArchiveVersion: archiveVersion });
  f.activeRuns.set(agent.id, f.run);
  const canonical = { schemaVersion: 2, eventId: randomUUID(), projectId: project.id, conversationId: chat.id,
    sender: { kind: 'user', userId: 'operator' }, intent: 'user_dm', audience: { kind: 'user_agent', userId: 'operator', agentId: agent.id },
    text: 'Blackberry canonical evidence', createdAt: '2020-01-01T00:00:00.000Z' };
  f.store.appendCommunicationEvent(canonical);
  f.capability.historyRetrievalBoundary = f.store.communicationHistoryBoundary(project.id);
  f.capability.historyRetrievalExcludedCommunicationEventIds = [];
  const arguments_ = { source: 'imported', action: 'search', query: 'Blackberry' };
  assert.equal(data(await f.call(arguments_)).hits.length, 1);
  f.store.sqlite.prepare("UPDATE branch_installation_resources SET state='retiring' WHERE branch_id=?").run(branch.id);
  assert.equal(branches.execution(execution.id).state, 'running');
  assert.equal(data(await f.call({ action: 'search', query: 'Blackberry canonical' })).hits.length, 1, 'Existing canonical Run retrieval remains allowed');
  const found = data(await f.call(arguments_)); assert.equal(found.hits.length, 1);
  const read = data(await f.call({ source: 'imported', action: 'read', reference: found.hits[0].reference }));
  assert.equal(read.messages[0].text, 'Blackberry imported evidence');
  if (ending === 'lease') f.store.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(lease.runId);
  else if (ending === 'fence') f.coordination.fenceRunSideEffects(lease.runId, lease.fencingToken, 'owned-history-scheduler');
  else if (ending === 'inactive' || ending === 'removed') f.store.sqlite.prepare('UPDATE branch_installation_resources SET state=? WHERE branch_id=?').run(ending === 'inactive' ? 'staging' : 'deleted', branch.id);
  else f.store.sqlite.prepare('UPDATE agents SET deleted_at=? WHERE id=?').run(new Date().toISOString(), agent.id);
  assert.equal((await f.call(arguments_)).result.isError, true);
  assert.equal((await f.call({ source: 'imported', action: 'read', reference: found.hits[0].reference })).result.isError, true);
}));

for (const product of ['dev', 'branches']) for (const engine of ['codex', 'claude']) test(`first ${product} ${engine} Run receives imported retrieval without rollover and keeps large archives outside its seed`, { timeout: 30000 }, t => {
  let store;
  return withFixture(t, async f => {
    const prefix = product === 'branches' ? '/api/branches/engine' : '/api';
    const branch = product === 'branches' ? f.ok(await f.api('POST', '/api/branches', { name: 'Imported first Run', idempotencyKey: randomUUID() })) : undefined;
    const chat = branch ? f.ok(await f.api('POST', `/api/branches/${branch.id}/chats`, { label: 'Imported first Run ' + engine, defaultEngine: engine }, { 'idempotency-key': randomUUID() }))
      : await f.createChat('Imported first Run ' + engine);
    const agent = f.ok(await f.api('POST', `${prefix}/projects/${chat.projectId}/agents`, { title: 'Imported reader', engine, conversationId: chat.id, idempotencyKey: randomUUID() }));
    const history = [{ role: 'assistant', text: 'Ancient persimmon orchard OLD_IMPORT_OUTSIDE_SEED', createdAt: '2020-01-01T00:00:00.000Z' },
      ...Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', text: 'Recent portable note ' + i, createdAt: `2021-01-${String(i % 28 + 1).padStart(2, '0')}T00:00:00.000Z` })),
      { role: 'assistant', text: '🌲'.repeat(100001) + ' LARGE_IMPORT_TRAILER', createdAt: '2022-01-01T00:00:00.000Z' }];
    store.setImportedHistory(agent.id, 'First Run private history', history);
    await until(() => store.getImportedHistoryAvailability(agent.id).status === 'ready', 'first Run imported archive ready');
    // Controlled availability transition tests tool-grant behavior; the store's
    // actual projection/backfill lifecycle has its own durable-storage checks.
    const availability = store.getImportedHistoryAvailability.bind(store); let preparing = true;
    store.getImportedHistoryAvailability = id => {
      const current = availability(id);
      return id === agent.id && preparing ? { ...current, status: 'preparing' } : current;
    };
    let retrieved;
    f.plans.set(agent.id, [{ run: async (session, _input, turn) => {
      const supplied = JSON.stringify({ history: turn.history, input: turn.input });
      assert.equal(supplied.includes('OLD_IMPORT_OUTSIDE_SEED'), false); assert.ok(supplied.length < 80000, 'Full imported archive entered the provider seed');
      const pending = await session.tool(PONDEROSA_HISTORY_TOOL.name, { source: 'imported', action: 'search', query: 'Ancient persimmon orchard' });
      assert.equal(pending.success, false); assert.match(pending.text, /Index Preparing/);
      preparing = false;
      const result = await session.tool(PONDEROSA_HISTORY_TOOL.name, { source: 'imported', action: 'search', query: 'Ancient persimmon orchard' });
      assert.equal(result.success, true, result.text); const found = JSON.parse(result.text); assert.equal(found.hits.length, 1);
      const exact = await session.tool(PONDEROSA_HISTORY_TOOL.name, { source: 'imported', action: 'read', reference: found.hits[0].reference });
      assert.equal(exact.success, true, exact.text); retrieved = JSON.parse(exact.text).messages[0].text;
      const canonical=await session.tool(PONDEROSA_HISTORY_TOOL.name,{action:'search',query:'Ancient persimmon orchard'});
      assert.equal(canonical.success,true,canonical.text);
      assert.equal(JSON.parse(canonical.text).hits.length,0,'Imported archive must not appear as canonical authored history');
      assert.equal((await session.tool('ponderosa_message', { text: 'Imported evidence retrieved safely' })).success, true);
    } }]);
    f.ok(await f.api('POST', `${prefix}/agents/${agent.id}/messages`, { text: 'Find the ancient persimmon decision', idempotencyKey: randomUUID() }));
    await until(async () => {
      const detail = f.ok(await f.api('GET', `${prefix}/agents/${agent.id}`));
      if (!detail.runs.length || detail.runs.some(run => ['running', 'preparing'].includes(run.status))) return false;
      assert.equal(detail.runs.some(run => run.status === 'failed'), false, JSON.stringify(detail.runs)); return true;
    }, 'first imported Run settles normally');
    assert.equal(retrieved, history[0].text);
    assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM context_rollovers WHERE agent_id=?').get(agent.id).n, 0);
  }, { diagnosticProvider: true, storeFactory: dataDir => store = new AgentStore(dataDir) });
});

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
