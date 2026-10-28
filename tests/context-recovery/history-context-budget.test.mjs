import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import { createServer } from '../../apps/server/dist/app.js';
import { withFixture, until, fixtureTestOptions } from '../shared/fixture.mjs';

test('ordinary one-shot sessions bind fresh acknowledgements and fence late cancelled session events', fixtureTestOptions, async t => {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'ponderosa-one-shot-budget-')));
  const store=new AgentStore(path.join(root,'data')),coord=new CoordinationV3Store(store.sqlite);
  const project=store.createProject({label:'Ordinary one-shot',hostPath:root,defaultEngine:'fixture',chatOwned:true});
  const chat=store.getConversation(project.lastConversationId),agent=store.createAgent(project.id,{title:'One-shot reader',engine:'fixture',conversationId:chat.id});
  const generation=randomUUID(),forged=randomUUID(),token=randomUUID(),headers={authorization:'Bearer '+token};
  let app,passed=false,turns=0,seeds=0,release,lateAttempted=false,lateSettled=false;
  const gate=new Promise(resolve=>release=resolve),inputs=[];
  const run=async function*(opts,fresh){
    turns++;if(fresh)seeds++;
    assert.equal(opts.resumeSessionId,fresh?undefined:generation);
    const owner=coord.activeAgentRun(agent.id);assert.ok(owner);
    inputs.push(store.getProviderInput(owner.id,true));
    if(turns===3){
      try {
        await gate;lateAttempted=true;
        // A provider may deliver buffered events after abort. They cannot
        // acknowledge a cancelled fence or replace the accepted generation.
        yield {type:'session',sessionId:forged};
        yield {type:'context_usage',providerSessionId:forged,providerSessionGeneration:forged,usedTokens:1,windowTokens:200000};
        yield {type:'turn_done'};return;
      } finally { lateSettled=true; }
    }
    yield {type:'session',sessionId:generation};
    const reply=await app.inject({method:'POST',url:'/api/agent-messages',headers:{authorization:'Bearer '+opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN},payload:{text:'Ordinary one-shot reply '+turns}});
    assert.equal(reply.statusCode,200,reply.body);
    yield {type:'context_usage',providerSessionId:generation,providerSessionGeneration:generation,usedTokens:1000,windowTokens:200000,requestOutputIncluded:true};
    yield {type:'turn_done'};
  };
  const adapter={id:'fixture',displayName:'Inert one-shot',trustedSystemPromptChannel:'developer',listModels:()=>[],listEfforts:()=>[],seed:opts=>run(opts,true),continue:opts=>run(opts,false)};
  try{
    app=createServer({dataDir:path.join(root,'data'),store,authToken:token,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,
      resourceAdmissionObservation:{sample:async()=>({availableBytes:8*1024**3,memoryFullPercent:0,ioFullPercent:0,source:'linux_host'})},communicationV3:{pollMs:10}});
    const send=()=>app.inject({method:'POST',url:'/api/conversations/'+chat.id+'/direct-messages',headers,payload:{text:'Independent ordinary task',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue'}});
    const completed=()=>store.sqlite.prepare("SELECT id,provider_session_id FROM scheduler_runs WHERE agent_id=? AND status='completed' ORDER BY fencing_token").all(agent.id);
    assert.equal((await send()).statusCode,200);
    await until(()=>completed().length===1&&!coord.activeAgentRun(agent.id),'first one-shot completion');
    assert.equal(completed()[0].provider_session_id,generation,'Fresh normalized session event owns its acknowledged input');
    assert.equal(store.acceptedProviderSessionContextUsage(agent.id)?.usage.providerSessionGeneration,generation);
    const frozen=JSON.stringify(inputs[0]);
    assert.equal((await send()).statusCode,200);
    await until(()=>completed().length===2&&!coord.activeAgentRun(agent.id),'compatible measured one-shot continuation');
    assert.equal(turns,2);assert.equal(seeds,1,'A compatible continuation does not silently reseed');
    assert.equal(completed()[1].provider_session_id,generation);
    assert.equal(inputs[1].sourceManifest.contextBudget.occupancyObservation.source,'accepted_run');
    assert.equal((await send()).statusCode,200);await until(()=>turns===3,'held exact one-shot continuation');
    const cancelled=coord.activeAgentRun(agent.id);assert.ok(cancelled);
    const cancel=await app.inject({method:'POST',url:'/api/agents/'+agent.id+'/cancel',headers,payload:{targetRunId:cancelled.id,idempotencyKey:randomUUID()}});assert.equal(cancel.statusCode,200,cancel.body);
    release();await until(()=>lateAttempted&&lateSettled&&!coord.activeAgentRun(agent.id),'late one-shot stream attempted and finalized behind the cancelled fence');
    assert.ok(!store.readEvents(agent.id).some(({event})=>event.type==='session'&&event.sessionId===forged||event.type==='context_usage'&&event.providerSessionGeneration===forged));
    assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM scheduler_runs WHERE agent_id=? AND provider_session_id=?').get(agent.id,forged).n,0);
    assert.equal(JSON.stringify(store.getProviderInput(inputs[0].executionId,true)),frozen);
    passed=true;
  }finally{
    release();if(app){app.prepareForShutdown();await app.close();}store.close();
    if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic('Retained one-shot fixture: '+root);
  }
});

function authored(store, chat, agent, text, index = 0) {
  const event = { schemaVersion: 2, eventId: randomUUID(), projectId: chat.projectId, conversationId: chat.id,
    sender: { kind: 'user', userId: 'local-operator' }, intent: 'user_dm',
    audience: { kind: 'user_agent', userId: 'local-operator', agentId: agent.id }, text,
    createdAt: new Date(Date.now() - 120000 + index).toISOString() };
  store.appendCommunicationEvent(event);
  store.appendEvent(agent.id, { type: 'communication_projection', communicationEventId: event.eventId, text: event.text, role: 'user' });
  return event;
}

function accepted(store, agentId) {
  const run = new CoordinationV3Store(store.sqlite).activeAgentRun(agentId);
  assert.ok(run, 'An exact active Run must own the accepted provider input');
  const packet = store.getProviderInput(run.id, true);
  assert.ok(packet?.exactPrompt, 'The provider input must have exact accepted text');
  return packet;
}

const supplied = packet => `${packet.exactSystemPrompt ?? ''}\n${packet.exactPrompt}`;

async function withBudgetFixture(t, work, options = {}) {
  let store; const pages = [], usage = new Map(), commandResults = new Map();
  await withFixture(t, f => work({ ...f, get store() { return store; }, pages, usage, commandResults }), {
    ...options,
    providerContextUsage: ({ agentId }) => usage.get(agentId) ?? { usedTokens: 1000, windowTokens: 200000 },
    providerCommandResult: input => commandResults.get(input.agentId)?.(input) ?? { message: "Controlled command completed" },
    storeFactory: root => {
    store = new AgentStore(root);
    for (const name of ['getAgentPrivateContextSourcePage', 'getImportedHistoryMessagePage',
      'getOrganizationalConversationContextSourcePage', 'getOrganizationalConversationDeltaPage']) {
      const read = store[name].bind(store);
      store[name] = (...args) => { const page = read(...args); pages.push({ name, limit: args[1]?.limit, count: page.items.length }); return page; };
    }
    return store;
  } });
}

async function withRuntimePoolBudgetFixture(t, maxIdleSessions, work, options) {
  const previous = process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
  process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = String(maxIdleSessions);
  try { await withBudgetFixture(t, work, options); }
  finally {
    if (previous === undefined) delete process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
    else process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = previous;
  }
}

test('context selection includes all seventy short relevant messages through bounded pages, without private scope leaks', fixtureTestOptions, t => withBudgetFixture(t, async f => {
  const chat = await f.createChat('Readable context budget'), agent = await f.createIdleAgent(chat, 'Budget reader');
  const peer = await f.createIdleAgent(chat, 'Private peer');
  const otherChat = await f.createChat('Other private Chat'), other = await f.createIdleAgent(otherChat, 'Other reader');
  const notes = Array.from({ length: 70 }, (_, i) => authored(f.store, chat, agent, `CEDAR_BUDGET_NOTE_${String(i).padStart(3, '0')} is retained.`, i));
  const peerSecret = authored(f.store, chat, peer, 'PRIVATE_PEER_BUDGET_SECRET');
  const otherSecret = authored(f.store, otherChat, other, 'FOREIGN_CHAT_BUDGET_SECRET');
  f.pages.length = 0;
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id), text = supplied(packet);
  const included = new Set(packet.sourceManifest.historyContext.fullyIncludedCommunicationEventIds);
  assert.equal(notes.filter(note => included.has(note.eventId)).length, 70, 'A fixed count or source prefetch must not discard fitting history');
  for (const note of notes) assert.ok(text.includes(note.text), `Missing complete relevant message ${note.text}`);
  assert.equal(text.includes(peerSecret.text), false); assert.equal(text.includes(otherSecret.text), false);
  const reads = f.pages.filter(page => page.name === 'getAgentPrivateContextSourcePage');
  assert.ok(reads.length > 2, 'History must cross individual database pages');
  assert.ok(f.pages.every(page => Number.isInteger(page.limit) && page.limit > 0 && page.limit <= 128 && page.count <= page.limit), 'Every source query remains bounded independently of total selection');
  const frozen = JSON.stringify(packet);
  const later = authored(f.store, chat, agent, 'LATE_BUDGET_ENTRY_OUTSIDE_FROZEN_BOUNDARY', 1000000);
  assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen, 'Later authored state cannot rewrite an accepted packet');
  const forbidden = f.ok(await f.tool(session, 'ponderosa_history', { action: 'search', query: 'PRIVATE_PEER_BUDGET_SECRET' }));
  assert.equal(forbidden.hits.length, 0);
  const future = f.ok(await f.tool(session, 'ponderosa_history', { action: 'search', query: later.text }));
  assert.equal(future.hits.length, 0, 'Accepted retrieval boundaries cannot expand to later messages');
  await finish(f, agent, session);
}));

