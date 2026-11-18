import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentStore, CoordinationV3Store } from '../../packages/agents/dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openCurrentMemoryDatabase } from '../../packages/agents/dist/state-admission.js';

test('queue deletion proof survives restart and outbox pruning, preserving races and other recipients', t => {
 const dir=mkdtempSync(path.join(tmpdir(),'queue-delete-'));
 let store=new AgentStore(dir),db=store.sqlite,v3=new CoordinationV3Store(db);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Queue deletion',hostPath:dir,defaultEngine:'codex'}).id;
 const chat=store.createConversation(project,{title:'Owned'}).id;
 const agents=[0,1].map(i=>store.createAgent(project,{title:'Owned '+i,engine:'codex',conversationId:chat}).id),now=new Date().toISOString(),scope='conversation:'+chat;
 const create=(targets=agents.slice(0,1),kind='human_message',policy='next_run',intent='user_dm')=>{const id=randomUUID(),sender={kind:'user',userId:'local-operator'},audience=intent==='broadcast'?{kind:'organization',organizationId:project}:{kind:'user_agents',userId:'local-operator',agentIds:targets};
  const communication={schemaVersion:2,eventId:id,projectId:project,conversationId:chat,sender,intent,audience,text:'Queued exact input',createdAt:now};
  const result=v3.recordRuntimeCommunication({id,projectId:project,sender,intent,audience,payload:{communication,dispatch:{conversationId:chat,text:communication.text,recipients:targets.map(agentId=>({agentId,attachments:[]}))}},activations:targets.map(agentId=>({agentId,kind,priority:100,dispatchPolicy:policy,promptClass:'human'})),now});
  return {id,ids:result.activations.map(value=>value.id)};};
 const read=message=>v3.deliveryReceiptsForCommunications(project,[message.id]).get(message.id);
 const cancel=id=>v3.cancelPendingActivation({activationId:id,projectId:project,idempotencyKey:'delete:'+id,now});
 const removed=create();assert.equal(read(removed)[0].queuedForNextRun,true);assert.equal(cancel(removed.ids[0]).cancelled,true);assert.equal(cancel(removed.ids[0]).replayed,true);assert.equal(read(removed)[0].queueDeletionConfirmed,true);
 db.prepare("DELETE FROM activation_outbox WHERE event_kind='queued_message_change'").run();store.close();store=new AgentStore(dir);db=store.sqlite;v3=new CoordinationV3Store(db);
 assert.equal(read(removed)[0].queueDeletionConfirmed,true,'Historical deletion derives from durable command evidence, not an outbox or browser');
 const partial=create(agents);cancel(partial.ids[0]);assert.ok(read(partial).every(value=>!value.queueDeletionConfirmed),'Another pending recipient is retained');
 cancel(partial.ids[1]);assert.ok(read(partial).every(value=>value.queueDeletionConfirmed),'All exact recipients must be deleted');
 const broadcast=create(agents,'human_message','next_run','broadcast');cancel(broadcast.ids[0]);assert.ok(read(broadcast).every(r=>!r.queueDeletionConfirmed));cancel(broadcast.ids[1]);assert.ok(read(broadcast).every(r=>r.queueDeletionConfirmed),'Broadcast uses exact dispatch recipients');
 for(const result of ['{bad json',JSON.stringify({cancelled:true,status:'delivery_started'}),JSON.stringify({cancelled:1,status:'cancelled'})]){const invalid=create();cancel(invalid.ids[0]);db.prepare("UPDATE coordination_idempotency SET result_json=? WHERE operation='cancel_activation' AND idempotency_key=?").run(result,'delete:'+invalid.ids[0]);assert.equal(read(invalid)[0].queueDeletionConfirmed,undefined,'Invalid result cannot prove deletion');}
 const unrelated=create();db.prepare("UPDATE agent_activations SET state='cancelled' WHERE id=?").run(unrelated.ids[0]);assert.equal(read(unrelated)[0].queueDeletionConfirmed,undefined,'An unrelated cancellation is not deletion');
 const immediate=create(agents.slice(0,1),'human_message','steer_or_run');cancel(immediate.ids[0]);assert.equal(read(immediate)[0].queueDeletionConfirmed,undefined,'Ordinary delivery cancellation remains visible');
 const raced=create();db.prepare("UPDATE agent_activations SET state='attached' WHERE id=?").run(raced.ids[0]);assert.equal(cancel(raced.ids[0]).status,'delivery_started');assert.equal(read(raced)[0].queueDeletionConfirmed,undefined);
 const submitted=create();const run=randomUUID();db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'completed','owned',?,1,'injected',?,?,?,?)").run(run,project,agents[0],now,now,now,now,scope);
 db.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,submitted_at) VALUES(?,?,'turn',0,'cancelled','owned',?,?,?,?)").run(randomUUID(),run,JSON.stringify(submitted.ids),now,now,now);cancel(submitted.ids[0]);assert.equal(read(submitted)[0].queueDeletionConfirmed,undefined,'Cancelled injection retains earlier possible effects');
 db.prepare("UPDATE scheduler_prompt_injections SET submitted_at=NULL,provider_turn_id='retained-provider-turn' WHERE run_id=?").run(run);
 assert.equal(read(submitted)[0].queueDeletionConfirmed,undefined,'A retained provider turn remains possible delivery evidence even without submission clocks');
 const retried=create(),old=db.prepare('SELECT * FROM agent_activations WHERE id=?').get(retried.ids[0]);db.prepare("UPDATE agent_activations SET state='consumed' WHERE id=?").run(old.id);
 const next={...old,id:randomUUID(),dedupe_key:randomUUID(),state:'pending'};db.prepare(`INSERT INTO agent_activations(${Object.keys(next).join(',')}) VALUES(${Object.keys(next).map(()=>'?').join(',')})`).run(...Object.values(next));
 db.prepare('INSERT INTO activation_sources(activation_id,source_kind,source_id) SELECT ?,source_kind,source_id FROM activation_sources WHERE activation_id=?').run(next.id,old.id);cancel(next.id);assert.equal(read(retried)[0].queueDeletionConfirmed,undefined,'Older consumed recipient attempt remains visible behind a newer queue cancellation');
 const missing=create(agents);db.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='communication'").run(missing.ids[1]);cancel(missing.ids[0]);assert.equal(read(missing)[0].queueDeletionConfirmed,undefined,'Incomplete recipient evidence cannot hide a message');
 assert.deepEqual(v3.deliveryReceiptsForCommunications(randomUUID(),[removed.id]).get(removed.id),[],'Project authority remains exact');
});

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

