import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {instance,seed,read} from './portability-fixture.mjs';

async function api(f,method,url,payload,extra={}){const res=await f.app.inject({method,url,headers:f.headers,...(payload===undefined?{}:{payload}),...extra});return {status:res.statusCode,body:res.json(),raw:res.body};}
async function exported(f,organization=true){const res=await api(f,'GET',`/api/agents/${f.a.id}/export?mode=full&organization=${organization}`);assert.equal(res.status,200,res.raw);return res.body;}
const body=(f,pkg)=>({package:pkg,conversationId:f.chat.id,engineMapping:{fixture:'fixture'}});
const imported=(f,pkg,key=randomUUID())=>api(f,'POST',`/api/projects/${f.project.id}/import-agents`,body(f,pkg),{headers:{...f.headers,'idempotency-key':key}});
function noRuns(f){for(const table of ['scheduler_runs','agent_activations','provider_operation_outbox'])assert.equal(f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);}

test('actual organization HTTP package roundtrip restores scoped queries and deduplicates team memory after reopen/reexport/retry',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);
 source.store.updateAgentOrganization(source.b.id,{managerAgentId:source.a.id});
 const raw=source.memory.core.database.raw,collection=await raw.client.getCollection({name:raw.names('chat:'+source.chat.id).memory}),row=await collection.get({limit:1,include:['metadatas']});await collection.update({ids:row.ids,metadatas:[{...row.metadatas[0],env:JSON.stringify(JSON.stringify({OPENAI_API_KEY:'SYNTHETIC_EXPORT_SECRET',safe:'kept'}))}]});
 const pkg=await exported(source);assert.doesNotMatch(JSON.stringify(pkg),/SYNTHETIC_EXPORT_SECRET/);assert.match(JSON.stringify(pkg),/kept/);assert.equal(pkg.memory.length,1);assert.equal(pkg.memory[0].snapshot.chunks.length,4);
 assert.equal((await api(source,'GET',`/api/agents/${source.a.id}/export?mode=template&organization=true`)).body.memory,undefined);
 const key=randomUUID(),result=await imported(destination,pkg,key);assert.equal(result.status,201,result.raw);
 const root=result.body.rootAgentId,child=result.body.agentIds.find(id=>id!==root);
 assert.equal((await read(destination,root)).length,3);assert.equal((await read(destination,child)).length,3);
 const query=await destination.memory.core.database.run({chatId:destination.chat.id,actor:{kind:'agent',id:root},runId:'trusted-test-query',fenceToken:'1',sourceType:'ai_inference',readChat:true,readGlobal:false,observeExposure:false,guard:async()=>{}},()=>destination.memory.core.database.candidates(['chat:'+destination.chat.id],Array.from({length:384},(_,i)=>i?0:1),100,true,0));assert.equal(query.length,3);
 assert.equal((await read(destination,destination.a.id)).length,2,'unrelated destination peer sees team only');assert.equal(destination.memory.getGrant(destination.chat.id,'dev').readGlobal,false);
 assert.equal((await imported(destination,pkg,key)).status,200);noRuns(destination);
 await destination.reopen();assert.equal((await read(destination,root)).length,3);assert.equal(destination.memory.getGrant(destination.chat.id,'dev').readGlobal,false);
 const next=await api(destination,'GET',`/api/agents/${root}/export?mode=full&organization=true`);assert.equal(next.status,200,next.raw);assert.equal(next.body.memory[0].snapshot.chunks.length,4);assert.equal(next.body.memory[0].snapshot.conflicts.length,1);
 const semantic=s=>s.chunks.map(r=>[r.text,r.embedding,r.metadata.deprecated,Boolean(r.metadata.supersedes)]).sort((a,b)=>a[0].localeCompare(b[0]));assert.deepEqual(semantic(next.body.memory[0].snapshot),semantic(pkg.memory[0].snapshot));noRuns(destination);
});

