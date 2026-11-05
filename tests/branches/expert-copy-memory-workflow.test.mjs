import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy} from '@ponderosa/agents';
import {localMemoryFor} from '../../apps/server/dist/local-memory.js';
import {ownedChroma,seed,read} from '../memory/portability-fixture.mjs';
import {withFixture,until} from '../shared/fixture.mjs';

test('reviewed finding is private, does not wake its source, and appears in a later reviewed copy', {timeout:300000}, async t=>{
 let store;const fixturePlans=[];
 await withFixture(t,async f=>{
  const chat=await f.createChat('Original memory'),source=await f.createIdleAgent(chat,'Source'),other=await f.createIdleAgent(chat,'Other');
  const memory=localMemoryFor(f.app);assert.ok(memory);await memory.ready();await memory.verifyChat(chat.id);
  const state={chat,a:source,b:other,memory};await seed(state);
  const sourceRuns=store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n;
  const originalUpdate=store.updateAgentCreationOperation.bind(store),observations=[];
  store.updateAgentCreationOperation=(id,patch)=>{
   const operation=originalUpdate(id,patch);
   if(operation?.kind==='import'&&patch.status==='completed'&&operation.agentIds.length===1){
    const plan=fixturePlans.shift();if(plan)f.plans.set(operation.agentIds[0],[{output:false,run:session=>plan(session,operation.agentIds[0],observations)}]);
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
   await until(()=>store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(receipt.requestId)?.state==='completed','copy request completed',90000);
   return {job,resource,receipt,base};
  }
  const first=await runJob('finding-first',false,true,async(session,id,out)=>{
   const denied=await f.tool(session,'ponderosa_local_memory_save',{text:'no global write',destination:'global'});assert.notEqual(denied.status,200);
   const saved=await f.tool(session,'ponderosa_local_memory_save',{text:'FINDING_FOR_LATER_COPY',destination:'chat',visibility:'private',recipient:'original'});
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
   const global=await f.tool(session,'ponderosa_local_memory_save',{text:'no global write',destination:'global'});assert.notEqual(global.status,200);
   const done=await f.tool(session,'ponderosa_update_request',{kind:'completed',text:'Second job done'});assert.equal(done.status,200,JSON.stringify(done.body));
  });
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n,sourceRuns,'findings did not wake the original');
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(second.resource.step_execution_id)?.state==='retired','second cleanup',120000);
  for(const {job,resource,receipt,base} of [first,second]){
   const saved=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);assert.ok(saved.finalSnapshotReceipt);assert.equal(saved.finalVerifiedSha256,saved.finalSnapshotReceipt.sha256);
   const trace=f.ok(await f.api('GET',base)).temporaryCopyTrace;assert.equal(trace.sourceAgentId,source.id);assert.equal(trace.requestId,receipt.requestId);assert.equal(trace.historyAvailable,true);
   const history=f.ok(await f.api('GET',base+'/copy-history'));assert.ok(history.runs.some(r=>r.agentId===receipt.copyAgentId));
  }
 },{storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'copy_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'policy'),provision:true})});
});
