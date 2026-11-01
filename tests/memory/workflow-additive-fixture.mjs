import assert from 'node:assert/strict';
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


export {api,ok,noRuns,bindings,selection,confirm,rows,byId,preserve,setup};
