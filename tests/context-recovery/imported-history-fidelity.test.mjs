import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { AgentStore, CoordinationV3Store, importedAgentHistoryPath } from '@ponderosa/agents';

const digest = text => createHash('sha256').update(text).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
async function ready(store, agentId) {
  const deadline = Date.now() + 10000;
  do {
    const availability = store.getImportedHistoryAvailability(agentId);
    if (availability.status === 'ready') return availability.archiveVersion;
    assert.notEqual(availability.status, 'unavailable', 'Admitted imported archive became unavailable');
    await yieldToLoop();
  } while (Date.now() < deadline);
  assert.fail('Imported archive did not finish its bounded indexing turns');
}
async function fixture(t, work) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ponderosa-imported-fidelity-')));
  const dataDir = path.join(root, 'data');
  let store = new AgentStore(dataDir), passed = false;
  const project = store.createProject({ label: 'Imported history fidelity', hostPath: root, defaultEngine: 'codex', chatOwned: true });
  const chat = store.getConversation(project.lastConversationId);
  const agent = store.createAgent(project.id, { title: 'Archive owner', engine: 'codex', conversationId: chat.id });
  const f = {
    root, dataDir, project, chat, agent,
    get store() { return store; },
    pathname: id => importedAgentHistoryPath(dataDir, project.id, id),
    createAgent: title => store.createAgent(project.id, { title, engine: 'codex', conversationId: chat.id }),
    reopen() { store.close(); store = new AgentStore(dataDir); },
  };
  try { await work(f); passed = true; }
  finally {
    store.close();
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic('Retained owned imported-history fixture: ' + root);
  }
}

test('completed deferred imported indexing preserves the clean restart checkpoint', { timeout: 20000 }, t => fixture(t, async f => {
  const messages = Array.from({ length: 48 }, (_, index) => ({ role: 'assistant', text: `CHECKPOINTARCHIVEWITNESS ${index}` }));
  f.store.setImportedHistory(f.agent.id, 'Checkpoint archive', messages);
  f.reopen();
  assert.equal(f.store.startupProfile().mode, 'recovery');
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'preparing');
  const version = await ready(f.store, f.agent.id);
  f.reopen();
  assert.equal(f.store.startupProfile().mode, 'clean', 'Projection-only deferred writes must not force another archive rebuild');
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'ready');
  assert.equal(search(f.store, f.agent.id, version, 'CHECKPOINTARCHIVEWITNESS').eligibleMessages, messages.length);
  f.reopen();
  assert.equal(f.store.startupProfile().mode, 'clean');
  assert.deepEqual(f.store.getImportedHistory(f.agent.id).messages, messages);
}));

test('a clean checkpoint preserves preparing state and safely resumes a fenced partial index', { timeout: 20000 }, t => fixture(t, async f => {
  const messages = Array.from({ length: 48 }, (_, index) => ({ role: 'assistant', text: `PARTIALCHECKPOINTWITNESS ${index}` }));
  f.store.setImportedHistory(f.agent.id, 'Partial checkpoint archive', messages);
  f.reopen();
  await yieldToLoop();
  const indexed = f.store.sqlite.prepare('SELECT count(*) count FROM imported_history_fts').get().count;
  assert.ok(indexed > 0 && indexed < messages.length, 'Close must interrupt actual indexing work');
  f.reopen();
  assert.equal(f.store.startupProfile().mode, 'clean');
  const partial = f.store.getImportedHistoryAvailability(f.agent.id);
  assert.equal(partial.status, 'preparing');
  assert.throws(() => search(f.store, f.agent.id, partial.archiveVersion, 'PARTIALCHECKPOINTWITNESS'), /preparing/i);
  const version = await ready(f.store, f.agent.id);
  assert.equal(search(f.store, f.agent.id, version, 'PARTIALCHECKPOINTWITNESS').eligibleMessages, messages.length);
  f.reopen();
  assert.equal(f.store.startupProfile().mode, 'clean');
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'ready');
}));

