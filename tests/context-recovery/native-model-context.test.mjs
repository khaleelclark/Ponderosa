import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore,CapabilityPolicyStore} from '../../packages/agents/dist/index.js';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import {withFixture,until} from '../shared/fixture.mjs';
import {inertCodex} from '../shared/inert-codex.mjs';
import {ownedChroma} from '../memory/portability-fixture.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

test('a Codex model-only change resumes its accepted thread without rebuilding context',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Retained model context');
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Preserve these Chat instructions.'}));
  const agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Remember the entire original objective.');
  const first=await until(async()=>(await native.requests()).find(x=>x.method==='turn/start'),'first native turn');
  assert.equal(first.params.model,'fixture');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status='completed'").get(agent.id),'first Run completed');
  await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id);assert.ok(accepted?.toolContractHash);
  assert.equal(accepted.sessionId,'inert-reviewed-thread');
  const previous=(await f.detail(agent.id)).runs.map(run=>run.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue the same objective with the new model.');
  const turns=await until(async()=>{const requests=await native.requests(),turns=requests.filter(x=>x.method==='turn/start');return turns.length===2?turns:undefined;},'second native turn');
  assert.equal(turns[1].params.model,'fixture-next');
  assert.equal(turns[1].params.threadId,turns[0].params.threadId);
  const requests=await native.requests();
  assert.equal(requests.filter(x=>x.method==='thread/start').length,1,'no fresh thread may replace the accepted one');
  assert.equal(requests.filter(x=>x.method==='thread/resume').length,1,'the evicted transport must resume the exact saved thread');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  await native.sendTool('ponderosa_message',{text:'Second task complete.'});
  await f.settled(agent.id,previous);
  const afterChange=store.resumeSessionState(agent.id);
  assert.equal(afterChange?.sessionId,accepted.sessionId);
  assert.notEqual(afterChange?.toolContractHash,accepted.toolContractHash,'the accepted contract advances to the new model');
  const afterSecond=(await f.detail(agent.id)).runs.map(run=>run.id);
  await f.send(agent.id,'Continue again using the selected model.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===3,'third native turn');
  const finalRequests=await native.requests();
  assert.equal(finalRequests.filter(x=>x.method==='thread/start').length,1);
  assert.equal(finalRequests.filter(x=>x.method==='thread/resume').length,2);
  await native.sendTool('ponderosa_message',{text:'Third task complete.'});
  await f.settled(agent.id,afterSecond);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true})).adapter});
});

test('a model change with changed policy does not use the model-only continuation',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Changed context policy'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'First objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  store.updateAgent(agent.id,{model:'fixture-next',role:'A changed standing instruction'});
  await f.send(agent.id,'Continue after changed policy.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'second native turn');
  const requests=await native.requests();
  assert.equal(requests.filter(x=>x.method==='thread/start').length,2,'changed policy must not qualify for the model-only exception');
  assert.equal(requests.filter(x=>x.method==='thread/resume').length,0);
  await native.sendTool('ponderosa_message',{text:'Second task complete.'});
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true})).adapter});
});

test('a mismatched native resume never sends a new turn or seeds a fresh thread',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Mismatched native thread'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'Keep this original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  store.updateAgent(agent.id,{model:'fixture-next'});
  await f.send(agent.id,'Continue with a different model.');
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'resume attempt');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('failed','outcome_unknown')").get(agent.id,JSON.stringify(prior)),'rejected continuation');
  await new Promise(resolve=>setTimeout(resolve,250));
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1,'no fresh thread after failed resume');
  assert.equal(calls.filter(x=>x.method==='thread/resume').length,1,'failed resume is not silently repeated');
  assert.equal(calls.filter(x=>x.method==='turn/start').length,1,'no new input reaches an unconfirmed thread');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
  assert.equal(store.resumeSessionState(agent.id)?.toolContractHash,old.toolContractHash);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,mismatchedResume:true})).adapter});
});

