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