test('held peer Request reuses only a known-unstarted handoff', t => {
  const db=openCurrentMemoryDatabase();t.after(()=>db.close());
  const project=randomUUID(),chat=randomUUID(),manager=randomUUID(),worker=randomUUID(),stamp=new Date().toISOString(),scope='conversation:'+chat;
  db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project,'Project','/unused',stamp);
  db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(chat,project,'Chat',stamp,stamp);
  for(const [id,handle] of [[manager,'manager'],[worker,'worker']]){
    db.prepare('INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,project,chat,handle,handle,'codex',stamp,stamp,'{}');
    db.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,0)').run(id,chat);
  }
  const v3=new CoordinationV3Store(db),requestId=randomUUID(),payload={text:'Exact peer assignment',refs:['owned-ref']};
  v3.coordinate({projectId:project,conversationId:chat,requesterAgentId:manager,actorScope:'user:local-operator',idempotencyKey:randomUUID(),
    requests:[{requestId,recipientAgentId:worker,lifetime:{kind:'indefinite'},payload}]});
  const activation=db.prepare(`SELECT a.id,a.payload_json FROM agent_activations a JOIN activation_sources s
    ON s.activation_id=a.id AND s.source_kind='request' WHERE s.source_id=?`).get(requestId);
  const peerNow=new Date(Date.now()+1000).toISOString();
  const peerLease=v3.leaseNextRun({workerId:'old-peer-attempt',now:peerNow});
  assert.ok(peerLease);assert.deepEqual(peerLease.activationIds,[activation.id]);
  assert.equal(v3.recoverOrphanedRuns('new-peer-owner',peerNow).retried,1);
  assert.equal(v3.canRetryUninjectedRun(peerLease.runId),true);
  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(activation.id).state,'retry_pending');
  const oldPeerAttachment=db.prepare('SELECT * FROM scheduler_run_activations WHERE run_id=? AND activation_id=?').get(peerLease.runId,activation.id);
  const rollover=randomUUID(),handoff=randomUUID(),hash='a'.repeat(64);
  db.prepare('UPDATE agents SET active_session_id=?,active_session_contract_hash=? WHERE id=?').run('old-session',hash,worker);
  db.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
    threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,
    source_run_id,source_activation_ids_json,scope_key,created_at,updated_at,terminal_at)
    VALUES(?,?,?,'failed','old-session','old-session',100,50,1,'event','[]','[]','old-run','[]',?,?,?,?)`)
    .run(rollover,project,worker,scope,stamp,stamp,stamp);
  const marker={rolloverId:rollover,settingsTransition:{activationId:activation.id,oldSessionId:'old-session',oldContractHash:hash}};
  db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
    VALUES(?,?,?,'context_rollover_handoff',100,'next_run','blocker','cancelled',?,?,?,?,?,?)`)
    .run(handoff,project,worker,handoff,JSON.stringify(marker),stamp,stamp,stamp,scope);
  db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'context_rollover',?)").run(handoff,rollover);
  assert.equal(v3.settingsTransitionRequestHold({projectId:project,requestId}).retryable,true);
  db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'task_reply_repair_wait','unresolved-accounting')").run(activation.id);
  assert.equal(v3.settingsTransitionRequestHold({projectId:project,requestId}).retryable,false);
  assert.equal(v3.retryHeldSettingsTransitionRequest({projectId:project,requestId,idempotencyKey:'other-hold'}).accepted,false);
  db.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='task_reply_repair_wait'").run(activation.id);
  db.prepare("UPDATE context_rollovers SET state='outcome_unknown' WHERE id=?").run(rollover);
  assert.equal(v3.settingsTransitionRequestHold({projectId:project,requestId}).retryable,false);
  assert.equal(v3.retryHeldSettingsTransitionRequest({projectId:project,requestId,idempotencyKey:'unknown'}).accepted,false);
  db.prepare("UPDATE context_rollovers SET state='failed' WHERE id=?").run(rollover);
  const run=randomUUID();
  db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'failed','test',?,99,'not_injected',?,?,?,?)")
    .run(run,project,worker,stamp,stamp,stamp,stamp,scope);
  db.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(run,handoff,stamp);
  assert.equal(v3.settingsTransitionRequestHold({projectId:project,requestId}).retryable,false);
  assert.equal(v3.retryHeldSettingsTransitionRequest({projectId:project,requestId,idempotencyKey:'attached'}).accepted,false);
  db.prepare('DELETE FROM scheduler_run_activations WHERE run_id=? AND activation_id=?').run(run,handoff);
  const command={projectId:project,requestId,idempotencyKey:'one-attempt'};
  const result=v3.retryHeldSettingsTransitionRequest(command);
  assert.equal(result.accepted,true);assert.equal(result.activationId,activation.id);
  assert.equal(v3.retryHeldSettingsTransitionRequest(command).replayed,true);
  assert.equal(db.prepare('SELECT state FROM context_rollovers WHERE id=?').get(rollover).state,'requested');
  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(handoff).state,'pending');
  assert.equal(db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(activation.id).payload_json,activation.payload_json);
  assert.deepEqual(v3.getRequest(requestId).payload,payload);
  assert.equal(db.prepare('SELECT count(*) n FROM coordination_requests WHERE project_id=?').get(project).n,1);
  assert.deepEqual(db.prepare('SELECT * FROM scheduler_run_activations WHERE run_id=? AND activation_id=?').get(peerLease.runId,activation.id),oldPeerAttachment);
  assert.equal(db.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(activation.id).n,1);
});

