import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {memorySourceMutations} from '../../apps/server/dist/memory-source-mutations.js';
import {beginSourceCapture,assertSourceCapture,releaseSourceCapture} from '../../packages/agents/dist/source-capture-boundary.js';
test('remote writes invalidate capture and failed settlement remains held across restart',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'memory-source-')),db=new Database(':memory:');
  try{
    const mutations=memorySourceMutations(directory),cut=beginSourceCapture(db);
    let settle;const pending=mutations.run(()=>new Promise(resolve=>{settle=resolve;}));
    assert.throws(()=>assertSourceCapture(cut),/source changed/);
    assert.throws(()=>mutations.assertSettled(),/reconciliation/);
    settle();await pending;mutations.assertSettled();releaseSourceCapture(cut);
    await assert.rejects(mutations.run(async()=>{throw Error('lost remote outcome');}),/lost remote outcome/);
    assert.throws(()=>memorySourceMutations(directory).assertSettled(),/reconciliation/);
  }finally{db.close();await rm(directory,{recursive:true,force:true});}
});
