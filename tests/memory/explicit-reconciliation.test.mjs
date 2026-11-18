import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {memorySourceMutations} from '../../apps/server/dist/memory-source-mutations.js';
import {beginSourceCapture,releaseSourceCapture} from '../../packages/agents/dist/source-capture-boundary.js';
test('operator reconciliation preserves backend evidence, clears exactly reviewed hold, and never replays writes',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'memory-reconcile-')),db=new Database(':memory:');let writes=0;
 try{
  const mutations=memorySourceMutations(directory),effect={scope:'chat:owned',log:false,operation:'upsert'};
  await assert.rejects(mutations.run(async()=>{writes++;throw Error('unknown backend outcome');},effect));
  const id=mutations.list()[0].id,observe=async()=>({rows:{preserved:'current backend bytes'},rowCount:1});
  const review=await mutations.review(id,observe),input={commandKey:'human-1',reviewSha256:review.reviewSha256,backendDrainEvidence:'Operator observed backend worker drain',preserveCurrentBackend:true};
  const receipt=await mutations.reconcile(id,input,observe);
  assert.equal(writes,1);assert.equal(mutations.list().length,0);mutations.assertSettled();
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory,'reconciled',`${id}.backend.json`),'utf8')),{preserved:'current backend bytes'});
  assert.deepEqual(await mutations.reconcile(id,input,async()=>{throw Error('must not re-read on committed replay');}),receipt);
  const token=beginSourceCapture(db);releaseSourceCapture(token);
  await assert.rejects(mutations.run(async()=>{throw Error('legacy unknown');}));
  const legacy=mutations.list()[0];assert.equal((await mutations.review(legacy.id,observe)).canReconcile,false);
  await assert.rejects(mutations.reconcile(legacy.id,{...input,reviewSha256:(await mutations.review(legacy.id,observe)).reviewSha256},observe),/current memory reconciliation/);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

// Deferred source only; preserve_unknown is a decision receipt, never backend proof.
test('legacy operator disposition survives reopen and retains exact original unknown hold',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'memory-preserve-unknown-')),db=new Database(':memory:');let effects=0;
 try{
  const mutations=memorySourceMutations(directory);
  await assert.rejects(mutations.run(async()=>{effects++;throw Error('legacy remote outcome unknown');}));
  const hold=mutations.list()[0],original=readFileSync(path.join(directory,`${hold.id}.json`));
  const review=await mutations.review(hold.id,async()=>{throw Error('unknown scope must not query a guessed collection');});
  const input={commandKey:'preserve-original',reviewSha256:review.hold.preserveUnknownReviewSha256,reason:'Keep original remote evidence; no completion proof exists',preserveUnknown:true};
  await assert.rejects(mutations.preserveUnknown(hold.id,{...input,reviewSha256:'0'.repeat(64)}),/review/);
  const receipt=await mutations.preserveUnknown(hold.id,input);
  assert.equal(receipt.outcome,'unknown');assert.equal(receipt.held,true);assert.equal(receipt.backendModified,false);assert.equal(receipt.replayed,false);
  assert.deepEqual(readFileSync(path.join(directory,`${hold.id}.json`)),original);
  assert.equal(mutations.list().length,1);assert.equal(mutations.list()[0].state,'unsettled');
  assert.throws(()=>mutations.assertSettled(),/reconciliation/);
  assert.throws(()=>beginSourceCapture(db),/unsettled writer/);
  const reopened=memorySourceMutations(directory);
  assert.deepEqual(reopened.list()[0].disposition,receipt);
  assert.deepEqual(await reopened.preserveUnknown(hold.id,input),receipt);
  await assert.rejects(reopened.preserveUnknown(hold.id,{...input,commandKey:'different'}),/conflict/);
  assert.equal(effects,1);
  await assert.rejects(reopened.run(async()=>{effects++;throw Error('backend unavailable');},{scope:'global',log:false,operation:'upsert'}));
  const known=reopened.list().find(item=>!item.legacy);
  const preservedKnown=await reopened.preserveUnknown(known.id,{...input,commandKey:'preserve-known-unconfirmed',reviewSha256:known.preserveUnknownReviewSha256});
  assert.equal(preservedKnown.held,true);assert.equal(reopened.list().length,2);assert.throws(()=>reopened.assertSettled());
  const receiptFile=path.join(directory,'preserved-unknown',`${hold.id}.json`);
  writeFileSync(receiptFile,JSON.stringify({...receipt,holdSha256:'0'.repeat(64)}));
  assert.throws(()=>reopened.list(),/conflicts/);
  assert.deepEqual(readFileSync(path.join(directory,`${hold.id}.json`)),original);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
