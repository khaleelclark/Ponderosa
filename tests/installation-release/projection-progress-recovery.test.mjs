import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AgentStore, CoordinationV3Store, WorkspaceStore } from '../../packages/agents/dist/index.js';
import { ContextCursorStore } from '../../apps/server/dist/context-cursors.js';
import { EngineAvailabilityStore } from '../../apps/server/dist/engine-availability-store.js';
import { createServer } from '../../apps/server/dist/app.js';

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
  assert.throws(() => f.store.appendEvent(f.agent.id, { type: 'text', delta: 'B after the rolled-back append' }),
    /restart|prefix/);
  assert.equal(f.store.readEventsSince(f.agent.id, 0).length, 0);
  const bytes = f.eventBytes();
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'recovery');
  assert.deepEqual(reopened.readEventsSince(f.agent.id, 0).map(row => [row.seq, row.event.delta]), [
    [1, 'A survived only in canonical JSONL'],
  ]);
  assert.deepEqual(f.eventBytes(), bytes);
  assert.equal(reopened.appendEvent(f.agent.id, { type: 'text', delta: 'B after recovery' }).seq, 2);
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


test('a post-event placement failure preserves primary history for bounded metadata recovery', t => {
  const f = fixture(t), event = { ...communication(f), intent: 'user_dm',
    audience: { kind: 'user_agent', userId: 'local', agentId: f.agent.id } };
  f.store.appendCommunicationEvent(event);
  f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_audit_search BEFORE INSERT ON main.chat_search_messages
    WHEN NEW.chat_kind='agent' BEGIN SELECT RAISE(ABORT, 'controlled placement failure'); END;`);
  assert.throws(() => f.store.appendEvent(f.agent.id, {
    type: 'user_message', text: event.text, communicationEventId: event.eventId,
  }), /controlled placement failure/);
  f.store.sqlite.exec('DROP TRIGGER fail_audit_search');
  assert.equal(f.store.readEventsSince(f.agent.id, 0).length, 1);
  f.store.ensureCommunicationProjectionLedger(f.project.id, { eventIds: new Set([event.eventId]), agentIds: new Set([f.agent.id]) });
  assert.equal(f.store.getMessages(f.agent.id).filter(row => row.communicationEventId === event.eventId).length, 1);
  const bytes = f.eventBytes(), reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'recovery', 'A metadata failure must not be certified by an unrelated successful owner');
  assert.equal(reopened.readEventsSince(f.agent.id, 0).length, 1);
  assert.equal(reopened.getMessages(f.agent.id).filter(row => row.communicationEventId === event.eventId).length, 1);
  assert.deepEqual(f.eventBytes(), bytes);
  assert.equal(reopened.appendEvent(f.agent.id, { type: 'text', delta: 'After recovery' }).seq, 2);
});

test('drafts, resource activity, saved decisions and accepted context use their own replay during a healthy restart', t => {
  const f = fixture(t), workspace = new WorkspaceStore(f.dataDir), cursors = new ContextCursorStore(f.dataDir);
  const draft = workspace.putDraft(f.project.lastConversationId, { text: 'Unsaved exact draft 😀', attachmentIds: [], expectedRevision: 0, clientId: 'restart-browser' });
  workspace.markResourceUsed('project', f.project.id);
  const decision = workspace.createDecision({ projectId: f.project.id, conversationId: f.project.lastConversationId,
    agentId: f.agent.id, runId: 'retained-question', mode: 'text', question: 'Keep this pending', options: [], allowOther: true, blocking: true, idempotencyKey: randomUUID() });
  const scope = { agentId: f.agent.id, engine: 'codex', model: 'qa', sessionId: 'qa-session', conversationId: f.project.lastConversationId, channel: 'main' };
  cursors.commit({ ...scope, lastMessageId: 'accepted-message', routingHash: 'accepted-route' });
  const cursor = cursors.get(scope);
  f.store.appendCommunicationEvent(communication(f));
  f.store.appendEvent(f.agent.id, { type: 'text', delta: 'Successful ordinary output' });
  workspace.close();
  const reopened = f.reopen();
  assert.equal(reopened.startupProfile().mode, 'clean');
  const nextWorkspace = new WorkspaceStore(f.dataDir);
  try {
    assert.deepEqual(nextWorkspace.getDraft(f.project.lastConversationId), draft);
    assert.deepEqual(nextWorkspace.getDecision(decision.id), decision);
    assert.deepEqual(new ContextCursorStore(f.dataDir).get(scope), cursor);
  } finally { nextWorkspace.close(); }
});


test('a real server lifetime preserves the host identity and independent journals while reusing healthy history', async t => {
  const f = fixture(t);
  let app = createServer({ dataDir: f.dataDir, store: f.store, engines: [], logger: false, allowedBrowseRoots: [f.root] });
  try {
    await app.ready();
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    const workspace = new WorkspaceStore(f.dataDir);
    try { workspace.putDraft(f.project.lastConversationId, { text: 'Saved through server lifetime', attachmentIds: [], expectedRevision: 0, clientId: 'server-restart' }); }
    finally { workspace.close(); }
    const evidence = new EngineAvailabilityStore(f.dataDir).record({ engineId: 'codex', available: true, source: 'operator_probe' });
    f.store.appendCommunicationEvent(communication(f));
    f.store.appendEvent(f.agent.id, { type: 'text', delta: 'Ordinary server output' });
    await app.close(); app = undefined;
    const vapid = readFileSync(path.join(f.dataDir, 'host-secrets', 'web-push-vapid.json'));
    const reopened = f.open();
    assert.equal(reopened.startupProfile().mode, 'clean');
    assert.deepEqual(new EngineAvailabilityStore(f.dataDir).get('codex'), evidence);
    app = createServer({ dataDir: f.dataDir, store: reopened, engines: [], logger: false, allowedBrowseRoots: [f.root] });
    await app.ready();
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.deepEqual(readFileSync(path.join(f.dataDir, 'host-secrets', 'web-push-vapid.json')), vapid);
    await app.close(); app = undefined;
    assert.equal(f.open().startupProfile().mode, 'clean');
  } finally { await app?.close(); }
});


test('a verified suffix cannot route foreign-owner records into another canonical journal', t => {
  const f = fixture(t);
  const other = f.store.createProject({ label: 'Other retained owner', hostPath: f.root, defaultEngine: 'codex' });
  f.store.close({ checkpointWrites: true }); f.open();
  f.store.appendCommunicationEvent(communication(f));
  const foreign = { ...communication(f), projectId: other.id, conversationId: other.lastConversationId,
    audience: { kind: 'organization', organizationId: other.id } };
  appendFileSync(path.join(f.dataDir, 'projects', f.project.id, 'communication-events.jsonl'), JSON.stringify(foreign) + '\n');
  f.close();
  const marker = JSON.parse(readFileSync(path.join(f.dataDir, '.projection-clean-shutdown.json'), 'utf8'));
  assert.equal(marker.tails.length, 1, 'Fault did not leave the intended verified source prefix');
  const append = AgentStore.prototype.appendCommunicationEvent;
  let routed = false;
  AgentStore.prototype.appendCommunicationEvent = function(record) {
    if (record.eventId === foreign.eventId) routed = true;
    return append.call(this, record);
  };
  // The original full recovery refuses this corrupt journal; incremental
  // repair must preserve that refusal instead of making a new foreign append.
  try { assert.throws(() => f.open(), /communication projection source event not found/); }
  finally { AgentStore.prototype.appendCommunicationEvent = append; }
  assert.equal(routed, false, 'Suffix replay followed embedded foreign routing instead of the journal owner');
  assert.equal(existsSync(path.join(f.dataDir, 'projects', other.id, 'communication-events.jsonl')), false);
});

import {renameSync} from 'node:fs';
for(const surviving of [false,true])test(`missing owner Chat is quarantined without rewriting retained private ownership; survivor=${surviving}`,t=>{
 const f=fixture(t),owner=f.store.getConversation(f.project.lastConversationId),a=f.agent;
 if(surviving)f.store.createConversation(f.project.id,{title:'Surviving unrelated Chat'});
 f.store.setImportedHistory(a.id,'Private historical source',[{role:'user',text:'Do not give this archive to another Chat'}]);
 const canonical=path.join(f.dataDir,'projects',f.project.id,'agents',a.id,'agent.json'),before=readFileSync(canonical);
 f.close();renameSync(path.join(f.dataDir,'projects',f.project.id,'conversations',owner.id),path.join(f.root,'retained-owner-for-repair'));
 const reopened=f.open();const after=reopened.getAgent(a.id);
 assert.ok(!after||after.conversationId===owner.id,'Recovery must never substitute a surviving Chat');
 assert.equal(readFileSync(canonical).equals(before),true,'Quarantine must not rewrite canonical ownership');
 assert.ok(reopened.startupProfile().recoveryIssues.some(issue=>issue.projectId===f.project.id&&issue.detail.includes(owner.id)));
});
