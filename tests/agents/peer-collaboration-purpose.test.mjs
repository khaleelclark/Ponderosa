import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentStore,CoordinationV3Store} from '@ponderosa/agents';
import {PONDEROSA_COORDINATE_TOOL, PONDEROSA_MESSAGE_TOOL} from '@ponderosa/core';
import {withFixture,until} from '../shared/fixture.mjs';

const sendPeer=(f,s,id,text,extra={})=>f.tool(s,'ponderosa_message',{intent:'collaboration',recipientAgentIds:[id],text,idempotencyKey:randomUUID(),...extra});
const steerRows=(store,run)=>store.sqlite.prepare("SELECT * FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' ORDER BY sequence").all(run);
const createRequest=(coordination,chat,sender,target)=>coordination.coordinate({projectId:chat.projectId,conversationId:chat.id,requesterAgentId:sender.id,actorScope:'user:local-operator',idempotencyKey:randomUUID(),requests:[{recipientAgentId:target.id,payload:{text:'Original tracked task'},lifetime:{kind:'indefinite'}}]}).requestIds[0];
const messageActivation=(store,eventId)=>store.sqlite.prepare("SELECT * FROM agent_activations WHERE dedupe_key LIKE ?").get(`communication:${eventId}:%`);

test('agent tool guidance describes tracked steering and visible noninterrupting progress',()=>{
 assert.match(PONDEROSA_COORDINATE_TOOL.description,/steer a busy Agent/);
 assert.doesNotMatch(PONDEROSA_COORDINATE_TOOL.description,/never steer/);
 assert.match(PONDEROSA_MESSAGE_TOOL.description,/messagePurpose instruction or question/);
 assert.match(PONDEROSA_MESSAGE_TOOL.description,/progress or fyi/);
});

