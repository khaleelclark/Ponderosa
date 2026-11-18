import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { EventLog } from '../../packages/agents/dist/eventlog.js';
import { projectionSourceFingerprint } from '../../packages/agents/dist/projection-checkpoint.js';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-projection-startup-'));
  let store;
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, open: () => store = new AgentStore(root), close: options => store.close(options) };
}

test('validated clean restart reuses communication and search projections; write-active restart repairs them', t => {
  const f = fixture(t), initial = f.open();
  const project = initial.createProject({ label: 'Retained project', hostPath: path.join(f.root, 'host'), defaultEngine: 'codex' });
  const event = { schemaVersion: 2, eventId: 'retained-message', projectId: project.id,
    conversationId: project.lastConversationId, sender: { kind: 'user', userId: 'local' },
    text: 'Retained searchable message', intent: 'broadcast', audience: { kind: 'organization', organizationId: project.id },
    createdAt: '2026-10-24T00:00:00.000Z' };
  initial.appendCommunicationEvent(event);
  f.close({ checkpointWrites: true });
  const clean = f.open();
  assert.equal(clean.startupProfile().mode, 'clean');
  assert.equal(clean.startupProfile().phasesMs.communicationLedger, undefined);
  assert.equal(clean.startupProfile().phasesMs.compactionHistory, undefined);
  assert.equal(clean.sqlite.prepare('SELECT text FROM compaction_history_messages WHERE communication_event_id=?').get(event.eventId).text, event.text);
  // A damaged projection during a write-active lifetime must never be certified
  // by the faster clean path, even though the canonical files are unchanged.
  clean.sqlite.prepare('DELETE FROM compaction_history_messages WHERE communication_event_id=?').run(event.eventId);
  f.close();
  const recovered = f.open();
  assert.equal(recovered.startupProfile().mode, 'recovery');
  assert.equal(typeof recovered.startupProfile().phasesMs.communicationLedger, 'number');
  assert.equal(typeof recovered.startupProfile().phasesMs.compactionHistory, 'number');
  assert.equal(recovered.sqlite.prepare('SELECT text FROM compaction_history_messages WHERE communication_event_id=?').get(event.eventId).text, event.text);
});

test('working files and artifact bytes do not invalidate projection sources; canonical metadata does', t => {
  const f = fixture(t), store = f.open();
  const project = store.createProject({ label: 'Fingerprint', hostPath: path.join(f.root, 'host'), defaultEngine: 'codex' });
  const before = projectionSourceFingerprint(f.root);
  for (const relative of ['workspaces/chat/node_modules/example/package.json', 'browser-profiles/profile/preferences.json',
    `projects/${project.id}/artifacts/content/user.json`, `projects/${project.id}/agents/test/artifacts/result.json`,
    `projects/${project.id}/agents/test/attachments/user.json`]) {
    const file = path.join(f.root, relative);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '{"user":"content"}\n');
  }
  assert.equal(projectionSourceFingerprint(f.root), before);
  store.updateProject(project.id, { label: 'Changed canonical label' });
  assert.notEqual(projectionSourceFingerprint(f.root), before);
});

test('changed canonical sources invalidate the clean marker and recover before serving', t => {
  const f = fixture(t), store = f.open();
  const project = store.createProject({ label: 'Before', hostPath: path.join(f.root, 'host'), defaultEngine: 'codex' });
  f.close({ checkpointWrites: true });
  const file = path.join(f.root, 'projects', project.id, 'project.json');
  const canonical = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...canonical, label: 'Canonical after offline change' }));
  const recovered = f.open();
  assert.equal(recovered.startupProfile().mode, 'recovery');
  assert.equal(recovered.getProject(project.id).label, 'Canonical after offline change');
});

test('unrecognized projection/schema certificates and interrupted lifetimes fall back to full recovery', t => {
  const f = fixture(t);
  f.open(); f.close();
  const marker = path.join(f.root, '.projection-clean-shutdown.json');
  for (const invalid of [{ projectionVersion: -1 }, { schemaFingerprint: 'unrecognized schema' }, { schemaVersion: -1 }]) {
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, 'utf8')), ...invalid }));
    const recovered = f.open();
    assert.equal(recovered.startupProfile().mode, 'recovery');
    f.close();
  }
  const interrupted = f.open();
  assert.equal(interrupted.startupProfile().mode, 'clean');
  interrupted.abortStartup();
  assert.equal(f.open().startupProfile().mode, 'recovery', 'Consumed certificates cannot survive an unclean lifetime');
});

test('one history read seeds the next append; torn tails repair and earlier corruption still refuses writes', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-eventlog-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const first = new EventLog(file);
  const event = { type: 'text', delta: 'Exact authored text' };
  assert.equal(first.append(event).seq, 1);
  const bytes = readFileSync(file, 'utf8');
  writeFileSync(file, bytes + '{"seq":2');
  const reopened = new EventLog(file);
  assert.equal(reopened.readAll().length, 1);
  assert.equal(reopened.append(event).seq, 2);
  assert.deepEqual(new EventLog(file).readAll().map(row => row.seq), [1, 2]);
  writeFileSync(file, 'not JSON\n' + bytes);
  assert.throws(() => new EventLog(file).append(event));
  assert.equal(readFileSync(file, 'utf8'), 'not JSON\n' + bytes);
});

