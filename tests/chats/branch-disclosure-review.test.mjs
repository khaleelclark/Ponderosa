import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {disclosureCanRevoke,disclosureReceiptMatches,disclosureReviewMatches} from '../../apps/web/src/components/branches/branchDisclosureReview.ts';
const target={admissionId:'admission',checkpointId:4,checkpointHash:'cut',destination:{projectId:'project',conversationId:'chat',executionId:'fresh-run',resourceStepId:'step',resourceGeneration:0},disclosure:{state:'approved',revision:2,reviewHash:'chosen'}};
const preview={admissionId:'admission',reviewHash:'current-review',facts:[],review:{facts:[],admissionId:'admission',reservation:{branchId:'branch',sourceExecutionId:'source-run',checkpointId:4,checkpointHash:'cut',destination:target.destination}}};
test('disclosure preview binds exact source checkpoint, admission and destination generation',()=>{
 assert.equal(disclosureReviewMatches(preview,target,'branch','source-run'),true);
 assert.equal(disclosureReviewMatches({...preview,admissionId:'other'},target,'branch','source-run'),false);
 assert.equal(disclosureReviewMatches(preview,{...target,checkpointHash:'other'},'branch','source-run'),false);
 for(const field of Object.keys(target.destination))assert.equal(disclosureReviewMatches(preview,{...target,destination:{...target.destination,[field]:'changed'}},'branch','source-run'),false);
 assert.equal(disclosureReviewMatches(preview,target,'other','source-run'),false);
});
test('revoke uses persisted choice even without preview; receipts cannot supply current authority',()=>{
 assert.equal(disclosureCanRevoke(target),true);
 assert.equal(disclosureCanRevoke({...target,disclosure:{state:'revoked',revision:3,reviewHash:'chosen'}}),false);
 assert.equal(disclosureCanRevoke({...target,disclosure:{state:'approved',revision:2}}),false);
 const input={commandKey:'key',action:'approve',reviewHash:'chosen',expectedRevision:1};
 const receipt={admissionId:'admission',commandKey:'key',action:'approve',reviewHash:'chosen',revision:2,state:'approved',active:false};
 assert.equal(disclosureReceiptMatches(receipt,'admission',input),true,'inactive historical approval is still its exact receipt');
 for(const change of [{admissionId:'other'},{commandKey:'new'},{revision:3},{reviewHash:'new'},{action:'revoke'},{state:'revoked'}])assert.equal(disclosureReceiptMatches({...receipt,...change},'admission',input),false);
});
