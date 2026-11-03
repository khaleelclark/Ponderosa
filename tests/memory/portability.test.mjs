import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {rename,access,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
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

test('Assistant startup provisions its Chat memory and a missing established collection is never recreated',async t=>{
 const f=await instance(t);
 const response=await f.app.inject({method:'GET',url:'/api/branches/assistant'});
 assert.equal(response.statusCode,200,response.body);
 const chatId=response.json().app?.chatId;assert.ok(chatId,'default Assistant owns a Chat');
 const raw=f.memory.core.database.raw,names=raw.names('chat:'+chatId);
 for(const name of [names.memory,names.log])assert.ok(await raw.client.getCollection({name}));
 const disabled=await f.app.inject({method:'POST',url:'/api/branches/assistant',payload:{enabled:false}});assert.equal(disabled.statusCode,200,disabled.body);
 const enabled=await f.app.inject({method:'POST',url:'/api/branches/assistant',payload:{enabled:true}});assert.equal(enabled.statusCode,200,enabled.body);
 const newChatId=enabled.json().app?.chatId;assert.ok(newChatId);assert.notEqual(newChatId,chatId);
 for(const name of Object.values(raw.names('chat:'+newChatId)))assert.ok(await raw.client.getCollection({name}));
 await f.reopen();
 const reopened=f.memory.core.database.raw,missing=new Error('The requested resource could not be found');missing.name='ChromaNotFoundError';
 const originalGet=reopened.client.getCollection.bind(reopened.client),originalCreate=reopened.client.createCollection.bind(reopened.client);let creates=0;
 reopened.client.getCollection=async args=>{if(args.name===names.memory)throw missing;return originalGet(args);};
 reopened.client.createCollection=async args=>{creates++;return originalCreate(args);};
 try{await assert.rejects(f.memory.provisionInventory(),error=>error===missing);assert.equal(creates,0,'an established missing collection must remain held');}
 finally{reopened.client.getCollection=originalGet;reopened.client.createCollection=originalCreate;}
});


test('new Chat creation provisions exactly its own memory scope',async t=>{
 const f=await instance(t);
 const result=await f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':randomUUID()},payload:{label:'Fresh memory scope',hostPath:f.root,defaultEngine:'fixture'}});
 assert.equal(result.statusCode,200,result.body);
 const chatId=result.json().id;assert.ok(chatId);
 for(const name of Object.values(f.memory.core.database.raw.names('chat:'+chatId)))assert.ok(await f.memory.core.database.raw.client.getCollection({name}));
 await f.reopen();
});

test('a process-unknown existing Chat never authorizes recreating its missing collection',async t=>{
 const f=await instance(t),memory=f.memory,raw=memory.core.database.raw,names=raw.names('chat:'+f.chat.id);
 const missing=new Error('The requested resource could not be found');missing.name='ChromaNotFoundError';
 const originalGet=raw.client.getCollection.bind(raw.client),originalCreate=raw.client.createCollection.bind(raw.client);let creates=0;
 memory.knownScopes.delete('chat:'+f.chat.id);
 raw.client.getCollection=async args=>{if(args.name===names.memory)throw missing;return originalGet(args);};
 raw.client.createCollection=async args=>{creates++;return originalCreate(args);};
 try{await assert.rejects(memory.provisionInventory(),error=>error===missing);assert.equal(creates,0,'an old scope must not be recreated just because this process has not seen it');}
 finally{raw.client.getCollection=originalGet;raw.client.createCollection=originalCreate;}
});


test('concurrent committed Chats provision only their own new memory scopes',async t=>{
 const f=await instance(t),memory=f.memory,original=memory.provisionNewChat.bind(memory);
 let arrivals=0,release;const both=new Promise(resolve=>{release=resolve;});
 memory.provisionNewChat=async chatId=>{if(++arrivals===2)release();await both;return original(chatId);};
 const create=label=>f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':randomUUID()},payload:{label,hostPath:f.root,defaultEngine:'fixture'}});
 try{
  const responses=await Promise.all([create('Concurrent one'),create('Concurrent two')]);
  for(const response of responses){
   assert.equal(response.statusCode,200,response.body);
   for(const name of Object.values(memory.core.database.raw.names('chat:'+response.json().id)))assert.ok(await memory.core.database.raw.client.getCollection({name}));
  }
  assert.equal(arrivals,2);
 }finally{memory.provisionNewChat=original;}
 await f.reopen();
});

test('a planned new Chat scope survives a lost pre-dispatch response and can safely resume',async t=>{
 const f=await instance(t),memory=f.memory,key=randomUUID(),original=memory.provisionNewChat.bind(memory);
 memory.provisionNewChat=async()=>{throw Error('synthetic pre-dispatch interruption');};
 const request=()=>f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':key},payload:{label:'Planned memory scope',hostPath:f.root,defaultEngine:'fixture'}});
 let first;
 try{first=await request();}finally{memory.provisionNewChat=original;}
 assert.equal(first.statusCode,409,first.body);
 const chatId=first.json().chatId;assert.ok(chatId);assert.equal(first.json().code,'memory_provision_pending');
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'planned',log_state:'planned'});
 await f.reopen();
 const second=await request();assert.equal(second.statusCode,200,second.body);assert.equal(second.json().id,chatId);
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'confirmed',log_state:'confirmed'});
 await f.reopen();
});

