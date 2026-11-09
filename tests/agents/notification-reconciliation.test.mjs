import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { AgentStore, WorkspaceStore, CoordinationV3Store } from '@ponderosa/agents';
import { createOperationalNotifications } from '../../apps/server/dist/operational-notifications.js';
import { WebPushDeliveryManager, pushPayload } from '../../apps/server/dist/web-push-delivery.js';
import { requestSettingsTransition, reconcileSettingsTransitionReservations } from '../../apps/server/dist/context-transition-admission.js';
import { EngineAuthStatusCache } from '../../apps/server/dist/engine-auth-cache.js';
import { createRuntimeEventAuthority } from '../../apps/server/dist/runtime-event-authority.js';
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
    getAgent: id => id.endsWith('-sender') ? undefined : ({ id, title: id, projectId:id[0], conversationId: `${id[0]}-chat` }),
  };
  const coordinationV3 = {
    coordinationAttentionCandidates: (limit, cursor) => [...requests.values()]
      .filter(r => ['failed', 'outcome_unknown', 'blocked'].includes(r.state))
      .filter(r => !cursor || r.id < cursor.recordId)
      .sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit)
      .map(r => ({ kind: 'request', recordId: r.id, projectId: r.projectId, agentId: r.recipientAgentId, updatedAt: at })),
    getRequest: id => requests.get(id),
    requestIsOperatorRecovery: id => requests.get(id)?.operatorInitiated ?? false,
    requestRetryStatus: id => ({ successorRequestId:requests.get(id)?.recoverySuccessorRequestId, recoveryState: requests.get(id)?.recoveryState, successorState: requests.get(id)?.successorState ?? (requests.get(id)?.recovered ? 'completed' : undefined) }),
    requestLifecycleDetails: ({recordId}) => ({ updates: requests.get(recordId)?.cause ? [{kind:'outcome_unknown',outcomeCause:requests.get(recordId).cause,resultingState:'outcome_unknown',createdAt:at}] : [] }),
  };
  const ops = createOperationalNotifications({ store, coordinationV3, workspace,
    publishWorkspaceSince() {}, logError: meta => errors.push(meta) });
  ops.agentWorkProjection.inspect = input => {
    const id = input.focusId.slice('request:'.length), r = requests.get(id);
    inspected.push(id); f.onInspect(id);
    const item = { id: input.focusId, recordId: id, kind: 'request', state: r.state,
      agentIds: [r.recipientAgentId], recipientAgentId: r.recipientAgentId, updatedAt: at };
    const items = [item, ...(r.pendingDecision ? [{ id: 'decision', kind: 'decision', state: 'pending' }] : [])];
    return { items, traces: [{ id: r.traceId ?? `trace:${id}`, itemIds: items.map(x => x.id), agentIds: item.agentIds,
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
        dedupeKey: `coordination-attention:${id}:trace`, workContext:{kind:'request',recordId:id,state:'failed',occurredAt:at}, title: 'Old notice', body: 'Old failure' });
    },
  });
}

test('unchanged publications retain one durable snapshot while invalidations coalesce and yield', async t => {
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
  assert.equal(canonical.length, 1, '100 unchanged coordination and one delivery publication need one durable snapshot'); assert.equal(published.length, 101, 'every workspace invalidation is retained');
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

test('pending Decisions stay visible and Skip does not promote internal assignment failure', fixtureTestOptions, t =>
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
    await f.reopen();
    assert.equal((await notices()).some(n => n.resolution?.requestId === result.requestIds[0]),false);
    const request = (await f.detail(worker.id)).coordinationV3.requests.find(r => r.id === result.requestIds[0]);
    assert.equal(request.state, 'failed', 'notification repair does not rewrite the canonical result');
  }));

for (const engine of ['codex', 'claude']) test(`${engine}: internal failure stays in canonical activity across reopen`, fixtureTestOptions, t =>
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
    await until(async()=> (await f.detail(worker.id)).coordinationV3.requests.some(r=>r.id===result.requestIds[0]&&r.state==='failed'),'canonical failed Request');
    assert.equal((await notices()).length,0);
    assert.equal(f.ok(await f.api('GET', '/api/health')).status, 'ok');
    await f.reopen();
    assert.equal((await notices()).length, 0);
    const request = (await f.detail(worker.id)).coordinationV3.requests.find(r => r.id === result.requestIds[0]);
    assert.equal(request.state, 'failed');
  }, { diagnosticProvider: true }));


