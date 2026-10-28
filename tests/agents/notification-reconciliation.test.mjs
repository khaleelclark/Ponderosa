import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { AgentStore, WorkspaceStore } from '@ponderosa/agents';
import { createOperationalNotifications } from '../../apps/server/dist/operational-notifications.js';
import { createServerReadModels } from '../../apps/server/dist/server-read-models.js';
import { AgentWorkProjection } from '../../apps/server/dist/routes/agent-work.js';
import { withFixture, until, fixtureTestOptions } from '../shared/fixture.mjs';

const at = '2026-10-22T00:00:00.000Z';
function notifications(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-notification-work-'));
  const workspace = new WorkspaceStore(root), requests = new Map(), inspected = [], errors = [];
  const f = { workspace, requests, inspected, errors, onInspect() {}, onResolve() {} };
  const store = {
    getProject: id => ['p', 'q'].includes(id) ? { id } : undefined,
    getAgent: id => ({ id, title: id, conversationId: `${id[0]}-chat` }),
  };
  const coordinationV3 = {
    coordinationAttentionCandidates: (limit, cursor) => [...requests.values()]
      .filter(r => ['failed', 'outcome_unknown', 'blocked'].includes(r.state))
      .filter(r => !cursor || r.id < cursor.recordId)
      .sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit)
      .map(r => ({ kind: 'request', recordId: r.id, projectId: r.projectId, agentId: r.recipientAgentId, updatedAt: at })),
    getRequest: id => requests.get(id),
    requestRetryStatus: id => ({ successorState: requests.get(id)?.recovered ? 'completed' : undefined }),
    requestLifecycleDetails: () => ({ updates: [] }),
  };
  const ops = createOperationalNotifications({ store, coordinationV3, workspace,
    publishWorkspaceSince() {}, logError: meta => errors.push(meta) });
  ops.agentWorkProjection.inspect = input => {
    const id = input.focusId.slice('request:'.length), r = requests.get(id);
    inspected.push(id); f.onInspect(id);
    const item = { id: input.focusId, recordId: id, kind: 'request', state: r.state,
      agentIds: [r.recipientAgentId], recipientAgentId: r.recipientAgentId, updatedAt: at };
    const items = [item, ...(r.pendingDecision ? [{ id: 'decision', kind: 'decision', state: 'pending' }] : [])];
    return { items, traces: [{ id: `trace:${id}`, itemIds: items.map(x => x.id), agentIds: item.agentIds,
      state: r.recovered ? 'finished' : 'attention' }] };
  };
  const setStatus = workspace.setNotificationStatus.bind(workspace);
  workspace.setNotificationStatus = (id, status) => { f.onResolve(workspace.getNotification(id)); return setStatus(id, status); };
  t.after(async () => { await ops.stopCoordinationAttentionNotifications(); workspace.close(); rmSync(root, { recursive: true, force: true }); });
  return Object.assign(f, { ops, store,
    add(projectId, id) {
      const r = { id, projectId, recipientAgentId: `${projectId}-worker`, requesterAgentId: `${projectId}-sender`,
        conversationId: `${projectId}-chat`, payload: { text: `Assignment ${id}` }, state: 'failed', updatedAt: at };
      requests.set(id, r); return r;
    },
    notice: id => workspace.findNotification(n => n.resolution?.requestId === id),
    stale(projectId, id = 'stale') {
      return workspace.createNotification({ projectId, kind: 'operational', status: 'open',
        dedupeKey: `coordination-attention:${id}:trace`, title: 'Old notice', body: 'Old failure' });
    },
  });
}

test('participant publications coalesce, preserve every event and yield between inspections', async t => {
  const f = notifications(t), canonical = [], published = [];
  for (let i = 0; i < 25; i++) f.add('p', `p-${i.toString().padStart(3, '0')}`);
  f.add('q', 'q-untouched');
  let sentinel;
  f.onInspect = () => { if (f.inspected.length === 1) setImmediate(() => { sentinel = f.inspected.length; }); };
  const models = createServerReadModels({ store: { getAgent: () => ({ id: 'p-worker', projectId: 'p' }),
    appendEvent: (id, event) => { canonical.push({ id, event }); return event; } },
    coordinationV3: { agentSnapshot: () => ({}) }, publish() {}, appendWorkspace: event => published.push(event),
    scheduleCoordinationAttentionNotifications: f.ops.scheduleCoordinationAttentionNotifications,
    reconcileCommunicationNotifications() {}, isClosed: () => false });
  for (let i = 0; i < 100; i++) models.publishCoordinationV3Changed('p-worker');
  models.publishMessageDeliveryChanged('p-worker');
  assert.equal(canonical.length, 101); assert.equal(published.length, 101);
  assert.equal(f.inspected.length, 0, 'request publication does not perform historical inspection');
  await f.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(f.inspected.length, 25); assert.equal(sentinel, 1, 'another I/O turn runs before the next inspection');
  assert.equal(f.notice('q-untouched'), undefined);
  await f.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(f.inspected.length, 50, 'a later burst gets a fresh pass');
  assert.deepEqual(f.errors, []);
});