test('a submitted but missing Chat collection remains held without another create',async t=>{
 const f=await instance(t),memory=f.memory,client=memory.core.database.raw.client,key=randomUUID(),original=client.createCollection.bind(client);let calls=0;
 client.createCollection=async()=>{calls++;throw Error('synthetic unknown create outcome');};
 const request=()=>f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':key},payload:{label:'Uncertain memory scope',hostPath:f.root,defaultEngine:'fixture'}});
 let first;
 try{first=await request();}finally{client.createCollection=original;}
 assert.equal(first.statusCode,409,first.body);
 const chatId=first.json().chatId;assert.ok(chatId);assert.equal(first.json().code,'memory_provision_pending');
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'submitted',log_state:'planned'});
 const second=await request();assert.equal(second.statusCode,409,second.body);assert.equal(second.json().chatId,chatId);
 assert.equal(calls,1,'uncertain collection creation was not blindly repeated');
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'submitted',log_state:'planned'});
 assert.throws(()=>memory.core.database.assertSourceSettled(),/requires reconciliation/);
});

test('observing a matching created collection does not clear an independent unknown-write hold',async t=>{
 const f=await instance(t),memory=f.memory,client=memory.core.database.raw.client,key=randomUUID(),original=client.createCollection.bind(client);let calls=0;
 client.createCollection=async options=>{calls++;const result=await original(options);if(calls===1)throw Error('synthetic lost create response');return result;};
 const request=()=>f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':key},payload:{label:'Observed memory scope',hostPath:f.root,defaultEngine:'fixture'}});
 let first;
 try{first=await request();}finally{client.createCollection=original;}
 assert.equal(first.statusCode,409,first.body);
 const chatId=first.json().chatId;assert.ok(chatId);
 const second=await request();assert.equal(second.statusCode,200,second.body);assert.equal(second.json().id,chatId);
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'confirmed',log_state:'confirmed'});
 assert.throws(()=>memory.core.database.assertSourceSettled(),/requires reconciliation/,'a matching read is not evidence that the unknown remote write drained');
});


test('a retained memory intent cannot authorize a different Chat owner',async t=>{
 const f=await instance(t),key=randomUUID();
 const response=await f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':key},payload:{label:'Owner binding',hostPath:f.root,defaultEngine:'fixture'}});
 assert.equal(response.statusCode,200,response.body);
 const chatId=response.json().id,memory=f.memory,client=memory.core.database.raw.client,originalCreate=client.createCollection.bind(client);let creates=0;
 f.store.sqlite.prepare("UPDATE local_memory_scope_provisioning SET project_id='foreign-project' WHERE chat_id=?").run(chatId);
 client.createCollection=async (...args)=>{creates++;return originalCreate(...args);};
 try{await assert.rejects(memory.verifyChat(chatId),/does not match current scope and installation/);assert.equal(creates,0);}
 finally{client.createCollection=originalCreate;}
});


test('a missing established memory policy is not recreated even when provisioning is configured',async t=>{
 const f=await instance(t),file=path.join(f.options.localMemory.stateDirectory,'host-policy.sqlite'),saved=file+'.preserved';
 await f.suspend();await rename(file,saved);
 try{
  await assert.rejects(f.resume(),/Established local memory policy is missing/);
  await assert.rejects(access(file),error=>error.code==='ENOENT');
  await access(saved);
 }finally{
  try{f.store.close();}catch{}
  await rename(saved,file);
  await f.resume();
 }
});

test('an unwitnessed upgraded installation does not treat a missing policy as fresh',async t=>{
 const f=await instance(t),file=path.join(f.options.localMemory.stateDirectory,'host-policy.sqlite'),saved=file+'.preserved';
 f.store.sqlite.prepare('DELETE FROM local_memory_host_binding WHERE singleton=1').run();
 await f.suspend();await rename(file,saved);
 try{
  await assert.rejects(f.resume(),/no first-install witness/);
  await assert.rejects(access(file),error=>error.code==='ENOENT');
  await access(saved);
 }finally{
  try{f.store.close();}catch{}
  await rename(saved,file);
  await f.resume();
 }
 assert.equal(f.store.sqlite.prepare('SELECT state FROM local_memory_host_binding WHERE singleton=1').get().state,'bound');
});

