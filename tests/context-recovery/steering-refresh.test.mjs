import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withFixture,until} from '../shared/fixture.mjs';
import {AgentStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';
const evidence=[];
for(const pressure of [false,true])test(`human steering ${pressure?'after pending refresh':'without refresh control'}`,{timeout:15000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Refresh steering fixture'),agent=await f.createIdleAgent(chat,'Controlled worker'),session=await f.hold(agent.id);
  const sourceRun=(await f.detail(agent.id)).runs[0].id;
  if(pressure){
   session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190000,windowTokens:200000});
   await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'pending refresh');
  }
  const before=f.steers.length;
  const accepted=f.ok(await f.api('POST',`/api/agents/${agent.id}/messages`,{text:'Stop repeating tests; inspect the requested artifact.',activeRunDelivery:'steer',idempotencyKey:randomUUID()}));
  const delivery=()=>f.api('GET',`/api/agents/${agent.id}`).then(f.ok).then(detail=>detail.messages.find(m=>m.communicationEventId===accepted.communicationEventId)?.deliveryReceipts?.[0]);
  let failure;
  try{await until(()=>f.steers.length>before,'correctly authored human steering reaches active provider',1500);}catch(error){failure=error;}
  const receipt=await delivery();
  const current=store.sqlite.prepare('SELECT id,status FROM scheduler_runs WHERE id=?').get(sourceRun);
  const rollover=store.sqlite.prepare('SELECT state,source_run_id FROM context_rollovers WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(agent.id);
  const handoff=store.sqlite.prepare("SELECT state,dispatch_policy FROM agent_activations WHERE agent_id=? AND kind='context_rollover_handoff' ORDER BY rowid DESC LIMIT 1").get(agent.id);
  // An actual controlled provider command still works while this source Run is held.
  const command=await session.invokeCommand('fixture-progress','');
  evidence.push({pressure,acceptedEvent:accepted.communicationEventId,sourceRun,current,rollover,handoff,receipt,providerSteers:f.steers.length-before,command,assertion:failure?.message??'delivered'});

  assert.equal(current.status,'running');assert.equal(command.message,'Controlled command completed');
  if(failure)throw failure;
  assert.equal(receipt.providerAcknowledged,true);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('late canonical steering survives isolated handoff and actual replacement without queued/private input', {timeout:30000}, async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Late steering retirement'), agent=await f.createIdleAgent(chat,'Worker');
  const other=await f.createIdleAgent(chat,'Private other');
  await f.send(other.id,'Other private message must not enter replacement'); await f.settled(other.id);
  const managerSession=await f.hold(other.id);
  f.plans.set(agent.id,[{hold:true}]);
  f.ok(await f.tool(managerSession,'ponderosa_coordinate',{recipientAgentId:agent.id,text:'Original tracked task must preserve its exact requester'}));
  await until(()=>f.sessions.get(agent.id),'tracked source Run');
  const session=f.sessions.get(agent.id);
  const sourceRun=(await f.detail(agent.id)).runs[0].id;
  const originalRequest=store.sqlite.prepare("SELECT source.source_id FROM scheduler_run_activations attached JOIN activation_sources source ON source.activation_id=attached.activation_id WHERE attached.run_id=? AND source.source_kind='request'").get(sourceRun).source_id;
  session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190000,windowTokens:200000});
  const rollover=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'requested rollover');
  let invalidBinderCalled=false;
  assert.throws(()=>new CoordinationV3Store(store.sqlite).rebindContextRolloverHandoffBoundary({
    id:rollover.id,handoffRunId:sourceRun,fencingToken:0,
    bind:()=>{invalidBinderCalled=true;throw Error('must not bind');},
  }),/exact live handoff/);
  assert.equal(invalidBinderCalled,false);
  assert.equal(store.sqlite.prepare('SELECT recent_tail_event_ids_json FROM context_rollovers WHERE id=?').get(rollover.id).recent_tail_event_ids_json,rollover.recent_tail_event_ids_json);
  await f.send(agent.id,'First correction can be answered before the later correction',{activeRunDelivery:'steer'});
  await until(()=>f.steers.length===1,'first correction');
  f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'First correction acknowledged',steeringInjectionId:f.steers[0].input.clientMessageId}));
  assert.equal(store.sqlite.prepare('SELECT visible_response_committed FROM context_rollovers WHERE id=?').get(rollover.id).visible_response_committed,1);
  const late=await f.send(agent.id,'Late canonical correction: preserve marker late-steer-exact and finish on my private route.',{activeRunDelivery:'steer'});
  await until(()=>f.steers.length===2,'live steering');
  const lateActivation=store.sqlite.prepare("SELECT source.activation_id FROM activation_sources source JOIN runtime_communications runtime ON runtime.id=source.source_id WHERE source.source_kind='communication' AND json_extract(runtime.payload_json,'$.communication.eventId')=?").get(late.communicationEventId).activation_id;
  const queued=await f.send(agent.id,'Explicit queued future instruction must stay separate',{activeRunDelivery:'queue'});
  assert.equal(store.sqlite.prepare("SELECT activation.dispatch_policy FROM agent_activations activation JOIN activation_sources source ON source.activation_id=activation.id JOIN runtime_communications runtime ON runtime.id=source.source_id WHERE json_extract(runtime.payload_json,'$.communication.eventId')=? AND source.source_kind='communication'").get(queued.communicationEventId).dispatch_policy,'next_run');
  // Repeated pressure after late input remains the same refresh cycle.
  session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190001,windowTokens:200000});
  let replacementRun;
  f.plans.set(agent.id,[{output:false,run:async(s)=>{
    assert.equal(s.engineAgentId,session.engineAgentId);
    assert.equal(f.steers.length,2);
    s.events.push({type:'text',delta:'Continue the unfinished private task, preserving its latest canonical correction and exact reply route. No external changes were made.'});
  }},{output:false,run:async(s,input,turn)=>{
    assert.notEqual(s.engineAgentId,session.engineAgentId);
    const serialized=JSON.stringify(turn);
    assert.match(serialized,/late-steer-exact/);
    assert.ok(!serialized.includes('Other private message must not enter replacement'));
    assert.ok(!serialized.includes('Explicit queued future instruction must stay separate'));
    const current=store.sqlite.prepare('SELECT * FROM context_rollovers WHERE id=?').get(rollover.id);
    assert.ok(JSON.parse(current.source_activation_ids_json).includes(lateActivation));
    assert.equal(current.visible_response_committed,1,'Earlier committed response remains historical fact');
    const tail=JSON.parse(current.recent_tail_event_ids_json), hashes=JSON.parse(current.recent_tail_hashes_json);
    assert.ok(tail.includes(late.communicationEventId));
    for(let i=0;i<tail.length;i++)assert.equal(hashes[i],store.sqlite.prepare('SELECT content_sha256 FROM compaction_history_messages WHERE communication_event_id=?').get(tail[i]).content_sha256);
    assert.ok(!tail.includes(queued.communicationEventId));
    assert.ok(store.sqlite.prepare("SELECT 1 FROM activation_sources WHERE activation_id=? AND source_kind='request' AND source_id=?").get(current.continuation_activation_id,originalRequest));
    replacementRun=current.replacement_run_id;
    s.events.push({type:'context_usage',providerSessionId:s.engineAgentId,providerSessionGeneration:s.engineAgentId,usedTokens:1000,windowTokens:200000});
    await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state='completed'").get(rollover.id),'verified replacement');
    f.ok(await f.tool(s,'ponderosa_message',{intent:'direct_to_user',text:'Latest canonical correction completed'}));
    f.ok(await f.tool(s,'ponderosa_update_request',{text:'Tracked result retained on original requester route'}));
  }}]);
  session.finish();
  await until(()=>replacementRun,'replacement executed');
  await f.settled(agent.id);
  const detail=await f.detail(agent.id);
  const reply=detail.messages.filter(m=>m.text==='Latest canonical correction completed');
  assert.equal(reply.length,1);
  assert.equal(store.getCommunicationEvent(chat.projectId,reply[0].communicationEventId).intent,'user_dm');
  assert.equal(store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(originalRequest).state,'completed');
  assert.equal(session.isAlive(),false);
  assert.equal(f.steers.length,2,'No duplicate live delivery');
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1,'No refresh loop');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('cancellation during requested refresh fences late source output and prevents replacement', {timeout:15000}, async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Refresh cancellation'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const run=(await f.detail(agent.id)).runs[0];
  session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190000,windowTokens:200000});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'refresh requested');
  await f.send(agent.id,'Valid correction before exact cancellation',{activeRunDelivery:'steer'});await until(()=>f.steers.length===1,'accepted correction');
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:randomUUID(),idempotencyKey:randomUUID()})).status,409);
  f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:run.id,idempotencyKey:randomUUID()}));
  const rejected=await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Forbidden late publication'});assert.notEqual(rejected.status,200);
  await until(()=>!session.isAlive(),'cancelled source process drained');
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run.id).status,'cancelled');
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM context_rollovers WHERE agent_id=? AND state IN ('requested','handoff_committed','session_retiring','continuation_ready')").get(agent.id).n,0);
  assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,1);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('separate handoff Run never admits task steering into its output contract', {timeout:15000}, async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Isolated handoff'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190000,windowTokens:200000});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'refresh requested');
  f.plans.set(agent.id,[{hold:true}]);session.finish();
  await until(()=>f.turns.filter(turn=>turn.agentId===agent.id).length===2,'isolated held handoff');
  const accepted=await f.send(agent.id,'Correction arriving after source completion',{activeRunDelivery:'steer'});
  const receipt=(await f.detail(agent.id)).messages.find(m=>m.communicationEventId===accepted.communicationEventId).deliveryReceipts[0];
  assert.equal(receipt.steeringWaitReason,'context_refresh');
  assert.equal(f.steers.length,0);
  const coord=new CoordinationV3Store(store.sqlite);
  assert.equal(coord.leaseNextSteering({workerId:'must-not-steer-handoff'}),undefined);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('a known rejected steer remains queued and cannot enter the handoff snapshot', {timeout:15000}, async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Rejected steering'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190000,windowTokens:200000});
  const rollover=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'refresh requested');
  const rejected=await f.send(agent.id,'Known undelivered steering must remain future work',{activeRunDelivery:'steer'});
  const receipt=await until(async()=>{
    const row=(await f.detail(agent.id)).messages.find(m=>m.communicationEventId===rejected.communicationEventId).deliveryReceipts[0];
    return row.steeringWaitReason==='provider_unsupported' && row;
  },'known provider steering refusal');
  assert.notEqual(receipt.providerAcknowledged,true);
  f.plans.set(agent.id,[{hold:true}]);session.finish();
  await until(()=>f.turns.filter(turn=>turn.agentId===agent.id).length===2,'held handoff after refusal');
  const final=store.sqlite.prepare('SELECT * FROM context_rollovers WHERE id=?').get(rollover.id);
  assert.ok(!JSON.parse(final.source_activation_ids_json).includes(receipt.activationId));
  assert.ok(!JSON.parse(final.recent_tail_event_ids_json).includes(rejected.communicationEventId));
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(receipt.activationId).state,'retry_pending');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>({status:'unsupported'})});
});

