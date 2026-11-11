import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { AgentStore, CoordinationV3Store } from '../../packages/agents/dist/index.js';
import { ReviewedSteeringAuthority } from '../../packages/agents/dist/coordination-v3-reviewed-steering.js';
import { payloadHash } from '../../packages/agents/dist/coordination-v3-canonical-json.js';
import { withFixture, until, runtimeAttachmentPaths } from '../shared/fixture.mjs';
import { inertCodex } from '../shared/inert-codex.mjs';
import { inertClaude } from '../shared/inert-claude.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pathModule from 'node:path';

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

test('a later public instruction stays queued before preparation while the earlier steering is unknown',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Queued after unknown steering'),agent=await f.createIdleAgent(chat,'Worker');
  const old=await f.hold(agent.id),run=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'An unconfirmed correction',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'unknown steering');
  old.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(run),'source complete');
  const turns=f.turns.length,runs=store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n;
  await f.send(agent.id,'A later separate instruction');
  const held=await until(()=>store.sqlite.prepare("SELECT a.id,a.state,a.payload_json FROM agent_activations a JOIN activation_sources held ON held.activation_id=a.id WHERE a.agent_id=? AND held.source_kind='settings_transition_reservation_wait'").get(agent.id),'later instruction held before lease');
  assert.equal(held.state,'pending');assert.ok(held.payload_json.includes('A later separate instruction'));
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n,runs,'Public intake must not invent a failed preparation Run');
  assert.equal(f.turns.length,turns,'No later provider input may be sent');
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');}});
});

