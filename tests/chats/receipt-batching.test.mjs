import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CoordinationV3Store } from '../../packages/agents/dist/index.js';
import { openCurrentMemoryDatabase } from '../../packages/agents/dist/state-admission.js';

test('receipt injection batches preserve latest rows, recovery, missing IDs and project scope', t => {
  const db = openCurrentMemoryDatabase(); t.after(() => db.close());
  const project = randomUUID(), chat = randomUUID(), agent = randomUUID(), stamp = '2026-10-19T00:00:00.000Z';
  db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project, 'Owned', '/unused', stamp);
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(chat, project, 'Owned', stamp, stamp);
  db.prepare('INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?)').run(agent, project, chat, 'Owned', 'owned', 'codex', stamp, stamp, '{}');
  db.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,0)').run(agent, chat);
  const run = randomUUID(), scope = 'conversation:' + chat;
  db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'completed','owned',?,1,'injected',?,?,?,?)").run(run, project, agent, stamp, stamp, stamp, stamp, scope);
  const insert = db.prepare('INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  let sequence = 0;
  const inject = (ids, createdAt = stamp, updatedAt = stamp) => {
    const id = randomUUID(); insert.run(id, run, 'steer', sequence++, 'acknowledged', 'owned', JSON.stringify(ids), createdAt, updatedAt, stamp); return id;
  };
  db.transaction(() => { for (let i = 0; i < 1000; i++) inject(['noise-' + i]); })();
  db.prepare('INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('execution-a', run, agent, project, 'owned', 'owned', '[]', stamp, stamp);
  db.prepare('INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('execution-z', run, agent, project, 'owned', 'owned', '[]', stamp, stamp);
  const v3 = new CoordinationV3Store(db), messages = [], activations = [], latest = new Map();
  for (let i = 0; i < 66; i++) {
    const id = randomUUID(), sender = { kind: 'user', userId: 'operator' }, audience = { kind: 'organization', organizationId: project };
    const event = { schemaVersion: 2, eventId: id, projectId: project, conversationId: chat, sender, intent: 'broadcast', audience, text: 'Owned ' + i, createdAt: stamp };
    const created = v3.recordRuntimeCommunication({ id, projectId: project, scopeKey: scope, sender, intent: 'broadcast', audience, payload: { communication: event }, now: stamp,
      activation: { agentId: agent, kind: 'user_message', priority: 100, promptClass: 'human' } });
    messages.push(id); activations.push(created.activationId);
    db.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(created.activationId);
    if (i === 65) continue;
    inject([created.activationId], '2026-10-18T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    inject([created.activationId]); latest.set(created.activationId, inject([created.activationId, created.activationId]));
  }
  // A recovery-only activation has no source communication, so it must be
  // fetched by the second batch rather than confused with its source receipt.
  const original = db.prepare('SELECT * FROM agent_activations WHERE id=?').get(activations[0]);
  original.id = randomUUID(); original.dedupe_key = randomUUID(); original.state = 'attached';
  db.prepare(`INSERT INTO agent_activations(${Object.keys(original).join(',')}) VALUES(${Object.keys(original).map(() => '?').join(',')})`).run(...Object.values(original));
  db.prepare("UPDATE agent_activations SET state='outcome_unknown' WHERE id=?").run(activations[0]);
  db.prepare("INSERT INTO scheduler_steering_recoveries(injection_id,run_id,agent_id,state,recover_at,created_at,updated_at) VALUES(?,?,?,'recovery_queued',?,?,?)").run(latest.get(activations[0]), run, agent, stamp, stamp, stamp);
  db.prepare('INSERT INTO scheduler_steering_recovery_activations VALUES(?,?,?)').run(latest.get(activations[0]), activations[0], original.id);
  inject([original.id]);
  const prepare = db.prepare, selected = new Map(); let scans = 0;
  db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (!/FROM scheduler_prompt_injections injection,\s*json_each\(injection.activation_ids_json\) member/u.test(sql)) return statement;
    scans++; const all = statement.all.bind(statement);
    statement.all = (...args) => all(...args).map(row => { const { activation_id, ...value } = row; selected.set(activation_id, value); return row; });
    return statement;
  };
  let receipts;
  try { receipts = v3.deliveryReceiptsForCommunications(project, messages); } finally { db.prepare = prepare; }
  assert.equal(scans, 2, 'One source batch and one recovery batch, independent of 66 recipients');
  const oracle = db.prepare(`SELECT injection.id,injection.run_id,injection.kind,injection.state,injection.updated_at,injection.acknowledged_at,
    (SELECT operation.state FROM provider_operation_outbox operation WHERE operation.run_id=injection.run_id AND operation.operation='interrupt' AND operation.idempotency_key LIKE 'cancel:%' ORDER BY operation.id DESC LIMIT 1) AS run_stop_operation_state,
    (SELECT provider.execution_id FROM provider_inputs provider WHERE provider.scheduler_run_id=injection.run_id ORDER BY provider.created_at DESC,provider.execution_id DESC LIMIT 1) AS execution_id
    FROM scheduler_prompt_injections injection,json_each(injection.activation_ids_json) member WHERE member.value=? ORDER BY injection.created_at DESC,injection.sequence DESC LIMIT 1`);
  for (const id of [...activations, original.id]) assert.deepEqual(selected.get(id), oracle.get(id));
  assert.equal(receipts.size, 66); assert.equal(receipts.get(messages[0])[0].state, 'recovering');
  assert.equal(receipts.get(messages[0])[0].recoveryExecutionId, 'execution-z');
  assert.equal(receipts.get(messages[65])[0].injectionId, undefined);
  for (const id of messages.slice(1, 65)) assert.equal(receipts.get(id)[0].state, 'processed');
  assert.ok([...v3.deliveryReceiptsForCommunications(randomUUID(), messages).values()].every(value => value.length === 0));
});

test('an exact unresolved Decision accounting hold is visible only on its original human task', t => {
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());
 const project=randomUUID(),chat=randomUUID(),agent=randomUUID(),now=new Date().toISOString(),scope='conversation:'+chat;
 db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project,'Task','/unused',now);
 db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(chat,project,'Task',now,now);
 db.prepare('INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?)').run(agent,project,chat,'Worker','worker','codex',now,now,'{}');
 db.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,0)').run(agent,chat);
 const failed=new CoordinationV3Store(db,{canonicalTaskDecisions:()=>{throw Error('controlled Decision read failure');}});
 const message=text=>{const id=randomUUID(),sender={kind:'user',userId:'local-operator'},audience={kind:'organization',organizationId:project};
  const communication={schemaVersion:2,eventId:id,projectId:project,conversationId:chat,sender,intent:'broadcast',audience,text,createdAt:now};
  const saved=failed.recordRuntimeCommunication({id,projectId:project,scopeKey:scope,sender,intent:'broadcast',audience,payload:{communication},now,
   activation:{agentId:agent,kind:'human_message',priority:100,dispatchPolicy:'next_run',promptClass:'human'}});
  db.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(saved.activationId);return {id,activationId:saved.activationId};};
 const root=message('Complete the original task'),other=message('A different task');
 const run=randomUUID();db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'completed','fixture',?,1,'injected',?,?,?,?)").run(run,project,agent,now,now,now,now,scope);
 db.prepare(`INSERT INTO required_reply_obligations(run_id,source_activation_id,project_id,agent_id,scope_key,reply_authority_json,attempt_count,state,created_at,updated_at,delivery_phase)
 VALUES(?,?,?,?,?,? ,0,'pending',?,?,'final')`).run(run,root.activationId,project,agent,scope,JSON.stringify({intent:'broadcast'}),now,now);
 assert.equal(failed.repairCanonicalTaskDecisionWait(run,now),false,'the real authority records an accounting hold on read failure');
 const held=failed.deliveryReceiptsForCommunication(project,root.id)[0];
 assert.equal(held.taskDecisionRepairHold,true);assert.equal(held.state,'unconfirmed');assert.equal(held.canRetry,undefined);
 db.prepare("UPDATE agent_activations SET state='outcome_unknown' WHERE id=?").run(root.activationId);
 assert.equal(failed.deliveryReceiptsForCommunication(project,root.id)[0].canRetry,undefined,'the hold cannot offer blind replay');
 const count=db.prepare('SELECT count(*) n FROM agent_activations').get().n;
 const stale=failed.retryMessageDelivery({projectId:project,activationId:root.activationId,idempotencyKey:'stale-before-hold'});
 assert.equal(stale.accepted,false);assert.equal(stale.rejectionReason,'not_terminal');
 assert.equal(db.prepare('SELECT count(*) n FROM agent_activations').get().n,count,'a stale retry cannot create work');

 db.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(root.activationId);
 const newer=randomUUID();db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'running','fixture',?,2,'injected',?,?,?,?)").run(newer,project,agent,now,now,now,now,scope);
 db.prepare(`INSERT INTO required_reply_obligations(run_id,source_activation_id,project_id,agent_id,scope_key,reply_authority_json,attempt_count,state,created_at,updated_at,delivery_phase) VALUES(?,?,?,?,?,?,0,'pending',?,?,'final')`).run(newer,root.activationId,project,agent,scope,JSON.stringify({intent:'broadcast'}),now,now);
 assert.equal(failed.deliveryReceiptsForCommunication(project,root.id)[0].taskDecisionRepairHold,undefined,'an older marker cannot override a newer task owner');
 db.prepare('DELETE FROM required_reply_obligations WHERE run_id=?').run(newer);db.prepare('DELETE FROM scheduler_runs WHERE id=?').run(newer);

 assert.equal(failed.deliveryReceiptsForCommunication(project,other.id)[0].taskDecisionRepairHold,undefined);
 assert.deepEqual(failed.deliveryReceiptsForCommunication(randomUUID(),root.id),[]);
 const restored=new CoordinationV3Store(db,{canonicalTaskDecisions:()=>[]});
 assert.equal(restored.repairCanonicalTaskDecisionWait(run,now),true);
 assert.equal(restored.deliveryReceiptsForCommunication(project,root.id)[0].taskDecisionRepairHold,undefined,'the receipt clears when canonical repair succeeds');
 db.prepare("UPDATE required_reply_obligations SET blocking_decision_id='real-pending-decision' WHERE run_id=? AND source_activation_id=?").run(run,root.activationId);
 assert.equal(restored.deliveryReceiptsForCommunication(project,root.id)[0].taskDecisionRepairHold,undefined,'a normal Decision wait alone is not a repair failure');
});

