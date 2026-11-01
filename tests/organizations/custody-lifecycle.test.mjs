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

// Deferred proof fixture; actual database/provider drain qualification remains separate.
import {custodyLifecycleProof} from '../../apps/server/dist/custody-lifecycle-proof.js';
test('custody proof includes unknown outcomes and queued destination authority',()=>{
 let runtimeSql='',runtimeParameters=[];
 const db={prepare(sql){return {all:()=>[],get(...parameters){
  if(sql.includes('FROM scheduler_runs')){runtimeSql=sql;runtimeParameters=parameters;return {held:1};}
  return undefined;
 }}}};
 const source={checkpointId:'checkpoint',agentIds:['agent'],intent:{executionId:'execution'}};
 const proof=custodyLifecycleProof(db,source,'custody');
 assert.match(runtimeSql,/outcome_unknown/);assert.match(runtimeSql,/agent_activations/);
 assert.match(runtimeSql,/retry_pending/);assert.deepEqual(runtimeParameters,['agent','agent','agent']);
 assert.equal(proof.blockers.includes('Source Agent agent has undrained runtime authority'),true);
});

test('canonical Branch proof replaces audit-only pins and retains actual owner blockers',()=>{
 const db={prepare(sql){return {all:()=>[{name:'branch_commands'}],get:()=>undefined};}};
 const source={checkpointId:'checkpoint',sourceChatId:'chat',agentIds:['agent'],intent:{executionId:'execution'}};
 let received;
 const owner={inspect(exact){received=exact;return {references:[{kind:'admission',ownerId:'owner',key:'admission',sha256:'hash'}],blockers:['participant_cleanup_incomplete:agent']};}};
 const proof=custodyLifecycleProof(db,{...source,boundaryId:'receipt-only'},'custody',owner);
 assert.deepEqual(received,source);
 assert.deepEqual(proof.references,['admission:owner:admission:hash']);
 assert.equal(proof.blockers.includes('participant_cleanup_incomplete:agent'),true);
});