test('uncertain human steering holds recovery without canceling the original task or replaying it',{timeout:20000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Uncertain steering hold'),agent=await f.createIdleAgent(chat,'Controlled worker');
  const session=await f.hold(agent.id),sourceRun=(await f.detail(agent.id)).runs[0].id;
  const sent=await f.send(agent.id,'Inspect the exact harmless fixture state',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(sourceRun),'unknown steering');
  const receipt=()=>f.detail(agent.id).then(d=>d.messages.find(m=>m.communicationEventId===sent.communicationEventId)?.deliveryReceipts?.[0]);
  const initial=await until(async()=>{const r=await receipt();return r?.state==='unconfirmed'&&r;},'visible unconfirmed delivery');
  assert.equal(initial.canLetCurrentRunFinish,true);
  const dismiss=await f.api('POST',`/api/projects/${chat.projectId}/message-deliveries/${initial.activationId}/cancel`,{idempotencyKey:randomUUID()});
  assert.equal(dismiss.status,409,'Uncertain human delivery cannot be dismissed as settled');
  const before=store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(sourceRun);
  assert.equal(before.state,'pending');
  store.sqlite.prepare("UPDATE scheduler_steering_recoveries SET recover_at='2000-01-01T00:00:00.000Z' WHERE injection_id=?").run(injection.id);
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(sourceRun).status,'running');
  assert.equal(store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(sourceRun).state,'pending');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind='steering_recovery'").get().n,0);
  const finish=f.ok(await f.api('POST',`/api/message-deliveries/${injection.id}/let-current-run-finish`,{idempotencyKey:randomUUID()}));
  assert.equal(finish.state,'waiting_for_run');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind='steering_recovery'").get().n,0);
  session.finish();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(sourceRun),'original Run finishes');
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(sourceRun).state,'pending');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind IN ('steering_recovery','required_reply_recovery')").get().n,0);
  assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,1);
  await f.reopen();
  assert.equal(store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(sourceRun).state,'pending');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind IN ('steering_recovery','required_reply_recovery')").get().n,0);
  const held=await receipt();assert.equal(held.state,'waiting_for_run');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{throw Error('Controlled unconfirmed steering');}});
});

