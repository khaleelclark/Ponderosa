import test from 'node:test';
import assert from 'node:assert/strict';
import {mountedRegressionInventory,mountedRegressionEntryImports} from '../shared/mounted-regression-inventory.mjs';
test('every exported mounted regression module is included in the browser entry exactly once',()=>{
 const inventory=mountedRegressionInventory(),imports=mountedRegressionEntryImports(),names=inventory.flatMap(row=>row.names);
 assert.ok(inventory.length>0,'Mounted fixtures must be discovered');
 assert.deepEqual(imports,inventory.map(row=>row.file),'A newly added mounted fixture must be wired before verification can pass');
 assert.equal(new Set(imports).size,imports.length,'A module cannot be duplicated in the entry');
 assert.equal(new Set(names).size,names.length,'Browser-addressable regression names must be unique');
});

import {runMountedCase} from '../shared/mounted-regression-lifetime.mjs';
test('authored foreign continuation storage and stale-authority paths have explicit browser cases',()=>{
 const entry=mountedRegressionInventory().find(row=>row.file==='tests/chats/branch-foreign-continuation-mounted.tsx');
 assert.deepEqual(entry?.names,['foreignBeforeEntryMissingRegression','foreignBeforeEntryRegression','foreignBeforeEntryTamperedRegression','foreignContinuationQuotaRegression','foreignContinuationRegression','foreignContinuationSecurityRegression','foreignContinuationStaleRegression']);
});
test('a hung case and hung cleanup retain finite evidence and permit the next independent cell',async()=>{
 let stopped=0,next=0;const never=()=>new Promise(()=>{});
 const outcome=await runMountedCase({run:never,stop:()=>{stopped++;},diagnose:never,close:never,timeout:5,cleanupTimeout:5});
 assert.equal(outcome.failure.code,'ERR_MOUNTED_TIMEOUT');assert.equal(outcome.failure.stage,'mounted case');assert.equal(stopped,1);assert.equal(outcome.timedOut,true);
 assert.deepEqual(outcome.secondary.map(row=>row.stage),['failure screenshot','context cleanup']);
 const following=await runMountedCase({run:async()=>{next++;},stop:()=>{},close:async()=>{},timeout:100,cleanupTimeout:100});
 assert.equal(following.failure,undefined);assert.equal(following.secondary.length,0);assert.equal(next,1,'Independent cells are never retried or skipped due to an earlier hung callback');
});
test('diagnostic and cleanup failure cannot replace the exact original mounted assertion',async()=>{
 const primary=Error('original fixture assertion'),cleanup=Error('owned context close failed');
 const outcome=await runMountedCase({run:async()=>{throw primary;},stop:()=>{},diagnose:async()=>{throw Error('screenshot failed');},close:async()=>{throw cleanup;},timeout:100,cleanupTimeout:100});
 assert.equal(outcome.failure,primary);assert.equal(outcome.secondary[1].error,cleanup);assert.equal(outcome.timedOut,false);
});
