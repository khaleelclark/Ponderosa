import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkpointCustodyLifecycle} from '../../apps/server/dist/checkpoint-custody-lifecycle.js';
test('custody reconciliation requires current reference/drain proof and preserves orphan originals',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'custody-lifecycle-')),id='a'.repeat(64);let references=['branch_commands.result_json'],blockers=[];
 try{
  writeFileSync(path.join(directory,`${id}.payload`),'last original bytes',{mode:0o600});
  const lifecycle=checkpointCustodyLifecycle(directory,()=>({references,blockers}));
  const first=lifecycle.review(id),input={commandKey:'reconcile-1',reviewSha256:first.reviewSha256,preserveEvidence:true};
  assert.throws(()=>lifecycle.reconcile(id,input),/unreferenced/);
  references=[];blockers=['undrained runtime'];assert.throws(()=>lifecycle.reconcile(id,{...input,reviewSha256:lifecycle.review(id).reviewSha256}),/drain/);
  blockers=[];const current=lifecycle.review(id);assert.throws(()=>lifecycle.reconcile(id,input),/review/);
  const command={...input,reviewSha256:current.reviewSha256},receipt=lifecycle.reconcile(id,command);
  assert.equal(readFileSync(path.join(receipt.evidenceDirectory,`${id}.payload`),'utf8'),'last original bytes');
  assert.equal(existsSync(path.join(directory,`${id}.payload`)),false);
  assert.deepEqual(lifecycle.reconcile(id,command),receipt);
  assert.equal(lifecycle.review(id).state,'reconciled');
  assert.throws(()=>lifecycle.reconcile(id,{...command,commandKey:'changed'}),/conflict/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
