import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {resourceInspectionMatches,resourceReleaseInput,resourceReleaseMatches} from '../../apps/web/src/components/branches/branchResourceReview.ts';
const inspection={branchId:'branch',executionId:'run',stepExecutionId:'step',generation:3,custody:{kind:'capture',state:'retained',custodyId:'custody',receiptSha256:'FULL-receipt-hash',packageSha256:'package-hash'}};
test('resource inspection checks exact owner and actual resource generation',()=>{
 assert.equal(resourceInspectionMatches(inspection,'branch','run','step'),true);
 assert.equal(resourceInspectionMatches({...inspection,executionId:'other'},'branch','run','step'),false);
 assert.equal(resourceInspectionMatches({...inspection,generation:NaN},'branch','run','step'),false);
});
test('only retained local capture produces release input; full receipt hash remains opaque',()=>{
 assert.deepEqual(resourceReleaseInput(inspection,'command'),{commandKey:'command',expectedGeneration:3,expectedCustodyId:'custody',expectedReceiptSha256:'FULL-receipt-hash'});
 for(const custody of [null,{...inspection.custody,kind:'restoration_source'},{...inspection.custody,state:'releasing'},{...inspection.custody,receiptSha256:null}])assert.equal(resourceReleaseInput({...inspection,custody},'command'),undefined);
});
test('release readback must match the entire original identity even after newer inspection',()=>{
 const input=resourceReleaseInput(inspection,'command');
 const receipt={commandKey:'command',stepExecutionId:'step',generation:3,custodyId:'custody',receiptSha256:'FULL-receipt-hash',state:'released'};
 assert.equal(resourceReleaseMatches(receipt,input,'step'),true);
 for(const changed of [{generation:4},{custodyId:'new'},{receiptSha256:'package-hash'},{commandKey:'other'},{stepExecutionId:'other'}])assert.equal(resourceReleaseMatches({...receipt,...changed},input,'step'),false);
 assert.equal(resourceReleaseMatches({commandKey:'command',state:'not_found'},input,'step'),true);
 assert.equal(resourceReleaseMatches(receipt,resourceReleaseInput({...inspection,generation:4},'command'),'step'),false);
});