test('duplicate snapshots do not grow durable history; changes, failed writes, scopes and reopen remain exact', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-coordination-storage-'));
  let store = new AgentStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.createProject({ label: 'Storage fixture', hostPath: root, defaultEngine: 'codex' });
  const chat = store.createConversation(project.id, { title: 'Snapshot scope' });
  const a = store.createAgent(project.id, { title: 'Sender', engine: 'codex', conversationId: chat.id });
  const b = store.createAgent(project.id, { title: 'Receiver', engine: 'claude', conversationId: chat.id });
  let coordinationV3 = new CoordinationV3Store(store.sqlite), published = [], workspace = [];
  const models = () => createServerReadModels({ store, coordinationV3, publish: (id, event) => published.push({ id, event }),
    appendWorkspace: event => workspace.push(event), scheduleCoordinationAttentionNotifications() {},
    reconcileCommunicationNotifications() {}, isClosed: () => false });
  let owner = models();
  const snapshots = id => store.readEvents(id).filter(x => x.event.type === 'coordination_v3_changed');
  for (let i = 0; i < 100; i++) owner.publishCoordinationV3Changed(a.id);
  assert.equal(snapshots(a.id).length, 1); assert.equal(workspace.length, 100);
  owner.publishCoordinationV3Changed(b.id); assert.equal(snapshots(b.id).length, 1);
  const requestId = randomUUID(), text = 'Exact authored request 😀 is not disposable snapshot data';
  coordinationV3.coordinate({ projectId: project.id, conversationId: chat.id, requesterAgentId: a.id,
    actorScope: 'user:local-operator', idempotencyKey: randomUUID(), requests: [
      { requestId, recipientAgentId: b.id, lifetime: { kind: 'indefinite' }, payload: { text } },
    ] });
  const append = store.appendEvent.bind(store);
  store.appendEvent = () => { throw Error('Controlled write failure'); };
  assert.throws(() => owner.publishCoordinationV3Changed(a.id), /Controlled write failure/);
  store.appendEvent = append;
  owner.publishCoordinationV3Changed(a.id); owner.publishCoordinationV3Changed(a.id);
  owner.publishMessageDeliveryChanged(b.id);
  assert.equal(snapshots(a.id).length, 2, 'failed append did not suppress the retry');
  assert.equal(snapshots(b.id).length, 2, 'one Agent cannot suppress another Agent change');
  for (const id of [a.id, b.id]) assert.deepEqual(snapshots(id).at(-1).event.coordination, coordinationV3.agentSnapshot(id));
  for (const id of [a.id, b.id]) assert.deepEqual(published.filter(x => x.id === id).map(x => x.event.seq), snapshots(id).map(x => x.seq), 'live and replay use the same ordered durable sequence');
  store.close(); store = new AgentStore(root); coordinationV3 = new CoordinationV3Store(store.sqlite); owner = models();
  assert.equal(coordinationV3.getRequest(requestId).payload.text, text, 'SQLite request authority survives reopen');
  for (let i = 0; i < 100; i++) owner.publishCoordinationV3Changed(a.id);
  assert.equal(snapshots(a.id).length, 3, 'a restart permits one fresh mirror, not another burst');
  assert.deepEqual(snapshots(a.id).at(-1).event.coordination, coordinationV3.agentSnapshot(a.id));
});


test('missing final handoff stays internal audit evidence, not an operator action', async t => {
 const f=notifications(t),request=f.add('p','missing-handoff');request.state='outcome_unknown';request.requesterAgentId='p-owner';request.cause={code:'run_completed_without_request_update'};
 await f.ops.scheduleCoordinationAttentionNotifications('p');
 assert.equal(f.notice(request.id),undefined);assert.equal(request.state,'outcome_unknown','Related finished work never proves the parent complete');
});
test('an active canonical recovery successor is not an operator obligation',async t=>{
 const f=notifications(t),request=f.add('p','recovering');request.recoverySuccessorRequestId='successor';request.successorState='in_progress';request.operatorInitiated=true;
 await f.ops.scheduleCoordinationAttentionNotifications('p');assert.equal(f.notice(request.id),undefined);
 request.successorState='failed';const failed=f.add('p','successor');failed.requesterAgentId='p-owner';failed.operatorInitiated=true;await f.ops.scheduleCoordinationAttentionNotifications('p');assert.equal(f.notice(failed.id)?.status,'open','Failed operator recovery remains available to review');
});
test('dismissal belongs to the exact work record across restart and trace regrouping',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'ponderosa-notice-identity-'));let workspace=new WorkspaceStore(root);
 t.after(()=>{workspace.close();rmSync(root,{recursive:true,force:true});});
 const notice=trace=>({kind:'operational',category:'coordination',severity:'attention',status:'open',dedupeKey:`coordination-attention:${trace}:request-a`,projectId:'p',workContext:{kind:'request',recordId:'request-a',traceId:trace,state:'failed',occurredAt:at},title:'Assignment needs review',body:'Review recovery'});
 const original=workspace.createNotification(notice('first'));workspace.setNotificationStatus(original.id,'dismissed');workspace.close();workspace=new WorkspaceStore(root);
 const regrouped=workspace.createNotification(notice('regrouped'),true);assert.equal(regrouped.id,original.id);assert.equal(regrouped.status,'dismissed');
});

