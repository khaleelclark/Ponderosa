// Deferred source; not executed. UI consumes server-owned selection, never fabricates owner ancestry.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BranchGroupClient} from '../../packages/core/src/branch-group-client.ts';
import {treePreviewSupported,groupCaptureMatches,groupDestinationMatches,groupReviewMatches,restoreGroupJournal} from '../../apps/web/src/components/branches/branchGroupReview.ts';
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