for (const source of ['canonical files', 'untracked projections', 'SQLite authority']) {
  test(`writes to ${source} between deferred index turns preserve their recovery boundary`, { timeout: 20000 }, t => fixture(t, async f => {
    const messages = Array.from({ length: 48 }, (_, index) => ({ role: 'assistant', text: `DIRTYCHECKPOINTWITNESS ${index}` }));
    f.store.setImportedHistory(f.agent.id, 'Dirty checkpoint archive', messages);
    f.reopen();
    await yieldToLoop();
    const indexed = f.store.sqlite.prepare('SELECT count(*) count FROM imported_history_fts').get().count;
    assert.ok(indexed > 0 && indexed < messages.length, 'Authoritative write must interleave actual indexing turns');
    let requestBefore;
    if (source === 'canonical files') f.store.updateAgent(f.agent.id, { title: 'Canonical edit between indexing turns' });
    else if (source === 'untracked projections') {
      f.store.sqlite.prepare("UPDATE imported_history_messages SET text = 'Unaccounted projection edit' WHERE agent_id = ? AND sequence = 0").run(f.agent.id);
    } else {
      const requests = new CoordinationV3Store(f.store.sqlite).coordinate({
        projectId: f.project.id, conversationId: f.chat.id, actorScope: 'user:local-operator', idempotencyKey: randomUUID(),
        requests: [{ recipientAgentId: f.agent.id, lifetime: { kind: 'indefinite' } }],
      });
      requestBefore = f.store.sqlite.prepare('SELECT * FROM coordination_requests WHERE id=?').get(requests.requestIds[0]);
    }
    await ready(f.store, f.agent.id);
    f.reopen();
    assert.equal(f.store.startupProfile().mode, source === 'SQLite authority' ? 'clean' : 'recovery',
      'Only canonical V3 authority may reuse history views; deferred indexing must not credit unrelated projection changes');
    if (source === 'canonical files') assert.equal(f.store.getAgent(f.agent.id).title, 'Canonical edit between indexing turns');
    else if (requestBefore) assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM coordination_requests WHERE id=?').get(requestBefore.id), requestBefore);
    await ready(f.store, f.agent.id);
    assert.deepEqual(f.store.getImportedHistory(f.agent.id).messages, messages);
  }));
}
function search(store, agentId, archiveVersion, query, limit = 8) {
  const { response } = store.searchImportedHistory({ agentId, archiveVersion, query, limit });
  assert.equal(response.source, 'imported');
  assert.equal(response.untrustedHistoricalData, true);
  assert.equal(response.utf8Bytes, bytes(response));
  assert.ok(bytes(response) <= 6000, 'Whole serialized search response must fit its UTF8 budget');
  assert.ok(response.hits.length <= 8);
  for (const hit of response.hits) {
    assert.ok(Buffer.byteLength(hit.excerpt.text, 'utf8') <= 640);
    assert.equal(hit.excerpt.sha256, digest(hit.excerpt.text));
  }
  return response;
}
function reassemble(store, agentId, archiveVersion, hit, original, options = {}) {
  const originalPoints = [...original];
  let continuation, previous = 0, text = '', chunks = 0;
  do {
    const { response, audit } = store.readImportedHistory({ agentId, archiveVersion, reference: hit.reference,
      ...(continuation ? { continuation } : {}), ...options });
    assert.equal(response.utf8Bytes, bytes(response));
    assert.ok(bytes(response) <= 8000, 'Whole serialized read response must fit its UTF8 budget');
    const message = response.messages[response.requestedMessageIndex];
    assert.equal(message.reference, hit.reference);
    assert.equal(message.contentSha256, digest(original));
    assert.equal(message.totalCodePoints, originalPoints.length);
    assert.equal(message.totalUtf8Bytes, Buffer.byteLength(original, 'utf8'));
    assert.equal(message.startCodePoint, previous);
    assert.equal(message.text, originalPoints.slice(message.startCodePoint, message.endCodePoint).join(''));
    assert.equal(message.complete, message.endCodePoint === originalPoints.length);
    assert.equal(Boolean(message.continuation), !message.complete);
    assert.ok(message.complete || message.endCodePoint > previous, 'Every unfinished read must advance');
    assert.ok(audit.selected.some(item => item.reference === hit.reference && item.startCodePoint === previous));
    text += message.text; previous = message.endCodePoint; continuation = message.continuation;
    assert.ok(++chunks < 1000, 'Continuation must terminate');
  } while (continuation);
  assert.equal(text, original);
  return chunks;
}

