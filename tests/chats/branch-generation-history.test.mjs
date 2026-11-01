// Deferred source; not executed.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generationCaptureEvidence,generationCaptureBudgetMatches,generationCaptureBudgetLabel,generationHistoryPreviewMatches,generationOnePreviewMatches,generationSelectionMatches,generationOneCaptureMatches,generationOneReceiptProjection} from '../../apps/web/src/components/branches/branchGenerationOne.ts';
import {disclosureReviewMatches,historicalFactGeneration} from '../../apps/web/src/components/branches/branchDisclosureReview.ts';
const hash=i=>i.toString(16).padStart(64,'0');
export function historyFixture(generation){
 const historicalPartition=Array.from({length:generation},(_,i)=>({executionId:'source',stepId:'step',generation:i,checkpointId:i+1,checkpointHash:hash(i+1),envelopeSha256:hash(i+100),intakeFence:{identity:`fence${i}`,sha256:hash(i+200)},discloseTo:['current-a','current-b']}));
 const preview={generation,consumedAttempts:generation+1,maxAttempts:33,reviewHash:hash(999),historicalReviewHash:hash(998),historicalPartition};
 const capture={generation,commandKey:'original',state:'retained',checkpointId:1000,checkpointHash:hash(997),restoreSupported:false,reviewHash:preview.reviewHash,historicalReviewHash:preview.historicalReviewHash,historicalPartition};
 const facts=historicalPartition.map(s=>({kind:'historical_generation',id:`original-fact${s.generation}`,sha256:hash(s.generation+300),originalAgentIds:[`old${s.generation}`],destinationAgentIds:['fresh-a','fresh-b'],originalActor:{original:`old${s.generation}`},originalAudience:{projectId:`old-project${s.generation}`,agentIds:[`old${s.generation}`]}}));
 const fullFacts=facts.map((f,i)=>({...f,content:{seal:{identity:{executionId:'source',stepId:'step',generation:i,agentIds:f.originalAgentIds},checkpointId:historicalPartition[i].checkpointId,checkpointHash:historicalPartition[i].checkpointHash,envelopeSha256:historicalPartition[i].envelopeSha256,intakeFence:historicalPartition[i].intakeFence,receipt:{checkpointId:`package${i}`}},retirement:{resultJson:'PRIVATE RETIREMENT'}}}));
 const destination={projectId:'fresh-project',conversationId:'fresh-chat',executionId:'fresh-run',resourceStepId:'fresh-step',resourceGeneration:0};
 const target={admissionId:'admission',checkpointId:1000,checkpointHash:capture.checkpointHash,destination,historicalPartition};
 const review={admissionId:'admission',reviewHash:hash(996),review:{admissionId:'admission',reservation:{branchId:'branch',sourceExecutionId:'source',checkpointId:1000,checkpointHash:capture.checkpointHash,destination,historicalPartition,custody:{intent:{resourceGeneration:generation,resourceStepId:'step'}}},stage:{agentMap:{'current-a':'fresh-a','current-b':'fresh-b'}},facts},facts:fullFacts};
 return {preview,capture,review,target};
}
for(const generation of [2,3,32])test(`generation ${generation} requires every ordered selection, original package/fact and unchanged budget`,()=>{
 const {preview,capture,review,target}=historyFixture(generation),copy=x=>structuredClone(x);
 assert.equal(generationHistoryPreviewMatches(preview,'source','step'),true);
 assert.equal(generationOnePreviewMatches(preview,'source','step'),false,'gen1 compatibility validator stays bounded');
 assert.equal(generationOneCaptureMatches(capture,preview,'original'),true);
 for(const change of [{consumedAttempts:1},{consumedAttempts:generation},{maxAttempts:generation},{maxAttempts:34},{generation:33},{historicalPartition:preview.historicalPartition.slice(0,-1)},{historicalPartition:[...preview.historicalPartition].reverse()}])assert.equal(generationHistoryPreviewMatches({...preview,...change},'source','step'),false);
 const alias=copy(preview);alias.historicalPartition.at(-1).checkpointId=alias.historicalPartition[0].checkpointId;assert.equal(generationHistoryPreviewMatches(alias,'source','step'),false);
 const changed=copy(preview);changed.historicalPartition.at(-1).discloseTo=['old-agent'];assert.equal(generationHistoryPreviewMatches(changed,'source','step'),false);
 assert.equal(generationOneCaptureMatches({...capture,generation:generation-1},preview,'original'),false);
 assert.equal(generationOneCaptureMatches({...capture,checkpointId:preview.historicalPartition[0].checkpointId},preview,'original'),false,'current cut cannot alias a prior package checkpoint');
 assert.equal(generationOneCaptureMatches({...capture,historicalPartition:preview.historicalPartition.slice(0,-1)},preview,'original'),false);
 const statusEvidence={generation,reviewHash:capture.reviewHash,historicalReviewHash:capture.historicalReviewHash,historicalPartition:capture.historicalPartition};
 assert.equal(generationSelectionMatches(statusEvidence,'source','step'),true);assert.equal(statusEvidence.maxAttempts,undefined,'status does not invent budget');
 assert.equal(disclosureReviewMatches(review,target,'branch','source'),true);
 assert.deepEqual(review.facts.map(historicalFactGeneration),Array.from({length:generation},(_,i)=>i));
 for(const mutate of [v=>v.facts.pop(),v=>v.facts.reverse(),v=>v.facts.at(-1).content.seal.checkpointHash=hash(10000),v=>v.facts.at(-1).content.seal.identity.generation=0,v=>v.facts.at(-1).originalActor={original:'changed'},v=>v.review.stage.agentMap['current-a']=`old${generation-1}`]){
  const v=copy(review);mutate(v);assert.equal(disclosureReviewMatches(v,target,'branch','source'),false);
 }
 const missing=copy(target);missing.historicalPartition.pop();assert.equal(disclosureReviewMatches(review,missing,'branch','source'),false);
 const receipt={receipt:{historicalPartition:review.facts.map((f,i)=>({selection:preview.historicalPartition[i],sha256:f.sha256,historical:true,dispatchable:false,destinationAgentIds:f.destinationAgentIds,seal:{PRIVATE:'native'},retirement:{resultJson:'PRIVATE RETIREMENT'}}))}};
 const projected=JSON.stringify(generationOneReceiptProjection(receipt));assert.ok(!projected.includes('PRIVATE'));assert.ok(projected.includes(`fence${generation-1}`));
});

