import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {CapabilityPolicyStore} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {instance,seed,vector} from './portability-fixture.mjs';
import {globalMemoryHash,validateGlobalMemory,selectGlobalMemory} from '../../apps/server/dist/portable-global-memory.js';
const endpoint='/api/local-memory/global-transfer';
async function api(f,action,payload,headers=f.headers){const r=await f.app.inject({method:action?'POST':'GET',url:endpoint+(action?'/'+action:''),headers,...(payload?{payload}:{})});return {status:r.statusCode,body:r.json(),raw:r.body};}
async function inventory(f){const r=await api(f);assert.equal(r.status,200,r.raw);return r.body;}
const select=s=>({chunkIds:s.chunks.map(r=>r.id),conflictIds:s.conflicts.map(r=>r.id)});
async function prepare(f,snapshot,selection=select(snapshot)){const r=await api(f,'preview',{snapshot,selection});assert.equal(r.status,200,r.raw);return r.body;}
const commit=(f,review,extra={})=>api(f,'import',{snapshot:review.snapshot,selection:select(review.snapshot),reviewHash:review.reviewHash,acknowledge:true,...extra});
function noWork(f){for(const table of ['scheduler_runs','agent_activations','provider_operation_outbox'])assert.equal(f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);}
async function globalSeed(f){
 const raw=f.memory.core.database.raw,at=new Date().toISOString(),parent=randomUUID(),child=randomUUID(),outside=randomUUID(),conflict=randomUUID();
 const provenance={actor:{kind:'agent',id:f.a.id},runId:'inert-source-history',fenceToken:'historical',at};
 const stamp=id=>({format:1,principal:f.memory.principalId,id,scope:'global',ownerChat:'global',audience:'installation-global',sourceType:'ai_inference',provenance,origin:provenance});
 const chunks=[{id:parent,text:'Earlier source preference',metadata:{source_type:'ai_inference',confidence:0.9,deprecated:true,timestamp:at}},{id:child,text:'Selected source preference',metadata:{source_type:'ai_inference',confidence:0.9,deprecated:false,timestamp:at,supersedes:parent}},{id:outside,text:'DO_NOT_TRANSFER',metadata:{source_type:'ai_inference',confidence:0.9,deprecated:false,timestamp:at}}];
 const c=await raw.client.getCollection({name:raw.names('global').memory});await c.upsert({ids:chunks.map(r=>r.id),documents:chunks.map(r=>r.text),embeddings:chunks.map(()=>vector),metadatas:chunks.map(r=>({...r.metadata,host_source_authority:JSON.stringify(stamp(r.id))}))});
 const log=await raw.client.getCollection({name:raw.names('global').log});await log.upsert({ids:[conflict],documents:['Preserve source disagreement for explicit resolution'],embeddings:[vector],metadatas:[{source_type:'ai_inference',timestamp:at,log_id:conflict,chunk_ids:JSON.stringify([parent,child]),chunk_ids_affected:JSON.stringify([parent,child]),chunks_affected:2,host_conflict_authority:JSON.stringify(stamp(conflict))}]});
 return {parent,child,outside,conflict,selection:{chunkIds:[parent,child],conflictIds:[conflict]}};
}
for(const branch of [false,true])test(`selected global HTTP transfer preserves destination authority, parallel facts/conflicts, explicit selection and reopen/retry in ${branch?'Branches':'Core'}`,async t=>{
 const source=await instance(t,branch),destination=await instance(t,branch);await seed(source);await seed(destination);const ids=await globalSeed(source),destIds=await globalSeed(destination);
 source.memory.setGrant(source.chat.id,true,0,branch?'branches':'dev');
 const policy=new CapabilityPolicyStore(destination.store.sqlite);policy.put({scopeKind:'global',scopeId:'ponderosa',expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite],actor:'operator',reason:'Keep local restrictions'});
 const policies=destination.store.sqlite.prepare('SELECT * FROM capability_policies ORDER BY scope_kind,scope_id').all(),grant=destination.memory.getGrant(destination.chat.id,branch?'branches':'dev'),agents=destination.store.listAgents(destination.project.id),before=(await inventory(destination)).snapshot;
 const local=await inventory(source);
 const denied=await api(source,'export',{selection:ids.selection,inventoryHash:local.inventoryHash});assert.equal(denied.status,409,denied.raw);
 const result=await api(source,'export',{selection:ids.selection,inventoryHash:local.inventoryHash,acknowledge:true});assert.equal(result.status,200,result.raw);const snapshot=result.body;
 assert.equal(snapshot.chunks.length,2);assert.equal(snapshot.conflicts.length,1);assert.doesNotMatch(JSON.stringify(snapshot),/DO_NOT_TRANSFER|EXCLUDED_GLOBAL_FACT|Included private fact|readGlobal/);
 const review=await prepare(destination,snapshot);assert.deepEqual(review.destination,before);assert.deepEqual((await inventory(destination)).snapshot,before,'preview has no effects');
 assert.equal((await commit(destination,review,{acknowledge:false})).status,409);assert.deepEqual((await inventory(destination)).snapshot,before);
 const receipt=await commit(destination,review);assert.equal(receipt.status,200,receipt.raw);assert.equal(receipt.body.added,3);
 const after=(await inventory(destination)).snapshot;for(const row of before.chunks)assert.deepEqual(after.chunks.find(r=>r.id===row.id),row);for(const row of before.conflicts)assert.deepEqual(after.conflicts.find(r=>r.id===row.id),row);
 for(const row of [...after.chunks,...after.conflicts].filter(r=>!before.chunks.some(b=>b.id===r.id)&&!before.conflicts.some(b=>b.id===r.id))){assert.equal(row.stamp.principal,destination.memory.principalId);assert.notEqual(row.stamp.provenance.actor.id,source.a.id);assert.equal(row.stamp.origin.runId,'inert-source-history');assert.match(row.stamp.provenance.runId,/^global-transfer:/);assert.equal(row.stamp.provenance.fenceToken,'historical');assert.deepEqual(row.embedding,vector);}
 const child=after.chunks.find(r=>receipt.body.chunkIds.includes(r.id)&&r.text==='Selected source preference');assert.ok(after.chunks.find(r=>r.id===child.metadata.supersedes).metadata.deprecated);
 const conflict=after.conflicts.find(r=>receipt.body.conflictIds.includes(r.id));assert.ok(JSON.parse(conflict.metadata.chunk_ids).every(id=>receipt.body.chunkIds.includes(id)));assert.ok(after.conflicts.some(r=>r.id===destIds.conflict));
 const checkAuthority=()=>{assert.deepEqual(destination.store.sqlite.prepare('SELECT * FROM capability_policies ORDER BY scope_kind,scope_id').all(),policies);assert.deepEqual(destination.memory.getGrant(destination.chat.id,branch?'branches':'dev'),grant);assert.deepEqual(destination.store.listAgents(destination.project.id),agents);noWork(destination);};checkAuthority();
 const repeated=await commit(destination,await prepare(destination,snapshot));assert.equal(repeated.status,200,repeated.raw);assert.equal(repeated.body.added,0);assert.deepEqual(repeated.body.chunkIds,receipt.body.chunkIds);assert.deepEqual((await inventory(destination)).snapshot,after);
 await destination.reopen();checkAuthority();assert.deepEqual((await inventory(destination)).snapshot,after);assert.equal((await commit(destination,await prepare(destination,snapshot))).body.added,0);
 const reexport=await api(destination,'export',{selection:{chunkIds:receipt.body.chunkIds,conflictIds:receipt.body.conflictIds},inventoryHash:(await inventory(destination)).inventoryHash,acknowledge:true});assert.equal(reexport.status,200,reexport.raw);assert.equal(reexport.body.conflicts.length,1);assert.equal(reexport.body.chunks[0].stamp.origin.runId,'inert-source-history');
});
test('missing lineage, unknown/duplicate selection and malformed global data refuse before any destination mutation',async t=>{
 const source=await instance(t),destination=await instance(t);const ids=await globalSeed(source),all=(await inventory(source)).snapshot,before=await inventory(destination);
 for(const selection of [{chunkIds:[ids.child],conflictIds:[]},{chunkIds:[ids.parent],conflictIds:[ids.conflict]},{chunkIds:[ids.parent,ids.parent],conflictIds:[]},{chunkIds:['unknown'],conflictIds:[]},{chunkIds:[],conflictIds:[]}]){
  const r=await api(destination,'preview',{snapshot:all,selection});assert.equal(r.status,409,r.raw);assert.deepEqual(await inventory(destination),before);noWork(destination);
 }
 const packet=selectGlobalMemory(all,ids.selection);
 for(const mutate of [s=>s.grants={readGlobal:true},s=>s.policies=[],s=>s.signature='foreign-model',s=>s.chunks[0].stamp.principal='foreign',s=>s.chunks[0].stamp.scope='chat:foreign',s=>s.chunks[0].stamp.audience='chat:foreign:team',s=>s.chunks[0].metadata.api_key='SYNTHETIC_SECRET',s=>s.chunks[0].metadata.host_source_authority='forged',s=>s.chunks[0].embedding=Array(384).fill(0),s=>s.chunks[0].embedding=Array(384).fill(1e-100),s=>s.conflicts[0].metadata.chunk_ids_affected='["foreign"]',s=>s.chunks.push(structuredClone(s.chunks[0]))]){
  const snapshot=structuredClone(packet);mutate(snapshot);const r=await api(destination,'preview',{snapshot,selection:select(snapshot)});assert.equal(r.status,409,r.raw);assert.deepEqual(await inventory(destination),before);noWork(destination);
 }
});
test('source change invalidates export review and destination change invalidates import review',async t=>{
 const source=await instance(t),destination=await instance(t);const ids=await globalSeed(source),local=await inventory(source),snapshot=selectGlobalMemory(local.snapshot,ids.selection),review=await prepare(destination,snapshot);
 await seed(source);const stale=await api(source,'export',{selection:ids.selection,inventoryHash:local.inventoryHash,acknowledge:true});assert.equal(stale.status,409,stale.raw);
 await seed(destination);const before=await inventory(destination),result=await commit(destination,review);assert.equal(result.status,409,result.raw);assert.match(result.body.error,/changed; review again/);assert.deepEqual(await inventory(destination),before);noWork(destination);
 const fresh=await prepare(destination,snapshot),changed=structuredClone(fresh.snapshot);changed.chunks[0].text+=' Changed after review';const altered=await commit(destination,{...fresh,snapshot:changed});assert.equal(altered.status,409,altered.raw);assert.deepEqual(await inventory(destination),before);
 const tampered=await commit(destination,await prepare(destination,snapshot),{reviewHash:'0'.repeat(64)});assert.equal(tampered.status,409,tampered.raw);assert.deepEqual(await inventory(destination),before);
});
test('Agent capabilities cannot inventory/export/review/import global transfer data',async t=>{
 const f=await instance(t),token=randomUUID();f.memory.ports.capabilities.set(token,{});const headers={authorization:'Bearer '+token};
 for(const action of [undefined,'export','preview','import']){const r=await api(f,action,action?{}:undefined,headers);assert.equal(r.status,401,r.raw);}noWork(f);
});
test('unknown local global rows refuse inventory and known credential metadata is excluded from export',async t=>{
 const f=await instance(t);await seed(f);const raw=f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('global').memory}),rows=await c.get({include:['metadatas']});
 await c.update({ids:rows.ids,metadatas:rows.metadatas.map(m=>({...m,env:JSON.stringify({OPENAI_API_KEY:'SYNTHETIC_SECRET',safe:'kept'})}))});const local=await inventory(f);assert.doesNotMatch(JSON.stringify(local),/SYNTHETIC_SECRET/);assert.match(JSON.stringify(local),/kept/);
 await c.upsert({ids:['unclassified'],documents:['NEVER_ADOPT'],embeddings:[vector],metadatas:[{source_type:'ai_inference',confidence:0.9,deprecated:false}]});const denied=await api(f);assert.equal(denied.status,500,denied.raw);assert.match(denied.body.error,/foreign or unclassified/);
});
test('deterministic collision preserves changed local fact and reviewed retry adds no replacement',async t=>{
 const source=await instance(t),destination=await instance(t),ids=await globalSeed(source),snapshot=selectGlobalMemory((await inventory(source)).snapshot,ids.selection);
 const first=await commit(destination,await prepare(destination,snapshot));assert.equal(first.status,200,first.raw);
 const original=(await inventory(destination)).snapshot.chunks.find(r=>r.id===first.body.chunkIds[0]);assert.ok(original);
 const raw=destination.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('global').memory});await c.update({ids:[original.id],documents:['Explicit destination edit'],embeddings:[vector]});const before=await inventory(destination);
 assert.deepEqual(before.snapshot.chunks.find(r=>r.id===original.id),{...original,text:'Explicit destination edit',embedding:vector},'fixture edit persists with its vector, metadata and provenance before collision refusal');
 const retry=await commit(destination,await prepare(destination,snapshot));assert.equal(retry.status,409,retry.raw);assert.match(retry.body.error,/collision/);assert.deepEqual(await inventory(destination),before);noWork(destination);
});
test('selection order and JSON key order do not change exact reviewed global packet identity',async t=>{
 const f=await instance(t),ids=await globalSeed(f),snapshot=(await inventory(f)).snapshot;
 const a=selectGlobalMemory(snapshot,ids.selection),b=selectGlobalMemory({...snapshot,chunks:[...snapshot.chunks].reverse()}, {...ids.selection,chunkIds:[...ids.selection.chunkIds].reverse()});assert.equal(globalMemoryHash(a),globalMemoryHash(b));assert.deepEqual(validateGlobalMemory(a),a);
});
for(const mode of ['storage-failure','revoked-guard'])test(`partial ${mode} leaves only selected readable ancestors; explicit re-review/reopen completes exact namespace`,async t=>{
 const source=await instance(t),destination=await instance(t),ids=await globalSeed(source),snapshot=selectGlobalMemory((await inventory(source)).snapshot,ids.selection),review=await prepare(destination,snapshot),raw=destination.memory.core.database.raw;
 const original=raw.client.getCollection.bind(raw.client);let writes=0,revoked=false;
 raw.client.getCollection=async args=>{const c=await original(args),add=c.add.bind(c);c.add=async input=>{writes++;if(mode==='storage-failure'&&writes===2)throw Error('Controlled transfer write failure');const result=await add(input);if(mode==='revoked-guard')revoked=true;return result;};return c;};
 try{await assert.rejects(destination.memory.core.database.importGlobalMemory(snapshot,review.reviewHash,async()=>{if(revoked)throw Error('Controlled operator revocation');}),mode==='storage-failure'?/Controlled transfer write failure/:/Controlled operator revocation/);}finally{raw.client.getCollection=original;}
 assert.equal(writes,mode==='storage-failure'?2:1);
 if(mode==='storage-failure'){
  const list=await destination.app.inject({method:'GET',url:'/api/local-memory/mutation-holds',headers:destination.headers});assert.equal(list.statusCode,200,list.body);
  const hold=list.json().find(row=>row.effect?.scope==='global');assert.ok(hold,'unknown global write must remain held');
  const review=await destination.app.inject({method:'GET',url:'/api/local-memory/mutation-holds/'+hold.id,headers:destination.headers});assert.equal(review.statusCode,200,review.body);
  const decision=await destination.app.inject({method:'POST',url:'/api/local-memory/mutation-holds/'+hold.id+'/reconcile',headers:destination.headers,payload:{commandKey:randomUUID(),reviewSha256:review.json().reviewSha256,backendDrainEvidence:'Controlled fixture threw before sending the second backend write',preserveCurrentBackend:true}});assert.equal(decision.statusCode,200,decision.body);
 }
 const partial=(await inventory(destination)).snapshot;assert.equal(partial.chunks.length,1);assert.equal(partial.chunks[0].text,'Earlier source preference');assert.equal(partial.conflicts.length,0);assert.equal((await commit(destination,review)).status,409,'stale pre-failure review cannot release further writes');noWork(destination);
 await destination.reopen();assert.deepEqual((await inventory(destination)).snapshot,partial);const finished=await commit(destination,await prepare(destination,snapshot));assert.equal(finished.status,200,finished.raw);assert.equal(finished.body.added,2);assert.equal((await inventory(destination)).snapshot.chunks.length,2);assert.equal((await inventory(destination)).snapshot.conflicts.length,1);noWork(destination);
});

