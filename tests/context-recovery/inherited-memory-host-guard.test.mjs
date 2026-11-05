import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {hasKnownRetainedMemory} from '../../apps/server/dist/context-transition-admission.js';
import {withFixture,until} from '../shared/fixture.mjs';
import {inertCodex} from '../shared/inert-codex.mjs';
import {ownedChroma} from '../memory/portability-fixture.mjs';

for(const mode of ['verified','generic-missing-origin']) test(`${mode} handoff retains earlier source evidence when memory is unavailable after restart`,{timeout:120000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Inherited source after restart'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic retained source.',destination:'global'}));
  const sourceId=saved.structuredContent?.result?.chunk_id;assert.ok(sourceId);
  await f.send(agent.id,'Keep the original task.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original input',20000);
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:sourceId,source:'global'});
  const response=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'read receipt',20000);
  assert.equal(response.result.success,true);
  await native.sendTool('ponderosa_message',{text:'Original work complete.'});await f.settled(agent.id);
  const oldSession=store.resumeSessionState(agent.id).sessionId;
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue under the changed model.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=2,'handoff',20000);
  await native.sendAnswer('The original objective includes the retained source.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=3,'replacement confirmation',20000);
  await native.sendAnswer('Continuity context received.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=4,'continued task',20000);
  await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  const session=store.resumeSessionState(agent.id),origin=store.acceptedProviderSessionInput(agent.id),boundary=store.providerCommandContextBoundary(agent.id);
  assert.ok(session?.sessionId&&origin?.executionId&&boundary?.executionId);assert.notEqual(session.sessionId,oldSession);
  const currentRows=store.sqlite.prepare(`SELECT count(*) n FROM memory_exposure_sources s JOIN scheduler_runs r ON r.id=s.run_id
   WHERE r.agent_id=? AND r.provider_session_id=?`).get(agent.id,session.sessionId).n;
  assert.equal(currentRows,0,'the new session itself has no disclosed-source row');
  if(mode==='generic-missing-origin'){
   const parent=store.sqlite.prepare(`SELECT h.id FROM context_rollovers r JOIN activation_sources x ON x.source_kind='context_rollover' AND x.source_id=r.id
    JOIN agent_activations h ON h.id=x.activation_id WHERE r.agent_id=? AND r.replacement_run_id=? AND r.state='completed'`).get(agent.id,origin.executionId);
   assert.ok(parent);store.sqlite.prepare("UPDATE agent_activations SET payload_json=json_remove(payload_json,'$.settingsTransition') WHERE id=?").run(parent.id);
   store.sqlite.prepare('DELETE FROM provider_inputs WHERE execution_id=?').run(origin.executionId);
   assert.equal(store.acceptedProviderSessionInput(agent.id),undefined,'the origin packet is missing in this disposable legacy fixture');
  }
  assert.equal(hasKnownRetainedMemory(store,agent.id,origin.executionId,boundary.executionId,session.sessionId),true,'the exact verified parent retains disclosed-source evidence');
  const count=(await native.requests()).filter(x=>x.method==='turn/start').length;
  await f.reopenWithoutMemory();
  assert.equal(hasKnownRetainedMemory(store,agent.id,origin.executionId,boundary.executionId,session.sessionId),true,'evidence survives a physical store reopen');
  await f.send(agent.id,'Continue after memory service is unavailable.');
  if(mode==='verified'){
   const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
     WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'inherited memory hold',20000);
   assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
   assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count,'no retained-session input is sent');
  } else {
   const turns=await until(async()=>{const rows=(await native.requests()).filter(x=>x.method==='turn/start');return rows.length>count?rows:undefined;},'fresh generic continuation',20000);
   const fresh=turns[count],payload=JSON.stringify(fresh.params.input);
   assert.notEqual(fresh.params.threadId,session.sessionId,'the missing origin selects a fresh provider session');
   assert.ok(payload.includes('Continue after memory service is unavailable.'));
   assert.ok(!payload.includes('Synthetic retained source.'),'the prior memory source is not seeded');
   assert.ok(!payload.includes('includes the retained source'),'the old handoff summary is not seeded');
   await native.sendTool('ponderosa_message',{text:'Fresh continuation complete.'});await f.settled(agent.id);
  }
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
 localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'inherit_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});