function budget(packet) {
  const value = packet.sourceManifest.contextBudget;
  assert.ok(value, 'Newly accepted inputs must freeze their complete context budget');
  assert.equal(value.estimator, 'conservative_utf8_bytes');
  assert.ok(value.estimatedInputTokens <= value.inputCeilingTokens, 'The complete estimated input must fit its ceiling');
  assert.ok(value.responseHeadroomTokens > 0, 'Response headroom must be reserved');
  return value;
}

async function finish(f, agent, session, steeringInjectionId) {
  f.ok(await f.tool(session, 'ponderosa_message', { text: 'Controlled context-budget task complete',
    ...(steeringInjectionId ? { steeringInjectionId } : {}) }));
  session.finish();
  await until(() => !new CoordinationV3Store(f.store.sqlite).activeAgentRun(agent.id), 'exact accepted Run settles');
}

async function readAll(f, session, eventId) {
  let text = '', continuation, end = 0;
  do {
    const page = f.ok(await f.tool(session, 'ponderosa_history', { action: 'read', communicationEventId: eventId,
      before: 0, after: 0, ...(continuation ? { continuation } : {}) }));
    const message = page.messages[0];
    assert.equal(message.startCodePoint, end); assert.ok(message.endCodePoint > end);
    assert.equal(Buffer.byteLength(JSON.stringify(page)), page.utf8Bytes); assert.ok(page.utf8Bytes <= 8000);
    text += message.text; end = message.endCodePoint; continuation = message.continuation;
  } while (continuation);
  return text;
}

test('unknown capacity uses explicit policy and one budget for complete instructions, tools, wrappers and history', fixtureTestOptions, t => withBudgetFixture(t, async f => {
  const instructions = `REQUIRED_BUDGET_INSTRUCTIONS_BEGIN\n${'Follow the documented local task rules. '.repeat(240)}REQUIRED_BUDGET_INSTRUCTIONS_END`;
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverTokens: 150000, globalInstructions: instructions }));
  const chat = await f.createChat('Shared outgoing budget'), agent = await f.createIdleAgent(chat, 'Complete input reader');
  const notes = Array.from({ length: 70 }, (_, i) => authored(f.store, chat, agent, `COMPETING_HISTORY_${i} ${'ordinary evidence '.repeat(110)}`, i));
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id), value = budget(packet);
  assert.equal(value.basis, 'context_policy'); assert.equal(value.windowTokens, undefined, 'Do not invent a model window');
  assert.equal(value.occupancyBasis, 'fresh_session'); assert.equal(value.occupancyTokens, 0);
  assert.ok(value.inputCeilingTokens + value.responseHeadroomTokens <= 150000);
  assert.ok(packet.exactSystemPrompt.includes(instructions), 'Required instructions must remain whole');
  assert.equal(value.systemPromptUtf8Bytes, Buffer.byteLength(packet.exactSystemPrompt));
  assert.ok(value.toolDefinitionsUtf8Bytes > 1000, 'Uncompressed selected tool definitions must consume the same budget');
  assert.ok(value.submittedUtf8Bytes >= Buffer.byteLength(packet.exactPrompt) + value.systemPromptUtf8Bytes + value.toolDefinitionsUtf8Bytes, 'Accounting must include wrappers as well as the actual payload');
  assert.equal(value.estimatedInputTokens, value.occupancyTokens + value.submittedUtf8Bytes);
  const selected = new Set(packet.sourceManifest.historyContext.fullyIncludedCommunicationEventIds);
  const included = notes.filter(note => selected.has(note.eventId));
  assert.ok(included.length > 0 && included.length < notes.length, 'History competes with required input instead of using a separate cap');
  for (const note of included) assert.ok(supplied(packet).includes(note.text), 'Selected history must contain complete messages');
  assert.equal(packet.sourceManifest.historyContext.additionalHistory, true);
  assert.match(packet.exactPrompt, /additional|omitted/i); assert.equal(packet.sourceManifest.historyContext.retrievalAvailable, true);
  await finish(f, agent, session);
}));

test('oversized omitted history remains completely readable in authorized Unicode chunks', fixtureTestOptions, t => withBudgetFixture(t, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverTokens: 75000 }));
  const chat = await f.createChat('Oversized historical evidence'), agent = await f.createIdleAgent(chat, 'Chunk reader');
  const content = `OVERSIZED_BUDGET_ORCHARD_BEGIN\n${'東京 🌲 café\0\n'.repeat(10000)}OVERSIZED_BUDGET_ORCHARD_END`;
  const old = authored(f.store, chat, agent, content), recent = authored(f.store, chat, agent, 'COMPLETE_RECENT_BUDGET_NOTE', 1);
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id); budget(packet);
  assert.equal(packet.sourceManifest.historyContext.fullyIncludedCommunicationEventIds.includes(old.eventId), false);
  assert.ok(supplied(packet).includes(recent.text));
  assert.equal(supplied(packet).includes('OVERSIZED_BUDGET_ORCHARD_BEGIN'), false, 'Do not silently retain a clipped oversized prefix');
  assert.equal(supplied(packet).includes('OVERSIZED_BUDGET_ORCHARD_END'), false, 'Do not silently retain a clipped oversized suffix');
  assert.equal(packet.sourceManifest.historyContext.additionalHistory, true);
  const found = f.ok(await f.tool(session, 'ponderosa_history', { action: 'search', query: 'OVERSIZED_BUDGET_ORCHARD_BEGIN' }));
  assert.ok(found.hits.some(hit => hit.communicationEventId === old.eventId));
  const frozen = JSON.stringify(packet); assert.equal(await readAll(f, session, old.eventId), content);
  assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen);
  await finish(f, agent, session);
}));

