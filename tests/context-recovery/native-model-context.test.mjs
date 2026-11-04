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
