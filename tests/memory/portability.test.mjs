import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {rename,access,mkdtemp,mkdir,rm,writeFile,readFile,copyFile,unlink,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {instance,seed,read,vector} from './portability-fixture.mjs';
import {validateMemorySnapshot,MEMORY_SNAPSHOT_MAX_BYTES} from '../../apps/server/dist/portable-memory-snapshot.js';
import {MEMORY_CLEANUP_PROVISION_HOLD,MEMORY_CLEANUP_UNKNOWN_HOLD,isMemoryCleanupHold} from '../../apps/server/dist/local-memory-authority.js';

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
for(const intent of ['confirmed','legacy'])test(`package restore never recreates a missing ${intent} Chat collection`,async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),mapping={[source.a.id]:destination.a.id};
 const raw=destination.memory.core.database.raw,scope='chat:'+destination.chat.id,names=raw.names(scope);
 if(intent==='legacy')destination.store.sqlite.prepare('DELETE FROM local_memory_scope_provisioning WHERE chat_id=?').run(destination.chat.id);
 else assert.deepEqual(destination.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(destination.chat.id),{memory_state:'confirmed',log_state:'confirmed'});
 const originalGet=raw.client.getCollection.bind(raw.client),originalCreate=raw.client.createCollection.bind(raw.client);let creates=0;
 const missing=new Error('The requested resource could not be found');missing.name='ChromaNotFoundError';
 raw.client.getCollection=async args=>{if(args.name===names.memory)throw missing;return originalGet(args);};
 raw.client.createCollection=async args=>{creates++;return originalCreate(args);};
 try{
  await assert.rejects(destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,randomUUID()),error=>error===missing);
  await assert.rejects(destination.memory.core.database.rollbackPackageMemory({chatId:destination.chat.id,chunkIds:['synthetic-owned-row'],conflictIds:[]},randomUUID(),async()=>{}),/Memory cleanup held/);
  await assert.rejects(destination.memory.core.database.purge(scope,async()=>{}),error=>error===missing);
  assert.equal(creates,0,'existing missing data must never be recreated');
 }
 finally{raw.client.getCollection=originalGet;raw.client.createCollection=originalCreate;}
});

for(const change of ['missing','replaced','same-token-new-id','incompatible'])for(const kind of ['memory','log'])test(`confirmed ${kind} collection ${change} after startup stays held`,async t=>{
 const f=await instance(t),raw=f.memory.core.database.raw,scope='chat:'+f.chat.id,name=raw.names(scope)[kind];
 const originalGet=raw.client.getCollection.bind(raw.client),originalCreate=raw.client.createCollection.bind(raw.client);let creates=0;
 const missing=new Error('The requested resource could not be found');missing.name='ChromaNotFoundError';
 raw.client.getCollection=async args=>{
  if(args.name!==name)return originalGet(args);
  if(change==='missing')throw missing;
  const collection=await originalGet(args);
  return new Proxy(collection,{get(target,key){if(key==='id'&&change==='same-token-new-id')return randomUUID();if(key==='metadata')return change==='incompatible'?{...target.metadata,dimensions:42}:change==='same-token-new-id'?target.metadata:{...target.metadata,ponderosa_provision_intent:'foreign-collection'};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 };
 raw.client.createCollection=async args=>{creates++;return originalCreate(args);};
 try{
  await assert.rejects(f.memory.exportPackageMemory(f.chat.id,[f.a.id]),change==='missing'?error=>error===missing:change==='incompatible'?/Incompatible memory collection binding/:/does not match its retained creation identity/);
  const response=await f.app.inject({method:'GET',url:'/api/local-memory/provisioning-holds',headers:f.headers});assert.equal(response.statusCode,200,response.body);
  assert.ok(response.json().some(row=>row.chatId===f.chat.id&&row.reason.includes('unavailable or conflicts')));
  await assert.rejects(f.memory.exportPackageMemory(f.chat.id,[f.a.id]),/Existing Chat memory is missing/);
  assert.equal(creates,0,'a missing or replaced confirmed collection is never recreated');
 }finally{raw.client.getCollection=originalGet;raw.client.createCollection=originalCreate;}
});

test('inventory holds a replaced confirmed collection without stopping other scopes',async t=>{
 const f=await instance(t),raw=f.memory.core.database.raw,scope='chat:'+f.chat.id,name=raw.names(scope).memory;
 const originalGet=raw.client.getCollection.bind(raw.client),originalCreate=raw.client.createCollection.bind(raw.client);let creates=0;
 raw.client.getCollection=async args=>{
  const collection=await originalGet(args);
  if(args.name!==name)return collection;
  return new Proxy(collection,{get(target,key){if(key==='metadata')return {...target.metadata,ponderosa_provision_intent:'foreign-collection'};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 };
 raw.client.createCollection=async args=>{creates++;return originalCreate(args);};
 try{
  await f.memory.provisionInventory();
  assert.ok(f.memory.provisioningHolds().some(row=>row.chatId===f.chat.id&&row.memoryState==='unknown'));
  assert.equal(creates,0);
  assert.ok(await originalGet({name:raw.names('global').memory}),'unrelated global collection remains available');
 }finally{raw.client.getCollection=originalGet;raw.client.createCollection=originalCreate;}
});

test('package import preserves an independently inserted record at the same ID',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),mapping={[source.a.id]:destination.a.id};
 const raw=destination.memory.core.database.raw,original=raw.client.getCollection.bind(raw.client);let raced;
 raw.client.getCollection=async args=>{
  const c=await original(args),add=c.add.bind(c);
  c.add=async input=>{
   if(!raced){
    raced={id:input.ids[0],name:args.name,text:'Independent synthetic record'};
    await add({...input,documents:[raced.text],metadatas:[{...input.metadatas[0],independent_fixture:'preserve'}]});
   }
   return add(input);
  };return c;
 };
 try{
  await assert.rejects(destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,randomUUID()),/Memory cleanup held|collision|already exists/i);
  assert.ok(raced);
  const c=await original({name:raced.name}),current=await c.get({ids:[raced.id],include:['documents','metadatas']});
  assert.deepEqual(current.ids,[raced.id]);assert.equal(current.documents[0],raced.text);assert.equal(current.metadatas[0].independent_fixture,'preserve');
 }finally{raw.client.getCollection=original;}
});

test('an uncertain package write retains staged rows and blocks cleanup until reconciliation',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);await seed(destination);
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),mapping={[source.a.id]:destination.a.id};
 const raw=destination.memory.core.database.raw,original=raw.client.getCollection.bind(raw.client);let writes=0,deletes=0;
 raw.client.getCollection=async args=>{const c=await original(args),add=c.add.bind(c),remove=c.delete.bind(c);c.add=async input=>{if(++writes===2)throw Error('Controlled package Chroma failure');return add(input);};c.delete=async input=>{deletes++;return remove(input);};return c;};
 const key=randomUUID();
 try{
  await assert.rejects(destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key),/Memory cleanup held/);
  assert.equal(deletes,0,'no compensation follows an uncertain remote write');
  assert.ok(destination.memory.core.database.listMutationHolds().some(hold=>hold.effect?.scope==='chat:'+destination.chat.id));
  await assert.rejects(destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]),/unsettled remote write/);
  await assert.rejects(destination.memory.restorePackageMemory(snapshot,destination.chat.id,mapping,key),/unsettled remote write/);
 }finally{raw.client.getCollection=original;}
});