for(const laterFailure of [false,true]) test(`qualified Codex continues the saved task and instruction with both files and the original reply root (direct later-unsubmitted authority fixture=${laterFailure})`,{timeout:30000},async t=>{
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
  let failed,failedActivations;
  if(laterFailure){
   const priorTurns=f.turns.length;
   // This is a canonical scheduler-authority fixture, not an attainable public
   // send path: public intake now holds uncertain context before leasing.
   // Preserve support for an already-recorded, truly unsubmitted preparation
   // and the rejection matrix below without weakening that admission guard.
   const event={schemaVersion:2,eventId:randomUUID(),projectId:chat.projectId,conversationId:chat.id,sender:{kind:'user',userId:'local-operator'},intent:'user_dm',audience:{kind:'user_agent',userId:'local-operator',agentId:agent.id},text:'A later separate instruction',createdAt:new Date().toISOString()};
   store.appendCommunicationEvent(event);store.appendEvent(agent.id,{type:'communication_projection',communicationEventId:event.eventId,text:event.text,role:'user'});
   const coordination=new CoordinationV3Store(store.sqlite),workerId='direct-later-preparation-fixture';
   const activationId=coordination.enqueueMessageActivation({projectId:chat.projectId,agentId:agent.id,scopeKey:`conversation:${chat.id}`,messageId:event.eventId,kind:'human',dispatchPolicy:'next_run',payload:{text:event.text,communication:event}});
   const lease=coordination.leaseNextRun({workerId,expectedActivationId:activationId});assert.ok(lease,'The authority fixture must obtain its exact scheduler lease');
   assert.equal(lease.agentId,agent.id);
   assert.equal(coordination.failRun({runId:lease.runId,fencingToken:lease.fencingToken,workerId,sameRunResumable:false,retryable:false,confirmedNotExecuted:true,error:'Controlled preparation refusal before provider input',failureDetail:{phase:'prepare',promptInjectionState:'not_injected'}}),'terminal');
   failed=store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(lease.runId);
   assert.equal(failed.status,'failed');assert.equal(failed.prompt_injection_state,'not_injected');
   assert.equal(failed.started_at,null);assert.equal(failed.provider_session_id,null);assert.ok(failed.terminal_at);
   failedActivations=store.sqlite.prepare('SELECT a.id,a.state,a.payload_json FROM agent_activations a JOIN scheduler_run_activations attached ON attached.activation_id=a.id WHERE attached.run_id=? ORDER BY a.id').all(failed.id);
   assert.ok(JSON.stringify(failedActivations).includes('A later separate instruction'));
   assert.equal(f.turns.length,priorTurns,'The later failed preparation did not submit a task');
  }
  const first=f.ok(await f.api('GET',path));
  if(first.status==='source_retirement_required') f.ok(await f.api('POST',path+'/retire-source'));
  const review=f.ok(await f.api('GET',path));assert.equal(review.status,'review_required');
  if(failed){
   assert.deepEqual(review.review.laterUnsubmittedRuns.map(row=>row.id),[failed.id]);
   const authority=new ReviewedSteeringAuthority(store.sqlite,()=>{throw Error('Unexpected creation');});
   for(const mutate of [
    ()=>store.sqlite.prepare("UPDATE scheduler_runs SET prompt_injection_state='injecting' WHERE id=?").run(failed.id),
    ()=>store.sqlite.prepare("UPDATE scheduler_runs SET status='outcome_unknown' WHERE id=?").run(failed.id),
    ()=>store.sqlite.prepare("UPDATE scheduler_runs SET started_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(failed.id),
    ()=>store.sqlite.prepare("UPDATE scheduler_runs SET provider_session_id='unexpected' WHERE id=?").run(failed.id),
    ()=>store.sqlite.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,submitted_at) VALUES(?,?,'turn',99,'submitted','hash','[]','2000','2000','2000')").run(randomUUID(),failed.id),
    ()=>store.sqlite.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,provider_turn_id) VALUES(?,?,'turn',99,'cancelled','hash','[]','2000','2000','provider-turn')").run(randomUUID(),failed.id),
    ()=>store.sqlite.prepare("INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'2000','2000')").run(randomUUID(),failed.id,agent.id,chat.projectId,'input','hash','{}'),
    ()=>store.sqlite.prepare("INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'2000','2000')").run(failed.id,randomUUID(),agent.id,chat.projectId,'input','hash','{}'),
    ...['provider-start-admission','provider-process-registration'].map(kind=>()=>store.sqlite.prepare("INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)").run(kind,randomUUID(),'{}',JSON.stringify({runId:failed.id}),'fixture')),
    ()=>store.sqlite.prepare("INSERT INTO provider_operation_outbox(run_id,operation,idempotency_key,payload_json,state,available_at,created_at,updated_at) VALUES(?,'interrupt',?,'{}','pending','2000','2000','2000')").run(failed.id,randomUUID()),
    ()=>store.sqlite.prepare("INSERT INTO coordination_idempotency(project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,'coordinate',?,'hash','{}','2000')").run(chat.projectId,`agent:${agent.id}:run:${failed.id}`,randomUUID()),
   ])assert.throws(()=>store.sqlite.transaction(()=>{
    mutate();assert.throws(()=>authority.preview(chat.projectId,sourceActivation),/later Run/);
    assert.throws(()=>authority.drainTarget(chat.projectId,sourceActivation),/later Run/);
    throw Error('restore later Run');
   })(),/restore later Run/);
   assert.throws(()=>store.sqlite.transaction(()=>{
    store.sqlite.prepare("UPDATE scheduler_runs SET terminal_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(failed.id);
    assert.notEqual(authority.preview(chat.projectId,sourceActivation).reviewSha256,review.review.reviewSha256);
    assert.throws(()=>authority.continue({projectId:chat.projectId,activationId:sourceActivation,reviewSha256:review.review.reviewSha256,effectsReviewed:true,idempotencyKey:randomUUID()}),/changed/);
    throw Error('restore exact review');
   })(),/restore exact review/);
  }
  let handoffReads=0;
  store.pendingContinuationHandoff=()=>{handoffReads++;return {id:'unrelated',executionId:'other-run',text:'unrelated stale handoff'};};
  useNative=true;
  const receipt=f.ok(await f.api('POST',path,{reviewSha256:review.review.reviewSha256,effectsReviewed:true,reviewNote:'Checked known receipts',idempotencyKey:randomUUID()})).receipt;
  const {settingsTransitionActivationHoldSql}=await import('../../packages/agents/dist/coordination-v3-settings-transition-hold.js');
  store.sqlite.exec('SAVEPOINT context_recovery_review_guard');
  try{
   store.sqlite.prepare(`INSERT INTO provider_context_recovery_requests(id,agent_id,project_id,source_run_id,scope_key,provider_session_id,tool_contract_hash,source_fence,idempotency_key,state,created_at)
    VALUES(?,?,?,?,?,?,?,1,?,'dismissed',?)`).run(randomUUID(),agent.id,chat.projectId,run,'conversation:'+chat.id,'retained-session','a'.repeat(64),randomUUID(),new Date().toISOString());
   const held=()=>store.sqlite.prepare(`SELECT ${settingsTransitionActivationHoldSql('a')} held FROM agent_activations a WHERE a.id=?`).get(receipt.activationId).held;
   assert.equal(held(),0,'Canonical human-reviewed continuation is distinct authority from automatic task recovery');
   store.sqlite.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='reviewed_steering'").run(receipt.activationId);
   assert.equal(held(),1,'Payload review metadata alone never authorizes original-task replay');
  }finally{store.sqlite.exec('ROLLBACK TO context_recovery_review_guard; RELEASE context_recovery_review_guard');}
  const call=await until(async()=> (await native.requests()).find(r=>r.method==='turn/start'),'qualified provider turn');
  assert.match(JSON.stringify(call),/The complete original task/);assert.match(JSON.stringify(call),/Apply the correction/);
  assert.match(JSON.stringify(call),/external effects occurred remain unknown/);
  assert.equal(handoffReads,0,'reviewed continuation must not adopt an unrelated generic handoff');
  const bytes=await Promise.all(runtimeAttachmentPaths(call).map(path=>readFile(path,'utf8')));
  assert.ok(bytes.includes('original fixture bytes'));assert.ok(bytes.includes('correction fixture bytes'));
  await native.sendTool('ponderosa_message',{text:'Completed reviewed task'});
  const response=await until(async()=> (await native.requests()).find(r=>r.toolResponse),'tool response');
  assert.equal(response.toolResponse.result.success,true);
  const current=await until(()=>store.sqlite.prepare("SELECT run_id FROM required_reply_obligations WHERE source_activation_id=? AND run_id<>? AND state='satisfied'").get(root,run),'original root satisfied');
  const all=store.sqlite.prepare('SELECT source_activation_id,state FROM required_reply_obligations WHERE run_id=?').all(current.run_id);
  assert.deepEqual(all,[{source_activation_id:root,state:'satisfied'}]);
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
  if(failed){
   assert.deepEqual(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(failed.id),failed,'The later failed Run remains untouched');
   assert.deepEqual(store.sqlite.prepare('SELECT a.id,a.state,a.payload_json FROM agent_activations a JOIN scheduler_run_activations attached ON attached.activation_id=a.id WHERE attached.run_id=? ORDER BY a.id').all(failed.id),failedActivations,'The later separate instruction remains untouched');
  }
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


test('Stop after reviewed provider admission prevents any successor turn input',{timeout:30000},async t=>{
 let store,useNative=false,native;
 await withFixture(t,async f=>{
  native=await inertCodex(f.root,{holdSecondAccountRead:true});
  const chat=await f.createChat('Stop before reviewed input'),agent=await f.createIdleAgent(chat,'Worker');
  const old=await f.hold(agent.id),source=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'Unconfirmed correction',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(source),'unknown steering');
  const [activation]=JSON.parse(injection.activation_ids_json),path=`/api/projects/${chat.projectId}/message-deliveries/${activation}/reviewed-continuation`;
  old.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(source),'source completed');
  if(f.ok(await f.api('GET',path)).status==='source_retirement_required')f.ok(await f.api('POST',path+'/retire-source'));
  const review=f.ok(await f.api('GET',path)).review;
  useNative=true;
  const result=f.ok(await f.api('POST',path,{reviewSha256:review.reviewSha256,effectsReviewed:true,idempotencyKey:randomUUID()})).receipt;
  const successor=await until(()=>store.sqlite.prepare("SELECT r.id,r.fencing_token FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id WHERE a.activation_id=? AND r.status='running'").get(result.activationId),'reviewed successor Run');
  await until(async()=>(await native.requests()).filter(r=>r.method==='account/read').length===2,'provider admitted and paused immediately before turn input');
  const admission=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.runId')=?").get(successor.id);
  assert.ok(admission,'exact successor admission must already be durable');
  const bound=JSON.parse(admission.receipt_json);
  assert.equal(bound.runFence,successor.fencing_token);
  assert.ok(store.sqlite.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-start-settlement' AND identity=?").get(bound.identity),'successor start must already be settled');
  assert.ok(store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE run_id=?').get(successor.id),'successor process must already be registered');
  f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:successor.id,idempotencyKey:randomUUID()}));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='cancelled'").get(successor.id),'exact successor stopped');
  await until(()=>!store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE run_id=?').get(successor.id),'stopped successor process exited');
  await native.releaseThread();
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await native.requests()).filter(r=>r.method==='turn/start').length,0,'no reviewed prompt may be written after Stop');
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_run_activations WHERE activation_id=?").get(result.activationId).n,1,'Stop must not replay the reviewed activation');
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');},nativeAdapterForOpen:()=>useNative?{openSession:opts=>native.adapter.openSession({...opts,expectedBillingMode:'subscription'})}:undefined});
});

