import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { ReviewedSteeringAuthority } from '../../packages/agents/dist/coordination-v3-reviewed-steering.js';
import { payloadHash } from '../../packages/agents/dist/coordination-v3-canonical-json.js';
import { withFixture, until, runtimeAttachmentPaths } from '../shared/fixture.mjs';
import { inertCodex } from '../shared/inert-codex.mjs';

test('unqualified provider holds a reviewed continuation without retry or relabeling the original outcome',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Reviewed interruption'), agent=await f.createIdleAgent(chat,'Controlled worker');
  const upload=async(name,content)=>f.ok(await f.api('POST',`/api/agents/${agent.id}/attachments`,Buffer.from(content),
    {'content-type':'application/octet-stream','x-ponderosa-filename':name,'x-ponderosa-media-type':'text/plain'}));
  const originalAsset=await upload('original.txt','original fixture bytes'), steerAsset=await upload('steer.txt','correction fixture bytes');
  f.plans.set(agent.id,[{hold:true}]);
  await f.send(agent.id,'Controlled held task',{attachmentIds:[originalAsset.id]});
  await until(()=>f.turns.some(x=>x.agentId===agent.id),'original provider input');
  const old=f.sessions.get(agent.id),sourceRun=(await f.detail(agent.id)).runs[0].id;
  const originalRoot=store.sqlite.prepare("SELECT source_activation_id FROM required_reply_obligations WHERE run_id=?").get(sourceRun).source_activation_id;
  const sent=await f.send(agent.id,'Apply this specific correction',{activeRunDelivery:'steer',attachmentIds:[steerAsset.id]});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(sourceRun),'unknown interruption');
  const [activationId]=JSON.parse(injection.activation_ids_json);
  old.finish();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(sourceRun),'source Run complete');
  await f.reopen();
  const path=`/api/projects/${chat.projectId}/message-deliveries/${activationId}/reviewed-continuation`;
  const view=f.ok(await f.api('GET',path));
  assert.equal(view.status,'review_required');
  assert.equal(view.review.effectInventory.nativeTail,'unknown');
  assert.equal(view.review.replayAuthorized,false);
  assert.ok(JSON.stringify(view.review.originalTask).includes('Controlled held task'));
  assert.ok(JSON.stringify(view.review.originalSteer).includes('Apply this specific correction'));
  for(const [event,asset] of [[view.review.originalTask.communication,originalAsset],[view.review.originalSteer.communication,steerAsset]]) {
   assert.equal(event.projectId,chat.projectId);assert.equal(event.conversationId,chat.id);
   assert.equal(event.sender.kind,'user');assert.equal(event.sender.userId,'local-operator');
   assert.ok(event.attachments.some(item=>item.id===asset.id && item.name===asset.name));
  }
  assert.equal((await f.api('GET',`/api/projects/foreign/message-deliveries/${activationId}/reviewed-continuation`)).status,404);
  const body={reviewSha256:view.review.reviewSha256,effectsReviewed:true,reviewNote:'Checked the visible receipts',idempotencyKey:randomUUID()};
  f.plans.set(agent.id,[{hold:true}]);
  const result=f.ok(await f.api('POST',path,body));
  assert.equal(result.status,'continuation_recorded');
  assert.equal(result.receipt.originalOutcome,'unknown');assert.equal(result.receipt.replayAuthorized,false);
  assert.equal(result.receipt.commandSha256,payloadHash({projectId:chat.projectId,activationId,...body}));
  const replay=f.ok(await f.api('POST',path,body));assert.equal(replay.receipt.activationId,result.receipt.activationId);
  assert.equal((await f.api('POST',path,{...body,reviewNote:'changed'})).status,409);
  const failed=await until(()=>store.sqlite.prepare("SELECT state,last_delivery_error FROM agent_activations WHERE id=? AND state='failed'").get(result.receipt.activationId),'unqualified provider held');
  assert.match(failed.last_delivery_error,/provider|continuation/i);
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,1,'unqualified provider receives no continuation');
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
  const linked=store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='reviewed_steering' AND source_id=?").get(injection.id);
  assert.equal(linked.n,1);
  assert.ok(store.sqlite.prepare("SELECT 1 FROM required_reply_obligations WHERE source_activation_id=? AND state IN ('pending','superseded','recovery_pending')").get(originalRoot));
  const runCount=store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n;
  await new Promise(resolve=>setTimeout(resolve,1800));
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,1,'no automatic retry after held continuation');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n,runCount,'no retry Run after held continuation');
  assert.ok(sent.communicationEventId);
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');}});
});

