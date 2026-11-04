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
    f.plans.set(target.id,[{hold:true}]);
    session.finish();
    await until(()=>f.turns.filter(turn=>turn.agentId===target.id).length>=2,'following Run starts');
    assert.equal(coordination.getRequest(requestId).state,'open');
    const input=f.turns.filter(turn=>turn.agentId===target.id).at(-1);
    assert.ok(JSON.stringify(input).includes(requestId));
    assert.ok(JSON.stringify(input).includes('Handle the new Request'));
    const next=f.sessions.get(target.id);
    const done=await f.tool(next,'ponderosa_update_request',{requestId,text:'Completed once'});
    assert.equal(done.status,200,JSON.stringify(done));
    assert.equal(coordination.getRequest(requestId).state,'completed');
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM coordination_request_updates WHERE request_id=? AND kind='completed'").get(requestId).count,1);
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