// Historical persisted records exercise the actual replay indexes, not only new writes.
const historicalNotice = (id, state='failed') => ({ id, createdAt:at, projectId:'p', kind:'operational', category:'coordination', status:'open', severity:'attention', dedupeKey:`coordination-attention:trace:${id}:r`, workContext:{kind:'request', recordId:'r', state, occurredAt:at},title:'Review assignment',body:'Review recovery' });
test('legacy duplicate dismissal suppresses older sibling after reopen in feed, badge, projection and push', t => {
 const dir=mkdtempSync(path.join(tmpdir(),'ui021-review-')); let w=new WorkspaceStore(dir); t.after(()=>{w.close();rmSync(dir,{recursive:true,force:true});});
 w.putPushSubscription({deviceId:'d',endpoint:'https://invalid.example/push',expirationTime:null,keys:{p256dh:'sample',auth:'sample'}});
 const sub=w.listPushSubscriptions()[0];
 for(const id of ['old-open','regrouped-dismissed']) w.append({type:'notification_changed',notificationId:id,action:'created'},{kind:'notification',notification:historicalNotice(id),pushTargets:[{deviceId:'d',subscriptionUpdatedAt:sub.updatedAt}]});
 w.setNotificationStatus('regrouped-dismissed','dismissed');w.close();w=new WorkspaceStore(dir);
 const {id:_,createdAt:__,...input}=historicalNotice('fresh');const adopted=w.createNotification({...input,dedupeKey:'coordination-attention:request:r'},true);
 assert.equal(adopted.id,'regrouped-dismissed');assert.equal(adopted.status,'dismissed');assert.equal(w.listNotificationPage({limit:100}).openActionCount,0);assert.deepEqual(w.activeNotificationIds(['old-open','regrouped-dismissed']),[]);assert.equal(w.notificationProjection({projectIds:['p'],conversationIds:[]}).workspace.importantCount,0);assert.equal(w.duePushDeliveries().length,0);
});
function recoveryFixture(t){const dir=mkdtempSync(path.join(tmpdir(),'ui021-review-'));const w=new WorkspaceStore(dir),requests=new Map(),joins=new Map();let ownerLive=false, ownerChat='chat', inspections=0;const c={getRequest:id=>requests.get(id),getJoin:id=>joins.get(id),requestRetryStatus:id=>requests.get(id)?.retry??{},requestIsOperatorRecovery:id=>requests.get(id)?.operator===true,requestLifecycleDetails:()=>({updates:[]}),coordinationAttentionCandidates:()=>[...requests.values()].filter(x=>['failed','blocked','outcome_unknown'].includes(x.state)).map(r=>({kind:'request',recordId:r.id,projectId:'p',agentId:'worker'}))};const ops=createOperationalNotifications({workspace:w,coordinationV3:c,store:{getProject:()=>({id:'p'}),getAgent:id=>id==='owner'&&!ownerLive?undefined:{id,title:id,projectId:'p',conversationId:ownerChat}},publishWorkspaceSince(){},logError(m){throw m;}});ops.agentWorkProjection.inspect=input=>{inspections++;const r=requests.get(input.focusId.slice(8));return{items:[{id:input.focusId,recordId:r.id,kind:'request',state:r.state,agentIds:['worker'],recipientAgentId:'worker',updatedAt:at}],traces:[{id:'trace:r',state:'finished',itemIds:[input.focusId],agentIds:['worker']}]};};const r={id:'r',projectId:'p',conversationId:'chat',requesterAgentId:'owner',recipientAgentId:'worker',payload:{text:'assignment'},state:'failed'};requests.set('r',r);t.after(async()=>{await ops.stopCoordinationAttentionNotifications();w.close();rmSync(dir,{recursive:true,force:true});});return{w,r,requests,joins,c,ops,owner:live=>ownerLive=live,ownerChat:chat=>ownerChat=chat,inspections:()=>inspections};}
test('demoted internal notice resolves only on canonical completion, not completed trace',t=>{const f=recoveryFixture(t);f.ops.reconcileCoordinationAttentionNotifications();const n=f.w.listNotificationPage({limit:100}).items[0];assert.equal(n.status,'open');f.owner(true);f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.w.getNotification(n.id).kind,'information');assert.equal(f.w.getNotification(n.id).status,'open');assert.equal(f.r.state,'failed');f.r.state='completed';f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.w.getNotification(n.id).status,'resolved');});
test('failed Agent recovery is internal while failed exact operator recovery is actionable',t=>{const f=recoveryFixture(t);f.owner(true);f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.w.listNotificationPage({limit:100}).openActionCount,0);f.r.operator=true;f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.w.listNotificationPage({limit:100}).openActionCount,1);});
test('pending descendant hides predecessor, completed descendant resolves existing predecessor notice',t=>{const f=recoveryFixture(t);f.ops.reconcileCoordinationAttentionNotifications();const n=f.w.listNotificationPage({limit:100}).items[0];f.r.retry={successorRequestId:'b',successorState:'failed',recoveryState:'in_progress'};f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.w.listNotificationPage({limit:100}).openActionCount,0);assert.equal(f.w.getNotification(n.id).status,'open');f.r.retry.recoveryState='completed';f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.w.getNotification(n.id).status,'resolved');});
test('legacy Join cleanup uses exact canonical read without graph traversal and checks Chat scope',t=>{const f=recoveryFixture(t);f.requests.clear();f.owner(true);f.ownerChat('different-chat');f.joins.set('j',{projectId:'p',conversationId:'chat',ownerAgentId:'owner',state:'impossible'});const n=f.w.createNotification({...historicalNotice('join'),workContext:{kind:'join',recordId:'j',state:'impossible',occurredAt:at}});f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.inspections(),0);assert.equal(f.w.getNotification(n.id).kind,'operational');f.ownerChat('chat');f.ops.reconcileCoordinationAttentionNotifications();assert.equal(f.w.getNotification(n.id).kind,'information');});
test('actual canonical multi-step lineage retains direct successor and reports descendant completion',t=>{const dir=mkdtempSync(path.join(tmpdir(),'ui021-lineage-review-'));const store=new AgentStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const p=store.createProject({label:'Disposable',hostPath:dir,defaultEngine:'codex'});const chat=store.createConversation(p.id,{title:'Disposable'});const a=store.createAgent(p.id,{title:'Owner',engine:'codex',conversationId:chat.id});const b=store.createAgent(p.id,{title:'Worker',engine:'codex',conversationId:chat.id});const v=new CoordinationV3Store(store.sqlite);const create=predecessor=>v.coordinate({projectId:p.id,conversationId:chat.id,requesterAgentId:a.id,actorScope:'user:local-operator',idempotencyKey:randomUUID(),requests:[{recipientAgentId:b.id,lifetime:{kind:'indefinite'},payload:{text:'Report actual outcome'},...(predecessor?{recoveryOfRequestId:predecessor}:{})}]}).requestIds[0];const finish=(id,kind)=>v.updateRequest({requestId:id,updateId:randomUUID(),kind,actor:{kind:'agent',id:b.id},payload:{text:'Exact canonical result'}});const aId=create();finish(aId,'failed');const bId=create(aId);finish(bId,'failed');const cId=create(bId);assert.equal(v.requestIsOperatorRecovery(aId),false);assert.equal(v.requestIsOperatorRecovery(bId),true);assert.equal(v.requestRetryStatus(aId).successorRequestId,bId);assert.equal(v.requestRetryStatus(aId).successorState,'failed');assert.equal(v.requestRetryStatus(aId).recoveryState,'open');finish(cId,'completed');assert.equal(v.requestRetryStatus(aId).recoveryState,'completed');assert.equal(v.requestRetryStatus(bId).recoveryState,'completed');});

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


