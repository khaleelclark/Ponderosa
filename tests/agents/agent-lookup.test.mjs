import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { AgentStore, CoordinationV3Store, importedAgentHistoryPath } from '@ponderosa/agents';
import { boundedFrozenSeedHistory, communicationSeedProvenance, renderSeedHistoryMessage } from '@ponderosa/core/seed-history';

async function withStores(t, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-agent-lookup-'));
  const stores = new Set();
  const open = name => { const store = new AgentStore(path.join(root, name)); stores.add(store); return store; };
  const seed = store => {
    const project = store.createProject({ label: 'Lookup fixture', hostPath: root, defaultEngine: 'codex' });
    const chat = store.createConversation(project.id, { title: 'Lookup Chat' });
    return store.createAgent(project.id, { title: 'Lookup Agent', engine: 'codex', conversationId: chat.id });
  };
  let passed = false;
  try { await run({ root, open, seed, close(store) { store.close(); stores.delete(store); } }); passed = true; }
  finally {
    for (const store of stores) store.close();
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed disposable fixture retained: ${root}`);
  }
}

test('repeated Agent lookups prepare one typed statement per database authority', t => withStores(t, async f => {
  const prepares = new Map(), original = Database.prototype.prepare;
  Database.prototype.prepare = function (sql, ...args) {
    if (sql.startsWith('select ') && sql.includes('from "agents"') &&
        sql.includes('"agents"."id" = ?') && sql.includes('"agents"."deleted_at" is null')) {
      prepares.set(this, (prepares.get(this) ?? 0) + 1);
    }
    return original.call(this, sql, ...args);
  };
  try {
    const first = f.open('first'), a = f.seed(first);
    const second = f.open('second'), b = f.seed(second);
    for (let index = 0; index < 50; index++) {
      assert.deepEqual(first.getAgent(a.id), a);
      assert.deepEqual(second.getAgent(b.id), b);
      assert.equal(first.getAgent(b.id), undefined);
      assert.equal(second.getAgent(a.id), undefined);
    }
    assert.equal(prepares.get(first.sqlite), 1);
    assert.equal(prepares.get(second.sqlite), 1);
  } finally { Database.prototype.prepare = original; }
}));

test('prepared lookups hydrate fresh metadata and retain deletion and owner-Chat guards', t => withStores(t, async f => {
  const store = f.open('fresh'), agent = f.seed(store);
  const initial = store.getAgent(agent.id);
  initial.title = 'Caller mutation';
  assert.equal(store.getAgent(agent.id).title, agent.title);
  const updated = store.updateAgent(agent.id, { title: 'Updated Agent' });
  assert.deepEqual(store.getAgent(agent.id), updated);
  store.setImportedHistory(agent.id, 'Private import', [{ role: 'assistant', text: 'Synthetic history' }]);
  assert.equal(store.getAgent(agent.id).importedFrom, 'Private import');
  assert.equal(store.getAgent(agent.id).importedHistoryCount, 1);
  const before = store.getAgent(agent.id);
  // Exercise row visibility and validation without committing malformed canonical state.
  store.sqlite.exec('SAVEPOINT lookup_visibility');
  try {
    store.sqlite.prepare('UPDATE agents SET deleted_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', agent.id);
    assert.equal(store.getAgent(agent.id), undefined);
    store.sqlite.prepare('UPDATE agents SET deleted_at = NULL, conversation_id = NULL WHERE id = ?').run(agent.id);
    assert.throws(() => store.getAgent(agent.id), /has no owner Chat/u);
  } finally { store.sqlite.exec('ROLLBACK TO lookup_visibility; RELEASE lookup_visibility'); }
  assert.deepEqual(store.getAgent(agent.id), before);
}));

test('lookups use the reopened database and remain isolated from other stores', t => withStores(t, async f => {
  let first = f.open('reopen');
  const agent = f.seed(first);
  first.updateAgent(agent.id, { title: 'Durable update' });
  const expected = first.getAgent(agent.id);
  f.close(first);
  const other = f.open('independent'), otherAgent = f.seed(other);
  first = f.open('reopen');
  assert.deepEqual(first.getAgent(agent.id), expected);
  assert.equal(other.getAgent(agent.id), undefined);
  assert.equal(first.getAgent(otherAgent.id), undefined);
  assert.equal(first.getAgent('missing-agent'), undefined);
  assert.equal(other.getAgent(otherAgent.id).title, otherAgent.title);
}));

for (const surviving of [false, true]) test(`missing owner Chat is quarantined without reassigning private history; survivor=${surviving}`, t => withStores(t, async f => {
  const store = f.open('missing-owner'), agent = f.seed(store);
  if (surviving) store.createConversation(agent.projectId, { title: 'Unrelated Chat' });
  store.setImportedHistory(agent.id, 'Private source', [{ role: 'user', text: 'Private history must keep its original owner' }]);
  const data = path.join(f.root, 'missing-owner');
  const canonical = path.join(data, 'projects', agent.projectId, 'agents', agent.id, 'agent.json');
  const imported = importedAgentHistoryPath(data, agent.projectId, agent.id);
  const before = await readFile(canonical), history = await readFile(imported);
  f.close(store);
  await rename(path.join(data, 'projects', agent.projectId, 'conversations', agent.conversationId), path.join(f.root, 'owner-retained-for-repair'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = f.open('missing-owner'), projected = reopened.getAgent(agent.id);
    assert.ok(!projected || projected.conversationId === agent.conversationId, 'Recovery must never substitute a surviving Chat');
    assert.equal((await readFile(canonical)).equals(before), true, 'Quarantine must not rewrite canonical ownership');
    assert.equal((await readFile(imported)).equals(history), true, 'Private history must remain intact');
    assert.ok(reopened.startupProfile().recoveryIssues.some(issue => issue.projectId === agent.projectId && issue.detail.includes(agent.conversationId)));
    f.close(reopened);
  }
}));

test('ownership proof change rejects older checkpoints while healthy current checkpoints remain reusable', t => withStores(t, async f => {
  let store = f.open('checkpoint'); const agent = f.seed(store);
  f.close(store); store = f.open('checkpoint'); f.close(store);
  const marker = path.join(f.root, 'checkpoint', '.projection-clean-shutdown.json');
  const certificate = JSON.parse(await readFile(marker, 'utf8'));
  certificate.projectionVersion = 2;
  await writeFile(marker, JSON.stringify(certificate));
  store = f.open('checkpoint');
  assert.equal(store.startupProfile().mode, 'recovery');
  assert.equal(store.getAgent(agent.id).conversationId, agent.conversationId);
  f.close(store); store = f.open('checkpoint');
  assert.equal(store.startupProfile().mode, 'clean');
  assert.equal(store.getAgent(agent.id).conversationId, agent.conversationId);
}));

test('rollover tails use the rendered allowance beyond 40 messages and 24k while frozen evidence survives reopen', t => withStores(t, async f => {
  let store = f.open('rollover'); const agent = f.seed(store);
  const author = (text, recipient = agent) => {
    const event = { schemaVersion: 2, eventId: randomUUID(), projectId: agent.projectId,
      conversationId: agent.conversationId, sender: { kind: 'user', userId: 'operator' },
      intent: 'user_dm', audience: { kind: 'user_agent', userId: 'operator', agentId: recipient.id },
      text, createdAt: new Date().toISOString() };
    store.appendCommunicationEvent(event); return event;
  };
  const events = Array.from({ length: 120 }, (_, index) => author(`Complete fact ${index}: ${'🌲 hello '.repeat(12)}`));
  const input = { agentId: agent.id, currentConversationId: agent.conversationId,
    submittedCommunicationEventIds: events.map(event => event.eventId), maxUtf8Bytes: 150000 };
  const bound = store.bindContextRolloverBoundary(input);
  assert.equal(bound.recentTail.length, events.length, 'Neither the 40-message nor 80-ID legacy ceiling may select history');
  const frozen = { agentId: agent.id, currentConversationId: agent.conversationId,
    boundary: { canonicalOrdinal: bound.canonicalOrdinal, communicationEventId: bound.communicationEventId }, recentTail: bound.recentTail };
  const resolved = store.resolveContextRolloverTail(frozen);
  assert.deepEqual(resolved.map(message => message.text), events.map(event => event.text));
  const messages = resolved.map(message => ({ role: 'user', text: message.text,
    provenance: communicationSeedProvenance(message.event, agent.id) }));
  const renderedBytes = messages.reduce((bytes, message) => bytes + Buffer.byteLength(renderSeedHistoryMessage(message)) + 1, 64);
  assert.ok(renderedBytes > 24000 && renderedBytes < input.maxUtf8Bytes);
  assert.deepEqual(boundedFrozenSeedHistory(messages, input.maxUtf8Bytes), messages);
  const clipped = boundedFrozenSeedHistory(messages, renderedBytes - 1000);
  assert.equal(clipped.length, messages.length);
  assert.deepEqual(clipped.map(message => message.provenance.eventId), messages.map(message => message.provenance.eventId));
  assert.ok(clipped.some((message, index) => message.text !== messages[index].text));
  assert.ok(clipped.reduce((bytes, message) => bytes + Buffer.byteLength(renderSeedHistoryMessage(message)) + 1, 64) <= renderedBytes - 1000);
  assert.deepEqual(store.resolveContextRolloverTail(frozen).map(message => message.text), events.map(event => event.text), 'Clipping presentation must not alter complete canonical retrieval');
  store.resetCompactionHistoryMaterializationStats();
  const smaller = store.bindContextRolloverBoundary({ ...input, maxUtf8Bytes: 6000 });
  assert.ok(smaller.recentTail.length > 0 && smaller.recentTail.length < bound.recentTail.length);
  assert.deepEqual(smaller.recentTail, bound.recentTail.slice(-smaller.recentTail.length), 'Keep the newest complete tail in canonical order');
  const reads = store.compactionHistoryMaterializationStats();
  assert.ok(reads.indexedRows <= smaller.recentTail.length + 2, 'Streaming stops at the first record outside the allowance');
  assert.equal(reads.journalEventArrayReads, 0, 'Tail selection must not read the archive');
  const coordination = new CoordinationV3Store(store.sqlite);
  const request = { projectId: agent.projectId, agentId: agent.id, oldProviderSessionId: 'frozen-source',
    providerSessionGeneration: 'frozen-source', detectedOccupancy: 160000, threshold: 150000, lowWaterMark: 90000,
    sourceRunId: 'frozen-source-run', compactionCutoffOrdinal: bound.canonicalOrdinal,
    compactionCutoffEventId: bound.communicationEventId, recentTail: bound.recentTail,
    sourceActivationIds: [], scopeKey: `agent:${agent.id}`, conversationId: agent.conversationId };
  const record = coordination.requestContextRollover(request);
  assert.equal(record.created, true);
  assert.equal(coordination.requestContextRollover(request).created, false);
  const saved = store.sqlite.prepare('SELECT recent_tail_event_ids_json, recent_tail_hashes_json FROM context_rollovers WHERE id=?').get(record.rollover.id);
  assert.throws(() => coordination.requestContextRollover({ ...request, recentTail: smaller.recentTail }), /replay conflicts/);
  author('A later message must not replace the frozen source list');
  f.close(store); store = f.open('rollover');
  assert.deepEqual(store.sqlite.prepare('SELECT recent_tail_event_ids_json, recent_tail_hashes_json FROM context_rollovers WHERE id=?').get(record.rollover.id), saved);
  assert.deepEqual(store.resolveContextRolloverTail(frozen).map(message => message.text), events.map(event => event.text));
  assert.deepEqual(store.resolveContextRolloverTail({ ...frozen, recentTail: bound.recentTail.slice(-40) }).map(message => message.text), events.slice(-40).map(event => event.text), 'An existing smaller frozen binding is not widened by the new policy');
}));

test('rollover allowance and frozen-tail transport guards preserve private scope and reject overflow', t => withStores(t, async f => {
  const store = f.open('rollover-guards'), agent = f.seed(store);
  const other = store.createAgent(agent.projectId, { title: 'Other private owner', engine: 'codex', conversationId: agent.conversationId });
  const event = { schemaVersion: 2, eventId: randomUUID(), projectId: agent.projectId,
    conversationId: agent.conversationId, sender: { kind: 'user', userId: 'operator' }, intent: 'user_dm',
    audience: { kind: 'user_agent', userId: 'operator', agentId: other.id }, text: 'Private foreign fact', createdAt: new Date().toISOString() };
  store.appendCommunicationEvent(event);
  const input = { agentId: agent.id, currentConversationId: agent.conversationId, submittedCommunicationEventIds: [event.eventId] };
  assert.throws(() => store.bindContextRolloverBoundary({ ...input, maxUtf8Bytes: 5000 }), /unavailable or unauthorized/);
  for (const maxUtf8Bytes of [0, -1, NaN, Infinity, 256 * 1024 + 1]) {
    assert.throws(() => store.bindContextRolloverBoundary({ ...input, maxUtf8Bytes }), /valid rendered tail allowance/);
  }
  assert.throws(() => boundedFrozenSeedHistory([{ role: 'user', text: 'Required provenance cannot fit' }], 1), /bounded presentation|aggregate bound/);
  const coordination = new CoordinationV3Store(store.sqlite);
  assert.throws(() => coordination.requestContextRollover({ projectId: agent.projectId, agentId: agent.id,
    oldProviderSessionId: 'oversized', providerSessionGeneration: 'oversized', detectedOccupancy: 160000,
    threshold: 150000, lowWaterMark: 90000, sourceRunId: 'source', compactionCutoffOrdinal: 1,
    compactionCutoffEventId: event.eventId, recentTail: Array.from({ length: 3000 }, (_, index) => ({ communicationEventId: `event-${index}`, contentSha256: 'a'.repeat(64) })),
    sourceActivationIds: [], scopeKey: `agent:${agent.id}` }), /bounded unique/);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers').get().n, 0);
}));
