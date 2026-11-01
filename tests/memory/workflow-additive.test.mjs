import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {BranchStore,CapabilityPolicyStore} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {instance,seed,read,vector} from './portability-fixture.mjs';
const api=async(f,method,url,payload)=>{const r=await f.app.inject({method,url,headers:f.headers,...(payload===undefined?{}:{payload})});return {status:r.statusCode,body:r.json(),raw:r.body};};
const ok=r=>{assert.equal(r.status,200,r.raw);return r.body;};
const noRuns=f=>{for(const table of ['scheduler_runs','agent_activations','provider_operation_outbox'])assert.equal(f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);};
const bindings=f=>({directories:{workspace:f.root},agents:{},engines:{fixture:'fixture'}});
const selection={newAgents:[{chatRef:'chat',agentRef:'new'}],teamChats:['chat']};
const confirm=(f,id,extra={})=>api(f,'POST',`/api/branches/installations/${id}/confirm`,{acknowledgeFullImport:true,acknowledgeMemoryUpdate:true,...extra});
async function rows(f,chatId){const raw=f.memory.core.database.raw;return Promise.all(['memory','log'].map(async kind=>{const c=await raw.client.getCollection({name:raw.names('chat:'+chatId)[kind]});return c.get({include:['documents','metadatas','embeddings']});}));}
const byId=rows=>Object.fromEntries(rows.ids.map((id,i)=>[id,[rows.documents[i],rows.metadatas[i],Array.from(rows.embeddings[i])]]));
function preserve(before,after){for(let i=0;i<before.length;i++){const next=byId(after[i]);for(const [id,row] of Object.entries(byId(before[i])))assert.deepEqual(next[id],row,'Existing record stays byte-equivalent');}}
async function setup(t){
 const source=await instance(t),f=await instance(t);await seed(source);const defs=[];
 for(const [index,a] of [source.a,source.b].entries()){
  const ref=index?'new':'existing',pkg=ok(await api(source,'GET',`/api/agents/${a.id}/export?mode=full`));pkg.rootRef=ref;pkg.agents[0].ref=ref;for(const m of pkg.memory??[])m.agentRefs=Object.fromEntries(Object.keys(m.agentRefs).map(id=>[id,ref]));defs.push({ref,definition:pkg});
 }
 const pkg={schema:'ponderosa.branch-installation.v1',packageId:'additive.workflow',mode:'full',exportedAt:new Date().toISOString(),definition:{schema:'ponderosa.branch.v1',name:'Additive',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Never run a provider'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats:[{ref:'chat',title:'Preserved Chat',agents:defs}],agentBindings:{worker:{chatRef:'chat',agentRef:'existing'}}};
 const initial=structuredClone(pkg);initial.mode='template';initial.chats[0].agents=initial.chats[0].agents.slice(0,1);for(const a of initial.chats[0].agents){a.definition.mode='template';delete a.definition.memory;delete a.definition.agents[0].history;delete a.definition.agents[0].artifacts;}
 const plan=ok(await api(f,'POST','/api/branches/install-preview',{package:initial,bindings:bindings(f)})),installed=ok(await confirm(f,plan.id));assert.equal(installed.state,'completed',installed.error);
 const branchId=installed.branchId,config=ok(await api(f,'GET',`/api/branches/${branchId}/configuration`)),old=f.store.getAgent(config.agents.worker),chat=f.store.getConversation(old.conversationId);
 const scoped=Object.assign(Object.create(f),{chat,a:old,b:old});await seed(scoped);
 f.memory.setGrant(chat.id,true,0,'branches');new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'global',scopeId:'ponderosa',expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts],actor:'operator',reason:'Retain destination script policy'});
 const global=await f.memory.core.database.raw.client.getCollection({name:f.memory.core.database.raw.names('global').memory}),globalBefore=await global.get({include:['documents','metadatas','embeddings']});
 const before=await rows(f,chat.id),permissions=structuredClone(old.managementPermissions),policies=f.store.sqlite.prepare('SELECT * FROM capability_policies ORDER BY scope_kind,scope_id').all(),grants=f.memory.policy.prepare('SELECT * FROM local_memory_chat_grants ORDER BY chat_id').all();
 pkg.chats[0].agents[0].definition.agents[0].managementPermissions.allowAutomaticDescendantDeletion=true;
 const preview=async(sel=selection,portable=pkg)=>api(f,'POST','/api/branches/install-preview',{branchId,package:portable,bindings:bindings(f),...(sel===undefined?{}:{memorySelection:sel})});
 const authority=async()=>{assert.deepEqual(await global.get({include:['documents','metadatas','embeddings']}),globalBefore);assert.deepEqual(f.store.getAgent(old.id).managementPermissions,permissions);assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM capability_policies ORDER BY scope_kind,scope_id').all(),policies);assert.deepEqual(f.memory.policy.prepare('SELECT * FROM local_memory_chat_grants ORDER BY chat_id').all(),grants);noRuns(f);};
 const unchanged=async()=>{assert.deepEqual(await rows(f,chat.id),before);await authority();};
 return {f,source,pkg,branchId,old,chat,before,preview,unchanged,authority,scoped,permissions};
}