test('short provider cause is retained in scoped diagnostics and redacted before Copy Logs', fixtureTestOptions, t => {
 return withFixture(t, async f => {
  const chat = await f.createChat('Short diagnostic'), agent = await f.createIdleAgent(chat, 'Failing worker');
  const cause = 'Controlled harmless upstream handshake refused';
  const secret = 'diagnostic-secret-that-must-not-escape';
  f.plans.set(agent.id, [{ output: false, run: async session => session.events.push({ type: 'error', terminalStatus: 'failed', message: `${cause} Authorization: Bearer ${secret}` }) }]);
  await f.send(agent.id, 'Controlled failure');
  const read = async (projectId, agentId) => f.ok(await f.api('GET', `/api/projects/${projectId}/agent-work?agentId=${agentId}`));
  const result = await until(async () => {
   const value = await read(chat.projectId, agent.id);
   return value.items.some(item => item.details?.some(detail => detail.value.includes(cause))) && value;
  }, 'precise scoped diagnostic');
  assert.ok(!JSON.stringify(result).includes(secret));
  const run = result.items.find(item => item.kind === 'run' && item.details?.some(detail => detail.label === 'Provider failure detail'));
  const details = f.ok(await f.api('GET', `/api/projects/${chat.projectId}/agent-work/items/run/${run.recordId}`));
  assert.ok(JSON.stringify(details).includes(cause)); assert.ok(!JSON.stringify(details).includes(secret));
  const other = await f.createChat('Foreign Chat'), otherAgent = await f.createIdleAgent(other, 'Other worker');
  assert.ok(!JSON.stringify(await read(other.projectId, otherAgent.id)).includes(cause));
  assert.equal((await f.api('GET', `/api/projects/${other.projectId}/agent-work/items/run/${run.recordId}`)).status, 404);
 });
});

