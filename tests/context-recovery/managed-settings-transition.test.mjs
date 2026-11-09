import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore, CoordinationV3Store, CapabilityPolicyStore } from '../../packages/agents/dist/index.js';
import { withFixture, until } from '../shared/fixture.mjs';
import { inertCodex } from '../shared/inert-codex.mjs';
import { ownedChroma } from '../memory/portability-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { CAPABILITY_IDS } from '@ponderosa/core';
import path from 'node:path';

async function accessRevocationPause(store,agentId,phase,kind){
 const pause=await until(()=>store.sqlite.prepare(`SELECT p.id,p.run_id,p.state,p.rollover_id,p.checkpoint_json,r.status,r.side_effects_fenced_at
  FROM agent_run_pauses p JOIN scheduler_runs r ON r.id=p.run_id
  WHERE p.agent_id=? AND p.state=? AND json_extract(p.checkpoint_json,?)=?
    AND json_extract(p.checkpoint_json,?)=1 AND r.status=? AND r.side_effects_fenced_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM scheduler_run_activations a JOIN agent_activations x ON x.id=a.activation_id WHERE a.run_id=r.id AND x.kind=?)`).get(agentId,"paused","$.phase",phase,"$.accessRevocationHold","cancelled",kind),"exact revoked Run paused and fenced",20000);
 await until(()=>store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE idempotency_key=? AND state=?").get("pause:"+pause.id,"completed"),"revoked provider drained",20000);
 return pause;
}

test('memory-enabled voice preserves earlier work through an isolated managed handoff',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Managed voice transition'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Preserve the original objective and its completed research.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  const response=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory result');
  assert.equal(response.result.success,true);
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  const voice=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue the original objective aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  const transition=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'settings handoff requested',20000);
  const pending=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending' ORDER BY created_at DESC LIMIT 1").get(agent.id);
  assert.ok(pending,'the voice task remains queued');
  const starts=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old-session handoff',20000);
  assert.equal(starts[1].params.threadId,starts[0].params.threadId);
  assert.equal(starts[1].params.model,starts[0].params.model,'handoff uses the old accepted model');
  assert.equal(starts[1].params.effort,starts[0].params.effort,'handoff uses the old accepted effort');
  assert.ok(!JSON.stringify(starts[1]).includes('Continue the original objective aloud.'),'queued voice work is not submitted to the old thread');
  await native.sendAnswer('Objective: finish the original work. Research is complete; continue with the remaining work.');
  const continuation=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'replacement confirmation',20000);
  assert.notEqual(continuation[2].params.threadId,starts[0].params.threadId);
  assert.ok(JSON.stringify(continuation[2]).includes('Research is complete; continue with the remaining work.'),'replacement input includes the actual managed handoff');
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(pending.id).state,'pending');
  assert.ok(!JSON.stringify(continuation[2]).includes('Continue the original objective aloud.'));
  await native.sendAnswer('Continuity context received.');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state='completed' AND completion_reason='replacement_verified'").get(transition.id),'replacement verified',20000);
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'queued voice task',20000);
  assert.equal(final[3].params.threadId,continuation[2].params.threadId);
  assert.ok(JSON.stringify(final[3]).includes('Continue the original objective aloud.'));
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1,'one managed transition serves this voice task');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(pending.id).n,1,'original voice task attaches exactly once');
  await native.sendTool('ponderosa_voice_reply',{});await f.settled(agent.id);
  const reply=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voice.message.communicationEventId}/${agent.id}`));
  assert.equal(reply.reply.state,'completed');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('revoking memory during a managed handoff prevents the old summary from being carried forward',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Managed transition revocation'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  await until(async()=>(await native.requests()).some(x=>x.toolResponse),'memory result');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  const rollover=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'handoff requested',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old-session handoff',20000);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await native.sendAnswer('Synthetic revoked summary must never transfer.');
  const pause=await accessRevocationPause(store,agent.id,'handoff','context_rollover_handoff');
  assert.equal(pause.rollover_id,rollover.id,'the exact rollover owns the paused handoff');
  assert.ok(store.sqlite.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending' AND payload_json LIKE ?").get(agent.id,'%Continue aloud.%'),'original voice task remains queued');
  const record=store.sqlite.prepare('SELECT handoff_event_id,state FROM context_rollovers WHERE id=?').get(rollover.id);
  assert.equal(record.handoff_event_id,null,'revoked content must never become a continuation handoff');
  assert.ok(!store.readEvents(agent.id).some(row=>row.event.type==='continuation_handoff'&&row.event.text?.includes('Synthetic revoked summary')));
  assert.ok(!(await native.requests()).filter(x=>x.method==='turn/start').some(x=>JSON.stringify(x).includes('Synthetic revoked summary')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('revoking memory while replacement opens prevents the handoff from being submitted',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Replacement revocation'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  await until(async()=>(await native.requests()).some(x=>x.toolResponse),'memory result');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff',20000);
  const rollover=store.sqlite.prepare("SELECT id FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id);assert.ok(rollover);
  await native.sendAnswer('Synthetic source summary, permitted before revocation.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='thread/start').length>=2,'replacement opening',20000);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await native.releaseThread();
  const pause=await accessRevocationPause(store,agent.id,'replacement','context_rollover_continuation');
  assert.equal(pause.rollover_id,rollover.id,'the exact rollover owns the paused replacement');
  assert.ok(store.sqlite.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending' AND payload_json LIKE ?").get(agent.id,'%Continue aloud.%'),'original voice task remains queued');
  const calls=await native.requests();
  assert.ok(!calls.filter(x=>x.method==='turn/start').some(x=>JSON.stringify(x).includes('Synthetic source summary, permitted before revocation.')),'revoked handoff never reaches replacement');
  assert.equal(calls.filter(x=>x.method==='turn/start'&&x.params?.threadId==='inert-reviewed-thread-2').length,0);
  const active=store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(agent.id);
  if(active)f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:active.id,idempotencyKey:randomUUID()}));
  await new Promise(resolve=>setTimeout(resolve,250));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true,holdReplacementStart:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('revoking memory while the managed voice reply streams invalidates publication',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Voice stream revocation'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  await until(async()=>(await native.requests()).some(x=>x.toolResponse),'memory result');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  const voice=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'handoff turn',20000);
  await native.sendAnswer('Original objective retained.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=3,'replacement confirmation',20000);
  await native.sendAnswer('Continuity context received.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=4,'voice turn',20000);
  await native.sendTool('ponderosa_voice_reply',{});
  await until(()=>store.readEvents(agent.id).some(row=>row.event.type==='voice_reply'&&row.event.reply.state==='streaming'),'voice streaming',20000);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await native.releaseVoice();
  const pause=await accessRevocationPause(store,agent.id,'source','human_message');
  assert.ok(JSON.stringify(JSON.parse(pause.checkpoint_json).sourceActivations).includes('Continue aloud.'),'original voice task remains in the durable pause');
  const status=await until(async()=>{const s=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voice.message.communicationEventId}/${agent.id}`));return s.runStatus==='cancelled'&&s.reply?.state==='failed'?s:undefined;},'cancelled voice projected as failed',20000);
  assert.equal(status.memoryExposure.state,'invalid');
  assert.notEqual(status.reply.state,'completed');
  assert.ok(!store.readEvents(agent.id).some(row=>row.event.type==='voice_reply'&&row.event.reply.runId===pause.run_id&&row.event.reply.state==='completed'),'no completed voice event is published');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM runtime_communications WHERE payload_json LIKE '%The objective continues safely.%'").get().n,0,'no stale final answer becomes canonical Communication');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,holdVoiceCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('interrupted managed handoff is not automatically replayed after restart',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Interrupted handoff'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  await until(async()=>(await native.requests()).some(x=>x.toolResponse),'memory result');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  const rollover=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'handoff requested',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff submitted',20000);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections i JOIN scheduler_run_activations a ON a.run_id=i.run_id JOIN agent_activations x ON x.id=a.activation_id WHERE x.kind='context_rollover_handoff' AND i.state='acknowledged'").get(),'handoff acknowledged',20000);
  await f.reopen();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state IN ('failed','outcome_unknown')").get(rollover.id),'interrupted handoff recorded',20000);
  await new Promise(resolve=>setTimeout(resolve,300));
  const rows=store.sqlite.prepare("SELECT state FROM agent_activations WHERE kind='context_rollover_handoff' AND json_extract(payload_json,'$.rolloverId')=?").all(rollover.id);
  assert.equal(rows.length,1,'an uncertain handoff must not be scheduled a second time');
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='turn/start'&&x.params?.threadId==='inert-reviewed-thread-1').length,2,'no repeated input on the old thread');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('interrupted transition exposes retry-pending review after restart',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Interrupted handoff'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  await until(async()=>(await native.requests()).some(x=>x.toolResponse),'memory result');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  const rollover=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'handoff requested',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff submitted',20000);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections i JOIN scheduler_run_activations a ON a.run_id=i.run_id JOIN agent_activations x ON x.id=a.activation_id WHERE x.kind='context_rollover_handoff' AND i.state='acknowledged'").get(),'handoff acknowledged',20000);
  // Isolate the notice projection for an original task in retry_pending.
  const original=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending'").get(agent.id);
  assert.ok(original);
  store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending' WHERE id=?").run(original.id);
  await f.reopen();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state IN ('failed','outcome_unknown')").get(rollover.id),'interrupted handoff recorded',20000);
  await until(async()=>f.ok(await f.api('GET','/api/notifications')).items.some(item=>item.title==='Agent context needs review'&&item.body.includes('handoff did not finish')),'retry-pending review notice',20000);
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(original.id).state,'retry_pending');
  const rows=store.sqlite.prepare("SELECT state FROM agent_activations WHERE kind='context_rollover_handoff' AND json_extract(payload_json,'$.rolloverId')=?").all(rollover.id);
  assert.equal(rows.length,1,'an uncertain handoff must not be scheduled a second time');
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='turn/start'&&x.params?.threadId==='inert-reviewed-thread-1').length,2,'no repeated input on the old thread');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('model change after a memory read transfers the objective before queued work',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Managed model transition'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Keep the original objective through the model change.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  await until(async()=>(await native.requests()).some(x=>x.toolResponse),'memory result');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue work using the selected model.');
  const turns=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old handoff',20000);
  assert.equal(turns[1].params.threadId,turns[0].params.threadId);
  assert.equal(turns[1].params.model,'fixture','handoff uses the old accepted model');
  assert.ok(!JSON.stringify(turns[1]).includes('Continue work using the selected model.'));
  await native.sendAnswer('Research is complete. Continue the original objective.');
  const confirmation=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'replacement confirmation',20000);
  assert.notEqual(confirmation[2].params.threadId,turns[0].params.threadId);
  assert.equal(confirmation[2].params.model,'fixture-next');
  assert.ok(JSON.stringify(confirmation[2]).includes('Research is complete. Continue the original objective.'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'queued model task',20000);
  assert.equal(final[3].params.threadId,confirmation[2].params.threadId);
  assert.equal(final[3].params.model,'fixture-next');
  assert.ok(JSON.stringify(final[3]).includes('Continue work using the selected model.'));
  await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('forgetting a previously read source during handoff prevents stale summary transfer',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Forgotten memory source'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic coral lighthouse source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id,'synthetic source was saved');
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  const response=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory read');
  assert.ok(JSON.stringify(response).includes('Synthetic coral lighthouse source.'));
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  const rollover=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'handoff requested',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff submitted',20000);
  f.ok(await f.api('POST','/api/local-memory/global',{operation:'forget',chunk_id:id,destination:'global'}));
  await native.sendAnswer('Synthetic coral lighthouse source must no longer be transferred.');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id JOIN agent_activations x ON x.id=a.activation_id WHERE x.kind='context_rollover_handoff' AND r.status IN ('failed','outcome_unknown')").get(),'changed source stopped handoff',20000);
  assert.equal(store.sqlite.prepare('SELECT handoff_event_id FROM context_rollovers WHERE id=?').get(rollover.id).handoff_event_id,null);
  assert.ok(!store.readEvents(agent.id).some(row=>row.event.type==='continuation_handoff'&&row.event.text?.includes('Synthetic coral lighthouse')));
  assert.ok(!(await native.requests()).filter(x=>x.method==='turn/start').some(x=>JSON.stringify(x).includes('Synthetic coral lighthouse source must no longer')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});


test('peer Request waits for the new model handoff and retains its exact assignment',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Peer model transition'),peer=await f.createIdleAgent(chat,'Manager'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Keep the original worker objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first worker turn');
  await native.sendTool('ponderosa_message',{text:'Initial research complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  const coordination=new CoordinationV3Store(store.sqlite),request=coordination.coordinate({projectId:chat.projectId,conversationId:chat.id,
   requesterAgentId:peer.id,actorScope:'user:local-operator',idempotencyKey:randomUUID(),
   requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'Peer assignment: compare the two synthetic results.'}}]}).requestIds[0];
  const activation=store.sqlite.prepare("SELECT a.id FROM activation_sources s JOIN agent_activations a ON a.id=s.activation_id WHERE s.source_kind='request' AND s.source_id=? AND a.kind='coordination_request'").get(request);
  assert.ok(activation);
  const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'peer old-session handoff',20000);
  assert.equal(old[1].params.threadId,old[0].params.threadId);assert.equal(old[1].params.model,'fixture');
  assert.ok(!JSON.stringify(old[1]).includes('Peer assignment: compare'));
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(activation.id).state,'pending');
  await native.sendAnswer('Worker objective and initial research retained.');
  const next=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'peer replacement confirmation',20000);
  assert.equal(next[2].params.model,'fixture-next');assert.ok(JSON.stringify(next[2]).includes('Worker objective and initial research retained.'));
  assert.ok(!JSON.stringify(next[2]).includes('Peer assignment: compare'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'peer Request',20000);
  assert.equal(final[3].params.threadId,next[2].params.threadId);assert.ok(JSON.stringify(final[3]).includes('Peer assignment: compare the two synthetic results.'));
  await native.sendTool('ponderosa_update_request',{requestId:request,kind:'completed',text:'Synthetic comparison complete.'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM coordination_requests WHERE id=? AND state='completed'").get(request),'peer Request completed',20000);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(activation.id).n,1,'original Request attached exactly once');
  await f.settled(agent.id);
  const peerRun=store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(peer.id);
  if(peerRun)f.ok(await f.api('POST',`/api/agents/${peer.id}/cancel`,{targetRunId:peerRun.id,idempotencyKey:randomUUID()}));
  await new Promise(resolve=>setTimeout(resolve,300));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:true})).adapter});
});

