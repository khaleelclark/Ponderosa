import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {historyActionAvailable,historyReviewMatches} from '../../apps/web/src/components/branches/branchHistoryReview.ts';
const checkpoint={id:4,branchId:'branch',executionId:'execution',contentHash:'checkpoint-hash'};
const request={source:{branchId:'branch',executionId:'execution',checkpointId:4,expectedHash:'checkpoint-hash',requestId:'request'},reviewHash:'opaque-review'};
test('review source must match the selected immutable checkpoint and exact current scope',()=>{
 const matches=value=>historyReviewMatches(value,'branch','execution',checkpoint,'request');
 assert.equal(matches({kind:'request',value:request}),true);
 assert.equal(matches({kind:'request',value:{...request,source:{...request.source,requestId:'other'}}}),false);
 assert.equal(matches({kind:'request',value:{...request,source:{...request.source,executionId:'other'}}}),false);
 const graph={checkpointId:4,checkpointHash:'checkpoint-hash',reviewHash:'graph-review',requests:[request]};
 assert.equal(matches({kind:'graph',value:graph}),true);
 assert.equal(matches({kind:'graph',value:{...graph,checkpointHash:'changed'}}),false);
 assert.equal(matches({kind:'graph',value:{...graph,requests:[{...request,source:{...request.source,branchId:'other'}}]}}),false);
});

test('unsupported graph cuts cannot offer restore or rewind, while evidence adoption stays separately reviewed',()=>{
 const supported={...checkpoint,restoreSupported:true,eligibility:'script_control_frontier'};
 assert.equal(historyActionAvailable('restore',supported),true);
 assert.equal(historyActionAvailable('rewind',{...supported,restoreSupported:false}),false);
 assert.equal(historyActionAvailable('restore',{...supported,eligibility:'unsupported_dependency'}),false);
 assert.equal(historyActionAvailable('adopt',{...supported,restoreSupported:false}),true);
 assert.equal(historyActionAvailable('adopt',undefined),false);
});
