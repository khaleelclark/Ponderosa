import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy} from '@ponderosa/agents';
import {BranchResourceService} from '../../apps/server/dist/branch-resource-service.js';
import {describeBranchDeletionFailure} from '../../apps/server/dist/branch-deletion-diagnostics.js';
import {sealBranchExpertSnapshot,reserveBranchExpertChat,reserveBranchExpertImport,reviewBranchExpertAccess,bindBranchExpertCopy,reserveBranchExpertFinal,sealBranchExpertFinal,verifyBranchExpertFinal,renewBranchExpertSnapshot} from '../../packages/agents/dist/branch-expert-copy.js';

test('copy jobs reserve distinct source-bound identities without sending work to the original',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'expert-copy-reservation-')),store=new AgentStore(root);
 t.after(()=>store.close());
 const coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Expert',hostPath:root,defaultEngine:'codex'});
 const chat=store.createConversation(project.id,{title:'Source chat'});
 const agent=store.createAgent(project.id,{title:'Expert',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Copies',trigger:{kind:'manual'},entry:'work',controls:[],
  steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'expert'},instructions:'Handle one job',jobHandling:'copy'}],
  edges:[],policy:{maxConcurrentExecutions:2,maxEphemeralAgents:2,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'copy-reservation-deploy',definition,bindings:{agents:{expert:agent.id},directories:{workspace:root}}});
 const jobs=[branches.accept(branch.id,'copy-job-1','one'),branches.accept(branch.id,'copy-job-2','two')];
 for(let i=0;i<12;i++)branches.advance();
 const receipts=jobs.map(job=>{
  const resource=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);
  assert.ok(resource);assert.equal(resource.state,'reserved');assert.equal(resource.requested_count,1);
  const receipt=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
  assert.equal(receipt.state,'reserved');assert.equal(receipt.sourceAgentId,agent.id);assert.equal(receipt.sourceChatId,chat.id);
  assert.equal(receipt.sourceProjectId,project.id);assert.deepEqual(receipt.snapshotSource.agentIds,[agent.id]);
  return receipt;
 });
 assert.notEqual(receipts[0].stepExecutionId,receipts[1].stepExecutionId);
 assert.notEqual(receipts[0].snapshotSource.checkpointId,receipts[1].snapshotSource.checkpointId);
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests WHERE recipient_agent_id=?').get(agent.id).n,0);
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM branch_resource_members').get().n,0);
 const provision=branches.resourceProvisions()[0];assert.ok(provision?.expertCopy);assert.equal(provision.workingDirectory,'');
});

test('expert copy binding requires a sealed exact snapshot, separate consent and fixed destination identities',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'expert-copy-receipt-')),store=new AgentStore(root);
 t.after(()=>store.close());
 const coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Expert',hostPath:root,defaultEngine:'codex'});
 const chat=store.createConversation(project.id,{title:'Source'});
 const agent=store.createAgent(project.id,{title:'Expert',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Copy',trigger:{kind:'manual'},entry:'work',controls:[],
  steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'expert'},instructions:'Work',jobHandling:'copy'}],edges:[],
  policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'copy-ledger-deploy',definition,bindings:{agents:{expert:agent.id},directories:{workspace:root}}});
 const job=branches.accept(branch.id,'copy-ledger-job','input');for(let i=0;i<6;i++)branches.advance();
 const resource=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);
 const original=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
 const captured={...original.snapshotSource,version:1,custodyId:'custody',boundaryId:'boundary',sha256:'a'.repeat(64),byteLength:20};
 assert.throws(()=>bindBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id,{copyAgentId:'copy',copyChatId:'other',copyProjectId:'other',requestId:'request',task:{instructions:'work',input:'input'}}),/snapshot or explicit consent/);
 sealBranchExpertSnapshot(store.sqlite,job.id,resource.step_execution_id,captured);
 reserveBranchExpertChat(store.sqlite,job.id,resource.step_execution_id,{copyChatId:'copy-chat',copyProjectId:'copy-project'});
 assert.throws(()=>reserveBranchExpertChat(store.sqlite,job.id,resource.step_execution_id,{copyChatId:'changed',copyProjectId:'copy-project'}),/identity changed/);
 const review={reviewSha256:'b'.repeat(64),source:[],destination:{restrictedCapabilityIds:[],restrictionSources:{},layers:[]}};
 const choice={action:'keep_destination',reviewSha256:review.reviewSha256};
 assert.throws(()=>reviewBranchExpertAccess(store.sqlite,job.id,resource.step_execution_id,review,choice,{snapshotSha256:'c'.repeat(64),reviewSha256:review.reviewSha256,copySourceMemory:true,allowFindingsWriteback:true}),/does not match/);
 reviewBranchExpertAccess(store.sqlite,job.id,resource.step_execution_id,review,choice,{snapshotSha256:captured.sha256,reviewSha256:review.reviewSha256,copySourceMemory:true,allowFindingsWriteback:false});
 reserveBranchExpertImport(store.sqlite,job.id,resource.step_execution_id,'import-operation');
 assert.throws(()=>bindBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id,{copyAgentId:agent.id,copyChatId:'copy-chat',copyProjectId:'copy-project',requestId:'request',task:{instructions:'work',input:'input'}}),/identity invalid/);
 bindBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id,{copyAgentId:'copy-agent',copyChatId:'copy-chat',copyProjectId:'copy-project',requestId:'request',task:{instructions:'work',input:'input'}});
 const bound=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
 assert.equal(bound.state,'active');assert.equal(bound.requestId,'request');assert.equal(bound.attemptId,original.attemptId);
 assert.equal(bound.consent.copySourceMemory,true);assert.equal(bound.consent.allowFindingsWriteback,false);
 const finalSource={...original.snapshotSource,checkpointId:'final',sourceChatId:'copy-chat',agentIds:['copy-agent']};
 reserveBranchExpertFinal(store.sqlite,job.id,resource.step_execution_id,finalSource,'d'.repeat(64));
 const final={...finalSource,version:1,custodyId:'final-custody',boundaryId:'final-boundary',sha256:'e'.repeat(64),byteLength:30};
 sealBranchExpertFinal(store.sqlite,job.id,resource.step_execution_id,final);
 verifyBranchExpertFinal(store.sqlite,job.id,resource.step_execution_id,final.sha256);
 const service=new BranchResourceService(branches,store,async()=>{},async()=>{},async()=>{});
 service.setPackageEngine({verifyCheckpointNow:()=>final.sha256});
 assert.throws(()=>service.verifyExpertFinalCustody('copy-chat','copy-project'),error=>{
  assert.match(error.message,/final fence is unavailable/);
  assert.equal(describeBranchDeletionFailure(error,'resource'),'Temporary agent copy final fence is unavailable. Cleanup step: cleaning up a temporary Workflow resource.');
  return true;
 },'a receipt without its exact retained fence cannot release cleanup and its exact cause is visible');
});