test('imported archive retains >100k Unicode/control text and retrieves late facts with exact bounded chunks', { timeout: 20000 }, t => fixture(t, async f => {
  const retained = '\uFEFF' + '  Déjà vu 🌲 e\u0301 漢字 "quoted" \\ \r\n\t\u0000\u0001\u001f '.repeat(6000) + ' LATEFIDELITYWITNESS\n  ';
  assert.ok(retained.length > 100000);
  const messages = [{ role: 'user', text: retained, createdAt: '2021-02-03T04:05:06.000Z' }];
  f.store.setImportedHistory(f.agent.id, 'Exact retained transcript', messages);
  const version = await ready(f.store, f.agent.id);
  assert.deepEqual(f.store.getImportedHistory(f.agent.id).messages, messages);
  const canonical = JSON.parse(await readFile(f.pathname(f.agent.id), 'utf8'));
  assert.deepEqual(canonical.messages, messages);
  const found = search(f.store, f.agent.id, version, 'LATEFIDELITYWITNESS', 1);
  assert.equal(found.hits.length, 1);
  const hit = found.hits[0];
  assert.equal(hit.sourceLabel, 'Imported History');
  assert.equal(hit.createdAt, messages[0].createdAt);
  assert.equal(hit.role, 'user');
  assert.equal(hit.contentSha256, digest(retained));
  assert.equal(hit.excerpt.text, [...retained].slice(hit.excerpt.startCodePoint, hit.excerpt.endCodePoint).join(''));
  assert.ok(reassemble(f.store, f.agent.id, version, hit, retained) > 1);
  // Observe actual SQLite result materialization, rather than clipping a full
  // returned row in this test. Neither the prompt seed nor retrieval may fetch
  // the enormous text into JS merely to take a bounded preview.
  const sqlite = f.store.sqlite, prepare = sqlite.prepare;
  const materialized = [];
  sqlite.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    return new Proxy(statement, { get(target, property) {
      const member = Reflect.get(target, property, target);
      if ((property === 'get' || property === 'all') && typeof member === 'function') return (...args) => {
        const result = member.apply(target, args);
        for (const row of Array.isArray(result) ? result : result ? [result] : []) {
          for (const [key, value] of Object.entries(row)) if (typeof value === 'string' || Buffer.isBuffer(value)) materialized.push({ sql, key, bytes: Buffer.byteLength(value) });
        }
        return result;
      };
      return typeof member === 'function' ? member.bind(target) : member;
    } });
  };
  try {
    const seed = f.store.getImportedHistoryMessagePage(f.agent.id, { limit: 1 });
    assert.equal(seed.items.length, 1);
    assert.ok(Buffer.byteLength(seed.items[0].text) < 25000);
    search(f.store, f.agent.id, version, 'LATEFIDELITYWITNESS', 1);
    f.store.readImportedHistory({ agentId: f.agent.id, archiveVersion: version, reference: hit.reference });
    assert.ok(materialized.length);
    assert.ok(materialized.every(item => item.bytes <= 32000), 'Imported text crossed SQLite as an unbounded JS value');
  } finally { sqlite.prepare = prepare; }
}));

