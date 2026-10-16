// Canonical archive regressions; no provider/model calls. Fake retrieval port
// below proves only host revalidation across asynchronous responses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { AgentStore, WorkspaceStore, CoordinationV3Store } from '@ponderosa/agents';
import { PONDEROSA_MEMORY_TOOLS } from '@ponderosa/core';
import { registerMemoryRoutes } from '../dist/routes/memory.js';
import { MemoryAuthority } from '../dist/memory-authority.js';
import { registerRequestSecurityHooks } from '../dist/server-request-hooks.js';
import { registerProductScope, rewriteProductUrl } from '../dist/product-scope.js';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-host-'));
  const store = new AgentStore(root), workspace = new WorkspaceStore(root), c = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({label:'P1',hostPath:root,defaultEngine:'codex'});
  const other = store.createProject({label:'P2',hostPath:root,defaultEngine:'claude'});
  const caps = new Map(), active = new Map(), unavailable = new Set();
  const opts = {dataDir:root,engines:[],authToken:'disposable-operator',memoryEnabled:true,...overrides};
  const ports = {store,opts,agentMessageCapabilities:caps,activeRuns:active,
    unavailable:(p,a,chat)=>[p,a,chat].some(id=>unavailable.has(id))};
  ports.capabilityOwnsAuthoritativeRun=createRuntimeAuthority({coordinationV3:c,coordinationV3WorkerId:'memory-test',activeRuns:active,agentMessageCapabilities:caps}).capabilityOwnsAuthoritativeRun;
  const authority = new MemoryAuthority(ports);
  const app = Fastify({rewriteUrl:rewriteProductUrl});
  registerProductScope(app,store,workspace,req=>caps.get(req.headers.authorization?.replace(/^Bearer\s+/i,''))?.conversationId,()=>false);
  registerRequestSecurityHooks(app,{opts,v3DispatchKey:'disposable-dispatch',agentMessageCapabilities:caps,deletingAgentIds:new Set(),validLauncherSession:()=>false,artifactFilesystemError:()=>undefined,isArtifactDependentWorkIntake:()=>false,isPublicWebAssetRequest:()=>false});
  registerMemoryRoutes(app,ports);
  t.after(async()=>{await app.close();store.close();rmSync(root,{recursive:true,force:true});});
  function run(p=project, chat=store.getConversation(p.lastConversationId)) {
    const a=store.createAgent(p.id,{title:'Fixture Agent',engine:'codex',conversationId:chat.id});
    c.coordinate({projectId:p.id,conversationId:chat.id,actorScope:'operator:memory-test',idempotencyKey:a.id,requests:[{requestId:a.id,recipientAgentId:a.id,lifetime:{kind:'indefinite'},payload:{text:'fixture'}}]});
    const lease=c.leaseNextRun({workerId:'memory-test'});assert.equal(lease.agentId,a.id);
    const token=`run-${a.id}`,cap={agentId:a.id,conversationId:chat.id,runId:lease.runId,v3SchedulerRunId:lease.runId,v3FencingToken:lease.fencingToken,availableToolNames:PONDEROSA_MEMORY_TOOLS.map(t=>t.name)};
    caps.set(token,cap);active.set(a.id,{...cap,messageCapability:token});return {a,chat,token,cap,lease};
  }
  async function call(body,token='disposable-operator',url=`/api/projects/${project.id}/memories`,method='POST') {
    return app.inject({method,url,headers:{authorization:`Bearer ${token}`},payload:body});
  }
  const save=(key='save',extras={})=>({operation:'save',text:'Keep credentials local',commandKey:key,...extras});
  return {root,store,workspace,c,project,other,caps,active,ports,authority,app,run,call,save,unavailable};
}


import { createRuntimeAuthority } from '../dist/runtime-authority.js';
import { registerConversationRoutes } from '../dist/routes/conversations.js';
import { createCommunicationProjectionReconciler } from '../dist/communication-projection-reconciler.js';