test('runtime event-consumer stall surfaces at 30 seconds and clears only after actual persistence',async t=>{
 const now=Date.parse('2030-01-01T00:00:00Z');t.mock.timers.enable({apis:['Date'],now});
 const agent={id:'owned',projectId:'project',conversationId:'chat',updatedAt:new Date(now).toISOString()};
 const run={startedAt:agent.updatedAt,executionId:'execution',v3SchedulerRunId:'scheduler',ownershipState:'running',leaseExpiresAt:new Date(now+3600000).toISOString()};
 const activeRuns=new Map([[agent.id,run]]),persisted=[],published=[];
 const authority=createRuntimeEventAuthority({opts:{},activeRuns,store:{appendEvent:(id,event)=>{persisted.push({id,event});return {...event,ts:new Date().toISOString()}}},
  ownsActiveRunForAuditDrain:(id,current)=>activeRuns.get(id)===current,publish:(id,event)=>published.push({id,event})});
 const models=createServerReadModels({activeRuns,scheduledSessionRollovers:new Map(),runtimeStallAfterMs:30000,
  workspace:{listDecisions:()=>[]},store:{latestHealthObservation:()=>undefined,getRunHealthSummaries:()=>[],activeExecutionPhase:()=>undefined},
  coordinationV3:{activeContextRollovers:()=>[],getAgentAvailability:()=> 'running',providerBlockedState:()=>undefined},
  transitionRun:authority.transitionRun,reusableRuntime:()=>undefined});
 const health=()=>models.agentHealth({type:'project',id:'project'},[agent]).agents[0];
 assert.equal(authority.receiveRuntimeEvent(agent.id,run),true);
 t.mock.timers.setTime(now+29999);assert.equal(health().status,'running');
 t.mock.timers.setTime(now+30000);const stalled=health();
 assert.equal(stalled.status,'stalled');assert.equal(stalled.reason,'runtime_event_consumer_stalled');
 assert.equal(stalled.attention.reason,'runtime_event_consumer_stalled');assert.equal(stalled.executionId,'execution');
 assert.equal(run.ownershipState,'stalled');assert.equal(persisted.length,0,'health cannot invent provider output or finish the task');
 await authority.persistRuntimeEvent(agent.id,run,{type:'text',text:'Controlled input',executionId:'execution'});
 assert.equal(persisted.length,1);assert.equal(published.length,1);assert.equal(health().status,'running');
 assert.equal(run.ownershipState,'running');assert.equal(run.lastEventPersistedAt,new Date(now+30000).toISOString());
 // Quiet native commands are not proof of a blocked event consumer.
 t.mock.timers.setTime(now+360000);assert.equal(health().status,'running');assert.equal(persisted.length,1);
 run.ownershipState='cancelling';assert.equal(authority.receiveRuntimeEvent(agent.id,run),false);
 assert.equal(await authority.persistRuntimeEvent(agent.id,run,{type:'text',text:'late',executionId:'execution'}),undefined);
 assert.equal(persisted.length,1);
});

