import test from 'node:test';
import assert from 'node:assert/strict';
import {BranchResourceService} from '../../apps/server/dist/branch-resource-service.js';

// Deferred orchestration regressions; no provider, browser, native process or remote backend.
test('lost capture response recovers the retained receipt without recapture or premature opening',async()=>{
 const source={checkpointId:'intent',sourceChatId:'source-chat',agentIds:['old-agent'],intent:{executionId:'execution',resourceStepId:'step',resourceGeneration:0,frontierSha256:'a'.repeat(64),bindingSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64)}};
 const receipt={...source,version:1,custodyId:'custody',boundaryId:'boundary',sha256:'d'.repeat(64),byteLength:100};
 let retained=false,captures=0,openings=0,errors=0,finalized=false;
 const branches={resourceProvisions:()=>[{stepExecutionId:'step',chatId:'source-chat'}],resourceOperation:()=>({state:'completed',result:{rootAgentId:'old-agent',agentIds:['old-agent']}}),resourceCaptureEligible:()=>true,
  resourceCaptureJournal:()=>({state:finalized?'retained':'capturing',source}),reserveResourceCapture:()=>source,
  finishResourceCapture:(s,r)=>{assert.deepEqual(s,source);assert.deepEqual(r,receipt);finalized=true;},waitResourceCheckpoint:async()=>assert.equal(finalized,true),
  bindResource:()=>{assert.equal(finalized,true);openings++;},resourceCaptureError:()=>errors++,resourceCleanupCandidates:()=>[],resourceContextCleanupCandidates:()=>[]};
 const service=new BranchResourceService(branches,{},async()=>assert.fail('delete'),async()=>assert.fail('create'),async()=>assert.fail('delete chat'));
 service.setImporter(async()=>assert.fail('already imported'));
 service.setPackageEngine({inspectCheckpoint:async s=>{assert.deepEqual(s,source);return retained?{state:'retained',receipt}:{state:'missing'};},captureCheckpoint:async()=>{captures++;retained=true;throw Error('response lost after durable package commit');}});
 await service.tick(true);assert.equal(openings,0);assert.equal(errors,1);assert.equal(captures,1);
 await service.tick(true);assert.equal(openings,1);assert.equal(captures,1);await service.stop();
});

test('cleanup cannot destroy source Agents when required retained package bytes fail verification',async()=>{
 let deleted=0,errors=0;
 const branches={resourceCleanupCandidates:()=>[{stepExecutionId:'step',agentIds:['agent']}],resourceContextCleanupCandidates:()=>[],resourceCaptureJournal:()=>({state:'retained',receipt:{custodyId:'retained'}}),resourceError:(_step,message)=>{assert.match(message,/changed/);errors++;}};
 const service=new BranchResourceService(branches,{},async()=>deleted++,async()=>assert.fail('create'),async()=>deleted++);
 service.setPackageEngine({readCheckpoint:async()=>{throw Error('retained package changed');}});
 await service.tick(false);assert.equal(deleted,0);assert.equal(errors,1);await service.stop();
});

test('a changed fresh destination review holds import instead of reusing an old access choice',async()=>{
 let imports=0,reviewed=0;
 const pkg={agents:[{ref:'original',history:[{role:'user',text:'private original'}]}],rootRef:'original'};
 const branches={resourceProvisions:()=>[{stepExecutionId:'step',chatId:'new-chat',template:{agents:[{}]},engineMapping:{}}],resourceOperation:()=>undefined,
  resourceRestoreJournal:()=>({receipt:{},rootRef:'original',choice:{action:'use_source',reviewSha256:'old-review'}}),resourceRestoreReview:(_step,review)=>{assert.equal(review.reviewSha256,'current-review');reviewed++;},resourceCleanupCandidates:()=>[],resourceContextCleanupCandidates:()=>[]};
 const service=new BranchResourceService(branches,{},async()=>assert.fail('delete'),async()=>assert.fail('new Chat already exists'),async()=>assert.fail('delete'));
 service.setImporter(async()=>imports++);
 service.setPackageEngine({readCheckpoint:async()=>pkg,validateAgent:()=>{},reviewAccess:async(_pkg,chat)=>{assert.equal(chat,'new-chat');return {reviewSha256:'current-review'};}});
 await service.tick(true);assert.equal(imports,0);assert.equal(reviewed,1);await service.stop();
});

// Deferred: this read must neither stage a choice nor clear an existing one.
test('pure resource inspection recomputes current destination review without changing journals',async()=>{
 const snapshot={branchId:'branch',executionId:'execution',stepExecutionId:'step',generation:7,state:'reserved',destinationChatId:'fresh-chat',destinationChatAvailable:true,importState:null,custody:{kind:'restoration_source',state:'restoration_source',custodyId:'custody',receiptSha256:'receipt-hash',checkpointId:'checkpoint',packageSha256:'package-hash'},currentPolicyReview:null,accessChoiceCurrent:false};
 const journal={receipt:{},rootRef:'source-root',choice:{action:'use_source',reviewSha256:'review'}};
 const branches={resourceInspection:()=>structuredClone(snapshot),resourceRestoreJournal:()=>structuredClone(journal),resourceOperation:()=>undefined,resourceRestoreReview:()=>assert.fail('pure GET must not stage review')};
 const service=new BranchResourceService(branches,{},async()=>assert.fail('delete'),async()=>assert.fail('create'),async()=>assert.fail('delete'));
 service.setPackageEngine({readCheckpoint:async()=>({rootRef:'source-root'}),reviewAccess:async(_pkg,chat)=>{assert.equal(chat,'fresh-chat');return {reviewSha256:'review'};}});
 const result=await service.inspectResource('step');assert.equal(result.accessChoiceCurrent,true);assert.equal(result.currentPolicyReview.reviewSha256,'review');
 assert.equal(snapshot.currentPolicyReview,null);assert.equal(journal.choice.reviewSha256,'review');
 service.setPackageEngine({readCheckpoint:async()=>({}),reviewAccess:async()=>{snapshot.generation++;return {reviewSha256:'changed'};}});
 await assert.rejects(service.inspectResource('step'),/inspection changed/);
});

test('resource custody SDK retains exact release input and performs no automatic retry',async()=>{
 const {BranchesClient}=await import('../../packages/core/dist/branches-client.js');
 const input={commandKey:'release:stable',expectedGeneration:3,expectedCustodyId:'c'.repeat(64),expectedReceiptSha256:'d'.repeat(64)},calls=[];
 const client=new BranchesClient('http://local.invalid',async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(options.method==='DELETE'?{...input,state:'releasing'}:{commandKey:input.commandKey,state:'not_found'}),{status:200});});
 await client.inspectResource('branch','execution','step');
 await client.releaseResourceCustody('branch','execution','step',input);
 await client.resourceCustodyReleaseStatus('branch','execution','step',input.commandKey);
 assert.equal(calls.length,3);assert.equal(calls[0].options.method,'GET');assert.equal(calls[1].options.method,'DELETE');assert.deepEqual(JSON.parse(calls[1].options.body),input);
 assert.equal(new URL(calls[2].url).searchParams.get('commandKey'),input.commandKey);
 let failures=0;const failed=new BranchesClient('http://local.invalid',async()=>{failures++;throw Error('connection lost');});
 await assert.rejects(failed.releaseResourceCustody('branch','execution','step',input),/connection lost/);assert.equal(failures,1);
});