test('a foreign host witness refuses before creating a missing memory policy',async t=>{
 const f=await instance(t),file=path.join(f.options.localMemory.stateDirectory,'host-policy.sqlite'),saved=file+'.preserved';
 const witness=f.store.sqlite.prepare('SELECT * FROM local_memory_host_binding WHERE singleton=1').get();
 f.store.sqlite.prepare("UPDATE local_memory_host_binding SET data_generation='foreign-generation' WHERE singleton=1").run();
 await f.suspend();await rename(file,saved);
 try{
  await assert.rejects(f.resume(),/host binding differs/);
  await assert.rejects(access(file),error=>error.code==='ENOENT');await access(saved);
 }finally{
  try{f.store.close();}catch{}
  const Database=(await import('better-sqlite3')).default,db=new Database(path.join(f.dataDir,'ponderosa.db'));
  db.prepare('UPDATE local_memory_host_binding SET data_generation=? WHERE singleton=1').run(witness.data_generation);db.close();
  await rename(saved,file);await f.resume();
 }
});


test('initial global scope planned before dispatch resumes safely after restart',async t=>{
 const f=await instance(t),root=await mkdtemp(path.join(tmpdir(),'memory-first-intent-'));
 const {AgentStore}=await import('@ponderosa/agents'),{LocalMemoryService}=await import('../../apps/server/dist/local-memory.js');
 const store=new AgentStore(path.join(root,'data'));
 const inference={signature:'initial-intent-fixture',async embed(){return Array.from({length:384},(_,i)=>i?0:1);},async rerank(pairs){return pairs.map(()=>1);},async close(){}};
 const options={dataDir:path.join(root,'data'),localMemory:{...f.options.localMemory,collectionPrefix:'first_'+randomUUID().replaceAll('-',''),stateDirectory:path.join(root,'policy'),provision:true}};
 const open=()=>new LocalMemoryService({opts:options,store,capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false},inference);
 let memory=open();
 try{
  assert.deepEqual(store.sqlite.prepare("SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id='global'").get(),{memory_state:'planned',log_state:'planned'});
  const raw=memory.core.database.raw,original=raw.client.getCollection.bind(raw.client);
  raw.client.getCollection=async()=>{throw Error('synthetic pre-dispatch offline');};
  try{await assert.rejects(memory.ready(),/pre-dispatch offline/);}finally{raw.client.getCollection=original;}
  assert.deepEqual(store.sqlite.prepare("SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id='global'").get(),{memory_state:'planned',log_state:'planned'});
  await memory.close();memory=open();await memory.ready();
  assert.deepEqual(store.sqlite.prepare("SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id='global'").get(),{memory_state:'confirmed',log_state:'confirmed'});
 }finally{await memory.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('fresh memory installation refuses an existing same-name collection without modifying it',async t=>{
 const f=await instance(t),root=await mkdtemp(path.join(tmpdir(),'memory-foreign-namespace-'));
 const {AgentStore}=await import('@ponderosa/agents'),{LocalMemoryService}=await import('../../apps/server/dist/local-memory.js');
 const store=new AgentStore(path.join(root,'data'));
 const inference={signature:'foreign-namespace-fixture',async embed(){return Array.from({length:384},(_,i)=>i?0:1);},async rerank(pairs){return pairs.map(()=>1);},async close(){}};
 const options={dataDir:path.join(root,'data'),localMemory:{...f.options.localMemory,collectionPrefix:'foreign_'+randomUUID().replaceAll('-',''),stateDirectory:path.join(root,'policy'),provision:true}};
 const memory=new LocalMemoryService({opts:options,store,capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false},inference);
 const raw=memory.core.database.raw,originalGet=raw.client.getCollection.bind(raw.client),originalCreate=raw.client.createCollection.bind(raw.client);let creates=0;
 raw.client.getCollection=async()=>({metadata:{embedding_signature:raw.signature,dimensions:384,'hnsw:space':'cosine'}});
 raw.client.createCollection=async (...args)=>{creates++;return originalCreate(...args);};
 try{
  await assert.rejects(memory.ready(),/already exists without its exact creation receipt/);assert.equal(creates,0);
  assert.deepEqual(store.sqlite.prepare("SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id='global'").get(),{memory_state:'planned',log_state:'planned'});
 }finally{raw.client.getCollection=originalGet;raw.client.createCollection=originalCreate;await memory.close();store.close();await rm(root,{recursive:true,force:true});}
});
