import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy,CapabilityPolicyStore,publishManagedArtifactContentAsync,readManagedArtifactContent} from '@ponderosa/agents';
import {withFixture,until} from '../shared/fixture.mjs';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {checkpointPackageCustody} from '../../apps/server/dist/checkpoint-agent-packages.js';
import {decodePortableArtifactData} from '../../apps/server/dist/agent-package-codec.js';

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
   assert.deepEqual(inspection.temporaryCopyActions.approvals,[],'inspection is not approval');
   assert.equal((await f.api('GET',url+'/access-review')).status,200,'preview uses existing review path');
   assert.equal(readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id).approvalHistory,undefined,'preview never invents operator approval provenance');
   assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests WHERE recipient_agent_id=?').get(source.id).n,0);
   const denied=await f.api('POST',url+'/access-review',{accessSettingsResolution:{action:'keep_destination',reviewSha256:inspection.expertCopyReview.reviewWithoutMemorySha256},snapshotSha256:'0'.repeat(64),copySourceMemory:false,allowFindingsWriteback:false});
   assert.equal(denied.status,409,'mismatched snapshot cannot approve the copy');
   assert.equal(readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id).approvalHistory,undefined,'rejected approval records no successful action');
   const approvalStarted=Date.now();
   const approved=await f.api('POST',url+'/access-review',{accessSettingsResolution:{action:'keep_destination',reviewSha256:inspection.expertCopyReview.reviewWithoutMemorySha256,agentActions:Object.fromEntries(inspection.currentPolicyReview.source.filter(x=>x.settings).map(x=>[x.ref,'keep_destination']))},snapshotSha256:inspection.expertCopyReview.snapshotSha256,copySourceMemory:false,allowFindingsWriteback:false});
   assert.equal(approved.status,200,JSON.stringify(approved.body));
   const approval=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id).approvalHistory;
   assert.equal(approval.length,1);assert.deepEqual(approval[0].actor,{kind:'user',id:'local-operator'});
   assert.equal(approval[0].origin,'operator_api');assert.ok(approval[0].requestId);
   assert.ok(Date.parse(approval[0].createdAt)>=approvalStarted&&Date.parse(approval[0].createdAt)<=Date.now());
   assert.equal(approval[0].reason,'run_reviewed_temporary_copy');
   assert.equal(approval[0].snapshotSha256,inspection.expertCopyReview.snapshotSha256);
   assert.equal(approval[0].resolution.action,'keep_destination');assert.equal(approval[0].copySourceMemory,false);assert.equal(approval[0].allowFindingsWriteback,false);
   await until(async()=>{const current=await f.api('GET',url);return current.status===200},'read reviewed progress',30000);
   assert.deepEqual(readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id).approvalHistory,approval,'read-only refresh preserves exact recorded approval');
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
   const actions=inspection.temporaryCopyActions;
   assert.equal(actions.approvals.length,1);assert.deepEqual(actions.approvals[0].actor,{kind:'user',id:'local-operator'});
   assert.equal(actions.approvals[0].requestId,r.approvalHistory[0].requestId);assert.equal(actions.approvals[0].createdAt,r.approvalHistory[0].createdAt);
   assert.equal(actions.approvals[0].action,'keep_destination');assert.equal(actions.approvals[0].copySourceMemory,false);
   assert.deepEqual(actions.retirement.provenance,{actor:{kind:'system',id:'ponderosa'},origin:'resource_cleanup',reason:'no_active_work_and_cleanup_completed'});
   const retirement=store.sqlite.prepare('SELECT id,created_at FROM branch_checkpoints WHERE execution_id=? AND transition_key=?').get(job.id,`resource-retired:${resource.step_execution_id}:${retired.generation}`);
   assert.equal(actions.retirement.checkpointId,retirement.id);assert.equal(actions.retirement.createdAt,retirement.created_at);
   assert.ok(!/snapshotSha256|reviewSha256|accessReview|dataBase64|snapshotSource/.test(JSON.stringify(actions)),'action projection returns no snapshot/package/authorization payload');
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