async function checkpoint(f, agent, session, usedTokens = 25000, windowTokens = 200000) {
  const before = f.store.sqlite.prepare("SELECT COALESCE(MAX(seq),0) seq FROM events WHERE agent_id=? AND type='context_usage'").get(agent.id).seq;
  session.events.push({ type: 'context_usage', providerSessionId: session.engineAgentId, providerSessionGeneration: session.engineAgentId,
    usedTokens, ...(windowTokens ? { windowTokens } : {}), aggregateTokens: 900000 });
  await until(() => f.store.sqlite.prepare("SELECT MAX(seq) seq FROM events WHERE agent_id=? AND type='context_usage'").get(agent.id).seq > before, 'exact occupancy checkpoint persisted');
}

async function refusedContinuation(f, agent, text = 'Do not dispatch unmeasured retained context') {
  const before = new Set(f.store.sqlite.prepare('SELECT id FROM scheduler_runs WHERE agent_id=?').all(agent.id).map(row => row.id));
  const turns = f.turns.length;
  await f.send(agent.id, text);
  const rows = await until(() => {
    const rows = f.store.sqlite.prepare('SELECT id,status,prompt_injection_state FROM scheduler_runs WHERE agent_id=?').all(agent.id).filter(row => !before.has(row.id));
    return rows.length && rows.every(row => row.status === 'failed') ? rows : false;
  }, 'unsafe retained context fails before dispatch');
  assert.equal(rows.length, 1); assert.equal(rows[0].prompt_injection_state, 'not_injected');
  assert.equal(f.turns.length, turns, 'Refusal cannot execute, reseed or replay');
}

