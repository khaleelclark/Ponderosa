import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AgentStore,CoordinationV3Store} from '@ponderosa/agents';
import {withFixture,until} from '../shared/fixture.mjs';

const createRequest=(coordination,chat,sender,target,id=randomUUID())=>coordination.coordinate({
  projectId:chat.projectId,conversationId:chat.id,requesterAgentId:sender.id,
  actorScope:'user:local-operator',idempotencyKey:randomUUID(),
  requests:[{requestId:id,recipientAgentId:target.id,payload:{text:'Handle the new Request'},lifetime:{kind:'indefinite'}}],
}).requestIds[0];
const activation=(store,id)=>store.sqlite.prepare(`SELECT a.* FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
  WHERE s.source_kind='request' AND s.source_id=? AND a.kind='coordination_request'`).get(id);
const steered=(store,run,state)=>store.sqlite.prepare("SELECT * FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state=? ORDER BY sequence DESC LIMIT 1").get(run,state);

test('busy Request requires its acknowledged prompt and explicit identity, even for a pre-known ID', {timeout:30000}, async t=>{
  let store,release,steerCalls=0;
  try { await withFixture(t,async f=>{
    const chat=await f.createChat('Busy Request');
    const target=await f.createIdleAgent(chat,'Worker'),sender=await f.createIdleAgent(chat,'Manager');
    const session=await f.hold(target.id),run=(await f.detail(target.id)).runs[0].id;
    const coordination=new CoordinationV3Store(store.sqlite);
    const requestId=randomUUID();
    // Both payloads exist before the Request or its fresh prompt fence exist.
    const oldImplicit={text:'Old result'},oldExplicit={requestId,text:'Old result'};
    createRequest(coordination,chat,sender,target,requestId);
    assert.equal(activation(store,requestId).dispatch_policy,'steer_or_run');
    const pending=await until(()=>steered(store,run,'submitted'),'Request submitted to provider');
    const steeredPrompt=f.steers.find(item=>item.agentId===target.id).input.prompt;
    assert.ok(steeredPrompt.includes(requestId));
    assert.ok(steeredPrompt.includes('Handle the new Request'));
    assert.ok(steeredPrompt.includes('human\'s complete objective'));
    assert.ok(coordination.requiredReplyObligationsForRun(run).some(item=>item.state==='pending'));
    assert.notEqual((await f.tool(session,'ponderosa_update_request',oldImplicit)).status,200);
    assert.notEqual((await f.tool(session,'ponderosa_update_request',oldExplicit)).status,200);
    const bad=await f.tool(session,'ponderosa_update_request',{requestId:'not-a-real-request',text:'Old result'});
    assert.equal(JSON.stringify(bad).includes(requestId),false);
    assert.equal(coordination.getRequest(requestId).state,'open');
    release(); await until(()=>steered(store,run,'acknowledged'),'Request acknowledged');
    assert.notEqual((await f.tool(session,'ponderosa_update_request',oldImplicit)).status,200);
    assert.notEqual((await f.tool(session,'ponderosa_update_request',oldExplicit)).status,200);
    const message=await f.tool(session,'ponderosa_message',{text:'Old message'});
    assert.notEqual(message.status,200);
    assert.equal(JSON.stringify(message).includes(pending.id),false,'error must not teach the new fence');
    assert.notEqual((await f.tool(session,'ponderosa_update_request',oldExplicit)).status,200,'retrying old args still fails');
    assert.equal(coordination.getRequest(requestId).state,'open');
    await f.send(target.id,'One more instruction during the same task');
    const later=await until(()=>{const injection=steered(store,run,'acknowledged');return injection?.id!==pending.id && injection;},'later human steer acknowledged');
    const afterLater=await f.tool(session,'ponderosa_message',{text:'Old message after later steer'});
    assert.notEqual(afterLater.status,200);
    assert.equal(JSON.stringify(afterLater).includes(later.id),false,'ordinary error must not expose later fence either');
    assert.notEqual((await f.tool(session,'ponderosa_update_request',oldExplicit)).status,200);
    const updated=await f.tool(session,'ponderosa_update_request',{requestId,steeringInjectionId:later.id,text:'Completed new Request'});
    assert.equal(updated.status,200,JSON.stringify(updated));
    assert.equal(coordination.getRequest(requestId).state,'completed');
    assert.ok(coordination.requiredReplyObligationsForRun(run).some(item=>item.state==='pending'));
    assert.equal((await f.detail(target.id)).runs.length,1,'same Run remains active');
    assert.equal(f.sessions.get(target.id),session,'same provider session remains active');
    session.finish();
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{if(++steerCalls===1)await new Promise(resolve=>{release=resolve});return {status:'accepted'};}});
  } finally {release?.();}
});

