import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AgentStore, CoordinationV3Store, WorkspaceStore } from '../../packages/agents/dist/index.js';

// Every database and canonical file in these checks belongs to a temporary
// native fixture. Faults hit the real projection transaction, never a provider.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-projection-progress-'));
  const dataDir = path.join(root, 'data'), hostPath = path.join(root, 'work');
  mkdirSync(hostPath);
  let store;
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  const open = () => store = new AgentStore(dataDir);
  const initial = open();
  const project = initial.createProject({ label: 'Projection progress', hostPath, defaultEngine: 'codex' });
  const agent = initial.createAgent(project.id, {
    title: 'Progress owner', engine: 'codex', conversationId: project.lastConversationId,
  });
  // Establish one fully reconciled starting point. The assertions below test
  // ordinary write-active close, without replaying at shutdown to hide faults.
  initial.close({ checkpointWrites: true });
  open();
  return {
    root, dataDir, project, agent,
    get store() { return store; },
    close: () => store.close(),
    reopen: () => { store.close(); return open(); },
    open,
    eventBytes: () => readFileSync(path.join(dataDir, 'projects', project.id, 'agents', agent.id, 'events.jsonl')),
  };
}

function communication(f, text = 'Original searchable cedar') {
  return { schemaVersion: 2, eventId: randomUUID(), projectId: f.project.id,
    conversationId: f.project.lastConversationId, sender: { kind: 'user', userId: 'local' },
    intent: 'broadcast', audience: { kind: 'organization', organizationId: f.project.id },
    text, createdAt: '2026-10-24T00:00:00.000Z' };
}

function historyRow(store, eventId) {
  return store.sqlite.prepare('SELECT * FROM compaction_history_messages WHERE communication_event_id=?').get(eventId);
}

function searchable(store, word) {
  return store.sqlite.prepare('SELECT communication_event_id FROM compaction_history_fts WHERE compaction_history_fts MATCH ?')
    .all(word).map(row => row.communication_event_id).sort();
}

test('healthy write-active shutdown reuses exact authored and indexed projections', t => {
  const f = fixture(t);
  const event = communication(f);
  f.store.appendCommunicationEvent(event);
  f.store.appendEvent(f.agent.id, { type: 'text', delta: 'Exact output 😀' });
  f.store.updateAgent(f.agent.id, { title: 'Updated progress owner' });
  const bytes = f.eventBytes(), indexed = historyRow(f.store, event.eventId);
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'clean');
  assert.equal(reopened.getAgent(f.agent.id).title, 'Updated progress owner');
  assert.deepEqual(historyRow(reopened, event.eventId), indexed);
  assert.deepEqual(searchable(reopened, 'cedar'), [event.eventId]);
  assert.deepEqual(f.eventBytes(), bytes, 'Clean restart changed canonical Agent bytes');
  assert.equal(reopened.readEventsSince(f.agent.id, 0).at(-1).event.delta, 'Exact output 😀');
});