test('settings transitions keep retry-pending work only after every old Run is proved unsubmitted', t => {
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());
 const project=randomUUID(),chat=randomUUID(),agent=randomUUID(),now=new Date().toISOString(),scope='conversation:'+chat;
 db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project,'Task','/unused',now);
 db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(chat,project,'Task',now,now);
 db.prepare('INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,active_session_id,active_session_contract_hash,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
   .run(agent,project,chat,'Worker','worker','codex','old-session','a'.repeat(64),now,now,'{}');
 db.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,0)').run(agent,chat);
 const v3=new CoordinationV3Store(db),sourceRun=randomUUID();
 db.prepare(`INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,provider_session_id,heartbeat_at,created_at,updated_at,terminal_at,scope_key)
   VALUES(?,?,?,'completed','old',?,1,'injected','old-session',?,?,?,?,?)`).run(sourceRun,project,agent,now,now,now,now,now,scope);
 db.prepare(`INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at)
   VALUES(?,?,'turn',0,'acknowledged','hash','[]',?,?)`).run(randomUUID(),sourceRun,now,now);
 db.prepare(`INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at)
   VALUES(?,?,?,?, 'old input','hash',?,?,?)`).run(sourceRun,sourceRun,agent,project,
   JSON.stringify({schemaVersion:3,normalRuntimeContract:{contractHash:'a'.repeat(64),engineId:'codex',model:'old',effort:'medium'}}),now,now);
 db.prepare('INSERT INTO scheduler_agent_fences(agent_id,next_fencing_token) VALUES(?,2)').run(agent);
 const eventId=randomUUID(),sender={kind:'user',userId:'local-operator'},audience={kind:'user_agents',userId:'local-operator',agentIds:[agent]};
 const communication={schemaVersion:2,eventId,projectId:project,conversationId:chat,sender,intent:'user_dm',audience,text:'Keep the exact queued objective',createdAt:now};
 const saved=v3.recordRuntimeCommunication({id:eventId,projectId:project,scopeKey:scope,sender,intent:'user_dm',audience,
   payload:{communication,dispatch:{conversationId:chat,model:'new',effort:'high'}},now,
   activation:{agentId:agent,kind:'human_message',priority:100,dispatchPolicy:'next_run',promptClass:'human'}});
 const activationId=saved.activationId,original=db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(activationId).payload_json;
 const runs=[];
 for(let i=0;i<2;i++){
   const lease=v3.leaseNextRun({workerId:'old-worker-'+i,now});assert.deepEqual(lease.activationIds,[activationId]);runs.push(lease.runId);
   const recovered=v3.recoverOrphanedRuns('new-worker-'+i,now);assert.equal(recovered.retried,1);
   assert.equal(v3.canRetryUninjectedRun(lease.runId),true);
   assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(activationId).state,'retry_pending');
 }
 const prior=()=>db.prepare('SELECT run_id,activation_id,attached_at,consumed_at FROM scheduler_run_activations WHERE activation_id=? ORDER BY run_id').all(activationId);
 const attachments=prior();assert.equal(attachments.length,2);
 const transition={reason:'settings',activationId,sourceRunId:sourceRun,sourceFence:1,oldSessionId:'old-session',oldContractHash:'a'.repeat(64),
   engineId:'codex',model:'old',effort:'medium',targetModel:'new',targetEffort:'high'};
 const request={projectId:project,agentId:agent,oldProviderSessionId:'old-session',providerSessionGeneration:'old-session',threshold:150000,lowWaterMark:90000,
   sourceRunId:sourceRun,sourceActivationIds:[],scopeKey:scope,conversationId:chat,compactionCutoffOrdinal:1,compactionCutoffEventId:eventId,
   recentTail:[{communicationEventId:eventId,contentSha256:'b'.repeat(64)}],settingsTransition:transition};
 const hold={projectId:project,agentId:agent,activationId,fingerprint:'c'.repeat(64)};
 const eligibility={projectId:project,agentId:agent,activationId,scopeKey:scope};
 assert.equal(v3.settingsTransitionUnsubmittedActivation(eligibility),true);
 assert.equal(v3.settingsTransitionUnsubmittedActivation({...eligibility,scopeKey:'agent:foreign'}),false);
 assert.equal(v3.holdSettingsTransitionReservation(hold),true);
 let receipt=v3.deliveryReceiptsForCommunication(project,eventId)[0];
 assert.equal(receipt.settingsTransitionHold,'retry_available');assert.equal(receipt.canRetry,true);
 const reject=[
   ()=>db.prepare("UPDATE scheduler_runs SET status='running' WHERE id=?").run(runs[0]),
   ()=>db.prepare("UPDATE scheduler_runs SET terminal_at=NULL WHERE id=?").run(runs[0]),
   ()=>db.prepare("UPDATE scheduler_runs SET status='outcome_unknown' WHERE id=?").run(runs[0]),
   ()=>db.prepare("UPDATE scheduler_runs SET prompt_injection_state='injecting' WHERE id=?").run(runs[0]),
   ()=>db.prepare("UPDATE scheduler_runs SET started_at=? WHERE id=?").run(now,runs[0]),
   ()=>db.prepare("UPDATE scheduler_runs SET scope_key='agent:foreign' WHERE id=?").run(runs[0]),
   ()=>db.prepare("UPDATE scheduler_run_activations SET consumed_at=? WHERE run_id=? AND activation_id=?").run(now,runs[0],activationId),
   ()=>db.prepare("UPDATE scheduler_prompt_injections SET state='submitted' WHERE run_id=?").run(runs[0]),
   ()=>db.prepare("UPDATE scheduler_prompt_injections SET submitted_at=? WHERE run_id=?").run(now,runs[0]),
   ()=>db.prepare("UPDATE scheduler_prompt_injections SET provider_turn_id='contradictory' WHERE run_id=?").run(runs[0]),
   ()=>db.prepare("INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
     .run(randomUUID(),runs[0],agent,project,'unknown input','hash','{}',now,now),
   ()=>db.prepare("INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
     .run(runs[0],randomUUID(),agent,project,'unknown input','hash','{}',now,now),
 ];
 // A safely deferred prompt-change lease returns to pending, while retaining
 // its cancelled attempt. The same complete evidence must hold for that state.
 for(const change of reject) {
   db.exec('SAVEPOINT pending_deferred_attempt');
   try {
     db.prepare("UPDATE agent_activations SET state='pending' WHERE id=?").run(activationId);
     assert.equal(v3.settingsTransitionUnsubmittedActivation(eligibility),true);
     change();
     assert.equal(v3.settingsTransitionUnsubmittedActivation(eligibility),false,'pending deferred work with contradictory evidence stays held');
     assert.equal(v3.holdSettingsTransitionReservation(hold),false);
   } finally {db.exec('ROLLBACK TO pending_deferred_attempt; RELEASE pending_deferred_attempt');}
 }
 for(const change of reject) {
   db.exec('SAVEPOINT ambiguous_prior_attempt');
   try {
     change();
     assert.equal(v3.settingsTransitionUnsubmittedActivation(eligibility),false);
     assert.equal(v3.holdSettingsTransitionReservation(hold),false);
     assert.equal(v3.settingsTransitionReservationHeld({...hold,fingerprint:'d'.repeat(64)}),true,'changed fingerprint cannot clear an uncertain hold');
     const uncertain=v3.deliveryReceiptsForCommunication(project,eventId)[0];
     assert.equal(uncertain.settingsTransitionHold,'review_required');assert.equal(uncertain.canRetry,undefined);
     assert.equal(v3.retryMessageDelivery({projectId:project,activationId,idempotencyKey:randomUUID()}).accepted,false);
     assert.throws(()=>v3.requestContextRollover(request),/source or pending work changed/);
   } finally {db.exec('ROLLBACK TO ambiguous_prior_attempt; RELEASE ambiguous_prior_attempt');}
 }
 assert.deepEqual(prior(),attachments);
 const command={projectId:project,activationId,idempotencyKey:'same-original-retry'};
 assert.equal(v3.retryMessageDelivery(command).activationId,activationId);
 assert.equal(v3.retryMessageDelivery(command).replayed,true);
 assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(activationId).state,'retry_pending');
 assert.equal(db.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(activationId).payload_json,original);
 assert.deepEqual(prior(),attachments);
 const rollover=v3.requestContextRollover(request);assert.equal(rollover.created,true);
 assert.deepEqual(prior(),attachments,'handoff reservation must retain every old Run attachment');
 assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(activationId).state,'retry_pending');
});