function archiveRoute(f) {
  const deleting=new Set(), unexpected=()=>{throw Error('unexpected unrelated port');};
  f.ports.unavailable=(p,a,chat)=>[p,a,chat].some(id=>f.unavailable.has(id))||deleting.has(chat);
  const reconciliation=createCommunicationProjectionReconciler({store:f.store,coordinationV3:f.c,assets:undefined,
    projectDeletionInProgress:p=>f.unavailable.has(p),agentDeletionInProgress:a=>f.unavailable.has(a),conversationDeletionInProgress:id=>deleting.has(id),
    attachmentDeletionInProgress:()=>false,assetReconciliationInProgress:()=>false,conversationDeliveryLeases:new Map(),agentDeliveryLeases:new Map(),
    recordCommunication:unexpected,projectCommunicationArtifact:unexpected,communicationArtifactAccess:unexpected,
    scheduleCommunicationReconciliation:()=>{},logError:unexpected,logInfo:()=>{},projectCommunicationToAgentAudit:unexpected});
  registerConversationRoutes(f.app,{store:f.store,workspace:f.workspace,engines:new Map(),cachedModelOptions:unexpected,
    appendWorkspace:event=>f.workspace.append(event),generateConversationTitle:unexpected,conversationDetail:unexpected,agentHealth:unexpected,teamDirectory:unexpected,
    hasActiveRun:a=>f.active.has(a),projectDeletionInProgress:p=>f.unavailable.has(p),deletingConversationIds:deleting,
    agentCreationConversationLeases:new Map(),conversationDeliveryLeases:new Map(),
    reconcileConversationRuntimeCommunicationProjections:reconciliation.reconcileConversationRuntimeCommunicationProjections,
    refreshTriggers:async()=>{},processConversationDeletionCleanup:unexpected});
  return async (chat,archived)=>{
    const response=await f.call({archived,defaultEngine:null,defaultModel:null,defaultEffort:null,defaultSpeed:null},undefined,`/api/conversations/${chat.id}`,'PATCH');
    assert.equal(response.statusCode,200,response.body);
    assert.equal(f.store.getConversation(chat.id).archived,archived);
    assert.equal(deleting.size,0,'temporary archive guard has ended');
  };
}
function snapshot(f) {
  return Object.fromEntries(['memories','memory_revisions','memory_index_intents','memory_commands','memory_tombstones','memory_scope_generations','memory_fts'].map(table=>[table,f.store.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('authenticated Chat archive denies public operations, cached reads and every receipt replay without writes; live sibling and current unarchive retain authority',async t=>{
  const f=fixture(t),r=f.run(),sibling=f.run(f.project,f.store.createConversation(f.project.id,{title:'Live sibling'})),archive=archiveRoute(f);
  const api=body=>f.call(body,r.token,'/api/agent-memory');
  const save=f.save('before'),savedResponse=await api(save);assert.equal(savedResponse.statusCode,200,savedResponse.body);const saved=savedResponse.json();
  const update={operation:'update',memoryId:saved.memoryId,expectedRevision:1,text:'current sentinel',commandKey:'updated'};
  const updatedResponse=await api(update);assert.equal(updatedResponse.statusCode,200);const updated=updatedResponse.json();
  const discarded=(await api(f.save('discard'))).json();
  const forget={operation:'forget',memoryId:discarded.memoryId,expectedRevision:1,commandKey:'forgotten'};
  assert.equal((await api(forget)).statusCode,200);
  const global=f.authority.forOperator('dev').save({scope:'global',text:'global sentinel',classification:'user_statement',commandKey:'global'});
  f.authority.setGrant(f.project.id,'dev',true,0);
  const reader=f.authority.forAgent(r.token,'ponderosa_memory_get'),search=f.authority.forAgent(r.token,'ponderosa_memory_search');
  const writer=f.authority.forAgent(r.token,'ponderosa_memory_save'),editor=f.authority.forAgent(r.token,'ponderosa_memory_update'),remover=f.authority.forAgent(r.token,'ponderosa_memory_forget');
  assert.equal(reader.get(saved.memoryId).text,'current sentinel');assert.ok(reader.get(global.memoryId));
  const before=snapshot(f);
  await archive(r.chat,true);
  assert.equal(f.store.getAgent(r.a.id).archived,false);
  assert.equal(f.c.ownsRun(r.lease.runId,r.lease.fencingToken,'memory-test'),true,'archive regression must exercise an otherwise owned Run');
  for(const body of [{operation:'get',memoryId:saved.memoryId},{operation:'search',query:'sentinel'},{operation:'search',query:'!!!'},f.save('after'),{operation:'update',memoryId:saved.memoryId,expectedRevision:2,text:'forbidden',commandKey:'after-update'},{operation:'forget',memoryId:saved.memoryId,expectedRevision:2,commandKey:'after-forget'},save,update,forget]) {
    const response=await api(body);assert.equal(response.statusCode,403,`${body.operation}: ${response.body}`);
    assert.ok(!response.body.includes('sentinel')&&!response.body.includes(saved.memoryId),'deny before content/receipt disclosure');
  }
  for(const access of [()=>reader.get(saved.memoryId),()=>reader.get(global.memoryId),()=>reader.history(saved.memoryId),()=>reader.hydrate([updated,global]),()=>reader.list(),()=>search.search('sentinel'),()=>reader.scopeGenerations(),
    ()=>writer.save({...save,classification:'agent_inference'}),()=>editor.update(saved.memoryId,1,{...update,classification:'agent_inference'}),()=>remover.forget(discarded.memoryId,1,'forgotten')]) assert.throws(access,/owner is unavailable/);
  assert.deepEqual(snapshot(f),before,'archive denial creates no records/revisions/intents/receipts or other memory state');
  const siblingGet=await f.call({operation:'get',memoryId:saved.memoryId},sibling.token,'/api/agent-memory');assert.equal(siblingGet.statusCode,200);assert.equal(siblingGet.json().text,'current sentinel');
  assert.equal((await f.call(f.save('sibling-write'),sibling.token,'/api/agent-memory')).statusCode,200);
  await archive(r.chat,false);
  assert.equal(reader.get(saved.memoryId).text,'current sentinel');
  assert.deepEqual((await api(save)).json(),saved,'same authoritative Run can replay after unarchive');
  assert.equal((await api(f.save('unarchived-write'))).statusCode,200);
});

test('unarchive never revives a cancelled Run or its cached resolver and receipts',async t=>{
  const f=fixture(t),r=f.run(),archive=archiveRoute(f),input=f.save('before-cancel');
  const saved=(await f.call(input,r.token,'/api/agent-memory')).json(),reader=f.authority.forAgent(r.token,'ponderosa_memory_get');
  await archive(r.chat,true);
  f.c.cancelAgentRun({agentId:r.a.id,idempotencyKey:'cancel-archived',expectedRunId:r.lease.runId});
  await archive(r.chat,false);
  assert.equal(f.c.ownsRun(r.lease.runId,r.lease.fencingToken,'memory-test'),false);
  const before=snapshot(f);
  assert.throws(()=>reader.get(saved.memoryId),/authorized|fenced/);
  assert.equal((await f.call(input,r.token,'/api/agent-memory')).statusCode,403);
  assert.deepEqual(snapshot(f),before);
  f.c.coordinate({projectId:f.project.id,conversationId:r.chat.id,actorScope:'operator:memory-test',idempotencyKey:'replacement',requests:[{requestId:'replacement',recipientAgentId:r.a.id,lifetime:{kind:'indefinite'},payload:{text:'replacement'}}]});
  const lease=f.c.leaseNextRun({workerId:'memory-test'});assert.equal(lease.agentId,r.a.id);
  const token='replacement-token',cap={...r.cap,runId:lease.runId,v3SchedulerRunId:lease.runId,v3FencingToken:lease.fencingToken};
  f.caps.set(token,cap);f.active.set(r.a.id,{...cap,messageCapability:token});
  assert.equal((await f.call({operation:'get',memoryId:saved.memoryId},token,'/api/agent-memory')).statusCode,200,'new canonical Run/fence for same Agent can read after unarchive');
  assert.throws(()=>reader.get(saved.memoryId),/authorized|fenced/,'old cached resolver remains stale after replacement');
  assert.equal((await f.call(input,r.token,'/api/agent-memory')).statusCode,403);
});
