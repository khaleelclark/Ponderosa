import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {instance,seed,read,vector} from './portability-fixture.mjs';
import {validateMemorySnapshot,MEMORY_SNAPSHOT_MAX_BYTES} from '../../apps/server/dist/portable-memory-snapshot.js';

for(const branch of [false,true])test(`fresh ${branch?'Branches':'Core'} private memory services restore lineage, vectors, conflicts and audiences; reopen/re-export keeps denied scope denied`,async t=>{
 const source=await instance(t,branch),destination=await instance(t,branch);await seed(source);
 source.memory.setGrant(source.chat.id,true,0,branch?'branches':'dev');
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]);
 assert.equal(snapshot.chunks.length,3);assert.equal(snapshot.conflicts.length,1);assert.deepEqual(snapshot.excludedScopes,['global']);assert.doesNotMatch(JSON.stringify(snapshot),/EXCLUDED_PRIVATE_FACT|EXCLUDED_GLOBAL_FACT/);
 const key=randomUUID(),mapping={[source.a.id]:destination.a.id};
 const receipt=await destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key);
 assert.deepEqual(await destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key),receipt);
 assert.notEqual(source.memory.principalId,destination.memory.principalId);
 const visible=await read(destination,destination.a.id);assert.equal(visible.length,3);assert.deepEqual(visible.map(r=>r.text).sort(),snapshot.chunks.map(r=>r.text).sort());
 for(const row of visible){assert.deepEqual(row.embedding,vector);const stamp=JSON.parse(row.metadata.host_source_authority);assert.equal(stamp.principal,destination.memory.principalId);assert.equal(stamp.ownerChat,destination.chat.id);assert.equal(stamp.provenance.actor.id,destination.memory.principalId);assert.match(stamp.provenance.runId,/^package-import:/);assert.equal(stamp.origin.runId,'source-not-a-live-run');}
 const child=visible.find(r=>r.text==='Revised seeded team fact 😀');assert.equal(visible.find(r=>r.id===child.metadata.supersedes).metadata.deprecated,true);
 assert.equal((await read(destination,destination.b.id)).length,2,'peer sees team only');
 assert.deepEqual(await read(destination,destination.a.id,false,false),[],'denied read authority stays denied');
 assert.equal(destination.memory.getGrant(destination.chat.id,branch?'branches':'dev').readGlobal,false);
 for(const table of ['scheduler_runs','agent_activations','provider_operation_outbox'])assert.equal(destination.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 const before=await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]);
 const references=JSON.parse(before.conflicts[0].metadata.chunk_ids);assert.ok(references.every(id=>before.chunks.some(r=>r.id===id)));
 await destination.reopen();const after=await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]);assert.deepEqual(after,before);
 assert.equal((await read(destination,destination.b.id)).length,2);assert.equal(destination.memory.getGrant(destination.chat.id,branch?'branches':'dev').readGlobal,false);
 assert.equal((await read(destination,destination.a.id)).some(r=>r.text==='EXCLUDED_GLOBAL_FACT'),false);
});
test('malformed, oversized and incompatible snapshots fail before any destination write',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),mapping={[source.a.id]:destination.a.id};
 for(const mutate of [s=>s.schema='ponderosa.chat-memory.v999',s=>s.signature='other-model',s=>s.grants={readGlobal:true},s=>s.chunks[0].embedding=[0],s=>s.chunks[0].stamp.audience='installation-global',s=>s.chunks[0].metadata.supersedes=s.chunks[0].id,s=>s.conflicts[0].metadata.chunk_ids_affected='["missing"]',s=>s.chunks[0].metadata.api_key='synthetic-secret',s=>s.chunks[0].text='x'.repeat(MEMORY_SNAPSHOT_MAX_BYTES)]){
  const invalid=structuredClone(snapshot);mutate(invalid);await assert.rejects(destination.memory.restorePackageMemory(invalid,destination.chat.id,mapping,randomUUID()),/Memory snapshot:/);assert.equal((await read(destination,destination.a.id)).length,0);
 }
 await assert.rejects(destination.memory.restorePackageMemory(snapshot,destination.chat.id,{},randomUUID()),/mapping/);
 assert.throws(()=>validateMemorySnapshot({...snapshot,chunks:Array(10001).fill(snapshot.chunks[0])}),/row limit|byte limit/);
});
test('controlled partial write compensates only new package rows and retry preserves pre-existing memory',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);await seed(destination);
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),before=await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]),mapping={[source.a.id]:destination.a.id};
 const raw=destination.memory.core.database.raw,original=raw.client.getCollection.bind(raw.client);let count=0,fail=true;
 raw.client.getCollection=async args=>{const c=await original(args),upsert=c.upsert.bind(c);c.upsert=async input=>{if(fail&&++count===2)throw Error('Controlled package Chroma failure');return upsert(input);};return c;};
 const key=randomUUID();await assert.rejects(destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key),/Controlled package Chroma failure/);
 assert.deepEqual(await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]),before);
 fail=false;await destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key);assert.equal((await read(destination,destination.a.id)).length,6);
 const changed=structuredClone(snapshot);changed.chunks[0].text='Never overwrite existing row';await assert.rejects(destination.memory.restorePackageMemory(changed,destination.chat.id,mapping,key),/collision/);assert.equal((await read(destination,destination.a.id)).some(r=>r.text==='Never overwrite existing row'),false);
});