test('event projection statements stay bounded across agents and replay preserves exact output/activity rows', t => {
  const f = fixture(t), store = f.open();
  const project = store.createProject({ label: 'Statement reuse', hostPath: f.root, defaultEngine: 'codex' });
  const agents = ['First', 'Second'].map(title => store.createAgent(project.id,
    { title, engine: 'codex', conversationId: project.lastConversationId }));
  const original = Database.prototype.prepare;
  let headPrepares = 0;
  Database.prototype.prepare = function (sql, ...args) {
    if (this === store.sqlite && sql.includes('INSERT INTO agent_event_head_projection')) headPrepares++;
    return original.call(this, sql, ...args);
  };
  const snapshot = () => Object.fromEntries(['events', 'messages', 'runs', 'artifacts', 'agent_event_head_projection',
    'agent_health_projection', 'run_output_heads', 'run_output_segments', 'activity_projection', 'tool_output_projection',
    'changed_file_projection', 'changed_file_execution_projection'].map(table => [table,
      store.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()]));
  try {
    for (const agent of agents) {
      const executionId = `execution-${agent.id}`;
      const events = [{ type: 'agent_lifecycle', status: 'running', reason: 'active_run', executionId, engine: 'codex' },
        { type: 'text', delta: 'Exact 😀 ', executionId }, { type: 'text', delta: 'joined output', executionId },
        { type: 'reasoning', delta: 'Private reasoning', executionId },
        { type: 'tool_result', id: 'result', output: 'large 😀 output '.repeat(400), executionId },
        { type: 'file_change', path: 'same-path.ts', kind: 'modified', diff: 'diff content', executionId },
        { type: 'agent_lifecycle', status: 'completed', reason: 'turn_completed', executionId }];
      events.forEach((event, index) => store.appendEvent(agent.id, event, new Date(Date.UTC(2026, 9, 24, 0, 0, index)).toISOString()));
      assert.equal(store.lastSeqOf(agent.id), events.length);
      assert.equal(store.readEventsSince(agent.id, 0, 2).length, 2);
      assert.equal(store.readEventsSince(agent.id, 2).length, events.length - 2);
      assert.equal(store.latestHealthObservation(agent.id).status, 'idle');
    }
    assert.equal(headPrepares, 1, 'Preparing the same event-head SQL must not grow with events or agents');
    const incremental = snapshot();
    store.rebuildProjections();
    assert.equal(headPrepares, 2, 'A cleared owner prepares its fixed SQL once for the entire rebuild');
    assert.deepEqual(snapshot(), incremental);
    store.appendEvent(agents[0].id, { type: 'text', delta: 'After replay', executionId: 'later-run' }, '2026-10-24T01:00:00.000Z');
    assert.equal(store.lastSeqOf(agents[0].id), 8);
    assert.equal(store.lastSeqOf(agents[1].id), 7);
  } finally { Database.prototype.prepare = original; }
});


test('normal write-active restart reuses verified history and preserves new messages, output and metadata', t => {
  const f = fixture(t), initial = f.open();
  const project = initial.createProject({ label: 'Healthy lifetime', hostPath: path.join(f.root, 'host'), defaultEngine: 'codex' });
  const agent = initial.createAgent(project.id, { title: 'Working agent', engine: 'codex', conversationId: project.lastConversationId });
  f.close({ checkpointWrites: true });
  const active = f.open();
  const message = { schemaVersion: 2, eventId: 'healthy-message', projectId: project.id,
    conversationId: project.lastConversationId, sender: { kind: 'user', userId: 'local' }, text: 'New exact searchable message 😀',
    intent: 'broadcast', audience: { kind: 'organization', organizationId: project.id }, createdAt: '2026-10-24T12:00:00.000Z' };
  active.appendCommunicationEvent(message);
  active.appendConversationMessage(project.lastConversationId, { text: message.text }, undefined, 'main', undefined, undefined, message.eventId);
  active.appendEvent(agent.id, { type: 'agent_lifecycle', status: 'running', reason: 'active_run', executionId: 'healthy-run', engine: 'codex' });
  active.appendEvent(agent.id, { type: 'text', delta: 'New exact output 😀', executionId: 'healthy-run' });
  active.appendEvent(agent.id, { type: 'agent_lifecycle', status: 'completed', reason: 'turn_completed', executionId: 'healthy-run' });
  active.markProjectUsed(project.id, project.lastConversationId);
  active.updateAgent(agent.id, { effort: 'high' });
  const expectedEvents = active.readEventsSince(agent.id, 0);
  f.close();
  const restarted = f.open();
  assert.equal(restarted.startupProfile().mode, 'clean', 'Healthy write activity must reuse committed history without rebuilding it');
  assert.equal(restarted.startupProfile().phasesMs.projectionReplay, undefined);
  assert.deepEqual(restarted.readEventsSince(agent.id, 0), expectedEvents);
  assert.equal(restarted.getAgent(agent.id).effort, 'high');
  assert.equal(restarted.getConversationMessages(project.lastConversationId)[0].text, message.text);
  assert.equal(restarted.sqlite.prepare('SELECT text FROM compaction_history_messages WHERE communication_event_id=?').get(message.eventId).text, message.text);
});
