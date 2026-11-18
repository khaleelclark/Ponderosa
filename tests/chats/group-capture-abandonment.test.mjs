// Deferred source; no execution authorized.
import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {groupCaptureEntryValid,groupAbandonmentReviewMatches,groupAbandonmentHeld,groupAbandonmentReceiptMatches,groupAbandonmentReceiptSummary,groupAbandonmentStorageKey,restoreGroupAbandonment,retainedGroupAbandonments} from '../../apps/web/src/components/lifecycle/groupCaptureAbandonment.ts';
const hash='a'.repeat(64),entry={executionId:'source',captureKey:'issued-group-capture:'+hash,sourceOwner:'retained_only',state:'capturing',evidenceSha256:hash,capturedCheckpointIds:['package0'],sources:[0,1].map(i=>({checkpointId:`package${i}`,sourceChatId:`chat${i}`,agentIds:[`agent${i}`],intent:{executionId:'source',resourceStepId:`step${i}`,resourceGeneration:0,frontierSha256:hash,hostCutSha256:hash,bindingSha256:hash,configurationSha256:hash}}))};
const review={executionId:entry.executionId,captureKey:entry.captureKey,groupId:hash,captureSha256:hash,branchRevision:hash,reviewSha256:hash,references:[],blockers:[],packages:entry.sources.map((source,i)=>({source,custodyId:String(i).repeat(64),state:i?'capturing':'retained',sourceAgentIds:source.agentIds,references:[],blockers:[],reviewSha256:hash,files:i?[]:[{name:'original.payload',sha256:hash,byteLength:42}]}))};
const input={executionId:entry.executionId,captureKey:entry.captureKey,commandKey:'original stable command',reviewSha256:hash,preserveEvidence:true},command={entry,input,review};
const receipt={state:'abandoned',groupId:hash,commandKey:input.commandKey,reviewSha256:hash,captureArchiveSha256:hash,packages:review.packages.map(p=>({state:'reconciled',custodyId:p.custodyId,commandKey:input.commandKey,reviewSha256:p.reviewSha256,preservedBytes:p.files.reduce((n,f)=>n+f.byteLength,0),filesSha256:hash})),branch:{schema:'branch-group-custody-abandon.v1',state:'abandoned',input:{executionId:entry.executionId,captureKey:entry.captureKey,commandKey:input.commandKey,captureSha256:hash,expectedRevision:hash},sources:entry.sources,packageRetirements:review.packages.map(p=>({custodyId:p.custodyId,sourceSha256:hash,revision:hash})),originalCaptureRaw:'PRIVATE SNAPSHOT NEVER DISPLAY',createdAt:'now'}};
test('discovery and review bind every raw group identity, including uncaptured members',()=>{
 assert.equal(groupCaptureEntryValid(entry),true);assert.equal(groupAbandonmentReviewMatches(review,entry),true);assert.equal(groupAbandonmentHeld(review),false);
 for(const patch of [{captureKey:'plaintext command'},{sources:[entry.sources[0]]},{sources:[entry.sources[0],entry.sources[0]]},{capturedCheckpointIds:['guessed']},{state:'retained'},{evidenceSha256:'invalid'}])assert.equal(groupCaptureEntryValid({...entry,...patch}),false);
 assert.equal(groupAbandonmentReviewMatches({...review,packages:review.packages.slice(0,1)},entry),false);
 assert.equal(groupAbandonmentReviewMatches({...review,captureKey:'other'},entry),false);
 assert.equal(groupAbandonmentHeld({...review,packages:[review.packages[0],{...review.packages[1],blockers:['second member native exit missing']}]}),true);
 assert.equal(groupAbandonmentHeld({...review,references:['foreign pin']}),true);
 assert.equal(groupCaptureEntryValid({...entry,capturedCheckpointIds:[]}),true,'zero packages is supported');
});
test('receipt needs exhaustive matching package and whole-owner proof; raw snapshots stay undisplayed',()=>{
 assert.equal(groupAbandonmentReceiptMatches(command,receipt),true);
 for(const patch of [{commandKey:'replacement'},{groupId:'other'},{reviewSha256:'new'},{state:'partial'},{packages:receipt.packages.slice(0,1)},{packages:[receipt.packages[0],receipt.packages[0]]},{packages:receipt.packages.map((p,i)=>i?{...p,preservedBytes:1}:p)}])assert.equal(groupAbandonmentReceiptMatches(command,{...receipt,...patch}),false);
 assert.equal(groupAbandonmentReceiptMatches(command,{...receipt,branch:{...receipt.branch,sources:entry.sources.slice(0,1)}}),false);
 assert.ok(!JSON.stringify(groupAbandonmentReceiptSummary(receipt)).includes('PRIVATE SNAPSHOT'));
});
test('saved exact command remains recoverable without live discovery or owner; corruption stays held',()=>{
 const original=globalThis.localStorage,key=groupAbandonmentStorageKey('origin','scope',entry),values=new Map([[key,JSON.stringify(command)]]);
 globalThis.localStorage={get length(){return values.size;},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null};
 try{
  assert.deepEqual(restoreGroupAbandonment(key,entry).command.input,input);
  assert.deepEqual(retainedGroupAbandonments('origin','scope').entries,[entry]);
  assert.deepEqual(retainedGroupAbandonments('origin','other').entries,[]);
  values.set(key,JSON.stringify({...command,input:{...input,reviewSha256:'new'}}));assert.ok(restoreGroupAbandonment(key,entry).error);assert.ok(retainedGroupAbandonments('origin','scope').error);
  values.set(key,'{');assert.ok(restoreGroupAbandonment(key,entry).error);
 }finally{globalThis.localStorage=original;}
});
