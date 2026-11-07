import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {localMemoryFor} from '../../apps/server/dist/local-memory.js';
import {ownedChroma,seed,read} from '../memory/portability-fixture.mjs';
import {withFixture,until} from '../shared/fixture.mjs';

test('temporary copies create new global notes under live write policy while source memory and findings remain reviewed', {timeout:300000}, async t=>{
 let store;const fixturePlans=[];let callbackError;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Original memory'),source=await f.createIdleAgent(chat,'Source'),other=await f.createIdleAgent(chat,'Other');
  const memory=localMemoryFor(f.app);assert.ok(memory);await memory.ready();await memory.verifyChat(chat.id);
  const state={chat,a:source,b:other,memory};const seeded=await seed(state);
  const existingGlobal=(await read(state,source.id,true)).find(row=>row.scope==='global'&&row.text==='EXCLUDED_GLOBAL_FACT');assert.ok(existingGlobal);
  const sourceRuns=store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n;
  const originalUpdate=store.updateAgentCreationOperation.bind(store),observations=[];
  store.updateAgentCreationOperation=(id,patch)=>{
   const operation=originalUpdate(id,patch);
   if(operation?.kind==='import'&&patch.status==='completed'&&operation.agentIds.length===1){
    const plan=fixturePlans.shift();if(plan)f.plans.set(operation.agentIds[0],[{output:false,run:async session=>{t.diagnostic('Copy callback started');try{return await plan(session,operation.agentIds[0],observations);}catch(error){callbackError=error;throw error;}}}]);
   }
   return operation;
  };
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const definition={schema:'ponderosa.branch.v1',name:'Memory copies',trigger:{kind:'manual'},entry:'work',controls:[],
   steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'source'},instructions:'Complete the selected job',jobHandling:'copy'}],edges:[],
   policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
  const branch=branches.deploy({chatId:chat.id,idempotencyKey:'copy-memory-deploy',definition,bindings:{agents:{source:source.id},directories:{workspace:f.root}}});
  async function runJob(key,copyMemory,writeback,plan){
   fixturePlans.push(plan);
   const job=branches.accept(branch.id,key,key+' input');
   const resource=await until(()=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id),'copy resource',30000);
   const base=`/api/branches/${branch.id}/executions/${job.id}/resources/${resource.step_execution_id}`;
   const review=await until(async()=>{const r=await f.api('GET',base);return r.status===200&&r.body.expertCopyReview&&r.body.currentPolicyReview?r.body:undefined},'copy review',90000);
   assert.equal(review.expertCopyReview.sourceMemoryAvailable,true);
   const chosenHash=copyMemory?review.currentPolicyReview.reviewSha256:review.expertCopyReview.reviewWithoutMemorySha256;
   const selection={action:'keep_destination',reviewSha256:chosenHash,agentActions:Object.fromEntries(review.currentPolicyReview.source.filter(x=>x.settings).map(x=>[x.ref,'keep_destination']))};
   const mismatch=await f.api('POST',base+'/access-review',{accessSettingsResolution:selection,snapshotSha256:'0'.repeat(64),copySourceMemory:copyMemory,allowFindingsWriteback:writeback});
   assert.equal(mismatch.status,409);
   assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests WHERE recipient_agent_id=?').get(source.id).n,0);
   const approved=await f.api('POST',base+'/access-review',{accessSettingsResolution:selection,snapshotSha256:review.expertCopyReview.snapshotSha256,copySourceMemory:copyMemory,allowFindingsWriteback:writeback});
   assert.equal(approved.status,200,JSON.stringify(approved.body));
   const receipt=await until(()=>{const r=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);return r?.state==='active'&&r},'active copy',90000);
   const request=store.sqlite.prepare('SELECT payload_json FROM coordination_requests WHERE id=?').get(receipt.requestId);
   const safety=JSON.parse(request.payload_json).safety;
   if(writeback){assert.match(safety,/temporary agent copy/i);assert.match(safety,/save concise durable findings to the original/i);assert.match(safety,/not wake it/i);}
   else assert.doesNotMatch(safety,/save concise durable findings to the original/i);
   await until(()=>{if(callbackError)throw callbackError;return store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(receipt.requestId)?.state==='completed';},'copy request completed',90000);
   return {job,resource,receipt,base};
  }
  const first=await runJob('finding-first',false,true,async(session,id,out)=>{
   t.diagnostic('First global save dispatch');const global=await f.tool(session,'ponderosa_local_memory_save',{text:'NEW_COPY_GLOBAL_NOTE',destination:'global'});assert.equal(global.status,200,JSON.stringify(global.body));t.diagnostic('Global save returned');
   assert.doesNotMatch(JSON.stringify(global.body),/EXCLUDED_GLOBAL_FACT|Included private fact|EXCLUDED_PRIVATE_FACT/,'write-only save does not disclose existing global or source-private facts');
   t.diagnostic('Read retained global note');const retained=(await read(state,source.id,true)).find(row=>row.scope==='global'&&row.text==='NEW_COPY_GLOBAL_NOTE');assert.ok(retained,'the new note is actually stored globally');
   const provenance=JSON.parse(retained.metadata.host_source_authority);assert.equal(provenance.provenance.actor.id,id);assert.equal(provenance.sourceType,'ai_inference');assert.equal(provenance.audience,'installation-global');
   t.diagnostic('Restricted operations begin');for(const [name,args] of [
    ['search',{query:'EXCLUDED_GLOBAL_FACT',source:'global'}],['get',{chunk_id:existingGlobal.id,source:'global'}],
    ['search',{query:'Included private fact',source:'chat'}],['get',{chunk_id:seeded.privateId,source:'chat'}],
    ['update',{chunk_id:existingGlobal.id,text:'Do not replace',destination:'global'}],['forget',{chunk_id:existingGlobal.id,destination:'global'}],
    ['save',{text:'No private global audience',destination:'global',visibility:'private'}]
   ]){const denied=await f.tool(session,'ponderosa_local_memory_'+name,args);assert.ok([400,403,409].includes(denied.status),name+' remains separately denied: '+denied.status);assert.doesNotMatch(JSON.stringify(denied.body),/EXCLUDED_GLOBAL_FACT|Included private fact/);}
   t.diagnostic('Approved finding dispatch');const saved=await f.tool(session,'ponderosa_local_memory_save',{text:'FINDING_FOR_LATER_COPY',destination:'chat',visibility:'private',recipient:'original'});
   out.push({id,saved});assert.equal(saved.status,200,JSON.stringify(saved.body));
   const done=await f.tool(session,'ponderosa_update_request',{kind:'completed',text:'First job done'});assert.equal(done.status,200,JSON.stringify(done.body));
  });
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM local_memory_scope_provisioning WHERE chat_id=?').get(first.receipt.copyChatId).n,0,'no temporary memory collection when source memory was declined');
  assert.ok((await read(state,source.id)).some(row=>row.text.includes('FINDING_FOR_LATER_COPY')));
  assert.ok(!(await read(state,other.id)).some(row=>row.text.includes('FINDING_FOR_LATER_COPY')));
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n,sourceRuns);
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(first.resource.step_execution_id)?.state==='retired','first cleanup',90000);

  const second=await runJob('finding-second',true,false,async(session,id,out)=>{
   const searched=await f.tool(session,'ponderosa_local_memory_search',{query:'FINDING_FOR_LATER_COPY',source:'chat',top_k:20});
   out.push({id,searched});assert.equal(searched.status,200,JSON.stringify(searched.body));assert.match(JSON.stringify(searched.body),/FINDING_FOR_LATER_COPY/);
   const denied=await f.tool(session,'ponderosa_local_memory_save',{text:'not approved',destination:'chat',visibility:'private',recipient:'original'});assert.notEqual(denied.status,200);
   const global=await f.tool(session,'ponderosa_local_memory_save',{text:'SECOND_COPY_GLOBAL_NOTE',destination:'global'});assert.equal(global.status,200,JSON.stringify(global.body));
   assert.doesNotMatch(JSON.stringify(global.body),/EXCLUDED_GLOBAL_FACT|NEW_COPY_GLOBAL_NOTE/,'global creation still grants no existing-note previews');
   const readDenied=await f.tool(session,'ponderosa_local_memory_get',{chunk_id:existingGlobal.id,source:'global'});assert.equal(readDenied.status,403,'source-memory consent is not global read');
   const updateDenied=await f.tool(session,'ponderosa_local_memory_update',{chunk_id:existingGlobal.id,text:'Do not change',destination:'global'});assert.equal(updateDenied.status,403,'existing global update remains denied');
   const done=await f.tool(session,'ponderosa_update_request',{kind:'completed',text:'Second job done'});assert.equal(done.status,200,JSON.stringify(done.body));
  });
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n,sourceRuns,'findings did not wake the original');
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(second.resource.step_execution_id)?.state==='retired','second cleanup',120000);
  const third=await runJob('global-without-source-or-findings-consent',false,false,async(session,id)=>{
   const saved=await f.tool(session,'ponderosa_local_memory_save',{text:'NO_READ_CONSENT_GLOBAL_NOTE',destination:'global'});assert.equal(saved.status,200,JSON.stringify(saved.body));
   assert.doesNotMatch(JSON.stringify(saved.body),/EXCLUDED_GLOBAL_FACT|NEW_COPY_GLOBAL_NOTE|SECOND_COPY_GLOBAL_NOTE|Included private fact/);
   const denied=await f.tool(session,'ponderosa_local_memory_search',{query:'Included private fact',source:'chat'});assert.equal(denied.status,409,'new global creation does not approve source memory');
   const finding=await f.tool(session,'ponderosa_local_memory_save',{text:'Not an approved finding',destination:'chat',visibility:'private',recipient:'original'});assert.equal(finding.status,409,'new global creation does not approve findings writeback');
   assert.equal((await f.tool(session,'ponderosa_update_request',{kind:'completed',text:'Write-only global job done'})).status,200);
  });
  assert.ok((await read(state,source.id,true)).some(row=>row.scope==='global'&&row.text==='NO_READ_CONSENT_GLOBAL_NOTE'));
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM local_memory_scope_provisioning WHERE chat_id=?').get(third.receipt.copyChatId).n,0,'write-only global copy creates no source-memory collection');
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(third.resource.step_execution_id)?.state==='retired','third cleanup',90000);
  const deniedJobs=[];
  for(const [target,url] of [['copy Branch','/api/branches/'+branch.id+'/capabilities'],['original Agent','/api/agents/'+source.id+'/capabilities']]){
   const current=f.ok(await f.api('GET',url));const revision=current.policy.revision;
   f.ok(await f.api('PUT',url,{revision,restrictedCapabilityIds:[...new Set([...current.policy.restrictedCapabilityIds,CAPABILITY_IDS.memoryWrite])]}));
   // Admit fresh tools under the human policy; never reuse a revoked tool credential.
   const deniedJob=await runJob('restricted-'+target.replaceAll(' ','-'),false,false,async session=>{
    const denied=await f.tool(session,'ponderosa_local_memory_save',{text:'DENIED_COPY_GLOBAL_NOTE',destination:'global'});if(typeof denied.body==='string')assert.equal(denied.body,'Unavailable Ponderosa tool for this Run: ponderosa_local_memory_save','human policy removes the write tool on '+target);else assert.equal(denied.status,403,'human write restriction on '+target+' still applies');
    assert.equal((await f.tool(session,'ponderosa_update_request',{kind:'completed',text:'Restricted write was not performed'})).status,200);
   });
   deniedJobs.push(deniedJob);
   await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(deniedJob.resource.step_execution_id)?.state==='retired','restricted copy cleanup',90000);
   f.ok(await f.api('PUT',url,{revision:revision+1,restrictedCapabilityIds:current.policy.restrictedCapabilityIds}));
  }
  assert.ok(!(await read(state,source.id,true)).some(row=>row.text==='DENIED_COPY_GLOBAL_NOTE'),'denied writes never commit');
  assert.equal((await read(state,source.id,true)).find(row=>row.id===existingGlobal.id)?.text,'EXCLUDED_GLOBAL_FACT','existing global note remains untouched');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n,sourceRuns,'global creation and denied writes never wake the original');
  for(const {job,resource,receipt,base} of [first,second,third,...deniedJobs]){
   const saved=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);assert.ok(saved.finalSnapshotReceipt);assert.equal(saved.finalVerifiedSha256,saved.finalSnapshotReceipt.sha256);
   const trace=f.ok(await f.api('GET',base)).temporaryCopyTrace;assert.equal(trace.sourceAgentId,source.id);assert.equal(trace.requestId,receipt.requestId);assert.equal(trace.historyAvailable,true);
   const history=f.ok(await f.api('GET',base+'/copy-history'));assert.ok(history.runs.some(r=>r.agentId===receipt.copyAgentId));
  }
 },{storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'copy_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'policy'),provision:true})});
});