test('memory HTTP errors identify invalid fields and keep revoked capabilities denied',async t=>{
 const f=await instance(t),ports=f.memory.ports,at=new Date().toISOString(),lease=new Date(Date.now()+60000).toISOString(),run='memory-validation-'+randomUUID(),token='owned-memory-validation-'+randomUUID();
 f.store.sqlite.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'running','owned',?,1,'injected',?,?,?,?)").run(run,f.project.id,f.a.id,lease,at,at,at,'conversation:'+f.chat.id);
 const originalOwnsRun=ports.ownsRun,controller=new AbortController();
 ports.capabilities.set(token,{agentId:f.a.id,conversationId:f.chat.id,runId:run,v3SchedulerRunId:run,v3FencingToken:1,availableToolNames:['ponderosa_local_memory_search']});
 ports.activeRuns.set(f.a.id,{messageCapability:token,conversationId:f.chat.id,controller});ports.ownsRun=()=>true;
 try{
 assert.ok(f.memory.agentContext(token,'ponderosa_local_memory_search',false),'the test capability is actually authorized');
 const bad=await f.app.inject({method:'POST',url:'/api/agent-local-memory',headers:{authorization:'Bearer '+token},payload:{operation:'search',query:'private authored text',top_k:21}});
 assert.equal(bad.statusCode,400,bad.body);assert.match(bad.json().error,/top_k must be an integer from 1 to 20/);assert.doesNotMatch(bad.body,/private authored text/);
 const extra=await f.app.inject({method:'POST',url:'/api/agent-local-memory',headers:{authorization:'Bearer '+token},payload:{operation:'search',query:'private authored text',['private unknown field']:'private value'}});
 assert.equal(extra.statusCode,400,extra.body);assert.doesNotMatch(extra.body,/private/);
 ports.capabilities.delete(token);
 const denied=await f.app.inject({method:'POST',url:'/api/agent-local-memory',headers:{authorization:'Bearer '+token},payload:{operation:'search',query:'safe query'}});
 assert.equal(denied.statusCode,401,denied.body);
 }finally{controller.abort();ports.capabilities.delete(token);ports.activeRuns.delete(f.a.id);ports.ownsRun=originalOwnsRun;}
});