test('ordinary text after a real global-memory revocation waits for safe context review',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Text after source revocation'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic revoked coral source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Preserve the original user objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original task');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  const read=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source read');
  assert.ok(JSON.stringify(read).includes('Synthetic revoked coral source.'));
  await native.sendTool('ponderosa_message',{text:'Earlier result: Synthetic revoked coral source.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id);assert.ok(accepted?.sessionId);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await f.send(agent.id,'Continue the original user objective in text.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id,a.payload_json FROM agent_activations a
   JOIN activation_sources h ON h.activation_id=a.id AND h.source_kind='settings_transition_reservation_wait'
   WHERE a.agent_id=? AND a.state='pending'`).get(agent.id),'context-review hold',20000);
  assert.ok(held.payload_json.includes('Continue the original user objective in text.'));
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('revoked or changed')));
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,1,'no old or fresh thread receives unsafe seed text');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId,'accepted context remains intact for review');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('a failed handoff reservation keeps the exact task queued and does not retry after restart',{timeout:90000},async t=>{
 let store,native,attempts=0;
 const original=CoordinationV3Store.prototype.requestContextRollover;
 CoordinationV3Store.prototype.requestContextRollover=function(input){
  if(input.settingsTransition){attempts++;throw new Error('Synthetic known pre-dispatch reservation failure');}
  return original.call(this,input);
 };
 t.after(()=>{CoordinationV3Store.prototype.requestContextRollover=original;});
 await withFixture(t,async f=>{
  const chat=await f.createChat('Handoff reservation failure'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Preserve this original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_message',{text:'First work complete.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue the same objective using the new model.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'durable exact hold',20000);
  assert.equal(attempts,1);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('could not prepare')));
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(attempts,1,'same failure is not retried automatically');
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,1);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  await f.reopen();await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(attempts,1,'restart must preserve the same hold without replay');
  assert.equal(store.sqlite.prepare("SELECT state FROM agent_activations WHERE id=?").get(held.id).state,'pending');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  const key=randomUUID(),retry=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/message-deliveries/${held.id}/retry`,{idempotencyKey:key}));
  assert.equal(retry.activationId,held.id,'retry preserves the exact original message');
  await until(()=>attempts===2,'one human-requested retry');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_reservation_wait'").get(held.id),'second failed hold');
  const again=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(again.items.some(item=>item.title==='Agent context needs review'&&(item.status??'open')==='open'),'a later failure reopens the notice');
  const replay=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/message-deliveries/${held.id}/retry`,{idempotencyKey:key}));
  assert.equal(replay.replayed,true,'replaying the same retry response cannot dispatch again');
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(attempts,2);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:true})).adapter});
});

test('changed Chat guidance uses accepted old handoff and current replacement instructions',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Changed guidance transition');
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Synthetic old Chat guidance.'}));
  const agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Preserve the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_message',{text:'Original work complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Synthetic new Chat guidance.'}));
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue using the updated guidance.');
  const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old handoff',20000);
  assert.equal(old[1].params.threadId,old[0].params.threadId);assert.equal(old[1].params.model,'fixture');
  assert.ok(!JSON.stringify(old[1]).includes('Continue using the updated guidance.'));
  await native.sendAnswer('The original objective and prior work remain relevant.');
  const confirmed=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'new confirmation',20000);
  const opened=(await native.requests()).filter(x=>x.method==='thread/start');
  assert.equal(opened.length,2);assert.ok(JSON.stringify(opened[1]).includes('Synthetic new Chat guidance.'));
  assert.ok(JSON.stringify(confirmed[2]).includes('The original objective and prior work remain relevant.'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'queued task',20000);
  assert.equal(final[3].params.threadId,confirmed[2].params.threadId);assert.ok(JSON.stringify(final[3]).includes('Continue using the updated guidance.'));
  await native.sendTool('ponderosa_message',{text:'Updated task complete.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:true})).adapter});
});


test('same-model Chat guidance preserves the original objective through one managed handoff',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Same-model guidance transition');
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Synthetic earlier guidance.'}));
  const agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Preserve the original objective and completed research.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_message',{text:'Research completed.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Synthetic updated guidance.'}));
  await f.send(agent.id,'Continue with the updated guidance.');
  const pending=await until(()=>store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending' AND payload_json LIKE ?").get(agent.id,'%Continue with the updated guidance.%'),'original task stays pending',20000);
  const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old handoff',20000);
  assert.equal(old[1].params.threadId,old[0].params.threadId);
  assert.equal(old[1].params.model,old[0].params.model);
  assert.ok(!JSON.stringify(old[1]).includes('Continue with the updated guidance.'));
  await native.sendAnswer('The original objective remains; earlier research is complete.');
  const next=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'replacement',20000);
  assert.notEqual(next[2].params.threadId,old[0].params.threadId);
  assert.ok(JSON.stringify(next[2]).includes('The original objective remains; earlier research is complete.'));
  const opened=(await native.requests()).filter(x=>x.method==='thread/start');
  assert.equal(opened.length,2);
  assert.ok(JSON.stringify(opened[1]).includes('Synthetic updated guidance.'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'original queued task',20000);
  assert.equal(final[3].params.threadId,next[2].params.threadId);
  assert.ok(JSON.stringify(final[3]).includes('Continue with the updated guidance.'));
  await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(pending.id).n,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});


test('guidance changed after lease defers the uninjected task into a managed handoff',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prompt edit during admission'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective and prior work.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_message',{text:'Initial work complete.'});await f.settled(agent.id);
  const originalLease=CoordinationV3Store.prototype.leaseNextRun;let changed=false;
  CoordinationV3Store.prototype.leaseNextRun=function(...args){
   const lease=originalLease.apply(this,args);
   if(lease && !changed && lease.agentId===agent.id && lease.activations.some(a=>a.kind==='human_message')){
    changed=true;assert.ok(store.updateConversation(chat.id,{instructions:'Guidance edited after preflight.'}));
   }
   return lease;
  };
  t.after(()=>{CoordinationV3Store.prototype.leaseNextRun=originalLease;});
  await f.send(agent.id,'The exact queued objective.');
  const handoff=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old session handoff after deferral',20000);
  assert.equal(changed,true);
  assert.equal(handoff[1].params.threadId,handoff[0].params.threadId);
  assert.ok(!JSON.stringify(handoff[1]).includes('The exact queued objective.'));
  const task=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1").get(agent.id,'%The exact queued objective.%');assert.ok(task);
  const prior=store.sqlite.prepare("SELECT r.* FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id WHERE a.activation_id=? AND r.status='cancelled'").get(task.id);
  assert.ok(prior);assert.equal(prior.prompt_injection_state,'not_injected');assert.equal(prior.started_at,null);
  await native.sendAnswer('The objective and earlier work remain.');
  const confirmation=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'replacement confirmation',20000);
  assert.ok(JSON.stringify(confirmation[2]).includes('The objective and earlier work remain.'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'queued task',20000);
  assert.equal(final[3].params.threadId,confirmation[2].params.threadId);
  assert.ok(JSON.stringify(final[3]).includes('The exact queued objective.'));
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start'&&JSON.stringify(x).includes('The exact queued objective.')).length,1);
  await native.sendTool('ponderosa_message',{text:'Finished the exact task.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

test('a later guidance change during the handoff cannot publish a stale replacement',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prompt changes during handoff'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_message',{text:'Initial work complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'First updated guidance.'}));
  await f.send(agent.id,'Original pending task.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff',20000);
  const rollover=store.sqlite.prepare("SELECT id FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id);assert.ok(rollover);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Second updated guidance.'}));
  await native.sendAnswer('This stale handoff must not be transferred.');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state IN ('failed','outcome_unknown')").get(rollover.id),'held stale handoff',20000);
  assert.ok(store.sqlite.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending') AND payload_json LIKE ?").get(agent.id,'%Original pending task.%'));
  assert.ok(!(await native.requests()).filter(x=>x.method==='turn/start').some(x=>JSON.stringify(x).includes('This stale handoff must not be transferred.')));
  assert.ok(!(await native.requests()).filter(x=>x.method==='turn/start').some(x=>JSON.stringify(x).includes('Original pending task.')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});


test('same-model guidance handoff retains an unchanged authorized memory source',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prompt transition with memory'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic violet observatory source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Preserve the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  const read=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory read');
  assert.ok(JSON.stringify(read).includes('Synthetic violet observatory source.'));
  await native.sendTool('ponderosa_message',{text:'Initial research complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Updated guidance for the same model.'}));
  await f.send(agent.id,'Continue the original objective.');
  const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old handoff',20000);
  assert.equal(old[1].params.threadId,old[0].params.threadId);
  await native.sendAnswer('Objective retained, including the authorized violet source.');
  const next=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'replacement',20000);
  assert.ok(JSON.stringify(next[2]).includes('Objective retained, including the authorized violet source.'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'original queued task',20000);
  assert.equal(final[3].params.threadId,next[2].params.threadId);
  assert.ok(JSON.stringify(final[3]).includes('Continue the original objective.'));
  await native.sendTool('ponderosa_message',{text:'The objective is complete.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'prompt_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('revoking a read memory during a same-model guidance handoff prevents transfer',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prompt transition revoked memory'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic revoked violet source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Preserve the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  const read=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory read');
  assert.ok(JSON.stringify(read).includes('Synthetic revoked violet source.'));
  await native.sendTool('ponderosa_message',{text:'Initial research complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Updated guidance for the same model.'}));
  await f.send(agent.id,'Continue the original objective.');
  const rollover=await until(()=>store.sqlite.prepare("SELECT id FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'prompt handoff',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff',20000);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await native.sendAnswer('Synthetic revoked source must never transfer.');
  const pause=await accessRevocationPause(store,agent.id,'handoff','context_rollover_handoff');
  assert.equal(pause.rollover_id,rollover.id);
  assert.ok(store.sqlite.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending') AND payload_json LIKE ?").get(agent.id,'%Continue the original objective.%'));
  assert.ok(!(await native.requests()).filter(x=>x.method==='turn/start').some(x=>JSON.stringify(x).includes('Synthetic revoked source must never transfer.')));
  assert.equal(store.sqlite.prepare('SELECT handoff_event_id FROM context_rollovers WHERE id=?').get(rollover.id).handoff_event_id,null);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'prompt_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});


test('an interrupted prompt handoff remains held without replay after restart',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Interrupted prompt handoff'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Preserve the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Guidance changed for this task.'}));
  await f.send(agent.id,'The original queued task remains.');
  const rollover=await until(()=>store.sqlite.prepare("SELECT * FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'prompt handoff',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'handoff submitted',20000);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections i JOIN scheduler_run_activations a ON a.run_id=i.run_id JOIN agent_activations x ON x.id=a.activation_id WHERE x.kind='context_rollover_handoff' AND i.state='acknowledged' AND json_extract(x.payload_json,'$.rolloverId')=?").get(rollover.id),'handoff acknowledged',20000);
  await f.reopen();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state IN ('failed','outcome_unknown')").get(rollover.id),'interrupted handoff recorded',20000);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind='context_rollover_handoff' AND json_extract(payload_json,'$.rolloverId')=?").get(rollover.id).n,1);
  assert.ok(store.sqlite.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending') AND payload_json LIKE ?").get(agent.id,'%The original queued task remains.%'));
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,2);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});


test('combined model and prompt change holds if target guidance changes before replacement',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Combined transition target'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first turn');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'First target guidance.'}));
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'The original queued task.');
  const rollover=await until(()=>store.sqlite.prepare("SELECT id FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'handoff',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff',20000);
  const originalLease=CoordinationV3Store.prototype.leaseNextRun;let changed=false;
  CoordinationV3Store.prototype.leaseNextRun=function(...args){
   const lease=originalLease.apply(this,args);
   if(lease && !changed && lease.agentId===agent.id && lease.activations.some(a=>a.kind==='context_rollover_continuation')){
    changed=true;assert.ok(store.updateConversation(chat.id,{instructions:'Later target guidance.'}));
   }
   return lease;
  };
  t.after(()=>{CoordinationV3Store.prototype.leaseNextRun=originalLease;});
  await native.sendAnswer('Original objective preserved in the handoff.');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state IN ('failed','outcome_unknown')").get(rollover.id),'changed target held',20000);
  assert.equal(changed,true);
  assert.ok(store.sqlite.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending') AND payload_json LIKE ?").get(agent.id,'%The original queued task.%'));
  const turns=(await native.requests()).filter(x=>x.method==='turn/start');
  assert.equal(turns.length,2,'the changed target never receives the handoff or queued work');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

for(const missingPrompt of [false,true])test('legacy prompt boundary holds original task; missing prompt='+missingPrompt,{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Legacy prompt change'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Preserve earlier objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first turn');
  await native.sendTool('ponderosa_message',{text:'Initial work complete.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id),packet=store.acceptedProviderSessionInput(agent.id);assert.ok(packet?.exactSystemPrompt);
  store.sqlite.prepare("UPDATE provider_inputs SET source_manifest_json=json_remove(source_manifest_json,'$.normalRuntimeContract'), provider_system_prompt=CASE WHEN ? THEN '' ELSE provider_system_prompt END WHERE execution_id=?").run(Number(missingPrompt),packet.executionId);
  assert.equal(store.acceptedProviderSessionInput(agent.id).sourceManifest.normalRuntimeContract,undefined);
  if(missingPrompt)f.ok(await f.api('PATCH','/api/workspace/preferences',{globalInstructions:'Changed workspace guidance after legacy session.'}));
  else f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Changed guidance after legacy session.'}));
  await f.send(agent.id,'The original queued work.');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM activation_sources h JOIN agent_activations a ON a.id=h.activation_id WHERE a.agent_id=? AND h.source_kind='settings_transition_reservation_wait' AND a.state IN ('pending','retry_pending')").get(agent.id),'legacy prompt review hold',20000);
  assert.equal(store.resumeSessionState(agent.id).sessionId,accepted.sessionId);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

test('capability change after verified replacement holds the exact queued task',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Access changes after replacement'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first turn');
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Updated guidance.'}));
  await f.send(agent.id,'The exact pending objective.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'old handoff',20000);
  await native.sendAnswer('Original objective retained.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=3,'replacement confirmation',20000);
  const originalLease=CoordinationV3Store.prototype.leaseNextRun;let changed=false;
  CoordinationV3Store.prototype.leaseNextRun=function(...args){
   const lease=originalLease.apply(this,args);
   if(lease && !changed && lease.agentId===agent.id && lease.activations.some(a=>a.kind==='human_message')){
    changed=true;new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.browserRead]});
   }
   return lease;
  };
  t.after(()=>{CoordinationV3Store.prototype.leaseNextRun=originalLease;});
  await native.sendAnswer('Continuity context received.');
  await until(()=>changed,'queued-task lease',20000);
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id,a.state FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.payload_json LIKE ? AND s.source_kind='settings_transition_reservation_wait' AND a.state IN ('pending','retry_pending')`).get(agent.id,'%The exact pending objective.%'),'exact task held for access review',20000);
  assert.ok(held);
  assert.ok(!(await native.requests()).filter(x=>x.method==='turn/start').some(x=>JSON.stringify(x).includes('The exact pending objective.')));
  assert.ok(!store.readEvents(agent.id).some(e=>e.event.type==='session_reset'&&e.event.reason==='tool_contract_changed'));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});