test('continuation budgets charge proven completed-turn occupancy and reject foreign capacity for both packets', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Exact session occupancy'), agent = await f.createIdleAgent(chat, 'Occupancy reader');
  let session = await f.hold(agent.id); const generation = session.engineAgentId;
  await checkpoint(f, agent, session); await finish(f, agent, session);
  f.usage.set(agent.id, { usedTokens: 25000, aggregateTokens: 900000, windowTokens: 200000, providerSessionGeneration: generation });
  session = await f.hold(agent.id); assert.equal(session.engineAgentId, generation);
  let value = budget(accepted(f.store, agent.id));
  assert.equal(value.basis, 'provider_window'); assert.equal(value.windowTokens, 200000);
  assert.equal(value.occupancyBasis, 'exact_session'); assert.equal(value.providerSessionGeneration, generation);
  assert.equal(value.occupancyTokens, 25000, 'Aggregate provider traffic is not current occupancy');
  assert.ok(value.estimatedInputTokens < 900000);
  await finish(f, agent, session);
  f.usage.set(agent.id, { usedTokens: 140000, aggregateTokens: 900000, windowTokens: 200000, providerSessionGeneration: 'foreign-generation' });
  session = await f.hold(agent.id); value = budget(accepted(f.store, agent.id));
  assert.equal(value.occupancyBasis, 'estimated_session'); assert.ok(value.occupancyTokens > 0);
  assert.equal(value.basis, 'context_policy'); assert.equal(value.windowTokens, undefined);
  assert.equal(value.occupancyObservation.source, 'accepted_input_estimate');
  const resumedPacket = accepted(f.store, agent.id);
  assert.equal(value.submittedUtf8Bytes, Buffer.byteLength(JSON.stringify({ input: resumedPacket.exactPrompt })), 'Submitted bytes describe only the actual resumed packet');
  assert.ok(value.occupancyObservation.retainedStaticUtf8Bytes > 0, 'Verified retained system/tools are charged once in the host estimate');
  assert.ok(value.occupancyTokens >= value.occupancyObservation.acceptedInputUtf8Bytes + value.occupancyObservation.outputUtf8Bytes + value.occupancyObservation.retainedStaticUtf8Bytes);
  const plan = f.store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT COALESCE(SUM(s.raw_utf8_bytes * 6 + 128),0) AS bytes
    FROM run_output_segments s WHERE s.agent_id=? AND s.execution_id IN (SELECT id FROM scheduler_runs
      WHERE agent_id=? AND provider_session_id=? AND prompt_injection_state='injected')`).all(agent.id, agent.id, generation);
  assert.ok(plan.some(row => /idx_run_output_segments_execution_response.*execution_id=/.test(row.detail)), 'Output aggregation must seek exact generation execution IDs, not scan lifetime output');
  t.diagnostic(`Retained output query plan: ${plan.map(row => row.detail).join('; ')}`);
  assert.equal(value.occupancyObservation.liveLowerBoundTokens, undefined, 'Foreign capacity/occupancy must not enter current or fallback evidence');
  await finish(f, agent, session);
  for (let i = 0; i < 70; i++) authored(f.store, chat, agent, `FALLBACK_POLICY_NOTE_${i} ${'bounded fresh context '.repeat(90)}`, i + 100);
  const turnsBefore = f.turns.length;
  f.plans.set(agent.id, [
    { output: false, run: async s => s.events.push({ type: 'error', terminalStatus: 'failed', message: 'failed to run pre-sampling compact: controlled context budget fallback' }) },
    { hold: true },
  ]);
  await f.send(agent.id, 'Use the separately qualified fresh packet only after confirmed pre-sampling rejection');
  await until(() => f.turns.length >= turnsBefore + 2, 'confirmed fresh fallback');
  session = f.sessions.get(agent.id); value = budget(accepted(f.store, agent.id));
  assert.equal(value.occupancyBasis, 'fresh_session'); assert.equal(value.basis, 'context_policy');
  assert.equal(value.windowTokens, undefined, 'Foreign-generation capacity cannot leak into the precompiled fresh packet');
  assert.equal(value.inputCeilingTokens, 90000);
  await finish(f, agent, session);
}));

test('warm continuation includes durable text following a partial checkpoint', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Warm partial checkpoint'), agent = await f.createIdleAgent(chat, 'Partial reader');
  let session = await f.hold(agent.id); const generation = session.engineAgentId;
  await checkpoint(f, agent, session);
  const tail = 'POST_CHECKPOINT_TEXT '.repeat(1804);
  session.events.push({ type: 'text', delta: tail });
  await until(() => f.store.sqlite.prepare("SELECT SUM(raw_utf8_bytes) bytes FROM run_output_segments WHERE agent_id=?").get(agent.id).bytes >= Buffer.byteLength(tail), 'durable tail projected');
  await finish(f, agent, session);
  f.usage.set(agent.id, { usedTokens: 25000, windowTokens: 200000, providerSessionGeneration: generation, requestOutputIncluded: false });
  session = await f.hold(agent.id); const value = budget(accepted(f.store, agent.id));
  assert.equal(value.occupancyBasis, 'exact_session'); assert.equal(value.occupancyTokens, 25000);
  assert.ok(value.postObservationUtf8Bytes >= Buffer.byteLength(tail), 'A warm getter cannot erase post-checkpoint output');
  assert.ok(value.estimatedInputTokens >= 25000 + Buffer.byteLength(tail) + value.submittedUtf8Bytes);
  await finish(f, agent, session);
}));

for (const nativeWork of [false, "tool_call", "work_start"]) {
  test(`warm stale checkpoint refuses ${nativeWork || 'later steering'}`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
    f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
    const chat = await f.createChat('Stale warm proof'), agent = await f.createIdleAgent(chat, 'Guarded reader');
    const session = await f.hold(agent.id), generation = session.engineAgentId;
    await checkpoint(f, agent, session);
    let fence;
    if (nativeWork) {
      session.events.push(nativeWork === 'work_start' ? { type: 'work_start', kind: 'native_tool' }
        : { type: 'tool_call', id: randomUUID(), name: 'unmetered_native', input: {} });
      await until(() => f.store.readEvents(agent.id).some(row => row.event.type === nativeWork), 'native work recorded');
    } else {
      await f.send(agent.id, 'Later uncertain-size steering', { activeRunDelivery: 'steer' });
      await until(() => f.steers.some(row => row.agentId === agent.id), 'steering acknowledged');
      fence = f.steers.at(-1).input.clientMessageId;
    }
    await finish(f, agent, session, fence);
    f.usage.set(agent.id, { usedTokens: 25000, windowTokens: 200000, providerSessionGeneration: generation });
    assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id), undefined);
    await refusedContinuation(f, agent);
    assert.equal(f.store.resumeSessionState(agent.id)?.sessionId, generation);
  }));
}

test('a newer exact checkpoint supersedes durable payload-free native work', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Metered native work'), agent = await f.createIdleAgent(chat, 'Native checkpoint reader');
  let session = await f.hold(agent.id);
  session.events.push({ type: 'work_start', kind: 'native_tool' });
  await until(() => f.store.readEvents(agent.id).some(row => row.event.type === 'work_start'), 'internal work marker persisted');
  const marker = f.store.readEvents(agent.id).find(row => row.event.type === 'work_start').event;
  assert.equal(marker.executionId, accepted(f.store, agent.id).executionId);
  await checkpoint(f, agent, session, 40000); await finish(f, agent, session);
  session = await f.hold(agent.id); const value = budget(accepted(f.store, agent.id));
  assert.equal(value.occupancyBasis, 'exact_session'); assert.equal(value.occupancyTokens, 40000);
  await finish(f, agent, session);
}));

test('third cold turn uses the latest acknowledged completed turn rather than the initial snapshot', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 0, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Three cold turns'), agent = await f.createIdleAgent(chat, 'Cold generation owner');
  let session = await f.hold(agent.id); const generation = session.engineAgentId, original = accepted(f.store, agent.id), frozen = JSON.stringify(original);
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session); await until(() => !session.isAlive(), 'first root exits');
  session = await f.hold(agent.id); const second = accepted(f.store, agent.id);
  assert.equal(budget(second).occupancyTokens, 25000);
  await checkpoint(f, agent, session, 40000); await finish(f, agent, session); await until(() => !session.isAlive(), 'second root exits');
  session = await f.hold(agent.id); const value = budget(accepted(f.store, agent.id));
  assert.equal(session.engineAgentId, generation); assert.equal(value.occupancyTokens, 40000);
  assert.equal(value.occupancyObservation.executionId, second.executionId);
  assert.equal(JSON.stringify(f.store.getProviderInput(original.executionId, true)), frozen);
  await finish(f, agent, session);
}));

test('fresh replacement ignores discarded occupancy and retrieves old submitted evidence omitted from the new input', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Discarded context is not retained'), agent = await f.createIdleAgent(chat, 'Replacement reader');
  const witness = authored(f.store, chat, agent, `DISCARDED_BUDGET_WITNESS ${'saved evidence '.repeat(1900)}`);
  let session = await f.hold(agent.id); const generation = session.engineAgentId, previous = accepted(f.store, agent.id), frozen = JSON.stringify(previous);
  assert.ok(previous.sourceManifest.historyContext.fullyIncludedCommunicationEventIds.includes(witness.eventId), 'Positive control: old session really received the complete witness');
  await finish(f, agent, session);
  f.usage.set(agent.id, { usedTokens: 140000, aggregateTokens: 900000, windowTokens: 200000, providerSessionGeneration: generation });
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverTokens: 150000, globalInstructions: `NEW_REPLACEMENT_RULES ${'Preserve the new required rules. '.repeat(240)}` }));
  for (let i = 0; i < 70; i++) authored(f.store, chat, agent, `NEWER_REPLACEMENT_NOTE_${i} ${'recent detail '.repeat(110)}`, i + 1);
  session = await f.hold(agent.id); assert.notEqual(session.engineAgentId, generation);
  const packet = accepted(f.store, agent.id), value = budget(packet);
  assert.equal(value.occupancyBasis, 'fresh_session'); assert.equal(value.occupancyTokens, 0);
  assert.equal(packet.sourceManifest.historyContext.fullyIncludedCommunicationEventIds.includes(witness.eventId), false);
  assert.equal(supplied(packet).includes('DISCARDED_BUDGET_WITNESS'), false);
  const found = f.ok(await f.tool(session, 'ponderosa_history', { action: 'search', query: 'DISCARDED_BUDGET_WITNESS' }));
  assert.ok(found.hits.some(hit => hit.communicationEventId === witness.eventId), 'Discarded session delivery cannot exclude evidence omitted from its replacement');
  assert.equal(await readAll(f, session, witness.eventId), witness.text);
  assert.equal(JSON.stringify(f.store.getProviderInput(previous.executionId, true)), frozen, 'A replacement cannot rewrite an earlier accepted prompt or manifest');
  await finish(f, agent, session);
}));

test('unknown over-policy occupancy rejects required input before provider dispatch and preserves accepted context', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Explicit context overflow'), agent = await f.createIdleAgent(chat, 'Retained context owner');
  const session = await f.hold(agent.id), generation = session.engineAgentId;
  const packet = accepted(f.store, agent.id), frozen = JSON.stringify(packet);
  await finish(f, agent, session);
  const before = new Set(f.store.sqlite.prepare('SELECT id FROM scheduler_runs WHERE agent_id=?').all(agent.id).map(row => row.id));
  const turnsBefore = f.turns.length;
  f.usage.set(agent.id, { usedTokens: 160000, aggregateTokens: 900000, providerSessionGeneration: generation });
  await f.send(agent.id, 'Required work must not silently discard or replay the original context.');
  const runs = await until(() => {
    const rows = f.store.sqlite.prepare('SELECT id,status,prompt_injection_state FROM scheduler_runs WHERE agent_id=?').all(agent.id).filter(row => !before.has(row.id));
    return rows.length && rows.every(row => row.status === 'failed') ? rows : false;
  }, 'over-policy scheduler Run fails before provider admission');
  assert.equal(runs.length, 1); assert.equal(runs[0].prompt_injection_state, 'not_injected');
  assert.equal(f.turns.length, turnsBefore, 'Overflow cannot execute or silently replay the task');
  assert.equal(f.sessions.get(agent.id), session, 'Overflow cannot substitute a fresh provider root');
  assert.equal(f.store.resumeSessionState(agent.id)?.sessionId, generation);
  assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen);
  assert.equal(new CoordinationV3Store(f.store.sqlite).activeAgentRun(agent.id), undefined);
  const rejection = f.store.sqlite.prepare("SELECT last_delivery_error FROM agent_activations WHERE agent_id=? AND state='failed' ORDER BY created_at DESC LIMIT 1").get(agent.id);
  assert.match(rejection.last_delivery_error, /context policy.*response headroom/i);
  assert.match(rejection.last_delivery_error, /413/);
}));

for (const laterSteering of [false, true]) {
  test(`cold resume ${laterSteering ? 'refuses occupancy made stale by later steering' : 'reuses an exact completed-Run occupancy observation'}`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 0, async f => {
    f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
    const chat = await f.createChat('Observed cold resume'), agent = await f.createIdleAgent(chat, 'Cold reader');
    const session = await f.hold(agent.id), generation = session.engineAgentId;
    const previous = accepted(f.store, agent.id), frozen = JSON.stringify(previous);
    await until(async () => (await f.detail(agent.id)).runOutput.some(output => output.text.includes('Ordinary fixture execution output')), 'initial provider output observed');
    session.events.push({ type: 'context_usage', providerSessionId: generation, providerSessionGeneration: generation,
      usedTokens: 25000, windowTokens: 200000, aggregateTokens: 900000 });
    await until(() => f.store.readEvents(agent.id).some(({ event }) => event.type === 'context_usage' && event.providerSessionGeneration === generation), 'exact occupancy event persisted');
    if (laterSteering) {
      await f.send(agent.id, 'Input accepted after the occupancy observation', { activeRunDelivery: 'steer' });
      await until(() => f.steers.some(steer => steer.agentId === agent.id), 'later steering acknowledged');
    }
    const steeringFence = laterSteering ? f.steers.filter(steer => steer.agentId === agent.id).at(-1)?.input.clientMessageId : undefined;
    if (laterSteering) assert.ok(steeringFence, 'Exact acknowledged steering identity must reach its canonical final reply');
    await finish(f, agent, session, steeringFence);
    await until(() => !session.isAlive(), 'idle owned provider root exits');
    const measured = f.store.acceptedProviderSessionContextUsage(agent.id);
    if (laterSteering) assert.equal(measured, undefined, 'Post-observation steering invalidates the measurement');
    else {
      assert.equal(measured.usage.usedTokens, 25000); assert.equal(measured.executionId, previous.executionId);
      assert.equal(measured.usage.providerSessionGeneration, generation); assert.ok(measured.observedAt);
    }
    if (laterSteering) {
      await refusedContinuation(f, agent);
      assert.equal(JSON.stringify(f.store.getProviderInput(previous.executionId, true)), frozen);
      return;
    }
    const resumed = await f.hold(agent.id), packet = accepted(f.store, agent.id), value = budget(packet);
    assert.notEqual(resumed, session); assert.equal(resumed.engineAgentId, generation);
    {
      assert.equal(value.occupancyBasis, 'exact_session'); assert.equal(value.occupancyTokens, 25000);
      assert.equal(value.occupancyObservation.source, 'accepted_run');
      assert.equal(value.occupancyObservation.providerSessionId, generation);
      assert.equal(value.occupancyObservation.executionId, previous.executionId);
      assert.equal(value.occupancyObservation.observedAt, measured.observedAt);
    }
    assert.equal(JSON.stringify(f.store.getProviderInput(previous.executionId, true)), frozen);
    await finish(f, agent, resumed);
  }));
}

const compactCommand = { name: 'compact', description: 'Native context compaction', source: 'adapter-implemented',
  acceptsArguments: false, insertText: '/compact', status: 'available', invocation: 'runtime' };
const commandUsageEvents = (store, agentId) => store.readEvents(agentId).filter(row => row.event.type === 'context_usage' && row.event.providerCommand);

for (const cold of [false, true]) test(`verified native compact replaces old occupancy for ${cold ? 'cold' : 'warm'} admission`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Native compact authority'), agent = await f.createIdleAgent(chat, 'Compact reader');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), generation = session.engineAgentId, original = accepted(f.store, agent.id), frozen = JSON.stringify(original);
  await checkpoint(f, agent, session, 160000); await finish(f, agent, session);
  f.commandResults.set(agent.id, () => {
    const contextUsage = { usedTokens: 25000, windowTokens: 200000, providerSessionGeneration: generation };
    f.usage.set(agent.id, contextUsage);
    return { outcome: 'completed', contextUsage };
  });
  const invoked = f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
  assert.equal(invoked.invoked, true); assert.equal(f.commands.length, 1);
  const audit = commandUsageEvents(f.store, agent.id).at(-1);
  assert.ok(audit); assert.equal(audit.event.usedTokens, 25000);
  assert.equal(audit.event.providerCommand.executionId, original.executionId);
  const owner = f.store.sqlite.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=?').get(original.executionId);
  assert.equal(audit.event.providerCommand.fencingToken, owner.fencing_token);
  assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id).usage.usedTokens, 25000);
  if (cold) await f.reopen();
  const next = await f.hold(agent.id), value = budget(accepted(f.store, agent.id));
  assert.equal(next.engineAgentId, generation); assert.equal(value.occupancyTokens, 25000);
  assert.equal(value.occupancyObservation.source, 'provider_command');
  assert.equal(value.occupancyObservation.commandInvocationId, audit.event.providerCommand.invocationId);
  assert.equal(value.occupancyObservation.fencingToken, owner.fencing_token);
  assert.equal(value.occupancyObservation.observedAt, audit.ts);
  assert.equal(JSON.stringify(f.store.getProviderInput(original.executionId, true)), frozen);
  assert.equal(f.commands.length, 1, 'A telemetry read cannot replay native compaction');
  await finish(f, agent, next);
}, { providerValidatesResumeBeforeTurn: true }));

test('cold native compact refuses before a throwaway command session while read-only status still works', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 0, async f => {
  const chat = await f.createChat('Cold command boundary'), agent = await f.createIdleAgent(chat, 'Cold command owner');
  f.capabilities.commands = [compactCommand, { ...compactCommand, name: 'status', insertText: '/status' }];
  const session = await f.hold(agent.id), generation = session.engineAgentId;
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  await until(() => !session.isAlive(), 'idle command owner root exits');
  const compact = await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' });
  assert.equal(compact.status, 409); assert.match(compact.body.error, /Context Refresh/);
  assert.equal(f.commands.length, 0, 'Native compaction cannot execute against an unrelated fresh session');
  const status = f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'status' }));
  assert.equal(status.invoked, true); assert.deepEqual(f.commands.map(command => command.name), ['status']);
  assert.equal(f.store.resumeSessionState(agent.id).sessionId, generation);
}));

for (const mode of ['stale', 'malformed', 'wrong_generation', 'leased_race']) test(`native compact keeps success without trusting ${mode} telemetry`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Rejected compact evidence'), agent = await f.createIdleAgent(chat, 'Guarded compact owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), generation = session.engineAgentId;
  await checkpoint(f, agent, session, 160000); await finish(f, agent, session);
  let lease; const coordination = new CoordinationV3Store(f.store.sqlite);
  f.commandResults.set(agent.id, () => {
    f.usage.set(agent.id, { usedTokens: 25000, windowTokens: 200000, providerSessionGeneration: generation });
    if (mode === 'stale') return {}; // A changed generic getter is not command freshness proof.
    if (mode === 'malformed') return { contextUsage: { usedTokens: 'invalid', providerSessionGeneration: generation } };
    if (mode === 'leased_race') {
      coordination.coordinate({ projectId: chat.projectId, conversationId: chat.id, actorScope: 'user:local-operator', idempotencyKey: randomUUID(),
        requests: [{ recipientAgentId: agent.id, lifetime: { kind: 'indefinite' }, payload: { text: 'Owned command-race fixture work' } }] });
      lease = coordination.leaseNextRun({ workerId: 'isolated-compact-race', leaseMs: 60000 });
      assert.ok(lease, 'A canonical lease must race before activeRuns exists');
    }
    return { outcome: 'completed', contextUsage: { usedTokens: 25000, windowTokens: 200000, providerSessionGeneration: mode === 'wrong_generation' ? 'foreign-generation' : generation } };
  });
  try {
    const result = f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
    assert.equal(result.invoked, true); assert.match(result.message, /invoked.*(telemetry|context usage)/i);
    assert.equal(f.commands.length, 1); assert.equal(commandUsageEvents(f.store, agent.id).length, 0);
    if (lease) assert.equal(coordination.activeAgentRun(agent.id).id, lease.runId, 'Command telemetry must not cancel raced work');
    else {
      assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id), undefined, 'Native work invalidates pre-command occupancy even without a proven reduction');
      assert.equal(f.store.acceptedProviderSessionInputEstimate(agent.id), undefined, 'Opaque native work cannot fall back to a plain-text estimate');
    }
  } finally {
    if (lease) coordination.cancelAgentRun({ agentId: agent.id, expectedRunId: lease.runId, idempotencyKey: randomUUID() });
  }
}));

for (const cold of [false, true]) for (const measured of [false, true]) test(`unmeasured native compact fences ${measured ? 'measured' : 'estimated'} context after ${cold ? 'restart' : 'warm command'}`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Native command without telemetry'), agent = await f.createIdleAgent(chat, 'Exact compact owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id), frozen = JSON.stringify(packet);
  if (measured) await checkpoint(f, agent, session, 25000);
  await finish(f, agent, session);
  assert.ok(measured ? f.store.acceptedProviderSessionContextUsage(agent.id) : f.store.acceptedProviderSessionInputEstimate(agent.id));
  f.commandResults.set(agent.id, () => {
    const fence = f.store.readEvents(agent.id).at(-1).event;
    assert.equal(fence.type, 'work_start', 'The fence must be durable before the provider can mutate context');
    assert.equal(fence.executionId, packet.executionId); assert.equal(fence.kind, 'native_tool');
    return { message: 'Compaction started; completion is unconfirmed. Do not repeat the command.' };
  });
  const result = f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
  assert.equal(result.invoked, true); assert.equal(f.commands.length, 1);
  if (cold) await f.reopen();
  assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id), undefined);
  assert.equal(f.store.acceptedProviderSessionInputEstimate(agent.id), undefined);
  await refusedContinuation(f, agent);
  assert.equal(f.commands.length, 1, 'Recovery cannot repeat the native operation');
  assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen);
}, { providerValidatesResumeBeforeTurn: true }));

for (const reason of ['Provider rejected the request', 'Transport closed after submission; outcome is unknown']) test(`native compact ${reason} preserves its pre-invocation accounting fence`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Uncertain native command'), agent = await f.createIdleAgent(chat, 'Native owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id), frozen = JSON.stringify(packet);
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  f.commandResults.set(agent.id, () => { throw new Error(reason); });
  const result = await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' });
  assert.equal(result.status, 409); assert.equal(f.commands.length, 1);
  assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id), undefined);
  assert.equal(f.store.acceptedProviderSessionInputEstimate(agent.id), undefined);
  await f.reopen(); await refusedContinuation(f, agent);
  assert.equal(f.commands.length, 1);
  assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen);
}, { providerValidatesResumeBeforeTurn: true }));

test('explicit Context Refresh retires unknown idle context without inventing a provider handoff or replaying work', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Explicit unknown-context recovery'), agent = await f.createIdleAgent(chat, 'Refresh owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id), frozen = JSON.stringify(packet);
  const oldGeneration = session.engineAgentId;
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  f.commandResults.set(agent.id, () => ({ outcome: 'outcome_unknown', message: 'Native completion unconfirmed. Do not repeat the command.' }));
  f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
  const turns = f.turns.length;
  const refresh = f.ok(await f.api('POST', `/api/agents/${agent.id}/compact`, {}));
  const rollover = await until(() => {
    const r = new CoordinationV3Store(f.store.sqlite).contextRollover(refresh.rolloverId);
    return r && ['completed', 'failed', 'outcome_unknown'].includes(r.state) ? r : false;
  }, 'explicit canonical recovery reaches a durable terminal result');
  assert.equal(rollover.state, 'completed'); assert.equal(rollover.completionReason, 'no_continuation_required');
  assert.equal(rollover.handoffEventId, undefined); assert.equal(rollover.continuationActivationId, undefined);
  assert.equal(f.turns.length, turns, 'Unknown context cannot receive an unmetered handoff turn');
  await until(() => !session.isAlive() && !f.store.resumeSessionState(agent.id), 'owned old runtime exits before new context');
  const next = await f.hold(agent.id), fresh = accepted(f.store, agent.id);
  assert.notEqual(next.engineAgentId, oldGeneration); assert.equal(fresh.sourceManifest.contextBudget.occupancyBasis, 'fresh_session');
  assert.equal(f.commands.length, 1); assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen);
  await finish(f, agent, next);
}, { providerValidatesResumeBeforeTurn: true }));

test('explicit Context Refresh preserves public warm and cold pre-submission failures without replaying them', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Public refused-input recovery'), agent = await f.createIdleAgent(chat, 'Refused-input owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id), frozen = JSON.stringify(packet);
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  f.commandResults.set(agent.id, () => ({ outcome: 'completed', message: 'Compaction completed without updated telemetry.' }));
  f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
  await refusedContinuation(f, agent, 'PUBLIC_REFUSAL_WARM');
  await f.reopen(); await refusedContinuation(f, agent, 'PUBLIC_REFUSAL_COLD');
  const failed = () => f.store.sqlite.prepare(`SELECT obligation.*, run.status, run.prompt_injection_state,
    run.provider_session_id, run.started_at, activation.state activation_state, activation.terminal_outcome,
    injection.state injection_state, injection.submitted_at, injection.acknowledged_at
    FROM required_reply_obligations obligation JOIN scheduler_runs run ON run.id=obligation.run_id
    JOIN agent_activations activation ON activation.id=obligation.source_activation_id
    JOIN scheduler_prompt_injections injection ON injection.run_id=run.id
    WHERE obligation.agent_id=? AND obligation.state='failed' ORDER BY run.fencing_token`).all(agent.id);
  const failures = failed(); assert.equal(failures.length, 2);
  for (const row of failures) {
    assert.equal(row.status, 'failed'); assert.equal(row.prompt_injection_state, 'not_injected');
    assert.equal(row.provider_session_id, null); assert.equal(row.started_at, null);
    assert.equal(row.activation_state, 'failed'); assert.equal(row.terminal_outcome, 'permanent_failure');
    assert.equal(row.injection_state, 'cancelled'); assert.equal(row.submitted_at, null); assert.equal(row.acknowledged_at, null);
  }
  const audit = () => failures.map(row => ({
    obligation: f.store.sqlite.prepare('SELECT * FROM required_reply_obligations WHERE run_id=?').get(row.run_id),
    run: f.store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(row.run_id),
    activation: f.store.sqlite.prepare('SELECT * FROM agent_activations WHERE id=?').get(row.source_activation_id),
    injections: f.store.sqlite.prepare('SELECT * FROM scheduler_prompt_injections WHERE run_id=? ORDER BY sequence').all(row.run_id),
  }));
  const originalAudit = audit();
  const turns = f.turns.length, runCount = f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n;
  const refresh = f.ok(await f.api('POST', `/api/agents/${agent.id}/compact`, {}));
  assert.equal(refresh.mode, 'canonical_refresh');
  assert.equal(new CoordinationV3Store(f.store.sqlite).contextRollover(refresh.rolloverId).completionReason, 'no_continuation_required');
  assert.equal(f.turns.length, turns); assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n, runCount);
  assert.deepEqual(audit(), originalAudit, 'Refresh preserves the rejected inputs and their failed-delivery audit');
  const next = await f.hold(agent.id), fresh = accepted(f.store, agent.id);
  assert.equal(f.turns.length, turns + 1); assert.notEqual(next.engineAgentId, session.engineAgentId);
  assert.equal(fresh.sourceManifest.contextBudget.occupancyBasis, 'fresh_session');
  assert.equal(f.commands.length, 1); assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen);
  await finish(f, agent, next);
  assert.deepEqual(audit(), originalAudit); assert.equal(f.turns.length, turns + 1, 'Only the independent new task executes');
}, { providerValidatesResumeBeforeTurn: true }));

for (const evidence of ['previous_accepted_attempt', 'failed_accepted_attempt', 'submitted', 'acknowledged']) test(`unknown-context refresh holds failed human delivery with ${evidence} evidence`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Failed delivery provenance'), agent = await f.createIdleAgent(chat, 'Provenance owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id), frozen = JSON.stringify(packet);
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  f.commandResults.set(agent.id, () => ({ outcome: 'completed', message: 'Compaction completed without updated telemetry.' }));
  f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
  await refusedContinuation(f, agent);
  const failed = f.store.sqlite.prepare(`SELECT run_id,source_activation_id FROM required_reply_obligations
    WHERE agent_id=? AND state='failed'`).get(agent.id); assert.ok(failed);
  // Retained canonical evidence must win over the current failed/not-injected
  // row, including an older accepted attachment or a cancelled injection that
  // still records submission. These are deliberate negative provenance probes.
  if (evidence === 'previous_accepted_attempt') f.store.sqlite.prepare(`INSERT INTO scheduler_run_activations
    (run_id,activation_id,attached_at,consumed_at) VALUES (?,?,?,?)`)
    .run(packet.executionId, failed.source_activation_id, new Date().toISOString(), new Date().toISOString());
  else if (evidence === 'failed_accepted_attempt') f.store.sqlite.prepare(`UPDATE scheduler_runs
    SET prompt_injection_state='injected',provider_session_id=? WHERE id=?`).run(session.engineAgentId, failed.run_id);
  else f.store.sqlite.prepare(`UPDATE scheduler_prompt_injections SET ${evidence === 'submitted' ? 'submitted_at' : 'acknowledged_at'}=? WHERE run_id=?`)
    .run(new Date().toISOString(), failed.run_id);
  const turns = f.turns.length;
  const refresh = await f.api('POST', `/api/agents/${agent.id}/compact`, {});
  assert.equal(refresh.status, 409); assert.equal(f.turns.length, turns); assert.equal(f.commands.length, 1);
  assert.equal(f.store.resumeSessionState(agent.id).sessionId, session.engineAgentId);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n, 0);
  assert.equal(f.store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(failed.run_id).state, 'failed');
  assert.equal(JSON.stringify(f.store.getProviderInput(packet.executionId, true)), frozen);
}, { providerValidatesResumeBeforeTurn: true }));

test('late compact telemetry cannot cross a newer native command marker', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  const chat = await f.createChat('Native command race'), agent = await f.createIdleAgent(chat, 'Fenced command owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), packet = accepted(f.store, agent.id); await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  let release, entered = 0; const gate = new Promise(resolve => { release = resolve; });
  f.commandResults.set(agent.id, async () => {
    if (++entered === 1) { await gate; return { outcome: 'completed', contextUsage: { usedTokens: 1000, providerSessionGeneration: session.engineAgentId } }; }
    return { outcome: 'outcome_unknown', message: 'Completion unconfirmed; do not repeat.' };
  });
  const first = f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' });
  try {
    await until(() => entered === 1, 'first command awaits its real result');
    // Defense in depth: even another canonical native-work owner cannot let
    // this older command's measurement cross its later opaque boundary.
    f.store.appendEvent(agent.id, { type: 'work_start', kind: 'native_tool', callId: randomUUID(), executionId: packet.executionId });
    release(); f.ok(await first);
    assert.equal(commandUsageEvents(f.store, agent.id).length, 0, 'The older invocation cannot certify a newer native mutation');
    assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id), undefined);
    assert.equal(f.store.acceptedProviderSessionInputEstimate(agent.id), undefined);
  } finally { release(); await first; }
}));

test('a second native command cannot certify context while the first may still mutate it', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  const chat = await f.createChat('Reverse native command race'), agent = await f.createIdleAgent(chat, 'Single mutation owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id); await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  let release, entered = 0; const gate = new Promise(resolve => { release = resolve; });
  f.commandResults.set(agent.id, async () => { if (++entered === 1) await gate;
    return { outcome: 'completed', contextUsage: { usedTokens: 1000, providerSessionGeneration: session.engineAgentId } }; });
  const first = f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' });
  try {
    await until(() => entered === 1, 'first native mutation remains in flight');
    const second = await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' });
    assert.equal(second.status, 409); assert.equal(second.body.retryable, false); assert.equal(f.commands.length, 1);
    assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id), undefined);
    release(); f.ok(await first);
    assert.equal(commandUsageEvents(f.store, agent.id).length, 1); assert.equal(f.store.acceptedProviderSessionContextUsage(agent.id).usage.usedTokens, 1000);
  } finally { release(); await first; }
}));

for (const blocker of ['decision', 'old_request', 'leased', 'injected', 'outcome_unknown']) test(`unknown-context refresh preserves ${blocker} work instead of dropping it`, fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  const chat = await f.createChat('Held context recovery'), agent = await f.createIdleAgent(chat, 'Guarded recovery owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), generation = session.engineAgentId;
  if (blocker === 'decision') f.ok(await f.tool(session, 'ponderosa_decision', { question: 'A real human choice is still required', mode: 'text', blocking: true }));
  if (blocker === 'old_request') {
    const worker = await f.createIdleAgent(chat, 'Unfinished owned worker'); f.plans.set(worker.id, [{ hold: true }]);
    f.ok(await f.tool(session, 'ponderosa_coordinate', { idempotencyKey: randomUUID(), requests: [{ recipientAgentId: worker.id, text: 'Owned unfinished work', lifetime: { kind: 'indefinite' } }] }));
    await until(() => f.turns.some(turn => turn.agentId === worker.id), 'owned delegated work starts');
  }
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  f.commandResults.set(agent.id, () => ({ outcome: 'outcome_unknown', message: 'Native completion unconfirmed. Do not repeat.' }));
  f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
  const coordination = new CoordinationV3Store(f.store.sqlite); let lease;
  if (['leased', 'injected', 'outcome_unknown'].includes(blocker)) {
    const now = new Date(Date.now() + 60000).toISOString();
    coordination.enqueueMessageActivation({ projectId: chat.projectId, agentId: agent.id, scopeKey: `conversation:${chat.id}`,
      messageId: randomUUID(), kind: 'human', payload: { text: 'Separate exact-fence controlled work' }, now });
    lease = coordination.leaseNextRun({ workerId: 'owned-native-recovery-test', now, leaseMs: 60000 }); assert.ok(lease);
    if (blocker !== 'leased') {
      coordination.preparePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, prompt: 'Owned uncertain submission', now });
      coordination.markPromptSubmitted({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, providerSessionId: generation, now });
      if (blocker === 'outcome_unknown') coordination.recoverOrphanedRuns('new-owned-worker', now);
    }
  }
  try {
    const before = f.turns.length;
    const refresh = await f.api('POST', `/api/agents/${agent.id}/compact`, {});
    assert.equal(refresh.status, 409); assert.equal(f.store.resumeSessionState(agent.id).sessionId, generation);
    assert.equal(f.commands.length, 1); assert.equal(f.turns.length, before);
    assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM context_rollovers WHERE agent_id=? AND completion_reason='no_continuation_required'").get(agent.id).n, 0);
  } finally { if (lease && blocker !== 'outcome_unknown') coordination.cancelAgentRun({ agentId: agent.id, expectedRunId: lease.runId, idempotencyKey: randomUUID() }); }
}));

test('canonical idle refresh preserves never-attempted future human input and dispatches it once', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  const chat = await f.createChat('Queued human context recovery'), agent = await f.createIdleAgent(chat, 'Queued recovery owner');
  f.capabilities.commands = [compactCommand];
  const session = await f.hold(agent.id), generation = session.engineAgentId;
  await checkpoint(f, agent, session, 25000); await finish(f, agent, session);
  f.commandResults.set(agent.id, () => ({ outcome: 'outcome_unknown', message: 'Native completion unconfirmed. Do not repeat.' }));
  f.ok(await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'compact' }));
  const coordination = new CoordinationV3Store(f.store.sqlite);
  const event = authored(f.store, chat, agent, 'FUTURE_HUMAN_INPUT_SURVIVES_EXPLICIT_REFRESH');
  const activationId = coordination.enqueueMessageActivation({ projectId: chat.projectId, agentId: agent.id, scopeKey: `conversation:${chat.id}`,
    messageId: event.eventId, kind: 'human', payload: { text: event.text, communication: event }, now: new Date(Date.now() + 2000).toISOString() });
  const original = f.store.sqlite.prepare('SELECT id,payload_json,available_at,created_at FROM agent_activations WHERE id=?').get(activationId);
  f.plans.set(agent.id, [{ hold: true }]); const turns = f.turns.length;
  const refresh = f.ok(await f.api('POST', `/api/agents/${agent.id}/compact`, {}));
  assert.equal(refresh.mode, 'canonical_refresh'); assert.equal(session.isAlive(), false);
  assert.deepEqual(f.store.sqlite.prepare('SELECT id,payload_json,available_at,created_at FROM agent_activations WHERE id=?').get(activationId), original);
  await until(() => f.turns.length === turns + 1, 'preserved future human input starts after retirement');
  const next = f.sessions.get(agent.id); assert.notEqual(next.engineAgentId, generation);
  assert.ok(supplied(accepted(f.store, agent.id)).includes('FUTURE_HUMAN_INPUT_SURVIVES_EXPLICIT_REFRESH'));
  await finish(f, agent, next);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(activationId).n, 1);
  assert.equal(f.commands.length, 1);
}));

let broadcastSequence = 0;
function broadcast(store, chat, text) {
  const event = { schemaVersion: 2, eventId: randomUUID(), projectId: chat.projectId, conversationId: chat.id,
    sender: { kind: 'user', userId: 'local-operator' }, intent: 'broadcast', audience: { kind: 'organization', organizationId: chat.projectId }, text, createdAt: new Date(Date.now() + broadcastSequence++).toISOString() };
  store.appendCommunicationEvent(event);
  const message = store.appendConversationMessage(chat.id, { text }, undefined, 'main', undefined, undefined, event.eventId);
  assert.ok(message); return { ...event, messageId: message.id };
}

test('bounded continuation pages preserve FIFO cursor delivery without skipping or replaying pending Broadcasts', { ...fixtureTestOptions, timeout: 60000 }, t => withBudgetFixture(t, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverTokens: 150000, contextRolloverEnabled: false }));
  const chat = await f.createChat('FIFO context continuation'), agent = await f.createIdleAgent(chat, 'Ordered reader');
  broadcast(f.store, chat, 'INITIAL_BROADCAST_CURSOR_ANCHOR');
  let session = await f.hold(agent.id); await checkpoint(f, agent, session, 1000, 120000); await finish(f, agent, session);
  const notes = Array.from({ length: 65 }, (_, i) => broadcast(f.store, chat, `FIFO_BUDGET_${String(i).padStart(3, '0')} ${'ordered detail '.repeat(95)}`));
  const delivered = []; let batches = 0;
  while (delivered.length < notes.length) {
    assert.ok(batches++ < 10, 'Continuation must make bounded progress');
    session = await f.hold(agent.id); const packet = accepted(f.store, agent.id), text = supplied(packet);
    const included = new Set(packet.sourceManifest.historyContext.fullyIncludedCommunicationEventIds);
    const batch = notes.filter(note => included.has(note.eventId));
    assert.ok(batch.length > 0, 'Pending oldest messages must not starve');
    assert.deepEqual(batch.map(note => note.eventId), notes.slice(delivered.length, delivered.length + batch.length).map(note => note.eventId), 'A context budget cannot skip undelivered FIFO content');
    let position = -1;
    for (const note of batch) { const next = text.indexOf(note.text); assert.ok(next > position, 'Broadcast order in the actual prompt is FIFO'); position = next; }
    assert.equal(batch.some(note => delivered.includes(note.eventId)), false);
    delivered.push(...batch.map(note => note.eventId)); await checkpoint(f, agent, session, 1000, 120000); await finish(f, agent, session);
  }
  assert.ok(batches > 1, 'The fixture must require multiple budget-limited submissions');
  assert.deepEqual(delivered, notes.map(note => note.eventId));
}));

test('oversized FIFO head submits its exact read reference before advancing to the following Broadcast', { ...fixtureTestOptions, timeout: 60000 }, t => withBudgetFixture(t, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Oversized ordered Broadcast'), agent = await f.createIdleAgent(chat, 'Referenced FIFO reader');
  broadcast(f.store, chat, 'OVERSIZED_FIFO_INITIAL_CURSOR');
  let session = await f.hold(agent.id); await finish(f, agent, session);
  const body = `OVERSIZED_FIFO_BEGIN\n${'東京 🌲 café\0\n'.repeat(10000)}OVERSIZED_FIFO_END`;
  const large = broadcast(f.store, chat, body), following = broadcast(f.store, chat, 'FOLLOWING_OVERSIZED_FIFO_MESSAGE');
  session = await f.hold(agent.id);
  const packet = accepted(f.store, agent.id), context = packet.sourceManifest.historyContext;
  assert.ok(packet.exactPrompt.includes(`communicationEventId:${JSON.stringify(large.eventId)}`), 'The retained head must identify its authorized complete read');
  assert.ok(context.clippedCommunicationEventIds.includes(large.eventId));
  assert.equal(context.fullyIncludedCommunicationEventIds.includes(large.eventId), false);
  assert.equal(context.fullyIncludedCommunicationEventIds.includes(following.eventId), false, 'Do not skip the oversized FIFO head');
  assert.equal(await readAll(f, session, large.eventId), body, 'The complete Unicode remainder stays authorized');
  await finish(f, agent, session);
  session = await f.hold(agent.id);
  const next = accepted(f.store, agent.id);
  assert.ok(next.sourceManifest.historyContext.fullyIncludedCommunicationEventIds.includes(following.eventId));
  assert.ok(next.exactPrompt.includes(following.text));
  assert.equal(next.exactPrompt.includes(`communicationEventId:${JSON.stringify(large.eventId)}`), false, 'The acknowledged reference must not replay');
  assert.equal(next.exactPrompt.includes('OVERSIZED_FIFO_BEGIN'), false);
  await finish(f, agent, session);
}));
