import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore,CapabilityPolicyStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import {withFixture,until} from '../shared/fixture.mjs';
import {inertCodex} from '../shared/inert-codex.mjs';
import {ownedChroma} from '../memory/portability-fixture.mjs';
import {localMemoryFor} from '../../apps/server/dist/local-memory.js';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

/** Drive every explicit provider turn: source handoff, replacement check,
 * then the exact original task. Inspect the retained queue at each boundary. */
async function managedTask({store,native,agent,originalText,initialTurns=1,expectedModel}) {
 const pending=await until(()=>store.sqlite.prepare(`SELECT id,state FROM agent_activations
   WHERE agent_id=? AND kind='human_message' AND json_extract(payload_json,'$.communication.text')=?
   ORDER BY created_at DESC LIMIT 1`).get(agent.id,originalText),'exact original activation',20000);
 const old=await until(async()=>{const turns=(await native.requests()).filter(x=>x.method==='turn/start');return turns.length>=initialTurns+1?turns:undefined;},'old-session handoff',20000);
 const source=old[initialTurns-1],handoff=old[initialTurns];
 assert.equal(handoff.params.threadId,source.params.threadId,'handoff is bound to the accepted old session');
 assert.equal(handoff.params.model,source.params.model,'handoff keeps the accepted old model');
 assert.match(JSON.stringify(handoff),/continuation handoff/i);
 assert.ok(!JSON.stringify(handoff).includes(originalText),'queued task is not delivered to the handoff');
 assert.ok(['pending','retry_pending'].includes(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(pending.id).state));
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(pending.id).n,0);
 const summary='Original objective and completed work retained for the next session.';
 await native.sendAnswer(summary);
 const confirmation=await until(async()=>{const turns=(await native.requests()).filter(x=>x.method==='turn/start');return turns.length>=initialTurns+2?turns[initialTurns+1]:undefined;},'replacement confirmation',20000);
 assert.notEqual(confirmation.params.threadId,source.params.threadId,'replacement uses a separate thread');
 if(expectedModel)assert.equal(confirmation.params.model,expectedModel);
 assert.ok(JSON.stringify(confirmation).includes(summary),'replacement receives the actual handoff');
 assert.ok(!JSON.stringify(confirmation).includes(originalText),'confirmation does not execute the queued task');
 assert.ok(['pending','retry_pending'].includes(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(pending.id).state));
 await native.sendAnswer('Continuity context received.');
 const task=await until(async()=>{const turns=(await native.requests()).filter(x=>x.method==='turn/start');return turns.length>=initialTurns+3?turns[initialTurns+2]:undefined;},'original queued task',20000);
 assert.equal(task.params.threadId,confirmation.params.threadId);
 if(expectedModel)assert.equal(task.params.model,expectedModel);
 assert.ok(JSON.stringify(task).includes(originalText),'the original task reaches the replacement');
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(pending.id).n,1,'the original task attaches exactly once');
 const run=store.sqlite.prepare('SELECT run_id FROM scheduler_run_activations WHERE activation_id=?').get(pending.id);
 return {source,handoff,confirmation,task,runId:run.run_id,activationId:pending.id};
}

