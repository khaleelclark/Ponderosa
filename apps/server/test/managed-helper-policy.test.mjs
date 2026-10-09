import assert from 'node:assert/strict';
import test from 'node:test';
import {PONDEROSA_CREATE_MANAGED_AGENT_TOOL,PONDEROSA_MANAGE_TOOL} from '@ponderosa/core';
import {createProviderDynamicToolHandler} from '../dist/routes/provider-dynamic-tool-handler.js';
import {fixture,helper,counters,inertDenied} from './managed-helper-policy.fixture.mjs';
const operations=[{kind:'create_agent',ref:'child',title:'Scaffold child',engine:'codex'}];
const restrict=f=>f.policies.put({scopeKind:'agent',scopeId:f.owner.id,expectedRevision:f.policies.get('agent',f.owner.id)?.revision??0,restrictedCapabilityIds:[helper]});
const allow=f=>f.policies.put({scopeKind:'agent',scopeId:f.owner.id,expectedRevision:f.policies.get('agent',f.owner.id)?.revision??0,restrictedCapabilityIds:[]});

test('canonical frozen-absent Run stays denied after Allow, including direct and management transports',{timeout:20000},async t=>{
 const f=await fixture(t,{restricted:true});assert.equal(f.tools.includes(PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name),false);assert.ok(f.tools.includes(PONDEROSA_MANAGE_TOOL.name));
 await inertDenied(f,()=>f.spawn(),401);allow(f);await inertDenied(f,()=>f.spawn(),401);
 await inertDenied(f,()=>f.manage({action:'plan',idempotencyKey:'absent',operations}),403);
 const before=await counters(f);const handler=createProviderDynamicToolHandler(f.app,[],f.token);
 const result=await handler({name:PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name,arguments:{}});assert.equal(result.success,false);assert.deepEqual(await counters(f),before);
 const describe=await f.manage({action:'describe'});assert.equal(describe.statusCode,200,describe.body);assert.equal(describe.json().permissions.autonomous.includes('create_agent'),false);
});

for(const branch of [false,true])test(`canonical allowed ${branch?'Branch':'Dev'} tracked creation is atomic and concurrent replay is stable`,{timeout:20000},async t=>{
 const f=await fixture(t,{branch});assert.ok(f.tools.includes(PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name));
 const results=await Promise.all([f.spawn('same'),f.spawn('same')]);for(const r of results)assert.equal(r.statusCode,200,r.body);
 const first=results[0].json();assert.equal(results[1].json().agent.id,first.agent.id);assert.ok(first.requestId);assert.ok(first.joinId);
 const child=f.store.getAgent(first.agent.id);assert.equal(child.projectId,f.p.id);assert.equal(child.conversationId,f.chat.id);assert.equal(child.managerAgentId,f.owner.id);assert.equal(child.spawnedByAgentId,f.owner.id);
 const opening=f.coordination.getRequest(first.requestId);assert.equal(opening.recipientAgentId,child.id);
 const communication=f.store.sqlite.prepare('SELECT audience_json,intent FROM runtime_communications WHERE id=?').get(`managed-opening:${child.id}`);assert.equal(communication.intent,'collaboration');assert.deepEqual(JSON.parse(communication.audience_json),{kind:'agents',agentIds:[child.id]});
 assert.equal(f.store.listAgents(f.p.id).filter(a=>a.managerAgentId===f.owner.id).length,1);assert.equal(f.starts(),1);
 await inertDenied(f,()=>f.spawn('same',{text:'Different work'}),409);
 const noJoin=await f.spawn('no-join',{awaitResult:false});assert.equal(noJoin.statusCode,200,noJoin.body);assert.ok(noJoin.json().requestId);assert.equal(noJoin.json().joinId,undefined);
 restrict(f);await inertDenied(f,()=>f.spawn('same'),403);
});

test('live revocation and inherited Chat/product/Run policy deny a frozen-present Run before any domain effects',{timeout:20000},async t=>{
 const f=await fixture(t);for(const [scopeKind,scopeId] of [['agent',f.owner.id],['chat',f.chat.id],['product','interactive'],['run',f.runRow().id]]){
  f.policies.put({scopeKind,scopeId,expectedRevision:0,restrictedCapabilityIds:[helper]});
  await inertDenied(f,()=>f.spawn(scopeKind),403);await inertDenied(f,()=>f.manage({action:'plan',idempotencyKey:scopeKind,operations}),403);
  f.policies.put({scopeKind,scopeId,expectedRevision:1,restrictedCapabilityIds:[]});
 }
});