for(const timing of ['idle','during-run'])test('workspace prompt refresh preserves native-only work across '+timing+' edit',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Workspace prompt continuity'),agent=await f.createIdleAgent(chat,'Worker');
  const finding='Synthetic private tool finding: violet relay is disconnected.';
  const objective='Inspect the relay, preserve findings, and finish the original objective.';
  const history=()=>store.sqlite.prepare('SELECT row_key,text FROM chat_search_messages WHERE project_id=? ORDER BY row_key').all(agent.projectId);
  await f.send(agent.id,objective);
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial native work');
  await native.sendWorkResult(finding);
  await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output===finding),'native-only tool result retained');
  assert.ok(!JSON.stringify(history()).includes(finding),'tool work is not silently published as Communication');
  const edit=async()=>{
   const before=history(),accepted=store.resumeSessionState(agent.id);
   const preferences=f.ok(await f.api('GET','/api/workspace/preferences'));
   const patch=timing==='idle'?{globalInstructions:'Keep relay verification explicit.'}:{profile:{...preferences.profile,displayName:'Relay Reviewer'}};
   f.ok(await f.api('PATCH','/api/workspace/preferences',patch));
   assert.deepEqual(history(),before,'workspace edit leaves canonical history unchanged');
   assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted?.sessionId,'edit retains accepted context until verified handoff');
  };
  if(timing==='during-run')await edit();
  await native.sendTool('ponderosa_message',{text:'Inspection progressed; the original objective is not complete.'});await f.settled(agent.id);
  assert.ok(store.resumeSessionState(agent.id)?.sessionId);
  if(timing==='idle')await edit();
  const followup='Continue the original relay objective.';
  await f.send(agent.id,followup);
  const starts=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length>=2?rows:undefined;},'old-context handoff',20000);
  assert.equal(starts[1].params.threadId,starts[0].params.threadId,'handoff inspects the context that observed tool work');
  assert.ok(!JSON.stringify(starts[1]).includes(followup),'queued task is not replayed into old context');
  const summary=objective+' '+finding+' The objective remains unfinished.';
  await native.sendAnswer(summary);
  const replacement=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length>=3?rows:undefined;},'verified replacement input',20000);
  assert.notEqual(replacement[2].params.threadId,starts[0].params.threadId);
  assert.ok(JSON.stringify(replacement[2]).includes(summary),'actual handoff carries native-only finding and unfinished objective');
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length>=4?rows:undefined;},'original queued input',20000);
  assert.equal(final[3].params.threadId,replacement[2].params.threadId);
  assert.ok(JSON.stringify(final[3]).includes(followup));
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1);
  assert.equal(store.readEvents(agent.id).filter(x=>x.event.type==='session_reset').length,0,'no direct bounded fresh-seed reset');
  await native.sendTool('ponderosa_message',{text:'The original objective is complete.'});await f.settled(agent.id);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,4,'no uncertain replay or extra provider turn');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});