test('global import preserves an independently inserted record at the same ID',async t=>{
 const source=await instance(t),destination=await instance(t),ids=await globalSeed(source),snapshot=selectGlobalMemory((await inventory(source)).snapshot,ids.selection),review=await prepare(destination,snapshot),raw=destination.memory.core.database.raw;
 const original=raw.client.getCollection.bind(raw.client);let raced;
 raw.client.getCollection=async args=>{
  const c=await original(args),add=c.add.bind(c);
  c.add=async input=>{
   if(!raced){
    raced={id:input.ids[0],name:args.name,text:'Independent synthetic global record'};
    await add({...input,documents:[raced.text],metadatas:[{...input.metadatas[0],independent_fixture:'preserve'}]});
   }
   return add(input);
  };return c;
 };
 try{
  const result=await commit(destination,review);assert.notEqual(result.status,200,result.raw);assert.ok(raced);
  const c=await original({name:raced.name}),current=await c.get({ids:[raced.id],include:['documents','metadatas']});
  assert.deepEqual(current.ids,[raced.id]);assert.equal(current.documents[0],raced.text);assert.equal(current.metadatas[0].independent_fixture,'preserve');noWork(destination);
 }finally{raw.client.getCollection=original;}
});

test('selected import uses the installed nonreentrant Chroma queue once for complete review and append',async t=>{
 const {ChromaStorage}=await import('@local-memory/mcp-node-private');
 const source=await instance(t),destination=await instance(t),ids=await globalSeed(source),snapshot=selectGlobalMemory((await inventory(source)).snapshot,ids.selection),review=await prepare(destination,snapshot);
 const raw=destination.memory.core.database.raw;
 assert.ok(raw instanceof ChromaStorage);assert.equal(raw.exclusive,ChromaStorage.prototype.exclusive,'exercise the installed queue, not a reentrant test double');
 const realExclusive=raw.exclusive.bind(raw),events=[];let release,entered,inner;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const outer=realExclusive(async()=>{events.push('outer');inner=realExclusive(async()=>{events.push('inner');});entered();await gate;events.push('release');});
 await started;
 try{await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['outer'],'nested work stays queued behind the current owner');}finally{release();await outer;await inner;}
 assert.deepEqual(events,['outer','release','inner']);
 let acquisitions=0,guards=0;
 // A second acquisition is the original self-wait: fail before enqueueing it so teardown cannot hang.
 // Every permitted acquisition still delegates to the unchanged installed nonreentrant queue.
 raw.exclusive=fn=>{assert.equal(++acquisitions,1,'import must not reacquire raw.exclusive while holding it');return realExclusive(fn);};
 let receipt;
 try{receipt=await destination.memory.core.database.importGlobalMemory(snapshot,review.reviewHash,async()=>{guards++;});}finally{raw.exclusive=ChromaStorage.prototype.exclusive;}
 assert.equal(acquisitions,1);assert.ok(guards>0);assert.equal(receipt.added,3);
 const after=(await inventory(destination)).snapshot;assert.equal(after.chunks.length,2);assert.equal(after.conflicts.length,1);noWork(destination);
 const retry=await commit(destination,await prepare(destination,snapshot));assert.equal(retry.status,200,retry.raw);assert.equal(retry.body.added,0);assert.deepEqual((await inventory(destination)).snapshot,after);
});