test('opening review can retire only the exact idle source and leaves its uncertain instruction intact',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Idle source review'),agent=await f.createIdleAgent(chat,'Worker');
  const old=await f.hold(agent.id),run=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'Unconfirmed change',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'unknown steer');
  const [activationId]=JSON.parse(injection.activation_ids_json);
  const path=`/api/projects/${chat.projectId}/message-deliveries/${activationId}/reviewed-continuation`;
  assert.equal((await f.api('POST',path+'/retire-source')).status,409,'running source must not be retired');
  assert.equal(old.isAlive(),true);
  old.finish();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(run),'source completed');
  const aliveBefore=old.isAlive();
  const preview=f.ok(await f.api('GET',path));
  assert.equal(preview.status,'source_retirement_required');assert.equal(preview.originalOutcome,'unknown');
  assert.equal(old.isAlive(),aliveBefore,'preview does not change source lifetime');
  assert.equal((await f.api('POST',`/api/projects/foreign/message-deliveries/${activationId}/reviewed-continuation/retire-source`)).status,404);
  const retired=f.ok(await f.api('POST',path+'/retire-source'));
  assert.deepEqual(retired,{status:'source_retired',originalOutcome:'unknown'});
  assert.equal(old.isAlive(),false);
  assert.equal(f.ok(await f.api('GET',path)).status,'review_required');
  assert.equal(store.sqlite.prepare("SELECT state FROM scheduler_prompt_injections WHERE id=?").get(injection.id).state,'outcome_unknown');
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,1);
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');}});
});

test('qualified Codex continues the saved task and instruction with both files and the original reply root',{timeout:30000},async t=>{
 let store, useNative=false, native;
 await withFixture(t,async f=>{
  native=await inertCodex(f.root);
  const chat=await f.createChat('Reviewed Codex transport'),agent=await f.createIdleAgent(chat,'Worker');
  const upload=async(name,content)=>f.ok(await f.api('POST',`/api/agents/${agent.id}/attachments`,Buffer.from(content),
    {'content-type':'application/octet-stream','x-ponderosa-filename':name,'x-ponderosa-media-type':'text/plain'}));
  const originalAsset=await upload('original.txt','original fixture bytes'),steerAsset=await upload('steer.txt','correction fixture bytes');
  f.plans.set(agent.id,[{hold:true}]);await f.send(agent.id,'The complete original task',{attachmentIds:[originalAsset.id]});
  await until(()=>f.turns.some(x=>x.agentId===agent.id),'source input');
  const old=f.sessions.get(agent.id),run=(await f.detail(agent.id)).runs[0].id;
  const root=store.sqlite.prepare("SELECT source_activation_id FROM required_reply_obligations WHERE run_id=?").get(run).source_activation_id;
  await f.send(agent.id,'Apply the correction',{activeRunDelivery:'steer',attachmentIds:[steerAsset.id]});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'unknown steer');
  const [sourceActivation]=JSON.parse(injection.activation_ids_json),path=`/api/projects/${chat.projectId}/message-deliveries/${sourceActivation}/reviewed-continuation`;
  old.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(run),'source complete');
  const first=f.ok(await f.api('GET',path));
  if(first.status==='source_retirement_required') f.ok(await f.api('POST',path+'/retire-source'));
  const review=f.ok(await f.api('GET',path));assert.equal(review.status,'review_required');
  useNative=true;
  const receipt=f.ok(await f.api('POST',path,{reviewSha256:review.review.reviewSha256,effectsReviewed:true,reviewNote:'Checked known receipts',idempotencyKey:randomUUID()})).receipt;
  const call=await until(async()=> (await native.requests()).find(r=>r.method==='turn/start'),'qualified provider turn');
  assert.match(JSON.stringify(call),/The complete original task/);assert.match(JSON.stringify(call),/Apply the correction/);
  assert.match(JSON.stringify(call),/external effects occurred remain unknown/);
  const bytes=await Promise.all(runtimeAttachmentPaths(call).map(path=>readFile(path,'utf8')));
  assert.ok(bytes.includes('original fixture bytes'));assert.ok(bytes.includes('correction fixture bytes'));
  await native.sendTool('ponderosa_message',{text:'Completed reviewed task'});
  const response=await until(async()=> (await native.requests()).find(r=>r.toolResponse),'tool response');
  assert.equal(response.toolResponse.result.success,true);
  const current=await until(()=>store.sqlite.prepare("SELECT run_id FROM required_reply_obligations WHERE source_activation_id=? AND run_id<>? AND state='satisfied'").get(root,run),'original root satisfied');
  const all=store.sqlite.prepare('SELECT source_activation_id,state FROM required_reply_obligations WHERE run_id=?').all(current.run_id);
  assert.deepEqual(all,[{source_activation_id:root,state:'satisfied'}]);
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
  assert.ok(receipt.commandSha256);
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');},nativeAdapterForOpen:()=>useNative?native?.adapter:undefined});
});