test('a Codex model change hands off the accepted context before the exact task',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Retained model context');
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Preserve these Chat instructions.'}));
  const agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Remember the entire original objective.');
  await until(async()=>(await native.requests()).find(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id);assert.ok(accepted?.toolContractHash);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  const text='Continue the same objective with the new model.';
  await f.send(agent.id,text);
  const moved=await managedTask({store,native,agent,originalText:text,expectedModel:'fixture-next'});
  await native.sendTool('ponderosa_message',{text:'Second task complete.'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(moved.runId),'original task completed');
  const afterChange=store.resumeSessionState(agent.id);
  assert.equal(afterChange?.sessionId,moved.confirmation.params.threadId);
  assert.notEqual(afterChange?.toolContractHash,accepted.toolContractHash);
  const before=(await f.detail(agent.id)).runs.map(run=>run.id);
  await f.send(agent.id,'Continue again using the selected model.');
  const third=await until(async()=>{const turns=(await native.requests()).filter(x=>x.method==='turn/start');return turns.length>=5?turns[4]:undefined;},'subsequent task');
  assert.equal(third.params.model,'fixture-next');assert.equal(third.params.threadId,moved.confirmation.params.threadId);
  await native.sendTool('ponderosa_message',{text:'Third task complete.'});await f.settled(agent.id,before);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
});

test('changed policy reaches the replacement while the handoff uses the old policy',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Changed context policy'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'First objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  store.updateAgent(agent.id,{model:'fixture-next',role:'A changed standing instruction'});
  const text='Continue after changed policy.';await f.send(agent.id,text);
  const moved=await managedTask({store,native,agent,originalText:text,expectedModel:'fixture-next'});
  const calls=await native.requests(),starts=calls.filter(x=>x.method==='thread/start');
  assert.equal(starts.length,2);
  assert.ok(!JSON.stringify(starts[0]).includes('A changed standing instruction'),'old provider policy stays unchanged');
  assert.ok(JSON.stringify(starts[1]).includes('A changed standing instruction'),'replacement receives current policy');
  await native.sendTool('ponderosa_message',{text:'Second task complete.'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(moved.runId),'original task completed');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,uniqueThreads:true})).adapter});
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

test('a rejected replacement preserves the old session and holds the original task',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Rejected model change'),agent=await f.createIdleAgent(chat,'Worker');
  store.updateAgent(agent.id,{model:'fixture',effort:'medium'});
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id);
  store.updateAgent(agent.id,{model:'fixture-next'});
  const text='Continue with a different model.';await f.send(agent.id,text);
  const prior=await until(async()=>{const a=(await native.requests()).filter(x=>x.method==='turn/start');return a.length>=2?a:undefined;},'old-session handoff',20000);
  assert.equal(prior[1].params.threadId,prior[0].params.threadId);assert.equal(prior[1].params.model,'fixture');
  assert.ok(!JSON.stringify(prior[1]).includes(text));
  await native.sendAnswer('Retain the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'&&x.params.model==='fixture-next'),'rejected replacement',20000);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state IN ('failed','outcome_unknown')").get(agent.id),'replacement rejection recorded',20000);
  const calls=await native.requests(),turns=calls.filter(x=>x.method==='turn/start');
  assert.equal(turns.filter(x=>x.params.model==='fixture-next').length,1,'rejected replacement is not repeated');
  assert.ok(!turns.some(x=>JSON.stringify(x).includes(text)),'original task was never sent');
  const queued=store.sqlite.prepare("SELECT id,state FROM agent_activations WHERE agent_id=? AND json_extract(payload_json,'$.communication.text')=?").get(agent.id,text);
  assert.ok(['pending','retry_pending'].includes(queued.state));
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(queued.id).n,0);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
  assert.equal(store.resumeSessionState(agent.id)?.toolContractHash,old.toolContractHash);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,rejectChangedModelTurn:true,uniqueThreads:true})).adapter});
});