test('only the exact exhausted no-publication snapshot reservation accepts the existing Retry intervention',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'expert-copy-retry-')),store=new AgentStore(root);t.after(()=>store.close());
 const coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Expert',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Source'});
 const agent=store.createAgent(project.id,{title:'Agent',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Copy retry',trigger:{kind:'manual'},entry:'work',controls:[],
  steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'expert'},instructions:'Work',jobHandling:'copy'}],edges:[],
  policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'copy-retry-deploy',definition,bindings:{agents:{expert:agent.id},directories:{workspace:root}}});
 const job=branches.accept(branch.id,'copy-retry-job','Preserve this exact input');for(let i=0;i<6;i++)branches.advance();
 const resource=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);
 const attempt=branches.detail(job.id).attempts[0];assert.equal(attempt.snapshotRetryAvailable,undefined);
 assert.equal(branches.currentActions(job.id).items.some(item=>item.kind==='attempt'&&item.attempt.id===attempt.id),false,'ordinary prepared work is not an intervention');
 let current=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
 for(let i=0;i<3;i++){
  const next={...current.snapshotSource,checkpointId:'next-'+i};
  const retried=renewBranchExpertSnapshot(store.sqlite,job.id,resource.step_execution_id,current.snapshotSource,next);
  assert.equal(retried,i<2);
  current=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
 }
 assert.equal(current.snapshotRetryHeld,true);assert.equal(current.snapshotFailures.length,3);
 assert.equal(branches.detail(job.id).attempts[0].snapshotRetryAvailable,true);
 const action=branches.currentActions(job.id).items.find(item=>item.kind==='attempt'&&item.attempt.id===attempt.id);
 assert.ok(action);assert.equal(action.attempt.snapshotRetryAvailable,true);assert.equal(action.attempt.retryBlockedReason,undefined);
 const before=current.snapshotSource.checkpointId;
 const response=branches.intervene(job.id,{commandKey:'retry-proven-snapshot',expectedRevision:branches.execution(job.id).revision,action:'retry',attemptId:attempt.id,reason:'Retry the confirmed no-effect snapshot'});
 const after=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
 assert.equal(after.snapshotRetryHeld,false);assert.equal(after.snapshotRetryBase,3);assert.notEqual(after.snapshotSource.checkpointId,before);
 assert.equal(branches.currentActions(job.id).items.some(item=>item.kind==='attempt'&&item.attempt.id===attempt.id),false);
 assert.equal(response.attempts[0].id,attempt.id,'the same job and attempt remain');
 assert.equal(response.attempts[0].requestId,undefined);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests WHERE recipient_agent_id=?').get(agent.id).n,0);
 assert.throws(()=>branches.intervene(job.id,{commandKey:'retry-unproven-snapshot',expectedRevision:branches.execution(job.id).revision,action:'retry',attemptId:attempt.id,reason:'Not held'}),/Only failed or outcome-unknown/);
});
