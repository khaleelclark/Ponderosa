import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
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


test('Agent Role is canonical setup, survives rebuild/reopen, clears independently of provenance', t => withStores(t, async f => {
  let store = f.open('role');
  const agent = f.seed(store), original = store.getAgent(agent.id);
  const role = 'Review Cafe\u0301\r\nCarefully';
  const updated = store.updateAgent(agent.id, { role });
  assert.equal(updated.role, 'Review Café\nCarefully');
  assert.equal(updated.spawnPrompt, original.spawnPrompt);
  assert.deepEqual(updated.presetSnapshot, original.presetSnapshot);
  store.rebuildProjections();
  assert.equal(store.getAgent(agent.id).role, updated.role);
  assert.equal(store.listAgents(agent.projectId).find(item => item.id === agent.id).role, updated.role);
  f.close(store); store = f.open('role');
  assert.equal(store.getAgent(agent.id).role, updated.role);
  assert.throws(() => store.updateAgent(agent.id, { role: '😀'.repeat(8001) }), /8000/);
  assert.equal(store.getAgent(agent.id).role, updated.role);
  assert.equal(store.updateAgent(agent.id, { role: null }).role, undefined);
  store.rebuildProjections();
  assert.equal(store.getAgent(agent.id).role, undefined);
}));


test('same-millisecond role updates invalidate metadata readback without changing the database schema', t => withStores(t, async f => {
  const store = f.open('role-cache'), agent = f.seed(store);
  const NativeDate = globalThis.Date, stamp = agent.updatedAt;
  class FixedDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [stamp])); } }
  globalThis.Date = FixedDate;
  try {
    for (const role of ['First Standing Role', 'Newer Standing Role', null]) {
      assert.equal(store.updateAgent(agent.id, { role }).role, role ?? undefined);
      assert.equal(store.getAgent(agent.id).role, role ?? undefined);
    }
    assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM pragma_table_info('agents') WHERE name='role'").get().n, 0);
  } finally { globalThis.Date = NativeDate; }
}));