test('guidance provenance never consumes genuine duplicate system messages or invents original timestamps', { timeout: 20000 }, t => fixture(t, async f => {
  const guidance = 'GUIDANCEFIDELITYWITNESS \r\n\t🌲'.repeat(5000);
  const duplicate = 'Imported initial instructions:\nActual authored SYSTEMDUPLICATEWITNESS';
  const messages = [{ role: 'system', text: duplicate }, { role: 'system', text: duplicate },
    { role: 'assistant', text: 'ANSWERFIDELITYWITNESS', createdAt: '2020-01-02T03:04:05.000Z' }];
  f.store.setImportedHistory(f.agent.id, 'Separated guidance', messages, guidance);
  const version = await ready(f.store, f.agent.id);
  const archived = f.store.getImportedHistory(f.agent.id);
  assert.equal(archived.initialInstructions, guidance);
  assert.deepEqual(archived.messages, messages);
  const found = search(f.store, f.agent.id, version, 'SYSTEMDUPLICATEWITNESS');
  assert.equal(found.hits.length, 2);
  assert.notEqual(found.hits[0].reference, found.hits[1].reference);
  assert.deepEqual(found.hits.map(hit => hit.sequence), [0, 1]);
  for (const hit of found.hits) {
    assert.equal(hit.sourceLabel, 'Imported History');
    assert.equal(hit.role, 'system');
    assert.equal('createdAt' in hit, false);
    assert.equal(hit.importedAt, archived.importedAt);
    reassemble(f.store, f.agent.id, version, hit, duplicate);
  }
  const instruction = search(f.store, f.agent.id, version, 'GUIDANCEFIDELITYWITNESS').hits;
  assert.equal(instruction.length, 1);
  assert.equal(instruction[0].sourceLabel, 'Imported Guidance');
  assert.equal(instruction[0].role, 'system');
  assert.equal('createdAt' in instruction[0], false);
  assert.ok(reassemble(f.store, f.agent.id, version, instruction[0], guidance) > 1);
}));

test('existing archives index in yielding turns, distinguish preparing from no-match and preserve bytes across rebuild/restart', { timeout: 20000 }, t => fixture(t, async f => {
  const messages = Array.from({ length: 96 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'system', text: `EXISTINGARCHIVEWITNESS ${index}\r\n🌲` }));
  // This unmarked, pre-feature archive remains authored history, even when a
  // real system message resembles the old guidance wrapper.
  messages[0].text = 'Imported initial instructions:\nEXISTINGARCHIVEWITNESS';
  const archive = { source: 'Existing portable archive', importedAt: '2020-01-01T00:00:00.000Z', messages };
  await writeFile(f.pathname(f.agent.id), JSON.stringify(archive) + '\n');
  const original = await readFile(f.pathname(f.agent.id));
  const availability = f.store.getImportedHistoryAvailability(f.agent.id);
  assert.equal(availability.status, 'preparing');
  assert.throws(() => f.store.searchImportedHistory({ agentId: f.agent.id, archiveVersion: availability.archiveVersion, query: 'ABSENTWITNESS' }), /preparing/i);
  const unrelated = f.createAgent('Ordinary Agent remains usable');
  assert.equal(f.store.getAgent(unrelated.id).title, unrelated.title);
  await yieldToLoop();
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'preparing');
  const version = await ready(f.store, f.agent.id);
  const absent = search(f.store, f.agent.id, version, 'ABSENTWITNESS');
  assert.equal(absent.noMatch, true); assert.equal(absent.hits.length, 0);
  const found = search(f.store, f.agent.id, version, 'EXISTINGARCHIVEWITNESS');
  assert.equal(found.eligibleMessages, messages.length);
  assert.ok(found.hits.every(hit => hit.sourceLabel === 'Imported History' && !('createdAt' in hit)));
  const hit = found.hits.find(item => item.sequence === 0) ?? found.hits[0];
  f.store.rebuildProjections();
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'preparing');
  assert.equal(await ready(f.store, f.agent.id), version);
  reassemble(f.store, f.agent.id, version, hit, messages[hit.sequence].text);
  f.reopen();
  assert.equal(await ready(f.store, f.agent.id), version);
  const after = search(f.store, f.agent.id, version, 'EXISTINGARCHIVEWITNESS');
  assert.deepEqual(after.hits.map(item => item.reference), found.hits.map(item => item.reference));
  reassemble(f.store, f.agent.id, version, hit, messages[hit.sequence].text);
  assert.deepEqual(await readFile(f.pathname(f.agent.id)), original, 'Backfill must not rewrite canonical archive bytes');
}));