test('unchanged known prompt continues the accepted native session',{timeout:90000},async t=>{
 let store,native;await withFixture(t,async f=>{
  const chat=await f.createChat('Unchanged prompt'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'The original objective remains unfinished.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'Progress only.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id);assert.ok(store.acceptedProviderSessionInput(agent.id)?.exactSystemPrompt);
  await f.send(agent.id,'Continue the same objective.');
  const rows=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length===2?x:undefined;},'compatible continuation');
  assert.equal(rows[1].params.threadId,rows[0].params.threadId);
  assert.equal(store.resumeSessionState(agent.id).sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,0);
  await native.sendTool('ponderosa_message',{text:'Objective complete.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

test('fresh prompt lookup failure preserves its redacted cause and exact queued work',{timeout:90000},async t=>{
 let store,native,fail=false;
 const secret='synthetic-prompt-token-7342',name='PONDEROSA_TEST_PROMPT_TOKEN',prior=process.env[name];process.env[name]=secret;
 t.after(()=>{if(prior===undefined)delete process.env[name];else process.env[name]=prior;});
 const original=AgentStore.prototype.acceptedProviderSessionInput;
 AgentStore.prototype.acceptedProviderSessionInput=function(...args){const packet=original.apply(this,args);return fail&&packet?{...packet,get exactSystemPrompt(){throw new Error('Synthetic saved prompt lookup failed '+secret);}}:packet;};
 t.after(()=>{AgentStore.prototype.acceptedProviderSessionInput=original;});
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prompt lookup failure'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Preserve original objective.');await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first turn');
  await native.sendTool('ponderosa_message',{text:'Progress only.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id);fail=true;
  f.ok(await f.api('PATCH','/api/workspace/preferences',{globalInstructions:'Changed workspace instructions.'}));
  await f.send(agent.id,'The exact queued objective.');
  const held=await until(()=>store.sqlite.prepare("SELECT a.id FROM agent_activations a JOIN activation_sources h ON h.activation_id=a.id WHERE a.agent_id=? AND a.state='pending' AND h.source_kind='settings_transition_reservation_wait'").get(agent.id),'exact context hold',20000);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(x=>x.body.includes('Synthetic saved prompt lookup failed')));
  assert.ok(!JSON.stringify(notices).includes(secret),'known secret is redacted from fresh cause');
  assert.equal(store.resumeSessionState(agent.id).sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,1,'failure does not dispatch or replay');
  fail=false;
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});


test('human capability grant preserves native-only work through the old restrictive handoff',{timeout:90000},async t=>{
 let store,native,selectedAgent,validatedGrant=false;
 const requestTransition=CoordinationV3Store.prototype.requestContextRollover;
 CoordinationV3Store.prototype.requestContextRollover=function(input){
  if(input.agentId===selectedAgent&&input.settingsTransition){
   for(const key of ['targetRestrictionsHash','targetSystemPromptHash'])assert.throws(()=>requestTransition.call(this,{...input,settingsTransition:{...input.settingsTransition,[key]:'0'.repeat(64)}}),/exact capability grant/,'canonical transaction rejects a substituted grant or instruction binding');
   validatedGrant=true;
  }
  return requestTransition.call(this,input);
 };
 t.after(()=>{CoordinationV3Store.prototype.requestContextRollover=requestTransition;});
 await withFixture(t,async f=>{
  const chat=await f.createChat('Grant continuity'),agent=await f.createIdleAgent(chat,'Worker');
  selectedAgent=agent.id;
  const url=`/api/agents/${agent.id}/capabilities`,finding='Synthetic native-only result: amber relay requires verification.';
  f.ok(await f.api('PUT',url,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]}));
  await f.send(agent.id,'Preserve relay findings and finish the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial native turn');
  await native.sendWorkResult(finding);
  await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output===finding),'native-only finding');
  await native.sendTool('ponderosa_message',{text:'Research progressed; relay verification remains.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id),before=store.sqlite.prepare('SELECT row_key,text FROM chat_search_messages WHERE project_id=? ORDER BY row_key').all(agent.projectId);
  assert.ok(!JSON.stringify(before).includes(finding));
  const granted=f.ok(await f.api('PUT',url,{revision:1,restrictedCapabilityIds:[]}));
  assert.deepEqual(granted.effective.restrictedCapabilityIds,[]);
  assert.deepEqual(store.sqlite.prepare('SELECT row_key,text FROM chat_search_messages WHERE project_id=? ORDER BY row_key').all(agent.projectId),before,'Save changes policy, never original history');
  assert.equal(store.resumeSessionState(agent.id).sessionId,accepted.sessionId);
  const followup='Continue relay verification with the newly approved tools.';await f.send(agent.id,followup);
  const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'owned old-restriction handoff',20000);
  assert.equal(old[1].params.threadId,old[0].params.threadId);assert.ok(!JSON.stringify(old[1]).includes(followup));
  const rollover=store.sqlite.prepare('SELECT * FROM context_rollovers WHERE agent_id=?').get(agent.id);assert.ok(rollover);assert.equal(validatedGrant,true);
  const handoffRun=store.sqlite.prepare("SELECT x.run_id FROM scheduler_run_activations x JOIN agent_activations a ON a.id=x.activation_id WHERE a.kind='context_rollover_handoff' AND json_extract(a.payload_json,'$.rolloverId')=?").get(rollover.id);assert.ok(handoffRun);
  const oldPacket=store.getProviderInput(handoffRun.run_id,true);assert.ok(oldPacket);
  assert.deepEqual(oldPacket.sourceManifest.normalRuntimeContract.capabilityRestrictions.restrictedCapabilityIds,[CAPABILITY_IDS.hostFileImport]);
  assert.ok(!oldPacket.sourceManifest.normalRuntimeContract.dynamicTools.some(x=>x.name==='ponderosa_import_file'));
  const summary='The original relay objective is unfinished. '+finding;await native.sendAnswer(summary);
  const replacement=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'expanded replacement',20000);
  assert.notEqual(replacement[2].params.threadId,old[0].params.threadId);assert.ok(JSON.stringify(replacement[2]).includes(summary));
  const current=store.sqlite.prepare('SELECT * FROM context_rollovers WHERE id=?').get(rollover.id),packet=store.getProviderInput(current.replacement_run_id,true);
  assert.deepEqual(packet.sourceManifest.normalRuntimeContract.capabilityRestrictions.restrictedCapabilityIds,[]);
  assert.ok(packet.sourceManifest.normalRuntimeContract.dynamicTools.some(x=>x.name==='ponderosa_import_file'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'original queued task',20000);
  assert.equal(final[3].params.threadId,replacement[2].params.threadId);assert.ok(JSON.stringify(final[3]).includes(followup));
  const pending=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND payload_json LIKE ?").get(agent.id,'%'+followup+'%');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(pending.id).n,1);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1);
  assert.ok(!store.readEvents(agent.id).some(x=>x.event.type==='session_reset'&&x.event.reason==='tool_contract_changed'));
  await native.sendTool('ponderosa_message',{text:'The relay objective is complete.'});await f.settled(agent.id);
  const savedPolicy=f.ok(await f.api('GET',url));assert.equal(savedPolicy.policy.revision,2);assert.deepEqual(savedPolicy.effective.restrictedCapabilityIds,[],'handoff never restores old human policy');
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,4);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

async function prepareFolderGit(f,store,chat){
 const {writeFile}=await import('node:fs/promises'),{execFileSync}=await import('node:child_process');
 const cwd=store.getChatContext(chat.id).hostPath;
 assert.ok(cwd===f.root||cwd.startsWith(f.root+path.sep),'Git setup is confined to the owned fixture');
 const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@localhost',...args],{cwd,stdio:'pipe'});
 git(['init','--initial-branch=main']);await writeFile(path.join(cwd,'owned-fixture.txt'),'owned folder fixture\n');git(['add','owned-fixture.txt']);git(['commit','-m','Owned fixture']);
 return cwd;
}
async function folderStatus(f,id){return f.ok(await f.api('GET',`/api/agents/${id}/working-folder-change`));}

test('idle working-folder changes preserve native-only findings and verify the actual new cwd before queued work',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Working-folder continuity'),agent=await f.createIdleAgent(chat,'Worker');
  const shared=await prepareFolderGit(f,store,chat);
  await f.send(agent.id,'Preserve this objective and its private native research.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendWorkResult('Private native finding: violet gearbox 641.');
  await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.id==='synthetic-private-work'&&x.event.output==='Private native finding: violet gearbox 641.'),'native-only work');
  await native.sendTool('ponderosa_message',{text:'Research is recorded.'});await f.settled(agent.id);
  let expectedStarts=1;
  for(const mode of ['separate_git','shared']){
   const before=store.getAgent(agent.id),response=await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:mode});assert.equal(response.status,202);const first=f.ok(response);
   assert.equal(first.workingCopy.mode,before.workingCopy.mode,'pending Save does not pretend its mode is saved');
   assert.equal(first.workingCopyChange.phase,'handoff');
   const repeated=f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:mode}));
   assert.equal(repeated.workingCopyChange.rolloverId,first.workingCopyChange.rolloverId);
   const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length===expectedStarts+1?x:undefined;},'one old-session handoff',20000);
   assert.equal(old.at(-1).params.threadId,old.at(-2).params.threadId);
   assert.equal(store.getAgent(agent.id).workingCopy.id,before.workingCopy.id,'handoff precedes folder mutation');
   if(mode==='shared')await f.send(agent.id,'Now complete the original objective once.');
   await native.sendAnswer('Continue the preserved objective. Private native finding: violet gearbox 641.');
   const next=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length===expectedStarts+2?x:undefined;},'new-cwd verification',20000);
   assert.notEqual(next.at(-1).params.threadId,old.at(-1).params.threadId);
   assert.ok(JSON.stringify(next.at(-1)).includes('violet gearbox 641'),'noncanonical native finding survives via the real handoff');
   const pending=await folderStatus(f,agent.id);assert.equal(pending.workingCopy.mode,mode);assert.equal(pending.workingCopyChange.phase,'verifying');
   const calls=await native.requests();assert.equal(calls.filter(x=>x.method==='thread/start').at(-1).params.cwd,pending.workingCopy.rootPath);
   assert.equal(calls.filter(x=>x.launchCwd).at(-1).launchCwd,pending.workingCopy.rootPath,'provider process actually launches at the new cwd');
   if(mode==='shared')assert.equal(pending.workingCopy.rootPath,shared);
   assert.equal(next.length,expectedStarts+2,'queued work stays out until replacement verification');
   await native.sendAnswer('Preserved context verified.');
   await until(async()=>(await folderStatus(f,agent.id)).workingCopyChange.phase==='completed','accepted new context',20000);
   expectedStarts+=2;
   if(mode==='shared'){
    const work=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length===expectedStarts+1?x:undefined;},'queued objective',20000);
    assert.equal(work.at(-1).params.threadId,next.at(-1).params.threadId);assert.ok(JSON.stringify(work.at(-1)).includes('Now complete the original objective once.'));
    await native.sendTool('ponderosa_message',{text:'Objective completed.'});expectedStarts++;
   }
   await f.settled(agent.id);
   const count=store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n;
   const same=f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:mode}));assert.equal(same.workingCopy.mode,mode);
   assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,count,'same-mode Save is a no-op');
  }
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,expectedStarts);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true,recordCwd:true})).adapter});
});

