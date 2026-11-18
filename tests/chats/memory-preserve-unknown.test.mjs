// Deferred source fixtures; execution requires separate authorization.
import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {memoryPreserveCommandValid,memoryPreserveHoldValid,memoryPreserveReceiptMatches,restoreMemoryPreserveCommand} from '../../apps/web/src/components/lifecycle/memoryPreserveUnknown.ts';
const command={id:'original',holdSha256:'a'.repeat(64),body:{commandKey:'saved-key',reviewSha256:'b'.repeat(64),reason:'Completion cannot be verified',preserveUnknown:true}};
const receipt={version:1,id:command.id,holdSha256:command.holdSha256,commandKey:command.body.commandKey,reviewSha256:command.body.reviewSha256,reason:command.body.reason,operatorId:'local-operator',disposition:'preserve_unknown',outcome:'unknown',held:true,replayed:false,backendModified:false};
const hold={id:command.id,sha256:command.holdSha256,preserveUnknownReviewSha256:command.body.reviewSha256,legacy:true,state:'unsettled'};
test('inventory-only legacy and known-effect unavailable holds use distinct verbatim preserve hash',()=>{
 assert.equal(memoryPreserveHoldValid(hold,hold.id),true);
 assert.equal(memoryPreserveHoldValid({...hold,legacy:false,effect:{scope:'collection',operation:'upsert',log:false}},hold.id),true);
 for(const patch of [{state:'reconciled'},{sha256:'bad'},{preserveUnknownReviewSha256:undefined},{id:'substitute'},{disposition:null}])assert.equal(memoryPreserveHoldValid({...hold,...patch},hold.id),false);
 assert.equal(memoryPreserveHoldValid({...hold,disposition:receipt},hold.id),true);
 assert.equal(memoryPreserveHoldValid({...hold,disposition:{...receipt,reviewSha256:'c'.repeat(64)}},hold.id),false);
});
test('exact disposition cannot claim completion, release, replay or backend mutation',()=>{
 assert.equal(memoryPreserveReceiptMatches(command,receipt),true);
 for(const patch of [{id:'other'},{holdSha256:'c'.repeat(64)},{commandKey:'new'},{reviewSha256:'c'.repeat(64)},{reason:'Changed operator reason'},{version:2},{operatorId:'other'},{disposition:'reconciled'},{outcome:'completed'},{held:false},{replayed:true},{backendModified:true}])assert.equal(memoryPreserveReceiptMatches(command,{...receipt,...patch}),false);
});
test('saved input corruption and wrong scope hold new commands instead of resetting',()=>{
 const original=globalThis.localStorage;
 try{
  for(const bytes of ['{broken',JSON.stringify({...command,id:'other'}),JSON.stringify({...command,body:{...command.body,reviewSha256:'ordinary-review'}}),JSON.stringify({...command,body:{...command.body,reason:'short'}}),JSON.stringify({...command,body:{...command.body,preserveUnknown:false}})]){
   globalThis.localStorage={getItem:()=>bytes};assert.ok(restoreMemoryPreserveCommand('key',command.id).error);
  }
  globalThis.localStorage={getItem:()=>JSON.stringify(command)};assert.deepEqual(restoreMemoryPreserveCommand('key',command.id).command,command);
  globalThis.localStorage={getItem:()=>null};assert.deepEqual(restoreMemoryPreserveCommand('key',command.id),{});
  assert.equal(memoryPreserveCommandValid({...command,body:{...command.body,backendDrainEvidence:'invented'}},command.id),false);
 }finally{if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original;}
});