test('unused Local Memory permits the verified model-only continuation',{timeout:30000},async t=>{
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
  assert.equal(requests.filter(x=>x.method==='thread/start').length,1,'unused memory must preserve the first thread');
  assert.equal(requests.filter(x=>x.method==='thread/resume').length,1);
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

for(const access of ['restricted','unused'])for(const mode of ['model','voice'])test(`memory-${access} ${mode} preserves authorized context`,{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Memory restricted continuation'),agent=await f.createIdleAgent(chat,'Worker');
  if(access==='restricted')new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead,CAPABILITY_IDS.memoryWrite]});
  await f.send(agent.id,'Preserve the complete initial objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  const initial=(await native.requests()).find(x=>x.method==='thread/start');
  assert.equal(initial.params.dynamicTools.some(tool=>tool.name.startsWith('ponderosa_local_memory_')),access==='unused');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  let voiceInput,runId;
  if(mode==='model'){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
   await f.send(agent.id,'Continue the objective on the new model.');
   await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'second native turn');
   const calls=await native.requests();
   assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
   assert.equal(calls.filter(x=>x.method==='thread/resume').length,1);
   const second=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status='running'").get(agent.id,JSON.stringify(prior)),'second Run');
   runId=second.id;
   const packet=store.getProviderInput(runId,true);
   assert.equal(packet.sourceManifest.providerSessionDisposition,'continued_session');
   assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
   await native.sendTool('ponderosa_message',{text:'Second task complete.'});
  }else{
   const text='Continue the objective aloud.';
   voiceInput=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{
    text,idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
   const moved=await managedTask({store,native,agent,originalText:text});
   runId=moved.runId;
   assert.equal(moved.source.params.threadId,old.sessionId);
   assert.ok(voiceInput.message.communicationEventId);
   await native.sendTool('ponderosa_voice_reply',{});
   const response=await until(async()=>{const replies=(await native.requests()).filter(call=>call.toolResponse);return replies.length>=2?replies.at(-1).toolResponse:undefined;},'voice tool response');
   assert.equal(response.result.success,true,'the original voice turn is authorized');
  }
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(runId),'exact task completed',20000);
  if(mode==='voice'){
   const status=await until(async()=>{const result=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voiceInput.message.communicationEventId}/${agent.id}`));return result.reply.state==='completed'?result:undefined;},'completed voice reply',20000);
   assert.equal(status.memoryExposure.state,'valid');
   assert.equal(status.reply.text,'The objective continues safely.');
  }
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:mode==='voice'})).adapter,
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

test('malformed native-history fork evidence is not used to authorize the original voice task',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Malformed prior native fork'),agent=await f.createIdleAgent(chat,'Worker');
  new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead,CAPABILITY_IDS.memoryWrite]});
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const key=randomUUID(),malformed={kind:'fork',targetAgentId:agent.id,state:null};
  store.sqlite.prepare("INSERT INTO coordination_idempotency(project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at) VALUES (?,?,'native_history',?,?,?,?)").run(chat.projectId,'operator:native-history:synthetic-source',key,'synthetic',JSON.stringify(malformed),new Date().toISOString());
  const text='Continue aloud.';
  const voice=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text,idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  const moved=await managedTask({store,native,agent,originalText:text});
  assert.deepEqual(JSON.parse(store.sqlite.prepare("SELECT result_json FROM coordination_idempotency WHERE actor_scope=? AND idempotency_key=?").get('operator:native-history:synthetic-source',key).result_json),malformed);
  await native.sendTool('ponderosa_voice_reply',{});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(moved.runId),'original voice task completed',20000);
  const status=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voice.message.communicationEventId}/${agent.id}`));
  assert.equal(status.reply.state,'completed');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:true})).adapter,
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