test('authorized legacy zero vectors remain readable while new zero writes stay refused',async t=>{
 const f=await instance(t),ids=await seed(f),scope='chat:'+f.chat.id,raw=f.memory.core.database.raw;
 const collection=await raw.client.getCollection({name:raw.names(scope).memory});
 const zero=Array(384).fill(0);
 await collection.update({ids:[ids.privateId],embeddings:[zero]});
 const own=await read(f,f.a.id),legacy=own.find(row=>row.id===ids.privateId);
 assert.ok(legacy);assert.equal(legacy.text,'Included private fact');assert.deepEqual(legacy.embedding,zero);
 assert.equal((await read(f,f.b.id)).some(row=>row.id===ids.privateId),false,'legacy reads retain private audience');
 const reader={chatId:f.chat.id,actor:{kind:'agent',id:f.a.id},runId:'zero-read-check',fenceToken:'1',sourceType:'ai_inference',readChat:true,readGlobal:false,observeExposure:false,guard:async()=>{}};
 const found=await f.memory.perform('get',{chunk_id:ids.privateId},reader);
 assert.equal(found.structuredContent.result.text,'Included private fact');
 const searched=await f.memory.perform('search',{query:'Included private fact',top_k:20,include_history:true},reader);
 assert.ok(searched.structuredContent.result.some(row=>row.chunk_id===ids.privateId),'authorized search returns the legacy record');
 const originalGetCollection=raw.client.getCollection.bind(raw.client);
 try{
  for(const invalid of [Array(383).fill(1),Array.from({length:384},(_,i)=>i===0?NaN:1),Array.from({length:384},(_,i)=>i===0?Infinity:1)]){
   raw.client.getCollection=async args=>{const c=await originalGetCollection(args);if(args.name===raw.names(scope).memory){const get=c.get.bind(c);c.get=async options=>{const page=await get(options);if(options.include?.includes('embeddings')&&page.ids.includes(ids.privateId))page.embeddings[page.ids.indexOf(ids.privateId)]=invalid;return page;};}return c;};
   await assert.rejects(f.memory.core.database.run(reader,()=>f.memory.core.database.get(ids.privateId,[scope])),/Invalid memory vector/);
  }
 }finally{raw.client.getCollection=originalGetCollection;}
 const authority={...reader,runId:'zero-write-check',writeScope:scope,targetId:ids.privateId,visibility:'private'};
 await assert.rejects(f.memory.core.database.run(authority,async()=>{const row=await f.memory.core.database.get(ids.privateId,[scope]);await f.memory.core.database.put(row);}),/Invalid memory vector/);
 const unchanged=await collection.get({ids:[ids.privateId],include:['embeddings']});
 assert.deepEqual(Array.from(unchanged.embeddings[0]),zero,'the refused write does not modify stored bytes');
});

for(const kind of ['chunks','conflicts'])test(`float32-underflow ${kind} refuse restore before writes while stored nonzero vectors roundtrip`,async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);await seed(destination);
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]),before=await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id]),mapping={[source.a.id]:destination.a.id};
 const raw=destination.memory.core.database.raw,original=raw.client.getCollection.bind(raw.client);let writes=0;
 raw.client.getCollection=async args=>{const c=await original(args),add=c.add.bind(c);c.add=async input=>{writes++;return add(input);};return c;};
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
 const originalGet=reopened.client.getCollection.bind(reopened.client),originalCreate=reopened.client.createCollection.bind(reopened.client),activeNames=reopened.names('chat:'+newChatId);let creates=0;
 reopened.client.getCollection=async args=>{if(args.name===activeNames.memory)throw missing;return originalGet(args);};
 reopened.client.createCollection=async args=>{creates++;return originalCreate(args);};
 try{
  await f.memory.provisionInventory();
  const coreHolds=await f.app.inject({method:'GET',url:'/api/local-memory/provisioning-holds',headers:f.headers});assert.equal(coreHolds.statusCode,200,coreHolds.body);
  assert.equal(coreHolds.json().some(row=>row.chatId===newChatId),false,'Core cannot see a Branches Chat hold');
  const holds=await f.app.inject({method:'GET',url:'/api/branches/engine/local-memory/provisioning-holds',headers:f.headers});assert.equal(holds.statusCode,200,holds.body);
  assert.ok(holds.json().some(row=>row.chatId===newChatId&&row.memoryState==='unknown'));
  assert.equal(creates,0,'an established missing collection must remain held');
  await assert.rejects(f.memory.verifyChat(newChatId),/Existing memory collection is missing/);
  assert.throws(()=>f.memory.assertCheckpointSourceSettled(),/existing data is missing/);
 }
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
 try{await memory.provisionInventory();assert.ok(memory.provisioningHolds().some(row=>row.chatId===f.chat.id&&row.memoryState==='unknown'));assert.equal(creates,0,'an old scope must not be recreated just because this process has not seen it');}
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