test('uncertain retry-pending hold survives database reopen without blocking another Agent', t => {
 const root=mkdtempSync(path.join(tmpdir(),'ponderosa-transition-hold-'));
 let store=new AgentStore(root);
 t.after(()=>{if(store)store.close();rmSync(root,{recursive:true,force:true});});
 const project=store.createProject({label:'Transition hold',hostPath:root,defaultEngine:'codex'});
 const chat=store.createConversation(project.id,{title:'Chat'});
 const worker=store.createAgent(project.id,{title:'Held worker',engine:'codex',conversationId:chat.id});
 const other=store.createAgent(project.id,{title:'Other worker',engine:'codex',conversationId:chat.id});
 let db=store.sqlite,v3=new CoordinationV3Store(db),now=new Date().toISOString();
 const send=(agent,text)=>{
   const id=randomUUID(),sender={kind:'user',userId:'local-operator'},audience={kind:'user_agents',userId:'local-operator',agentIds:[agent.id]};
   const communication={schemaVersion:2,eventId:id,projectId:project.id,conversationId:chat.id,sender,intent:'user_dm',audience,text,createdAt:now};
   const saved=v3.recordRuntimeCommunication({id,projectId:project.id,scopeKey:'conversation:'+chat.id,sender,intent:'user_dm',audience,payload:{communication},now,
     activation:{agentId:agent.id,kind:'human_message',priority:100,dispatchPolicy:'next_run',promptClass:'human'}});
   return {id,activationId:saved.activationId};
 };
 const held=send(worker,'Preserve the unresolved original work');
 const old=v3.leaseNextRun({workerId:'crashed-worker',now});assert.deepEqual(old.activationIds,[held.activationId]);
 assert.equal(v3.recoverOrphanedRuns('new-owner',now).retried,1);
 assert.equal(v3.canRetryUninjectedRun(old.runId),true);
 db.prepare("UPDATE scheduler_prompt_injections SET state='outcome_unknown' WHERE id=?").run(old.injectionId);
 const input={projectId:project.id,agentId:worker.id,activationId:held.activationId,scopeKey:'conversation:'+chat.id,fingerprint:'a'.repeat(64)};
 assert.equal(v3.settingsTransitionUnsubmittedActivation(input),false);
 assert.equal(v3.holdSettingsTransitionReservation(input),false);
 assert.equal(v3.holdUncertainSettingsTransitionReservation({...input,scopeKey:'agent:wrong'}),false);
 assert.equal(v3.holdUncertainSettingsTransitionReservation(input),true);
 assert.equal(v3.deliveryReceiptsForCommunication(project.id,held.id)[0].settingsTransitionHold,'review_required');
 const prior=db.prepare('SELECT run_id,activation_id,attached_at,consumed_at FROM scheduler_run_activations WHERE activation_id=?').all(held.activationId);
 store.close();store=new AgentStore(root);db=store.sqlite;v3=new CoordinationV3Store(db);
 assert.equal(v3.settingsTransitionReservationHeld({...input,fingerprint:'b'.repeat(64)}),true,'a settings change cannot clear uncertain evidence');
 const receipt=v3.deliveryReceiptsForCommunication(project.id,held.id)[0];
 assert.equal(receipt.settingsTransitionHold,'review_required');assert.equal(receipt.canRetry,undefined);
 assert.equal(v3.retryMessageDelivery({projectId:project.id,activationId:held.activationId,idempotencyKey:'do-not-replay'}).accepted,false);
 assert.deepEqual(db.prepare('SELECT run_id,activation_id,attached_at,consumed_at FROM scheduler_run_activations WHERE activation_id=?').all(held.activationId),prior);
 assert.equal(db.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(old.injectionId).state,'outcome_unknown');
 now=new Date().toISOString();
 const independent=send(other,'Other Agent work can continue');
 const next=v3.leaseNextRun({workerId:'independent-worker',now});
 assert.equal(next.agentId,other.id);assert.deepEqual(next.activationIds,[independent.activationId]);
 assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(held.activationId).state,'retry_pending');
 assert.equal(db.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.activationId).n,1);
});