test('a canonical event whose actual projection aborts repairs its verified suffix before serving', t => {
  const f = fixture(t);
  f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_event_projection BEFORE INSERT ON main.events
    BEGIN SELECT RAISE(ABORT, 'controlled event projection failure'); END;`);
  assert.throws(() => f.store.appendEvent(f.agent.id, { type: 'text', delta: 'Durable unprojected suffix 😀' }),
    /controlled event projection failure/);
  const bytes = f.eventBytes();
  assert.equal(f.store.readEventsSince(f.agent.id, 0).length, 0, 'Fault did not abort the real projection');
  f.store.sqlite.exec('DROP TRIGGER fail_event_projection');
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'incremental');
  assert.deepEqual(reopened.readEventsSince(f.agent.id, 0).map(row => row.event.delta), ['Durable unprojected suffix 😀']);
  assert.deepEqual(f.eventBytes(), bytes, 'Suffix recovery appended or rewrote authored history');
});

test('an outer rollback followed by another append cannot certify an earlier canonical gap', t => {
  const f = fixture(t);
  assert.throws(f.store.sqlite.transaction(() => {
    f.store.appendEvent(f.agent.id, { type: 'text', delta: 'A survived only in canonical JSONL' });
    throw Error('controlled outer rollback');
  }), /controlled outer rollback/);
  assert.equal(f.store.readEventsSince(f.agent.id, 0).length, 0);
  f.store.appendEvent(f.agent.id, { type: 'text', delta: 'B after the rolled-back append' });
  assert.deepEqual(f.store.readEventsSince(f.agent.id, 0).map(row => row.seq), [2]);
  const bytes = f.eventBytes();
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'recovery');
  assert.deepEqual(reopened.readEventsSince(f.agent.id, 0).map(row => [row.seq, row.event.delta]), [
    [1, 'A survived only in canonical JSONL'], [2, 'B after the rolled-back append'],
  ]);
  assert.deepEqual(f.eventBytes(), bytes);
});

test('a failed revision index transaction and exact retry retain the latest edit and FTS result', t => {
  const f = fixture(t), event = communication(f);
  f.store.appendCommunicationEvent(event);
  const revision = { schemaVersion: 1, kind: 'edit', eventId: randomUUID(), idempotencyKey: randomUUID(),
    projectId: f.project.id, conversationId: f.project.lastConversationId, targetEventId: event.eventId,
    sender: event.sender, text: 'Latest searchable sequoia 😀', createdAt: '2026-10-24T00:00:01.000Z' };
  // The messages, FTS and participant replacements share this transaction.
  f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_revision_index BEFORE UPDATE ON main.compaction_history_messages
    BEGIN SELECT RAISE(ABORT, 'controlled revision index failure'); END;`);
  assert.throws(() => f.store.appendCommunicationRevision(revision), /controlled revision index failure/);
  assert.equal(historyRow(f.store, event.eventId).text, event.text);
  f.store.sqlite.exec('DROP TRIGGER fail_revision_index');
  assert.equal(f.store.appendCommunicationRevision(revision).replayed, true);
  assert.equal(historyRow(f.store, event.eventId).text, revision.text, 'Exact revision retry left its old search text');
  assert.deepEqual(searchable(f.store, 'sequoia'), [event.eventId]);
  assert.deepEqual(searchable(f.store, 'cedar'), []);
  const revisionPath = path.join(f.dataDir, 'projects', f.project.id, 'communication-revisions.jsonl');
  const bytes = readFileSync(revisionPath);
  const reopened = f.reopen();
  assert.equal(historyRow(reopened, event.eventId).text, revision.text);
  assert.deepEqual(searchable(reopened, 'sequoia'), [event.eventId]);
  assert.deepEqual(readFileSync(revisionPath), bytes, 'Idempotent revision repair duplicated canonical history');
});

