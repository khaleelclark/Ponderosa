import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {AuthorityStorage} from '../../apps/server/dist/local-memory-authority.js';
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

test('an exact memory read uses only the authorized target and bound ancestors',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'memory-exact-read-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const scope='chat:owned',signature='fixture-embedding',reads=[];
 const provenance={actor:{kind:'agent',id:'member'},runId:'fixture-run',fenceToken:'1',at:'2026-11-01T00:00:00.000Z'};
 const metadata=(id,audience,supersedes)=>({
  source_type:'ai_inference', deprecated:false, confidence:0.9, ...(supersedes?{supersedes}:{}),
  host_source_authority:JSON.stringify({format:1,principal:'fixture',id,scope,ownerChat:'owned',audience,
   sourceType:'ai_inference',provenance,origin:provenance}),
 });
 const rows=new Map([
  ['parent',metadata('parent',scope+':team')],
  ['revision',metadata('revision',scope+':team','parent')],
  ['foreign',metadata('foreign',scope+':agent:other')],
  ['blocked',metadata('blocked',scope+':team','foreign')],
 ]);
 const collection={
  id:'fixture-collection',metadata:{'hnsw:space':'cosine',embedding_signature:signature,dimensions:384},
  get:async({ids})=>{
   assert.equal(ids.length,1,'exact lookup cannot inventory the collection');
   reads.push(ids[0]);
   const existing=ids.filter(id=>rows.has(id));
   return {ids:existing,metadatas:existing.map(id=>rows.get(id)),documents:existing.map(id=>id),
    embeddings:existing.map(()=>[1,...Array(383).fill(0)])};
  },
 };
 const raw={options:{url:'http://127.0.0.1:1'},signature,exclusive:work=>work(),
  names:()=>({memory:'fixture-memory'}),client:{getCollection:async()=>collection}};
 const memory=new AuthorityStorage(raw,'fixture',{},directory);
 const authority={chatId:'owned',actor:provenance.actor,runId:'reader',fenceToken:'2',
  sourceType:'ai_inference',readChat:true,readGlobal:false,guard:async()=>{}};
 const read=id=>memory.run(authority,()=>memory.get(id,[scope]),id);
 assert.equal((await read('revision')).text,'revision');
 assert.deepEqual(reads,['revision','parent','revision','revision']);
 assert.equal(await read('blocked'),null,'a private foreign ancestor invalidates the lineage');
 assert.equal(await read('missing'),null);
});
