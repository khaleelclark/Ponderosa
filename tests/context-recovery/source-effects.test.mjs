// Deferred regression source. Do not execute until whole-implementation testing resumes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

async function originalSource(f, store) {
  const chat = await f.createChat('Original effect receipts');
  const agent = await f.createIdleAgent(chat, 'Original writer');
  const runId = 'original-effect-run', fence = 7, now = new Date().toISOString();
  store.sqlite.prepare(`INSERT INTO scheduler_runs
    (id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,
     provider_session_id,heartbeat_at,created_at,updated_at,scope_key)
    VALUES (?,?,?,'outcome_unknown','prior-worker',?,?,'injected','original-session',?,?,?,'original-scope')`)
    .run(runId,chat.projectId,agent.id,now,fence,now,now,now);
  const path = `/api/agents/${agent.id}/source-runs/${runId}/effects`;
  const communication = (id, sourceRunId = runId) => store.sqlite.prepare(`INSERT INTO runtime_communications
    (id,project_id,sender_json,intent,audience_json,payload_json,payload_hash,actionable,created_at)
    VALUES (?,?,?,'user_dm','{}','{}',?,0,?)`).run(id,chat.projectId,
      JSON.stringify({kind:'agent',agentId:agent.id,executionId:sourceRunId}),'a'.repeat(64),now);
  return {agent,runId,fence,path,communication};
}

test('original exact host commit is reconciled without declaring source/native success; receipt survives reopen', options, t => {
  let store;
  return withFixture(t, async f => {
    const s = await originalSource(f,store);
    s.communication('original-message');
    s.communication('other-run-message','other-run');
    const inventory = f.ok(await f.api('GET',`${s.path}?sourceFence=${s.fence}`));
    assert.deepEqual(inventory.effects.map(x=>[x.receiptId,x.outcome]),[['original-message','host_committed']]);
    assert.equal(inventory.nativeTail,'unknown');
    assert.equal(inventory.sourceWork,'held_unknown');
    const input = {sourceFence:s.fence,expectedInventoryHash:inventory.inventoryHash,idempotencyKey:'inspect-original-only'};
    const first = f.ok(await f.api('POST',`${s.path}/reconcile`,input));
    assert.equal(first.replayed,false);
    assert.equal(first.receipt.disposition,'host_receipts_reconciled_external_unknown');
    assert.equal(first.receipt.replayAuthorized,false);
    assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(s.runId).status,'outcome_unknown');
    await f.reopen();
    const saved = f.ok(await f.api('GET',`${s.path}/reconciliations/${input.idempotencyKey}?sourceFence=${s.fence}`));
    assert.deepEqual(saved.receipt,first.receipt);
    const replay = f.ok(await f.api('POST',`${s.path}/reconcile`,input));
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.receipt,first.receipt);
    const rows = store.sqlite.prepare("SELECT count(*) n FROM coordination_idempotency WHERE operation='source_effects_reconcile'").get();
    assert.equal(rows.n,1);
    assert.equal((await f.api('POST',`${s.path}/reconcile`,{...input,expectedInventoryHash:'b'.repeat(64)})).status,409);
  }, {storeFactory:p=>(store=new AgentStore(p))});
});

