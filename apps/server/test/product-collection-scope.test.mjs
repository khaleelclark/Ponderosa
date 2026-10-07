import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import {AgentStore,BranchStore,CoordinationV3Store,WorkspaceStore} from '@ponderosa/agents';
import {projectProductSql,registerProductScope,rewriteProductUrl} from '../dist/product-scope.js';
import {sqliteCollectionPage} from '../dist/collection-page.js';
import {registerArtifactRoutes} from '../dist/routes/artifacts.js';
import {registerTriggerRoutes} from '../dist/routes/triggers.js';
import {registerWorkspaceDirectoryRoutes} from '../dist/routes/workspace-directory.js';
import {registerProjectDeletionRoutes} from '../dist/project-deletion-coordinator.js';

const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
function artifact(projectId,agentId,id,createdAt){return {id,projectId,agentId,originAgentId:agentId,kind:'generated_file',path:`${id}.txt`,summary:id,createdAt,mediaType:'text/plain',size:1,sha256:'0'.repeat(64),visibility:'project',pinned:false}}

test('artifact, trigger, and directory collections scope before pagination and counts',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'product-collections-')),store=new AgentStore(dir),workspace=new WorkspaceStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),app=Fastify({rewriteUrl:rewriteProductUrl});
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
 const dev=store.createProject({label:'Shared',hostPath:dir,defaultEngine:'codex'}),devChat=store.getConversation(dev.lastConversationId),devAgent=store.createAgent(dev.id,{title:'Dev Agent',engine:'codex',conversationId:devChat.id,managementPermissions:permissions});
 const branch=branches.create('Branch','owner'),branchProject=store.createProject({label:'Branch temp',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id}),branchChat=store.getConversation(branchProject.lastConversationId),branchAgent=store.createAgent(branchProject.id,{title:'Branch Agent',engine:'codex',conversationId:branchChat.id,managementPermissions:permissions});
 // A legacy/shared Project makes post-pagination filtering observable. Chat ownership remains canonical.
 store.sqlite.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(dev.id,branchChat.id);store.sqlite.prepare('UPDATE agents SET project_id=? WHERE id=?').run(dev.id,branchAgent.id);
 store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'active')").run(branch.id,'pkg','chat','',branchChat.id);
 store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'active')").run(branch.id,'pkg','chat','agent',branchAgent.id);
 for(const [agent,id,created] of [[devAgent,'dev-old','2026-01-01T00:00:00.000Z'],[devAgent,'dev-new','2026-01-02T00:00:00.000Z'],[branchAgent,'branch-1','2026-02-01T00:00:00.000Z'],[branchAgent,'branch-2','2026-02-02T00:00:00.000Z'],[branchAgent,'branch-3','2026-02-03T00:00:00.000Z']])store.recordProjectArtifact(artifact(dev.id,agent.id,id,created));
 const makeTrigger=(agent,chat,id,updated)=>{coordination.createTriggerDefinition({id,projectId:dev.id,conversationId:chat.id,targetAgentId:agent.id,name:id,instructions:'Run',sourceKind:'schedule',sourceConfig:{scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'},enabled:true,now:updated});store.sqlite.prepare('UPDATE trigger_definitions SET updated_at=? WHERE id=?').run(updated,id)};
 makeTrigger(devAgent,devChat,'dev-trigger-old','2026-01-01T00:00:00.000Z');makeTrigger(devAgent,devChat,'dev-trigger-new','2026-01-02T00:00:00.000Z');
 makeTrigger(branchAgent,branchChat,'branch-trigger-1','2026-02-01T00:00:00.000Z');makeTrigger(branchAgent,branchChat,'branch-trigger-2','2026-02-02T00:00:00.000Z');makeTrigger(branchAgent,branchChat,'branch-trigger-3','2026-02-03T00:00:00.000Z');
 registerProductScope(app,store,workspace,()=>undefined,()=>false);
 registerArtifactRoutes(app,{store,assets:{},dataDir:dir,projectFileAuthority:{},publish(){},managedProjectArtifactAgreesWithRuntime(){return true}});
 registerTriggerRoutes(app,{store,coordination,sources:{},deletingConversationIds:new Set(),webhookRawBodies:new WeakMap(),rejectQuarantinedMutation:()=>false,appendWorkspace(){},reconcileOperationalNotifications(){},resolveOperationalNotification(){},notifyScheduler(){}});
 registerWorkspaceDirectoryRoutes(app,{store,coordination,workspace,projectDisplayPath:path=>path,agentHealth:(scope,agents)=>({scope,generatedAt:new Date(0).toISOString(),agents:agents.map(agent=>({agentId:agent.id,childAgentIds:[],status:'running',statusTimestamp:'2026-03-01T00:00:00.000Z',reason:{kind:'active_run'}}))})});
 const devArtifacts=await app.inject(`/api/projects/${dev.id}/artifacts?limit=1`);assert.equal(devArtifacts.statusCode,200,devArtifacts.body);assert.deepEqual(devArtifacts.json().items.map(item=>item.id),['dev-new']);assert.equal(devArtifacts.json().history.hasMore,true);
 const nextDevArtifacts=await app.inject(`/api/projects/${dev.id}/artifacts?limit=1&cursor=${encodeURIComponent(devArtifacts.json().history.cursor)}`);assert.deepEqual(nextDevArtifacts.json().items.map(item=>item.id),['dev-old']);
 const branchArtifacts=await app.inject(`/api/branches/engine/projects/${dev.id}/artifacts?limit=1`);assert.deepEqual(branchArtifacts.json().items.map(item=>item.id),['branch-3']);
 const devTriggers=await app.inject('/api/triggers?limit=1');assert.equal(devTriggers.headers['x-total-count'],'2');assert.deepEqual(devTriggers.json().map(item=>item.id),['dev-trigger-new']);assert.equal(devTriggers.headers['x-collection-has-more'],'true');
 const branchTriggers=await app.inject('/api/branches/engine/triggers?limit=1');assert.equal(branchTriggers.headers['x-total-count'],'3');assert.deepEqual(branchTriggers.json().map(item=>item.id),['branch-trigger-3']);
 const devAgents=await app.inject('/api/workspace/directory/agent?active=true&limit=1');assert.equal(devAgents.json().activeCount,1);assert.deepEqual(devAgents.json().items.map(item=>item.agent.id),[devAgent.id]);
 const branchAgents=await app.inject('/api/branches/engine/workspace/directory/agent?active=true&limit=1');assert.equal(branchAgents.json().activeCount,1);assert.deepEqual(branchAgents.json().items.map(item=>item.agent.id),[branchAgent.id]);
 const devDirectoryTriggers=await app.inject('/api/workspace/directory/trigger?limit=1');assert.equal(devDirectoryTriggers.json().enabledCount,2);assert.equal(devDirectoryTriggers.json().total,2);
 const branchDirectoryTriggers=await app.inject('/api/branches/engine/workspace/directory/trigger?limit=1');assert.equal(branchDirectoryTriggers.json().enabledCount,3);assert.equal(branchDirectoryTriggers.json().total,3);
 store.sqlite.prepare("UPDATE branch_installation_resources SET state='retiring' WHERE local_id=?").run(branchAgent.id);
 assert.equal((await app.inject('/api/branches/engine/triggers?limit=10')).json().length,0,'inactive Agent triggers are excluded before pagination');
 assert.equal((await app.inject('/api/branches/engine/workspace/directory/agent?active=true&limit=10')).json().activeCount,0,'inactive Agent is excluded from summary count');
 assert.equal((await app.inject('/api/branches/engine/workspace/directory/trigger?limit=10')).json().enabledCount,0,'inactive Agent triggers are excluded from enabled count');

 const stagingProject=store.createProject({label:'Staging only',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id}),stagingChat=store.getConversation(stagingProject.lastConversationId);
 store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'staging')").run(branch.id,'staging','chat','',stagingChat.id);
 store.sqlite.prepare("UPDATE projects SET last_used_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(stagingProject.id);
 const branchProjects=sqliteCollectionPage(store.sqlite,{limit:'1'},{baseSql:`SELECT id,label title,COALESCE(last_used_at,created_at) updated_at FROM projects WHERE ${projectProductSql('projects.id','branches')}`,params:[],order:'updated',scope:'test-branch-projects',generationKeys:['projects'],hydrate:id=>store.getProject(id)});
 assert.equal(branchProjects.total,1);assert.deepEqual(branchProjects.items.map(project=>project.id),[dev.id]);
 const devProjects=sqliteCollectionPage(store.sqlite,{limit:'10'},{baseSql:`SELECT id,label title,COALESCE(last_used_at,created_at) updated_at FROM projects WHERE ${projectProductSql('projects.id','dev')}`,params:[],order:'updated',scope:'test-dev-projects',generationKeys:['projects'],hydrate:id=>store.getProject(id)});
 assert.ok(!devProjects.items.some(project=>project.id===stagingProject.id),'staging-only Branch Projects are unavailable in both products');

 const devOccurrence=coordination.recordTriggerOccurrence({triggerId:'dev-trigger-new',occurrenceKey:'dev-occurrence',payload:{},provenance:{source:'test'}});
 const nativeBranchTrigger=coordination.createTriggerDefinition({projectId:dev.id,conversationId:branchChat.id,branchId:branch.id,name:'Native Branch trigger',instructions:'Run',sourceKind:'schedule',sourceConfig:{scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'},enabled:true});
 const branchOccurrence=coordination.recordTriggerOccurrence({triggerId:'dev-trigger-old',occurrenceKey:'branch-occurrence',payload:{},provenance:{source:'test'}});
 store.sqlite.prepare("UPDATE trigger_occurrences SET trigger_id=?,agent_id=NULL,branch_id=?,trigger_snapshot_json=?,occurred_at=? WHERE id=?").run(nativeBranchTrigger.id,branch.id,JSON.stringify({id:nativeBranchTrigger.id,conversationId:branchChat.id,branchId:branch.id,productScope:'branches',name:nativeBranchTrigger.name,instructions:nativeBranchTrigger.instructions,sourceKind:nativeBranchTrigger.sourceKind,sourceConfig:nativeBranchTrigger.sourceConfig,fullAccess:true}),'2099-01-02T00:00:00.000Z',branchOccurrence.occurrenceId);
 store.sqlite.prepare("UPDATE trigger_occurrences SET occurred_at=? WHERE id=?").run('2099-01-01T00:00:00.000Z',devOccurrence.occurrenceId);
 const devHistory=await app.inject(`/api/projects/${dev.id}/trigger-occurrences?limit=1`);
 assert.deepEqual(devHistory.json().map(item=>item.id),[devOccurrence.occurrenceId],'foreign newer history is filtered before limit');
 const branchHistory=await app.inject(`/api/branches/engine/projects/${dev.id}/trigger-occurrences?limit=1`);
 assert.deepEqual(branchHistory.json().map(item=>item.id),[branchOccurrence.occurrenceId]);
 // Native Branch triggers have no Project target; their occurrence remains visible in Branches.
 store.sqlite.prepare('UPDATE trigger_occurrences SET project_id=? WHERE id=?').run('',branchOccurrence.occurrenceId);
 const nativeHistory=await app.inject(`/api/branches/engine/triggers/${nativeBranchTrigger.id}/occurrences?limit=1`);
 assert.equal(nativeHistory.statusCode,200,nativeHistory.body);
 assert.deepEqual(nativeHistory.json().map(item=>item.id),[branchOccurrence.occurrenceId]);
 const nativeOccurrence=await app.inject(`/api/branches/engine/trigger-occurrences/${branchOccurrence.occurrenceId}`);
 assert.equal(nativeOccurrence.statusCode,200,nativeOccurrence.body);
 assert.equal(nativeOccurrence.json().id,branchOccurrence.occurrenceId);
 assert.equal((await app.inject(`/api/trigger-occurrences/${branchOccurrence.occurrenceId}`)).statusCode,404);
 assert.equal((await app.inject(`/api/branches/engine/trigger-occurrences/${devOccurrence.occurrenceId}`)).statusCode,404);
 assert.equal((await app.inject({method:'PATCH',url:`/api/triggers/${nativeBranchTrigger.id}`,payload:{enabled:false}})).statusCode,404);
 assert.equal((await app.inject({method:'PATCH',url:`/api/branches/engine/triggers/dev-trigger-new`,payload:{enabled:false}})).statusCode,404);
});


test('mixed-product Project deletion and preview fail closed without child disclosure',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mixed-project-delete-')),store=new AgentStore(dir),workspace=new WorkspaceStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),app=Fastify({rewriteUrl:rewriteProductUrl});
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
 const project=store.createProject({label:'Mixed',hostPath:dir,defaultEngine:'codex'}),branch=branches.create('Branch','owner');
 const branchProject=store.createProject({label:'Branch Chat',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id}),branchChat=store.getConversation(branchProject.lastConversationId);
 store.sqlite.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(project.id,branchChat.id);
 registerProductScope(app,store,workspace,()=>undefined,()=>false);
 registerProjectDeletionRoutes(app,{store,coordinationV3:coordination,activeRuns:new Map(),projectBrowserGrants:new Map()});
 for(const prefix of ['/api','/api/branches/engine']){
  const preview=await app.inject(`${prefix}/projects/${project.id}/deletion-preview`);
  assert.equal(preview.statusCode,409,preview.body);assert.deepEqual(Object.keys(preview.json()),['error']);
  const deletion=await app.inject({method:'DELETE',url:`${prefix}/projects/${project.id}`});
  assert.equal(deletion.statusCode,409,deletion.body);assert.ok(store.getProject(project.id));
 }
});