test('verified replacement confirmation drains before queued human or peer work can steer', t => {
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());
 const project=randomUUID(),chat=randomUUID(),worker=randomUUID(),manager=randomUUID(),now=new Date().toISOString(),scope='conversation:'+chat;
 db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project,'Task','/unused',now);
 db.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(chat,project,'Task',now,now);
 for(const [id,name] of [[worker,'worker'],[manager,'manager']]){
  db.prepare('INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id,project,chat,name,name,'codex',now,now,'{}');
  db.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,0)').run(id,chat);
 }
 const v3=new CoordinationV3Store(db),run=randomUUID(),rollover=randomUUID(),confirmation=randomUUID(),handoff=randomUUID();
 db.prepare(`INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,provider_session_id,heartbeat_at,created_at,updated_at,started_at,scope_key)
  VALUES(?,?,?,'running','test',?,1,'injected','new-session',?,?,?,?,?)`).run(run,project,worker,'2999-01-01T00:00:00Z',now,now,now,now,scope);
 db.prepare("INSERT INTO scheduler_agent_fences(agent_id,next_fencing_token) VALUES(?,2)").run(worker);
 db.prepare(`INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,submitted_at,acknowledged_at)
  VALUES(?,?,'turn',0,'acknowledged','hash',?,?,?,?,?)`).run(randomUUID(),run,JSON.stringify([confirmation]),now,now,now,now);
 db.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
  threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,
  source_run_id,source_activation_ids_json,scope_key,continuation_activation_id,replacement_run_id,replacement_verified_at,completion_reason,created_at,updated_at,terminal_at)
  VALUES(?,?,?,'completed','old-session','old-session',100,50,1,'event','[]','[]','old-run','[]',?,?,?,?, 'replacement_verified',?,?,?)`)
  .run(rollover,project,worker,scope,confirmation,run,now,now,now,now);
 const insert=db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
  VALUES(?,?,?,?,?,'next_run','blocker',?,?,?,?,?,?,?)`);
 const marker={rolloverId:rollover,settingsTransition:{activationId:'target',reason:'settings'}};
 insert.run(handoff,project,worker,'context_rollover_handoff',100,'consumed',handoff,JSON.stringify(marker),now,now,now,scope);
 insert.run(confirmation,project,worker,'context_rollover_continuation',110,'attached',confirmation,JSON.stringify(marker),now,now,now,scope);
 db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'context_rollover',?),(?,'context_rollover',?)")
   .run(handoff,rollover,confirmation,rollover);
 db.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(run,confirmation,now);
 const eventId=randomUUID(),sender={kind:'user',userId:'local-operator'},audience={kind:'user_agents',userId:'local-operator',agentIds:[worker]};
 const communication={schemaVersion:2,eventId,projectId:project,conversationId:chat,sender,intent:'user_dm',audience,text:'Original human task',createdAt:now};
 const human=v3.recordRuntimeCommunication({id:eventId,projectId:project,scopeKey:scope,sender,intent:'user_dm',audience,payload:{communication},now,
   activation:{agentId:worker,kind:'human_message',priority:100,dispatchPolicy:'steer_or_run',promptClass:'human'}}).activationId;
 const requestId=randomUUID();
 v3.coordinate({projectId:project,conversationId:chat,requesterAgentId:manager,actorScope:'user:local-operator',idempotencyKey:randomUUID(),
  requests:[{requestId,recipientAgentId:worker,lifetime:{kind:'indefinite'},payload:{text:'Original peer task'}}]},now);
 const peer=db.prepare("SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id=?").get(requestId).activation_id;
 assert.equal(v3.leaseNextSteering({workerId:'too-early',now}),undefined,'neither queued item may enter the confirmation Run');
 for(const id of [human,peer]){
  assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(id).state,'pending');
  assert.equal(db.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(id).n,0);
 }
 v3.completeRun(run,1,now);
 db.exec('SAVEPOINT verified_transition_isolation');
 try {
  db.prepare("UPDATE agent_activations SET payload_json=json_set(payload_json,'$.settingsTransition.activationId',?,'$.settingsTransition.targetSystemPromptHash','test-hash') WHERE id=?").run(human,handoff);
  const secondId=randomUUID(),secondCommunication={...communication,eventId:secondId,text:'Other pending human task'};
  const other=v3.recordRuntimeCommunication({id:secondId,projectId:project,scopeKey:scope,sender,intent:'user_dm',audience,
   payload:{communication:secondCommunication},now,
   activation:{agentId:worker,kind:'human_message',priority:100,dispatchPolicy:'steer_or_run',promptClass:'human'}}).activationId;
  assert.equal(v3.peekNextRunnable({now,excludedAgentIds:[worker]}),undefined,'excluded Agent cannot be selected by the priority fence');
  db.exec('SAVEPOINT verified_task_steering');
  try {
   db.prepare("UPDATE scheduler_runs SET status='running',terminal_at=NULL WHERE id=?").run(run);
   const steer=v3.leaseNextSteering({workerId:'unrelated-running',now});
   assert.ok(!steer || !steer.activationIds.includes(human),'verified-transition task cannot steer into an unrelated Run');
  } finally {db.exec('ROLLBACK TO verified_task_steering; RELEASE verified_task_steering');}
  db.exec('SAVEPOINT original_first');
  try {
   const lease=v3.leaseNextRun({workerId:'marked-first',now});
   assert.deepEqual(lease.activationIds,[human],'the verified-transition task runs alone');
   assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(other).state,'pending');
  } finally {db.exec('ROLLBACK TO original_first; RELEASE original_first');}
  db.exec('SAVEPOINT other_first');
  try {
   db.prepare('UPDATE agent_activations SET priority=101 WHERE id=?').run(other);
   const lease=v3.leaseNextRun({workerId:'other-first',now});
   assert.deepEqual(lease.activationIds,[human],'the marked task precedes even higher-priority same-scope work');
   assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(other).state,'pending');
  } finally {db.exec('ROLLBACK TO other_first; RELEASE other_first');}
 } finally {db.exec('ROLLBACK TO verified_transition_isolation; RELEASE verified_transition_isolation');}
 db.exec('SAVEPOINT human_after_drain');
 try {const lease=v3.leaseNextRun({workerId:'human-after-drain',now});assert.ok(lease.activationIds.includes(human));}
 finally {db.exec('ROLLBACK TO human_after_drain; RELEASE human_after_drain');}
 db.exec('SAVEPOINT peer_after_drain');
 try {
  db.prepare("UPDATE agent_activations SET state='cancelled' WHERE id=?").run(human);
  const lease=v3.leaseNextRun({workerId:'peer-after-drain',now});assert.deepEqual(lease.activationIds,[peer]);
 } finally {db.exec('ROLLBACK TO peer_after_drain; RELEASE peer_after_drain');}
});