test('product parser refuses encoded metadata credentials, malformed bindings/signatures and oversize before Agent or memory mutation',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);const pkg=await exported(source,false),before=destination.store.listAgents(destination.project.id).length;
 for(const mutate of [p=>p.memory.push(structuredClone(p.memory[0])),p=>p.memory[0].snapshot.schema='unsupported',p=>p.memory[0].snapshot.signature='wrong-model',p=>p.memory[0].snapshot.chunks[0].text='\ud800',p=>p.memory[0].agentRefs[source.a.id]='missing',p=>p.memory[0].snapshot.chunks[0].metadata.env=JSON.stringify(JSON.stringify({OPENAI_API_KEY:'SYNTHETIC_ONLY'})),p=>p.memory[0].snapshot.chunks[0].text='x'.repeat(16*1024*1024)]){
  const invalid=structuredClone(pkg);mutate(invalid);const res=await imported(destination,invalid);assert.ok(res.status>=400,res.raw);assert.equal(destination.store.listAgents(destination.project.id).length,before);assert.equal((await read(destination,destination.a.id)).length,0);
 }
 noRuns(destination);
});

test('pending package rows stay hidden and SIGKILL after the first real product memory write is rolled back at startup',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);const pkg=await exported(source,false),key=randomUUID();
 const options={...destination.options};delete options.engines;
 await destination.suspend();
 const worker=fork(new URL('./package-crash-worker.mjs',import.meta.url),[],{execArgv:['--import',new URL('../shared/workspace-resolution.mjs',import.meta.url).pathname],stdio:['ignore','ignore','pipe','ipc']});
 let errors='';worker.stderr.on('data',chunk=>{errors+=chunk;});const exited=once(worker,'exit');worker.send({options,payload:{projectId:destination.project.id,body:body(destination,pkg)},key});const [code,signal]=await exited;assert.equal(signal,'SIGKILL',errors||String(code));
 await destination.resume();
 const op=destination.store.findAgentCreationOperation({projectId:destination.project.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:key});assert.equal(op.status,'rolled_back',op.lastError);assert.equal((await read(destination,destination.a.id)).length,0);assert.equal(destination.store.listAgents(destination.project.id).length,2);
 const raw=destination.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+destination.chat.id).memory});assert.deepEqual((await c.get({include:['metadatas']})).ids,[],'no hidden namespace orphan remains');
 const retry=await imported(destination,pkg,key);assert.equal(retry.status,201,retry.raw);assert.equal((await read(destination,retry.body.rootAgentId)).length,3);noRuns(destination);
});

const workflow=(defs)=>({schema:'ponderosa.branch-installation.v1',packageId:'memory.workflow.fixture',mode:'template',exportedAt:new Date().toISOString(),definition:{schema:'ponderosa.branch.v1',name:'Memory workflow',trigger:{kind:'manual'},entry:'agent',controls:[],steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'speaker'},instructions:'No provider turn'}],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats:[{ref:'chat',title:'Memory Chat',agents:defs.map((definition,index)=>({ref:index?'peer':'speaker',definition}))}],agentBindings:{speaker:{chatRef:'chat',agentRef:'speaker'}}});
async function install(f,pkg){const preview=await api(f,'POST','/api/branches/install-preview',{package:pkg,bindings:{directories:{workspace:f.root},agents:{},engines:{fixture:'fixture'}}});assert.equal(preview.status,200,preview.raw);const result=await api(f,'POST',`/api/branches/installations/${preview.body.id}/confirm`,{acknowledgeFullImport:true});assert.equal(result.status,200,result.raw);assert.equal(result.body.state,'completed',result.raw);return {preview:preview.body,result:result.body};}
test('actual Branch workflow package transport maps logical refs and installs team memory only once on a fresh destination',async t=>{
 const source=await instance(t),destination=await instance(t);
 const defs=[];for(const [index,a] of [source.a,source.b].entries()){const ref=index?'peer':'speaker',r=await api(source,'GET',`/api/agents/${a.id}/export?mode=template`);assert.equal(r.status,200,r.raw);defs.push({...r.body,rootRef:ref,agents:r.body.agents.map(n=>({...n,ref}))});}
 const installed=await install(source,workflow(defs)),configuration=await api(source,'GET',`/api/branches/${installed.result.branchId}/configuration`),a=source.store.getAgent(configuration.body.agents.speaker),resource=source.store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref='peer'").get(installed.result.branchId),b=source.store.getAgent(resource.local_id),chat=source.store.getConversation(a.conversationId);
 const scoped=Object.assign(Object.create(source),{a,b,chat,project:source.store.getProject(chat.projectId)});await seed(scoped);
 const pack=await api(source,'GET',`/api/branches/${installed.result.branchId}/package?mode=full`);assert.equal(pack.status,200,pack.raw);
 const total=pack.body.chats.flatMap(c=>c.agents).flatMap(a=>a.definition.memory??[]).flatMap(m=>m.snapshot.chunks);assert.equal(total.length,4);assert.equal(total.filter(r=>r.stamp.audience.endsWith(':team')).length,2);
 const result=await install(destination,pack.body),config=await api(destination,'GET',`/api/branches/${result.result.branchId}/configuration`),target=destination.store.getAgent(config.body.agents.speaker),destChat=destination.store.getConversation(target.conversationId),dst=Object.assign(Object.create(destination),{a:target,chat:destChat});
 assert.equal((await read(dst,target.id)).length,3);assert.equal(destination.memory.getGrant(destChat.id,'branches').readGlobal,false);noRuns(destination);
 const next=await api(destination,'GET',`/api/branches/${result.result.branchId}/package?mode=full`);assert.equal(next.status,200,next.raw);assert.equal(next.body.chats.flatMap(c=>c.agents).flatMap(a=>a.definition.memory??[]).flatMap(m=>m.snapshot.chunks).length,4);
 const refused=await api(destination,'POST','/api/branches/install-preview',{branchId:result.result.branchId,package:next.body,bindings:{directories:{workspace:destination.root},agents:{},engines:{fixture:'fixture'}}});assert.equal(refused.status,400);assert.match(refused.body.error,/fresh installation/);
 await destination.reopen();assert.equal((await read(dst,target.id)).length,3);noRuns(destination);
});

