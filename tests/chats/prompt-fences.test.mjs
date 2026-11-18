import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import { withFixture, until } from '../shared/fixture.mjs';
import { openCurrentMemoryDatabase } from '../../packages/agents/dist/state-admission.js';

function fixture(t) {
  const sqlite = openCurrentMemoryDatabase();
  t.after(() => sqlite.close());
  const now = new Date().toISOString(), projectId = randomUUID(), conversationId = randomUUID();
  sqlite.prepare('INSERT INTO projects(id,label,host_path,created_at) VALUES(?,?,?,?)').run(projectId,'Fixture','/unused',now);
  sqlite.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(conversationId,projectId,'Fixture',now,now);
  const agentId = randomUUID(), otherAgentId = randomUUID();
  for (const id of [agentId, otherAgentId]) sqlite.prepare(
    'INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id,projectId,conversationId,id,id,'codex',now,now,'{}');
  for (const id of [agentId, otherAgentId]) sqlite.prepare('INSERT INTO agent_conversation_memberships(agent_id,conversation_id,position) VALUES(?,?,?)').run(id,conversationId,0);
  const scopeKey = 'conversation:' + conversationId;
  const addRun = (id = randomUUID(), agent = agentId, token = 1) => {
    sqlite.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,provider_session_id,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'running','fixture',?,?,'injected',?,?,?,?,?)")
      .run(id,projectId,agent,new Date(Date.now()+60000).toISOString(),token,'session:'+id,now,now,now,scopeKey);
    return { runId:id,agentId:agent,fencingToken:token };
  };
  const authorization = addRun(), store = new CoordinationV3Store(sqlite);
  const injection = (kind = 'turn', state = 'acknowledged', sequence = 0, auth = authorization) => {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,auth.runId,kind,sequence,state,'fixture-hash','[]',now,now);
    return id;
  };
  const publish = (id, overrides = {}) => store.recordRuntimeCommunication({
    id:randomUUID(),projectId,scopeKey,runAuthorization:authorization,
    sender:{kind:'agent',agentId,executionId:authorization.runId},intent:'user_dm',
    audience:{kind:'user_agent',userId:'local-operator',agentId},
    payload:{text:'Exact fixture reply'},steeringInjectionId:id,...overrides,
  });
  return {sqlite,store,authorization,projectId,conversationId,agentId,otherAgentId,scopeKey,addRun,injection,publish};
}

test('an acknowledged initial turn permits the default reply without a steering fence', t => {
  const f = fixture(t); f.injection();
  assert.equal(f.publish(null).replayed, false);
});

