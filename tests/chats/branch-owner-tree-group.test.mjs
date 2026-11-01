// Deferred source; not executed. UI consumes server-owned selection, never fabricates owner ancestry.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BranchGroupClient} from '../../packages/core/src/branch-group-client.ts';
import {treePreviewSupported,groupCaptureMatches,groupDestinationMatches,groupReviewMatches,restoreGroupJournal} from '../../apps/web/src/components/branches/branchGroupReview.ts';
import {groupReviewEvidenceMatches} from '../../apps/web/src/components/branches/branchGroupReviewEvidence.ts';
const hash=n=>n.toString(16).padStart(64,'0');
const owners=['parent','child'].map((executionId,i)=>({executionId,branchId:`branch${i}`,resourceStepId:`step${i}`,sourceChatId:`chat${i}`,agentIds:[`original${i}`]}));
const preview={reviewHash:hash(1),versionId:'version',currentAuthority:false,actionEligible:false,owners};
const command={kind:'capture',scope:'owner_tree',body:{commandKey:'capture / original',reviewHash:preview.reviewHash,versionId:preview.versionId},resourceStepIds:owners.map(o=>o.resourceStepId),preview};
const status={state:'retained',reviewHash:preview.reviewHash,versionId:preview.versionId,currentAuthority:false,actionEligible:false,checkpointId:50,checkpointHash:hash(2),sources:owners.map(({executionId,resourceStepId,sourceChatId})=>({executionId,resourceStepId,sourceChatId,sealed:true}))};
const input={commandKey:'prepare',checkpointId:50,expectedHash:hash(2),reconcileEffects:true};
const resources=owners.map((o,i)=>({custody:{checkpointId:`package${i}`,custodyId:`custody${i}`,sourceChatId:o.sourceChatId,agentIds:o.agentIds,sha256:hash(i+10),intent:{executionId:o.executionId,resourceStepId:o.resourceStepId,resourceGeneration:0,frontierSha256:hash(i+20),hostCutSha256:hash(i+30),bindingSha256:hash(i+40),configurationSha256:hash(i+50)}},destination:{projectId:'fresh-project',conversationId:`fresh-chat${i}`,executionId:`fresh${i}`,resourceStepId:`fresh-step${i}`,resourceGeneration:0}}));
const target={scope:'owner_tree',ownerMap:{parent:'fresh0',child:'fresh1'},commandKey:'prepare',admissionId:'admission',checkpointId:50,checkpointHash:hash(2),state:'awaiting_disclosure',resources,disclosure:{state:'unreviewed',revision:0}};
const facts=owners.map((o,i)=>({kind:'request',id:`request${i}`,sha256:hash(i+60),originalAgentIds:o.agentIds,destinationAgentIds:[`fresh-agent${i}`],originalActor:{agentId:o.agentIds[0]},originalAudience:{projectId:`original-project${i}`,agentIds:o.agentIds}}));
const review={admissionId:'admission',reviewHash:hash(70),hostCutSha256:hash(71),policyRevision:hash(72),review:{admissionId:'admission',reservation:{branchId:'branch0',sourceExecutionId:'parent',commandKey:'prepare',checkpointId:50,checkpointHash:hash(2),resources},facts},facts:facts.map(f=>({...f,content:{text:'original fact'}})),policy:owners.map(o=>({sourceChatId:o.sourceChatId,policy:{}}))};
test('exact parent/child preview and status survive storage and canonical recovery without action authority',()=>{
 assert.equal(treePreviewSupported(preview),true);assert.equal(groupCaptureMatches(status,command),true);
 for(const change of [{currentAuthority:true},{actionEligible:true},{owners:owners.slice(0,1)},{owners:[...owners,owners[0]]},{owners:[owners[0],{...owners[1],executionId:'parent'}]}])assert.equal(treePreviewSupported({...preview,...change}),false);
 for(const change of [{reviewHash:hash(3)},{versionId:'changed'},{currentAuthority:true},{sources:status.sources.slice(0,1)},{sources:[status.sources[0],{...status.sources[1],executionId:'other'}]},{sources:[status.sources[0],{...status.sources[1],sealed:false}]}])assert.equal(groupCaptureMatches({...status,...change},command),false);
 assert.equal(groupCaptureMatches({...status,state:'capturing',sources:status.sources.map((s,i)=>({...s,sealed:i===0}))},command),true,'partial tree remains held');
 const discovered={...command,preview:undefined,treeSources:status.sources,checkpointId:50,checkpointHash:hash(2)};
 assert.equal(groupCaptureMatches(status,discovered),true);assert.equal(groupCaptureMatches({...status,checkpointId:51},discovered),false);
 const old=globalThis.localStorage;try{globalThis.localStorage={getItem:()=>JSON.stringify({capture:command,pending:command})};assert.equal(restoreGroupJournal('key').error,undefined);globalThis.localStorage={getItem:()=>JSON.stringify({capture:{...command,scope:'standalone'}})};assert.ok(restoreGroupJournal('key').error);}finally{globalThis.localStorage=old;}
});
test('both per-owner hashes/maps/policies/facts remain separate; flattening and non-first drift refuse',()=>{
 assert.equal(groupDestinationMatches(target,input,'parent',command.resourceStepIds,command),true);
 assert.equal(groupReviewMatches(review,target,'branch0','parent'),true,'combined host hash is not either per-owner host hash');
 for(const mutate of [v=>v.ownerMap.child='fresh0',v=>delete v.ownerMap.child,v=>v.ownerMap.extra='other',v=>v.resources[1].destination.executionId='fresh0',v=>v.resources[1].custody.intent.executionId='other',v=>v.resources[1].custody.intent.resourceGeneration=1,v=>v.scope='standalone']){const v=structuredClone(target);mutate(v);assert.equal(groupDestinationMatches(v,input,'parent',command.resourceStepIds,command),false);}
 for(const mutate of [v=>v.policy.pop(),v=>v.facts.pop(),v=>v.facts[1].originalActor={agentId:'other'},v=>v.review.reservation.resources[1].custody.intent.bindingSha256=hash(99)]){const v=structuredClone(review);mutate(v);assert.equal(groupReviewMatches(v,target,'branch0','parent'),false);}
 const admitted={...target,state:'admitted',receipt:{resources,owners:resources.map(r=>({executionId:r.destination.executionId,resourceStepId:r.destination.resourceStepId,resourceGeneration:0}))}};
 assert.equal(groupDestinationMatches(admitted,input,'parent',command.resourceStepIds,command),true);
 assert.equal(groupDestinationMatches({...admitted,receipt:undefined},input,'parent',command.resourceStepIds,command),false);
 assert.equal(groupDestinationMatches({...admitted,receipt:{...admitted.receipt,owners:admitted.receipt.owners.slice(0,1)}},input,'parent',command.resourceStepIds,command),false);
});
test('tree adapters use exact routes and CAS, no mutation retries or singular fallback',async()=>{
 const calls=[],api=new BranchGroupClient('branch/one','parent?',async(path,init)=>{calls.push({path,init});if(init?.method==='POST')throw Error('lost');return {items:[]};});
 await api.previewTreeCapture();await api.discoverTreeCaptures();await assert.rejects(()=>api.captureTree(command.body));await api.treeCaptureStatus(command.body.commandKey);
 assert.equal(calls.length,4);assert.match(calls[0].path,/tree-capture-preview$/);assert.match(calls[1].path,/tree-captures$/);assert.deepEqual(JSON.parse(calls[2].init.body),command.body);assert.match(calls[3].path,/tree-capture\?commandKey=capture%20%2F%20original$/);assert.equal(calls[3].init.method,undefined);
});