test('reviewed new Agent/private and preserved Chat/team additions preserve existing memory/authority across reopen and same-plan retry',async t=>{
 const x=await setup(t),{f}=x;const plan=ok(await x.preview());assert.equal(plan.memoryUpdateReview.incoming.length,1);assert.equal(plan.memoryUpdateReview.incoming[0].snapshot.chunks.length,3);assert.equal(plan.memoryUpdateReview.incoming[0].snapshot.conflicts.length,1);assert.equal(plan.memoryUpdateReview.excludedRows,4);assert.ok(plan.memoryUpdateReview.destination[0].chunks.length);
 const refused=await confirm(f,plan.id,{acknowledgeMemoryUpdate:false});assert.equal(refused.status,409);assert.match(refused.body.error,/acknowledgement.*additive memory/);await x.unchanged();
 const result=ok(await confirm(f,plan.id));assert.equal(result.state,'completed',result.error);preserve(x.before,await rows(f,x.chat.id));assert.deepEqual(f.store.getAgent(x.old.id).managementPermissions,x.permissions);
 const resource=f.store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref='new' AND state='active'").get(x.branchId),fresh=f.store.getAgent(resource.local_id);assert.equal(fresh.conversationId,x.chat.id);assert.notEqual(fresh.id,x.source.b.id);
 const visible=await read(x.scoped,fresh.id);assert.equal(visible.filter(r=>r.text==='EXCLUDED_PRIVATE_FACT').length,1,'Only the selected new Agent private fact is visible');assert.equal(visible.some(r=>r.text==='Included private fact'),false,'Existing source Agent private memory excluded');
 await x.authority();const inventory=await rows(f,x.chat.id);assert.deepEqual(ok(await confirm(f,plan.id)),result);assert.deepEqual(await rows(f,x.chat.id),inventory);noRuns(f);
 await f.reopen();preserve(x.before,await rows(f,x.chat.id));assert.deepEqual(f.store.getAgent(x.old.id).managementPermissions,x.permissions);const exported=ok(await api(f,'GET',`/api/branches/${x.branchId}/package?mode=full`));assert.ok(exported.chats[0].agents.some(a=>a.ref==='new'&&a.definition.memory[0].snapshot.chunks.length));noRuns(f);
});

test('unselected/stale/foreign/removal/source-collision previews refuse or explicitly exclude without touching existing data',async t=>{
 const x=await setup(t),{f}=x;
 for(const sel of [null,false,{newAgents:[{chatRef:'chat',agentRef:'existing'}],teamChats:[]},{newAgents:[],teamChats:['chat']},{...selection,extra:true}]){const r=await x.preview(sel);assert.equal(r.status,400,r.raw);await x.unchanged();}
 const missing=await api(f,'POST','/api/branches/install-preview',{branchId:x.branchId,package:x.pkg,bindings:bindings(f)});assert.equal(missing.status,400);assert.match(missing.body.error,/explicit additive/);
 const foreign=structuredClone(x.pkg);foreign.packageId='foreign';assert.equal((await x.preview(selection,foreign)).status,400);
 const removed=structuredClone(x.pkg);removed.chats[0].agents.shift();removed.agentBindings.worker.agentRef='new';assert.equal((await x.preview(selection,removed)).status,400);
 const collision=structuredClone(x.pkg),team=collision.chats[0].agents[0].definition.memory[0].snapshot.chunks.find(r=>r.stamp.audience.endsWith(':team'));collision.chats[0].agents[1].definition.memory[0].snapshot.chunks.find(r=>r.id===team.id).text='Conflicting source ID';assert.equal((await x.preview(selection,collision)).status,400);await x.unchanged();
 const empty=ok(await x.preview({newAgents:[],teamChats:[]}));assert.deepEqual(empty.memoryUpdateReview.incoming,[]);assert.equal(empty.memoryUpdateReview.excludedRows,8);
 const stale=ok(await x.preview());f.store.updateAgent(x.old.id,{title:'Human edit'});assert.equal((await confirm(f,stale.id)).status,409);f.store.updateAgent(x.old.id,{title:x.old.title});
 const memoryStale=ok(await x.preview());const raw=f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+x.chat.id).memory});await c.update({ids:[x.before[0].ids[0]],documents:['Human memory edit'],embeddings:[vector]});const edited=await rows(f,x.chat.id);const result=await confirm(f,memoryStale.id);assert.equal(result.status,409);assert.match(result.body.error,/Destination memory changed/);assert.deepEqual(await rows(f,x.chat.id),edited);noRuns(f);
});