test('a mutation after a page was read gets a follow-up and cannot resolve from a stale retained set', async t => {
  const f = notifications(t), old = f.stale('p');
  f.add('p', 'a'); f.add('p', 'b'); f.add('q', 'q');
  let changed = false;
  f.onInspect = () => {
    if (changed) return;
    changed = true;
    setImmediate(() => {
      f.add('p', 'z-new-before-cursor');
      f.requests.get('a').pendingDecision = true;
      void f.ops.scheduleCoordinationAttentionNotifications('p');
    });
  };
  f.onResolve = n => { if (n.id === old.id) assert.ok(f.inspected.includes('z-new-before-cursor'), 'follow-up completed before resolution'); };
  await Promise.all(['p', 'q'].map(f.ops.scheduleCoordinationAttentionNotifications));
  assert.ok(f.inspected.filter(id => id === 'b').length >= 2);
  assert.ok(f.inspected.indexOf('q') < f.inspected.indexOf('z-new-before-cursor'), 'other projects are not starved by a dirty follow-up');
  assert.equal(f.workspace.getNotification(old.id).status, 'resolved');
  assert.equal(f.notice('a')?.status ?? 'resolved', 'resolved', 'pending Decision suppresses the generic failure');
  assert.equal(f.notice('z-new-before-cursor').status, 'open');
});

test('delivery-only publications invalidate an in-flight attention pass', async t => {
  const f = notifications(t), old = f.stale('p'); f.add('p', 'b'); f.add('p', 'a');
  const models = createServerReadModels({ store: { getAgent: () => ({ id: 'p-worker', projectId: 'p' }), appendEvent: () => ({}) },
    coordinationV3: { agentSnapshot: () => ({}) }, publish() {}, appendWorkspace() {},
    scheduleCoordinationAttentionNotifications: f.ops.scheduleCoordinationAttentionNotifications,
    reconcileCommunicationNotifications() {}, isClosed: () => false });
  let changed = false;
  f.onInspect = () => {
    if (!changed) { changed = true; setImmediate(() => { f.add('p', 'z'); models.publishMessageDeliveryChanged('p-worker'); }); }
  };
  f.onResolve = n => { if (n.id === old.id) assert.ok(f.inspected.includes('z')); };
  await f.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(f.notice('z').status, 'open'); assert.equal(f.workspace.getNotification(old.id).status, 'resolved');
});

test('project-scoped repair preserves other projects, dismissals, retries and all candidate pages', async t => {
  const f = notifications(t);
  for (let i = 0; i < 205; i++) f.add('p', `p-${i.toString().padStart(3, '0')}`);
  f.add('q', 'q');
  const unrelated = f.stale('q');
  await f.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(f.inspected.length, 205); assert.equal(f.notice('q'), undefined);
  assert.equal(f.workspace.getNotification(unrelated.id).status, 'open');
  const dismissed = f.notice('p-000'); f.workspace.setNotificationStatus(dismissed.id, 'dismissed');
  f.requests.get('p-001').recovered = true;
  await f.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(f.workspace.getNotification(dismissed.id).status, 'dismissed');
  assert.equal(f.notice('p-001').status, 'resolved', 'completed recovery removes the obsolete failure');
  assert.equal(f.workspace.getNotification(unrelated.id).status, 'open');
});

test('failed scans do not resolve old notices or block another project, and can retry on the next update', async t => {
  const f = notifications(t), old = f.stale('p'); f.add('p', 'p'); f.add('q', 'q');
  f.onInspect = id => { if (id === 'p') throw Error('Synthetic inspector failure'); };
  await Promise.all(['p', 'q'].map(f.ops.scheduleCoordinationAttentionNotifications));
  assert.equal(f.errors.length, 1); assert.equal(f.notice('q').status, 'open');
  assert.equal(f.workspace.getNotification(old.id).status, 'open');
  f.onInspect = () => {};
  await f.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(f.notice('p').status, 'open'); assert.equal(f.workspace.getNotification(old.id).status, 'resolved');
});

test('stale-notice cleanup yields and stops resolving when the project changes', async t => {
  const f = notifications(t), first = f.stale('p', 'first'), second = f.stale('p', 'second');
  f.onResolve = n => {
    if (n.id === first.id) setImmediate(() => {
      f.add('p', 'new-failure'); void f.ops.scheduleCoordinationAttentionNotifications('p');
    });
    if (n.id === second.id) assert.ok(f.inspected.includes('new-failure'), 'old resolution waits for the new complete pass');
  };
  await f.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(f.workspace.getNotification(second.id).status, 'resolved');
  assert.equal(f.notice('new-failure').status, 'open');
});