test('unsupported steering queues the Request once for the following Run', {timeout:30000}, async t=>{
  let store,calls=0;
  await withFixture(t,async f=>{
    const chat=await f.createChat('Unsupported provider');
    const target=await f.createIdleAgent(chat,'Worker'),sender=await f.createIdleAgent(chat,'Manager');
    const session=await f.hold(target.id),coordination=new CoordinationV3Store(store.sqlite);
    const requestId=createRequest(coordination,chat,sender,target);
    await until(()=>activation(store,requestId).steering_wait_reason==='provider_unsupported','unsupported provider recorded');
    assert.equal(activation(store,requestId).dispatch_policy,'next_run');
    assert.equal(coordination.requestDelivery(requestId).steeringWaitReason,'provider_unsupported');
    await new Promise(resolve=>setTimeout(resolve,1300));
    assert.equal(calls,1,'known unsupported provider is not polled repeatedly');
    // Exercise the pending Request through required-reply recovery before
    // admitting the Request to its own Run.
    const requestActivation=activation(store,requestId).id;
    // Select the real reply recovery deterministically; the scheduler can
    // otherwise lease the lower-priority Request before recovery is queued.
    // Release this fixture-only scheduling gate while recovery is still live.
    store.sqlite.prepare("UPDATE agent_activations SET available_at=? WHERE id=?").run('9999-12-31T23:59:59.999Z',requestActivation);
    f.plans.set(target.id,[{hold:true}]);
    session.finish();
    const recovery=await until(()=>{
      const row=store.sqlite.prepare(`SELECT ra.run_id,a.id activation_id FROM scheduler_run_activations ra
        JOIN agent_activations a ON a.id=ra.activation_id
        WHERE a.agent_id=? AND a.kind='required_reply_recovery' ORDER BY ra.rowid DESC LIMIT 1`).get(target.id);
      return row&&f.turns.some(turn=>turn.agentId===target.id&&JSON.stringify(turn.input).includes(row.run_id))?row:undefined;
    },'required human reply recovery starts');
    assert.equal(coordination.getRequest(requestId).state,'open');
    assert.equal(activation(store,requestId).state,'retry_pending');
    store.sqlite.prepare("UPDATE agent_activations SET available_at=? WHERE id=?").run(new Date().toISOString(),requestActivation);
    const original=activation(store,requestId),proof={projectId:original.project_id,agentId:original.agent_id,activationId:original.id,scopeKey:original.scope_key};
    const refused=store.sqlite.prepare(`SELECT injection.id,injection.run_id FROM scheduler_prompt_injections injection,json_each(injection.activation_ids_json) member
      WHERE member.value=? AND injection.kind='steer' AND injection.state='cancelled'`).get(requestActivation);
    assert.ok(refused,'the exact unsupported steer remains as cancelled audit evidence');
    assert.equal(coordination.settingsTransitionUnsubmittedActivation(proof),true,'definite no-write refusal is eligible for the next Run');
    for(const [sql,value] of [
      ["UPDATE scheduler_prompt_injections SET state='outcome_unknown' WHERE id=?",refused.id],
      ["UPDATE scheduler_prompt_injections SET acknowledged_at='2026-01-01T00:00:00.000Z' WHERE id=?",refused.id],
      ["UPDATE scheduler_prompt_injections SET provider_turn_id='contradictory' WHERE id=?",refused.id],
      ["UPDATE scheduler_runs SET status='failed' WHERE id=?",refused.run_id],
    ]){
      const rollback=Error('restore synthetic contradictory evidence');
      assert.throws(()=>store.sqlite.transaction(()=>{
        store.sqlite.prepare(sql).run(value);
        assert.equal(coordination.settingsTransitionUnsubmittedActivation(proof),false,'ambiguous, acknowledged or non-completed evidence stays held');
        throw rollback;
      })(),error=>error===rollback);
    }
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE run_id=? AND activation_id=?').get(recovery.run_id,requestActivation).n,0);
    const recoveryInput=f.turns.find(turn=>turn.agentId===target.id&&JSON.stringify(turn.input).includes(recovery.run_id));
    assert.ok(JSON.stringify(recoveryInput).includes(recovery.activation_id));
    assert.ok(!JSON.stringify(recoveryInput).includes(requestId),'the Request remains separate from the recovery');
    assert.equal(f.turns.filter(turn=>turn.agentId===target.id&&JSON.stringify(turn.input).includes(requestId)).length,0,"the Request has not been submitted during recovery");
    await until(()=>store.sqlite.prepare('SELECT prompt_injection_state FROM scheduler_runs WHERE id=?').get(recovery.run_id)?.prompt_injection_state==='injected','recovery input acknowledged');
    const recoverySession=f.sessions.get(target.id);
    const humanReply=await f.tool(recoverySession,'ponderosa_message',{text:'The original task is complete.'});
    assert.equal(humanReply.status,200,JSON.stringify(humanReply));
    f.plans.set(target.id,[{hold:true}]);
    recoverySession.finish();

    const requestRun=await until(()=>{
      const row=store.sqlite.prepare('SELECT run_id FROM scheduler_run_activations WHERE activation_id=?').get(requestActivation);
      return row&&f.turns.some(turn=>turn.agentId===target.id&&JSON.stringify(turn.input).includes(requestId))?row:undefined;
    },'exact queued Request starts');
    assert.notEqual(requestRun.run_id,recovery.run_id);
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(requestActivation).n,1);
    const matching=f.turns.filter(turn=>turn.agentId===target.id&&JSON.stringify(turn.input).includes(requestId));
    assert.equal(matching.length,1,'the original Request is submitted exactly once');
    assert.ok(JSON.stringify(matching[0].input).includes(requestRun.run_id));
    assert.ok(JSON.stringify(matching[0].input).includes('Handle the new Request'));
    assert.equal(coordination.getRequest(requestId).state,'open');
    await until(()=>store.sqlite.prepare('SELECT prompt_injection_state FROM scheduler_runs WHERE id=?').get(requestRun.run_id)?.prompt_injection_state==='injected','Request input acknowledged');
    const next=f.sessions.get(target.id);
    const done=await f.tool(next,'ponderosa_update_request',{requestId,text:'Completed once'});
    assert.equal(done.status,200,JSON.stringify(done));
    assert.equal(coordination.getRequest(requestId).state,'completed');
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM coordination_request_updates WHERE request_id=? AND kind='completed'").get(requestId).count,1);
    assert.equal(f.turns.filter(turn=>turn.agentId===target.id&&JSON.stringify(turn.input).includes(requestId)).length,1);
    next.finish();
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{calls++;return {status:'unsupported'};}});
});

