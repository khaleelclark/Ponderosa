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