test('management scaffold and replay remain unassigned; revocation denies planned creation without changing the plan',{timeout:20000},async t=>{
 const f=await fixture(t);const planned=await f.manage({action:'plan',idempotencyKey:'plan',operations});assert.equal(planned.statusCode,200,planned.body);const planId=planned.json().planId;
 restrict(f);await inertDenied(f,()=>f.manage({action:'apply',planId}),403);allow(f);
 const before=await counters(f),applied=await f.manage({action:'apply',planId});assert.equal(applied.statusCode,200,applied.body);
 const after=await counters(f);assert.equal(after.agents.length,before.agents.length+1);for(const table of ['coordination_requests','coordination_joins','runtime_communications','agent_activations','scheduler_runs'])assert.deepEqual(after[table],before[table]);
 restrict(f);const replay=await f.manage({action:'apply',planId});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);
});

test('canonical stale fence, foreign bearer, archived Chat and pending deletion deny before creation receipts',{timeout:20000},async t=>{
 const f=await fixture(t);
 await inertDenied(f,()=>f.app.inject({method:'POST',url:'/api/agent-spawn',headers:{authorization:'Bearer foreign'},payload:{}}),401);
 f.store.updateConversation(f.chat.id,{archived:true});await inertDenied(f,()=>f.spawn('archived'),404);f.store.updateConversation(f.chat.id,{archived:false});
 f.store.markConversationDeletionPending(f.chat.id);await inertDenied(f,()=>f.spawn('deleting'),409);
 f.store.sqlite.prepare('DELETE FROM conversation_deletion_receipts WHERE conversation_id=?').run(f.chat.id);
 f.coordination.cancelAgentRun({agentId:f.owner.id,idempotencyKey:'stale',expectedRunId:f.runRow().id});
 await inertDenied(f,()=>f.spawn('stale'),401,{cancellation:true});
});

test('creation plan is bound to exact canonical Run; a later admitted Run cannot apply it',{timeout:20000},async t=>{
 const f=await fixture(t);const planned=await f.manage({action:'plan',idempotencyKey:'bound',operations});assert.equal(planned.statusCode,200,planned.body);
 const admitted=f.nextAdmission(f.owner.id);
 const queued=await f.app.inject({method:'POST',url:`/api/agents/${f.owner.id}/messages`,payload:{text:'Next inert Run',idempotencyKey:'next-run',activeRunDelivery:'queue'}});assert.ok(queued.statusCode<300,queued.body);f.release();
 const options=await admitted;const headers={authorization:`Bearer ${options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN}`};
 const before=await counters(f);const response=await f.app.inject({method:'POST',url:'/api/agent-management',headers,payload:{action:'apply',planId:planned.json().planId}});assert.equal(response.statusCode,409,response.body);
 const after=await counters(f);for(const table of ['agents','agent_creation_operations','agent_creation_operation_members','coordination_requests','coordination_joins','runtime_communications','agent_management_plans'])assert.deepEqual(after[table],before[table]);
});

for(const revoke of ['policy','fence'])test(`actual awaited stop then ${revoke} revocation preserves its receipt and denies later scaffold creation`,{timeout:20000},async t=>{
 const f=await fixture(t,{maxConcurrentRuns:2});
 const child=f.store.createAgent(f.p.id,{title:'Running child',engine:'codex',conversationId:f.chat.id,managerAgentId:f.owner.id});const admitted=f.nextAdmission(child.id);
 const sent=await f.app.inject({method:'POST',url:`/api/agents/${child.id}/messages`,payload:{text:'Inert child Run',idempotencyKey:'child-run',activeRunDelivery:'queue'}});assert.ok(sent.statusCode<300,sent.body);await admitted;
 const plan=await f.manage({action:'plan',idempotencyKey:'stop-then-create',operations:[{kind:'stop_agent',targetAgentId:child.id},...operations]});assert.equal(plan.statusCode,200,plan.body);
 f.setStopResponseEffect(async id=>{if(id===child.id&&revoke==='fence'){f.coordination.cancelAgentRun({agentId:f.owner.id,idempotencyKey:'awaited-fence',expectedRunId:f.runRow().id});}else if(id===child.id){const response=await f.app.inject({method:'PUT',url:`/api/agents/${f.owner.id}/capabilities`,payload:{revision:0,restrictedCapabilityIds:[helper]}});assert.equal(response.statusCode,200,response.body);}});
 const before=f.store.listAgents(f.p.id).length;const applied=await f.manage({action:'apply',planId:plan.json().planId});assert.equal(applied.statusCode,revoke==='policy'?403:401,applied.body);assert.equal(applied.json().partialChangesPossible,true);assert.equal(f.store.listAgents(f.p.id).length,before);
 const durable=f.store.getAgentManagementPlan(plan.json().planId);assert.deepEqual(durable.operationProgress.map(p=>p.kind),['stop_agent']);assert.equal(durable.status,'applying');assert.equal(f.coordination.cancellationReceipt(child.id,`${durable.id}:0`).cancelled,true);
});