// Offline canonical stores and a fake sender; no provider or push service.
function quietRecoveryFixture(t) {
 const root=mkdtempSync(path.join(tmpdir(),'ui002-notices-'));
 let store=new AgentStore(root),workspace=new WorkspaceStore(root),coordinationV3;
 const project=store.createProject({label:'Recovery project',hostPath:root,defaultEngine:'codex'});
 const chat=store.createConversation(project.id,{title:'Affected Chat'}),agent=store.createAgent(project.id,{title:'Affected Agent',engine:'codex',conversationId:chat.id});
 const failures=new Map(),receipts=new Map();let source,owner,ops,ctx;
 function bind() {
  coordinationV3=new CoordinationV3Store(store.sqlite);
  coordinationV3.communicationAttentionActivations=()=>[...failures.values()];
  coordinationV3.deliveryReceiptsForCommunication=(_project,event)=>receipts.has(event)?[receipts.get(event)]:[];
  store.getCommunicationEvent=()=>({text:'Canonical blocked instruction'});
  store.resumeSessionState=()=>({sessionId:'retained-session',toolContractHash:'a'.repeat(64)});
  store.providerCommandContextBoundary=()=>source&&({executionId:source.runId,fencingToken:source.fencingToken,providerSessionId:'retained-session'});
  coordinationV3.activeContextRollover=()=>owner;
  ops=createOperationalNotifications({store,workspace,coordinationV3,publishWorkspaceSince(){},logError(meta){throw meta;}});
  ctx={app:{},store,workspace,coordinationV3,...ops};
 }
 bind();
 const create=(text='Canonical blocked instruction')=>coordinationV3.createActivation({projectId:project.id,agentId:agent.id,kind:'human_message',priority:1,promptClass:'human',dedupeKey:randomUUID(),scopeKey:'conversation:'+chat.id,payload:{text},sourceKind:'fixture',sourceId:randomUUID(),now:new Date().toISOString()});
 const initial=create();source=coordinationV3.leaseNextRun({workerId:'offline-source'});assert.ok(source);assert.ok(source.activationIds.includes(initial));
 store.sqlite.prepare("UPDATE scheduler_runs SET status='completed',prompt_injection_state='injected',provider_session_id='retained-session',started_at=?,terminal_at=? WHERE id=?").run(at,at,source.runId);
 store.sqlite.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(initial);
 workspace.putPushSubscription({deviceId:'device',endpoint:'https://invalid.example/push',expirationTime:null,keys:{p256dh:'synthetic',auth:'synthetic'}});
 const hold=async id=>requestSettingsTransition({...ctx,opts:{},engines:new Map(),engineAuthStatuses:new EngineAuthStatusCache(),cachedModelOptions:()=>undefined,excludedAgentIds:[],candidate:{activationId:id,agentId:agent.id,projectId:project.id,scopeKey:'conversation:'+chat.id}});
 const failure=(id,state='outcome_unknown',terminalOutcome=state==='outcome_unknown'?null:state)=>{
  store.sqlite.prepare('UPDATE agent_activations SET state=?,terminal_outcome=?,updated_at=? WHERE id=?').run(state,terminalOutcome,new Date().toISOString(),id);
  failures.set(id,{id,projectId:project.id,agentId:agent.id,kind:'human_message',state,terminalOutcome,scopeKey:'conversation:'+chat.id,communicationEventId:id,communicationIntent:'user_dm',deliveryFailures:1,updatedAt:new Date().toISOString()});
  receipts.set(id,{activationId:id,targetAgentId:agent.id,state:state==='outcome_unknown'?'run_unconfirmed':'failed',attemptCount:1,updatedAt:at});
 };
 t.after(()=>{workspace.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {project,chat,agent,create,hold,failure,failures,receipts,source,
  get store(){return store;},get workspace(){return workspace;},get c(){return coordinationV3;},get ops(){return ops;},
  reconcile(){reconcileSettingsTransitionReservations(ctx);},
  owner(value){owner=value;},
  reopen(){workspace.close();store.close();store=new AgentStore(root);workspace=new WorkspaceStore(root);bind();},
  notices(){return workspace.listNotificationPage({limit:100}).items;}};
}

test('UI002 one context boundary survives fingerprints, queued work, dismissal and restart until verified recovery',async t=>{
 const f=quietRecoveryFixture(t),ids=[f.create('First blocked instruction'),f.create('Second blocked instruction'),f.create('Third blocked instruction')];
 for(const id of ids)assert.equal(await f.hold(id),false);
 let notice=f.notices()[0];assert.equal(f.notices().length,1);assert.equal(f.workspace.listPushDeliveries().length,1);
 assert.deepEqual(new Set(notice.workContext.activationIds),new Set(ids));assert.match(notice.title,/Affected Agent.*Affected Chat/);assert.match(notice.workContext.assignment,/blocked instruction/);
 const identity=notice.id;
 f.workspace.updatePreferences({globalInstructions:'Changed guidance'});f.reconcile();
 assert.equal(f.workspace.getNotification(identity).status,'open','a fingerprint only schedules admission recheck');
 for(const id of ids)await f.hold(id);
 assert.equal(f.notices()[0].id,identity);assert.equal(f.workspace.listPushDeliveries().length,1);
 f.workspace.setNotificationStatus(identity,'dismissed');const fourth=f.create('Fourth blocked instruction');await f.hold(fourth);ids.push(fourth);
 f.reopen();f.reconcile();assert.equal(f.workspace.getNotification(identity).status,'dismissed');assert.equal(f.workspace.listPushDeliveries().length,0,'dismissal removes its pending push without renewing the incident');
 for(const id of ids.slice(0,-1))f.store.sqlite.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(id);
 f.reconcile();assert.equal(f.workspace.getNotification(identity).recoveredAt,undefined,'one still-blocked member prevents recovery');
 f.store.sqlite.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(fourth);f.reconcile();
 assert.equal(f.workspace.getNotification(identity).status,'dismissed');assert.ok(f.workspace.getNotification(identity).recoveredAt);
 assert.equal(f.workspace.duePushDeliveries().length,0);assert.equal(f.workspace.nextPushDeliveryAt(),undefined);
 const next=f.create('New incident after verified recovery');await f.hold(next);
 assert.notEqual(f.notices()[0].id,identity);assert.equal(f.workspace.duePushDeliveries().length,1);
});

test('UI002 owned context recovery stays quiet while rechecks and revoked holds cannot masquerade as recovery',async t=>{
 const f=quietRecoveryFixture(t),id=f.create();await f.hold(id);const notice=f.notices()[0];
 f.store.sqlite.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_reservation_wait'").run(id);
 f.owner({id:'owned-rollover',state:'requested',scopeKey:'conversation:'+f.chat.id,oldProviderSessionId:'retained-session',sourceRunId:f.source.runId});
 f.reconcile();assert.equal(f.workspace.listNotificationPage({limit:100}).openActionCount,0);assert.equal(f.workspace.activeNotificationIds([notice.id]).length,0);assert.equal(f.workspace.duePushDeliveries().length,0);
 const cursor=f.workspace.cursor();f.reconcile();assert.equal(f.workspace.cursor(),cursor,'unchanged owned recovery creates no notification churn');
 const active=f.c.contextRecovery.active;
 f.c.contextRecovery.active=()=>({state:'unsupported_fenced',progress:{phase:'held',sourceWork:'held_unknown'}});
 f.reconcile();assert.equal(f.workspace.listNotificationPage({limit:100}).openActionCount,1,'unsupported/unknown source work immediately outranks an owned context repair');
 f.c.contextRecovery.active=active;
 f.owner(undefined);f.c.holdSettingsTransitionReservation({projectId:f.project.id,agentId:f.agent.id,activationId:id,fingerprint:'b'.repeat(64)});
 await f.hold(id);assert.equal(f.notices()[0].id,notice.id);assert.equal(f.notices()[0].kind,'operational');assert.equal(f.workspace.listPushDeliveries().length,1,'same unresolved incident cannot push twice');
 f.owner({id:'owned-rollover',state:'requested',scopeKey:'conversation:'+f.chat.id,oldProviderSessionId:'retained-session',sourceRunId:f.source.runId});
 f.reconcile();await f.hold(id);assert.equal(f.workspace.listNotificationPage({limit:100}).openActionCount,1,'an access/context hold outranks a live owner');
});

test('UI002 communication recovery is quiet; outcome changes and restart retain one incident and push',async t=>{
 const f=quietRecoveryFixture(t),id=f.create();f.failure(id,'failed','permanent_failure');
 f.receipts.set(id,{activationId:id,targetAgentId:f.agent.id,state:'retrying',attemptCount:1,updatedAt:at,providerFailure:{recovery:'scheduled'}});
 f.ops.reconcileCommunicationFailureNotifications();assert.equal(f.notices().length,0);assert.equal(f.workspace.duePushDeliveries().length,0);
 f.failure(id);f.ops.reconcileCommunicationFailureNotifications();const notice=f.notices()[0];
 assert.match(notice.title,/Affected Agent.*Affected Chat/);assert.equal(notice.action.kind,'open_agent');assert.match(notice.body,/cannot confirm/);
 f.failure(id,'failed','permanent_failure');f.ops.reconcileCommunicationFailureNotifications();assert.equal(f.notices().length,1);assert.equal(f.notices()[0].id,notice.id);assert.equal(f.workspace.listPushDeliveries().length,1);
 f.reopen();f.ops.reconcileCommunicationFailureNotifications();assert.equal(f.notices()[0].id,notice.id);
 f.receipts.set(id,{activationId:id,targetAgentId:f.agent.id,state:'recovered',attemptCount:1,updatedAt:at});f.ops.reconcileCommunicationFailureNotifications();
 assert.equal(f.workspace.getNotification(notice.id).status,'resolved');assert.equal(f.workspace.nextPushDeliveryAt(),undefined);
 const sent=[];const manager=new WebPushDeliveryManager({store:f.workspace,sender:{async send(_sub,payload){sent.push(JSON.parse(payload));}},onWorkspaceEvents(){}});t.after(()=>manager.stop());await manager.drain();assert.deepEqual(sent,[]);
 f.failure(id);f.ops.reconcileCommunicationFailureNotifications();await manager.drain();assert.equal(sent.length,1);assert.notEqual(sent[0].notificationId,notice.id);assert.match(sent[0].url,/\/agents\/.*view=technical&focus=activation/);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(id).state,'outcome_unknown','notification reconciliation never rewrites uncertain work');
});

test('UI002 Web Push rechecks stale snapshot eligibility immediately before each fake send',async t=>{
 const f=quietRecoveryFixture(t),one=f.ops.createOperationalNotification({dedupeKey:'one',category:'communication',severity:'urgent',title:'One',body:'Review one'}),two=f.ops.createOperationalNotification({dedupeKey:'two',category:'communication',severity:'urgent',title:'Two',body:'Review two'});
 const sent=[];const manager=new WebPushDeliveryManager({store:f.workspace,sender:{async send(_sub,payload){sent.push(JSON.parse(payload));f.workspace.setNotificationStatus(two.id,'resolved',true);}},onWorkspaceEvents(){}});t.after(()=>manager.stop());
 await manager.drain();assert.deepEqual(sent.map(x=>x.notificationId),[one.id]);assert.equal(f.workspace.duePushDeliveries().length,0);assert.equal(f.workspace.nextPushDeliveryAt(),undefined);
});

test('UI002 retained outcome and retry-lineage aliases converge without a third push, including dismissal',async t=>{
 const f=quietRecoveryFixture(t),root=f.create(),successor=f.create();f.failure(root);f.failure(successor,'failed','permanent_failure');
 f.failures.get(root).supersededByRetry=true;f.failures.get(root).communicationEventId='same-message';f.failures.get(successor).communicationEventId='same-message';
 f.store.sqlite.prepare('INSERT INTO activation_delivery_retry_lineage VALUES(?,?,?,?,?)').run(root,successor,root,1,at);
 f.receipts.set('same-message',{activationId:successor,targetAgentId:f.agent.id,state:'failed',attemptCount:2,updatedAt:at});
 for(const [id,state] of [[root,'outcome_unknown'],[successor,'permanent_failure']])f.workspace.createNotification({kind:'operational',category:'communication',severity:'urgent',dedupeKey:`communication-delivery:${id}:${state}`,projectId:f.project.id,agentId:f.agent.id,conversationId:f.chat.id,communicationEventId:'same-message',workContext:{kind:'activation',recordId:id,state,occurredAt:at},title:'Previous failure',body:'Earlier uncertain work retained'},true);
 assert.equal(f.workspace.listPushDeliveries().length,2);
 f.reopen();f.ops.reconcileCommunicationFailureNotifications();
 const notice=f.notices()[0];assert.equal(f.notices().length,1);assert.equal(notice.workContext.recordId,root);assert.equal(f.workspace.listPushDeliveries().length,2,'adoption cannot queue a third delivery');assert.equal(f.workspace.duePushDeliveries().length,1);
 f.workspace.setNotificationStatus(notice.id,'dismissed');f.reopen();f.ops.reconcileCommunicationFailureNotifications();assert.equal(f.notices().length,0);assert.equal(f.workspace.duePushDeliveries().length,0);
 f.receipts.set('same-message',{activationId:successor,targetAgentId:f.agent.id,state:'recovered',attemptCount:2,updatedAt:at});f.ops.reconcileCommunicationFailureNotifications();assert.ok(f.workspace.getNotification(notice.id).recoveredAt);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(root).state,'outcome_unknown');
});

