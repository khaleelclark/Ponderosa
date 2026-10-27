import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import { withFixture, until, fixtureTestOptions } from '../shared/fixture.mjs';

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

async function withBudgetFixture(t, work) {
  let store; const pages = [], usage = new Map();
  await withFixture(t, f => work({ ...f, store, pages, usage }), {
    providerContextUsage: ({ agentId }) => usage.get(agentId) ?? { usedTokens: 1000, windowTokens: 200000 },
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

async function withRuntimePoolBudgetFixture(t, maxIdleSessions, work) {
  const previous = process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
  process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = String(maxIdleSessions);
  try { await withBudgetFixture(t, work); }
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

test('continuation budgets charge exact-generation occupancy, not aggregate traffic or unverified generations', fixtureTestOptions, t => withRuntimePoolBudgetFixture(t, 2, async f => {
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverEnabled: false }));
  const chat = await f.createChat('Exact session occupancy'), agent = await f.createIdleAgent(chat, 'Occupancy reader');
  let session = await f.hold(agent.id); const generation = session.engineAgentId;
  await finish(f, agent, session);
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
  assert.equal(value.occupancyBasis, 'unavailable'); assert.equal(value.occupancyTokens, 0);
  assert.equal(value.providerSessionGeneration, undefined, 'Wrong-generation observations must not become accepted occupancy evidence');
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
    const resumed = await f.hold(agent.id), packet = accepted(f.store, agent.id), value = budget(packet);
    assert.notEqual(resumed, session); assert.equal(resumed.engineAgentId, generation);
    if (laterSteering) {
      assert.equal(value.occupancyBasis, 'unavailable'); assert.equal(value.occupancyTokens, 0);
      assert.equal(value.occupancyObservation, undefined);
    } else {
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
  let session = await f.hold(agent.id); await finish(f, agent, session);
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
    delivered.push(...batch.map(note => note.eventId)); await finish(f, agent, session);
  }
  assert.ok(batches > 1, 'The fixture must require multiple budget-limited submissions');
  assert.deepEqual(delivered, notes.map(note => note.eventId));
}));