test('an old root result cannot finish after a newly steered Request is acknowledged', {timeout:30000}, async t=>{
  let store,release;
  try {await withFixture(t,async f=>{
    const chat=await f.createChat('Existing Request');
    const target=await f.createIdleAgent(chat,'Worker'),sender=await f.createIdleAgent(chat,'Manager');
    const coordination=new CoordinationV3Store(store.sqlite);
    f.plans.set(target.id,[{hold:true}]);
    const original=createRequest(coordination,chat,sender,target);
    await until(()=>f.turns.some(turn=>turn.agentId===target.id),'original Request run');
    const session=f.sessions.get(target.id),run=(await f.detail(target.id)).runs[0].id;
    const old={requestId:original,text:'Old result'};
    const next=createRequest(coordination,chat,sender,target);
    const pending=await until(()=>steered(store,run,'submitted'),'new Request submitted');
    release();await until(()=>steered(store,run,'acknowledged'),'new Request acknowledged');
    assert.notEqual((await f.tool(session,'ponderosa_update_request',old)).status,200);
    assert.equal(coordination.getRequest(original).state,'open');
    assert.equal(coordination.getRequest(next).state,'open');
    assert.equal((await f.tool(session,'ponderosa_update_request',{...old,steeringInjectionId:pending.id})).status,200);
    assert.equal(coordination.getRequest(original).state,'completed');
    assert.equal(coordination.getRequest(next).state,'open');
    session.finish();
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{await new Promise(resolve=>{release=resolve});return {status:'accepted'};}});
  } finally {release?.();}
});

test('uncertain steering stays visible and is not retried', {timeout:30000}, async t=>{
  let store,calls=0;
  await withFixture(t,async f=>{
    const chat=await f.createChat('Uncertain delivery');
    const target=await f.createIdleAgent(chat,'Worker'),sender=await f.createIdleAgent(chat,'Manager');
    const session=await f.hold(target.id),coordination=new CoordinationV3Store(store.sqlite);
    const requestId=createRequest(coordination,chat,sender,target);
    await until(()=>activation(store,requestId).state==='outcome_unknown','uncertain delivery held');
    assert.equal(coordination.requestDelivery(requestId).deliveryState,'delivery_uncertain');
    await new Promise(resolve=>setTimeout(resolve,1300));
    assert.equal(calls,1);assert.equal(coordination.getRequest(requestId).state,'open');
    session.finish();
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{calls++;throw Error('uncertain provider response');}});
});