test('stale fence/inventory, fabricated outcome and undrained original custody refuse', options, t => {
  let store;
  return withFixture(t, async f => {
    const s = await originalSource(f,store);
    const original = f.ok(await f.api('GET',`${s.path}?sourceFence=${s.fence}`));
    assert.equal((await f.api('GET',`${s.path}?sourceFence=8`)).status,409);
    s.communication('late-canonical-receipt');
    const input={sourceFence:s.fence,expectedInventoryHash:original.inventoryHash,idempotencyKey:'never-replay'};
    assert.equal((await f.api('POST',`${s.path}/reconcile`,input)).status,409);
    assert.equal((await f.api('POST',`${s.path}/reconcile`,{...input,outcome:'completed'})).status,400);
    store.sqlite.prepare(`INSERT INTO provider_process_authority
      (id,worker_id,purpose,project_id,agent_id,run_id,pid,pgid,birth_marker,created_at)
      VALUES ('undrained','prior-worker','provider',?,?,?,123,123,'original-birth',?)`)
      .run(s.agent.projectId,s.agent.id,s.runId,new Date().toISOString());
    assert.equal((await f.api('GET',`${s.path}?sourceFence=${s.fence}`)).status,409);
    assert.equal(store.sqlite.prepare("SELECT count(*) n FROM coordination_idempotency WHERE operation='source_effects_reconcile'").get().n,0);
  }, {storeFactory:p=>(store=new AgentStore(p))});
});