test('actionable collaboration steers by default while marked progress and FYIs remain visible and noninterrupting',{timeout:30000},async t=>{
 let store;await withFixture(t,async f=>{
  const chat=await f.createChat('Classified collaboration'),a=await f.createIdleAgent(chat,'Sender'),b=await f.createIdleAgent(chat,'Recipient');
  const sender=await f.hold(a.id),target=await f.hold(b.id),targetRun=(await f.detail(b.id)).runs[0].id;
  const coordination=new CoordinationV3Store(store.sqlite),beforeObligations=coordination.requiredReplyObligationsForRun(targetRun).length;
  const key=randomUUID();
  const progress=await sendPeer(f,sender,b.id,'Visible progress',{messagePurpose:'progress',idempotencyKey:key});
  const fyi=await sendPeer(f,sender,b.id,'Visible FYI',{messagePurpose:'fyi'});
  assert.equal(progress.status,200,JSON.stringify(progress));assert.equal(fyi.status,200,JSON.stringify(fyi));
  assert.equal(messageActivation(store,progress.body.eventId).dispatch_policy,'next_run');
  assert.equal(messageActivation(store,fyi.body.eventId).dispatch_policy,'next_run');
  assert.equal(steerRows(store,targetRun).length,0);
  const shared=f.ok(await f.api('GET',`/api/conversations/${chat.id}/collaboration`));
  assert.ok(JSON.stringify(shared).includes('Visible progress'));assert.ok(JSON.stringify(shared).includes('Visible FYI'));
  const conflict=await sendPeer(f,sender,b.id,'Visible progress',{messagePurpose:'instruction',idempotencyKey:key});
  assert.notEqual(conflict.status,200,'same key cannot change delivery purpose');
  const information=f.ok(await f.tool(sender,'ponderosa_message',{delivery:'next_run',recipientAgentIds:[b.id],text:'Passive next Run only',idempotencyKey:randomUUID()}));
  assert.ok(information);assert.equal(steerRows(store,targetRun).length,0);
  const defaultAsk=await sendPeer(f,sender,b.id,'Please check this',{urgency:'ordinary'});
  assert.equal(defaultAsk.status,200,JSON.stringify(defaultAsk));
  await until(()=>steerRows(store,targetRun).some(row=>row.state==='acknowledged'),'unmarked instruction steers');
  assert.equal(messageActivation(store,defaultAsk.body.eventId).dispatch_policy,'steer_or_run');
  const legacyProgress=await sendPeer(f,sender,b.id,'Legacy unmarked progress');
  assert.equal(legacyProgress.status,200,JSON.stringify(legacyProgress));
  await until(()=>steerRows(store,targetRun).filter(row=>row.state==='acknowledged').length===2,'unmarked progress also steers');
  assert.equal(coordination.requiredReplyObligationsForRun(targetRun).length,beforeObligations,'peer sends create no automatic reply obligation');
  assert.equal(f.steers.filter(item=>item.agentId===a.id).length,0,'no automatic return steer');
  const originalReply=await f.tool(sender,'ponderosa_message',{intent:'direct_to_user',text:'An operator reply'});
  assert.equal(originalReply.status,200,JSON.stringify(originalReply));
  target.finish();sender.finish();
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('a worker can steer its busy tracked Request sender with a question; marked progress stays passive',{timeout:30000},async t=>{
 let store;await withFixture(t,async f=>{
  const chat=await f.createChat('Question requester'),manager=await f.createIdleAgent(chat,'Manager'),worker=await f.createIdleAgent(chat,'Worker');
  const managerSession=await f.hold(manager.id),managerRun=(await f.detail(manager.id)).runs[0].id;
  const coordination=new CoordinationV3Store(store.sqlite);f.plans.set(worker.id,[{hold:true}]);
  const requestId=createRequest(coordination,chat,manager,worker);
  await until(()=>f.turns.some(turn=>turn.agentId===worker.id),'worker accepts Request');
  const session=f.sessions.get(worker.id),before=coordination.requiredReplyObligationsForRun(managerRun).length;
  const progress=await sendPeer(f,session,manager.id,'Working on it',{messagePurpose:'progress'});
  assert.equal(progress.status,200,JSON.stringify(progress));assert.deepEqual(progress.body.passiveRecipientAgentIds,[manager.id]);
  assert.equal(steerRows(store,managerRun).length,0);
  const question=await sendPeer(f,session,manager.id,'Which choice should I use?',{messagePurpose:'question'});
  assert.equal(question.status,200,JSON.stringify(question));
  await until(()=>steerRows(store,managerRun).some(row=>row.state==='acknowledged'),'question steers requester');
  const plain=await sendPeer(f,session,manager.id,'Please clarify the other choice');
  assert.equal(plain.status,200,JSON.stringify(plain));
  await until(()=>steerRows(store,managerRun).filter(row=>row.state==='acknowledged').length===2,'unmarked ask steers requester');
  assert.equal(coordination.getRequest(requestId).state,'open');
  assert.equal(coordination.requiredReplyObligationsForRun(managerRun).length,before,'peer message creates no automatic reply obligation');
  session.finish();managerSession.finish();
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('a peer instruction fences a delayed result for the existing Request',{timeout:30000},async t=>{
 let store;await withFixture(t,async f=>{
  const chat=await f.createChat('Peer steer fence'),manager=await f.createIdleAgent(chat,'Manager'),worker=await f.createIdleAgent(chat,'Worker'),peer=await f.createIdleAgent(chat,'Peer');
  const peerSession=await f.hold(peer.id),coordination=new CoordinationV3Store(store.sqlite);
  f.plans.set(worker.id,[{hold:true}]);const requestId=createRequest(coordination,chat,manager,worker);
  await until(()=>f.turns.some(turn=>turn.agentId===worker.id),'worker starts Request');
  const session=f.sessions.get(worker.id),run=(await f.detail(worker.id)).runs[0].id,old={requestId,text:'Old prepared result'};
  const sent=await sendPeer(f,peerSession,worker.id,'Change the work direction',{messagePurpose:'instruction'});
  assert.equal(sent.status,200,JSON.stringify(sent));
  const injection=await until(()=>steerRows(store,run).find(row=>row.state==='acknowledged'),'peer instruction acknowledged');
  assert.notEqual((await f.tool(session,'ponderosa_update_request',old)).status,200);
  const error=await f.tool(session,'ponderosa_message',{text:'Stale old answer'});
  assert.notEqual(error.status,200);assert.equal(JSON.stringify(error).includes(injection.id),false);
  assert.notEqual((await f.tool(session,'ponderosa_update_request',old)).status,200,'ordinary error does not enable stale retry');
  assert.equal(coordination.getRequest(requestId).state,'open');
  const current=await f.tool(session,'ponderosa_update_request',{...old,steeringInjectionId:injection.id});
  assert.equal(current.status,200,JSON.stringify(current));
  session.finish();peerSession.finish();
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('human and actionable peer input do not share an uncertain steering submission',{timeout:30000},async t=>{
 let store,release,calls=0;
 try {await withFixture(t,async f=>{
  const chat=await f.createChat('Peer and human steering'),a=await f.createIdleAgent(chat,'Sender'),b=await f.createIdleAgent(chat,'Recipient');
  const sender=await f.hold(a.id),target=await f.hold(b.id),run=(await f.detail(b.id)).runs[0].id;
  await f.send(b.id,'First held steer');await until(()=>calls===1,'first steer held');
  await f.send(b.id,'Human interruption');
  const peer=await sendPeer(f,sender,b.id,'Peer instruction',{messagePurpose:'instruction'});
  assert.equal(peer.status,200,JSON.stringify(peer));release();
  const rows=await until(()=>{const rows=steerRows(store,run);return rows.length===3&&rows[1].state==='outcome_unknown'&&rows[2].state==='acknowledged' ? rows : false;},'human held and peer delivered');
  const human=JSON.parse(rows[1].activation_ids_json),peerIds=JSON.parse(rows[2].activation_ids_json);
  assert.equal(human.length,1);assert.equal(peerIds.length,1);
  assert.equal(store.sqlite.prepare('SELECT prompt_class FROM agent_activations WHERE id=?').get(human[0]).prompt_class,'human');
  assert.equal(store.sqlite.prepare('SELECT kind FROM agent_activations WHERE id=?').get(peerIds[0]).kind,'ordinary_message');
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(human[0]).state,'outcome_unknown');
  assert.equal(calls,3);target.finish();sender.finish();
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{const n=++calls;if(n===1)await new Promise(resolve=>{release=resolve});if(n===2)throw Error('uncertain human steering');return {status:'accepted'};}});
 } finally {release?.();}
});

for(const urgency of ['ordinary','urgent']) for(const result of ['unsupported','unknown']) test(`${result} ${urgency} peer steering is not repeatedly sent`,{timeout:30000},async t=>{
 let store,calls=0;await withFixture(t,async f=>{
  const chat=await f.createChat('Peer steering failure'),a=await f.createIdleAgent(chat,'Sender'),b=await f.createIdleAgent(chat,'Recipient');
  const sender=await f.hold(a.id),target=await f.hold(b.id),run=(await f.detail(b.id)).runs[0].id;
  const peer=await sendPeer(f,sender,b.id,'Preserve this instruction',{messagePurpose:'instruction',urgency});
  assert.equal(peer.status,200,JSON.stringify(peer));
  if(result==='unsupported'){
   await until(()=>messageActivation(store,peer.body.eventId)?.steering_wait_reason==='provider_unsupported','unsupported provider recorded');
   await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(calls,1);
   const activation=messageActivation(store,peer.body.eventId);
   assert.equal(activation.dispatch_policy,'next_run');
   if(urgency==='urgent'){
    assert.equal(activation.kind,'urgent_message');assert.equal(activation.priority,90);assert.equal(activation.prompt_class,'blocker');
   }
   const receipts=f.ok(await f.api('POST',`/api/conversations/${chat.id}/message-delivery-receipts`,{communicationEventIds:[peer.body.eventId],activationIds:[]}));
   assert.equal(receipts.items[0].deliveryReceipts[0].steeringWaitReason,'provider_unsupported');
   f.plans.set(b.id,[{hold:true}]);target.finish();
   await until(()=>f.turns.filter(turn=>turn.agentId===b.id).length>=2,'following Run starts');
   const prompt=f.turns.filter(turn=>turn.agentId===b.id).at(-1).input.prompt;
   assert.equal(prompt.split('Preserve this instruction').length-1,1,'one exact authored instruction reaches the next Run');
   assert.equal(prompt.includes('[CURRENT INPUT · URGENT PEER MESSAGE]'),urgency==='urgent','provider input preserves only the urgent peer classification');
   const humanInput=f.turns.find(turn=>turn.agentId===a.id).input.prompt;
   assert.equal(humanInput.includes('[CURRENT INPUT · URGENT PEER MESSAGE]'),false,'human input is unchanged');
   f.sessions.get(b.id).finish();
  }else{
   await until(()=>messageActivation(store,peer.body.eventId)?.state==='outcome_unknown','uncertain peer delivery held');
   await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(calls,1);
   assert.equal(steerRows(store,run).at(-1).state,'outcome_unknown');target.finish();
  }
  sender.finish();
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{calls++;if(result==='unknown')throw Error('uncertain provider result');return {status:'unsupported'};}});
});

test('a sole urgent peer message starting an idle agent retains its urgency in the provider input',{timeout:30000},async t=>{
 let store;await withFixture(t,async f=>{
  const chat=await f.createChat('Urgent peer input'),a=await f.createIdleAgent(chat,'Sender'),b=await f.createIdleAgent(chat,'Recipient');
  const sender=await f.hold(a.id);f.plans.set(b.id,[{hold:true}]);
  const sent=await sendPeer(f,sender,b.id,'Urgent original text',{messagePurpose:'instruction',urgency:'urgent'});
  assert.equal(sent.status,200,JSON.stringify(sent));
  await until(()=>f.turns.some(turn=>turn.agentId===b.id),'urgent peer Run starts');
  const input=f.turns.find(turn=>turn.agentId===b.id).input.prompt;
  assert.ok(input.includes('[CURRENT INPUT · URGENT PEER MESSAGE]'));
  assert.equal(input.split('Urgent original text').length-1,1);
  const activation=messageActivation(store,sent.body.eventId);
  assert.equal(activation.priority,90);assert.equal(activation.kind,'urgent_message');
  assert.equal(f.turns.find(turn=>turn.agentId===a.id).input.prompt.includes('[CURRENT INPUT · URGENT PEER MESSAGE]'),false);
  f.sessions.get(b.id).finish();sender.finish();
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