test('deleting a never-provisioned Chat preserves unrelated same-name collections',async t=>{
 const f=await instance(t),memory=f.memory,raw=memory.core.database.raw,original=memory.provisionNewChat.bind(memory);
 memory.provisionNewChat=async()=>{throw Error('synthetic pre-dispatch interruption');};
 let created;
 try{created=await f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':randomUUID()},payload:{label:'Never provisioned',hostPath:f.root,defaultEngine:'fixture'}});}
 finally{memory.provisionNewChat=original;}
 assert.equal(created.statusCode,409,created.body);const chatId=created.json().chatId,scope='chat:'+chatId;
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'planned',log_state:'planned'});
 memory.setGrant(chatId,true,0,'dev');
 const foreign=await raw.client.createCollection({name:raw.names(scope).memory,metadata:{ownership:'independent'}});
 await foreign.add({ids:['foreign'],documents:['Keep this unrelated data'],embeddings:[vector]});
 const originalDelete=raw.client.deleteCollection.bind(raw.client),originalComplete=f.store.markConversationDeletionServerCleanupComplete.bind(f.store);let deletes=0;
 raw.client.deleteCollection=async args=>{deletes++;return originalDelete(args);};
 // Inject a failure at the receipt boundary, after the Chat grant is removed.
 f.store.markConversationDeletionServerCleanupComplete=()=>{throw Error('synthetic receipt interruption');};
 try{
  const result=await f.app.inject({method:'DELETE',url:'/api/conversations/'+chatId,headers:f.headers});
  assert.equal(result.statusCode,200,result.body);assert.equal(result.json().cleanupPending,true,result.body);
  assert.equal(deletes,0);assert.deepEqual((await foreign.get()).ids,['foreign']);
  const receipt=f.store.getConversationDeletionReceipt(chatId);
  assert.equal(receipt.serverCleanupCompleted,false);assert.match(receipt.lastError,/synthetic receipt interruption/);
  assert.equal(memory.policy.prepare('SELECT 1 FROM local_memory_chat_grants WHERE chat_id=?').get(chatId),undefined);
 }finally{raw.client.deleteCollection=originalDelete;f.store.markConversationDeletionServerCleanupComplete=originalComplete;}
 // Restart must safely replay the exact no-effect cleanup and finish its receipt.
 await f.reopen();
 const deadline=Date.now()+5000;while(!f.store.getConversationDeletionReceipt(chatId).serverCleanupCompleted&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.store.getConversationDeletionReceipt(chatId).serverCleanupCompleted,true);
 const preserved=await f.memory.core.database.raw.client.getCollection({name:raw.names(scope).memory});
 assert.deepEqual((await preserved.get()).ids,['foreign']);
});