test('imported references and continuations reject foreign, forged, cross-message and replaced archives', { timeout: 20000 }, t => fixture(t, async f => {
  const messages = [{ role: 'assistant', text: 'PRIVATEOWNERWITNESS ' + '🌲'.repeat(10000) },
    { role: 'assistant', text: 'PRIVATEOTHERROWWITNESS ' + 'A'.repeat(20000) }];
  f.store.setImportedHistory(f.agent.id, 'Private archive', messages);
  const version = await ready(f.store, f.agent.id);
  const hit = search(f.store, f.agent.id, version, 'PRIVATEOWNERWITNESS').hits[0];
  const otherHit = search(f.store, f.agent.id, version, 'PRIVATEOTHERROWWITNESS').hits[0];
  const first = f.store.readImportedHistory({ agentId: f.agent.id, archiveVersion: version, reference: hit.reference }).response;
  const continuation = first.messages[first.requestedMessageIndex].continuation;
  assert.ok(continuation);
  const sibling = f.createAgent('Another private archive');
  f.store.setImportedHistory(sibling.id, 'Private archive', messages);
  const siblingVersion = await ready(f.store, sibling.id);
  assert.throws(() => f.store.readImportedHistory({ agentId: sibling.id, archiveVersion: siblingVersion, reference: hit.reference }), /reference/);
  for (const patch of [
    { reference: hit.reference.slice(0, -1) + (hit.reference.endsWith('0') ? '1' : '0') },
    { continuation: continuation.replace(/^ic1\.\d+\./, 'ic1.1.') },
    { reference: otherHit.reference, continuation },
    { continuation: 'x'.repeat(10000) },
  ]) assert.throws(() => f.store.readImportedHistory({ agentId: f.agent.id, archiveVersion: version, reference: hit.reference, ...patch }), /reference|continuation|range/);
  f.store.setImportedHistory(f.agent.id, 'Replacement archive', [{ role: 'user', text: 'REPLACEMENTWITNESS' }]);
  const replacementVersion = await ready(f.store, f.agent.id);
  assert.notEqual(replacementVersion, version);
  assert.throws(() => f.store.readImportedHistory({ agentId: f.agent.id, archiveVersion: version, reference: hit.reference, continuation }), /changed|unavailable/);
  assert.throws(() => f.store.readImportedHistory({ agentId: f.agent.id, archiveVersion: replacementVersion, reference: hit.reference, continuation }), /reference/);
  assert.equal(search(f.store, f.agent.id, replacementVersion, 'PRIVATEOWNERWITNESS').noMatch, true);
  assert.equal(search(f.store, f.agent.id, replacementVersion, 'REPLACEMENTWITNESS').hits.length, 1);
}));