test('an initial reply remains interim when later human steering is unconfirmed',{timeout:15000},async t=>{
 let store,release;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Steer during prior reply'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const run=(await f.detail(agent.id)).runs[0].id;
  const sent=await f.tool(session,'ponderosa_message',{text:'The initial work is underway'});
  assert.equal(sent.status,200,JSON.stringify(sent));
  const initial=store.sqlite.prepare('SELECT state,delivery_phase,satisfied_communication_id FROM required_reply_obligations WHERE run_id=?').get(run);
  assert.equal(initial.state,'satisfied');assert.equal(initial.delivery_phase,'initial');
  f.plans.set(agent.id,[]);
  await f.send(agent.id,'Later instruction with uncertain delivery',{activeRunDelivery:'steer'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='submitted'").get(run),'steer submitted');
  assert.equal(store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(run).state,'satisfied');
  release();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'steer outcome unknown');
  const held=store.sqlite.prepare('SELECT state,delivery_phase,interim_communication_id FROM required_reply_obligations WHERE run_id=?').get(run);
  assert.equal(held.state,'pending');assert.equal(held.delivery_phase,'final');assert.equal(held.interim_communication_id,initial.satisfied_communication_id);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{await new Promise(resolve=>{release=resolve});throw Error('Controlled unconfirmed steer');}});
});