test('Chat cleanup waits for in-flight provisioning before deciding there was no effect',async t=>{
 const f=await instance(t),memory=f.memory,raw=memory.core.database.raw,original=memory.provisionNewChat.bind(memory);
 memory.provisionNewChat=async()=>{throw Error('synthetic pre-dispatch interruption');};
 let created;
 try{created=await f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':randomUUID()},payload:{label:'Queued provisioning',hostPath:f.root,defaultEngine:'fixture'}});}
 finally{memory.provisionNewChat=original;}
 assert.equal(created.statusCode,409,created.body);const chatId=created.json().chatId;
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const provisioning=raw.exclusive(async()=>{entered();await gate;f.store.sqlite.prepare("UPDATE local_memory_scope_provisioning SET memory_state='submitted' WHERE chat_id=?").run(chatId);});
 await started;
 const deleting=f.app.inject({method:'DELETE',url:'/api/conversations/'+chatId,headers:f.headers});
 const deadline=Date.now()+5000;while(!f.store.getConversationDeletionReceipt(chatId)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(f.store.getConversationDeletionReceipt(chatId));release();await provisioning;
 const result=await deleting;assert.equal(result.statusCode,200,result.body);assert.equal(result.json().cleanupPending,true,result.body);
 assert.match(f.store.getConversationDeletionReceipt(chatId).lastError,/Memory cleanup held/);
});

for(const invalid of ['generation','principal','storage','witness-generation','witness-principal','witness-storage','empty-confirmed-id','unknown-effect'])test(`never-provisioned Chat cleanup holds when ${invalid} proof is uncertain`,async t=>{
 const f=await instance(t),memory=f.memory,raw=memory.core.database.raw,original=memory.provisionNewChat.bind(memory);
 memory.provisionNewChat=async()=>{throw Error('synthetic pre-dispatch interruption');};
 let created;
 try{created=await f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':randomUUID()},payload:{label:'Uncertain proof',hostPath:f.root,defaultEngine:'fixture'}});}
 finally{memory.provisionNewChat=original;}
 assert.equal(created.statusCode,409,created.body);const chatId=created.json().chatId;
 let evidence;
 if(invalid==='unknown-effect'){
  evidence=path.join(f.options.localMemory.stateDirectory,'source-mutation-holds',randomUUID()+'.json');
  await writeFile(evidence,JSON.stringify({version:1,id:path.basename(evidence,'.json'),state:'remote_write_unsettled'}),{mode:0o600});
 }else if(invalid==='empty-confirmed-id'){
  f.store.sqlite.prepare("UPDATE local_memory_scope_provisioning SET memory_state='confirmed',log_state='confirmed',memory_collection_id='',log_collection_id='retained' WHERE chat_id=?").run(chatId);
 }else{
  const witness=invalid.startsWith('witness-'),kind=invalid.replace('witness-','');
  const column={generation:'data_generation',principal:'principal_id',storage:'storage_binding'}[kind];
  if(witness){
   f.store.sqlite.prepare("UPDATE local_memory_scope_provisioning SET memory_state='confirmed',log_state='confirmed',memory_collection_id='memory-id',log_collection_id='log-id' WHERE chat_id=?").run(chatId);
   f.store.sqlite.prepare(`UPDATE local_memory_host_binding SET ${column}=? WHERE singleton=1`).run(randomUUID());
  }else f.store.sqlite.prepare(`UPDATE local_memory_scope_provisioning SET ${column}=? WHERE chat_id=?`).run(randomUUID(),chatId);
 }
 const originalDelete=raw.client.deleteCollection.bind(raw.client),originalGet=raw.client.getCollection.bind(raw.client);let deletes=0,scopeReads=0;
 raw.client.deleteCollection=async args=>{deletes++;return originalDelete(args);};
 raw.client.getCollection=async args=>{if(Object.values(raw.names('chat:'+chatId)).includes(args.name))scopeReads++;return originalGet(args);};
 try{
  const result=await f.app.inject({method:'DELETE',url:'/api/conversations/'+chatId,headers:f.headers});
  assert.equal(result.statusCode,200,result.body);assert.equal(result.json().cleanupPending,true,result.body);
  const reason=f.store.getConversationDeletionReceipt(chatId).lastError;
  assert.equal(reason,invalid==='unknown-effect'?MEMORY_CLEANUP_UNKNOWN_HOLD:MEMORY_CLEANUP_PROVISION_HOLD);
  assert.equal(isMemoryCleanupHold(reason),true,'Periodic cleanup must leave the unverified state held');
  assert.equal(deletes,0);
  assert.equal(scopeReads,0,'Unverified ownership must hold before any Chat collection lookup');
  if(evidence)assert.match(await readFile(evidence,'utf8'),/remote_write_unsettled/);
 }finally{raw.client.deleteCollection=originalDelete;raw.client.getCollection=originalGet;}
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
 const second=await request();assert.equal(second.statusCode,409,second.body);assert.equal(second.json().chatId,chatId);
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'submitted',log_state:'planned'});
 assert.throws(()=>memory.core.database.assertSourceSettled(),/requires reconciliation/,'a matching read is not evidence that the unknown remote write drained');
 await memory.exportPackageMemory(f.chat.id,[f.a.id]);
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

test('memory policy custody refuses copied, replaced and symbolic policy locations',async t=>{
 const f=await instance(t),directory=f.options.localMemory.stateDirectory,file=path.join(directory,'host-policy.sqlite'),saved=file+'.original',copy=path.join(f.root,'copied-policy');
 await f.suspend();await mkdir(copy,{mode:0o700});await copyFile(file,path.join(copy,'host-policy.sqlite'));
 const copied=await readFile(path.join(copy,'host-policy.sqlite'));
 try{
  f.options.localMemory.stateDirectory=copy;
  await assert.rejects(f.resume(),/Memory policy custody changed/);
  assert.deepEqual(await readFile(path.join(copy,'host-policy.sqlite')),copied,'refused copy remains untouched');
 }finally{try{f.store.close();}catch{}f.options.localMemory.stateDirectory=directory;await f.resume();}
 await rename(file,saved);
 try{
  await copyFile(saved,file);
  assert.throws(()=>f.memory.getGrant(f.chat.id,'dev'),/Memory policy custody changed/);
  await unlink(file);await symlink(saved,file);
  assert.throws(()=>f.memory.getGrant(f.chat.id,'dev'),/Memory policy custody changed/);
 }finally{await unlink(file).catch(()=>{});await rename(saved,file);}
 assert.equal(f.memory.getGrant(f.chat.id,'dev').chatId,f.chat.id);
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
  await memory.ready();assert.ok(memory.provisioningHolds().some(row=>row.scope==='global'&&row.memoryState==='unknown'));assert.equal(creates,0);
  assert.deepEqual(store.sqlite.prepare("SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id='global'").get(),{memory_state:'planned',log_state:'planned'});
 }finally{raw.client.getCollection=originalGet;raw.client.createCollection=originalCreate;await memory.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('policy initialized before its first binding seeds durable scopes after restart',async t=>{
 const f=await instance(t),root=await mkdtemp(path.join(tmpdir(),'memory-policy-before-bind-'));
 const {AgentStore}=await import('@ponderosa/agents'),{LocalMemoryService}=await import('../../apps/server/dist/local-memory.js');
 const store=new AgentStore(path.join(root,'data'));
 const project=store.createProject({label:'Existing before first memory',hostPath:root,defaultEngine:'fixture'});
 const inference={signature:'policy-before-bind-fixture',async embed(){return Array.from({length:384},(_,i)=>i?0:1);},async rerank(pairs){return pairs.map(()=>1);},async close(){}};
 const options={dataDir:path.join(root,'data'),localMemory:{...f.options.localMemory,collectionPrefix:'beforebind_'+randomUUID().replaceAll('-',''),stateDirectory:path.join(root,'policy'),provision:true}};
 const open=()=>new LocalMemoryService({opts:options,store,capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false},inference);
 let memory=open();
 try{
  // Model interruption after the external policy transaction and before the
  // canonical binding/intents transaction; no remote create was dispatched.
  store.sqlite.transaction(()=>{
   store.sqlite.prepare('DELETE FROM local_memory_scope_provisioning').run();
   store.sqlite.prepare("UPDATE local_memory_host_binding SET state='never_configured',principal_id=NULL,storage_binding=NULL,policy_custody=NULL WHERE singleton=1").run();
  })();
  await memory.close();memory=open();
  const planned=store.sqlite.prepare('SELECT chat_id,memory_state,log_state FROM local_memory_scope_provisioning ORDER BY chat_id').all();
  assert.deepEqual(new Set(planned.map(row=>row.chat_id)),new Set(['global',project.lastConversationId]));
  assert.ok(planned.every(row=>row.memory_state==='planned'&&row.log_state==='planned'));
  await memory.ready();
  assert.ok(store.sqlite.prepare("SELECT COUNT(*) n FROM local_memory_scope_provisioning WHERE memory_state='confirmed' AND log_state='confirmed'").get().n===2);
 }finally{await memory.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('first installation retains an inactive Chat plan until its owner is active',async t=>{
 const f=await instance(t),root=await mkdtemp(path.join(tmpdir(),'memory-inactive-first-'));
 const {AgentStore,BranchStore,CoordinationV3Store}=await import('@ponderosa/agents'),{LocalMemoryService}=await import('../../apps/server/dist/local-memory.js');
 const store=new AgentStore(path.join(root,'data')),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const project=store.createProject({label:'Staged before first memory',hostPath:root,defaultEngine:'fixture'}),chatId=project.lastConversationId;
 const branch=branches.create('Staged fixture','staged-fixture');
 store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'staging')").run(branch.id,'staged-package','staged-chat','',chatId);
 const inference={signature:'inactive-first-fixture',async embed(){return Array.from({length:384},(_,i)=>i?0:1);},async rerank(pairs){return pairs.map(()=>1);},async close(){}};
 const options={dataDir:path.join(root,'data'),localMemory:{...f.options.localMemory,collectionPrefix:'inactive_'+randomUUID().replaceAll('-',''),stateDirectory:path.join(root,'policy'),provision:true}};
 const memory=new LocalMemoryService({opts:options,store,capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false},inference);
 try{
  await memory.ready();
  assert.deepEqual(store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'planned',log_state:'planned'});
  await assert.rejects(memory.verifyChat(chatId),/Canonical durable Chat unavailable/);
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE local_id=?").run(chatId);
  await memory.verifyChat(chatId);
  assert.deepEqual(store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'confirmed',log_state:'confirmed'});
 }finally{await memory.close();await branches.unitSaver.drain().catch(()=>{});store.close();await rm(root,{recursive:true,force:true});}
});

test('an exact staged package owner can provision its planned first-install Chat scope',async t=>{
 const source=await instance(t);await seed(source);
 const snapshot=await source.memory.exportPackageMemory(source.chat.id,[source.a.id]);
 const root=await mkdtemp(path.join(tmpdir(),'memory-staged-first-'));
 const {AgentStore,BranchStore,CoordinationV3Store}=await import('@ponderosa/agents'),{LocalMemoryService}=await import('../../apps/server/dist/local-memory.js');
 const store=new AgentStore(path.join(root,'data')),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const branch=branches.create('Staged import','staged-import');
 const project=store.createProject({label:'Staged destination',hostPath:root,defaultEngine:'fixture',chatOwned:true,branchId:branch.id}),chatId=project.lastConversationId;
 const {operation}=store.beginAgentCreationOperation({projectId:project.id,conversationId:chatId,actorScope:'user:local-operator',kind:'import',idempotencyKey:randomUUID(),payloadHash:'staged-first-memory'}),agentId=randomUUID();
 store.addAgentCreationOperationMember(operation.id,agentId,0);store.createAgent(project.id,{title:'Staged worker',engine:'fixture',conversationId:chatId},undefined,agentId);
 const planId=randomUUID(),at=new Date().toISOString();
 store.sqlite.prepare("INSERT INTO branch_installation_plans(id,branch_id,package_json,bindings_json,preview_json,state,created_at) VALUES(?,?, '{}','{}','{}','applying',?)").run(planId,branch.id,at);
 store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state,staging_plan_id,creation_operation_id) VALUES(?,?,?,?,?,'staging',?,?)").run(branch.id,'package','chat','',chatId,planId,operation.id);
 store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state,staging_plan_id,creation_operation_id) VALUES(?,?,?,?,?,'staging',?,?)").run(branch.id,'package','chat','worker',agentId,planId,operation.id);
 const inference={signature:source.memory.core.inference.signature,async embed(){return vector;},async rerank(pairs){return pairs.map(()=>1);},async close(){}};
 const options={dataDir:path.join(root,'data'),localMemory:{...source.options.localMemory,collectionPrefix:'staged_'+randomUUID().replaceAll('-',''),stateDirectory:path.join(root,'policy'),provision:true}};
 const memory=new LocalMemoryService({opts:options,store,capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false},inference);
 try{
  await memory.ready();
  assert.deepEqual(store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'planned',log_state:'planned'});
  const empty=store.beginAgentCreationOperation({projectId:project.id,conversationId:chatId,actorScope:'user:local-operator',kind:'import',idempotencyKey:randomUUID(),payloadHash:'empty-staged-operation'}).operation;
  const entry={snapshot,agentRefs:{[source.a.id]:'worker'}};
  await assert.rejects(memory.restoreImportMemory(empty.id,entry,{},'empty-staged'),/Exact staged Branch import ownership required/);
  assert.deepEqual(store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'planned',log_state:'planned'});
  await memory.restoreImportMemory(operation.id,entry,{[source.a.id]:agentId},'actual-staged');
  assert.deepEqual(store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'confirmed',log_state:'confirmed'});
  await assert.rejects(memory.exportPackageMemory(chatId,[agentId]),/Canonical Chat is unavailable/);
 }finally{await memory.close();await branches.unitSaver.drain().catch(()=>{});store.close();await rm(root,{recursive:true,force:true});}
});