test('working-folder mutation refusal retains context and retries the same committed handoff without replay',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const {writeFile,unlink}=await import('node:fs/promises');
  const chat=await f.createChat('Folder failure and retry'),agent=await f.createIdleAgent(chat,'Worker');await prepareFolderGit(f,store,chat);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'separate_git'}));
  await f.send(agent.id,'Keep the working-folder objective.');await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');
  await native.sendWorkResult('Native work is retained.');await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output==='Native work is retained.'),'actual native work before reply');await native.sendTool('ponderosa_message',{text:'Native research is recorded.'});await f.settled(agent.id);
  const old=store.getAgent(agent.id),dirty=path.join(old.workingCopy.rootPath,'owned-untracked.txt');await writeFile(dirty,'preserve me');
  const saved=f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'shared'}));
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'handoff');await native.sendAnswer('Keep the objective and native working state.');
  const held=await until(async()=>{const x=await folderStatus(f,agent.id);return x.workingCopyChange?.phase==='held'?x:undefined;},'dirty-copy refusal',20000);
  assert.equal(held.workingCopy.id,old.workingCopy.id);assert.equal(held.workingCopyChange.canKeepCurrent,true);assert.match(held.workingCopyChange.message,/changed|untracked|ignored|preserv/i);
  await f.send(agent.id,'Queued work must not silently reseed.');
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,2);
  await unlink(dirty);
  const retry=f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'shared'}));assert.equal(retry.workingCopyChange.rolloverId,saved.workingCopyChange.rolloverId);
  const next=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length===3?x:undefined;},'same-handoff replacement',20000);
  assert.ok(JSON.stringify(next[2]).includes('Keep the objective and native working state.'));
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE agent_id=? AND kind='context_rollover_handoff'").get(agent.id).n,1,'retry never repeats compaction/handoff');
  await native.sendAnswer('Context verified.');await until(async()=>(await folderStatus(f,agent.id)).workingCopyChange.phase==='completed','verified',20000);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===4,'retained queued work',20000);
  await native.sendTool('ponderosa_message',{text:'Queued objective completed.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

test('restart during a working-folder handoff retains the exact choice and refuses replay or fresh fallback',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Interrupted folder Save'),agent=await f.createIdleAgent(chat,'Worker');await prepareFolderGit(f,store,chat);
  await f.send(agent.id,'Preserve the original working context.');await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');await native.sendWorkResult('Prior native context retained.');await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output==='Prior native context retained.'),'prior native work before reply');await native.sendTool('ponderosa_message',{text:'Prior research is recorded.'});await f.settled(agent.id);
  const before=store.getAgent(agent.id),saved=f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'separate_git'}));
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'handoff submitted');
  await f.reopen();
  const held=await until(async()=>{const x=await folderStatus(f,agent.id);return x.workingCopyChange?.phase==='held'?x:undefined;},'interrupted Save retained',20000);
  assert.equal(held.workingCopy.id,before.workingCopy.id);assert.equal(held.workingCopyChange.rolloverId,saved.workingCopyChange.rolloverId);
  assert.equal(held.workingCopyChange.canKeepCurrent,false,'uncertain handoff cannot be cancelled as unchanged');
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/working-folder-change/${saved.workingCopyChange.rolloverId}/keep`,{})).status,409);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'separate_git'}));
  await f.send(agent.id,'Do not replay the uncertain handoff.');
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,2);
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE agent_id=? AND kind='context_rollover_handoff'").get(agent.id).n,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});


test('dirty working-folder refusal can explicitly keep the unchanged folder and native context',{timeout:90000},async t=>{
 let store,native;await withFixture(t,async f=>{
  const {writeFile,readFile}=await import('node:fs/promises');
  const chat=await f.createChat('Keep unchanged folder'),agent=await f.createIdleAgent(chat,'Worker');await prepareFolderGit(f,store,chat);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'separate_git'}));
  await f.send(agent.id,'Retain the original objective and native work.');await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial turn');await native.sendWorkResult('Private finding remains in the accepted native session.');await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.id==='synthetic-private-work'&&x.event.output==='Private finding remains in the accepted native session.'),'actual private native finding');await native.sendTool('ponderosa_message',{text:'Progress recorded.'});await f.settled(agent.id);
  const before=store.getAgent(agent.id),session=store.resumeSessionState(agent.id),dirty=path.join(before.workingCopy.rootPath,'owned-untracked.txt');await writeFile(dirty,'retain unchanged bytes');
  const saved=f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'shared'}));
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'handoff');await native.sendAnswer('Preserve the native finding and original objective.');
  const held=await until(async()=>{const value=await folderStatus(f,agent.id);return value.workingCopyChange?.phase==='held'&&value.workingCopyChange.canKeepCurrent?value:undefined;},'safe unchanged-folder escape',20000);
  assert.equal(held.workingCopy.id,before.workingCopy.id);await f.send(agent.id,'Continue the original task in the unchanged folder.');assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,2);
  const url=`/api/agents/${agent.id}/working-folder-change/${saved.workingCopyChange.rolloverId}/keep`,kept=f.ok(await f.api('POST',url,{}));assert.equal(kept.workingCopyChange.phase,'kept_current');assert.equal(kept.workingCopy.id,before.workingCopy.id);
  f.ok(await f.api('POST',url,{}));
  const work=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===3?rows:undefined;},'queued work in retained native context',20000);
  assert.equal(work[2].params.threadId,work[0].params.threadId);assert.ok(JSON.stringify(work[2]).includes('Continue the original task in the unchanged folder.'));
  assert.equal(store.resumeSessionState(agent.id).sessionId,session.sessionId);assert.equal(await readFile(dirty,'utf8'),'retain unchanged bytes');
  assert.equal((await native.requests()).find(x=>x.method==='thread/start').params.cwd,before.workingCopy.rootPath,'retained native session actually opened in the unchanged folder');
  await native.sendWorkResult('Continuation retained the native finding in the unchanged session.');
  await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output==='Continuation retained the native finding in the unchanged session.'),'fresh owned usage before another turn');
  await native.sendTool('ponderosa_message',{text:'Original objective continued.'});await f.settled(agent.id);
  const prior=f.ok(await f.api('GET',`/api/agents/${agent.id}`)).runs.map(x=>x.id);
  await f.send(agent.id,'Use the retained private finding to finish the next step after keeping this folder.');
  const fresh=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length===4?rows:undefined;},'new instruction after Keep',20000);
  assert.equal(fresh[3].params.threadId,work[0].params.threadId);assert.ok(JSON.stringify(fresh[3]).includes('Use the retained private finding'));
  await native.sendTool('ponderosa_message',{text:'Next step completed using retained native context.'});await f.settled(agent.id,prior);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,4);assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE agent_id=? AND kind='context_rollover_handoff'").get(agent.id).n,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

test('working-folder history preserves older uncertainty but newer unresolved input blocks reservation and Keep',{timeout:90000},async t=>{
 const original=CoordinationV3Store.prototype.requestContextRollover;let requested;
 CoordinationV3Store.prototype.requestContextRollover=function(input){if(input.workingCopyTransition)requested=structuredClone(input);return original.call(this,input);};
 t.after(()=>{CoordinationV3Store.prototype.requestContextRollover=original;});
 for(const newer of [false,'source','later']){
  let store,native;await withFixture(t,async f=>{
   const {writeFile}=await import('node:fs/promises');
   const chat=await f.createChat('Retained historical uncertainty '+newer),agent=await f.createIdleAgent(chat,'Worker');await prepareFolderGit(f,store,chat);
   await f.send(agent.id,'Preserve the current valid objective.');await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial native turn');
   await native.sendWorkResult('Original native finding.');await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output==='Original native finding.'),'actual finding');await native.sendTool('ponderosa_message',{text:'Progress recorded.'});await f.settled(agent.id);
   const historical=store.providerCommandContextBoundary(agent.id).executionId;
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'separate_git'}));
   await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'first actual handoff');await native.sendAnswer('Preserve original native finding and objective.');
   await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===3,'accepted new generation');await native.sendAnswer('Native context reconstructed.');
   await until(async()=>(await folderStatus(f,agent.id)).workingCopyChange.phase==='completed','first folder verified');await f.settled(agent.id);
   const current=store.providerCommandContextBoundary(agent.id);assert.ok(current.fencingToken>store.sqlite.prepare('SELECT fencing_token FROM scheduler_runs WHERE id=?').get(historical).fencing_token);
   // Seed a retained older unknown row after constructing a real newer accepted
   // generation. This qualifies guard scope, not an external recovery workflow.
   store.sqlite.prepare("UPDATE scheduler_runs SET status='outcome_unknown',prompt_injection_state='injecting' WHERE id=?").run(historical);
   const oldBytes=JSON.stringify(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(historical));
   const before=store.getAgent(agent.id);await writeFile(path.join(before.workingCopy.rootPath,'owned-untracked.txt'),'preserve historical fixture');
   const save=await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'shared'});assert.equal(save.status,202,'older retained uncertainty does not veto a valid newer source');const saved=f.ok(save),intent=structuredClone(requested);
   await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===4,'current generation handoff');await native.sendAnswer('Keep current native context and objective.');
   const held=await until(async()=>{const value=await folderStatus(f,agent.id);return value.workingCopyChange?.phase==='held'?value:undefined;},'dirty failure with older history');assert.equal(held.workingCopyChange.canKeepCurrent,true,'older uncertainty does not permanently lock the unchanged folder');
   if(newer){
    const row=store.sqlite.prepare('SELECT source_execution_id FROM continuation_handoffs WHERE id=(SELECT handoff_event_id FROM context_rollovers WHERE id=?)').get(saved.workingCopyChange.rolloverId);
    store.sqlite.prepare("UPDATE scheduler_runs SET status='outcome_unknown',prompt_injection_state='injecting' WHERE id=?").run(newer==='source'?intent.sourceRunId:row.source_execution_id);
    assert.equal((await folderStatus(f,agent.id)).workingCopyChange.canKeepCurrent,false,'later unresolved input still vetoes Keep');
    assert.equal((await f.api('POST',`/api/agents/${agent.id}/working-folder-change/${saved.workingCopyChange.rolloverId}/keep`,{})).status,409);
    assert.throws(()=>new CoordinationV3Store(store.sqlite).requestContextRollover(intent),/saved working-folder context boundary changed/,'later uncertainty still vetoes canonical reservation');
   }else{
    const kept=f.ok(await f.api('POST',`/api/agents/${agent.id}/working-folder-change/${saved.workingCopyChange.rolloverId}/keep`,{}));assert.equal(kept.workingCopyChange.phase,'kept_current');assert.equal(kept.workingCopy.id,before.workingCopy.id);
   }
   assert.equal(JSON.stringify(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(historical)),oldBytes,'older uncertainty is neither rewritten nor certified resolved');
  },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
 }
});

test('working-folder memory authorization includes earlier reads before a later completed native Run',{timeout:90000},async t=>{
 let store,native;await withFixture(t,async f=>{
  const chat=await f.createChat('Earlier native memory read'),agent=await f.createIdleAgent(chat,'Worker');await prepareFolderGit(f,store,chat);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const savedMemory=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic earlier folder lineage source.',destination:'global'}));
  const memoryId=savedMemory.structuredContent?.result?.chunk_id;assert.ok(memoryId,'real synthetic memory source saved');
  await f.send(agent.id,'Read memory and preserve the original objective.');await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first memory turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:memoryId,source:'global'});const response=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'actual memory result');assert.equal(response.result.success,true);assert.ok(JSON.stringify(response).includes('Synthetic earlier folder lineage source.'),'earlier source was actually disclosed');
  await native.sendWorkResult('Earlier memory read completed.');await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output==='Earlier memory read completed.'),'fresh memory-turn usage');await native.sendTool('ponderosa_message',{text:'Research recorded.'});await f.settled(agent.id);
  const origin=store.acceptedProviderSessionInput(agent.id).executionId;
  await f.send(agent.id,'Continue without another memory read.');await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'later native turn');
  await native.sendWorkResult('Later work completed.');await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output==='Later work completed.'),'later fresh usage');await native.sendTool('ponderosa_message',{text:'Later work recorded.'});await f.settled(agent.id);
  assert.notEqual(store.providerCommandContextBoundary(agent.id).executionId,origin,'the latest source differs from generation origin');
  const save=await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'separate_git'});assert.equal(save.status,202);
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===3,'memory-authorized old-session handoff');await native.sendAnswer('Preserve the earlier authorized memory research and original objective.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===4,'memory-authorized folder replacement');await native.sendAnswer('Earlier memory context reconstructed.');
  await until(async()=>(await folderStatus(f,agent.id)).workingCopyChange.phase==='completed','memory-enabled folder verified');await f.settled(agent.id);
  await f.send(agent.id,'Continue the original objective after the folder change without a new memory read.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===5,'normal task traverses folder memory lineage');
  await native.sendWorkResult('Post-folder work completed.');await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output==='Post-folder work completed.'),'post-folder fresh usage');await native.sendTool('ponderosa_message',{text:'Post-folder work recorded.'});await f.settled(agent.id);
  const before=store.getAgent(agent.id),accepted=store.resumeSessionState(agent.id),count=store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n;
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  const result=await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'shared'});assert.equal(result.status,409);assert.match(result.body.error,/memory access changed|memory.*verif/i);
  assert.equal(store.getAgent(agent.id).workingCopy.id,before.workingCopy.id);assert.equal(store.resumeSessionState(agent.id).sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,count,'revoked earlier memory cannot enter another summary');assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,5,'no unreviewed native replay');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true,holdMemoryCompletion:true})).adapter,
  localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'folder_origin_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});