async function retry(f,id){f.store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL WHERE id=?').run(id);return ok(await confirm(f,id));}
async function blockPublish(x,operation){const original=BranchStore.prototype.deploy;BranchStore.prototype.deploy=function(input,...args){if(input.idempotencyKey==='install:'+operation)throw Error('Controlled publication unavailable');return original.call(this,input,...args);};try{return ok(await confirm(x.f,operation));}finally{BranchStore.prototype.deploy=original;}}

test('failed staged publication hides additions, rejects edited deterministic IDs without overwrite, and retries the same completed Agent receipt',async t=>{
 const x=await setup(t),plan=ok(await x.preview()),state=await blockPublish(x,plan.id);assert.equal(state.state,'applying');assert.match(state.error,/Controlled publication/);
 assert.equal((await read(x.scoped,x.old.id)).filter(r=>r.text==='Revised seeded team fact 😀').length,1,'Unpublished team addition hidden');
 const staged=x.f.store.sqlite.prepare("SELECT * FROM branch_installation_resources WHERE staging_plan_id=? AND agent_ref='new'").get(plan.id),op=x.f.store.getAgentCreationOperation(staged.creation_operation_id);assert.equal(op.status,'completed');assert.ok(op.result.memoryPlan.length);
 const raw=x.f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+x.chat.id).memory}),id=op.result.memoryPlan[0].chunkIds[0],original=await c.get({ids:[id],include:['documents','metadatas','embeddings']});await c.update({ids:[id],documents:['Explicit staged edit'],embeddings:[vector]});const before=await rows(x.f,x.chat.id),collision=await retry(x.f,plan.id);assert.equal(collision.state,'applying');assert.match(collision.error,/collision/);assert.deepEqual(await rows(x.f,x.chat.id),before,'Collision must not replace or delete the edited record');
 await c.update({ids:[id],documents:original.documents,embeddings:original.embeddings.map(v=>Array.from(v))});const done=await retry(x.f,plan.id);assert.equal(done.state,'completed',done.error);assert.equal(x.f.store.getAgent(staged.local_id).id,staged.local_id);assert.equal(x.f.store.getAgentCreationOperation(op.id).status,'completed');preserve(x.before,await rows(x.f,x.chat.id));noRuns(x.f);
});

test('cancel compensates completed staged team/private memory on a preserved Chat and retains destination data',async t=>{
 const x=await setup(t),plan=ok(await x.preview());assert.equal((await blockPublish(x,plan.id)).state,'applying');const staged=x.f.store.sqlite.prepare("SELECT * FROM branch_installation_resources WHERE staging_plan_id=? AND agent_ref='new'").get(plan.id);
 const result=ok(await api(x.f,'POST',`/api/branches/installations/${plan.id}/cancel`,{}));assert.equal(result.state,'canceled',result.error);assert.equal(x.f.store.getAgent(staged.local_id),undefined);await x.unchanged();assert.equal(x.f.store.getAgentCreationOperation(staged.creation_operation_id)?.result?.memoryPlan,undefined);
});

test('partial physical memory write fails visibly, rolls back its rows, and same-plan retry adds no duplicate facts',async t=>{
 const x=await setup(t),plan=ok(await x.preview()),raw=x.f.memory.core.database.raw,get=raw.client.getCollection.bind(raw.client);let writes=0;
 raw.client.getCollection=async args=>{const c=await get(args),upsert=c.upsert.bind(c);c.upsert=async input=>{if(input.metadatas?.some(m=>m.host_package_operation)&&++writes===2)throw Error('Controlled second additive write failure');return upsert(input);};return c;};let state;try{state=ok(await confirm(x.f,plan.id));}finally{raw.client.getCollection=get;}
 assert.equal(state.state,'applying');assert.match(state.error,/Controlled second additive write failure/);await x.unchanged();const done=await retry(x.f,plan.id);assert.equal(done.state,'completed',done.error);const after=await rows(x.f,x.chat.id);assert.equal(after[0].ids.length,x.before[0].ids.length+3);assert.equal(after[1].ids.length,x.before[1].ids.length+1);assert.equal((await retry(x.f,plan.id)).state,'completed');assert.deepEqual(await rows(x.f,x.chat.id),after);noRuns(x.f);
});

test('destination edits during staged recovery require a new review and compensate only hidden additions',async t=>{
 const x=await setup(t),plan=ok(await x.preview());assert.equal((await blockPublish(x,plan.id)).state,'applying');
 const raw=x.f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+x.chat.id).memory}),id=x.before[0].ids[0];await c.update({ids:[id],documents:['Concurrent operator edit'],embeddings:[vector]});
 const done=await retry(x.f,plan.id);assert.equal(done.state,'review_required',done.error);assert.match(done.error,/Destination memory changed/);
 const actual=await rows(x.f,x.chat.id);assert.equal(actual[0].ids.length,x.before[0].ids.length);assert.equal(actual[1].ids.length,x.before[1].ids.length);assert.equal(byId(actual[0])[id][0],'Concurrent operator edit');
 for(let i=0;i<x.before.length;i++)for(const [key,row]of Object.entries(byId(x.before[i])))if(key!==id)assert.deepEqual(byId(actual[i])[key],row);
 await x.authority();assert.equal(x.f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE staging_plan_id=? AND state IN ('staging','retiring')").get(plan.id).n,0);noRuns(x.f);
});
