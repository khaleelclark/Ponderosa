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
import {settledCanvasResizeDiagnostics} from '../shared/canvas-resize-diagnostics.mjs';
test('native deferred-resize classification preserves application errors, ongoing resize failures and raw evidence',()=>{
 const message='ResizeObserver loop completed with undelivered notifications.',url='http://127.0.0.1:1234/';
 const args={browser:'webkit',name:'workflowVisibleConnectionsRegression',url,pageErrors:[message],pageErrorCountAtProof:1,diagnostics:{name:'workflowVisibleConnectionsRegression',documentUrl:url,rejections:0,overflow:false,errors:[{message,isTrusted:true,filename:url,line:0,column:0,errorNull:true,at:80}],proof:{checkpoint:'workflow-fit',started:0,quietSince:100,finished:400,frames:10,nativeCount:1,busy:false,nodes:Array.from({length:3},(_,id)=>({id,x:0,y:0,width:200,height:56})),paths:['M0 0L0 1','M1 0L1 1']},after:{checkpoint:'after-unmount',started:410,quietSince:420,finished:700,frames:10,nativeCount:1,busy:false,nodes:[],paths:[]}}};
 const before=structuredClone(args);assert.equal(settledCanvasResizeDiagnostics(args),true);assert.deepEqual(args,before,'Classification never erases raw errors');
 for(const [reason,change] of [
  ['other browser',a=>a.browser='chromium'],['other case',a=>a.name='unrelated'],['another document',a=>a.url+='other'],
  ['application exception',a=>a.diagnostics.errors[0].errorNull=false],['synthetic event',a=>a.diagnostics.errors[0].isTrusted=false],['script location',a=>a.diagnostics.errors[0].line=1],
  ['different native error',a=>a.diagnostics.errors[0].message='Application failed'],['other Playwright error',a=>a.pageErrors.push('Application failed')],['rejection',a=>a.diagnostics.rejections++],
  ['missing proof',a=>delete a.diagnostics.proof],['wrong checkpoint',a=>a.diagnostics.proof.checkpoint='earlier'],['short quiet interval',a=>a.diagnostics.proof.finished=200],
  ['deadline exceeded',a=>a.diagnostics.proof.finished=2100],['unsettled layout',a=>a.diagnostics.proof.busy=true],['missing node',a=>a.diagnostics.proof.nodes.pop()],['missing edge',a=>a.diagnostics.proof.paths.pop()],
  ['invisible node',a=>a.diagnostics.proof.nodes[0].width=0],['nonfinite node',a=>a.diagnostics.proof.nodes[0].height=NaN],['late native warning',a=>a.diagnostics.errors[0].at=450],
  ['new warning after proof',a=>a.diagnostics.errors.push({...a.diagnostics.errors[0],at:450})],['missing cleanup proof',a=>delete a.diagnostics.after],['remaining rendered node',a=>a.diagnostics.after.nodes.push(a.diagnostics.proof.nodes[0])],['overflow',a=>a.diagnostics.overflow=true],
 ]){const invalid=structuredClone(args);change(invalid);assert.equal(settledCanvasResizeDiagnostics(invalid),false,reason);}
 const coalesced=structuredClone(args);coalesced.diagnostics.errors=Array.from({length:6},()=>({...args.diagnostics.errors[0]}));coalesced.diagnostics.proof.nativeCount=6;coalesced.diagnostics.after.nativeCount=6;
 assert.equal(settledCanvasResizeDiagnostics(coalesced),true,'Native events may coalesce in Playwright');
 coalesced.pageErrors.push(message);assert.equal(settledCanvasResizeDiagnostics(coalesced),false,'Any pageerror after the proof barrier fails, even when it has the same text');
});
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