test('two ordinary no-call Runs hand off context before the original voice task',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Multiple untouched memory turns'),agent=await f.createIdleAgent(chat,'Worker');
  for(let index=0;index<2;index++){
   const before=(await f.detail(agent.id)).runs.map(run=>run.id);
   await f.send(agent.id,'Original objective turn '+index);
   await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===index+1,'ordinary turn');
   await native.sendTool('ponderosa_message',{text:'Ordinary task complete '+index});
   await f.settled(agent.id,before);
  }
  const text='Continue aloud.';
  const voice=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text,idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  const moved=await managedTask({store,native,agent,originalText:text,initialTurns:2});
  await native.sendTool('ponderosa_voice_reply',{});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(moved.runId),'voice task completed',20000);
  const status=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voice.message.communicationEventId}/${agent.id}`));
  assert.equal(status.memoryExposure.state,'valid');assert.equal(status.reply.state,'completed');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

async function finishVoiceThroughManagedHandoff(f,native,agent,prior){
 const handoff=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old-thread handoff');
 assert.equal(handoff[1].params.threadId,handoff[0].params.threadId,'the memory-capable old thread only receives a handoff');
 await native.sendAnswer('Original objective retained; continue the work.');
 const confirmation=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'replacement confirmation');
 assert.notEqual(confirmation[2].params.threadId,handoff[0].params.threadId);
 await native.sendAnswer('Continuity context received.');
 const voice=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'new-thread voice');
 assert.equal(voice[3].params.threadId,confirmation[2].params.threadId);
 await native.sendTool('ponderosa_voice_reply',{});await f.settled(agent.id,prior);
}

for(const operation of ['search','save','invalid'])test(`a prior ${operation} memory attempt uses managed voice continuity`,{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Memory attempt'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  const tool=operation==='save'?'ponderosa_local_memory_save':'ponderosa_local_memory_search';
  const args=operation==='save'?{text:'Synthetic fact.',destination:'chat'}:operation==='search'?{query:'Synthetic search'}:{};
  await native.sendTool(tool,args);
  const response=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory result');
  if(operation==='invalid')assert.equal(response.result.success,false);else assert.equal(response.result.success,true);
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await finishVoiceThroughManagedHandoff(f,native,agent,prior);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('re-registering the same Run cannot erase a memory attempt',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Reentered memory witness'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  const response=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory response');
  assert.equal(response.result.success,true);
  const memory=localMemoryFor(f.app),active=memory.ports.activeRuns.get(agent.id);
  assert.ok(active?.messageCapability);memory.beginUnusedMemoryWitness(active.messageCapability);
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await finishVoiceThroughManagedHandoff(f,native,agent,prior);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

for(const change of ['grant','restart'])test(`${change} after a no-call Run preserves the voice task through a handoff`,{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Changed memory authority'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  if(change==='grant')f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  else await f.reopen();
  const text='Continue aloud.';
  const voice=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text,idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  const moved=await managedTask({store,native,agent,originalText:text});
  await native.sendTool('ponderosa_voice_reply',{});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status='completed'").get(moved.runId),'voice task completed',20000);
  const status=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voice.message.communicationEventId}/${agent.id}`));
  assert.equal(status.reply.state,'completed');assert.equal(status.memoryExposure.state,'valid');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('grant change while no-call voice resume is paused prevents provider submission',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Grant changed during resume'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'paused voice resume');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  await native.releaseThread();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND status IN ('failed','outcome_unknown')").get(agent.id,JSON.stringify(prior)),'grant change rejected');
  const calls=await native.requests();assert.equal(calls.filter(x=>x.method==='turn/start').length,1);assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
  assert.ok(!store.readEvents(agent.id).some(row=>row.event.type==='voice_reply'&&row.event.reply.state==='completed'));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdResume:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('a newly discovered prior unknown Run blocks no-call voice submission',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prior unknown Run'),agent=await f.createIdleAgent(chat,'Worker');
  store.sqlite.prepare("INSERT INTO scheduler_agent_fences(agent_id,next_fencing_token) VALUES (?,2) ON CONFLICT(agent_id) DO UPDATE SET next_fencing_token=2").run(agent.id);
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  const first=store.sqlite.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=?').get(prior[0]);assert.equal(first.fencing_token,2);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'paused voice resume');
  const now=new Date().toISOString();
  store.sqlite.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES (?,?,?,'outcome_unknown','synthetic',?,1,'injecting',?,?,?,?)").run(randomUUID(),chat.projectId,agent.id,now,now,now,now,first.scope_key);
  await native.releaseThread();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND fencing_token>2 AND status IN ('failed','outcome_unknown')").get(agent.id),'unknown history rejected');
  const calls=await native.requests();assert.equal(calls.filter(x=>x.method==='turn/start').length,1);assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdResume:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('a newly discovered prior unknown Run blocks a model handoff without Local Memory',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prior unknown Run'),agent=await f.createIdleAgent(chat,'Worker');
  store.sqlite.prepare("INSERT INTO scheduler_agent_fences(agent_id,next_fencing_token) VALUES (?,2) ON CONFLICT(agent_id) DO UPDATE SET next_fencing_token=2").run(agent.id);
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  const first=store.sqlite.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=?').get(prior[0]);assert.equal(first.fencing_token,2);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'paused voice resume');
  const now=new Date().toISOString();
  store.sqlite.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES (?,?,?,'outcome_unknown','synthetic',?,1,'injecting',?,?,?,?)").run(randomUUID(),chat.projectId,agent.id,now,now,now,now,first.scope_key);
  await native.releaseThread();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND fencing_token>2 AND status IN ('failed','outcome_unknown')").get(agent.id),'unknown history rejected');
  const calls=await native.requests();assert.equal(calls.filter(x=>x.method==='turn/start').length,1);assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdResume:true})).adapter});
});

