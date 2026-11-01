import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {groupCaptureMatches,groupDestinationMatches,groupReviewMatches,restoreGroupJournal} from '../../apps/web/src/components/branches/branchGroupReview.ts';
import {BranchGroupClient} from '../../packages/core/src/branch-group-client.ts';
const hash='a'.repeat(64),input={commandKey:'prepare',checkpointId:4,expectedHash:hash,reconcileEffects:true};
const command={kind:'capture',body:{commandKey:'capture'},resourceStepIds:['step0','step1']};
const sources=[0,1].map(i=>({checkpointId:`package${i}`,resourceStepId:`step${i}`,sourceChatId:`chat${i}`,sealed:true}));
const status={state:'retained',cleanupHeld:false,abandonment:'unsupported',checkpointId:4,checkpointHash:hash,sources};
const resources=sources.map((s,i)=>({custody:{checkpointId:s.checkpointId,custodyId:`custody${i}`,sourceChatId:s.sourceChatId,sha256:hash,agentIds:[`agent${i}`],intent:{executionId:'source',resourceStepId:s.resourceStepId,resourceGeneration:0,frontierSha256:hash,hostCutSha256:hash,bindingSha256:hash,configurationSha256:hash}},destination:{projectId:'project',conversationId:`fresh-chat${i}`,executionId:'fresh',resourceStepId:`fresh-step${i}`,resourceGeneration:0}}));
const target={commandKey:'prepare',admissionId:'admission',checkpointId:4,checkpointHash:hash,resources,state:'awaiting_disclosure',disclosure:{state:'unreviewed',revision:0}};
const review={admissionId:'admission',reviewHash:hash,hostCutSha256:hash,policyRevision:hash,review:{admissionId:'admission',reservation:{branchId:'branch',sourceExecutionId:'source',commandKey:'prepare',checkpointId:4,checkpointHash:hash,resources}},policy:sources.map(s=>({sourceChatId:s.sourceChatId,policy:{}}))};
test('both exact retained seals required; partial captures keep cleanup held',()=>{
 assert.equal(groupCaptureMatches(status,command),true);
 for(const change of [{sources:[sources[0]]},{sources:[...sources,sources[0]]},{sources:[sources[0],sources[0]]},{cleanupHeld:true},{checkpointHash:'other'},{sources:[sources[0],{...sources[1],sealed:false}]}])assert.equal(groupCaptureMatches({...status,...change},command),false);
 assert.equal(groupCaptureMatches({...status,state:'capturing',cleanupHeld:true,sources:[sources[0],{...sources[1],sealed:false}]},command),true);
 assert.equal(groupCaptureMatches({...status,state:'capturing',cleanupHeld:false},command),false);
});
test('destination and whole preview bind both original packages and policies',()=>{
 assert.equal(groupDestinationMatches(target,input,'source',command.resourceStepIds),true);
 assert.equal(groupReviewMatches(review,target,'branch','source'),true);
 for(const index of [0,1]){
  const changed=structuredClone(target);changed.resources[index].custody.sha256='b'.repeat(64);
  assert.equal(groupReviewMatches(review,changed,'branch','source'),false);
  const later=structuredClone(target);later.resources[index].destination.resourceGeneration=1;
  assert.equal(groupDestinationMatches(later,input,'source',command.resourceStepIds),false);
 }
 assert.equal(groupReviewMatches({...review,policy:[review.policy[0]]},target,'branch','source'),false);
 assert.equal(groupReviewMatches(review,target,'other','source'),false);
 assert.equal(groupDestinationMatches({...target,resources:[...resources,resources[0]]},input,'source',command.resourceStepIds),false);
});
test('corrupt or incomplete storage never authorizes replacement commands',()=>{
 const original=globalThis.localStorage;
 try{
  for(const bytes of ['{','null','[]',JSON.stringify({capture:{kind:'prepare',body:input}}),JSON.stringify({prepare:input})]){
   globalThis.localStorage={getItem:()=>bytes};assert.ok(restoreGroupJournal('key').error);
  }
  globalThis.localStorage={getItem:()=>JSON.stringify({capture:command,prepare:input,pending:{kind:'prepare',body:input}})};
  assert.equal(restoreGroupJournal('key').error,undefined);
 }finally{globalThis.localStorage=original;}
});
test('shared client uses pure encoded exact-key readback and never retries a failed mutation',async()=>{
 const calls=[],api=new BranchGroupClient('branch/one','run?',async(path,init)=>{calls.push({path,init});if(init?.method==='POST')throw Error('response lost');return status;});
 await assert.rejects(()=>api.capture({commandKey:'capture & one'}));assert.equal(calls.length,1);
 await api.captureStatus('capture & one');assert.match(calls[1].path,/destination-groups\/capture\?commandKey=capture%20%26%20one$/);assert.equal(calls[1].init.method,undefined);
 await api.choiceReceipt('admission/one','choice & one');assert.match(calls[2].path,/admission%2Fone\/disclosure\?commandKey=choice%20%26%20one$/);assert.equal(calls.length,3);
});
