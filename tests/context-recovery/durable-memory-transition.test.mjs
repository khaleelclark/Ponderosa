import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore, CoordinationV3Store, CapabilityPolicyStore } from '../../packages/agents/dist/index.js';
import { CAPABILITY_IDS } from '../../packages/core/dist/index.js';
import { withFixture, until } from '../shared/fixture.mjs';
import { inertCodex } from '../shared/inert-codex.mjs';
import { ownedChroma } from '../memory/portability-fixture.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

for (const operation of ['get','save']) test(`durable memory receipt supports ${operation} through a normal restart and model change`,{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Durable memory transition'),agent=await f.createIdleAgent(chat,'Worker');
  let id;
  if(operation==='get'){
   f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
   const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic durable source.',destination:'global'}));
   id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  }
  await f.send(agent.id,'Retain the original objective across restart.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool(operation==='get'?'ponderosa_local_memory_get':'ponderosa_local_memory_save',
   operation==='get'?{chunk_id:id,source:'global'}:{text:'Synthetic completed saved fact.',destination:'chat'});
  const reply=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory result');
  assert.equal(reply.result.success,true);
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  const receipt=store.sqlite.prepare('SELECT * FROM memory_exposure_runs WHERE agent_id=?').get(agent.id);
  assert.equal(receipt.pending,0);assert.equal(receipt.uncertain,0);assert.equal(receipt.attempted,1);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM memory_exposure_sources WHERE run_id=?').get(receipt.run_id).n,operation==='get'?1:0);
  await f.reopen();
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue using the new model.');
  const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old session handoff after restart',20000);
  assert.equal(old[1].params.threadId,old[0].params.threadId);assert.equal(old[1].params.model,'fixture');
  assert.ok(!JSON.stringify(old[1]).includes('Continue using the new model.'));
  await native.sendAnswer('The original objective and completed research are retained.');
  const next=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=3?x:undefined;},'replacement after restart',20000);
  assert.equal(next[2].params.model,'fixture-next');
  assert.ok(JSON.stringify(next[2]).includes('The original objective and completed research are retained.'));
  await native.sendAnswer('Continuity context received.');
  const final=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=4?x:undefined;},'original task after restart',20000);
  assert.ok(JSON.stringify(final[3]).includes('Continue using the new model.'));
  await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('ordinary text after restart and memory revocation waits for context review',{timeout:90000},async t=>{
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
  await f.reopen();
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

test('legacy session with possible post-origin revocation holds original ordinary text',{timeout:90000},async t=>{
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
  // Simulate a session created before exposure receipts existed.
  store.sqlite.prepare('DELETE FROM memory_exposure_sources WHERE run_id IN (SELECT run_id FROM memory_exposure_runs WHERE agent_id=?)').run(agent.id);
  store.sqlite.prepare('DELETE FROM memory_exposure_runs WHERE agent_id=?').run(agent.id);
  await f.reopen();
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await f.send(agent.id,'Continue the original user objective in text.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id,a.payload_json FROM agent_activations a
   JOIN activation_sources h ON h.activation_id=a.id AND h.source_kind='settings_transition_reservation_wait'
   WHERE a.agent_id=? AND a.state='pending'`).get(agent.id),'context-review hold',20000);
  assert.ok(held.payload_json.includes('Continue the original user objective in text.'));
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('may have been removed')));
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,1,'no old or fresh thread receives unsafe seed text');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId,'accepted context remains intact for review');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('recorded unverified memory with no source IDs holds ordinary text',{timeout:90000},async t=>{
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
  // Model a receipt whose result could not be attributed to individual sources.
  store.sqlite.prepare('DELETE FROM memory_exposure_sources WHERE run_id IN (SELECT run_id FROM memory_exposure_runs WHERE agent_id=?)').run(agent.id);
  store.sqlite.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE agent_id=?').run(agent.id);
  await f.reopen();
  await f.send(agent.id,'Continue the original user objective in text.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id,a.payload_json FROM agent_activations a
   JOIN activation_sources h ON h.activation_id=a.id AND h.source_kind='settings_transition_reservation_wait'
   WHERE a.agent_id=? AND a.state='pending'`).get(agent.id),'context-review hold',20000);
  assert.ok(held.payload_json.includes('Continue the original user objective in text.'));
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('could not be checked')));
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,1,'no old or fresh thread receives unsafe seed text');
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId,'accepted context remains intact for review');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('legacy session with removed memory-read capability holds original ordinary text',{timeout:90000},async t=>{
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
  // Simulate a session created before exposure receipts existed.
  store.sqlite.prepare('DELETE FROM memory_exposure_sources WHERE run_id IN (SELECT run_id FROM memory_exposure_runs WHERE agent_id=?)').run(agent.id);
  store.sqlite.prepare('DELETE FROM memory_exposure_runs WHERE agent_id=?').run(agent.id);
  await f.reopen();
  new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]});
  await f.send(agent.id,'Continue the original user objective in text.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id,a.payload_json FROM agent_activations a
   JOIN activation_sources h ON h.activation_id=a.id AND h.source_kind='settings_transition_reservation_wait'
   WHERE a.agent_id=? AND a.state='pending'`).get(agent.id),'context-review hold',20000);
  assert.ok(held.payload_json.includes('Continue the original user objective in text.'));
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('Memory read access was removed')));
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
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,uniqueThreads:true})).adapter});
});


test('forgetting an unreturned search candidate does not block later model handoff',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Unreturned search candidate'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const first=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic bright coral lighthouse.',destination:'global'}));
  const second=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic quiet woodland cabin.',destination:'global'}));
  const ids=[first.structuredContent?.result?.chunk_id,second.structuredContent?.result?.chunk_id];assert.ok(ids.every(Boolean));
  await f.send(agent.id,'Retain this objective across a settings change.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first native turn');
  await native.sendTool('ponderosa_local_memory_search',{query:'Synthetic coral lighthouse',source:'global',top_k:1});
  const reply=await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'search result');
  assert.equal(reply.result.success,true);
  await native.sendTool('ponderosa_message',{text:'Research complete.'});await f.settled(agent.id);
  const refs=store.sqlite.prepare(`SELECT e.source_id FROM memory_exposure_sources e
   JOIN memory_exposure_runs r ON r.run_id=e.run_id WHERE r.agent_id=?`).all(agent.id);
  assert.equal(refs.length,1,'only the source actually returned by search is recorded');
  const unreturned=ids.find(id=>id!==refs[0].source_id);assert.ok(unreturned);
  f.ok(await f.api('POST','/api/local-memory/global',{operation:'forget',chunk_id:unreturned,destination:'global'}));
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Continue using the selected model.');
  const old=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length>=2?x:undefined;},'old session handoff',20000);
  assert.equal(old[1].params.threadId,old[0].params.threadId);
  await native.sendAnswer('The original objective and research remain available.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=3,'replacement',20000);
  await native.sendAnswer('Continuity context received.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length>=4,'queued task',20000);
  await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});


test('recorded memory plus a missing later receipt holds ordinary work for review',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Incomplete exposure coverage'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic previously read source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'First objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'first turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'memory result');
  await native.sendTool('ponderosa_message',{text:'First work complete.'});await f.settled(agent.id);
  await f.send(agent.id,'Second objective.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'second turn');
  await native.sendTool('ponderosa_message',{text:'Second work complete.'});await f.settled(agent.id);
  const runs=store.sqlite.prepare('SELECT id FROM scheduler_runs WHERE agent_id=? ORDER BY fencing_token').all(agent.id);
  assert.equal(runs.length,2);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM memory_exposure_sources WHERE run_id=?').get(runs[0].id).n,1);
  store.sqlite.prepare('DELETE FROM memory_exposure_runs WHERE run_id=?').run(runs[1].id);
  await f.send(agent.id,'Third objective remains queued.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'incomplete exposure hold',20000);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('could not be checked')));
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,2);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});


test('memory source lineage survives two handoffs and restart before revocation',{timeout:120000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Inherited memory lineage'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic inherited source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source read');
  await native.sendTool('ponderosa_message',{text:'Read the inherited source.'});await f.settled(agent.id);
  let count=1;
  for(const model of ['fixture-next','fixture']){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model}));
   await f.send(agent.id,`Continue original objective with ${model}.`);
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'old generation handoff',20000);
   await native.sendAnswer('The original objective includes Synthetic inherited source.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'replacement confirmation',20000);
   await native.sendAnswer('Continuity context received.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'queued objective',20000);
   await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  }
  const accepted=store.resumeSessionState(agent.id);await f.reopen();
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await f.send(agent.id,'Continue after access change.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'inherited source hold',20000);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('revoked or changed')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('unverified rollover parent with recorded sources holds ordinary work',{timeout:120000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Inherited memory lineage'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic inherited source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source read');
  await native.sendTool('ponderosa_message',{text:'Read the inherited source.'});await f.settled(agent.id);
  let count=1;
  for(const model of ['fixture-next']){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model}));
   await f.send(agent.id,`Continue original objective with ${model}.`);
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'old generation handoff',20000);
   await native.sendAnswer('The original objective includes Synthetic inherited source.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'replacement confirmation',20000);
   await native.sendAnswer('Continuity context received.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'queued objective',20000);
   await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  }
  const accepted=store.resumeSessionState(agent.id);
  // Model a legacy pressure-rollover parent which has no settings marker.
  const parent=store.sqlite.prepare(`SELECT h.id FROM context_rollovers r JOIN activation_sources x
   ON x.source_kind='context_rollover' AND x.source_id=r.id JOIN agent_activations h ON h.id=x.activation_id
   WHERE r.agent_id=? AND r.state='completed' AND h.kind='context_rollover_handoff'`).get(agent.id);
  assert.ok(parent);
  store.sqlite.prepare(`UPDATE agent_activations SET payload_json=json_remove(payload_json,'$.settingsTransition') WHERE id=?`).run(parent.id);
  await f.reopen();
  await f.send(agent.id,'Continue after access change.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'inherited source hold',20000);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('could not be checked')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('forgetting inherited memory during the second handoff stops its summary',{timeout:120000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Inherited memory lineage'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic inherited source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source read');
  await native.sendTool('ponderosa_message',{text:'Read the inherited source.'});await f.settled(agent.id);
  let count=1;
  for(const model of ['fixture-next','fixture']){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model}));
   await f.send(agent.id,`Continue original objective with ${model}.`);
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'old generation handoff',20000);
   if(model==='fixture'){
    f.ok(await f.api('POST','/api/local-memory/global',{operation:'forget',chunk_id:id,destination:'global'}));
    await native.sendAnswer('A stale Synthetic inherited source must not be transferred.');
    await until(()=>store.sqlite.prepare(`SELECT 1 FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id
     JOIN agent_activations x ON x.id=a.activation_id WHERE x.kind='context_rollover_handoff'
      AND r.agent_id=? AND r.status IN ('failed','outcome_unknown')`).get(agent.id),'inherited source stopped handoff',20000);
    const handoff=store.sqlite.prepare("SELECT handoff_event_id FROM context_rollovers WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(agent.id);
    assert.equal(handoff.handoff_event_id,null);
    assert.ok(!store.readEvents(agent.id).some(row=>row.event.type==='continuation_handoff'&&row.event.text?.includes('stale Synthetic inherited source')));
    return;
   }
   await native.sendAnswer('The original objective includes Synthetic inherited source.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'replacement confirmation',20000);
   await native.sendAnswer('Continuity context received.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'queued objective',20000);
   await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  }
  const accepted=store.resumeSessionState(agent.id);await f.reopen();
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:false,expectedRevision:1}));
  await f.send(agent.id,'Continue after access change.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'inherited source hold',20000);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('revoked or changed')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('memory-off generic parent with recorded sources holds ordinary work',{timeout:120000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Inherited memory lineage'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic inherited source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source read');
  await native.sendTool('ponderosa_message',{text:'Read the inherited source.'});await f.settled(agent.id);
  let count=1;
  for(const model of ['fixture-next']){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model}));
   await f.send(agent.id,`Continue original objective with ${model}.`);
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'old generation handoff',20000);
   await native.sendAnswer('The original objective includes Synthetic inherited source.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'replacement confirmation',20000);
   await native.sendAnswer('Continuity context received.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'queued objective',20000);
   await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  }
  const accepted=store.resumeSessionState(agent.id);
  // Model a legacy pressure-rollover parent which has no settings marker.
  const parent=store.sqlite.prepare(`SELECT h.id FROM context_rollovers r JOIN activation_sources x
   ON x.source_kind='context_rollover' AND x.source_id=r.id JOIN agent_activations h ON h.id=x.activation_id
   WHERE r.agent_id=? AND r.state='completed' AND h.kind='context_rollover_handoff'`).get(agent.id);
  assert.ok(parent);
  store.sqlite.prepare(`UPDATE agent_activations SET payload_json=json_remove(payload_json,'$.settingsTransition') WHERE id=?`).run(parent.id);
  await f.reopenWithoutMemory();
  await f.send(agent.id,'Continue after access change.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'inherited source hold',20000);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('Local Memory is unavailable')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('memory-off generic parent with unverified zero-ID receipt holds ordinary work',{timeout:120000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Inherited memory lineage'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic inherited source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source read');
  await native.sendTool('ponderosa_message',{text:'Read the inherited source.'});await f.settled(agent.id);
  let count=1;
  for(const model of ['fixture-next']){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model}));
   await f.send(agent.id,`Continue original objective with ${model}.`);
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'old generation handoff',20000);
   await native.sendAnswer('The original objective includes Synthetic inherited source.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'replacement confirmation',20000);
   await native.sendAnswer('Continuity context received.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'queued objective',20000);
   await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  }
  const accepted=store.resumeSessionState(agent.id);
  // Model a legacy pressure-rollover parent which has no settings marker.
  const parent=store.sqlite.prepare(`SELECT h.id FROM context_rollovers r JOIN activation_sources x
   ON x.source_kind='context_rollover' AND x.source_id=r.id JOIN agent_activations h ON h.id=x.activation_id
   WHERE r.agent_id=? AND r.state='completed' AND h.kind='context_rollover_handoff'`).get(agent.id);
  assert.ok(parent);
  store.sqlite.prepare(`UPDATE agent_activations SET payload_json=json_remove(payload_json,'$.settingsTransition') WHERE id=?`).run(parent.id);
  store.sqlite.prepare('DELETE FROM memory_exposure_sources WHERE run_id IN (SELECT run_id FROM memory_exposure_runs WHERE agent_id=?)').run(agent.id);
  store.sqlite.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE agent_id=? AND attempted=1').run(agent.id);
  await f.reopenWithoutMemory();
  await f.send(agent.id,'Continue after access change.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'inherited source hold',20000);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('Local Memory is unavailable')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('memory-on generic parent with unverified zero-ID receipt holds ordinary work',{timeout:120000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Inherited memory lineage'),agent=await f.createIdleAgent(chat,'Worker');
  f.ok(await f.api('PUT',`/api/local-memory/grants/${chat.id}`,{readGlobal:true,expectedRevision:0}));
  const saved=f.ok(await f.api('POST','/api/local-memory/global',{operation:'save',text:'Synthetic inherited source.',destination:'global'}));
  const id=saved.structuredContent?.result?.chunk_id;assert.ok(id);
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'original turn');
  await native.sendTool('ponderosa_local_memory_get',{chunk_id:id,source:'global'});
  await until(async()=>(await native.requests()).find(x=>x.toolResponse)?.toolResponse,'source read');
  await native.sendTool('ponderosa_message',{text:'Read the inherited source.'});await f.settled(agent.id);
  let count=1;
  for(const model of ['fixture-next']){
   f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model}));
   await f.send(agent.id,`Continue original objective with ${model}.`);
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'old generation handoff',20000);
   await native.sendAnswer('The original objective includes Synthetic inherited source.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'replacement confirmation',20000);
   await native.sendAnswer('Continuity context received.');
   count++;await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===count,'queued objective',20000);
   await native.sendTool('ponderosa_message',{text:'Continued work complete.'});await f.settled(agent.id);
  }
  const accepted=store.resumeSessionState(agent.id);
  // Model a legacy pressure-rollover parent which has no settings marker.
  const parent=store.sqlite.prepare(`SELECT h.id FROM context_rollovers r JOIN activation_sources x
   ON x.source_kind='context_rollover' AND x.source_id=r.id JOIN agent_activations h ON h.id=x.activation_id
   WHERE r.agent_id=? AND r.state='completed' AND h.kind='context_rollover_handoff'`).get(agent.id);
  assert.ok(parent);
  store.sqlite.prepare(`UPDATE agent_activations SET payload_json=json_remove(payload_json,'$.settingsTransition') WHERE id=?`).run(parent.id);
  store.sqlite.prepare('DELETE FROM memory_exposure_sources WHERE run_id IN (SELECT run_id FROM memory_exposure_runs WHERE agent_id=?)').run(agent.id);
  store.sqlite.prepare('UPDATE memory_exposure_runs SET unverified=1 WHERE agent_id=? AND attempted=1').run(agent.id);
  await f.reopen();
  await f.send(agent.id,'Continue after access change.');
  const held=await until(()=>store.sqlite.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
   WHERE a.agent_id=? AND a.state='pending' AND s.source_kind='settings_transition_reservation_wait'`).get(agent.id),'inherited source hold',20000);
  assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,0);
  const notices=f.ok(await f.api('GET','/api/notifications'));
  assert.ok(notices.items.some(item=>item.title==='Agent context needs review'&&item.body.includes('could not be checked')));
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true})).adapter,
   localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'context_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});
