import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { CAPABILITY_IDS } from '../../packages/core/dist/index.js';
import { localMemoryFor } from '../../apps/server/dist/local-memory.js';
import { withFixture, until } from '../shared/fixture.mjs';
import { inertCodex } from '../shared/inert-codex.mjs';
import { ownedChroma } from '../memory/portability-fixture.mjs';

test('retained memory admission proof fences exact access and source changes while permitting expansions',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Retained memory admission'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  f.ok(await f.api('PUT',`/api/agents/${agent.id}/capabilities`,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.filesystemWrite]}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic retained memory source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  const response=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory result');
  assert.equal(response.result.success,true);
  await native.sendTool('ponderosa_message',{text:'Source read complete.'});await f.settled(agent.id);
  const session=store.resumeSessionState(agent.id),packet=store.acceptedProviderSessionInput(agent.id),boundary=store.providerCommandContextBoundary(agent.id);
  assert.ok(session?.sessionId&&packet?.executionId&&boundary?.executionId);
  const memory=localMemoryFor(f.app),input={agentId:agent.id,chatId:chat.id,sessionId:session.sessionId,originRunId:packet.executionId,sourceRunId:boundary.executionId,currentRunId:randomUUID()};
  const invalid=await memory.prepareRetainedInputProof({...input,sourceRunId:randomUUID()});
  assert.equal(invalid.status,'unavailable');assert.equal(invalid.isCurrent(),false);
  const proof=await memory.prepareRetainedInputProof(input);
  assert.equal(proof.status,'valid');assert.equal(proof.isCurrent(),true);
  store.sqlite.exec('SAVEPOINT retained_memory_identity');
  try{
   store.sqlite.prepare("UPDATE agents SET active_session_id='different-session' WHERE id=?").run(agent.id);
   assert.equal(proof.isCurrent(),false,'the accepted session is exact');
  }finally{store.sqlite.exec('ROLLBACK TO retained_memory_identity; RELEASE retained_memory_identity');}
  store.sqlite.exec('SAVEPOINT retained_memory_unknown');
  try{
   const now=new Date().toISOString();
   store.sqlite.prepare(`INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key)
    VALUES(?,?,?,'outcome_unknown','synthetic',?,9999,'injecting',?,?,?,?)`).run(randomUUID(),chat.projectId,agent.id,now,now,now,now,`conversation:${chat.id}`);
   assert.equal(proof.isCurrent(),false,'a separate uncertain Run cannot be overlooked');
  }finally{store.sqlite.exec('ROLLBACK TO retained_memory_unknown; RELEASE retained_memory_unknown');}
  f.ok(await f.api('PUT',`/api/agents/${agent.id}/capabilities`,{revision:1,restrictedCapabilityIds:[]}));
  assert.equal(proof.isCurrent(),true,'an access expansion does not invalidate retained work');
  f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic unrelated source.',destination:'global'}));
  assert.equal(proof.isCurrent(),true,'an unrelated new source does not invalidate an actual read');
  f.ok(await f.api('PUT',`/api/agents/${agent.id}/capabilities`,{revision:2,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]}));
  assert.equal(proof.isCurrent(),false,'removing access to an exposed source fences admission');
  f.ok(await f.api('PUT',`/api/agents/${agent.id}/capabilities`,{revision:3,restrictedCapabilityIds:[]}));
  assert.equal(proof.isCurrent(),true);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  assert.equal(proof.isCurrent(),false,'removing global access fences admission');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:2}));
  const sourceProof=await memory.prepareRetainedInputProof(input);
  assert.equal(sourceProof.status,'valid');
  f.ok(await f.api('POST','/api/local-memory/global',{operation:'forget',chunk_id:id,destination:'global'}));
  assert.equal(sourceProof.isCurrent(),false,'mutation of the actual source fences admission');
  store.sqlite.prepare('DELETE FROM memory_exposure_sources WHERE run_id IN (SELECT run_id FROM memory_exposure_runs WHERE agent_id=?)').run(agent.id);
  store.sqlite.prepare('DELETE FROM memory_exposure_runs WHERE agent_id=?').run(agent.id);
  const legacy=await memory.prepareRetainedInputProof(input);
  assert.equal(legacy.status,'unknown');assert.equal(legacy.isCurrent(),true);
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:3}));
  assert.equal(legacy.isCurrent(),false,'a legacy session cannot cross an actual grant removal unnoticed');
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,holdMemoryCompletion:true})).adapter,
  localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'admission_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});