test('settings handoff receipt retries only provably unstarted original delivery', t => {
  const db=openCurrentMemoryDatabase();t.after(()=>db.close());
  const project=randomUUID(),chat=randomUUID(),agent=randomUUID(),now=new Date().toISOString(),scope='conversation:'+chat;
  db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project,'Task','/unused',now);
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(chat,project,'Task',now,now);
  db.prepare('INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,active_session_id,active_session_contract_hash,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(agent,project,chat,'Worker','worker','codex','old-session','a'.repeat(64),now,now,'{}');
  db.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,0)').run(agent,chat);
  const v3=new CoordinationV3Store(db);
  const message=text=>{
    const id=randomUUID(),sender={kind:'user',userId:'local-operator'},audience={kind:'organization',organizationId:project};
    const communication={schemaVersion:2,eventId:id,projectId:project,conversationId:chat,sender,intent:'broadcast',audience,text,createdAt:now};
    const saved=v3.recordRuntimeCommunication({id,projectId:project,scopeKey:scope,sender,intent:'broadcast',audience,
      payload:{communication,dispatch:{model:'chosen-model',effort:'high'}},now,
      activation:{agentId:agent,kind:'human_message',priority:100,dispatchPolicy:'next_run',promptClass:'human'}});
    return {id,activationId:saved.activationId};
  };
  const first=message('Original instructions and attachments');
  const original=db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(first.activationId).payload_json;
  const before=db.prepare('SELECT source_kind,source_id FROM activation_sources WHERE activation_id=? ORDER BY source_kind,source_id').all(first.activationId);
  assert.equal(v3.holdSettingsTransitionReservation({projectId:project,agentId:agent,activationId:first.activationId,fingerprint:'b'.repeat(64)}),true);
  db.exec('SAVEPOINT nonoperator');
  try {
    db.prepare("UPDATE runtime_communications SET sender_json=? WHERE id=?").run(JSON.stringify({kind:'agent',agentId:agent}),first.id);
    const peerReceipt=v3.deliveryReceiptsForCommunication(project,first.id)[0];
    if (peerReceipt) { assert.equal(peerReceipt.settingsTransitionHold,'review_required');assert.equal(peerReceipt.canRetry,undefined); }
    assert.equal(v3.retryMessageDelivery({projectId:project,activationId:first.activationId,idempotencyKey:'nonoperator'}).accepted,false);
  } finally { db.exec('ROLLBACK TO nonoperator; RELEASE nonoperator'); }
  let receipt=v3.deliveryReceiptsForCommunication(project,first.id)[0];
  assert.equal(receipt.settingsTransitionHold,'retry_available'); assert.equal(receipt.canRetry,true);assert.equal(receipt.retryMayDuplicate,undefined);
  const attempt={projectId:project,activationId:first.activationId,idempotencyKey:'first-explicit-retry'};
  const done=v3.retryMessageDelivery(attempt);assert.equal(done.accepted,true);assert.equal(done.activationId,first.activationId);
  assert.equal(v3.retryMessageDelivery(attempt).replayed,true);
  assert.equal(db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(first.activationId).payload_json,original);
  assert.deepEqual(db.prepare('SELECT source_kind,source_id FROM activation_sources WHERE activation_id=? ORDER BY source_kind,source_id').all(first.activationId),before);
  assert.equal(db.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(first.activationId).n,0);
  assert.equal(v3.deliveryReceiptsForCommunication(project,first.id)[0].settingsTransitionHold,undefined);

  const second=message('Preserve the second exact task'),rollover=randomUUID(),handoff=randomUUID();
  db.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
    threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,source_run_id,source_activation_ids_json,scope_key,created_at,updated_at,terminal_at)
    VALUES(?,?,?,'failed','old-session','old-session',100,50,1,'synthetic-event','[]','[]','old-run','[]',?,?,?,?)`).run(rollover,project,agent,scope,now,now,now);
  const payload={rolloverId:rollover,settingsTransition:{activationId:second.activationId,oldSessionId:'old-session',oldContractHash:'a'.repeat(64),targetModel:'new'}};
  db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
    VALUES(?,?,?,'context_rollover_handoff',100,'next_run','blocker','cancelled',?,?,?,?,?,?)`)
    .run(handoff,project,agent,handoff,JSON.stringify(payload),now,now,now,scope);
  db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'context_rollover',?)").run(handoff,rollover);
  const secondPayload=db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(second.activationId).payload_json;
  receipt=v3.deliveryReceiptsForCommunication(project,second.id)[0];
  assert.equal(receipt.settingsTransitionHold,'retry_available');assert.equal(receipt.canRetry,true);
  // An older receipt cannot override a later unknown outcome.
  db.prepare("UPDATE context_rollovers SET state='outcome_unknown' WHERE id=?").run(rollover);
  receipt=v3.deliveryReceiptsForCommunication(project,second.id)[0];
  assert.equal(receipt.settingsTransitionHold,'review_required');assert.equal(receipt.canRetry,undefined);
  assert.equal(v3.retryMessageDelivery({projectId:project,activationId:second.activationId,idempotencyKey:'stale-unknown'}).accepted,false);
  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(handoff).state,'cancelled');
  // Even a failure status is insufficient if a handoff Run was ever attached.
  db.prepare("UPDATE context_rollovers SET state='failed' WHERE id=?").run(rollover);
  const run=randomUUID();
  db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'failed','fixture',?,1,'not_injected',?,?,?,?)")
    .run(run,project,agent,now,now,now,now,scope);
  db.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(run,handoff,now);
  assert.equal(v3.deliveryReceiptsForCommunication(project,second.id)[0].settingsTransitionHold,'review_required');
  assert.equal(v3.retryMessageDelivery({projectId:project,activationId:second.activationId,idempotencyKey:'stale-attached'}).accepted,false);
  db.prepare('DELETE FROM scheduler_run_activations WHERE run_id=? AND activation_id=?').run(run,handoff);
  assert.equal(v3.deliveryReceiptsForCommunication(project,second.id)[0].settingsTransitionHold,'retry_available');
  const secondAttempt={projectId:project,activationId:second.activationId,idempotencyKey:'second-explicit-retry'};
  const retried=v3.retryMessageDelivery(secondAttempt);
  assert.equal(retried.accepted,true);assert.equal(retried.activationId,second.activationId);
  assert.equal(db.prepare('SELECT state FROM context_rollovers WHERE id=?').get(rollover).state,'requested');
  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(handoff).state,'pending');
  assert.equal(db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(second.activationId).payload_json,secondPayload);
  assert.equal(db.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(second.activationId).n,0);
  assert.equal(v3.retryMessageDelivery(secondAttempt).replayed,true);
});