test('a stale reply during submitted human steering cannot complete the original objective',{timeout:15000},async t=>{
 let store,release;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Steer reply race'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const run=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'A later human correction',{activeRunDelivery:'steer'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='submitted'").get(run),'steer submitted');
  const old=await f.tool(session,'ponderosa_message',{text:'A prior work update'});
  assert.equal(old.status,200,JSON.stringify(old));
  assert.equal(store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(run).state,'pending');
  release();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'steer unknown');
  assert.equal(store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=?').get(run).state,'pending');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{await new Promise(resolve=>{release=resolve});throw Error('Controlled ambiguous steer');}});
});

test('restart with a submitted human steer holds the original reply and refuses replay',{timeout:15000},async t=>{
 let store,release;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Orphaned steer'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const run=(await f.detail(agent.id)).runs[0].id;
  const initial=await f.tool(session,'ponderosa_message',{text:'Initial progress'});
  assert.equal(initial.status,200,JSON.stringify(initial));
  const correction=await f.send(agent.id,'Correction whose acceptance is uncertain',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='submitted'").get(run),'steer submitted');
  const coordination=new CoordinationV3Store(store.sqlite);
  assert.equal(coordination.recoverOrphanedRuns('fixture-new-owner').outcomeUnknown,1);
  const root=store.sqlite.prepare('SELECT state,delivery_phase,interim_communication_id FROM required_reply_obligations WHERE run_id=?').get(run);
  assert.equal(root.state,'pending');assert.equal(root.delivery_phase,'final');assert.ok(root.interim_communication_id);
  assert.equal(store.sqlite.prepare("SELECT state FROM scheduler_prompt_injections WHERE id=?").get(injection.id).state,'outcome_unknown');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM scheduler_steering_recoveries WHERE injection_id=?").get(injection.id).n,0);
  const view=(await f.detail(agent.id)).messages.find(m=>m.communicationEventId===correction.communicationEventId).deliveryReceipts[0];
  assert.equal(view.state,'unconfirmed');assert.notEqual(view.canRetry,true);
  // A newer acknowledgement for the same source must not hide an older
  // unresolved steering submission from the replay admission guard.
  store.sqlite.prepare(`INSERT INTO scheduler_prompt_injections
    (id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,acknowledged_at)
    VALUES (?,?,'turn',999,'acknowledged','fixture',?,?,?,?)`)
    .run(randomUUID(),run,JSON.stringify([view.activationId]),'9999-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z');
  const retry=await f.api('POST',`/api/projects/${chat.projectId}/message-deliveries/${view.activationId}/retry`,{idempotencyKey:randomUUID()});
  assert.equal(retry.status,409);
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind IN ('steering_recovery','required_reply_recovery')").get().n,0);
  release();
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{await new Promise(resolve=>{release=resolve});throw Error('Controlled ambiguous steer');}});
});