test('an uncertain initial global create remains held across restart while reconciliation stays available',async t=>{
 const f=await instance(t),root=await mkdtemp(path.join(tmpdir(),'memory-global-unknown-'));
 const {AgentStore}=await import('@ponderosa/agents'),{LocalMemoryService}=await import('../../apps/server/dist/local-memory.js');
 const store=new AgentStore(path.join(root,'data'));
 const inference={signature:'global-unknown-fixture',async embed(){return Array.from({length:384},(_,i)=>i?0:1);},async rerank(pairs){return pairs.map(()=>1);},async close(){}};
 const options={dataDir:path.join(root,'data'),localMemory:{...f.options.localMemory,collectionPrefix:'unknown_'+randomUUID().replaceAll('-',''),stateDirectory:path.join(root,'policy'),provision:true}};
 const open=()=>new LocalMemoryService({opts:options,store,capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false},inference);
 let memory=open();
 try{
  const raw=memory.core.database.raw,original=raw.client.createCollection.bind(raw.client);
  raw.client.createCollection=async options=>{await original(options);throw Error('synthetic lost global create response');};
  try{await assert.rejects(memory.ready(),/lost global create response/);}finally{raw.client.createCollection=original;}
  await memory.close();memory=open();await memory.ready();
  assert.deepEqual(store.sqlite.prepare("SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id='global'").get(),{memory_state:'submitted',log_state:'planned'});
  assert.ok(memory.core.database.listMutationHolds().some(hold=>hold.effect?.scope==='global'));
  assert.throws(()=>memory.core.database.assertScopeSettled('global'),/unsettled remote write/);
  await assert.rejects(memory.core.database.exportGlobalMemory(async()=>{}),/unsettled remote write/);
 }finally{await memory.close();store.close();await rm(root,{recursive:true,force:true});}
});