test('acknowledged current turn publishes once; newer acknowledged steering fences new output but preserves exact replay', t => {
  const f=fixture(t), turn=f.injection(), id=randomUUID();
  const first=f.publish(turn,{id}); assert.equal(first.replayed,false);
  assert.equal(f.publish(turn,{id}).replayed,true);
  const steer=f.injection('steer','acknowledged',1);
  assert.throws(()=>f.publish(turn),/fenced behind acknowledged steering/);
  assert.throws(()=>f.publish(null),/fenced behind acknowledged steering/);
  assert.equal(f.publish(turn,{id}).replayed,true);
  assert.equal(f.publish(steer).replayed,false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_communications').get().n,2);
  assert.throws(()=>f.publish(turn,{id,payload:{text:'Changed operation'}}),/collision/);
});

for (const state of ['pending','submitted','outcome_unknown','cancelled']) test('unacknowledged/cancelled '+state+' prompt IDs cannot publish', t => {
  const f=fixture(t); f.injection();
  const invalid=f.injection('steer',state,1);
  assert.throws(()=>f.publish(invalid),/prompt|fenced/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_communications').get().n,0);
});

test('pending steering does not supersede an acknowledged turn; older turns and steering become stale only when newer prompts are acknowledged', t => {
  const f=fixture(t), turn=f.injection(), pending=f.injection('steer','pending',1);
  assert.equal(f.publish(turn).replayed,false);
  f.sqlite.prepare("UPDATE scheduler_prompt_injections SET state='acknowledged' WHERE id=?").run(pending);
  assert.throws(()=>f.publish(turn),/fenced/);
  assert.equal(f.publish(pending).replayed,false);
  const next=f.injection('steer','acknowledged',2);
  assert.throws(()=>f.publish(pending),/fenced/);
  assert.equal(f.publish(next).replayed,false);
  const newerTurn=f.injection('turn','acknowledged',3);
  assert.equal(f.publish(newerTurn).replayed,false);
  assert.throws(()=>f.publish(next),/prompt|fenced/);
});

test('unknown, wrong-Run/session, stale turn, wrong scope and non-authoritative Run cannot publish', t => {
  const f=fixture(t), original=f.injection();
  assert.throws(()=>f.publish(randomUUID()),/prompt|fenced/);
  const other=f.addRun(undefined,f.otherAgentId);
  const otherPrompt=f.injection('turn','acknowledged',0,other);
  assert.throws(()=>f.publish(otherPrompt),/prompt|fenced/);
  const current=f.injection('turn','acknowledged',1);
  assert.throws(()=>f.publish(original),/prompt|fenced/);
  assert.throws(()=>f.publish(current,{scopeKey:'agent:'+f.agentId}),/scope/);
  assert.throws(()=>f.publish(current,{runAuthorization:{...f.authorization,fencingToken:2}}),/authoritative/);
  f.sqlite.prepare("UPDATE scheduler_runs SET side_effects_fenced_at=? WHERE id=?").run(new Date().toISOString(),f.authorization.runId);
  assert.throws(()=>f.publish(current),/authoritative/);
  f.sqlite.prepare("UPDATE scheduler_runs SET side_effects_fenced_at=NULL,status='cancelled' WHERE id=?").run(f.authorization.runId);
  assert.throws(()=>f.publish(current),/authoritative/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_communications').get().n,0);
});

test('passive next-Run communication uses the same acknowledged prompt authority and exact replay', t => {
  const f=fixture(t), turn=f.injection(), args={projectId:f.projectId,conversationId:f.conversationId,publisherAgentId:f.agentId,sourceRunId:f.authorization.runId,runAuthorization:f.authorization,idempotencyKey:randomUUID(),text:'Passive fixture fact',recipientAgentIds:[f.otherAgentId],steeringInjectionId:turn};
  const first=f.store.publishAgentNextRunDelivery(args);
  const steer=f.injection('steer','acknowledged',1);
  assert.equal(f.store.publishAgentNextRunDelivery(args).delivery.id,first.delivery.id);
  assert.throws(()=>f.store.publishAgentNextRunDelivery({...args,idempotencyKey:randomUUID()}),/fenced/);
  assert.equal(f.store.publishAgentNextRunDelivery({...args,idempotencyKey:randomUUID(),steeringInjectionId:steer}).replayed,false);
});


test('current prompt identity does not relax operator-final delivery or communication scope requirements', t => {
  const f=fixture(t), turn=f.injection();
  assert.throws(()=>f.publish(turn,{taskDelivery:'final',payload:{text:'Unowned final',taskDelivery:'final'}}),/task delivery requires/);
  assert.throws(()=>f.publish(turn,{audience:{kind:'user_agent',userId:'local-operator',agentId:randomUUID()}}),/authority does not agree/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_communications').get().n,0);
});

function taskRoot(f, text = 'Implement the whole objective, then validate everything together.') {
  const id = randomUUID(), now = new Date().toISOString();
  const communication = { schemaVersion: 2, eventId: randomUUID(), projectId: f.projectId,
    conversationId: f.conversationId, sender: { kind: 'user', userId: 'local-operator' },
    intent: 'user_dm', audience: { kind: 'user_agent', userId: 'local-operator', agentId: f.agentId }, text, createdAt: now };
  f.sqlite.prepare(`INSERT INTO agent_activations
    (id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
    VALUES (?,?,?,'human_message',100,'next_run','human','consumed',?,?,?,?,?,?)`)
    .run(id, f.projectId, f.agentId, id, JSON.stringify({ communication }), now, now, now, f.scopeKey);
  f.sqlite.prepare(`INSERT INTO required_reply_obligations
    (run_id,source_activation_id,project_id,agent_id,scope_key,reply_authority_json,state,created_at,updated_at,delivery_phase)
    VALUES (?,?,?,?,?,?,'pending',?,?,'final')`)
    .run(f.authorization.runId, id, f.projectId, f.agentId, f.scopeKey, '{"intent":"direct_to_user"}', now, now);
  return { id, communication };
}

function retireForTask(f, root) {
  const generation = 'session:' + f.authorization.runId;
  const { rollover } = f.store.requestContextRollover({ projectId: f.projectId, agentId: f.agentId,
    oldProviderSessionId: generation, providerSessionGeneration: generation, detectedOccupancy: 160000,
    threshold: 150000, lowWaterMark: 90000, sourceRunId: f.authorization.runId,
    compactionCutoffOrdinal: 1, compactionCutoffEventId: root.communication.eventId,
    recentTail: [{ communicationEventId: root.communication.eventId, contentSha256: 'a'.repeat(64) }],
    sourceActivationIds: [root.id], scopeKey: f.scopeKey, conversationId: f.conversationId,
    replyAuthority: { intent: 'direct_to_user' }, visibleResponseCommitted: true });
  f.store.commitContextRolloverHandoff(rollover.id, randomUUID());
  f.store.beginContextRolloverRetirement(rollover.id);
  return f.store.prepareContextRolloverContinuation({ id: rollover.id });
}

test('an unfinished batch cannot claim blocked completion; a progress reply still allows one rollover continuation', t => {
  const f = fixture(t), turn = f.injection(), root = taskRoot(f);
  assert.throws(() => f.publish(turn, { satisfiesRequiredReply: true, taskDelivery: 'blocked',
    payload: { text: 'Batch finished; much implementation remains.', taskDelivery: 'blocked' } }), /task_delivery_blocker_required/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_communications').get().n, 0,
    'Rejected closure and its receipt roll back together');
  f.publish(turn, { satisfiesRequiredReply: true, payload: { text: 'Batch finished; continuing implementation.' } });
  assert.equal(f.store.requiredReplyObligationsForRun(f.authorization.runId)[0].state, 'pending');
  const rollover = retireForTask(f, root);
  assert.equal(rollover.state, 'continuation_ready');
  assert.ok(rollover.continuationActivationId);
  assert.equal(f.store.prepareContextRolloverContinuation({ id: rollover.id }).continuationActivationId, rollover.continuationActivationId);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='context_rollover_continuation'").get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runtime_communications').get().n, 1,
    'Continuation reconstructs inputs; it never replays communication or unknown external effects');
});

test('a genuine blocking Decision keeps the task waiting instead of completing it or retrying forever', t => {
  const f = fixture(t), turn = f.injection(), root = taskRoot(f), decisionId = randomUUID();
  f.store.waitForTaskDecision({ runAuthorization: f.authorization, decisionId, scopeKey: f.scopeKey });
  f.publish(turn, { satisfiesRequiredReply: true, taskDelivery: 'blocked',
    payload: { text: 'Waiting for the exact prerequisite in the Decision.', taskDelivery: 'blocked' } });
  const obligation = f.store.requiredReplyObligationsForRun(f.authorization.runId)[0];
  assert.equal(obligation.state, 'pending'); assert.equal(obligation.blockingDecisionId, decisionId);
  const rollover = retireForTask(f, root);
  assert.equal(rollover.state, 'completed'); assert.equal(rollover.continuityWaiting, true);
  assert.equal(rollover.continuationActivationId, undefined);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
});

test('true whole-task completion permits rollover retirement without a replacement loop', t => {
  const f = fixture(t), turn = f.injection(), root = taskRoot(f);
  f.publish(turn, { satisfiesRequiredReply: true, taskDelivery: 'final',
    payload: { text: 'All required implementation and final checks complete.', taskDelivery: 'final' } });
  assert.equal(f.store.requiredReplyObligationsForRun(f.authorization.runId)[0].state, 'satisfied');
  const rollover = retireForTask(f, root);
  assert.equal(rollover.state, 'completed'); assert.equal(rollover.completionReason, 'no_continuation_required');
  assert.equal(rollover.continuationActivationId, undefined);
  assert.deepEqual(f.store.unfinishedHumanSourceActivationIds(f.authorization.runId), []);
});

test('unfinished task reconstruction preserves the original objective and acknowledged human steering, excluding peer prose and other owners', t => {
  const f = fixture(t), turn = f.injection(), root = taskRoot(f), correction = taskRoot(f, 'Do not test until ALL implementation is combined.');
  f.sqlite.prepare("UPDATE required_reply_obligations SET state='satisfied',delivery_phase='initial' WHERE source_activation_id=?").run(correction.id);
  f.sqlite.prepare('UPDATE scheduler_prompt_injections SET activation_ids_json=? WHERE id=?')
    .run(JSON.stringify([root.id, correction.id]), turn);
  assert.deepEqual(f.store.unfinishedHumanSourceActivationIds(f.authorization.runId), [root.id, correction.id]);
  f.sqlite.prepare("UPDATE agent_activations SET payload_json=json_set(payload_json,'$.communication.sender.kind','agent') WHERE id=?").run(correction.id);
  assert.deepEqual(f.store.unfinishedHumanSourceActivationIds(f.authorization.runId), [root.id]);
  f.sqlite.prepare('UPDATE agent_activations SET agent_id=? WHERE id=?').run(f.otherAgentId, root.id);
  assert.deepEqual(f.store.unfinishedHumanSourceActivationIds(f.authorization.runId), []);
});


const providerOptions = { timeout: 30000 };
const acknowledgedPrompt = (f, agentId) => {
  const sqlite = new Database(path.join(f.dataDir,'ponderosa.db'), {readonly:true});
  try {
    const row=sqlite.prepare("SELECT injection.id,injection.kind FROM scheduler_prompt_injections injection JOIN scheduler_runs run ON run.id=injection.run_id WHERE run.agent_id=? AND run.status='running' AND injection.state='acknowledged' ORDER BY injection.sequence DESC LIMIT 1").get(agentId);
    assert.ok(row, 'Scheduler did not acknowledge a prompt on the active owned Run');
    return row;
  } finally { sqlite.close(); }
};
test('scheduler current-turn ID crosses the message route; unknown/wrong-Run and later steering fences preserve exact replay', providerOptions, t => withFixture(t, async f => {
  const chat=await f.createChat('Prompt identity route'), a=await f.createIdleAgent(chat,'Owner'), b=await f.createIdleAgent(chat,'Other session');
  const session=await f.hold(a.id); await f.hold(b.id);
  const turn=acknowledgedPrompt(f,a.id).id;
  const other=acknowledgedPrompt(f,b.id).id;
  const args={intent:'direct_to_user',text:'Current-turn fixture progress',steeringInjectionId:turn,idempotencyKey:randomUUID()};
  const first=f.ok(await f.tool(session,'ponderosa_message',args));
  assert.equal(f.ok(await f.tool(session,'ponderosa_message',args)).eventId,first.eventId);
  for (const id of [randomUUID(),other]) assert.equal((await f.tool(session,'ponderosa_message',{...args,steeringInjectionId:id,idempotencyKey:randomUUID()})).status,409);
  const marker='Exact new steering '+randomUUID();
  await f.send(a.id,marker,{activeRunDelivery:'steer'});
  await until(()=>f.steers.some(x=>x.agentId===a.id&&x.input.prompt.includes(marker)),'accepted newer steering');
  const accepted=acknowledgedPrompt(f,a.id); assert.equal(accepted.kind,'steer');
  const steer=accepted.id;
  assert.equal((await f.tool(session,'ponderosa_message',{...args,idempotencyKey:randomUUID()})).status,409);
  assert.equal(f.ok(await f.tool(session,'ponderosa_message',args)).eventId,first.eventId);
  f.ok(await f.tool(session,'ponderosa_message',{...args,text:'Newest steering fixture reply',steeringInjectionId:steer,idempotencyKey:randomUUID()}));
  const detail=await f.detail(a.id);
  assert.equal(detail.messages.filter(x=>x.role==='assistant'&&x.text===args.text).length,1);
  assert.equal(detail.messages.filter(x=>x.role==='assistant'&&x.text==='Newest steering fixture reply').length,1);
  assert.equal(f.sessions.get(b.id).isAlive(),true,'Unrelated session was affected');
}));

test('cancelled Run and replaced session cannot use their old message capability', providerOptions, async t => {
 let store;
 await withFixture(t, async f => {
  const chat=await f.createChat('Cancelled prompt identity'), agent=await f.createIdleAgent(chat,'Owner'), session=await f.hold(agent.id);
  const turn=acknowledgedPrompt(f,agent.id).id;
  const run=(await f.detail(agent.id)).runs.find(x=>x.status==='running');
  const cancellationKey=randomUUID();f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:run.id,idempotencyKey:cancellationKey}));
  const cancelled=await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Forbidden cancelled output',steeringInjectionId:turn,idempotencyKey:randomUUID()});
  assert.ok(cancelled.status>=400);
  await until(()=>store.stoppedProviderSessionBoundary(agent.id)?.cleanupConfirmed,'cancelled root cleanup observed');
  assert.equal(session.isAlive(),false);
  const original=store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(run.id),packet=JSON.stringify(store.getProviderInput(run.id,true));
  const status=f.ok(await f.api('GET',`/api/agents/${agent.id}/context-recoveries`)),boundary=status.boundary;
  assert.equal(boundary.sourceRunId,run.id);assert.equal(status.sourceEvidence.sourceRunStatus,'cancelled');
  const commandsBefore=f.commands.length,turnsBefore=f.turns.length,previous=(await f.detail(agent.id)).runs.map(x=>x.id),task='Controlled replacement task';
  f.plans.set(agent.id,[{hold:true}]);const independent=await f.send(agent.id,task);
  const queued=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND json_extract(payload_json,'$.communication.eventId')=?").get(agent.id,independent.communicationEventId);assert.ok(queued);
  const recovered=await until(()=>store.sqlite.prepare("SELECT progress_json FROM provider_context_recovery_requests WHERE agent_id=? AND source_run_id=? AND state='dismissed'").get(agent.id,run.id),'automatic measured recovery');
  assert.equal(JSON.parse(recovered.progress_json).phase,'context_accepted');assert.equal(f.commands.length,commandsBefore+1);assert.equal(f.commands.at(-1).name,'compact');assert.equal(f.commands.at(-1).sessionId,boundary.providerSessionId);
  await until(()=>f.turns.some(x=>x.agentId===agent.id&&x.input.prompt.includes(task)),'same independent replacement task admitted automatically');
  const replacement=f.sessions.get(agent.id);
  assert.notEqual(replacement,session);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(queued.id).n,1);assert.equal(f.turns.length,turnsBefore+1);
  assert.deepEqual(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(run.id),original);assert.equal(JSON.stringify(store.getProviderInput(run.id,true)),packet);
  const stale=await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Forbidden old-session output',steeringInjectionId:turn,idempotencyKey:randomUUID()});
  assert.ok(stale.status>=400);
  f.ok(await f.tool(replacement,'ponderosa_message',{intent:'direct_to_user',text:'Current replacement task completed',steeringInjectionId:acknowledgedPrompt(f,agent.id).id,idempotencyKey:randomUUID()}));
  replacement.finish();const finished=await f.settled(agent.id,previous);
  assert.equal(finished.runs.filter(x=>!previous.includes(x.id)&&x.status==='completed').length,1);assert.equal(f.turns.length,turnsBefore+1);
  assert.ok(!(await f.detail(agent.id)).messages.some(x=>x.text.startsWith('Forbidden')));
 },{storeFactory:root=>store=new AgentStore(root),providerValidatesResumeBeforeTurn:true,
  providerContextRecoverySupport:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},
  providerCommandResult:({sessionId})=>({outcome:'completed',contextUsage:{usedTokens:1000,windowTokens:200000,providerSessionGeneration:sessionId}})});
});