test('temporary copy starts with fresh workspace when its source retains a multipart working original',{timeout:180000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Imported source'),seed=await f.createIdleAgent(chat,'Seed expert');
  await f.send(seed.id,'HISTORICAL_EXPERT_OBJECTIVE');await f.settled(seed.id);
  const bytes=Buffer.alloc(64*1024*1024+17,0x61);bytes[0]=0;bytes[bytes.length-1]=23;
  const digest=createHash('sha256').update(bytes).digest('hex'),root=store.getAgent(seed.id).workingCopy.rootPath;
  await writeFile(path.join(root,'large-original.bin'),bytes);
  const artifactId=randomUUID(),artifact=Buffer.from('PRESERVED_HISTORICAL_DOCUMENT');
  await publishManagedArtifactContentAsync(f.dataDir,chat.projectId,artifactId,artifact);
  store.recordProjectArtifact({id:artifactId,projectId:chat.projectId,agentId:seed.id,originAgentId:seed.id,kind:'document',path:'history.txt',summary:'Historical document',createdAt:new Date().toISOString(),size:artifact.length,sha256:createHash('sha256').update(artifact).digest('hex'),mediaType:'text/plain'});
  const exported=f.ok(await f.api('GET',`/api/agents/${seed.id}/export?mode=full&workingFiles=${encodeURIComponent(JSON.stringify(['large-original.bin']))}`));
  const recovery=path.join(f.root,'source-recovery'),imported=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/import-agents`,{
   package:exported,conversationId:chat.id,engineMapping:{codex:'codex'},workingFilesDestination:recovery
  },{'idempotency-key':randomUUID()}));
  const source=store.getAgent(imported.rootAgentId),sourceState=store.getImportedHistory(source.id).portableState;
  assert.equal(sourceState.workingFiles[0].parts.sha256,digest);
  const policies=new CapabilityPolicyStore(store.sqlite);
  policies.put({scopeKind:'agent',scopeId:source.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite],actor:'operator'});
  const updateCreation=store.updateAgentCreationOperation.bind(store);
  store.updateAgentCreationOperation=(id,patch)=>{
   const op=updateCreation(id,patch);
   if(op?.kind==='import'&&patch.status==='completed'&&op.agentIds.length===1)f.plans.set(op.agentIds[0],[{hold:true}]);
   return op;
  };
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const definition={schema:'ponderosa.branch.v1',name:'Copy imported expert',trigger:{kind:'manual'},entry:'work',controls:[],
   steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'source'},instructions:'Finish the job',jobHandling:'copy'}],edges:[],
   policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
  const branch=branches.deploy({chatId:chat.id,idempotencyKey:'copy-imported-expert',definition,bindings:{agents:{source:source.id},directories:{workspace:f.root}}});
  const job=branches.accept(branch.id,'copy-imported-job','Preserve the original objective');
  const resource=await until(()=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id),'copy reservation',30000);
  const url=`/api/branches/${branch.id}/executions/${job.id}/resources/${resource.step_execution_id}`;
  const inspection=await until(async()=>{const r=await f.api('GET',url);return r.status===200&&r.body.expertCopyReview&&r.body.currentPolicyReview?r.body:undefined},'copy access review',60000);
  assert.equal(inspection.expertCopyReview.consentCurrent,false);
  assert.ok(inspection.currentPolicyReview.source.some(item=>item.settings?.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite)),'the source restriction is shown for explicit review');
  assert.equal(readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id).copyAgentId,undefined,'no copy is imported before review');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests WHERE recipient_agent_id=?').get(source.id).n,0);
  const approval=await f.api('POST',url+'/access-review',{accessSettingsResolution:{action:'keep_destination',reviewSha256:inspection.expertCopyReview.reviewWithoutMemorySha256,agentActions:Object.fromEntries(inspection.currentPolicyReview.source.filter(x=>x.settings).map(x=>[x.ref,'keep_destination']))},snapshotSha256:inspection.expertCopyReview.snapshotSha256,copySourceMemory:false,allowFindingsWriteback:false});
  assert.equal(approval.status,200,JSON.stringify(approval.body));
  const active=await until(()=>{
   const current=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
   const state=store.sqlite.prepare('SELECT state,error FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id);
   if(state?.error?.includes('Choose a new destination folder'))throw Error(state.error);
   return current?.state==='active'&&current;
  },'copy of imported expert active',60000);
  assert.notEqual(active.copyAgentId,source.id);
  assert.equal(policies.resolveForAgent(active.copyAgentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),false,'keeping destination policy does not silently inherit a source restriction');
  const history=store.getImportedHistory(active.copyAgentId);
  assert.ok(history.messages.some(message=>message.text.includes('HISTORICAL_EXPERT_OBJECTIVE')),'historical objective remains available');
  assert.equal(history.portableState?.workingFiles,undefined,'fresh workspace does not restore source files');
  const copied=store.getProjectArtifacts(active.copyProjectId).find(item=>item.summary==='Historical document');
  assert.ok(copied,'ordinary historical artifact remains available');
  assert.equal(readManagedArtifactContent(f.dataDir,active.copyProjectId,copied.id,copied.size,copied.sha256).body.toString(),artifact.toString());
  assert.equal(createHash('sha256').update(await readFile(path.join(recovery,'large-original.bin'))).digest('hex'),digest,'source recovery original remains intact');
  assert.equal(store.getImportedHistory(source.id).portableState.workingFiles[0].parts.sha256,digest);
  const copyAgent=store.getAgent(active.copyAgentId);
  await writeFile(path.join(copyAgent.workingCopy.rootPath,'copy-generated-large.bin'),bytes);
  const session=await until(()=>f.sessions.get(active.copyAgentId),'copy provider session',30000);
  const done=await f.tool(session,'ponderosa_update_request',{kind:'completed',text:'Copy job finished'});
  assert.equal(done.status,200,JSON.stringify(done.body));session.finish();
  await until(()=>branches.execution(job.id)?.state==='completed','copy job completion',60000);
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id)?.state==='retired','copy retirement after final custody',90000);
  const final=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
  assert.ok(final.finalSnapshotReceipt);assert.equal(final.finalVerifiedSha256,final.finalSnapshotReceipt.sha256);
  const finalHistory=await f.api('GET',url+'/copy-history');assert.equal(finalHistory.status,200,'final custody remains readable after cleanup: '+JSON.stringify(finalHistory.body));
  assert.ok(finalHistory.body.runs.some(run=>run.agentId===seed.id),'the approved source snapshot retains the earlier imported Run archive');
  assert.ok(finalHistory.body.runs.some(run=>run.agentId===active.copyAgentId),'the temporary copy Run remains visible');
  const finalPackage=await checkpointPackageCustody(f.dataDir).read(final.finalSnapshotReceipt);
  const owner=finalPackage.agents.find(agent=>agent.ref===active.copyAgentId),generated=owner?.workingFiles?.find(file=>file.path==='copy-generated-large.bin');
  assert.equal(generated?.parts?.sha256,digest,'final custody includes the new complete large original');
  const full=createHash('sha256');for(const ref of generated.parts.refs){const part=owner.artifacts.find(item=>item.ref===ref);full.update((await decodePortableArtifactData(part)).data);}
  assert.equal(full.digest('hex'),digest,'all final working-file part bytes survive cleanup');
  assert.equal(createHash('sha256').update(await readFile(path.join(recovery,'large-original.bin'))).digest('hex'),digest,'cleanup preserved the source original');
  // A new archive cannot claim to be reviewed source history merely by
  // naming the source Agent: its exact bytes must have been in the snapshot.
  const job2=branches.accept(branch.id,'copy-forged-archive-job','A separate job');
  const resource2=await until(()=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job2.id),'second copy reservation',30000);
  const url2=`/api/branches/${branch.id}/executions/${job2.id}/resources/${resource2.step_execution_id}`;
  const review2=await until(async()=>{const r=await f.api('GET',url2);return r.status===200&&r.body.expertCopyReview&&r.body.currentPolicyReview?r.body:undefined},'second copy review',60000);
  const approved2=await f.api('POST',url2+'/access-review',{accessSettingsResolution:{action:'keep_destination',reviewSha256:review2.expertCopyReview.reviewWithoutMemorySha256,agentActions:Object.fromEntries(review2.currentPolicyReview.source.filter(x=>x.settings).map(x=>[x.ref,'keep_destination']))},snapshotSha256:review2.expertCopyReview.snapshotSha256,copySourceMemory:false,allowFindingsWriteback:false});
  assert.equal(approved2.status,200,JSON.stringify(approved2.body));
  const copy2=await until(()=>{const value=readBranchExpertCopy(store.sqlite,job2.id,resource2.step_execution_id);return value?.state==='active'&&value},'second copy active',60000);
  const forged=Buffer.from(JSON.stringify({schema:'ponderosa.execution-archive.v1',sourceAgentId:source.id,sourceProjectId:source.projectId,events:[],runs:[]}));
  const forgedId=randomUUID();await publishManagedArtifactContentAsync(f.dataDir,copy2.copyProjectId,forgedId,forged);
  store.recordProjectArtifact({id:forgedId,projectId:copy2.copyProjectId,agentId:copy2.copyAgentId,originAgentId:copy2.copyAgentId,kind:'log',path:'unreviewed.json',summary:'Unreviewed archive',createdAt:new Date().toISOString(),size:forged.length,sha256:createHash('sha256').update(forged).digest('hex'),mediaType:'application/vnd.ponderosa.execution-archive+json'});
  const session2=await until(()=>f.sessions.get(copy2.copyAgentId),'second copy provider session',30000);
  const done2=await f.tool(session2,'ponderosa_update_request',{kind:'completed',text:'Second copy finished'});
  assert.equal(done2.status,200,JSON.stringify(done2.body));session2.finish();
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource2.step_execution_id)?.state==='retired','second copy retirement',90000);
  const refused=await f.api('GET',url2+'/copy-history');
  assert.equal(refused.status,409,'unreviewed archive bytes are not accepted as inherited history');
  assert.match(refused.body.error,/Run archive owner differs/);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});