for(const fault of ['changed-task','missing-task-file','missing-steer-file'])
test(`reviewed continuation holds when ${fault} invalidates saved evidence`,{timeout:30000},async t=>{
 let store,useNative=false,native;
 await withFixture(t,async f=>{
  native=await inertCodex(f.root);
  const chat=await f.createChat('Changed reviewed evidence'),agent=await f.createIdleAgent(chat,'Worker');
  const upload=async(name)=>f.ok(await f.api('POST',`/api/agents/${agent.id}/attachments`,Buffer.from(name),
   {'content-type':'application/octet-stream','x-ponderosa-filename':name,'x-ponderosa-media-type':'text/plain'}));
  const taskFile=await upload('task.txt'),steerFile=await upload('steer.txt');
  f.plans.set(agent.id,[{hold:true}]);await f.send(agent.id,'Original objective',{attachmentIds:[taskFile.id]});
  await until(()=>f.turns.some(x=>x.agentId===agent.id),'source input');
  const old=f.sessions.get(agent.id),run=(await f.detail(agent.id)).runs[0].id;
  const root=store.sqlite.prepare("SELECT source_activation_id FROM required_reply_obligations WHERE run_id=?").get(run).source_activation_id;
  await f.send(agent.id,'Correction',{activeRunDelivery:'steer',attachmentIds:[steerFile.id]});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'unknown steer');
  const [steer]=JSON.parse(injection.activation_ids_json),path=`/api/projects/${chat.projectId}/message-deliveries/${steer}/reviewed-continuation`;
  old.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(run),'source completed');
  const first=f.ok(await f.api('GET',path));if(first.status==='source_retirement_required')f.ok(await f.api('POST',path+'/retire-source'));
  const review=f.ok(await f.api('GET',path)).review;
  if(fault==='changed-task'){
   const row=store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(root),payload=JSON.parse(row.payload_json);
   payload.communication.text='changed after review';
   store.sqlite.prepare('UPDATE agent_activations SET payload_json=? WHERE id=?').run(JSON.stringify(payload),root);
  } else {
   const id=fault==='missing-task-file'?root:steer;
   const payload=JSON.parse(store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(id).payload_json);
   await unlink(payload.dispatch.attachments[0].localPath);
  }
  useNative=true;
  const response=await f.api('POST',path,{reviewSha256:review.reviewSha256,effectsReviewed:true,idempotencyKey:randomUUID()});
  if(fault==='changed-task') assert.equal(response.status,409);
  else {
   const receipt=f.ok(response).receipt;
   await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_activations WHERE id=? AND state='failed'").get(receipt.activationId),'missing file held');
  }
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,0);
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');},nativeAdapterForOpen:()=>useNative?native?.adapter:undefined});
});