test('Pinecone explicit Allow admits creation only in a later normally prepared Run',{timeout:20000},async t=>{
 const f=await fixture(t,{pinecone:true});await inertDenied(f,()=>f.spawn('before-optin'),401);
 const saved=await f.app.inject({method:'PUT',url:`/api/agents/${f.owner.id}/capabilities`,payload:{revision:1,restrictedCapabilityIds:[]}});assert.equal(saved.statusCode,200,saved.body);await inertDenied(f,()=>f.spawn('same-run'),401);
 const admitted=f.nextAdmission(f.owner.id);const queued=await f.app.inject({method:'POST',url:`/api/agents/${f.owner.id}/messages`,payload:{text:'Explicit later task',idempotencyKey:'after-optin',activeRunDelivery:'queue'}});assert.ok(queued.statusCode<300,queued.body);f.release();const next=await admitted;
 assert.ok(JSON.parse(next.environment.PONDEROSA_AGENT_TOOL_NAMES).includes(PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name));f.headers.authorization=`Bearer ${next.environment.PONDEROSA_AGENT_MESSAGE_TOKEN}`;
 const created=await f.spawn('allowed-later');assert.equal(created.statusCode,200,created.body);assert.ok(created.json().requestId);assert.ok(created.json().joinId);assert.equal(f.store.listAgents(f.p.id).length,2);assert.equal(f.store.getPineconeProfile(f.owner.id).agentId,f.owner.id);
});

test('ordinary scoped approval/apply/replay remains compatible after helper revocation',{timeout:20000},async t=>{
 const f=await fixture(t);const child=f.store.createAgent(f.p.id,{title:'Reorganize child',engine:'codex',conversationId:f.chat.id,managerAgentId:f.owner.id}),sibling=f.store.createAgent(f.p.id,{title:'Sibling manager',engine:'codex',conversationId:f.chat.id,managerAgentId:f.owner.id});
 const planned=await f.manage({action:'plan',idempotencyKey:'approval',operations:[{kind:'set_manager',targetAgentId:child.id,managerAgentId:sibling.id}]});assert.equal(planned.statusCode,200,planned.body);assert.ok(planned.json().approvalDecisionId);
 await inertDenied(f,()=>f.manage({action:'apply',planId:planned.json().planId}),409);
 restrict(f);const approved=await f.app.inject({method:'POST',url:`/api/decisions/${planned.json().approvalDecisionId}/respond`,payload:{optionId:'approve'}});assert.equal(approved.statusCode,200,approved.body);
 const applied=await f.manage({action:'apply',planId:planned.json().planId});assert.equal(applied.statusCode,200,applied.body);assert.equal(f.store.getAgent(child.id).managerAgentId,sibling.id);
 const replay=await f.manage({action:'apply',planId:planned.json().planId});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);
});

for(const state of ['staging','retiring'])test(`direct creation denies ${state} installed ownership before a receipt`,{timeout:20000},async t=>{
 const f=await fixture(t,{branch:true});f.store.sqlite.prepare(`INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?, 'fixture', 'work', 'owner', ?, ?)`).run(f.chat.branchId,f.owner.id,state);
 await inertDenied(f,()=>f.spawn(state),404);await inertDenied(f,()=>f.manage({action:'plan',idempotencyKey:state,operations}),404);
});

