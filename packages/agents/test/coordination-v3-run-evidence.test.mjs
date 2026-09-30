import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore, CoordinationV3Store } from '../dist/index.js';

test('Run evidence distinguishes published replies, provider progress, heartbeats and completion without exposing output', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-evidence-'));
  const store = new AgentStore(root), coordination = new CoordinationV3Store(store.sqlite);
  try {
    const project = store.createProject({ label: 'Fixture', hostPath: root, defaultEngine: 'codex' });
    const chat = store.createConversation(project.id, { title: 'Chat' });
    const agent = store.createAgent(project.id, { title: 'Agent', engine: 'codex', conversationId: chat.id });
    const start = Date.now() - 10_000;
    const at = milliseconds => new Date(start + milliseconds).toISOString();
    const now = at(0);
    coordination.coordinate({ projectId: project.id, conversationId: chat.id, actorScope: 'user:operator',
      idempotencyKey: 'work', requests: [{ requestId: 'request', recipientAgentId: agent.id, lifetime: { kind: 'indefinite' }, payload: { text: 'Work' } }] });
    const lease = coordination.leaseNextRun({ workerId: 'fixture' });
    assert.ok(lease);
    coordination.markRunStarted(lease.runId, lease.fencingToken, now);
    coordination.recordProviderInput({ executionId: 'execution', schedulerRunId: lease.runId, fencingToken: lease.fencingToken,
      agentId: agent.id, projectId: project.id, prompt: 'work', sourceManifest: { schemaVersion: 1, historyMessageCount: 0,
        activationIds: lease.activationIds, communicationEventIds: [], artifactIds: [], conversationId: chat.id,
        providerSessionDisposition: 'fresh_task', sources: [] }, now });
    // Disposable projected evidence: no provider activity or publication is
    // inferred from a scheduler heartbeat or from reply text.
    const insertEvent = (seq, payload, time) => store.sqlite.prepare('INSERT INTO events(id,agent_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(`event-${seq}`, agent.id, seq, payload.type, JSON.stringify(payload), time);
    store.appendEvent(agent.id, { type: 'agent_lifecycle', executionId: 'execution', status: 'running', reason: 'active_run' }, now);
    const tool = store.appendEvent(agent.id, { type: 'tool_result', id: 'tool', output: 'SECRET TOOL OUTPUT' }, at(1000));
    assert.equal(JSON.parse(store.sqlite.prepare('SELECT payload_json FROM events WHERE agent_id=? AND seq=?').get(agent.id, tool.seq).payload_json).executionId, undefined);
    assert.equal(store.sqlite.prepare('SELECT execution_id FROM activity_projection WHERE agent_id=? AND seq=?').get(agent.id, tool.seq).execution_id, 'execution');
    insertEvent(3, { type: 'tool_result', executionId: 'other-run', output: 'OTHER RUN' }, at(2000));
    const details = () => new Map(coordination.agentWorkItemDetails({ projectId: project.id, conversationId: chat.id, kind: 'run', recordId: lease.runId }).map(item => [item.label, item.value]));
    assert.equal(details().get('Last recorded provider progress'), `${at(1000)} (tool_result)`);
    assert.match(details().get('Recorded terminal event'), /No terminal event/);
    assert.match(details().get('Reply publication'), /Not found/);
    const publicationTime = at(3000);
    store.sqlite.prepare('INSERT INTO runtime_communications(id,project_id,sender_json,intent,audience_json,payload_json,payload_hash,actionable,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('reply', project.id, JSON.stringify({ kind: 'agent', agentId: agent.id, executionId: 'execution' }), 'user_dm', '{}', '{}', 'fixture', 0, publicationTime);
    store.sqlite.prepare('INSERT INTO messages(id,communication_event_id,agent_id,seq,role,text,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('reply-message', 'reply', agent.id, 3, 'assistant', 'SECRET REPLY CONTENT', publicationTime);
    assert.equal(details().get('Reply publication'), publicationTime);
    assert.match(details().get('Reply and Run state'), /reply was sent.*Run is still active/);
    assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(lease.runId).status, 'running');
    assert.doesNotMatch(JSON.stringify([...details()]), /SECRET|OTHER RUN/);
    assert.equal(coordination.agentWorkItemDetails({ projectId: 'foreign', kind: 'run', recordId: lease.runId }), undefined);
    assert.equal(coordination.agentWorkItemDetails({ projectId: project.id, conversationId: 'foreign', kind: 'run', recordId: lease.runId }), undefined);
    insertEvent(4, { type: 'agent_lifecycle', executionId: 'execution', status: 'waiting', reason: 'work_item_waiting_approval' }, at(3500));
    assert.match(details().get('Recorded terminal event'), /No terminal event/);
    insertEvent(5, { type: 'agent_lifecycle', executionId: 'execution', status: 'completed', reason: 'turn_completed' }, at(4000));
    assert.equal(details().get('Recorded terminal event'), `${at(4000)}: completed (turn_completed)`);
    for (let i = 6; i < 150; i++) insertEvent(i, { type: 'tool_result', executionId: 'execution', output: 'SECRET' }, now);
    assert.match(details().get('Recorded terminal event'), /bounded evidence window/);
    assert.match(details().get('Evidence window'), /Older evidence may be omitted/);
    assert.equal(JSON.parse(details().get('Recent Run event metadata')).length, 16);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