test('successful provider tool output remains unknown, even with an empty error list', options, t => {
  let store;
  return withFixture(t, async f => {
    const s = await originalSource(f,store), now=new Date().toISOString();
    for (const [seq,event] of [[900,{type:'tool_call',id:'external-write',name:'external-write',input:{}}],
      [901,{type:'tool_result',id:'external-write',output:'success',isError:false}]]) {
      store.sqlite.prepare('INSERT INTO events(id,agent_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(`original-event-${seq}`,s.agent.id,seq,event.type,JSON.stringify(event),now);
      store.sqlite.prepare('INSERT INTO activity_projection(agent_id,seq,event_type,execution_id,event_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(s.agent.id,seq,event.type,s.runId,JSON.stringify(event),now);
    }
    const inventory=f.ok(await f.api('GET',`${s.path}?sourceFence=${s.fence}`));
    assert.equal(inventory.effects.length,2);
    assert.ok(inventory.effects.every(x=>x.outcome==='unknown'&&x.toolCallId==='external-write'));
    assert.equal(inventory.nativeTail,'unknown');
    assert.ok(!JSON.stringify(inventory).includes('success'));
  }, {storeFactory:p=>(store=new AgentStore(p))});
});

test('canonical Request update and coordinate receipts prove only their committed host transaction', options, t => {
  let store;
  return withFixture(t, async f => {
    const s=await originalSource(f,store), now=new Date().toISOString(), db=store.sqlite;
    db.prepare(`INSERT INTO coordination_requests
      (id,project_id,recipient_agent_id,payload_json,state,version,lifetime_kind,created_at,updated_at)
      VALUES ('original-request',?,?,'{}','completed',1,'indefinite',?,?)`)
      .run(s.agent.projectId,s.agent.id,now,now);
    db.prepare(`INSERT INTO coordination_request_updates
      (id,request_id,kind,actor_kind,actor_id,payload_json,payload_hash,resulting_state,resulting_version,created_at)
      VALUES ('original-update','original-request','completed','agent',?,? ,?,'completed',1,?)`)
      .run(s.agent.id,JSON.stringify({executionId:s.runId,text:'private result'}),'c'.repeat(64),now);
    db.prepare(`INSERT INTO coordination_idempotency
      (project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at)
      VALUES (?,?,'coordinate','original-handoff',?, ?,?)`)
      .run(s.agent.projectId,`agent:${s.agent.id}:run:${s.runId}`,'d'.repeat(64),JSON.stringify({requestIds:['original-request'],replayed:false}),now);
    const inventory=f.ok(await f.api('GET',`${s.path}?sourceFence=${s.fence}`));
    assert.deepEqual(inventory.effects.map(x=>x.kind),['coordination','request_update']);
    assert.ok(inventory.effects.every(x=>x.outcome==='host_committed'));
    const update=inventory.effects.find(x=>x.kind==='request_update');
    assert.equal(update.requestId,'original-request');
    assert.equal(update.resultingVersion,1);
    assert.equal(update.resultingState,'completed');
    assert.equal(inventory.sourceWork,'held_unknown');
    assert.ok(!JSON.stringify(inventory).includes('private result'));
  }, {storeFactory:p=>(store=new AgentStore(p))});
});

test('completed Run with exact unknown human steering permits inspection only after custody drains', {timeout:30000}, async t => {
 let store;
 return withFixture(t,async f=>{
  const chat=await f.createChat('Completed with unconfirmed steer'),agent=await f.createIdleAgent(chat,'Worker');
  const session=await f.hold(agent.id),runId=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'A correction whose delivery is unknown',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(runId),'unconfirmed steer');
  session.finish();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(runId),'source Run completes');
  await f.reopen();
  const db=store.sqlite,run=db.prepare('SELECT status,fencing_token FROM scheduler_runs WHERE id=?').get(runId);
  const path='/api/agents/'+agent.id+'/source-runs/'+runId+'/effects',target=path+'?sourceFence='+run.fencing_token;
  const before=db.prepare("SELECT state FROM required_reply_obligations WHERE run_id=?").get(runId);
  assert.equal(before.state,'pending');
  assert.equal((await f.api('GET',path+'?sourceFence='+(run.fencing_token+1))).status,409);
  const inventory=f.ok(await f.api('GET',target));
  assert.equal(inventory.sourceStatus,'completed');
  assert.deepEqual(inventory.unknownSteeringInjectionIds,[injection.id]);
  assert.equal(inventory.nativeTail,'unknown');assert.equal(inventory.sourceWork,'held_unknown');assert.equal(inventory.replayAuthorized,false);
  const saved=f.ok(await f.api('POST',path+'/reconcile',{sourceFence:run.fencing_token,expectedInventoryHash:inventory.inventoryHash,idempotencyKey:'inspect-held-steer'}));
  assert.equal(saved.receipt.replayAuthorized,false);
  assert.equal(saved.receipt.disposition,'host_receipts_reconciled_external_unknown');
  assert.equal(db.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
  assert.equal(db.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(runId).state,'pending');
  assert.equal(db.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(runId).status,'completed');
  assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,1);
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');}});
});

test('completed Run inspection requires an unknown steer on that exact Run', options, t=>{
 let store;
 return withFixture(t,async f=>{
  const s=await originalSource(f,store),db=store.sqlite;
  db.prepare("UPDATE scheduler_runs SET status='completed' WHERE id=?").run(s.runId);
  const target=s.path+'?sourceFence='+s.fence;
  assert.equal((await f.api('GET',target)).status,409,'Ordinary completed Runs are outside this API');
  const now=new Date().toISOString();
  db.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at) VALUES (?,?,\'steer\',1,\'pending\',\'\',\'[]\',?,?)").run('not-unknown',s.runId,now,now);
  assert.equal((await f.api('GET',target)).status,409,'Pending does not establish an unknown terminal steer');
  db.prepare("UPDATE scheduler_prompt_injections SET state='outcome_unknown' WHERE id='not-unknown'").run();
  const first=f.ok(await f.api('GET',target));
  assert.deepEqual(first.unknownSteeringInjectionIds,['not-unknown']);
  db.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at) VALUES (?,?,\'steer\',2,\'outcome_unknown\',\'\',\'[]\',?,?)").run('another-unknown',s.runId,now,now);
  assert.equal((await f.api('POST',s.path+'/reconcile',{sourceFence:s.fence,expectedInventoryHash:first.inventoryHash,idempotencyKey:'stale-exact-set'})).status,409,'A changed injection set invalidates the reviewed inventory');
  db.prepare("INSERT INTO provider_process_authority(id,worker_id,purpose,project_id,agent_id,run_id,pid,pgid,birth_marker,created_at) VALUES ('undrained-completed','prior-worker','provider',?,?,?,124,124,'original-birth',?)").run(s.agent.projectId,s.agent.id,s.runId,now);
  assert.equal((await f.api('GET',target)).status,409,'Live original custody remains unavailable');
 },{storeFactory:p=>(store=new AgentStore(p))});
});