test('exact pending import membership allows restoration but denies visibility; incomplete cleanup remains journaled until recovery',async t=>{
 const source=await instance(t),destination=await instance(t);await seed(source);const pkg=await exported(source,false),memory=pkg.memory;
 const {operation}=destination.store.beginAgentCreationOperation({projectId:destination.project.id,conversationId:destination.chat.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:randomUUID(),payloadHash:'controlled-pending-memory'}),id=randomUUID();
 destination.store.addAgentCreationOperationMember(operation.id,id,0);destination.store.createAgent(destination.project.id,{title:'Pending import',engine:'fixture',conversationId:destination.chat.id},undefined,id);
 const plan=destination.memory.prepareImportMemory(operation.id,memory);destination.store.updateAgentCreationOperation(operation.id,{result:{phase:'prepared_memory',memoryPlan:plan}});
 const mapping={[source.a.id]:id};await destination.memory.restoreImportMemory(operation.id,memory[0],mapping,plan[0].namespace);
 assert.deepEqual(await read(destination,destination.a.id),[],'existing peer cannot see uncommitted team rows');assert.deepEqual((await destination.memory.exportPackageMemory(destination.chat.id,[destination.a.id])).chunks,[],'pending data cannot escape through export');
 await assert.rejects(destination.memory.restoreImportMemory(operation.id,memory[0],{[source.a.id]:destination.a.id},plan[0].namespace),/membership/);
 const raw=destination.memory.core.database.raw,original=raw.client.getCollection.bind(raw.client);let refuse=true;
 raw.client.getCollection=async args=>{const c=await original(args),remove=c.delete.bind(c);c.delete=async input=>{if(refuse)throw Error('Controlled memory cleanup unavailable');return remove(input);};return c;};
 destination.store.updateAgentCreationOperation(operation.id,{status:'rolling_back'});await assert.rejects(destination.memory.rollbackImportMemory(operation.id),/cleanup unavailable/);assert.ok(destination.store.getAgentCreationOperation(operation.id).result.memoryPlan.length);assert.deepEqual(await read(destination,destination.a.id),[]);
 refuse=false;await destination.reopen();assert.equal(destination.store.getAgentCreationOperation(operation.id).status,'rolled_back');assert.equal(destination.store.getAgent(id),undefined);assert.deepEqual(await read(destination,destination.a.id),[]);noRuns(destination);
});

test('unconfigured memory destination explicitly refuses a memory-bearing package before creating Agents',async t=>{
 const source=await instance(t),destination=await instance(t,false,false);await seed(source);const pkg=await exported(source,false),result=await imported(destination,pkg);assert.equal(result.status,409,result.raw);assert.match(result.body.error,/configure destination local memory/);assert.equal(destination.store.listAgents(destination.project.id).length,2);noRuns(destination);
});
