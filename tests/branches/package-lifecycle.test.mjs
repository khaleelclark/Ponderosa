import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {registerAgentPackageRoutes} from '../../apps/server/dist/routes/agent-packages.js';
import {validatePortableAgentPackage} from '../../apps/server/dist/portable-agent-package-validation.js';
import {AGENT_PACKAGE_MAX_BYTES,agentPackageJsonUtf8Bytes} from '@ponderosa/core';

const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
const portable=()=>({schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Portable workers',rootRef:'root',agents:[{ref:'root',title:'Worker',engine:'codex',managementPermissions:permissions},{ref:'child',title:'Child',managerRef:'root',engine:'codex',managementPermissions:permissions}]});
async function withPackages(t,run){
 const root=await mkdtemp(path.join(tmpdir(),'branch-package-current-')),store=new AgentStore(root),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),app=Fastify();let passed=false;
 const branch=branches.create('Package organization','owner'),project=store.createProject({label:'Branch Chat',chatOwned:true,branchId:branch.id,hostPath:root,defaultEngine:'codex'}),chatId=project.lastConversationId;
 const pending=new Set();
 const {packageEngine}=registerAgentPackageRoutes(app,{dataDir:root,store,coordination,assets:{},engines:new Map([['codex',{adapter:{id:'codex',listModels:()=>[],listEfforts:()=>[]}}]]),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:pending,agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace:()=>{},agentMessages:()=>[],createOperationalNotification:()=>{}});
 await app.ready();
 try{await run({store,coordination,branches,app,packageEngine,project,chatId,pending});passed=true}
 finally{await app.close();store.close();if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Retained package fixture: ${root}`)}
}

test('Branch imports use ordinary validation and atomically bind their reserved Agent identities with completion; replay creates nothing',t=>withPackages(t,async f=>{
 const pkg=portable(),key=randomUUID();let plans=0,commits=0;
 f.store.sqlite.exec('CREATE TEMP TABLE package_binding(agent_id TEXT PRIMARY KEY,operation_id TEXT)');
 const hooks={plan(ids,operationId){plans++;const operation=f.store.getAgentCreationOperation(operationId);assert.equal(operation.status,'preparing');assert.deepEqual(operation.agentIds,ids);assert.equal(operation.conversationId,f.chatId);assert.equal(operation.productScope,'branches');for(const id of ids){assert.equal(f.store.getAgent(id),undefined);f.store.sqlite.prepare('INSERT INTO package_binding VALUES(?,?)').run(id,operationId)}},commit(result){commits++;assert.ok(f.store.sqlite.inTransaction);for(const id of result.agentIds)assert.equal(f.store.agentCreationPending(id),true)}};
 f.packageEngine.validateAgent(pkg,{codex:'codex'});
 const imported=await f.packageEngine.importAgent(f.project.id,f.chatId,pkg,{codex:'codex'},key,{branchHooks:hooks});
 assert.equal(plans,1);assert.equal(commits,1);assert.equal(imported.agentIds.length,2);
 const root=f.store.getAgent(imported.rootAgentId),child=f.store.getAgent(imported.agentIds.find(id=>id!==root.id));assert.equal(child.managerAgentId,root.id);
 for(const id of imported.agentIds)assert.equal(f.store.agentCreationPending(id),false);
 const receipt=f.store.sqlite.prepare('SELECT operation_id FROM package_binding LIMIT 1').get();assert.equal(f.store.getAgentCreationOperation(receipt.operation_id).status,'completed');
 assert.deepEqual(await f.packageEngine.importAgent(f.project.id,f.chatId,pkg,{codex:'codex'},key,{branchHooks:hooks}),imported);
 assert.equal(plans,1);assert.equal(commits,1);assert.equal(f.store.listAgents(f.project.id).length,2);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 const exported=await f.packageEngine.exportAgent(root.id,'template');assert.equal(exported.rootRef,exported.agents[0].ref);f.packageEngine.validateAgent(exported,{codex:'codex'});
}));

for(const failure of ['plan','commit','cancellation'])test(`${failure} during a Branch import cannot acknowledge completion or leave active Agents`,t=>withPackages(t,async f=>{
 const controller=new AbortController(),key=randomUUID();let operationId,planned=[];
 f.store.sqlite.exec('CREATE TEMP TABLE binding_commit_probe(agent_id TEXT PRIMARY KEY)');
 const hooks={plan(ids,id){planned=ids;operationId=id;if(failure==='plan')throw Error('Controlled reservation failure');if(failure==='cancellation')controller.abort(Error('Controlled cancellation'))},commit(result){f.store.sqlite.prepare('INSERT INTO binding_commit_probe VALUES(?)').run(result.rootAgentId);throw Error('Controlled binding failure')}};
 await assert.rejects(f.packageEngine.importAgent(f.project.id,f.chatId,portable(),{codex:'codex'},key,{branchHooks:hooks,signal:controller.signal}),/Controlled/);
 assert.ok(operationId);assert.equal(f.store.getAgentCreationOperation(operationId).status,'rolled_back');
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM binding_commit_probe').get().n,0);
 assert.equal(f.store.listAgents(f.project.id).length,0);assert.ok(planned.every(id=>!f.store.getAgent(id)));assert.equal(f.pending.size,0);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
}));

test('the shared package parser rejects malformed context, duplicate artifacts, template history and unsupported fields before import',()=>{
 const pkg=portable();assert.equal(validatePortableAgentPackage(pkg).package,pkg);
 for(const mutate of [p=>p.agents[0].managementPermissions.allowAutomaticDescendantDeletion='yes',p=>p.agents[0].history=[],p=>p.agents[0].newAuthority=true,p=>p.agents[1].managerRef='missing',p=>p.sourceProjectInstructions='x']){
  const invalid=structuredClone(pkg);mutate(invalid);assert.throws(()=>validatePortableAgentPackage(invalid));
 }
 const artifact={ref:'00000000-0000-4000-8000-000000000001',kind:'document',path:'note.txt',createdAt:new Date().toISOString(),dataBase64:'eA=='};
 const full={...pkg,mode:'full',kind:'agent',agents:[{...pkg.agents[0],history:[{role:'user',text:'Imported context'}],artifacts:[artifact]}]};
 const valid=validatePortableAgentPackage(full);assert.equal(valid.totalArtifactBytes,1);
 full.agents[0].artifacts.push({...artifact});assert.throws(()=>validatePortableAgentPackage(full),/unique/);
} );

test('ordinary HTTP import retains explicit permission acknowledgement, exact replay, and canonical destination custody',t=>withPackages(t,async f=>{
 const project=f.store.createProject({label:'Ordinary Chat',chatOwned:true,hostPath:f.store.getProject(f.project.id).hostPath,defaultEngine:'codex'}),pkg=portable(),key=randomUUID();
 pkg.agents[0].managementPermissions={...permissions,allowAutomaticDescendantDeletion:true};
 const payload={package:pkg,conversationId:project.lastConversationId,engineMapping:{codex:'codex'}};
 const send=(body=payload)=>f.app.inject({method:'POST',url:`/api/projects/${project.id}/import-agents`,payload:body,headers:{'idempotency-key':key}});
 const refused=await send();assert.equal(refused.statusCode,409);assert.match(refused.json().error,/acknowledgement/);assert.equal(f.store.listAgents(project.id).length,0);
 const accepted=await send({...payload,acknowledgeElevatedManagementPermissions:true});
 // A refused payload retains its exact idempotency identity; new authority needs a new request key.
 assert.equal(accepted.statusCode,409);
 const authorizedKey=randomUUID(),authorized={...payload,acknowledgeElevatedManagementPermissions:true};
 const acceptedNew=await f.app.inject({method:'POST',url:`/api/projects/${project.id}/import-agents`,payload:authorized,headers:{'idempotency-key':authorizedKey}});
 assert.equal(acceptedNew.statusCode,201,acceptedNew.body);const result=acceptedNew.json();assert.equal(result.agentIds.length,2);
 const operation=f.store.findAgentCreationOperation({projectId:project.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:authorizedKey});
 assert.equal(operation.conversationId,project.lastConversationId);assert.equal(operation.productScope,'dev');assert.equal(operation.status,'completed');
 assert.throws(()=>f.store.beginAgentCreationOperation({projectId:project.id,conversationId:f.chatId,actorScope:operation.actorScope,kind:'import',idempotencyKey:authorizedKey,payloadHash:operation.payloadHash}),/different input/);
 const replay=await f.app.inject({method:'POST',url:`/api/projects/${project.id}/import-agents`,payload:authorized,headers:{'idempotency-key':authorizedKey}});assert.equal(replay.statusCode,200);assert.deepEqual(replay.json(),result);
 const reordered=await f.app.inject({method:'POST',url:`/api/projects/${project.id}/import-agents`,payload:{engineMapping:{codex:' codex '},conversationId:project.lastConversationId,acknowledgeElevatedManagementPermissions:true,package:pkg},headers:{'idempotency-key':authorizedKey}});
 assert.equal(reordered.statusCode,200,reordered.body);assert.deepEqual(reordered.json(),result,'canonical JSON replay retains its original identity');
}));

test('legacy JSON envelopes retain bounded metadata and reject malformed text before destination mutations',t=>withPackages(t,async f=>{
 const project=f.store.createProject({label:'Envelope destination',chatOwned:true,hostPath:f.store.getProject(f.project.id).hostPath,defaultEngine:'codex'});
 for(const failure of ['metadata','history','initialInstructions']){
  const pkg=portable();pkg.mode='full';
  if(failure==='history')pkg.agents[0].history=[{role:'user',text:'\ud800'}];
  if(failure==='initialInstructions')pkg.agents[0].initialInstructions='\udfff';
  const payload={package:pkg,conversationId:project.lastConversationId,engineMapping:{codex:failure==='metadata'?'x'.repeat(16384):'codex'}};
  const result=await f.app.inject({method:'POST',url:`/api/projects/${project.id}/import-agents`,headers:{'idempotency-key':randomUUID()},payload});
  assert.equal(result.statusCode,failure==='metadata'?413:400,result.body);
  assert.match(result.json().error,failure==='metadata'?/metadata exceeds 16 KiB/u:/well-formed Unicode/u);
  assert.equal(f.store.listAgents(project.id).length,0);
 }
}));

test('post-remap UTF-8 growth is refused before Agent reservation, artifact publication or Chat changes',{timeout:60_000},t=>withPackages(t,async f=>{
 const pkg=portable();pkg.mode='full';
 const artifact={ref:randomUUID(),kind:'document',path:'a.txt',createdAt:new Date().toISOString(),dataBase64:'eA=='};
 pkg.agents[0].artifacts=[artifact];
 const text='雪'.repeat(64*1024),history=Array.from({length:1300},()=>({role:'user',text}));history.push({role:'assistant',text:''});pkg.agents[0].history=history;
 history.at(-1).text='x'.repeat(AGENT_PACKAGE_MAX_BYTES-agentPackageJsonUtf8Bytes(pkg));
 assert.equal(agentPackageJsonUtf8Bytes(pkg),AGENT_PACKAGE_MAX_BYTES);
 const before=f.store.getConversation(f.chatId),key=randomUUID();
 await assert.rejects(f.packageEngine.importAgent(f.project.id,f.chatId,pkg,{codex:'codex'},key),error=>error.statusCode===413&&/256 MiB/u.test(error.message));
 assert.equal(f.store.listAgents(f.project.id).length,0);assert.equal(f.store.getProjectArtifacts(f.project.id).length,0);
 assert.equal(f.store.getConversation(f.chatId).instructions,before.instructions);
 const receipt=f.store.findAgentCreationOperation({projectId:f.project.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:key});
 assert.equal(receipt.status,'rolled_back');assert.deepEqual(receipt.agentIds,[]);assert.deepEqual(receipt.artifactIds,[]);
}));

test('a Chat instruction change during import is preserved while the existing rollback removes pending Agents',t=>withPackages(t,async f=>{
 const pkg=portable();pkg.mode='full';pkg.sourceProjectInstructions='Imported Chat instructions';
 const create=f.store.createAgent.bind(f.store);let edited=false;
 f.store.createAgent=(...args)=>{const agent=create(...args);if(!edited){edited=true;f.store.updateConversation(f.chatId,{instructions:'Newer human instructions'})}return agent};
 await assert.rejects(f.packageEngine.importAgent(f.project.id,f.chatId,pkg,{codex:'codex'},randomUUID()),error=>error.statusCode===409&&/instructions changed/u.test(error.message));
 assert.equal(f.store.getConversation(f.chatId).instructions,'Newer human instructions');
 assert.equal(f.store.listAgents(f.project.id).length,0);assert.equal(f.pending.size,0);
}));