test('a rejected changed-model turn preserves the prior accepted thread without a fresh seed',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Rejected model change'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  store.updateAgent(agent.id,{model:'fixture-next'});
  await f.send(agent.id,'Continue with a different model.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'rejected turn');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('failed','outcome_unknown')").get(agent.id,JSON.stringify(prior)),'rejection settled');
  await new Promise(resolve=>setTimeout(resolve,250));
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
  assert.equal(calls.filter(x=>x.method==='thread/resume').length,1);
  assert.equal(calls.filter(x=>x.method==='turn/start').length,2,'rejected turn must not be repeated');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
  assert.equal(store.resumeSessionState(agent.id)?.toolContractHash,old.toolContractHash);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,rejectChangedModelTurn:true})).adapter});
});

test('Local Memory configured prevents the model-only continuation',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Memory enabled'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'First objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  store.updateAgent(agent.id,{model:'fixture-next'});
  await f.send(agent.id,'Continue with memory enabled.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'second native turn');
  const requests=await native.requests();
  assert.equal(requests.filter(x=>x.method==='thread/start').length,2,'memory-enabled history must not qualify for the model-only exception');
  assert.equal(requests.filter(x=>x.method==='thread/resume').length,0);
  await native.sendTool('ponderosa_message',{text:'Second task complete.'});
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),
     modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('stopping during resumed provider admission prevents model-continuation input',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Stopped model change'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  store.updateAgent(agent.id,{model:'fixture-next'});
  await f.send(agent.id,'Continue with the new model.');
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'second provider admission');
  const run=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('leased','running')").get(agent.id,JSON.stringify(prior)),'second active Run');
  f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:run.id,idempotencyKey:randomUUID()}));
  await native.releaseThread();
  await new Promise(resolve=>setTimeout(resolve,300));
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='turn/start').length,1,'no model-continuation input after Stop');
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1,'no fresh thread after Stop');
  // Stop may retire the saved session; no later turn is submitted automatically.
  assert.ok(old.sessionId);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdResume:true})).adapter});
});

for(const change of ['role','capability','chat','title'])test(`${change} changed while Codex resume is paused prevents submission`,{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Changed during resume'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  store.updateAgent(agent.id,{model:'fixture-next'});
  await f.send(agent.id,'Continue with the new model.');
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'paused native resume');
  if(change==='role')f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{role:'New standing policy after resume started'}));
  else if(change==='chat')f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'New Chat rules after resume started'}));
  else if(change==='title')f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{title:'Renamed while resuming'}));
  else new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]});
  await native.releaseThread();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('failed','outcome_unknown')").get(agent.id,JSON.stringify(prior)),'policy change rejected');
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='turn/start').length,1,'no prompt after policy changed');
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1,'no fresh seed after the failed continuation');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
  assert.equal(store.resumeSessionState(agent.id)?.toolContractHash,old.toolContractHash);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdResume:true})).adapter});
});