test('a failed unsupported metadata projection cannot be laundered by a later hot Agent update', t => {
  const f = fixture(t);
  const workingCopy = { id: `copy:${randomUUID()}`, mode: 'separate_git', state: 'unavailable',
    rootPath: path.join(f.root, 'retained-copy'), branch: 'codex/retained-fixture',
    failure: 'Retained copy needs operator inspection', updatedAt: '2026-10-24T00:00:02.000Z' };
  f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_working_copy BEFORE UPDATE OF working_copy_json ON main.agents
    BEGIN SELECT RAISE(ABORT, 'controlled working-copy projection failure'); END;`);
  assert.throws(() => f.store.updateAgentWorkingCopy(f.agent.id, workingCopy), /controlled working-copy projection failure/);
  f.store.sqlite.exec('DROP TRIGGER fail_working_copy');
  f.store.updateAgent(f.agent.id, { title: 'Later harmless rename' });
  assert.notDeepEqual(f.store.getAgent(f.agent.id).workingCopy, workingCopy, 'Fault did not leave the intended stale projection');
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'recovery');
  assert.equal(reopened.getAgent(f.agent.id).title, 'Later harmless rename');
  assert.deepEqual(reopened.getAgent(f.agent.id).workingCopy, workingCopy);
});

test('coherent raw FTS damage followed by a healthy hot write still requires full repair', t => {
  const f = fixture(t), event = communication(f);
  f.store.appendCommunicationEvent(event);
  const row = f.store.sqlite.prepare('SELECT rowid FROM compaction_history_messages WHERE communication_event_id=?').get(event.eventId);
  f.store.sqlite.prepare('DELETE FROM compaction_history_fts WHERE rowid=?').run(row.rowid);
  f.store.sqlite.prepare('INSERT INTO compaction_history_fts(rowid,project_id,communication_event_id,text) VALUES (?,?,?,?)')
    .run(row.rowid, f.project.id, event.eventId, 'Incorrect redwood');
  assert.deepEqual(searchable(f.store, 'redwood'), [event.eventId]);
  assert.deepEqual(searchable(f.store, 'cedar'), []);
  f.store.appendEvent(f.agent.id, { type: 'text', delta: 'Healthy later output' });
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'recovery');
  assert.deepEqual(searchable(reopened, 'cedar'), [event.eventId]);
  assert.deepEqual(searchable(reopened, 'redwood'), []);
});

for (const timing of ['during the admitted lifetime', 'after its proof was written']) {
  test(`an external SQLite mutation ${timing} invalidates projection reuse`, t => {
    const f = fixture(t), event = communication(f);
    f.store.appendCommunicationEvent(event);
    if (timing === 'after its proof was written') f.close();
    const external = new Database(path.join(f.dataDir, 'ponderosa.db'));
    try {
      external.prepare('UPDATE compaction_history_messages SET text=? WHERE communication_event_id=?')
        .run('External unprojected corruption', event.eventId);
    } finally { external.close(); }
    if (timing === 'during the admitted lifetime') {
      f.store.appendEvent(f.agent.id, { type: 'text', delta: 'A benign write after external mutation' });
      f.close();
    }
    const reopened = f.open();
    assert.equal(reopened.startupProfile().mode, 'recovery');
    assert.equal(historyRow(reopened, event.eventId).text, event.text);
  });
}

for (const loss of ['missing proof', 'unclean lifetime']) {
  test(`${loss} preserves the conservative recovery fallback`, t => {
    const f = fixture(t);
    f.store.appendEvent(f.agent.id, { type: 'text', delta: 'Retained canonical output' });
    const bytes = f.eventBytes();
    if (loss === 'missing proof') {
      f.close();
      rmSync(path.join(f.dataDir, '.projection-clean-shutdown.json'), { force: true });
    } else f.store.abortStartup();
    const reopened = f.open();
    assert.equal(reopened.startupProfile().mode, 'recovery');
    assert.equal(reopened.readEventsSince(f.agent.id, 0).at(-1).event.delta, 'Retained canonical output');
    assert.deepEqual(f.eventBytes(), bytes);
  });
}

function authorityRows(store) {
  const tables = store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(row => row.name).filter(name => /^(coordination_|scheduler_|runtime_|provider_|activation_|required_reply_|context_rollover)/u.test(name)
      || name === 'agent_activations');
  return Object.fromEntries(tables.map(table => [table,
    store.sqlite.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row)).sort()]));
}

test('projection recovery preserves full V3 authority rows and an unanswered saved decision', t => {
  const f = fixture(t), v3 = new CoordinationV3Store(f.store.sqlite);
  const requester = f.store.createAgent(f.project.id, {
    title: 'Retained requester', engine: 'codex', conversationId: f.project.lastConversationId,
  });
  const coordinated = v3.coordinate({ projectId: f.project.id, conversationId: f.project.lastConversationId,
    requesterAgentId: requester.id, actorScope: 'user:local-operator', idempotencyKey: randomUUID(),
    requests: [{ recipientAgentId: f.agent.id, lifetime: { kind: 'indefinite' }, payload: { text: 'Preserve uncertain outcome' } }],
    join: { mode: 'all', wakePolicy: 'final_only' } });
  v3.updateRequest({ requestId: coordinated.requestIds[0], updateId: randomUUID(), kind: 'outcome_unknown',
    actor: { kind: 'supervisor' }, payload: { text: 'No automatic retry was authorized' } });
  let workspace = new WorkspaceStore(f.dataDir);
  const decision = workspace.createDecision({ projectId: f.project.id, conversationId: f.project.lastConversationId,
    agentId: f.agent.id, runId: 'retained-question', mode: 'text', question: 'Choose the safe next action',
    options: [], allowOther: true, blocking: true, idempotencyKey: randomUUID() });
  workspace.close();
  const workspaceBytes = readFileSync(path.join(f.dataDir, 'workspace-events.jsonl'));
  const before = authorityRows(f.store);
  f.store.appendEvent(f.agent.id, { type: 'text', delta: 'Authored telemetry to recover' });
  f.store.sqlite.prepare('DELETE FROM events WHERE agent_id=?').run(f.agent.id);
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'recovery');
  assert.deepEqual(authorityRows(reopened), before, 'Projection recovery changed V3 authority, fences, outcomes or outbox');
  workspace = new WorkspaceStore(f.dataDir);
  try { assert.deepEqual(workspace.getDecision(decision.id), decision); }
  finally { workspace.close(); }
  assert.deepEqual(readFileSync(path.join(f.dataDir, 'workspace-events.jsonl')), workspaceBytes);
  assert.equal(reopened.readEventsSince(f.agent.id, 0).at(-1).event.delta, 'Authored telemetry to recover');
});