test('source retirement refuses foreign or mismatched process ownership and leaves both providers running',{timeout:30000},async t=>{
 const previous=process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS='4';let store;
 try { await withFixture(t,async f=>{
  const chat=await f.createChat('Foreign source owner'),agent=await f.createIdleAgent(chat,'Reviewed worker');
  const foreign=await f.createIdleAgent(chat,'Other worker'),other=await f.hold(foreign.id);
  const old=await f.hold(agent.id),source=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'Unconfirmed correction',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(source),'unknown steering');
  const [activation]=JSON.parse(injection.activation_ids_json),path=`/api/projects/${chat.projectId}/message-deliveries/${activation}/reviewed-continuation`;
  old.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(source),'source completed');
  assert.equal(f.ok(await f.api('GET',path)).status,'source_retirement_required');
  assert.equal(old.isAlive(),true,'source must remain live before the mismatch test');
  const row=store.sqlite.prepare('SELECT id,worker_id,agent_id,run_id,birth_marker FROM provider_process_authority WHERE agent_id=?').get(agent.id);
  assert.ok(row);
  for(const [column,value] of [['worker_id','foreign-worker'],['agent_id',foreign.id],['run_id','foreign-run'],['birth_marker','different-birth']]){
   store.sqlite.prepare(`UPDATE provider_process_authority SET ${column}=? WHERE id=?`).run(value,row.id);
   try {
    const response=await f.api('POST',path+'/retire-source');
    assert.equal(response.status,409,column+' mismatch must be held');
    assert.equal(old.isAlive(),true,'source must not be terminated for '+column);
    assert.equal(other.isAlive(),true,'foreign Agent must not be terminated for '+column);
   } finally {store.sqlite.prepare(`UPDATE provider_process_authority SET ${column}=? WHERE id=?`).run(row[column],row.id);}
  }
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id IN (SELECT id FROM scheduler_prompt_injections WHERE run_id=? AND kind=?)').get(source,'steer').state,'outcome_unknown');
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');}});
 } finally {if(previous===undefined)delete process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;else process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS=previous;}
});