test('a newly discovered later unknown Run blocks a model handoff without Local Memory',{timeout:30000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prior unknown Run'),agent=await f.createIdleAgent(chat,'Worker');
  store.sqlite.prepare("INSERT INTO scheduler_agent_fences(agent_id,next_fencing_token) VALUES (?,2) ON CONFLICT(agent_id) DO UPDATE SET next_fencing_token=2").run(agent.id);
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const old=store.resumeSessionState(agent.id),prior=(await f.detail(agent.id)).runs.map(run=>run.id);
  const first=store.sqlite.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=?').get(prior[0]);assert.equal(first.fencing_token,2);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='thread/resume'),'paused voice resume');
  const now=new Date().toISOString(),synthetic=randomUUID();
  store.sqlite.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES (?,?,?,'outcome_unknown','synthetic',?,100,'injecting',?,?,?,?)").run(synthetic,chat.projectId,agent.id,now,now,now,now,first.scope_key);
  await native.releaseThread();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND fencing_token>2 AND id<>? AND status IN ('failed','outcome_unknown')").get(agent.id,synthetic),'unknown history rejected');
  const calls=await native.requests();assert.equal(calls.filter(x=>x.method==='turn/start').length,1);assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,old.sessionId);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdResume:true})).adapter});
});

test('memory revoked after the original managed voice turn begins invalidates the live stream',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Revoked during retained voice'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_message',{text:'First task complete.'});await f.settled(agent.id);
  const prior=(await f.detail(agent.id)).runs.map(run=>run.id),text='Continue aloud.';
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text,idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'queue',voiceReply:true}));
  const moved=await managedTask({store,native,agent,originalText:text}),run={id:moved.runId};
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic search'});
  const search=await until(async()=>{const calls=(await native.requests()).filter(x=>x.toolResponse);return calls.length>=2?calls.at(-1).toolResponse:undefined;},'memory search response');
  assert.equal(search.result.success,true);
  await native.sendTool('ponderosa_voice_reply',{});
  const streaming=await until(()=>store.readEvents(agent.id).find(row=>row.event.type==='voice_reply'&&row.event.reply.state==='streaming'),'voice streaming');
  assert.match(streaming.event.reply.text,/objective continues safely/);
  new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]});
  const invalid=await until(()=>store.readEvents(agent.id).find(row=>row.event.type==='voice_reply'&&row.event.reply.failureReason==='context_changed'),'voice invalidation');
  assert.equal(invalid.event.reply.state,'failed');
  await native.releaseVoice();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND status IN ('completed','failed','cancelled','outcome_unknown')").get(run.id),'revoked voice Run terminal',20000);
  assert.ok(!store.readEvents(agent.id).some(row=>row.event.type==='voice_reply'&&row.event.reply.state==='completed'));
  const communications=new CoordinationV3Store(store.sqlite).runtimeCommunications(chat.projectId).filter(row=>row.payload.communication?.sender.kind==='agent'&&row.payload.communication.sender.executionId===run.id);
  assert.equal(communications.length,0,'stale voice context must not publish a canonical reply');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,holdVoiceCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});