test('close and deletion fence queued backfill without resurrecting private projections', { timeout: 20000 }, t => fixture(t, async f => {
  const messages = Array.from({ length: 64 }, (_, index) => ({ role: 'assistant', text: `QUEUEDARCHIVEWITNESS ${index}` }));
  const archive = JSON.stringify({ source: 'Queued archive', importedAt: '2020-01-01T00:00:00.000Z', messages }) + '\n';
  await writeFile(f.pathname(f.agent.id), archive);
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'preparing');
  const closed = f.store;
  f.reopen();
  await yieldToLoop();
  assert.equal(closed.getImportedHistoryAvailability(f.agent.id).status, 'unavailable');
  const version = await ready(f.store, f.agent.id);
  assert.equal(search(f.store, f.agent.id, version, 'QUEUEDARCHIVEWITNESS').eligibleMessages, messages.length);
  await writeFile(f.pathname(f.agent.id), archive);
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'preparing');
  const aborted = f.store;
  aborted.abortStartup();
  f.reopen();
  await yieldToLoop();
  assert.equal(aborted.getImportedHistoryAvailability(f.agent.id).status, 'unavailable');
  await ready(f.store, f.agent.id);
  const deleted = f.createAgent('Disposable queued owner');
  await writeFile(f.pathname(deleted.id), archive);
  assert.equal(f.store.getImportedHistoryAvailability(deleted.id).status, 'preparing');
  assert.equal(f.store.deleteAgent(deleted.id), true);
  await yieldToLoop(); await yieldToLoop();
  assert.equal(f.store.getImportedHistoryAvailability(deleted.id).status, 'unavailable');
  assert.equal(f.store.sqlite.prepare('SELECT count(*) AS n FROM imported_history_messages WHERE agent_id = ?').get(deleted.id).n, 0);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) AS n FROM imported_history_indexes WHERE agent_id = ?').get(deleted.id).n, 0);
  f.store.rebuildProjections();
  await ready(f.store, f.agent.id);
  assert.equal(f.store.getImportedHistoryAvailability(deleted.id).status, 'unavailable');
  assert.equal(f.store.sqlite.prepare('SELECT count(*) AS n FROM imported_history_messages WHERE agent_id = ?').get(deleted.id).n, 0);
}));

test('failed existing-archive indexing becomes unavailable and a restored version can prepare successfully', { timeout: 20000 }, t => fixture(t, async f => {
  const messages = [{ role: 'assistant', text: 'RESTOREDARCHIVEWITNESS' }];
  f.store.setImportedHistory(f.agent.id, 'Restorable archive', messages);
  const originalVersion = await ready(f.store, f.agent.id);
  const original = await readFile(f.pathname(f.agent.id));
  await writeFile(f.pathname(f.agent.id), '{"source":"Damaged existing archive","messages":[');
  const pending = f.store.getImportedHistoryAvailability(f.agent.id);
  assert.equal(pending.status, 'preparing');
  const deadline = Date.now() + 5000;
  while (f.store.getImportedHistoryAvailability(f.agent.id).status === 'preparing' && Date.now() < deadline) await yieldToLoop();
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'unavailable');
  assert.throws(() => f.store.searchImportedHistory({ agentId: f.agent.id, archiveVersion: pending.archiveVersion, query: 'RESTOREDARCHIVEWITNESS' }), /unavailable/i);
  await writeFile(f.pathname(f.agent.id), original);
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'preparing');
  const restoredVersion = await ready(f.store, f.agent.id);
  assert.notEqual(restoredVersion, originalVersion);
  const hit = search(f.store, f.agent.id, restoredVersion, 'RESTOREDARCHIVEWITNESS').hits[0];
  reassemble(f.store, f.agent.id, restoredVersion, hit, messages[0].text);
  assert.deepEqual(await readFile(f.pathname(f.agent.id)), original);
}));