test('canonical saved budgets require proof, exact top-level values and unchanged cut/budget/hash',()=>{
 const {preview,capture}=historyFixture(3);
 const retryBudget={state:'verified',consumedAttempts:4,maxAttempts:33,evidenceHash:hash(700)};
 const verified={...capture,consumedAttempts:4,maxAttempts:33,retryBudget};
 assert.equal(generationCaptureBudgetMatches(verified),true);
 const recovered=generationCaptureEvidence(verified);
 assert.equal(recovered.consumedAttempts,4);assert.equal(recovered.maxAttempts,33);
 assert.equal(recovered.retryBudget.evidenceHash,hash(700));
 assert.equal(generationOneCaptureMatches(verified,recovered,'original'),true);
 assert.ok(generationCaptureBudgetLabel(verified).includes(hash(700)));
 for(const bad of [ {...verified,maxAttempts:32}, {...verified,consumedAttempts:1}, {...verified,retryBudget:{...retryBudget,evidenceHash:'bad'}}, {...verified,retryBudget:{...retryBudget,state:'unknown'}}, {...capture,maxAttempts:33}, {...verified,retryBudget:{state:'unavailable',reason:'missing_saved_retry_proof'}}, {...verified,retryBudget:null} ]){
  assert.equal(generationCaptureBudgetMatches(bad),false);assert.throws(()=>generationCaptureEvidence(bad));
 }
 assert.equal(generationOneCaptureMatches({...verified,retryBudget:{...retryBudget,evidenceHash:hash(701)}},recovered,'original'),false);
 assert.equal(generationOneCaptureMatches({...verified,reviewHash:hash(701)},recovered,'original'),false);
 assert.equal(generationOneCaptureMatches({...verified,checkpointId:1},recovered,'original'),false);
 assert.equal(generationOneCaptureMatches({...verified,checkpointId:1001},recovered,'original'),false);
 assert.equal(generationOneCaptureMatches({...verified,checkpointHash:hash(702)},recovered,'original'),false);
 assert.equal(generationOneCaptureMatches({...verified,maxAttempts:32,retryBudget:{...retryBudget,maxAttempts:32}},preview,'original'),false,'saved preview budget conflict stays held');
 for(const legacy of [capture,{...capture,retryBudget:{state:'unavailable',reason:'missing_saved_retry_proof'}}]){
  assert.equal(generationCaptureBudgetMatches(legacy),true);assert.equal(generationCaptureEvidence(legacy).maxAttempts,undefined);assert.ok(generationCaptureBudgetLabel(legacy).includes('unavailable'));
  assert.equal(generationOneCaptureMatches(legacy,preview,'original'),true,'legacy original preview remains preserved');
  assert.equal(generationOneCaptureMatches(legacy,recovered,'original'),false,'verified discovery cannot downgrade during status recovery');
 }
});