test('a submitted missing collection without a mutation file stays visible and is not replayed',async t=>{
 const f=await instance(t),memory=f.memory,key=randomUUID(),original=memory.provisionNewChat.bind(memory);
 memory.provisionNewChat=async()=>{throw Error('synthetic interruption before memory dispatch');};
 const request=()=>f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':key},payload:{label:'Submitted gap',hostPath:f.root,defaultEngine:'fixture'}});
 let first;
 try{first=await request();}finally{memory.provisionNewChat=original;}
 assert.equal(first.statusCode,409,first.body);const chatId=first.json().chatId;assert.ok(chatId);
 // Model interruption after the durable submitted transition but before the
 // separate source-hold file was written; no backend create is performed.
 f.store.sqlite.prepare("UPDATE local_memory_scope_provisioning SET memory_state='submitted' WHERE chat_id=?").run(chatId);
 await f.reopen();
 const holds=await f.app.inject({method:'GET',url:'/api/local-memory/provisioning-holds',headers:f.headers});
 assert.equal(holds.statusCode,200,holds.body);
 const row=holds.json().find(item=>item.chatId===chatId);assert.equal(row.memoryState,'submitted');assert.equal(row.logState,'planned');
 assert.doesNotMatch(JSON.stringify(row),/intent_id|principal_id|storage_binding/);
 const retry=await request();assert.equal(retry.statusCode,409,retry.body);assert.equal(retry.json().chatId,chatId);
 assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'submitted',log_state:'planned'});
 assert.throws(()=>f.memory.assertCheckpointSourceSettled(),/creation or deletion requires reconciliation/);
});

