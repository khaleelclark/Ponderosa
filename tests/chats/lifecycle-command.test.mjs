// Deferred source regression; execution is not authorized for this handoff.
import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {lifecycleReceiptMatches,restoreLifecycleCommand} from '../../apps/web/src/components/lifecycle/lifecycleCommand.ts';
test('destination approval and retirement are separate exact command receipts',()=>{
 const body={commandKey:'key',expectedReviewHash:'review',releaseSourcePins:false,authorizeDeletedOwner:true};
 const command={id:'admission',path:'destination',action:'approve',body};
 const approval={admissionId:'admission',reviewHash:'review',choice:{authorizeDeletedOwner:true,releaseSourcePins:false,expectedReviewHash:'review',commandKey:'key'}};
 assert.equal(lifecycleReceiptMatches(command,approval),true);
 assert.equal(lifecycleReceiptMatches({...command,action:'retire'},approval),false);
 const receipt={admissionId:'admission',reviewHash:'review',commandKey:'key',releasedSourcePins:false,retiredAt:'now'};
 assert.equal(lifecycleReceiptMatches({...command,action:'retire'},receipt),true);
 for(const patch of [{admissionId:'other'},{reviewHash:'other'},{commandKey:'new'},{releasedSourcePins:true}])assert.equal(lifecycleReceiptMatches({...command,action:'retire'},{...receipt,...patch}),false);
});
test('memory/custody/import/capture receipt identity cannot substitute for another hold',()=>{
 const memory={id:'hold',path:'memory',action:'reconcile',body:{commandKey:'key',reviewSha256:'review',backendDrainEvidence:'Observed stopped worker',preserveCurrentBackend:true}};
 const receipt={id:'hold',commandKey:'key',reviewSha256:'review',backendDrainEvidence:'Observed stopped worker',backendSha256:'backend',state:'reconciled'};
 assert.equal(lifecycleReceiptMatches(memory,receipt),true);
 assert.equal(lifecycleReceiptMatches(memory,{...receipt,id:'other'}),false);
 assert.equal(lifecycleReceiptMatches(memory,{...receipt,backendDrainEvidence:'Invented proof'}),false);
 const imported={id:'import',action:'reconcile',body:{commandKey:'key',reviewSha256:'review',action:'preserve_unresolved',note:'Unknown effects'}};
 assert.equal(lifecycleReceiptMatches(imported,{operationId:'import',commandKey:'key',reviewSha256:'review',state:'preserved_unresolved'}),true);
 assert.equal(lifecycleReceiptMatches(imported,{operationId:'import',commandKey:'key',reviewSha256:'review',state:'retired'}),false);
 const custody={id:'custody',action:'reconcile',body:{commandKey:'key',reviewSha256:'review',preserveEvidence:true}};
 assert.equal(lifecycleReceiptMatches(custody,{custodyId:'custody',commandKey:'key',reviewSha256:'review',filesSha256:'inventory',state:'reconciled'}),true);
 assert.equal(lifecycleReceiptMatches(custody,{...receipt,id:'custody'}),false);
 const capture={id:'custody',action:'abandon',body:{source:{checkpointId:'cut'},captureKey:'original',commandKey:'key',reviewSha256:'review',preserveEvidence:true}};
 assert.equal(lifecycleReceiptMatches(capture,{custodyId:'custody',commandKey:'key',reviewSha256:'review',state:'abandoned'}),true);
});
test('Branch retirement compares exact source, CAS and selected hashes despite object key order',()=>{
 const body={source:{checkpointId:'cut'},commandKey:'key',expectedRevision:'revision',checkpoints:[{id:7,sha256:'hash'}]};
 const command={id:'custody',action:'retire-checkpoints',body};
 const receipt={schema:'branch-custody-checkpoint-retirement.v1',custodyId:'custody',state:'retired',input:{commandKey:'key',expectedRevision:'revision',checkpoints:[{sha256:'hash',id:7}],source:{checkpointId:'cut'}}};
 assert.equal(lifecycleReceiptMatches(command,receipt),true);
 assert.equal(lifecycleReceiptMatches(command,{...receipt,input:{...receipt.input,expectedRevision:'new'}}),false);
});

test('unreadable retained commands hold new mutations instead of silently resetting',()=>{
 const original=globalThis.localStorage;
 try{
  globalThis.localStorage={getItem:()=>'{broken'};
  assert.ok(restoreLifecycleCommand('scope').error);
  globalThis.localStorage={getItem:()=>JSON.stringify({id:'id',path:'path',action:'reconcile',body:{commandKey:'original'}})};
  assert.equal(restoreLifecycleCommand('scope').command.body.commandKey,'original');
  globalThis.localStorage={getItem:()=>null};assert.deepEqual(restoreLifecycleCommand('scope'),{});
 }finally{if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original;}
});