for(const mode of ['model','voice'])test(`memory-restricted ${mode} retains the verified first Codex thread`,{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Memory restricted continuation'),agent=await f.createIdleAgent(chat,'Worker');
  new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead,CAPABILITY_IDS.memoryWrite]});
  await f.send(agent.id,'Preserve the complete initial objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  const initial=(await native.requests()).find(x=>x.method==='thread/start');
  assert.ok(!initial.params.dynamicTools.some(tool=>tool.name.startsWith('ponderosa_local_memory_')));
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  let voiceInput;
  if(mode==='model'){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
   await f.send(agent.id,'Continue the objective on the new model.');
  }else{
   voiceInput=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{
    text:'Continue the objective aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  }
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'second native turn');
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1,'the first session is not replaced');
  assert.equal(calls.filter(x=>x.method==='thread/resume').length,1,'the provider confirms the original thread');
  const second=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status='running'").get(agent.id,JSON.stringify(prior)),'second Run');
  const packet=store.getProviderInput(second.id,true);
  assert.equal(packet.sourceManifest.providerSessionDisposition,'continued_session');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
  if(mode==='voice'){
   assert.ok(voiceInput.message.communicationEventId);
   await native.sendTool('ponderosa_voice_reply',{});
   const response=await until(async()=>{const replies=(await native.requests()).filter(call=>call.toolResponse);return replies.length>=2?replies.at(-1).toolResponse:undefined;},'voice tool response');
   assert.equal(response.result.success,true,'voice stream must be authorized');
  }else await native.sendTool('ponderosa_message',{text:'Second task complete.'});
  await f.settled(agent.id,prior);
  if(mode==='voice'){
   const event=await until(()=>store.readEvents(agent.id).find(row=>row.event.type==='voice_reply'&&row.event.reply.state==='completed'),'completed voice reply');
   assert.equal(event.event.reply.text,'The objective continues safely.');
   const status=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voiceInput.message.communicationEventId}/${agent.id}`));
   assert.equal(status.memoryExposure.state,'valid');
  }
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),
     modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('a thread that once had memory tools is not reused for a later voice request',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Memory grant changed'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'First objective with memory available.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  const initial=(await native.requests()).find(x=>x.method==='thread/start');
  assert.ok(initial.params.dynamicTools.some(tool=>tool.name.startsWith('ponderosa_local_memory_')));
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead,CAPABILITY_IDS.memoryWrite]});
  const prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'fresh voice turn');
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='thread/start').length,2,'prior memory exposure cannot use the exception');
  assert.equal(calls.filter(x=>x.method==='thread/resume').length,0);
  await native.sendTool('ponderosa_voice_reply',{});
  await f.settled(agent.id,prior);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),
     modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('memory capability changed while voice thread resume is paused prevents submission',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Memory access changed during resume'),agent=await f.createIdleAgent(chat,'Worker');
  const policies=new CapabilityPolicyStore(store.sqlite);
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead,CAPABILITY_IDS.memoryWrite]});
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});
  await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'paused voice thread resume');
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:1,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]});
  await native.releaseThread();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('failed','outcome_unknown')").get(agent.id,JSON.stringify(prior)),'changed memory capability rejected');
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='turn/start').length,1,'no voice input sent with a stale capability snapshot');
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1,'no fresh replacement after failed prewrite check');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdResume:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),
     modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('a malformed native-history fork receipt prevents voice thread reuse',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Malformed prior native fork'),agent=await f.createIdleAgent(chat,'Worker');
  new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead,CAPABILITY_IDS.memoryWrite]});
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const prior=(await f.detail(agent.id)).runs.map(run=>run.id),key=randomUUID();
  const malformed={kind:'fork',targetAgentId:agent.id,state:null};
  store.sqlite.prepare("INSERT INTO coordination_idempotency(project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at) VALUES (?,?,'native_history',?,?,?,?)").run(chat.projectId,'operator:native-history:synthetic-source',key,'synthetic',JSON.stringify(malformed),new Date().toISOString());
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'fresh voice turn');
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='thread/start').length,2);
  assert.equal(calls.filter(x=>x.method==='thread/resume').length,0,'unknown fork evidence cannot authorize reuse');
  assert.deepEqual(JSON.parse(store.sqlite.prepare("SELECT result_json FROM coordination_idempotency WHERE actor_scope=? AND idempotency_key=?").get('operator:native-history:synthetic-source',key).result_json),malformed);
  await native.sendTool('ponderosa_voice_reply',{});await f.settled(agent.id,prior);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),
     modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

for(const scenario of ['mismatched','stop'])test(`voice ${scenario} during thread resume cannot publish or seed a replacement`,{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Interrupted voice resume'),agent=await f.createIdleAgent(chat,'Worker');
  new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead,CAPABILITY_IDS.memoryWrite]});
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'voice resume');
  if(scenario==='stop'){
   const run=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('leased','running')").get(agent.id,JSON.stringify(prior)),'voice Run');
   f.ok(await f.api('POST',`/api/agents/${agent.id}/cancel`,{targetRunId:run.id,idempotencyKey:randomUUID()}));
   await native.releaseThread();
  }else await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('failed','outcome_unknown')").get(agent.id,JSON.stringify(prior)),'mismatched resume rejected');
  await new Promise(resolve=>setTimeout(resolve,250));
  const calls=await native.requests();
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1,'no fresh thread');
  assert.equal(calls.filter(x=>x.method==='thread/resume').length,1,'no automatic replay');
  assert.equal(calls.filter(x=>x.method==='turn/start').length,1,'no voice input on an unconfirmed or stopped Run');
  assert.ok(!store.readEvents(agent.id).some(row=>row.event.type==='voice_reply'&&row.event.reply.state==='completed'));
  if(scenario==='mismatched')assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,mismatchedResume:scenario==='mismatched',holdResume:scenario==='stop'})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),
     modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});