test('uncertain settings handoff holds its source reply recovery across reopen without blocking another Agent', t => {
 const root=mkdtempSync(path.join(tmpdir(),'ponderosa-transition-source-hold-'));
 let store=new AgentStore(root);
 t.after(()=>{if(store)store.close();rmSync(root,{recursive:true,force:true});});
 const project=store.createProject({label:'Source hold',hostPath:root,defaultEngine:'codex'});
 const chat=store.createConversation(project.id,{title:'Chat'});
 const worker=store.createAgent(project.id,{title:'Held worker',engine:'codex',conversationId:chat.id});
 const otherChat=store.createConversation(project.id,{title:'Other Chat'});
 const other=store.createAgent(project.id,{title:'Other worker',engine:'codex',conversationId:otherChat.id});
 let db=store.sqlite,v3=new CoordinationV3Store(db);const now=new Date().toISOString(),scope='conversation:'+chat.id;
 const rollover=randomUUID(),handoff=randomUUID(),sourceRun=randomUUID(),recovery=randomUUID();
 db.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
  threshold,low_water_mark,compaction_cutoff_ordinal,recent_tail_event_ids_json,recent_tail_hashes_json,source_run_id,source_activation_ids_json,scope_key,created_at,updated_at)
  VALUES(?,?,?,'outcome_unknown','old','old',100,50,0,'[]','[]',?,'[]',?,?,?)`).run(rollover,project.id,worker.id,sourceRun,scope,now,now);
 const insert=db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
  VALUES(?,?,?,?,?,'next_run','blocker',?,?,?,?,?,?,?)`);
 insert.run(handoff,project.id,worker.id,'context_rollover_handoff',100,'outcome_unknown',handoff,JSON.stringify({rolloverId:rollover,settingsTransition:{activationId:'original'}}),now,now,now,scope);
 const payload=JSON.stringify({requiredReplyRecovery:{sourceRunId:sourceRun,sourceActivationId:'source',attempt:1},instruction:'Continue exact saved reply'});
 insert.run(recovery,project.id,worker.id,'required_reply_recovery',100,'pending',recovery,payload,now,now,now,scope);
 db.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'context_rollover',?)").run(handoff,rollover);
 store.close();store=new AgentStore(root);db=store.sqlite;v3=new CoordinationV3Store(db);
 const retained=db.prepare('SELECT state,payload_json FROM agent_activations WHERE id=?').get(recovery);
 assert.equal(retained.state,'pending');assert.equal(retained.payload_json,payload);
 assert.ok(v3.pendingActivations(project.id).some(item=>item.id===recovery),'held source recovery remains visible');
 assert.equal(v3.peekNextRunnable({now}),undefined,'unknown source recovery cannot be selected');
 const event=randomUUID(),sender={kind:'user',userId:'local-operator'},audience={kind:'user_agents',userId:'local-operator',agentIds:[other.id]};
 const communication={schemaVersion:2,eventId:event,projectId:project.id,conversationId:otherChat.id,sender,intent:'user_dm',audience,text:'Other work',createdAt:now};
 const independent=v3.recordRuntimeCommunication({id:event,projectId:project.id,scopeKey:'conversation:'+otherChat.id,sender,intent:'user_dm',audience,payload:{communication},now,
   activation:{agentId:other.id,kind:'human_message',priority:90,dispatchPolicy:'next_run',promptClass:'human'}}).activationId;
 const lease=v3.leaseNextRun({workerId:'independent',now});
 assert.equal(lease.agentId,other.id);assert.deepEqual(lease.activationIds,[independent]);
 assert.equal(db.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(recovery).n,0);
 assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(recovery).state,'pending');
});

