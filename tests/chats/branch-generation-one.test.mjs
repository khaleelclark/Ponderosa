// Deferred source; not executed.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generationOnePreviewMatches,generationOneCaptureMatches,generationOneReceiptProjection} from '../../apps/web/src/components/branches/branchGenerationOne.ts';
const hash='a'.repeat(64),selection={executionId:'run',stepId:'step',generation:0,checkpointId:1,checkpointHash:hash,envelopeSha256:hash,intakeFence:{identity:'fence',sha256:hash},discloseTo:['current-ref']};
const preview={generation:1,reviewHash:hash,historicalReviewHash:hash,historicalPartition:[selection]};
const capture={commandKey:'original key',state:'retained',checkpointId:2,checkpointHash:hash,restoreSupported:false,reviewHash:hash,historicalReviewHash:hash,historicalPartition:[selection]};
test('only exact server generation-one selection and complete retained cut reach preparation',()=>{
 assert.equal(generationOnePreviewMatches(preview,'run','step'),true);
 for(const change of [{generation:2},{reviewHash:''},{historicalPartition:[]},{historicalPartition:[selection,selection]},{historicalPartition:[{...selection,generation:1}]},{historicalPartition:[{...selection,discloseTo:[]}]},{historicalPartition:[{...selection,executionId:'other'}]}])assert.equal(generationOnePreviewMatches({...preview,...change},'run','step'),false);
 assert.equal(generationOneCaptureMatches(capture,preview,'original key'),true);
 for(const change of [{commandKey:'guessed'},{state:'not_found'},{historicalReviewHash:'changed'},{historicalPartition:[{...selection,discloseTo:['old-agent']}]},{checkpointId:undefined},{restoreSupported:true},{reviewHash:'new cut'}])assert.equal(generationOneCaptureMatches({...capture,...change},preview,'original key'),false);
});
import {disclosureReviewMatches} from '../../apps/web/src/components/branches/branchDisclosureReview.ts';
test('all retired facts retain actor/audience metadata and current package recipient refs',()=>{
 const destination={projectId:'fresh-project',conversationId:'fresh-chat',executionId:'fresh-run',resourceStepId:'fresh-step',resourceGeneration:1};
 const target={admissionId:'admission',checkpointId:2,checkpointHash:hash,destination,historicalPartition:[selection]};
 const fact={kind:'historical_generation',id:'retired-fact',sha256:hash,originalAgentIds:['retired-agent'],destinationAgentIds:['fresh-agent'],originalActor:{agentId:'retired-agent'},originalAudience:{kind:'private'}};
 const review={admissionId:'admission',reviewHash:hash,review:{admissionId:'admission',reservation:{branchId:'branch',sourceExecutionId:'run',checkpointId:2,checkpointHash:hash,destination,custody:{intent:{resourceGeneration:1,resourceStepId:'step'}},historicalPartition:[selection]},stage:{agentMap:{'current-ref':'fresh-agent'}},facts:[fact]},facts:[{...fact,content:{seal:{identity:{executionId:'run',stepId:'step',generation:0,agentIds:['retired-agent']},checkpointId:1,checkpointHash:hash,envelopeSha256:hash,intakeFence:selection.intakeFence}}}]};
 assert.equal(disclosureReviewMatches(review,target,'branch','run'),true);
 for(const change of [{facts:[]},{facts:[{...fact,originalActor:{agentId:'fresh-agent'}}]},{facts:[{...fact,originalAudience:{kind:'broadcast'}}]},{facts:[{...fact,destinationAgentIds:['retired-agent']}]}])assert.equal(disclosureReviewMatches({...review,...change},target,'branch','run'),false);
 assert.equal(disclosureReviewMatches({...review,review:{...review.review,stage:{agentMap:{'retired-agent':'fresh-agent'}}}},target,'branch','run'),false);
 assert.equal(disclosureReviewMatches(review,{...target,historicalPartition:undefined},'branch','run'),false);
});

test('receipt display excludes native retired seals and raw retirement bytes',()=>{
 const projected=generationOneReceiptProjection({receipt:{historicalPartition:[{sha256:hash,selection,seal:{privateBody:'PRIVATE SEAL'},retirement:{resultJson:'PRIVATE SNAPSHOT'},historical:true,dispatchable:false,destinationAgentIds:['fresh-agent']}]}});
 assert.ok(!JSON.stringify(projected).includes('PRIVATE'));assert.ok(JSON.stringify(projected).includes('dispatchable'));
});