test('UI002 fake sender delivers one incident across unknown-to-permanent and restart',async t=>{
 const f=quietRecoveryFixture(t),id=f.create(),sent=[];
 const sender={async send(_subscription,payload){sent.push(JSON.parse(payload));}};
 let manager=new WebPushDeliveryManager({store:f.workspace,sender,onWorkspaceEvents(){}});t.after(()=>manager.stop());
 f.failure(id);f.ops.reconcileCommunicationFailureNotifications();await manager.drain();assert.equal(sent.length,1);
 f.failure(id,'failed','permanent_failure');f.ops.reconcileCommunicationFailureNotifications();await manager.drain();assert.equal(sent.length,1);
 await manager.stop();f.reopen();f.ops.reconcileCommunicationFailureNotifications();manager=new WebPushDeliveryManager({store:f.workspace,sender,onWorkspaceEvents(){}});
 await manager.drain();assert.equal(sent.length,1);assert.equal(f.notices()[0].id,sent[0].notificationId);
});

test('UI002 push reconciles canonical recovery before its first drain without recursive sends',async t=>{
 const f=quietRecoveryFixture(t),id=f.create(),sent=[];
 f.failure(id);f.ops.reconcileCommunicationFailureNotifications();const notice=f.notices()[0];
 f.receipts.set(id,{activationId:id,targetAgentId:f.agent.id,state:'recovered',attemptCount:1,updatedAt:at});
 let reconciliations=0;
 const manager=new WebPushDeliveryManager({store:f.workspace,sender:{async send(_sub,payload){sent.push(JSON.parse(payload));}},
  reconcileNotifications(){reconciliations++;f.ops.reconcileCommunicationFailureNotifications();manager.notify();},onWorkspaceEvents(){}});
 t.after(()=>manager.stop());await manager.drain();
 assert.equal(reconciliations,1);assert.deepEqual(sent,[]);assert.equal(f.workspace.getNotification(notice.id).status,'resolved');
 assert.equal(f.workspace.nextPushDeliveryAt(),undefined);assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(id).state,'outcome_unknown');
});