test('unsupported-steer proof is lazy for ordinary receipt rows and retains the old predicate results',async t=>{
 const {transitionUnsubmittedActivationSql}=await import('../../packages/agents/dist/coordination-v3-transition-unsubmitted.js');
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());
 const guarded=transitionUnsubmittedActivationSql('a');
 const legacy=guarded.replace('OR (CASE WHEN','OR (').replace('THEN NOT EXISTS','AND NOT EXISTS').replace('ELSE 0 END))','))');
 // Ordinary rows cannot qualify for unsupported-steer recovery. Instrument the
 // expensive branch itself to prove SQLite never evaluates it for these rows.
 let evaluations=0;db.function('unsupported_probe',()=>{evaluations++;return 1;});
 const instrumented=guarded.replace('THEN NOT EXISTS','THEN unsupported_probe() AND NOT EXISTS');
 const now=new Date().toISOString(),project=randomUUID(),agent=randomUUID();
 db.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(project,'Lazy receipts','/unused',now);
 db.prepare('INSERT INTO agents(id,project_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?)').run(agent,project,'Receipt','receipt','codex',now,now,'{}');
 const v3=new CoordinationV3Store(db);
 for(let i=0;i<35;i++)v3.recordRuntimeCommunication({id:randomUUID(),projectId:project,scopeKey:'agent:'+agent,sender:{kind:'user',userId:'local-operator'},intent:'user_dm',audience:{kind:'user_agent',userId:'local-operator',agentId:agent},payload:{text:'receipt '+i},activation:{agentId:agent,kind:'human_message',priority:100,promptClass:'human'},now});
 const select=predicate=>db.prepare(`SELECT a.id,${predicate} eligible FROM agent_activations a ORDER BY a.id`).all();
 assert.deepEqual(select(instrumented),select(legacy));assert.equal(evaluations,0,'Ordinary receipt rows do not enter unsupported-steer history scans');
});