test('a submitted create is not adopted from copyable matching metadata after restart',async t=>{
 const f=await instance(t),memory=f.memory,key=randomUUID(),original=memory.provisionNewChat.bind(memory);
 memory.provisionNewChat=async()=>{throw Error('synthetic interruption before memory dispatch');};
 let first;try{first=await f.app.inject({method:'POST',url:'/api/chats',headers:{...f.headers,'idempotency-key':key},payload:{label:'Uncertain create',hostPath:f.root,defaultEngine:'fixture'}});}finally{memory.provisionNewChat=original;}
 assert.equal(first.statusCode,409,first.body);const chatId=first.json().chatId,raw=memory.core.database.raw,scope='chat:'+chatId;
 const intent=f.store.sqlite.prepare('SELECT intent_id FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId);
 f.store.sqlite.prepare("UPDATE local_memory_scope_provisioning SET memory_state='submitted' WHERE chat_id=?").run(chatId);
 const name=raw.names(scope).memory,foreign=await raw.client.createCollection({name,configuration:{hnsw:{space:'cosine'}},metadata:{'hnsw:space':'cosine',embedding_signature:raw.signature,dimensions:384,ponderosa_provision_intent:intent.intent_id+':memory'}});
 await f.reopen();
 const current=f.memory.core.database.raw,originalCreate=current.client.createCollection.bind(current.client);let creates=0;
 current.client.createCollection=async(...args)=>{creates++;return originalCreate(...args);};
 try{
  await assert.rejects(f.memory.verifyChat(chatId),/unverified.*not repeated/i);
  assert.deepEqual(f.store.sqlite.prepare('SELECT memory_state,memory_collection_id,log_state FROM local_memory_scope_provisioning WHERE chat_id=?').get(chatId),{memory_state:'submitted',memory_collection_id:null,log_state:'planned'});
  assert.equal((await current.client.getCollection({name})).id,foreign.id);
  assert.equal(creates,0,'an uncertain submitted create is never replayed or adopted');
 }finally{current.client.createCollection=originalCreate;}
});

test('unidentified or malformed source hold evidence fences all scopes without removal',async t=>{
 const f=await instance(t),directory=path.join(f.options.localMemory.stateDirectory,'source-mutation-holds');
 const malformedId=randomUUID(),malformed=path.join(directory,malformedId+'.json'),unknown=path.join(directory,'unidentified.json');
 const malformedBytes=JSON.stringify({version:1,id:malformedId,effect:{}}),unknownBytes='{"unclassified":true}';
 await writeFile(malformed,malformedBytes);await writeFile(unknown,unknownBytes);
 assert.throws(()=>f.memory.core.database.assertScopeSettled('global'),/unsettled remote write/);
 assert.throws(()=>f.memory.core.database.assertScopeSettled('chat:'+f.chat.id),/unsettled remote write/);
 assert.equal(await readFile(malformed,'utf8'),malformedBytes);assert.equal(await readFile(unknown,'utf8'),unknownBytes);
});

test('legacy Chat without a provisioning intent still cleans its own memory and preserves global records',async t=>{
 const f=await instance(t);await seed(f);
 const raw=f.memory.core.database.raw,scope='chat:'+f.chat.id;
 const global=await raw.client.getCollection({name:raw.names('global').memory});
 const before=await global.get({include:['documents','metadatas']});
 assert.ok(before.ids.length>0);
 f.store.sqlite.prepare('DELETE FROM local_memory_scope_provisioning WHERE chat_id=?').run(f.chat.id);
 const result=await f.app.inject({method:'DELETE',url:'/api/conversations/'+f.chat.id,headers:f.headers});
 assert.equal(result.statusCode,200,result.body);assert.equal(result.json().cleanupPending,false,result.body);
 for(const name of Object.values(raw.names(scope)))await assert.rejects(raw.client.getCollection({name}),{name:'ChromaNotFoundError'});
 const after=await global.get({include:['documents','metadatas']});
 assert.deepEqual(after.ids,before.ids);assert.deepEqual(after.documents,before.documents);assert.deepEqual(after.metadatas,before.metadatas);
});
