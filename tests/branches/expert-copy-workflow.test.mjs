import assert from 'node:assert/strict';
import test from 'node:test';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy} from '@ponderosa/agents';
import {withFixture,until} from '../shared/fixture.mjs';

test('parallel temporary copies run independently without Local Memory after explicit review', {timeout:180000}, async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Copy source'),source=await f.createIdleAgent(chat,'Persistent agent');
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const definition={schema:'ponderosa.branch.v1',name:'Copy jobs',trigger:{kind:'manual'},entry:'work',controls:[],
   steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'source'},instructions:'Finish the independent job',jobHandling:'copy'}],edges:[],
   policy:{maxConcurrentExecutions:2,maxEphemeralAgents:1,failure:{action:'stop'}}};
  const branch=branches.deploy({chatId:chat.id,idempotencyKey:'copy-live-deploy',definition,bindings:{agents:{source:source.id},directories:{workspace:f.root}}});
  const jobs=[branches.accept(branch.id,'copy-live-one','Input one'),branches.accept(branch.id,'copy-live-two','Input two')];
  const items=[];
  for(const job of jobs){
   const resource=await until(()=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id),'copy reservation',30000);
   const url=`/api/branches/${branch.id}/executions/${job.id}/resources/${resource.step_execution_id}`;
   const inspection=await until(async()=>{const result=await f.api('GET',url);return result.status===200&&result.body.currentPolicyReview&&result.body.expertCopyReview?result.body:undefined},'copy review',60000);
   assert.equal(inspection.expertCopyReview.sourceMemoryAvailable,false);
   assert.equal(inspection.expertCopyReview.consentCurrent,false);
   assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests WHERE recipient_agent_id=?').get(source.id).n,0);
   const denied=await f.api('POST',url+'/access-review',{accessSettingsResolution:{action:'keep_destination',reviewSha256:inspection.expertCopyReview.reviewWithoutMemorySha256},snapshotSha256:'0'.repeat(64),copySourceMemory:false,allowFindingsWriteback:false});
   assert.equal(denied.status,409,'mismatched snapshot cannot approve the copy');
   const approved=await f.api('POST',url+'/access-review',{accessSettingsResolution:{action:'keep_destination',reviewSha256:inspection.expertCopyReview.reviewWithoutMemorySha256,agentActions:Object.fromEntries(inspection.currentPolicyReview.source.filter(x=>x.settings).map(x=>[x.ref,'keep_destination']))},snapshotSha256:inspection.expertCopyReview.snapshotSha256,copySourceMemory:false,allowFindingsWriteback:false});
   assert.equal(approved.status,200,JSON.stringify(approved.body));
   items.push({job,resource});
  }
  const receipts=[];
  for(const {job,resource} of items){
   const receipt=await until(()=>{const r=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);return r?.state==='active'&&r},'copy active',60000);
   receipts.push(receipt);
   assert.notEqual(receipt.copyAgentId,source.id);assert.notEqual(receipt.copyChatId,chat.id);
   assert.equal(receipt.consent.copySourceMemory,false);assert.equal(receipt.consent.allowFindingsWriteback,false);
  }
  assert.notEqual(receipts[0].copyAgentId,receipts[1].copyAgentId);assert.notEqual(receipts[0].requestId,receipts[1].requestId);
  for(const {job} of items)await until(()=>branches.execution(job.id)?.state==='completed','independent copy result',60000);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n,0,'the original is never awakened');
  for(const receipt of receipts)assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM local_memory_scope_provisioning WHERE chat_id=?').get(receipt.copyChatId).n,0);
  for(const {job,resource} of items){
   const retired=await until(()=>{const r=store.sqlite.prepare('SELECT * FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id);return r?.state==='retired'&&r},'copy cleanup',90000);
   assert.equal(retired.state,'retired');
   const r=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);assert.ok(r.finalSnapshotReceipt);assert.equal(r.finalVerifiedSha256,r.finalSnapshotReceipt.sha256);
   const base=`/api/branches/${branch.id}/executions/${job.id}/resources/${resource.step_execution_id}`;
   const inspection=f.ok(await f.api('GET',base)),trace=inspection.temporaryCopyTrace;
   assert.ok(trace);assert.equal(trace.sourceAgentId,source.id);assert.equal(trace.sourceChatId,chat.id);
   assert.equal(trace.copyAgentId,r.copyAgentId);assert.equal(trace.requestId,r.requestId);assert.equal(trace.task.input,job.input);
   assert.ok(trace.result);assert.equal(trace.historyAvailable,true);
   const historyResponse=await f.api('GET',base+'/copy-history');
   assert.equal(historyResponse.status,200,JSON.stringify(historyResponse.body));
   const history=historyResponse.body;assert.equal(history.sourceAgentId,source.id);assert.equal(history.copyAgentId,r.copyAgentId);assert.equal(history.requestId,r.requestId);
   assert.ok(history.runs.some(run=>run.agentId===r.copyAgentId&&run.status==='completed'),'real copy Run retained after deletion');
   assert.ok(history.events.some(event=>event.agentId===r.copyAgentId),'copy work-log retained after deletion');
   assert.equal(store.getAgent(r.copyAgentId),undefined,'copy Agent was actually deleted');
   assert.equal(store.getConversation(r.copyChatId),undefined,'copy Chat was actually deleted');
   console.log('COPY_ARCHIVE_BYTES',JSON.stringify({source:r.snapshotReceipt.byteLength,final:r.finalSnapshotReceipt.byteLength,sourceHistory:'empty',sourceMemory:'unavailable',jobs:2}));
  }
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});