test('human interruptions and tracked Requests use separate steer submissions while retaining same-kind batching', {timeout:30000}, async t=>{
  let store,release,calls=0;
  try {await withFixture(t,async f=>{
    const chat=await f.createChat('Separated steer batches');
    const target=await f.createIdleAgent(chat,'Worker'),sender=await f.createIdleAgent(chat,'Manager');
    const session=await f.hold(target.id),run=(await f.detail(target.id)).runs[0].id;
    const coordination=new CoordinationV3Store(store.sqlite);
    await f.send(target.id,'First held steering delivery');
    await until(()=>calls===1,'first steering submission held');
    // Queue both kinds while the first provider call is in flight, so the
    // next scheduler selection genuinely has all four candidates at once.
    await f.send(target.id,'Second human interruption');
    await f.send(target.id,'Third human interruption');
    const first=createRequest(coordination,chat,sender,target);
    const second=createRequest(coordination,chat,sender,target);
    release();
    const injections=await until(()=>{
      const rows=store.sqlite.prepare("SELECT activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='acknowledged' ORDER BY sequence").all(run);
      return rows.length===3?rows:false;
    },'three separate steering submissions');
    const contents=injections.map(row=>JSON.parse(row.activation_ids_json).map(id=>
      store.sqlite.prepare('SELECT kind,prompt_class FROM agent_activations WHERE id=?').get(id)));
    assert.deepEqual(contents.map(items=>items.length),[1,2,2]);
    assert.ok(contents[1].every(item=>item.prompt_class==='human'));
    assert.ok(contents[2].every(item=>item.kind==='coordination_request'));
    assert.ok(contents.every(items=>!(items.some(item=>item.prompt_class==='human') && items.some(item=>item.kind==='coordination_request'))));
    assert.equal(coordination.getRequest(first).state,'open');
    assert.equal(coordination.getRequest(second).state,'open');
    assert.ok(coordination.requiredReplyObligationsForRun(run).some(item=>item.state==='pending'));
    assert.equal((await f.detail(target.id)).runs.length,1);
    session.finish();
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{
    if(++calls===1)await new Promise(resolve=>{release=resolve});
    return {status:'accepted'};
  }});} finally {release?.();}
});

test('an uncertain human steer remains held separately from a queued peer Request', {timeout:30000}, async t=>{
  let store,release,calls=0;
  try {await withFixture(t,async f=>{
    const chat=await f.createChat('Separate uncertain interruption');
    const target=await f.createIdleAgent(chat,'Worker'),sender=await f.createIdleAgent(chat,'Manager');
    const session=await f.hold(target.id),run=(await f.detail(target.id)).runs[0].id;
    const coordination=new CoordinationV3Store(store.sqlite);
    await f.send(target.id,'First held steering delivery');
    await until(()=>calls===1,'first submission held');
    await f.send(target.id,'Uncertain human interruption');
    const requestId=createRequest(coordination,chat,sender,target);
    release();
    const rows=await until(()=>{
      const all=store.sqlite.prepare("SELECT state,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' ORDER BY sequence").all(run);
      return all.length===3 && all[1].state==='outcome_unknown' && all[2].state==='acknowledged' ? all : false;
    },'uncertain human held and separate peer delivered');
    const humanIds=JSON.parse(rows[1].activation_ids_json),peerIds=JSON.parse(rows[2].activation_ids_json);
    assert.equal(humanIds.length,1);assert.equal(peerIds.length,1);
    assert.equal(store.sqlite.prepare('SELECT prompt_class FROM agent_activations WHERE id=?').get(humanIds[0]).prompt_class,'human');
    assert.equal(store.sqlite.prepare('SELECT kind FROM agent_activations WHERE id=?').get(peerIds[0]).kind,'coordination_request');
    assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(humanIds[0]).state,'outcome_unknown');
    assert.equal(coordination.getRequest(requestId).state,'open');
    assert.ok(coordination.requiredReplyObligationsForRun(run).some(item=>item.state==='pending'));
    assert.equal(calls,3);
    session.finish();
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{
    const n=++calls;if(n===1)await new Promise(resolve=>{release=resolve});
    if(n===2)throw Error('uncertain human delivery');
    return {status:'accepted'};
  }});} finally {release?.();}
});