for (const scope of ['Project', 'Chat']) test(`${scope} deletion erases private imported rows and cannot be undone by queued indexing`, { timeout: 20000 }, t => fixture(t, async f => {
  f.store.setImportedHistory(f.agent.id, 'Disposable private archive', [{ role: 'user', text: 'DELETIONARCHIVEWITNESS' }]);
  await ready(f.store, f.agent.id);
  const rowIds = f.store.sqlite.prepare('SELECT rowid FROM imported_history_messages WHERE agent_id=?').all(f.agent.id).map(row => row.rowid);
  f.store.rebuildProjections();
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'preparing');
  if (scope === 'Project') assert.equal(f.store.deleteProject(f.project.id), true);
  else {
    assert.equal(f.store.deleteAgent(f.agent.id), true);
    const receipt = f.store.commitConversationDeletion(f.chat.id);
    assert.equal(receipt.canonicalDeletionCompleted, true);
    f.store.finishConversationDeletionStorageCleanup(receipt);
  }
  await yieldToLoop(); await yieldToLoop();
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'unavailable');
  for (const table of ['imported_history_messages', 'imported_history_indexes']) {
    assert.equal(f.store.sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE agent_id=?`).get(f.agent.id).n, 0);
  }
  for (const id of rowIds) assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM imported_history_fts WHERE rowid=?').get(id).n, 0);
  f.reopen();
  assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status, 'unavailable');
}));

test('constructor failure fences index jobs queued by recovery before a later startup barrier fails', { timeout: 20000 }, t => fixture(t, async f => {
  const agents = [f.agent, f.createAgent('Earlier queued archive'), f.createAgent('Another queued archive')];
  for (const agent of agents) f.store.setImportedHistory(agent.id, 'Queued startup archive', [{ role: 'assistant', text: 'STARTUPARCHIVEWITNESS' }]);
  f.store.close();
  // An unfenced fire-and-forget worker becomes an unhandled rejection after
  // construction releases its SQLite lease. Inject a failure only after real
  // recovery queued its jobs; do not corrupt unrelated canonical authority.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { AgentStore } from './packages/agents/dist/index.js';
    import { setTimeout as delay } from 'node:timers/promises';
    const original = AgentStore.prototype.listProjects;
    let observedQueuedWork = false;
    AgentStore.prototype.listProjects = function (...args) {
      if (this.sqlite.prepare("SELECT count(*) AS n FROM imported_history_indexes WHERE status = 'preparing'").get().n) {
        observedQueuedWork = true;
        throw new Error('Controlled post-projection startup barrier');
      }
      return original.apply(this, args);
    };
    assert.throws(() => new AgentStore(process.argv[1]), /Controlled post-projection startup barrier/);
    AgentStore.prototype.listProjects = original;
    assert.equal(observedQueuedWork, true);
    await delay(30);
    console.log('Queued startup workers were fenced');
  `, f.dataDir], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /workers were fenced/);
  f.reopen();
  for (const agent of agents) await ready(f.store, agent.id);
}));


test('requested large neighbors cannot prevent exact forward progress through a long imported message', { timeout: 20000 }, t => fixture(t, async f => {
  const neighbor = label => ({ role: 'assistant', text: label + '🌲\r\n'.repeat(4000) });
  const retained = 'NEIGHBORPROGRESSWITNESS\n' + '雪🌲\r\n'.repeat(20000) + ' EXACT_TARGET_END';
  const messages = [neighbor('First before '), neighbor('Second before '), { role: 'user', text: retained }, neighbor('First after '), neighbor('Second after ')];
  assert.ok(retained.length > 100000);
  assert.ok(messages.filter(message => message.text !== retained).every(message => Buffer.byteLength(message.text) > 8000));
  f.store.setImportedHistory(f.agent.id, 'Neighbor budget pressure', messages);
  const version = await ready(f.store, f.agent.id);
  const hit = search(f.store, f.agent.id, version, 'NEIGHBORPROGRESSWITNESS', 1).hits[0];
  assert.equal(hit.sequence, 2);
  const initial = f.store.readImportedHistory({ agentId: f.agent.id, archiveVersion: version, reference: hit.reference, before: 2, after: 2 }).response;
  const target = initial.messages[initial.requestedMessageIndex];
  assert.equal(target.reference, hit.reference); assert.equal(target.complete, false); assert.ok(target.endCodePoint > target.startCodePoint); assert.ok(target.continuation);
  assert.ok(reassemble(f.store, f.agent.id, version, hit, retained, { before: 2, after: 2 }) > 1);
}));
