import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {createServer} from '../../apps/server/dist/app.js';
import {localMemoryFor} from '../../apps/server/dist/local-memory.js';
import {validateMemorySnapshot,MEMORY_SNAPSHOT_MAX_BYTES} from '../../apps/server/dist/portable-memory-snapshot.js';

let chroma;
async function ownedChroma(){
 if(chroma)return chroma.url;
 const root=await mkdtemp(path.join(tmpdir(),'memory-package-chroma-')),reserve=net.createServer();
 await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.env.PONDEROSA_TEST_CHROMA_BIN??'chroma',['run','--path',root,'--host','127.0.0.1','--port',String(port)],{stdio:'ignore',env:{...process.env,ANONYMIZED_TELEMETRY:'False'}});
 chroma={root,child,url:'http://127.0.0.1:'+port,exit:once(child,'exit')};
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Owned Chroma exited');try{if((await fetch(chroma.url+'/api/v2/heartbeat')).ok)return chroma.url;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Owned Chroma unavailable');
}
after(async()=>{if(chroma){chroma.child.kill('SIGTERM');await chroma.exit;await rm(chroma.root,{recursive:true,force:true});}});
async function instance(t,branch=false){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'memory-package-'))),dataDir=path.join(root,'data'),token=randomUUID();let store=new AgentStore(dataDir),app;
 const adapter={id:'fixture',displayName:'Inert',listModels:()=>[],listEfforts:()=>[],async*seed(){throw Error('No provider turn allowed');},async*continue(){throw Error('No provider turn allowed');}};
 const branchId=branch?new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)).create('Portable memory scope','fixture').id:undefined;
 const project=store.createProject({label:'Memory portability',hostPath:root,defaultEngine:'fixture',chatOwned:true,...(branchId?{branchId}:{})}),chat=store.getConversation(project.lastConversationId);
 const a=store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Included'}),b=store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Excluded'});
 const options={dataDir,authToken:token,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,localMemory:{chromaUrl:await ownedChroma(),collectionPrefix:'package_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR??path.join(tmpdir(),'unconfigured-memory-models'),stateDirectory:path.join(root,'policy'),provision:true}};
 const open=async()=>{app=createServer({...options,store});await app.ready();};
 const close=async()=>{app.prepareForShutdown();await app.close();store.close();};await open();
 t.after(async()=>{await close();await rm(root,{recursive:true,force:true});});
 const f={root,project,chat,a,b,get memory(){return localMemoryFor(app);},get store(){return store;},async reopen(){await close();store=new AgentStore(dataDir);await open();}};return f;
}
const vector=Array.from({length:384},(_,i)=>i?0:1);
async function seed(f){
 const memory=f.memory,raw=memory.core.database.raw,scope='chat:'+f.chat.id,at=new Date().toISOString();
 const provenance={actor:{kind:'agent',id:f.a.id},runId:'source-not-a-live-run',fenceToken:'historical-source',at};
 const row=(id,audience,text,parent)=>({id,text,embedding:vector,metadata:{source_type:'ai_inference',confidence:0.9,deprecated:Boolean(parent===null),timestamp:at,...(typeof parent==='string'?{supersedes:parent}:{})},stamp:{format:1,principal:memory.principalId,id,scope,ownerChat:f.chat.id,audience,sourceType:'ai_inference',provenance,origin:provenance}});
 const parent=randomUUID(),child=randomUUID(),privateId=randomUUID(),outside=randomUUID(),conflict=randomUUID();
 const rows=[row(parent,scope+':team','Original seeded team fact',null),row(child,scope+':team','Revised seeded team fact 😀',parent),row(privateId,scope+':agent:'+f.a.id,'Included private fact'),row(outside,scope+':agent:'+f.b.id,'EXCLUDED_PRIVATE_FACT')];
 const c=await raw.client.getCollection({name:raw.names(scope).memory});
 await c.upsert({ids:rows.map(r=>r.id),documents:rows.map(r=>r.text),embeddings:rows.map(r=>r.embedding),metadatas:rows.map(r=>({...r.metadata,host_source_authority:JSON.stringify(r.stamp)}))});
 const log=await raw.client.getCollection({name:raw.names(scope).log}),r=row(conflict,scope+':team','Preserved conflict reasoning');
 await log.upsert({ids:[conflict],documents:[r.text],embeddings:[vector],metadatas:[{...r.metadata,log_id:conflict,chunk_ids:JSON.stringify([parent,child]),chunk_ids_affected:JSON.stringify([parent,child]),chunks_affected:2,host_conflict_authority:JSON.stringify(r.stamp)}]});
 const global=await raw.client.getCollection({name:raw.names('global').memory}),gid=randomUUID(),gprov={...provenance,actor:{kind:'user',id:memory.principalId}};
 await global.upsert({ids:[gid],documents:['EXCLUDED_GLOBAL_FACT'],embeddings:[vector],metadatas:[{...r.metadata,source_type:'user_statement',host_source_authority:JSON.stringify({...r.stamp,id:gid,scope:'global',ownerChat:'global',audience:'installation-global',sourceType:'user_statement',provenance:gprov,origin:gprov})}]});
 return {parent,child,privateId};
}
async function read(f,agentId,readGlobal=false,readChat=true){
 const a={chatId:f.chat.id,actor:{kind:'agent',id:agentId},runId:'trusted-test-read',fenceToken:'1',sourceType:'ai_inference',readChat,readGlobal,observeExposure:false,guard:async()=>{}};
 return f.memory.core.database.run(a,()=>f.memory.core.database.list(['chat:'+f.chat.id,...(readGlobal?['global']:[])]));
}
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