test('busy calls steer with priority and distinct source receipts; late old call cannot answer the next turn', {timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Priority call'),agent=await f.createIdleAgent(chat,'Call partner');
  let session=await f.hold(agent.id);const originalRun=(await f.detail(agent.id)).runs[0].id;
  const coord=new CoordinationV3Store(store.sqlite);
  const worker=await f.createIdleAgent(chat,'Inert task worker');
  const delegated=f.ok(await f.tool(session,'ponderosa_coordinate',{idempotencyKey:'call-task-delegation',requests:[{recipientAgentId:worker.id,text:'Complete synthetic task prerequisite',lifetime:{kind:'indefinite'}}]}));
  await until(()=>coord.getRequest(delegated.requestIds[0])?.state==='completed','synthetic prerequisite completed');
  // Consume the canonical outcome on the real continuation before claiming
  // final delivery; a call must preserve this result-integration barrier.
  f.plans.set(agent.id,[{hold:true}]);session.finish();
  await until(()=>f.turns.filter(turn=>turn.agentId===agent.id).length===2,'task continuation consumes prerequisite');
  session=f.sessions.get(agent.id);
  const run=coord.activeAgentRun(agent.id).id;assert.notEqual(run,originalRun);
  assert.ok(coord.requiredReplyObligationsForRun(run).some(o=>o.deliveryPhase==='final'&&o.state==='pending'),'tracked delegation preserves original final delivery');
  const send=async key=>f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{
   text:`Synthetic call ${key}`,idempotencyKey:key,recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  const first=await send('call-one');
  const firstId=first.message.communicationEventId;
  const firstActivation=coord.runtimeCommunicationForEvent(firstId,agent.id).activations[0].id;
  const firstRow=store.sqlite.prepare('SELECT priority,dispatch_policy FROM agent_activations WHERE id=?').get(firstActivation);
  assert.equal(firstRow.priority,110);assert.equal(firstRow.dispatch_policy,'steer_or_run');
  const injection=await until(()=>{const i=coord.promptInjectionForActivation(run,firstActivation);return i?.state==='acknowledged'&&i;},'first call steering acknowledged');
  assert.deepEqual(coord.activationIdsForInjection(injection.id,run),[firstActivation]);
  assert.match(f.steers.at(-1).input.prompt,/CURRENT CALL TURN/);
  const oldArgs={intent:'direct_to_user',text:'First exact answer',steeringInjectionId:injection.id};
  const answer=f.ok(await f.tool(session,'ponderosa_message',oldArgs));
  const firstObligation=coord.requiredReplyObligationsForRun(run).find(o=>o.sourceActivationId===firstActivation);
  assert.equal(firstObligation.satisfiedCommunicationId,answer.eventId);
  assert.ok(coord.requiredReplyObligationsForRun(run).some(o=>o.sourceActivationId!==firstActivation&&o.state==='pending'),'original task remains unfinished');
  const second=await send('call-two'),secondId=second.message.communicationEventId;
  const secondActivation=coord.runtimeCommunicationForEvent(secondId,agent.id).activations[0].id;
  const later=await until(()=>{const i=coord.promptInjectionForActivation(run,secondActivation);return i?.state==='acknowledged'&&i;},'second call steering acknowledged');
  assert.notEqual(later.id,injection.id);
  const oldReplay=f.ok(await f.tool(session,'ponderosa_message',oldArgs));
  assert.equal(oldReplay.eventId,answer.eventId,'an exact old replay returns only its existing receipt');
  assert.notEqual((await f.tool(session,'ponderosa_message',{...oldArgs,text:'Late unpublished first-call answer'})).status,200,'an unpublished stale first-call response is fenced');
  assert.equal(coord.requiredReplyObligationsForRun(run).find(o=>o.sourceActivationId===secondActivation).state,'pending');
  let status=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${secondId}/${agent.id}`));
  assert.equal(status.canonicalReplyEventId,undefined,'first reply cannot satisfy second call');
  const secondAnswer=f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Second exact answer',steeringInjectionId:later.id}));
  status=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${secondId}/${agent.id}`));
  assert.equal(status.canonicalReplyEventId,secondAnswer.eventId);
  assert.notEqual(status.canonicalReplyEventId,answer.eventId);
  const repeated=f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Second exact answer',steeringInjectionId:later.id}));
  assert.equal(repeated.eventId,secondAnswer.eventId,'same call response remains idempotent');
  assert.ok(coord.requiredReplyObligationsForRun(run).some(o=>o.sourceActivationId!==firstActivation&&o.sourceActivationId!==secondActivation&&o.state==='pending'));
  f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Original task complete',taskDelivery:'final',steeringInjectionId:later.id}));
  const replay=await send('call-two');assert.equal(replay.message.communicationEventId,secondId);
  assert.equal((await f.detail(agent.id)).runs.length,2,'both calls steer the existing continuation without another Run');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