test('ownership proof change rejects older checkpoints while healthy current checkpoints remain reusable', t => withStores(t, async f => {
  let store = f.open('checkpoint'); const agent = f.seed(store);
  f.close(store); store = f.open('checkpoint'); f.close(store);
  const marker = path.join(f.root, 'checkpoint', '.projection-clean-shutdown.json');
  const certificate = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(certificate.projectionVersion, 5);
  certificate.projectionVersion = 4;
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

test('settings transition preserves pending work and isolates replacement confirmation', t => withStores(t, async f => {
  const store = f.open('settings-transition'), agent = f.seed(store), db = store.sqlite;
  const scope = `agent:${agent.id}`, now = new Date().toISOString(), session = 'old-session';
  const contractHash = 'a'.repeat(64), run = randomUUID(), pending = randomUUID(), competing = randomUUID(), priorTask = randomUUID();
  db.prepare('UPDATE agents SET active_session_id=?, active_session_contract_hash=? WHERE id=?').run(session, contractHash, agent.id);
  db.prepare(`INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,provider_session_id,heartbeat_at,created_at,updated_at,terminal_at,scope_key)
    VALUES(?,?,?,'completed','fixture',?,1,'injected',?,?,?,?,?,?)`).run(run,agent.projectId,agent.id,now,session,now,now,now,now,scope);
  db.prepare(`INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at)
    VALUES(?,?,'turn',1,'acknowledged','hash','[]',?,?)`).run(randomUUID(),run,now,now);
  db.prepare(`INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at)
    VALUES(?,?,?,?, 'old input','hash',?,?,?)`).run(run,run,agent.id,agent.projectId,JSON.stringify({schemaVersion:3,normalRuntimeContract:{contractHash,engineId:'codex',model:'old',effort:'medium'}}),now,now);
  const insert = db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
    VALUES(?,?,?,'human_message',?,'next_run','human','pending',?,'{}',?,?,?,?)`);
  for (const [id, priority] of [[pending,20],[competing,1000],[priorTask,10]]) insert.run(id,agent.projectId,agent.id,priority,id,now,now,now,scope);
  db.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(priorTask);
  db.prepare("INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at,consumed_at) VALUES(?,?,?,?)").run(run,priorTask,now,now);
  db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'request','prior-task-request')").run(priorTask);
  const event={schemaVersion:2,eventId:randomUUID(),projectId:agent.projectId,conversationId:agent.conversationId,
    sender:{kind:'user',userId:'operator'},intent:'user_dm',audience:{kind:'user_agent',userId:'operator',agentId:agent.id},text:'Original objective',createdAt:now};
  store.appendCommunicationEvent(event);
  const bound=store.bindContextRolloverBoundary({agentId:agent.id,currentConversationId:agent.conversationId,submittedCommunicationEventIds:[event.eventId]});
  const transition={reason:'settings',activationId:pending,sourceRunId:run,sourceFence:1,oldSessionId:session,oldContractHash:contractHash,engineId:'codex',model:'old',effort:'medium',targetModel:'new',authorizationSignatureHash:'b'.repeat(64),authorizationOriginRunId:run};
  const request={projectId:agent.projectId,agentId:agent.id,oldProviderSessionId:session,providerSessionGeneration:session,
    threshold:150000,lowWaterMark:90000,sourceRunId:run,sourceActivationIds:[priorTask],scopeKey:scope,conversationId:agent.conversationId,
    compactionCutoffOrdinal:bound.canonicalOrdinal,compactionCutoffEventId:bound.communicationEventId,recentTail:bound.recentTail,settingsTransition:transition};
  const coordination=new CoordinationV3Store(db);
  assert.throws(()=>coordination.requestContextRollover({...request,settingsTransition:{...transition,sourceFence:2}}),/source or pending work changed/);
  assert.throws(()=>coordination.requestContextRollover({...request,settingsTransition:{...transition,authorizationOriginRunId:undefined}}),/Invalid exact/);
  for (const mutation of [
    () => db.prepare("UPDATE scheduler_runs SET prompt_injection_state='injecting' WHERE id=?").run(run),
    () => db.prepare("UPDATE agent_activations SET state='attached' WHERE id=?").run(pending),
    () => db.prepare("UPDATE agents SET active_session_contract_hash=? WHERE id=?").run('c'.repeat(64),agent.id),
    () => db.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at) VALUES(?,?,'steer',2,'outcome_unknown','hash','[]',?,?)").run(randomUUID(),run,now,now),
  ]) {
    db.exec('SAVEPOINT transition_negative');
    try { mutation(); assert.throws(() => coordination.requestContextRollover(request), /source or pending work changed/); }
    finally { db.exec('ROLLBACK TO transition_negative; RELEASE transition_negative'); }
  }
  assert.throws(() => coordination.requestContextRollover({...request,settingsTransition:{...transition,targetModel:'old',targetEffort:'medium'}}),/Invalid exact/);
  assert.throws(() => coordination.requestContextRollover({...request,settingsTransition:{...transition,reason:'voice',targetModel:'old',targetEffort:'medium'}}),/canonical queued voice/);
  db.exec('SAVEPOINT canonical_voice');
  try {
    const voiceEvent={eventId:randomUUID(),projectId:agent.projectId,conversationId:agent.conversationId,intent:'user_dm',
      sender:{kind:'user',userId:'local-operator'},audience:{kind:'user_agents',userId:'local-operator',agentIds:[agent.id]}};
    const dispatch={voiceReply:true,activeRunDelivery:'queue',conversationId:agent.conversationId,recipients:[{agentId:agent.id}]};
    const payload={communication:voiceEvent,dispatch};
    db.prepare('UPDATE agent_activations SET payload_json=? WHERE id=?').run(JSON.stringify(payload),pending);
    db.prepare("INSERT INTO runtime_communications(id,project_id,sender_json,intent,audience_json,payload_json,payload_hash,actionable,created_at) VALUES(?,?,?,?,?,?,?,1,?)")
      .run(voiceEvent.eventId,agent.projectId,JSON.stringify(voiceEvent.sender),'user_dm',JSON.stringify(voiceEvent.audience),JSON.stringify(payload),'hash',now);
    db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'communication',?)").run(pending,voiceEvent.eventId);
    for(const mutate of [
      value=>{value.communication.sender.userId='other';},
      value=>{value.communication.audience.agentIds.push('other');},
      value=>{value.dispatch.activeRunDelivery='steer';},
      value=>{value.communication.document={id:'foreign'};},
    ]) {
      db.exec('SAVEPOINT malformed_voice');
      try { const bad=structuredClone(payload);mutate(bad);db.prepare('UPDATE runtime_communications SET payload_json=? WHERE id=?').run(JSON.stringify(bad),voiceEvent.eventId);
        assert.throws(()=>coordination.requestContextRollover({...request,settingsTransition:{...transition,reason:'voice',targetModel:'old',targetEffort:'medium'}}),/canonical queued voice/);
      } finally { db.exec('ROLLBACK TO malformed_voice; RELEASE malformed_voice'); }
    }
    const voice=coordination.requestContextRollover({...request,settingsTransition:{...transition,reason:'voice',targetModel:'old',targetEffort:'medium'}});
    assert.equal(voice.created,true);
  } finally { db.exec('ROLLBACK TO canonical_voice; RELEASE canonical_voice'); }
  const first=coordination.requestContextRollover(request);
  assert.equal(first.created,true);
  assert.equal(coordination.requestContextRollover(request).rollover.id,first.rollover.id);
  assert.equal(db.prepare('SELECT detected_occupancy FROM context_rollovers WHERE id=?').get(first.rollover.id).detected_occupancy,null);
  const handoff=db.prepare(`SELECT a.* FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id WHERE s.source_id=? AND a.kind='context_rollover_handoff'`).get(first.rollover.id);
  const handoffPayload=JSON.parse(handoff.payload_json);
  assert.deepEqual(handoffPayload.settingsTransition,transition);
  assert.deepEqual(handoffPayload.dispatch,{engine:'codex',model:'old',effort:'medium'});
  assert.throws(() => coordination.requestContextRollover({...request,compactionCutoffOrdinal:request.compactionCutoffOrdinal+1}),/replay conflicts/);
  db.prepare('UPDATE context_rollovers SET detected_occupancy=? WHERE id=?').run(160000,first.rollover.id);
  assert.equal(coordination.retireContextRolloverAfterHeadroomRecovery({agentId:agent.id,providerSessionGeneration:session,providerSessionId:session,usedTokens:1}),undefined);
  assert.equal(coordination.retryContextRolloverHandoff(first.rollover.id,'synthetic validation failure').scheduled,true);
  const attempts=db.prepare("SELECT a.payload_json FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id WHERE s.source_id=? AND a.kind='context_rollover_handoff'").all(first.rollover.id);
  assert.equal(attempts.length,2);
  for (const attempt of attempts) assert.deepEqual(JSON.parse(attempt.payload_json).settingsTransition,transition);

  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(pending).state,'pending');
  db.prepare("UPDATE context_rollovers SET state='session_retiring', handoff_event_id='synthetic-handoff' WHERE id=?").run(first.rollover.id);
  const ready=coordination.prepareContextRolloverContinuation({id:first.rollover.id});
  assert.equal(ready.state,'continuation_ready');
  const confirm=db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(ready.continuationActivationId);
  assert.deepEqual(JSON.parse(confirm.payload_json).settingsTransition,transition);
  assert.deepEqual(JSON.parse(confirm.payload_json).sourceActivationIds,[]);
  assert.deepEqual(JSON.parse(confirm.payload_json).dispatch,{engine:'codex',model:'new'});
  assert.equal(db.prepare("SELECT count(*) n FROM activation_sources WHERE activation_id=? AND source_kind='request'").get(ready.continuationActivationId).n,0);
  assert.equal(db.prepare("SELECT state FROM agent_activations WHERE id=?").get(priorTask).state,'consumed');
  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(pending).state,'pending');
  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(competing).state,'pending');
  // Exercise the actual lease selector, including both candidate and coalesced
  // queue selection, with higher priority unrelated work in the same scope.
  db.prepare('INSERT INTO scheduler_agent_fences(agent_id,next_fencing_token) VALUES(?,2)').run(agent.id);
  db.exec('SAVEPOINT priority_barrier');
  try {
    const lease=coordination.leaseNextRun({workerId:'settings-transition-fixture',coalesceLimit:8});
    assert.ok(lease,'the replacement confirmation must be schedulable');
    assert.deepEqual(lease.activationIds,[ready.continuationActivationId]);
    assert.equal(db.prepare('SELECT priority FROM agent_activations WHERE id=?').get(competing).priority,1000);
    for (const id of [pending,competing]) {
      assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(id).state,'pending');
      assert.equal(db.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(id).n,0);
    }
    const submission=db.prepare('SELECT state,activation_ids_json FROM scheduler_prompt_injections WHERE id=?').get(lease.injectionId);
    assert.equal(submission.state,'pending');
    assert.deepEqual(JSON.parse(submission.activation_ids_json),[ready.continuationActivationId]);
    assert.equal(coordination.leaseNextRun({workerId:'second-worker'}),undefined);
    assert.equal(db.prepare('SELECT count(*) n FROM provider_inputs WHERE scheduler_run_id=?').get(lease.runId).n,0);
  } finally { db.exec('ROLLBACK TO priority_barrier; RELEASE priority_barrier'); }
  db.prepare("UPDATE context_rollovers SET state='completed',completion_reason='headroom_restored',terminal_at=? WHERE id=?").run(now,first.rollover.id);
  const second=coordination.requestContextRollover({...request,settingsTransition:{...transition,activationId:competing,targetModel:'other'}});
  assert.equal(second.created,true);
  assert.notEqual(second.rollover.id,first.rollover.id);
  db.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(ready.continuationActivationId);
  // A failed reservation fences only the exact unsubmitted work and is
  // re-evaluated when its observed settings/session fingerprint changes.
  const base={projectId:agent.projectId,agentId:agent.id,activationId:pending}, fingerprint='d'.repeat(64);
  assert.equal(coordination.holdSettingsTransitionReservation({...base,fingerprint}),true);
  assert.equal(coordination.settingsTransitionReservationHeld({...base,fingerprint}),true);
  assert.equal(coordination.settingsTransitionReservationHeld({...base,fingerprint:'e'.repeat(64)}),false);
  assert.equal(coordination.holdSettingsTransitionReservation({...base,fingerprint}),true);
  assert.equal(coordination.failContextRollover(second.rollover.id,'outcome_unknown','synthetic uncertain submission','internal').state,'outcome_unknown');
  const other=store.createAgent(agent.projectId,{title:'Other independent Agent',engine:'codex',conversationId:agent.conversationId});
  const otherId=randomUUID();
  db.prepare("INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key) VALUES(?,?,?,'human_message',50,'next_run','human','pending',?,'{}',?,?,?,?)")
    .run(otherId,agent.projectId,other.id,otherId,now,now,now,`agent:${other.id}`);
  // Reopen to exercise the durable database, not an in-memory hold.
  f.close(store);
  const reopened=f.open('settings-transition'), resumed=new CoordinationV3Store(reopened.sqlite), db2=reopened.sqlite;
  assert.equal(resumed.settingsTransitionReservationHeld({...base,fingerprint}),true);
  assert.equal(resumed.releaseUnstartedFailedSettingsTransition({projectId:agent.projectId,agentId:agent.id,activationId:competing,
    rolloverId:second.rollover.id,targetModel:'changed-again'}),false,'unknown provider outcome cannot be released by changing settings');
  const otherLease=resumed.leaseNextRun({workerId:'independent-agent'});
  assert.deepEqual(otherLease.activationIds,[otherId]);
  assert.equal(db2.prepare('SELECT state FROM agent_activations WHERE id=?').get(pending).state,'pending');
  assert.equal(db2.prepare('SELECT state FROM agent_activations WHERE id=?').get(competing).state,'pending');
  assert.equal(db2.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id IN (?,?)').get(pending,competing).n,0);
  // A changed target may release a known failed transition only if no
  // handoff/replacement Run attached and the original session remains active.
  db2.exec('SAVEPOINT safe_release');
  try {
    db2.prepare("UPDATE context_rollovers SET state='failed' WHERE id=?").run(second.rollover.id);
    assert.equal(resumed.releaseUnstartedFailedSettingsTransition({projectId:agent.projectId,agentId:agent.id,activationId:competing,
      rolloverId:second.rollover.id,targetModel:'changed-again'}),false,'the source session must still be active');
    // Projection rebuild correctly dropped the synthetic session; restore it
    // within this savepoint to model an exact, still-active source session.
    db2.prepare('UPDATE agents SET active_session_id=?,active_session_contract_hash=? WHERE id=?').run(session,contractHash,agent.id);
    assert.equal(resumed.releaseUnstartedFailedSettingsTransition({projectId:agent.projectId,agentId:agent.id,activationId:competing,
      rolloverId:second.rollover.id,targetModel:'other'}),false);
    db2.exec('SAVEPOINT attached_handoff');
    try {
      const handoff2=db2.prepare("SELECT activation_id FROM activation_sources WHERE source_kind='context_rollover' AND source_id=?").get(second.rollover.id).activation_id;
      db2.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(otherLease.runId,handoff2,now);
      assert.equal(resumed.releaseUnstartedFailedSettingsTransition({projectId:agent.projectId,agentId:agent.id,activationId:competing,
        rolloverId:second.rollover.id,targetModel:'changed-again'}),false,'any attached handoff must remain held');
    } finally { db2.exec('ROLLBACK TO attached_handoff; RELEASE attached_handoff'); }
    assert.equal(resumed.releaseUnstartedFailedSettingsTransition({projectId:agent.projectId,agentId:agent.id,activationId:competing,
      rolloverId:second.rollover.id,targetModel:'changed-again'}),true);
    const lease=resumed.leaseNextRun({workerId:'after-safe-change'});
    assert.deepEqual(lease.activationIds,[competing]);
    assert.equal(db2.prepare('SELECT state FROM agent_activations WHERE id=?').get(pending).state,'pending');
  } finally { db2.exec('ROLLBACK TO safe_release; RELEASE safe_release'); }


}));