test('install update, lineage resolution error, foreign Chat and owner Project deletion fail closed',{timeout:20000},async t=>{
 const f=await fixture(t,{branch:true});const sql=f.store.sqlite;
 sql.prepare(`INSERT INTO branch_installation_plans(id,branch_id,package_json,bindings_json,preview_json,state,created_at) VALUES('fixture-update',?,'{}','{}','{}','applying',?)`).run(f.chat.branchId,new Date().toISOString());await inertDenied(f,()=>f.spawn('installing'),409);sql.prepare("DELETE FROM branch_installation_plans WHERE id='fixture-update'").run();
 sql.prepare('UPDATE agents SET spawned_by_agent_id=? WHERE id=?').run(f.owner.id,f.owner.id);await inertDenied(f,()=>f.spawn('policy-error'),403);sql.prepare('UPDATE agents SET spawned_by_agent_id=NULL WHERE id=?').run(f.owner.id);
 const another=f.store.createConversation(f.p.id,{title:'Foreign current Chat'});sql.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run(another.id,f.owner.id);await inertDenied(f,()=>f.spawn('foreign-chat'),404);sql.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run(f.chat.id,f.owner.id);
 f.store.markProjectDeletionPending(f.p.id);await inertDenied(f,()=>f.spawn('project-deletion'),409);
});

test('pending creation, archived and deleted owner cannot use an otherwise admitted bearer',{timeout:20000},async t=>{
 const f=await fixture(t);f.store.updateAgent(f.owner.id,{archived:true});await inertDenied(f,()=>f.spawn('archived-owner'),404);f.store.updateAgent(f.owner.id,{archived:false});
 const operation=f.store.beginAgentCreationOperation({projectId:f.p.id,actorScope:'fixture:pending',kind:'human',idempotencyKey:'pending-owner',payloadHash:'fixture'}).operation;f.store.addAgentCreationOperationMember(operation.id,f.owner.id,0);assert.equal(f.store.agentCreationPending(f.owner.id),true);
 await inertDenied(f,()=>f.spawn('pending-owner'),409);f.store.updateAgentCreationOperation(operation.id,{status:'completed',result:{agentId:f.owner.id}});
 f.store.deleteAgent(f.owner.id,id=>f.coordination.handleAgentDeletion(id));await inertDenied(f,()=>f.spawn('deleted-owner'),401,{cancellation:true});
});

test('missing frozen management name denies even inspection before any management effects',async t=>{
 const {default:Fastify}=await import('fastify');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {AgentStore,CoordinationV3Store}=await import('@ponderosa/agents');const {registerAgentManagementRoutes}=await import('../dist/routes/agent-management.js');
 const dir=await mkdtemp(join(tmpdir(),'management-frozen-')),store=new AgentStore(dir),app=Fastify();t.after(async()=>{await app.close();store.close();await rm(dir,{recursive:true,force:true});});
 const p=store.createProject({label:'Frozen management',hostPath:dir,defaultEngine:'codex'}),owner=store.createAgent(p.id,{title:'Owner',engine:'codex',conversationId:p.lastConversationId}),c=new CoordinationV3Store(store.sqlite);
 c.coordinate({projectId:p.id,conversationId:p.lastConversationId,actorScope:'user:local-operator',idempotencyKey:'parent',requests:[{requestId:'parent',recipientAgentId:owner.id,lifetime:{kind:'indefinite'},payload:{}}]});const lease=c.leaseNextRun({workerId:'fixture'});assert.ok(lease);
 const capability={agentId:owner.id,conversationId:p.lastConversationId,runId:lease.runId,v3SchedulerRunId:lease.runId,v3FencingToken:lease.fencingToken,availableToolNames:[PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name]};
 registerAgentManagementRoutes(app,{store,coordinationV3:c,workspace:{},engines:new Map(),managementPlans:new Map(),activeRuns:new Map([[owner.id,{runId:lease.runId,messageCapability:'fixture'}]]),agentMessageCapabilities:new Map([['fixture',capability]]),deletingAgentIds:new Set(),deletingProjectIds:new Set(),deletingConversationIds:new Set(),cachedModelOptions:()=>[],capabilityOwnsAuthoritativeRun:cap=>c.ownsRun(cap.v3SchedulerRunId,cap.v3FencingToken),managedAgentCreationRestricted:()=>false,publicManagementOperations:ops=>ops,commitAgentDeletion:async()=>{throw Error('no delete');},appendWorkspace:()=>{},publishWorkspaceSince:()=>{},notifyScheduler:()=>{}});
 const f={dir,store};await inertDenied(f,()=>app.inject({method:'POST',url:'/api/agent-management',headers:{authorization:'Bearer fixture'},payload:{action:'describe'}}),401);
});
