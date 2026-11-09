import {proveRetainedCodexVoiceContext} from '../../apps/server/dist/retained-codex-voice-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentStore, CoordinationV3Store } from '../../packages/agents/dist/index.js';
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


test('accepted old generation remains eligible for a new voice call after rejected replacement preparation', {timeout:90000}, async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Rejected replacement retained generation'),agent=await f.createIdleAgent(chat,'Worker');
  await f.send(agent.id,'Synthetic original objective.');
  await until(async()=>(await native.requests()).some(x=>x.method==='turn/start'),'initial accepted turn');
  await native.sendTool('ponderosa_message',{text:'Synthetic initial response.'});await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id);
  const call=()=>f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Synthetic voice request.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true});
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture-next'}));
  await f.send(agent.id,'Synthetic transition request.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===2,'old generation handoff');
  await native.sendAnswer('Synthetic bounded handoff.');
  const prepared=await until(()=>store.sqlite.prepare(`SELECT id,replacement_run_id FROM context_rollovers WHERE agent_id=? AND replacement_input_committed_at IS NOT NULL AND replacement_session_id IS NULL`).get(agent.id),'replacement packet prepared');
  await until(async()=>(await native.requests()).filter(x=>x.method==='thread/start').length>=2,'replacement open started');
  await f.reopen();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state='outcome_unknown'").get(prepared.id),'replacement retained unknown');
  assert.equal(store.resumeSessionState(agent.id).sessionId,accepted.sessionId);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'fixture'}));
  const before=(await native.requests()).filter(x=>x.method==='turn/start').length;
  await f.send(agent.id,'Synthetic later ordinary text.');
  await until(async()=>(await native.requests()).filter(x=>x.method==='turn/start').length===before+1,'later accepted old generation turn');
  await native.sendTool('ponderosa_message',{text:'Synthetic later response.'});await until(()=>store.providerCommandContextBoundary(agent.id),'later accepted idle boundary');
  await f.reopen(); // Deployment starts cold; qualify real native resume, not only warm reuse.
  const opensBefore=await native.requests();
  const priorFreshStarts=opensBefore.filter(x=>x.method==='thread/start').length;
  const priorResumes=opensBefore.filter(x=>x.method==='thread/resume'&&x.params.threadId===accepted.sessionId).length;
  const packet=store.acceptedProviderSessionInput(agent.id),boundary=store.providerCommandContextBoundary(agent.id);
  const exposure=await localMemoryFor(f.app).retainedMemoryExposureStatus(agent.id,chat.id,accepted.sessionId,packet.executionId,boundary.executionId);
  assert.equal(exposure,'unknown','generic historical exposure remains conservative');
  const proof=proveRetainedCodexVoiceContext({store,memory:localMemoryFor(f.app),agentId:agent.id,chatId:chat.id,sessionId:accepted.sessionId,
    sourceRunId:boundary.executionId,contractHash:accepted.toolContractHash,systemPromptHash:packet.systemPromptHash});
  assert.ok(proof?.isCurrent(),'exact accepted generation has complete durable no-use proof');
  const input={store,memory:localMemoryFor(f.app),agentId:agent.id,chatId:chat.id,sessionId:accepted.sessionId,
    sourceRunId:boundary.executionId,contractHash:accepted.toolContractHash,systemPromptHash:packet.systemPromptHash};
  const negative=(label,mutate)=>{
    store.sqlite.exec('SAVEPOINT call_guard');
    try{mutate();assert.equal(proveRetainedCodexVoiceContext(input),undefined,label);assert.equal(proof.isCurrent(),false,label+' fences captured proof');}
    finally{store.sqlite.exec('ROLLBACK TO call_guard; RELEASE call_guard');}
    assert.ok(proof.isCurrent(),label+' rollback restores exact proof');
  };
  for(const field of ['attempted','pending','uncertain','unverified']){
    negative('accepted receipt '+field,()=>store.sqlite.prepare(`UPDATE memory_exposure_runs SET ${field}=1 WHERE run_id=?`).run(packet.executionId));
    negative('candidate receipt '+field,()=>store.sqlite.prepare(`UPDATE memory_exposure_runs SET ${field}=1 WHERE run_id=?`).run(prepared.replacement_run_id));
  }
  negative('missing receipt',()=>store.sqlite.prepare('DELETE FROM memory_exposure_runs WHERE run_id=?').run(packet.executionId));
  negative('disclosed source',()=>store.sqlite.prepare("INSERT INTO memory_exposure_sources(run_id,scope,source_id,content_hash) VALUES(?,'global','synthetic-source',?)").run(packet.executionId,'a'.repeat(64)));
  negative('authorization changed',()=>store.sqlite.prepare('UPDATE memory_exposure_runs SET authorization_hash=? WHERE run_id=?').run('b'.repeat(64),packet.executionId));
  negative('candidate continued rather than fresh',()=>store.sqlite.prepare("UPDATE provider_inputs SET source_manifest_json=json_set(source_manifest_json,'$.providerSessionDisposition','continued_session') WHERE execution_id=?").run(prepared.replacement_run_id));
  negative('candidate manifest hash mismatch',()=>store.sqlite.prepare('UPDATE context_rollovers SET replacement_manifest_hash=? WHERE id=?').run('c'.repeat(64),prepared.id));
  negative('candidate ownership mismatch',()=>store.sqlite.prepare("UPDATE agent_activations SET scope_key='conversation:other' WHERE id=(SELECT continuation_activation_id FROM context_rollovers WHERE id=?)").run(prepared.id));
  negative('candidate accepted contradiction',()=>store.sqlite.prepare("UPDATE context_rollovers SET completion_reason='replacement_verified' WHERE id=?").run(prepared.id));
  negative('accepted source no longer completed',()=>store.sqlite.prepare("UPDATE scheduler_runs SET status='outcome_unknown' WHERE id=?").run(boundary.executionId));
  negative('native history fork',()=>store.sqlite.prepare("INSERT INTO coordination_idempotency(project_id,actor_scope,operation,idempotency_key,payload_hash,result_json,created_at) VALUES(?,'synthetic','native_history','synthetic',?,?,?)").run(chat.projectId,'d'.repeat(64),JSON.stringify({targetAgentId:agent.id}),new Date().toISOString()));
  store.sqlite.exec('SAVEPOINT receipt_epoch');
  try{store.sqlite.prepare('UPDATE memory_exposure_runs SET mutation_epoch=mutation_epoch+1 WHERE run_id=?').run(packet.executionId);assert.equal(proof.isCurrent(),false,'receipt epoch race invalidates captured proof');}
  finally{store.sqlite.exec('ROLLBACK TO receipt_epoch; RELEASE receipt_epoch');}
  const historical=JSON.stringify(store.sqlite.prepare('SELECT * FROM context_rollovers WHERE id=?').get(prepared.id));
  const count=(await native.requests()).filter(x=>x.method==='turn/start').length;
  // Model a reservation pinned by the earlier semantic retention policy.
  // Pause only fixture polling while persisting the real canonical call.
  const peek=CoordinationV3Store.prototype.peekNextRunnable;
  CoordinationV3Store.prototype.peekNextRunnable=()=>undefined;
  let sent,pinned;const pendingCalls=[];
  try{
    sent=f.ok(await call());
    pinned=store.sqlite.prepare("SELECT id,project_id,agent_id,scope_key FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending' ORDER BY created_at DESC LIMIT 1").get(agent.id);
    assert.ok(pinned);
    new CoordinationV3Store(store.sqlite).holdSettingsTransitionReservation({projectId:chat.projectId,agentId:agent.id,activationId:pinned.id,fingerprint:'a'.repeat(64)});
    const authority=new CoordinationV3Store(store.sqlite);
    assert.equal(authority.settingsTransitionReservationHeld({projectId:chat.projectId,agentId:agent.id,activationId:pinned.id,fingerprint:'a'.repeat(64)}),true,'same semantic policy remains pinned');
    store.sqlite.exec('SAVEPOINT strong_pin');
    try{
      store.sqlite.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'task_decision_repair_wait','synthetic-review')").run(pinned.id);
      assert.equal(authority.settingsTransitionReservationHeld({projectId:chat.projectId,agentId:agent.id,activationId:pinned.id,fingerprint:'b'.repeat(64)}),false);
      assert.equal(store.sqlite.prepare("SELECT count(*) n FROM activation_sources WHERE activation_id=? AND source_kind='task_decision_repair_wait'").get(pinned.id).n,1,'stronger review hold survives semantic re-evaluation');
      assert.notEqual(peek.call(authority)?.activationId,pinned.id,'stronger review hold remains unschedulable');
    }finally{store.sqlite.exec('ROLLBACK TO strong_pin; RELEASE strong_pin');}
    store.sqlite.exec('SAVEPOINT cancelled_pin');
    try{
      store.sqlite.prepare("UPDATE agent_activations SET state='cancelled' WHERE id=?").run(pinned.id);
      authority.settingsTransitionReservationHeld({projectId:chat.projectId,agentId:agent.id,activationId:pinned.id,fingerprint:'b'.repeat(64)});
      assert.notEqual(peek.call(authority)?.activationId,pinned.id,'cancelled work never becomes runnable');
    }finally{store.sqlite.exec('ROLLBACK TO cancelled_pin; RELEASE cancelled_pin');}
    pendingCalls.push({sent,pinned});
    store.sqlite.exec('SAVEPOINT attempted_pin');
    try{
      store.sqlite.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(prepared.replacement_run_id,pinned.id,new Date().toISOString());
      assert.equal(new CoordinationV3Store(store.sqlite).settingsTransitionReservationHeld({projectId:chat.projectId,agentId:agent.id,activationId:pinned.id,fingerprint:'b'.repeat(64)}),true,'changed policy cannot release previously attached work');
      assert.equal(store.sqlite.prepare("SELECT count(*) n FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_reservation_wait'").get(pinned.id).n,1);
    }finally{store.sqlite.exec('ROLLBACK TO attempted_pin; RELEASE attempted_pin');}
    for(let i=1;i<3;i++){
      const next=f.ok(await call()),activation=store.sqlite.prepare("SELECT id,project_id,agent_id,scope_key FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending' ORDER BY created_at DESC LIMIT 1").get(agent.id);
      assert.ok(activation&&!pendingCalls.some(c=>c.pinned.id===activation.id));
      authority.holdSettingsTransitionReservation({projectId:chat.projectId,agentId:agent.id,activationId:activation.id,fingerprint:'a'.repeat(64)});
      pendingCalls.push({sent:next,pinned:activation});
    }
  }finally{CoordinationV3Store.prototype.peekNextRunnable=peek;}
  for(let index=0;index<pendingCalls.length;index++){
  ({sent,pinned}=pendingCalls[index]);
  const turns=await until(async()=>{const x=(await native.requests()).filter(x=>x.method==='turn/start');return x.length===count+index+1?x:undefined;},'new voice '+index+' on retained old generation');
  assert.equal(turns.at(-1).params.threadId,accepted.sessionId);
  const opens=await native.requests();
  assert.equal(opens.filter(x=>x.method==='thread/start').length,priorFreshStarts,'strict voice never opens a fresh thread');
  if(index===0)assert.equal(opens.filter(x=>x.method==='thread/resume'&&x.params.threadId===accepted.sessionId).length,priorResumes+1,'cold first call resumes exactly accepted old thread once');
  assert.ok(opens.slice(opensBefore.length).filter(x=>x.method==='thread/resume').every(x=>x.params.threadId===accepted.sessionId),'all subsequent native resumes retain the same accepted old thread');
  assert.ok(JSON.stringify(turns.at(-1)).includes('Synthetic voice request.'));
  assert.ok(!JSON.stringify(turns.at(-1)).includes('Synthetic bounded handoff.'));
  const voice=store.sqlite.prepare(`SELECT a.id,a.state FROM agent_activations a JOIN activation_sources src ON src.activation_id=a.id
    WHERE a.agent_id=? AND src.source_kind='communication' AND src.source_id LIKE ? ORDER BY a.created_at DESC LIMIT 1`).get(agent.id,'%'+sent.message.communicationEventId+'%');
  assert.ok(voice);
  assert.equal(voice.id,pinned.id,'semantic re-evaluation preserves original Activation identity');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM activation_sources WHERE activation_id=? AND source_kind IN ('settings_transition_reservation_wait','settings_transition_retry_pending')").get(voice.id).n,0);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(voice.id).n,1);
  assert.equal(JSON.stringify(store.sqlite.prepare('SELECT * FROM context_rollovers WHERE id=?').get(prepared.id)),historical);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1);
  await native.sendTool('ponderosa_voice_reply',{});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs r JOIN scheduler_run_activations x ON x.run_id=r.id WHERE x.activation_id=? AND r.status='completed'").get(voice.id),'new voice completed');
  }
  // Many normal scheduler/reconciliation polls must not re-deliver any call.
  for(let i=0;i<2;i++){
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal((await native.requests()).filter(x=>x.method==='turn/start').length,count+pendingCalls.length);
    for(const {pinned}of pendingCalls)assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(pinned.id).n,1);
    assert.equal(JSON.stringify(store.sqlite.prepare('SELECT * FROM context_rollovers WHERE id=?').get(prepared.id)),historical);
  }

 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertCodex(root,{advertiseModels:true,emitVoiceReply:true,holdMemoryCompletion:true,uniqueThreads:true,holdReplacementStart:true,emitVoiceContextUsage:true})).adapter,
  localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'callreg_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});