test('a reused source provider is retired only with its latest exact Run and fence',{timeout:30000},async t=>{
 const previous=process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS='1';let store;
 try {
  await withFixture(t,async f=>{
   const chat=await f.createChat('Reused reviewed source'),agent=await f.createIdleAgent(chat,'Worker');
   await f.send(agent.id,'First completed task');await f.settled(agent.id);
   const retained=f.sessions.get(agent.id),before=(await f.detail(agent.id)).runs.map(x=>x.id);
   f.plans.set(agent.id,[{hold:true}]);await f.send(agent.id,'Second objective');
   await until(()=>f.turns.filter(x=>x.agentId===agent.id).length===2,'second source input');
   assert.equal(f.sessions.get(agent.id),retained,'fixture must reuse the same provider');
   const runs=(await f.detail(agent.id)).runs,source=runs.find(r=>!before.includes(r.id)).id;
   await f.send(agent.id,'Unconfirmed correction',{activeRunDelivery:'steer'});
   const injection=await until(()=>store.sqlite.prepare("SELECT activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(source),'unknown steering');
   const [activation]=JSON.parse(injection.activation_ids_json),path=`/api/projects/${chat.projectId}/message-deliveries/${activation}/reviewed-continuation`;
   retained.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(source),'reused source completed');
   const authority=store.sqlite.prepare("SELECT id,run_id FROM provider_process_authority WHERE agent_id=?").get(agent.id);
   assert.equal(authority.run_id,source);
   const registrations=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=?").all(authority.id).map(x=>JSON.parse(x.receipt_json));
   assert.ok(registrations.some(r=>before.includes(r.runId)),'same lifetime must retain earlier Run evidence');
   const current=store.sqlite.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=?').get(source);
   assert.ok(registrations.some(r=>r.runId===source&&r.runFence===current.fencing_token),'same lifetime must have exact source Run/fence evidence');
   const first=f.ok(await f.api('GET',path));assert.equal(first.status,'source_retirement_required');
   f.ok(await f.api('POST',path+'/retire-source'));assert.equal(retained.isAlive(),false);
   assert.equal(f.ok(await f.api('GET',path)).status,'review_required');
  },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');}});
 } finally {if(previous===undefined)delete process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;else process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS=previous;}
});


test('qualified Claude continues the original task and correction without replaying uncertain delivery',{timeout:30000},async t=>{
 let store,useNative=false,native,invokeTool;
 await withFixture(t,async f=>{
  native=await inertClaude(f.root);
  const chat=await f.createChat('Reviewed Claude transport'),agent=await f.createIdleAgent(chat,'Worker');
  const upload=async(name,content)=>f.ok(await f.api('POST',`/api/agents/${agent.id}/attachments`,Buffer.from(content),
    {'content-type':'application/octet-stream','x-ponderosa-filename':name,'x-ponderosa-media-type':'text/plain'}));
  const taskFile=await upload('task.txt','original Claude fixture bytes'),steerFile=await upload('steer.txt','correction Claude fixture bytes');
  f.plans.set(agent.id,[{hold:true}]);await f.send(agent.id,'The full original Claude task',{attachmentIds:[taskFile.id]});
  await until(()=>f.turns.some(x=>x.agentId===agent.id),'source input');
  const old=f.sessions.get(agent.id),source=(await f.detail(agent.id)).runs[0].id;
  const root=store.sqlite.prepare("SELECT source_activation_id FROM required_reply_obligations WHERE run_id=?").get(source).source_activation_id;
  await f.send(agent.id,'Apply the Claude correction',{activeRunDelivery:'steer',attachmentIds:[steerFile.id]});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(source),'unknown steering');
  const [activation]=JSON.parse(injection.activation_ids_json),url=`/api/projects/${chat.projectId}/message-deliveries/${activation}/reviewed-continuation`;
  old.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(source),'source complete');
  if(f.ok(await f.api('GET',url)).status==='source_retirement_required')f.ok(await f.api('POST',url+'/retire-source'));
  const review=f.ok(await f.api('GET',url)).review;
  useNative=true;
  const receipt=f.ok(await f.api('POST',url,{reviewSha256:review.reviewSha256,effectsReviewed:true,reviewNote:'Inspected known effects',idempotencyKey:randomUUID()})).receipt;
  const input=await until(async()=>(await native.frames()).find(frame=>frame.type==='user'),'Claude user input');
  assert.match(JSON.stringify(input),/The full original Claude task/);
  assert.match(JSON.stringify(input),/Apply the Claude correction/);
  assert.match(JSON.stringify(input),/external effects occurred remain unknown/);
  const bytes=await Promise.all(runtimeAttachmentPaths(input).map(p=>readFile(p,'utf8')));
  assert.ok(bytes.includes('original Claude fixture bytes'));assert.ok(bytes.includes('correction Claude fixture bytes'));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_run_activations a JOIN scheduler_runs r ON r.id=a.run_id WHERE a.activation_id=? AND r.prompt_injection_state='injected'").get(receipt.activationId),'Claude input acknowledged');
  // This uses the actual host tool handler supplied to the provider. It does
  // not simulate a Claude MCP protocol exchange.
  const reply=await invokeTool({id:'fixture-claude-reply',name:'ponderosa_message',arguments:{text:'Completed reviewed Claude task'}});
  assert.equal(reply.success,true);
  await native.finish();
  const next=await until(()=>store.sqlite.prepare("SELECT run_id FROM required_reply_obligations WHERE source_activation_id=? AND run_id<>? AND state='satisfied'").get(root,source),'original task reply satisfied');
  assert.deepEqual(store.sqlite.prepare('SELECT source_activation_id,state FROM required_reply_obligations WHERE run_id=?').all(next.run_id),[{source_activation_id:root,state:'satisfied'}]);
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');},nativeAdapterForOpen:()=>useNative?{openSession:opts=>{invokeTool=opts.handleDynamicToolCall;return native.adapter.openSession(opts);}}:undefined});
});

test('Claude checks the stop fence after async model selection before writing input',{timeout:15000},async t=>{
 const root=await mkdtemp(pathModule.join(tmpdir(),'inert-claude-stop-')),native=await inertClaude(root,{holdModel:true});
 const controller=new AbortController();let session,stopped=false,handle;
 try {
  session=await native.adapter.openSession({agentId:'fixture',cwd:root,history:[],model:'first',signal:controller.signal,onRuntimeSpawned:h=>{handle=h},onRuntimeRootExit:()=>{}});
  const input=session.startTurn({prompt:'MUST NOT BE WRITTEN',model:'second',assertCurrent:()=>{if(stopped)throw Error('controlled Stop fence');}});
  const captured=input.then(()=>({accepted:true}),error=>({error}));
  await until(async()=>(await native.frames()).some(frame=>frame.type==='control_request'&&frame.request?.subtype==='set_model'),'model change paused');
  assert.equal(handle.isAlive(),true);
  stopped=true;await native.releaseModel();
  const outcome=await captured;assert.match(outcome.error?.message??'',/controlled Stop fence/);
  assert.equal((await native.frames()).filter(frame=>frame.type==='user').length,0);
 } finally {await session?.close();await rm(root,{recursive:true,force:true});}
});


test('Stop after Claude provider admission prevents reviewed user input',{timeout:30000},async t=>{
 let store,useNative=false,native;
 await withFixture(t,async f=>{
  native=await inertClaude(f.root,{holdModel:true});
  const chat=await f.createChat('Stop reviewed Claude'),agent=await f.createIdleAgent(chat,'Worker');
  const old=await f.hold(agent.id),source=(await f.detail(agent.id)).runs[0].id;
  await f.send(agent.id,'Unconfirmed Claude correction',{activeRunDelivery:'steer'});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(source),'unknown steering');
  const [activation]=JSON.parse(injection.activation_ids_json),url=`/api/projects/${chat.projectId}/message-deliveries/${activation}/reviewed-continuation`;
  old.finish();await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(source),'source completed');
  if(f.ok(await f.api('GET',url)).status==='source_retirement_required')f.ok(await f.api('POST',url+'/retire-source'));
  const review=f.ok(await f.api('GET',url)).review;
  useNative=true;
  const result=f.ok(await f.api('POST',url,{reviewSha256:review.reviewSha256,effectsReviewed:true,idempotencyKey:randomUUID()})).receipt;
  const successor=await until(()=>store.sqlite.prepare("SELECT r.id,r.fencing_token FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id WHERE a.activation_id=? AND r.status='running'").get(result.activationId),'reviewed successor Run');
  await until(async()=>(await native.frames()).some(frame=>frame.type==='control_request'&&frame.request?.subtype==='set_model'),'registered Claude provider paused before input');
  const admission=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.runId')=?").get(successor.id);
  assert.ok(admission);
  const bound=JSON.parse(admission.receipt_json);assert.equal(bound.runFence,successor.fencing_token);
  assert.ok(store.sqlite.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-start-settlement' AND identity=?").get(bound.identity),'Claude provider start must be settled');
  assert.ok(store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE run_id=?').get(successor.id));
  f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:successor.id,idempotencyKey:randomUUID()}));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='cancelled'").get(successor.id),'Claude successor stopped');
  await until(()=>!store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE run_id=?').get(successor.id),'Claude process exited');
  await native.releaseModel();await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal((await native.frames()).filter(frame=>frame.type==='user').length,0,'no reviewed task may be written after Stop');
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_run_activations WHERE activation_id=?").get(result.activationId).n,1,'Stop must not replay the reviewed activation');
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown delivery');},nativeAdapterForOpen:()=>useNative?{openSession:opts=>native.adapter.openSession({...opts,model:'initial-model'})}:undefined});
});

for(const initialReply of [false,true]) test(`reviewed continuation preserves ${initialReply?'final':'initial'} root after an orphaned uncertain Run`,{timeout:30000},async t=>{
 let store,useNative=false,native;
 await withFixture(t,async f=>{
  native=await inertCodex(f.root);
  const chat=await f.createChat('Orphaned reviewed continuation'),agent=await f.createIdleAgent(chat,'Worker');
  const upload=async(name,content)=>f.ok(await f.api('POST',`/api/agents/${agent.id}/attachments`,Buffer.from(content),
   {'content-type':'application/octet-stream','x-ponderosa-filename':name,'x-ponderosa-media-type':'text/plain'}));
  const taskFile=await upload('task.txt','orphan task bytes'),steerFile=await upload('steer.txt','orphan steer bytes');
  f.plans.set(agent.id,[{hold:true}]);await f.send(agent.id,'Finish the complete original task',{attachmentIds:[taskFile.id]});
  await until(()=>f.turns.some(x=>x.agentId===agent.id),'source input');
  const source=f.sessions.get(agent.id),run=(await f.detail(agent.id)).runs[0].id;
  const root=store.sqlite.prepare('SELECT source_activation_id FROM required_reply_obligations WHERE run_id=?').get(run).source_activation_id;
  if(initialReply){const reply=await f.tool(source,'ponderosa_message',{text:'Interim progress'});assert.equal(reply.status,200,JSON.stringify(reply));}
  await f.send(agent.id,'Apply the saved correction',{activeRunDelivery:'steer',attachmentIds:[steerFile.id]});
  const injection=await until(()=>store.sqlite.prepare("SELECT id,activation_ids_json FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(run),'uncertain steering');
  const [activationId]=JSON.parse(injection.activation_ids_json);
  assert.equal(new CoordinationV3Store(store.sqlite).recoverOrphanedRuns('other-fixture-worker').outcomeUnknown,1);
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run).status,'outcome_unknown');
  assert.equal(store.sqlite.prepare('SELECT state FROM required_reply_obligations WHERE run_id=? AND source_activation_id=?').get(run,root).state,'pending');
  const livePath=`/api/projects/${chat.projectId}/message-deliveries/${activationId}/reviewed-continuation`;
  assert.equal((await f.api('POST',livePath+'/retire-source')).status,409,'a locally active source must not be retired');
  assert.equal(source.isAlive(),true);
  await f.reopen();
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run).status,'outcome_unknown');
  const path=`/api/projects/${chat.projectId}/message-deliveries/${activationId}/reviewed-continuation`;
  const view=f.ok(await f.api('GET',path));
  assert.equal(view.status,'review_required');assert.equal(view.review.effectInventory.sourceStatus,'outcome_unknown');
  assert.equal(view.review.effectInventory.nativeTail,'unknown');assert.equal(view.review.replayAuthorized,false);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,0,'worker loss must not restart work automatically');
  useNative=true;
  const body={reviewSha256:view.review.reviewSha256,effectsReviewed:true,reviewNote:'Reviewed uncertain work',idempotencyKey:randomUUID()};
  const receipt=f.ok(await f.api('POST',path,body)).receipt;
  assert.equal(f.ok(await f.api('POST',path,body)).receipt.activationId,receipt.activationId);
  const call=await until(async()=> (await native.requests()).find(x=>x.method==='turn/start'),'reviewed successor turn');
  assert.match(JSON.stringify(call),/Finish the complete original task/);
  assert.match(JSON.stringify(call),/Apply the saved correction/);
  assert.match(JSON.stringify(call),/external effects occurred remain unknown/);
  const files=await Promise.all(runtimeAttachmentPaths(call).map(file=>readFile(file,'utf8')));
  assert.ok(files.includes('orphan task bytes'));assert.ok(files.includes('orphan steer bytes'));
  await native.sendTool('ponderosa_message',{text:'Reviewed task complete',...(initialReply?{taskDelivery:'final'}:{})});
  const reply=await until(async()=> (await native.requests()).find(x=>x.toolResponse),'successor tool response');
  assert.equal(reply.toolResponse.result.success,true,JSON.stringify(reply));
  const successor=await until(()=>store.sqlite.prepare("SELECT run_id FROM required_reply_obligations WHERE source_activation_id=? AND run_id<>? AND state='satisfied'").get(root,run),'original task reply');
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM required_reply_obligations WHERE run_id=?").get(successor.run_id).n,1);
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(injection.id).state,'outcome_unknown');
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run).status,'outcome_unknown');
 },{storeFactory:p=>(store=new AgentStore(p)),steeringResponse:async()=>{throw Error('Controlled unknown steer');},nativeAdapterForOpen:()=>useNative?native?.adapter:undefined});
});