test('legacy mixed-source uncertain recoveries stay held while unrelated work remains leasable',{timeout:15000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Legacy steering recovery'),agent=await f.createIdleAgent(chat,'Worker');
  await f.hold(agent.id);
  const run=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'Unconfirmed human steer',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'unknown steer');
  const human=JSON.parse(injection.activation_ids_json)[0],coordination=new CoordinationV3Store(store.sqlite);
  const now=new Date().toISOString(),scopeKey=`conversation:${chat.id}`;
  const add=(id,kind)=>coordination.enqueueMessageActivation({projectId:chat.projectId,agentId:agent.id,scopeKey,messageId:id,kind,payload:{text:id},now});
  const peer=add('legacy-peer-source','ordinary');
  const humanRetry=add('legacy-human-recovery','human'),peerRetry=add('legacy-peer-recovery','ordinary');
  for(const id of [humanRetry,peerRetry])store.sqlite.prepare("UPDATE agent_activations SET kind='steering_recovery' WHERE id=?").run(id);
  store.sqlite.prepare('UPDATE scheduler_prompt_injections SET activation_ids_json=? WHERE id=?').run(JSON.stringify([human,peer]),injection.id);
  store.sqlite.prepare("UPDATE scheduler_steering_recoveries SET state='recovery_queued' WHERE injection_id=?").run(injection.id);
  const mapping=store.sqlite.prepare('INSERT INTO scheduler_steering_recovery_activations(injection_id,source_activation_id,recovery_activation_id) VALUES(?,?,?)');
  mapping.run(injection.id,human,humanRetry);mapping.run(injection.id,peer,peerRetry);
  // Simulate a peer member that was already attached to the old injection.
  store.sqlite.prepare("UPDATE agent_activations SET state='outcome_unknown' WHERE id=?").run(peer);
  const unrelated=add('independent-future-work','human');
  const fence=store.sqlite.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=?').get(run).fencing_token;
  coordination.completeRun(run,fence,now);
  const lease=coordination.leaseNextRun({workerId:'controlled-review',now});
  assert.ok(lease,'An unrelated eligible activation must not be starved');
  assert.ok(lease.activationIds.includes(unrelated));
  assert.ok(!lease.activationIds.includes(humanRetry)&&!lease.activationIds.includes(peerRetry));
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(humanRetry).state,'pending');
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(peerRetry).state,'pending');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{throw Error('Controlled ambiguous steer');}});
});
