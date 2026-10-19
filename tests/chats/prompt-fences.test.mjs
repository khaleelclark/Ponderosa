import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoordinationV3Store } from '@ponderosa/agents';
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

test('cancelled Run and replaced session cannot use their old message capability', providerOptions, t => withFixture(t, async f => {
  const chat=await f.createChat('Cancelled prompt identity'), agent=await f.createIdleAgent(chat,'Owner'), session=await f.hold(agent.id);
  const turn=acknowledgedPrompt(f,agent.id).id;
  const run=(await f.detail(agent.id)).runs.find(x=>x.status==='running');
  f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:run.id,idempotencyKey:randomUUID()}));
  const cancelled=await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Forbidden cancelled output',steeringInjectionId:turn,idempotencyKey:randomUUID()});
  assert.ok(cancelled.status>=400);
  f.ok(await f.api('PATCH','/api/workspace/preferences',{globalInstructions:'Fresh controlled replacement policy'}));
  const replacement=await f.hold(agent.id);
  assert.notEqual(replacement,session);
  const stale=await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Forbidden old-session output',steeringInjectionId:turn,idempotencyKey:randomUUID()});
  assert.ok(stale.status>=400);
  assert.ok(!(await f.detail(agent.id)).messages.some(x=>x.text.startsWith('Forbidden')));
}));