for(const kind of ['chunks','conflicts'])test(`float32-underflow ${kind} refuse restore before writes while stored nonzero vectors roundtrip`,async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);await seed(destination);
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),before=await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]),mapping={[source.a.id]:destination.a.id};
 const raw=destination.memory.core.database.raw,original=raw.client.getCollection.bind(raw.client);let writes=0;
 raw.client.getCollection=async args=>{const c=await original(args),upsert=c.upsert.bind(c);c.upsert=async input=>{writes++;return upsert(input);};return c;};
 for(const component of [1e-50,-1e-50,0,1e39]){
  const invalid=structuredClone(snapshot);invalid[kind][0].embedding=Array.from({length:384},(_,i)=>i===0?component:0);
  await assert.rejects(destination.memory.restorePackageMemory(invalid,destination.chat.id,mapping,randomUUID()),/Memory snapshot:.*vector/);
 }
 assert.equal(writes,0,'reject stored-zero vectors before any Chroma upsert');
 assert.deepEqual(await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]),before,'pre-existing destination remains readable and unchanged');
 const legitimate=structuredClone(snapshot),stored=Array.from({length:384},(_,i)=>i<4?(i%2?-0.5:0.5):0);
 for(const row of [...legitimate.chunks,...legitimate.conflicts])row.embedding=[...stored];
 const receipt=await destination.memory.restorePackageMemory(legitimate,destination.chat.id,mapping,randomUUID());
 assert.equal(receipt.chunkIds.length,snapshot.chunks.length);assert.equal(receipt.conflictIds.length,snapshot.conflicts.length);assert.ok(writes>0);
 const restored=await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]);
 for(const [rows,ids] of [[restored.chunks,receipt.chunkIds],[restored.conflicts,receipt.conflictIds]]){
  const imported=rows.filter(row=>ids.includes(row.id));assert.equal(imported.length,ids.length);
  for(const row of imported)assert.deepEqual(row.embedding,stored,'legitimate stored float32 components remain exact');
 }
 await destination.reopen();assert.deepEqual(await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]),restored);
});

test('natural local embedding export retries exactly before and after reopen; changed vectors and content collide',async t=>{
 const source=await instance(t),destination=await instance(t);
 await seed(source,await source.memory.core.inference.embed('A small blue boat crosses a quiet lake.'));
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),mapping={[source.a.id]:destination.a.id},key=randomUUID();
 const receipt=await destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key);
 const canonical=s=>({...s,chunks:[...s.chunks].sort((a,b)=>a.id.localeCompare(b.id)),conflicts:[...s.conflicts].sort((a,b)=>a.id.localeCompare(b.id))});
 const restored=await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]);
 for(const [rows,original,ids] of [[restored.chunks,snapshot.chunks,receipt.chunkIds],[restored.conflicts,snapshot.conflicts,receipt.conflictIds]])for(let i=0;i<ids.length;i++)assert.deepEqual(rows.find(r=>r.id===ids[i]).embedding,original[i].embedding);
 assert.deepEqual(await destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key),receipt);
 await destination.reopen();assert.deepEqual(canonical(await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id])),canonical(restored));
 assert.deepEqual(await destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key),receipt);
 for(const kind of ['chunks','conflicts'])for(const field of ['embedding','text']){
  const changed=structuredClone(snapshot);if(field==='embedding'){const component=new Float32Array([changed[kind][0].embedding[0]]);new Uint32Array(component.buffer)[0]++;changed[kind][0].embedding[0]=component[0];}else changed[kind][0].text+=' changed';
  await assert.rejects(destination.memory.restorePackageMemory(changed,destination.chat.id,mapping,key),/collision/);
 }
 assert.deepEqual(canonical(await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id])),canonical(restored));
});