test('stop joins queued or yielded work and prevents any further store reads', async t => {
  const queued = notifications(t); queued.add('p', 'p');
  const work = queued.ops.scheduleCoordinationAttentionNotifications('p');
  await queued.ops.stopCoordinationAttentionNotifications(); await work;
  assert.equal(queued.inspected.length, 0);
  await queued.ops.scheduleCoordinationAttentionNotifications('p'); assert.equal(queued.inspected.length, 0);
  const running = notifications(t); running.add('p', 'a'); running.add('p', 'b');
  running.onInspect = () => { setImmediate(() => { void running.ops.stopCoordinationAttentionNotifications(); }); };
  await running.ops.scheduleCoordinationAttentionNotifications('p');
  assert.equal(running.inspected.length, 1);
  await immediate(); assert.equal(running.inspected.length, 1);
});

test('startup repairs notices synchronously, including orphaned projects', t => {
  const f = notifications(t), orphan = f.stale('missing'); f.add('p', 'p');
  f.ops.reconcileCoordinationAttentionNotifications();
  assert.equal(f.notice('p').status, 'open'); assert.equal(f.workspace.getNotification(orphan.id).status, 'resolved');
});

test('one fresh global pending-agent snapshot preserves quarantine, decisions and deleted history', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE agent_creation_operations(id,project_id,status);
    CREATE TABLE agent_creation_operation_members(operation_id,agent_id);
    INSERT INTO agent_creation_operations VALUES('op','foreign-project','preparing');
    INSERT INTO agent_creation_operation_members VALUES('op','pending');`);
  let batches = 0, individual = 0;
  const context = { client: db };
  const store = { listAgents: () => [{ id: 'live', title: 'Live' }],
    pendingAgentCreationIds: () => { batches++; return AgentStore.prototype.pendingAgentCreationIds.call(context); },
    agentCreationPending: id => { individual++; return AgentStore.prototype.agentCreationPending.call(context, id); } };
  const decision = { id: 'question', agentId: 'pending', projectId: 'p', status: 'pending', runId: 'r', question: 'Private question', createdAt: at, updatedAt: at };
  const items = ['live', 'pending', 'deleted'].flatMap(agentId => Array.from({ length: 100 }, (_, i) => ({
    id: `activation:${agentId}-${i}`, recordId: `${agentId}-${i}`, kind: 'activation', state: 'pending',
    agentIds: [agentId, ...(agentId === 'live' && i === 0 ? ['pending'] : [])], relatedItemIds: [], referenceIds: [], createdAt: at, updatedAt: at,
  })));
  const projection = new AgentWorkProjection(store, { agentWorkItems: () => ({ items: structuredClone(items), truncated: false }) },
    { listDecisionPage: () => ({ decisions: [decision], hasMore: false }), getDecision: () => decision, decisionsForRuns: () => [] });
  for (const status of ['preparing', 'canonical_committed', 'rolling_back', 'completed', 'rolled_back']) {
    db.prepare('UPDATE agent_creation_operations SET status=?').run(status);
    const result = projection.inspect({ projectId: 'p', limit: 500 });
    const pending = ['preparing', 'canonical_committed', 'rolling_back'].includes(status);
    assert.equal(result.items.some(x => x.agentIds.includes('pending')), !pending, status);
    assert.equal(result.items.some(x => x.kind === 'decision'), !pending, status);
    assert.ok(result.items.some(x => x.agentIds.includes('deleted')), 'non-pending deleted history remains visible');
  }
  assert.equal(batches, 5); assert.equal(individual, 0, 'quarantine checks do not query per work item');
});

test('pending Decisions suppress generic failure, and Skip exposes the unchanged failed assignment', fixtureTestOptions, t =>
  withFixture(t, async f => {
    const chat = await f.createChat('Decision invalidation');
    const manager = await f.createIdleAgent(chat, 'Manager'), worker = await f.createIdleAgent(chat, 'Worker');
    const session = await f.hold(manager.id);
    let decision;
    f.plans.set(worker.id, [{ output: false, run: async s => {
      decision = f.ok(await f.tool(s, 'ponderosa_decision', { idempotencyKey: randomUUID(),
        mode: 'text', question: 'Which recovery should I use?', blocking: false }));
      f.ok(await f.tool(s, 'ponderosa_update_request', { kind: 'failed', text: 'Controlled failed assignment' }));
    } }]);
    const result = f.ok(await f.tool(session, 'ponderosa_coordinate', { idempotencyKey: randomUUID(), requests: [
      { recipientAgentId: worker.id, text: 'Exercise Decision invalidation', lifetime: { kind: 'indefinite' } },
    ] }));
    await until(async () => (await f.detail(worker.id)).coordinationV3.requests.some(r => r.id === result.requestIds[0] && r.state === 'failed'), 'failed assignment');
    const notices = async () => f.ok(await f.api('GET', '/api/notifications')).items;
    assert.ok((await notices()).some(n => n.decision?.id === decision.id));
    assert.equal((await notices()).some(n => n.resolution?.requestId === result.requestIds[0]), false);
    f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true }));
    await until(async () => (await notices()).some(n => n.resolution?.requestId === result.requestIds[0]), 'Skip reveals the generic failure');
    const request = (await f.detail(worker.id)).coordinationV3.requests.find(r => r.id === result.requestIds[0]);
    assert.equal(request.state, 'failed', 'notification repair does not rewrite the canonical result');
  }));

for (const engine of ['codex', 'claude']) test(`${engine}: failed assignment notice and canonical result survive reopen`, fixtureTestOptions, t =>
  withFixture(t, async f => {
    const chat = await f.createChat(`Notification ${engine}`);
    const create = title => f.api('POST', `/api/projects/${chat.projectId}/agents`, {
      title, engine, conversationId: chat.id, idempotencyKey: randomUUID(),
    }).then(f.ok);
    const manager = await create('Manager'), worker = await create('Worker');
    const session = await f.hold(manager.id);
    f.plans.set(worker.id, [{ output: false, run: async s => {
      f.ok(await f.tool(s, 'ponderosa_update_request', { kind: 'failed', text: 'Controlled failed assignment' }));
    } }]);
    const result = f.ok(await f.tool(session, 'ponderosa_coordinate', { idempotencyKey: randomUUID(), requests: [
      { recipientAgentId: worker.id, text: 'Exercise failure notification', lifetime: { kind: 'indefinite' } },
    ] }));
    const notices = async () => f.ok(await f.api('GET', '/api/notifications')).items.filter(n => n.resolution?.requestId === result.requestIds[0]);
    await until(async () => (await notices()).length === 1, 'derived assignment notice');
    assert.equal((await notices())[0].workContext.state, 'failed');
    assert.equal(f.ok(await f.api('GET', '/api/health')).status, 'ok');
    await f.reopen();
    assert.equal((await notices()).length, 1);
    const request = (await f.detail(worker.id)).coordinationV3.requests.find(r => r.id === result.requestIds[0]);
    assert.equal(request.state, 'failed');
  }, { diagnosticProvider: true }));


test('reordered affected Agents do not rewrite a notice, while real changes persist across reopen', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'notification-membership-'));
  let workspace = new WorkspaceStore(root);
  t.after(() => { workspace.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { projectId: 'p', kind: 'operational', status: 'open',
    dedupeKey: 'coordination-attention:membership', title: 'Assignment needs review',
    body: 'The outcome is uncertain.', agentId: 'worker', agentIds: ['worker', 'reviewer', 'manager'] };
  const notice = workspace.createNotification(input);
  const journal = path.join(root, 'workspace-events.jsonl');
  const before = readFileSync(journal), cursor = workspace.cursor();
  for (const agentIds of [['manager', 'worker', 'reviewer'], ['reviewer', 'manager', 'worker']]) {
    const retained = workspace.createNotification({ ...input, agentIds });
    assert.deepEqual(retained.agentIds, notice.agentIds, 'retain the saved presentation order');
  }
  assert.equal(workspace.cursor(), cursor);
  assert.deepEqual(readFileSync(journal), before, 'reconciliation must not append duplicate updates');
  workspace.close(); workspace = new WorkspaceStore(root);
  workspace.createNotification({ ...input, agentIds: [...input.agentIds].reverse() });
  assert.equal(workspace.cursor(), cursor, 'reopen must not recreate ordering churn');
  assert.deepEqual(readFileSync(journal), before);

  let changedAt = workspace.cursor();
  const changed = workspace.createNotification({ ...input, agentIds: ['worker', 'new-reviewer'] });
  assert.equal(workspace.readSince(changedAt).length, 1, 'new membership remains a real update');
  assert.deepEqual(changed.agentIds, ['worker', 'new-reviewer']);
  changedAt = workspace.cursor();
  const detail = workspace.createNotification({ ...input, body: 'A human choice is required.', agentIds: ['new-reviewer', 'worker'] });
  assert.equal(workspace.readSince(changedAt).length, 1, 'changed content remains visible');
  assert.equal(detail.body, 'A human choice is required.');
  assert.deepEqual(detail.agentIds, changed.agentIds);
  workspace.setNotificationStatus(notice.id, 'dismissed');
  changedAt = workspace.cursor();
  workspace.createNotification(input);
  assert.equal(workspace.cursor(), changedAt, 'dismissed notices stay dismissed');
  workspace.close(); workspace = new WorkspaceStore(root);
  assert.equal(workspace.getNotification(notice.id).status, 'dismissed');
});
