import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {reviewedContinuationCommandSha256}=await import('../../apps/web/src/components/ReviewedContinuationDialog.tsx');
const {payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');

test('continuation receipt hash matches backend canonical input with and without Web Crypto',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto'),native=globalThis.crypto;
 try{
  for(const crypto of [native,{},undefined]){
   Object.defineProperty(globalThis,'crypto',{value:crypto,configurable:true});
   for(const note of [undefined,'Reviewed 🌲 effects\nno repeat']){
    const saved={version:1,product:'dev',projectId:'project-one',activationId:'steer-one',agentId:'agent-one',runId:'run-one',injectionId:'injection-one',reviewSha256:'a'.repeat(64),idempotencyKey:'command-one',...(note!==undefined?{reviewNote:note}:{})};
    const input={projectId:saved.projectId,activationId:saved.activationId,reviewSha256:saved.reviewSha256,effectsReviewed:true,idempotencyKey:saved.idempotencyKey,...(note!==undefined?{reviewNote:note}:{})};
    assert.equal(await reviewedContinuationCommandSha256(saved),payloadHash(input));
   }
  }
 }finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;}
});