test('UI002 stopping a deferred push drain prevents dispatch',async t=>{
 const f=quietRecoveryFixture(t),id=f.create(),sent=[];f.failure(id);f.ops.reconcileCommunicationFailureNotifications();
 let reconciliations=0;
 const manager=new WebPushDeliveryManager({store:f.workspace,sender:{async send(_sub,payload){sent.push(payload);}},
  reconcileNotifications(){reconciliations++;},onWorkspaceEvents(){}});
 const draining=manager.drain();await manager.stop();await draining;
 assert.equal(reconciliations,0);assert.deepEqual(sent,[]);assert.equal(f.workspace.duePushDeliveries().length,1);
});

test('UI002 failed canonical reconciliation keeps push pending and reports its error',async t=>{
 const f=quietRecoveryFixture(t),id=f.create(),sent=[],errors=[];f.failure(id);f.ops.reconcileCommunicationFailureNotifications();
 const failure=new Error('Synthetic canonical read failure');
 const manager=new WebPushDeliveryManager({store:f.workspace,sender:{async send(_sub,payload){sent.push(payload);}},
  reconcileNotifications(){throw failure;},onReconciliationError(error){errors.push(error);},onWorkspaceEvents(){}});
 t.after(()=>manager.stop());await manager.drain();
 assert.deepEqual(sent,[]);assert.deepEqual(errors,[failure]);assert.equal(f.workspace.duePushDeliveries().length,1);
});
