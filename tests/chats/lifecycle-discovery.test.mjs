// Deferred source; no execution authorized.
import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {lifecycleDiscoveryPage} from '../../apps/web/src/components/lifecycle/lifecycleDiscovery.ts';
test('cursor pages preserve one exact revision through more than fifty identities',()=>{
 const first={revision:'original',items:Array.from({length:50},(_,i)=>({operationId:String(i)})),nextCursor:'opaque & cursor'};
 const second={revision:'original',items:[{operationId:'50'}]};
 assert.equal(lifecycleDiscoveryPage(first).nextCursor,'opaque & cursor');
 assert.equal(lifecycleDiscoveryPage(second,first.revision).items[0].operationId,'50');
 assert.throws(()=>lifecycleDiscoveryPage({...second,revision:'changed'},first.revision),/restart/);
 for(const patch of [{revision:''},{items:null},{items:Array(101).fill({})},{nextCursor:''},{unverifiedEvidenceCount:-1}])assert.throws(()=>lifecycleDiscoveryPage({...first,...patch}),/restart/);
});
