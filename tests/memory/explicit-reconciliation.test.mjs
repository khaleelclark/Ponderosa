import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
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
