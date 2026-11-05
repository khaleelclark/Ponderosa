import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore, CapabilityPolicyStore, CoordinationV3Store} from '../../packages/agents/dist/index.js';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import {withFixture, until} from '../shared/fixture.mjs';
import {inertCodex} from '../shared/inert-codex.mjs';
import {ownedChroma} from '../memory/portability-fixture.mjs';

for (const scenario of ['source-before-thread','grant-before-input','expansion-before-thread']) {
 test(`retained memory admission: ${scenario}`,{timeout:90000},async t=>{
  let store,native;
  await withFixture(t,async f=>{
   const chat=await f.createChat('Memory admission boundary'),agent=await f.createIdleAgent(chat,'Worker');
   const policies=new CapabilityPolicyStore(store.sqlite);
   if(scenario==='expansion-before-thread') policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]});
   f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
   const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic protected source.',destination:'global'}));
   const id=saved.structuredContent?.result?.chunk_id; assert.ok(id);
   await f.send(agent.id,'Preserve the original objective.');
   await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial native turn');
   await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
   const source=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source result');
   assert.ok(JSON.stringify(source).includes('Synthetic protected source.'));
   await native.sendTool('ponderosa_message',{text:'The prior objective was researched.'}); await f.settled(agent.id);
   const accepted=store.resumeSessionState(agent.id).sessionId;
   await f.reopen();
   const before=await native.requests();
   const text=`Continue the exact objective for ${scenario}.`;
   await native.holdAccountRead(scenario==='grant-before-input'?2:1);
   await f.send(agent.id,text);
   await until(()=>native.accountReadHeld(),'provider account response held',20000);
   const held=await native.requests();
   assert.equal(held.filter(x=>x.method==='turn/start').length,before.filter(x=>x.method==='turn/start').length);
   assert.equal(held.filter(x=>x.method==='thread/resume').length-before.filter(x=>x.method==='thread/resume').length,scenario==='grant-before-input'?1:0);
   if(scenario==='source-before-thread') f.ok(await f.api('POST','/api/local-memory/global',{operation:'forget',chunk_id:id,destination:'global'}));
   else if(scenario==='grant-before-input') f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
   else new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:1,restrictedCapabilityIds:[]});
   await native.releaseThread();
   const activation=await until(()=>store.sqlite.prepare(`SELECT id,state,payload_json FROM agent_activations WHERE agent_id=? AND json_extract(payload_json,'$.communication.text')=?`).get(agent.id,text),'exact original task');
   if(scenario==='expansion-before-thread'){
    await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>before.filter(x=>x.method==='turn/start').length,'expanded access accepted',20000);
    const inputs=(await native.requests()).filter(x=>x.method==='turn/start'&&JSON.stringify(x).includes(text));assert.equal(inputs.length,1);
    await native.sendTool('ponderosa_message',{text:'Continued objective completed.'});await f.settled(agent.id);
    assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(activation.id).state,'consumed');
   }else{
    await until(()=>store.sqlite.prepare(`SELECT 1 FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id WHERE a.activation_id=? AND r.status IN ('failed','cancelled','outcome_unknown')`).get(activation.id),'revocation held',20000);
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,before.filter(x=>x.method==='turn/start').length,'revoked context never receives the queued task');
    if(scenario==='source-before-thread') assert.equal((await native.requests()).filter(x=>x.method==='thread/resume').length,before.filter(x=>x.method==='thread/resume').length,'changed source prevents native resume');
    const persisted=store.sqlite.prepare('SELECT state,payload_json FROM agent_activations WHERE id=?').get(activation.id);
    assert.ok(persisted.payload_json.includes(text));assert.notEqual(persisted.state,'consumed');
    assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted);
    const communications=new CoordinationV3Store(store.sqlite).runtimeCommunications(chat.projectId);
    assert.ok(communications.some(row=>JSON.stringify(row.payload).includes(text)),'original work remains visible');
    assert.equal(communications.filter(row=>row.payload.communication?.sender?.kind==='agent'&&JSON.stringify(row.payload).includes('Continued objective completed.')).length,0);
   }
  },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>{native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true});const adapter=native.adapter;const open=adapter.openSession.bind(adapter);adapter.openSession=opts=>open({...opts,expectedBillingMode:'subscription'});return adapter;},
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
 });
}