function savedReviewEvidence(){
 const idMap=Object.fromEntries([['step0','fresh-step0'],['step1','fresh-step1'],['path0','fresh-path0'],['path1','fresh-path1'],['original-call-attempt','fresh-call-attempt']]);
 return {state:'verified',evidenceHash:hash(90),ancestry:'prospective',idMap,ownerMap:target.ownerMap,owners:owners.map((o,i)=>({
  branchId:o.branchId,sourceExecutionId:o.executionId,destinationExecutionId:`fresh${i}`,
  sourceParentExecutionId:i?'parent':null,sourceParentAttemptId:i?'original-call-attempt':null,destinationParentExecutionId:i?'fresh0':null,destinationParentAttemptId:i?'fresh-call-attempt':null,
  counters:{traversals:5+i,loopIterations:i,recoveryTraversals:0,callDepth:i,depthCeiling:4,paths:[{sourcePathId:`path${i}`,destinationPathId:`fresh-path${i}`,traversals:3}],steps:[{sourceStepExecutionId:`step${i}`,destinationStepExecutionId:`fresh-step${i}`,invocation:1}],loops:[{sourcePathId:`path${i}`,destinationPathId:`fresh-path${i}`,edgeId:'edge',iterations:i}]},
  limits:{maxCallDepth:4,maxTraversals:100,maxLoopIterations:20},policy:{maxConcurrentExecutions:2,failure:{action:'stop'}},capacity:{maxConcurrentExecutions:2,maxPathInstances:1000,maxStepInvocations:1000,maxEphemeralAgents:100},selectedUsage:{paths:1,stepInvocations:1,requestedAgents:1},
  acceptance:{source:i?'call:original':'manual',admittedAt:'2026-11-01T00:00:00Z',kind:i?'charged':'manual',budget:{branchId:o.branchId,revision:2,policy:i?{limit:12,period:'day'}:null,used:i?3:0,allowance:2,heldCount:0,periodId:i?'saved-period':null,periodStartedAt:i?'2026-11-01T00:00:00Z':null,observedAt:'2026-11-01T00:00:00Z'}}
 }))};
}
test('M4 exact saved per-owner ancestry/maps/counters/capacity/acceptance remain separate',()=>{
 const value={...target,reviewEvidence:savedReviewEvidence()};
 assert.equal(groupReviewEvidenceMatches(value),true);
 assert.equal(groupDestinationMatches(value,input,'parent',command.resourceStepIds,command),true);
 assert.equal(groupReviewMatches(review,value,'branch0','parent'),true);
 const otherBranch=structuredClone(value);otherBranch.reviewEvidence.owners[0].branchId='other';otherBranch.reviewEvidence.owners[0].acceptance.budget.branchId='other';assert.equal(groupReviewMatches(review,otherBranch,'branch0','parent'),false,'root Branch identity cannot substitute');
 assert.equal(value.reviewEvidence.owners[0].acceptance.budget.policy,null,'null means unlimited, never invented zero quota');
 for(const mutate of [v=>v.reviewEvidence=null,v=>v.reviewEvidence.ancestry='committed',v=>v.reviewEvidence.evidenceHash='bad',v=>v.reviewEvidence.ownerMap={parent:'fresh0',child:'wrong'},v=>v.reviewEvidence.owners.pop(),v=>v.reviewEvidence.owners[0].sourceParentExecutionId='child',v=>v.reviewEvidence.owners[1].destinationParentAttemptId='wrong',v=>v.reviewEvidence.owners[1].counters.steps[0].destinationStepExecutionId='wrong',v=>v.reviewEvidence.owners[1].counters.paths[0].traversals=-1,v=>v.reviewEvidence.owners[1].capacity.maxStepInvocations='unknown',v=>v.reviewEvidence.owners[1].selectedUsage.paths=99,v=>v.reviewEvidence.owners[1].acceptance.budget.branchId='other',v=>v.reviewEvidence.owners[1].acceptance.budget.used=undefined,v=>v.reviewEvidence.owners[1].policy.failure.action='guessed']){
  const changed=structuredClone(value);mutate(changed);
  assert.equal(groupReviewEvidenceMatches(changed),false);assert.equal(groupDestinationMatches(changed,input,'parent',command.resourceStepIds,command),false);assert.equal(groupReviewMatches(review,changed,'branch0','parent'),false);
 }
 const admitted={...value,state:'admitted',reviewEvidence:{...value.reviewEvidence,ancestry:'committed'},receipt:{resources,owners:resources.map(r=>({executionId:r.destination.executionId,resourceStepId:r.destination.resourceStepId,resourceGeneration:0}))}};
 assert.equal(groupDestinationMatches(admitted,input,'parent',command.resourceStepIds,command),true);
 assert.equal(groupReviewEvidenceMatches({...admitted,reviewEvidence:value.reviewEvidence}),false,'admitted cannot claim prospective FKs');
 assert.equal(groupReviewEvidenceMatches({...target,reviewEvidence:{state:'unavailable',reason:'legacy_missing_saved_evidence'}}),true);
 assert.equal(groupReviewEvidenceMatches({...target,reviewEvidence:{state:'unavailable',reason:'legacy_missing_saved_evidence',owners:[]}}),false,'unavailable never supplies invented numeric evidence');
});
