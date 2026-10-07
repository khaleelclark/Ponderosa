import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import {AgentStore,BranchStore,CoordinationV3Store,WorkspaceStore} from '@ponderosa/agents';
import {AgentWorkProjection} from '../dist/routes/agent-work.js';
import {registerAgentOrganizationRoutes} from '../dist/routes/agent-organization.js';
import {registerSearchRoutes} from '../dist/routes/search.js';
import {workspaceEventInProduct} from '../dist/routes/streams.js';
import {registerProductScope,rewriteProductUrl} from '../dist/product-scope.js';

const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'product-final-')),store=new AgentStore(dir),workspace=new WorkspaceStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Mixed',hostPath:dir,defaultEngine:'codex'}),devChat=store.getConversation(project.lastConversationId),branch=branches.create('Scoped Branch','scope-final'),branchChat=store.createConversation(project.id,{title:'Branch Chat'});
 store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
 const devAgent=store.createAgent(project.id,{title:'Dev Agent',engine:'codex',conversationId:devChat.id,managementPermissions:permissions}),branchAgent=store.createAgent(project.id,{title:'Branch Agent',engine:'codex',conversationId:branchChat.id,managementPermissions:permissions});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 return {dir,store,workspace,coordination,branches,project,devChat,branch,branchChat,devAgent,branchAgent};
}

test('execution-owned temporary Chats and Agents are readable but external mutations are fenced',async t=>{
 const f=setup(t),definition={schema:'ponderosa.branch.v1',name:'Audit only',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'console.log(1)',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 f.branches.deploy({chatId:'',branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'audit-deploy',definition,bindings:{agents:{},directories:{root:f.dir}}});
 const execution=f.branches.accept(f.branch.id,'audit-run','input');
 const tempProject=f.store.createProject({label:'Temporary',chatOwned:true,branchId:f.branch.id,executionId:execution.id,defaultEngine:'codex'});
 const tempChat=f.store.getConversation(tempProject.lastConversationId);
 const tempAgent=f.store.createAgent(tempProject.id,{title:'Temporary Agent',engine:'codex',conversationId:tempChat.id,managementPermissions:permissions});
 const app=Fastify({rewriteUrl:rewriteProductUrl});t.after(()=>app.close());
 registerProductScope(app,f.store,f.workspace,request=>request.headers['x-test-runtime']==='yes'?tempChat.id:undefined,()=>false);
 app.get('/api/agents/:id',async request=>f.store.getAgent(request.params.id));
 app.patch('/api/agents/:id',async()=>({accepted:true}));
 app.post('/api/projects/:id/agents',async()=>({accepted:true}));
 app.post('/api/projects/:id/import-agents',async()=>({accepted:true}));
 app.put('/api/projects/:id/agents/:agentId/browser-preference',async()=>({accepted:true}));
 app.post('/api/projects/:projectId/browser',async()=>({accepted:true}));
 app.get('/api/conversations/:id/members',async()=>[tempAgent]);
 const base='/api/branches/engine';
 assert.equal((await app.inject(`${base}/agents/${tempAgent.id}`)).statusCode,200);
 assert.equal((await app.inject(`${base}/conversations/${tempChat.id}/members`)).statusCode,200);
 const update=await app.inject({method:'PATCH',url:`${base}/agents/${tempAgent.id}`,payload:{title:'Changed'}});
 assert.equal(update.statusCode,409,update.body);
 const create=await app.inject({method:'POST',url:`${base}/projects/${tempProject.id}/agents`,payload:{conversationId:tempChat.id,title:'Extra'}});
 assert.equal(create.statusCode,409,create.body);
 const imported=await app.inject({method:'POST',url:`${base}/projects/${tempProject.id}/import-agents`,payload:{conversationId:tempChat.id}});
 assert.equal(imported.statusCode,409,imported.body);
 const nested=await app.inject({method:'PUT',url:`${base}/projects/${tempProject.id}/agents/${tempAgent.id}/browser-preference`,payload:{mode:'trusted'}});
 assert.equal(nested.statusCode,409,nested.body);
 const browser=await app.inject({method:'POST',url:`${base}/projects/${tempProject.id}/browser`,payload:{mode:'trusted'}});
 assert.equal(browser.statusCode,409,browser.body);
 const persistent=await app.inject({method:'PATCH',url:`${base}/agents/${f.branchAgent.id}`,payload:{title:'Allowed'}});
 assert.equal(persistent.statusCode,200,persistent.body);
 const runtime=await app.inject({method:'PATCH',url:`${base}/agents/${tempAgent.id}`,headers:{'x-test-runtime':'yes'},payload:{title:'Runtime-owned'}});
 assert.equal(runtime.statusCode,200,runtime.body);
});

test('workspace events use canonical mixed-Project resource ownership in both directions',t=>{
 const f=setup(t);
 const devDecision=f.workspace.createDecision({projectId:f.project.id,conversationId:f.devChat.id,agentId:f.devAgent.id,question:'Dev?',options:[],mode:'text',allowOther:true,idempotencyKey:'event-dev'});
 const branchDecision=f.workspace.createDecision({projectId:f.project.id,conversationId:f.branchChat.id,agentId:f.branchAgent.id,question:'Branch?',options:[],mode:'text',allowOther:true,idempotencyKey:'event-branch'});
 const devNotification=f.workspace.createNotification({projectId:f.project.id,conversationId:f.devChat.id,agentId:f.devAgent.id,kind:'direct_response',title:'Dev',body:'Dev'});
 const branchNotification=f.workspace.createNotification({projectId:f.project.id,conversationId:f.branchChat.id,agentId:f.branchAgent.id,branchId:f.branch.id,kind:'direct_response',title:'Branch',body:'Branch'});
 const devTrigger=f.coordination.createTriggerDefinition({projectId:f.project.id,conversationId:f.devChat.id,targetAgentId:f.devAgent.id,name:'Dev trigger',instructions:'Run',sourceKind:'schedule',sourceConfig:{scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'},enabled:true});
 const branchTrigger=f.coordination.createTriggerDefinition({projectId:f.project.id,conversationId:f.branchChat.id,branchId:f.branch.id,name:'Branch trigger',instructions:'Run',sourceKind:'schedule',sourceConfig:{scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'},enabled:true});
 const pairs=[
  [{type:'conversation_changed',projectId:f.project.id,conversationId:f.devChat.id,action:'updated'},{type:'conversation_changed',projectId:f.project.id,conversationId:f.branchChat.id,action:'updated'}],
  [{type:'draft_changed',conversationId:f.devChat.id,revision:1,cleared:false},{type:'draft_changed',conversationId:f.branchChat.id,revision:1,cleared:false}],
  [{type:'draft_conflict',conversationId:f.devChat.id,revision:1},{type:'draft_conflict',conversationId:f.branchChat.id,revision:1}],
  [{type:'queued_message_changed',conversationId:f.devChat.id,deliveryId:'dev-delivery',action:'queued'},{type:'queued_message_changed',conversationId:f.branchChat.id,deliveryId:'branch-delivery',action:'queued'}],
  [{type:'resource_used',kind:'agent',resourceId:f.devAgent.id},{type:'resource_used',kind:'agent',resourceId:f.branchAgent.id}],
  [{type:'notification_changed',notificationId:devNotification.id,projectId:f.project.id,conversationId:f.devChat.id,action:'created'},{type:'notification_changed',notificationId:branchNotification.id,projectId:f.project.id,conversationId:f.branchChat.id,action:'created'}],
  [{type:'notification_changed',decisionId:devDecision.id,projectId:f.project.id,conversationId:f.devChat.id,action:'created'},{type:'notification_changed',decisionId:branchDecision.id,projectId:f.project.id,conversationId:f.branchChat.id,action:'created'}],
  [{type:'message_delivery_changed',projectId:f.project.id,agentId:f.devAgent.id,conversationIds:[f.devChat.id]},{type:'message_delivery_changed',projectId:f.project.id,agentId:f.branchAgent.id,conversationIds:[f.branchChat.id]}],
  [{type:'coordination_changed',projectId:f.project.id,agentId:f.devAgent.id,conversationIds:[f.devChat.id]},{type:'coordination_changed',projectId:f.project.id,agentId:f.branchAgent.id,conversationIds:[f.branchChat.id]}],
  [{type:'usage_changed',projectId:f.project.id,agentId:f.devAgent.id,conversationIds:[f.devChat.id],seq:1},{type:'usage_changed',projectId:f.project.id,agentId:f.branchAgent.id,conversationIds:[f.branchChat.id],seq:1}],
  [{type:'agent_event',projectId:f.project.id,agentId:f.devAgent.id,conversationIds:[f.devChat.id],seq:1,eventType:'text',category:'message'},{type:'agent_event',projectId:f.project.id,agentId:f.branchAgent.id,conversationIds:[f.branchChat.id],seq:1,eventType:'text',category:'message'}],
  [{type:'trigger_changed',projectId:f.project.id,agentId:f.devAgent.id,triggerId:devTrigger.id,action:'updated'},{type:'trigger_changed',projectId:f.project.id,triggerId:branchTrigger.id,action:'updated'}],
  [{type:'push_delivery_changed',notificationId:devNotification.id,deviceId:'device',action:'delivered'},{type:'push_delivery_changed',notificationId:branchNotification.id,deviceId:'device',action:'delivered'}],
 ];
 for(const [devEvent,branchEvent] of pairs){
  assert.equal(workspaceEventInProduct(f.store,f.workspace,devEvent,'dev'),true,devEvent.type);
  assert.equal(workspaceEventInProduct(f.store,f.workspace,devEvent,'branches'),false,devEvent.type);
  assert.equal(workspaceEventInProduct(f.store,f.workspace,branchEvent,'branches'),true,branchEvent.type);
  assert.equal(workspaceEventInProduct(f.store,f.workspace,branchEvent,'dev'),false,branchEvent.type);
 }
 for(const event of [{type:'preferences_updated',preferences:f.workspace.getPreferences()},{type:'push_subscription_changed',deviceId:'device',action:'upserted'}]){
  assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'dev'),true);assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'branches'),true);
 }
 for(const event of [{type:'project_changed',projectId:f.project.id,action:'updated'},{type:'runtime_capabilities_changed',projectId:f.project.id,engineId:'codex'}]){
  assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'dev'),true);assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'branches'),true);
 }
 assert.equal(workspaceEventInProduct(f.store,f.workspace,{type:'notification_changed',action:'acknowledged'},'dev'),true);
 assert.equal(workspaceEventInProduct(f.store,f.workspace,{type:'notification_changed',action:'acknowledged'},'branches'),true);
 const definition={schema:'ponderosa.branch.v1',name:'Scoped',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'console.log(1)',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 f.branches.deploy({chatId:'',branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'scope-checkpoint-deploy',definition,bindings:{agents:{},directories:{root:f.dir}}});
 const execution=f.branches.accept(f.branch.id,'scope-checkpoint-run','input');
 const checkpointId=f.store.sqlite.prepare('SELECT id FROM branch_checkpoints WHERE execution_id=? ORDER BY id LIMIT 1').get(execution.id).id;
 const checkpoint={type:'branch_checkpoint',checkpointId,branchId:f.branch.id,chatId:'',executionId:execution.id,kind:'trigger_accepted',evidence:{}};
 assert.equal(workspaceEventInProduct(f.store,f.workspace,checkpoint,'dev'),false);
 for(const event of [{type:'preferences_updated',preferences:f.workspace.getPreferences()},{type:'push_subscription_changed',deviceId:'device',action:'upserted'}]){
  assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'dev'),true);assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'branches'),true);
 }
 for(const event of [{type:'project_changed',projectId:f.project.id,action:'updated'},{type:'runtime_capabilities_changed',projectId:f.project.id,engineId:'codex'}]){
  assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'dev'),true);assert.equal(workspaceEventInProduct(f.store,f.workspace,event,'branches'),true);
 }
 assert.equal(workspaceEventInProduct(f.store,f.workspace,checkpoint,'branches'),true);
 assert.equal(workspaceEventInProduct(f.store,f.workspace,{...checkpoint,executionId:'wrong'},'branches'),false);
 assert.equal(workspaceEventInProduct(f.store,f.workspace,{...checkpoint,branchId:'wrong'},'branches'),false);
 assert.equal(workspaceEventInProduct(f.store,f.workspace,{...checkpoint,checkpointId:checkpointId+1_000_000},'branches'),false);
});

test('generic DELETE cannot bypass Branch lifecycle while exact internal dispatch can',async t=>{
 const f=setup(t),app=Fastify({rewriteUrl:rewriteProductUrl});t.after(()=>app.close());
 registerProductScope(app,f.store,f.workspace,()=>undefined,request=>request.headers['x-ponderosa-v3-dispatch']==='exact-dispatch');
 app.delete('/api/conversations/:id',async()=>({deleted:true}));
 app.delete('/api/projects/:id',async()=>({deleted:true}));
 for(const prefix of ['/api','/api/branches/engine']){
  assert.equal((await app.inject({method:'DELETE',url:`${prefix}/conversations/${f.branchChat.id}`})).statusCode,409);
  assert.equal((await app.inject({method:'DELETE',url:`${prefix}/projects/${f.project.id}`})).statusCode,409);
 }
 assert.equal((await app.inject({method:'DELETE',url:`/api/branches/engine/conversations/${f.branchChat.id}`,headers:{'x-ponderosa-v3-dispatch':'wrong'}})).statusCode,409);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,'',?,'retiring')").run(f.branch.id,'retirement-test','retiring-chat',f.branchChat.id);
 assert.equal((await app.inject({method:'DELETE',url:`/api/branches/engine/conversations/${f.branchChat.id}`})).statusCode,409);
 assert.equal((await app.inject({method:'DELETE',url:`/api/branches/engine/conversations/${f.branchChat.id}`,headers:{'x-ponderosa-v3-dispatch':'exact-dispatch'}})).statusCode,200);
});


test('Agent deletion roots are product scoped and installed Branch Agents require Branch lifecycle',async t=>{
 const f=setup(t),app=Fastify({rewriteUrl:rewriteProductUrl});t.after(()=>app.close());
 registerProductScope(app,f.store,f.workspace,()=>undefined,()=>false);
 app.post('/api/projects/:id/agent-deletions/preview',async()=>({accepted:true}));
 app.post('/api/projects/:id/agent-deletions/commit',async()=>({accepted:true}));
 app.delete('/api/agents/:id',async()=>({deleted:true}));
 for(const path of ['preview','commit']){
  assert.equal((await app.inject({method:'POST',url:`/api/projects/${f.project.id}/agent-deletions/${path}`,payload:{rootAgentIds:[f.branchAgent.id],previewHash:'a'.repeat(64)}})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:`/api/branches/engine/projects/${f.project.id}/agent-deletions/${path}`,payload:{rootAgentIds:[f.devAgent.id],previewHash:'a'.repeat(64)}})).statusCode,404);
 }
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'active')").run(f.branch.id,'package','chat','agent',f.branchAgent.id);
 assert.equal((await app.inject({method:'POST',url:`/api/branches/engine/projects/${f.project.id}/agent-deletions/preview`,payload:{rootAgentIds:[f.branchAgent.id]}})).statusCode,409);
 assert.equal((await app.inject({method:'DELETE',url:`/api/branches/engine/agents/${f.branchAgent.id}`})).statusCode,409);
});

test('organization pagination, relationships, deleted groups, and counts are Chat scoped',async t=>{
 const f=setup(t),app=Fastify({rewriteUrl:rewriteProductUrl});t.after(()=>app.close());
 const devChild=f.store.createAgent(f.project.id,{title:'Dev Child',engine:'codex',conversationId:f.devChat.id,managementPermissions:permissions});
 f.store.sqlite.prepare('UPDATE agents SET manager_agent_id=? WHERE id=?').run(f.branchAgent.id,devChild.id);
 const deletedBranch=f.store.createAgent(f.project.id,{title:'Deleted Branch',engine:'codex',conversationId:f.branchChat.id,managementPermissions:permissions});
 f.store.sqlite.prepare("UPDATE agents SET deleted_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(deletedBranch.id);
 registerProductScope(app,f.store,f.workspace,()=>undefined,()=>false);
 registerAgentOrganizationRoutes(app,{store:f.store,agentHealth:(scope,agents)=>({scope,generatedAt:new Date(0).toISOString(),agents:agents.map(agent=>({agentId:agent.id,childAgentIds:[],status:'idle',statusTimestamp:new Date(0).toISOString(),reason:{kind:'idle'}}))})});
 const devRoots=(await app.inject(`/api/projects/${f.project.id}/agent-organization?scope=roots&limit=1`)).json();
 assert.deepEqual(devRoots.items.map(item=>item.id),[f.devAgent.id]);assert.equal(devRoots.total,1);assert.equal(devRoots.specialGroupCounts.deleted,0);
 const devOrphans=(await app.inject(`/api/projects/${f.project.id}/agent-organization?scope=orphaned&limit=1`)).json();
 assert.deepEqual(devOrphans.items.map(item=>item.id),[devChild.id]);assert.equal(devOrphans.items[0].relation.kind,'orphaned');
 const branchRoots=(await app.inject(`/api/branches/engine/projects/${f.project.id}/agent-organization?scope=roots&limit=1`)).json();
 assert.deepEqual(branchRoots.items.map(item=>item.id),[f.branchAgent.id]);assert.equal(branchRoots.total,1);assert.equal(branchRoots.specialGroupCounts.deleted,1);
 const branchDeleted=(await app.inject(`/api/branches/engine/projects/${f.project.id}/agent-organization?scope=deleted&limit=1`)).json();
 assert.deepEqual(branchDeleted.items.map(item=>item.id),[deletedBranch.id]);assert.equal(branchDeleted.total,1);
 const branchChildren=await app.inject(`/api/branches/engine/projects/${f.project.id}/agent-organization?scope=children&parentAgentId=${f.branchAgent.id}`);
 assert.equal(branchChildren.statusCode,200);assert.deepEqual(branchChildren.json().items,[]);
});

test('All Chat decisions filter canonical product ownership before the limit',async t=>{
 const f=setup(t),projection=new AgentWorkProjection(f.store,f.coordination,f.workspace);
 const own=f.workspace.createDecision({projectId:f.project.id,conversationId:f.devChat.id,agentId:f.devAgent.id,question:'Own',options:[],mode:'text',allowOther:true,idempotencyKey:'own'});
 await new Promise(resolve=>setTimeout(resolve,2));
 f.workspace.createDecision({projectId:f.project.id,conversationId:f.devChat.id,agentId:f.branchAgent.id,question:'Cross product',options:[],mode:'text',allowOther:true,idempotencyKey:'cross'});
 const result=projection.inspect({projectId:f.project.id,limit:1,product:'dev'});
 assert.deepEqual(result.items.filter(item=>item.kind==='decision').map(item=>item.recordId),[own.id]);
});


test('All Chat HTTP route scopes mixed-Project decisions before pagination',async t=>{
 const f=setup(t),app=Fastify({rewriteUrl:rewriteProductUrl});t.after(()=>app.close());
 registerProductScope(app,f.store,f.workspace,()=>undefined,()=>false);
 registerSearchRoutes(app,{store:f.store,workspace:f.workspace,coordinationV3:f.coordination,globalChatSearch:()=>({results:[],recentChats:[],truncated:false})});
 const dev=f.workspace.createDecision({projectId:f.project.id,conversationId:f.devChat.id,agentId:f.devAgent.id,question:'Dev decision',options:[],mode:'text',allowOther:true,idempotencyKey:'route-dev'});
 await new Promise(resolve=>setTimeout(resolve,2));
 const branch=f.workspace.createDecision({projectId:f.project.id,conversationId:f.branchChat.id,agentId:f.branchAgent.id,question:'Branch decision',options:[],mode:'text',allowOther:true,idempotencyKey:'route-branch'});
 const devPage=await app.inject('/api/all-chat?limit=1'),branchPage=await app.inject('/api/branches/engine/all-chat?limit=1');
 assert.equal(devPage.statusCode,200,devPage.body);assert.deepEqual(devPage.json().decisions.map(item=>item.decision.id),[dev.id]);
 assert.equal(branchPage.statusCode,200,branchPage.body);assert.deepEqual(branchPage.json().decisions.map(item=>item.decision.id),[branch.id]);
});

test('usage totals, breakdown identities, and recent turns follow canonical Chat ownership',t=>{
 const f=setup(t),insert=f.store.sqlite.prepare(`INSERT INTO runs(id,agent_id,title,status,reason,engine,started_at,updated_at,completed_at,input_tokens,output_tokens,total_tokens) VALUES(?,?,?,'completed','turn_completed','codex',?,?,?,?,?,?)`);
 insert.run('dev-run',f.devAgent.id,'Dev Run','2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z','2026-01-01T00:00:01.000Z',2,3,5);
 insert.run('branch-run',f.branchAgent.id,'Branch Run','2026-01-02T00:00:00.000Z','2026-01-02T00:00:01.000Z','2026-01-02T00:00:01.000Z',7,4,11);
 const dev=f.store.getTokenUsage({type:'overall',product:'dev'}),branches=f.store.getTokenUsage({type:'overall',product:'branches'}),projectDev=f.store.getTokenUsage({type:'project',id:f.project.id,product:'dev'}),branch=f.store.getTokenUsage({type:'branch',id:f.branch.id});
 assert.deepEqual({runs:dev.finalizedRuns,total:dev.totalTokens,ids:dev.breakdown.map(x=>x.agentId),turns:dev.recentTurns.map(x=>x.executionId)},{runs:1,total:5,ids:[f.devAgent.id],turns:['dev-run']});
 assert.deepEqual({runs:branches.finalizedRuns,total:branches.totalTokens,ids:branches.breakdown.map(x=>x.agentId),turns:branches.recentTurns.map(x=>x.executionId)},{runs:1,total:11,ids:[f.branchAgent.id],turns:['branch-run']});
 assert.equal(projectDev.totalTokens,5);assert.equal(branch.totalTokens,11);
});

test('Agent deletion validates the full cascade and durable replay receipt',async t=>{
 const f=setup(t),app=Fastify({rewriteUrl:rewriteProductUrl});t.after(()=>app.close());
 const manualRoot=f.store.createAgent(f.project.id,{title:'Manual Branch Root',engine:'codex',conversationId:f.branchChat.id,managementPermissions:permissions});
 const installedChild=f.store.createAgent(f.project.id,{title:'Installed Branch Child',engine:'codex',conversationId:f.branchChat.id,managerAgentId:manualRoot.id,managementPermissions:permissions});
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'active')").run(f.branch.id,'cascade-package','cascade-chat','installed-child',installedChild.id);
 registerProductScope(app,f.store,f.workspace,()=>undefined,()=>false);
 app.post('/api/projects/:id/agent-deletions/preview',async()=>({accepted:true}));
 app.post('/api/projects/:id/agent-deletions/commit',async()=>({accepted:true}));
 const descendant=await app.inject({method:'POST',url:`/api/branches/engine/projects/${f.project.id}/agent-deletions/preview`,payload:{rootAgentIds:[manualRoot.id]}});
 assert.equal(descendant.statusCode,409,descendant.body);
 const mixed=await app.inject({method:'POST',url:`/api/branches/engine/projects/${f.project.id}/agent-deletions/preview`,payload:{rootAgentIds:[manualRoot.id,f.devAgent.id]}});
 assert.equal(mixed.statusCode,404,mixed.body);

 const replayRoot=f.store.createAgent(f.project.id,{title:'Replay Root',engine:'codex',conversationId:f.branchChat.id,managementPermissions:permissions});
 const replayChild=f.store.createAgent(f.project.id,{title:'Replay Installed Child',engine:'codex',conversationId:f.branchChat.id,managerAgentId:replayRoot.id,managementPermissions:permissions});
 const preview=f.store.previewAgentDeletion([replayRoot.id]);
 f.store.deleteAgentSubtrees(preview.rootAgentIds,preview.previewHash);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'active')").run(f.branch.id,'replay-package','replay-chat','replay-child',replayChild.id);
 const replay=await app.inject({method:'POST',url:`/api/branches/engine/projects/${f.project.id}/agent-deletions/commit`,payload:{rootAgentIds:[replayRoot.id],previewHash:preview.previewHash}});
 assert.equal(replay.statusCode,409,replay.body);
});

test('deleted Chat and Project events retain product scope for live delivery and replay',t=>{
 const f=setup(t);
 const assertDelivery=(event,owner)=>{
  for(const candidate of [event,f.workspace.readSince(event.id-1).find(item=>item.id===event.id)]){
   assert.ok(candidate);
   assert.equal(workspaceEventInProduct(f.store,f.workspace,candidate.event,owner),true);
   assert.equal(workspaceEventInProduct(f.store,f.workspace,candidate.event,owner==='dev'?'branches':'dev'),false);
  }
 };
 const devRemoved=f.store.createConversation(f.project.id,{title:'Removed Dev Chat'});
 const branchRemoved=f.store.createConversation(f.project.id,{title:'Removed Branch Chat'});
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(f.branch.id,branchRemoved.id);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,'',?,'retiring')").run(f.branch.id,'deletion-events','removed-branch-chat',branchRemoved.id);
 for(const [chat,owner] of [[devRemoved,'dev'],[branchRemoved,'branches']]){
  f.store.markConversationDeletionPending(chat.id);
  const receipt=f.store.commitConversationDeletion(chat.id);
  assert.equal(receipt.branchId,owner==='branches'?f.branch.id:undefined);
  assertDelivery(f.workspace.reconcileConversationDeletion(f.project.id,chat.id),owner);
 }
 const createProjectReceipt=owner=>{
  const project=f.store.createProject({label:`Removed ${owner}`,hostPath:join(f.dir,`removed-${owner}`),defaultEngine:'codex'});
  if(owner==='branches')f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(f.branch.id,project.lastConversationId);
  const receipt=f.store.commitProjectDeletion(project.id);
  assert.equal(receipt.productScope,owner);
  return f.workspace.reconcileProjectDeletion(project.id);
 };
 assertDelivery(createProjectReceipt('dev'),'dev');
 assertDelivery(createProjectReceipt('branches'),'branches');
});

test('search recents, results, and All Chat exclude staging and retiring Branch Chats before limits',t=>{
 const f=setup(t);
 const active=f.store.createConversation(f.project.id,{title:'Active Branch Search'});
 const retiring=f.store.createConversation(f.project.id,{title:'Retiring Branch Search'});
 const staging=f.store.createConversation(f.project.id,{title:'Staging Branch Search'});
 for(const chat of [active,retiring,staging])f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(f.branch.id,chat.id);
 const append=(chat,id)=>{
  const createdAt=`2026-01-01T00:00:0${id}.000Z`,eventId=`scope-search-${id}`;
  f.store.appendCommunicationEvent({eventId,schemaVersion:2,projectId:f.project.id,conversationId:chat.id,sender:{kind:'user',userId:'local-user'},intent:'broadcast',audience:{kind:'organization',organizationId:f.project.id},text:`scope-token ${id}`,createdAt});
  assert.ok(f.store.appendConversationMessage(chat.id,{role:'user',text:`scope-token ${id}`},undefined,'main',undefined,undefined,eventId));
 };
 append(active,1);append(retiring,2);append(staging,3);
 const bind=f.store.sqlite.prepare('INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,\'\',?,?)');
 bind.run(f.branch.id,'search-package','active',active.id,'active');
 bind.run(f.branch.id,'search-package','retiring',retiring.id,'retiring');
 bind.run(f.branch.id,'search-package','staging',staging.id,'staging');
 const search=f.store.searchGlobalChats({product:'branches',query:'scope-token',limit:1,recentLimit:1,maxScannedMessages:1});
 assert.deepEqual(search.results.map(item=>item.chat.id),[active.id]);
 const recent=f.store.searchGlobalChats({product:'branches',limit:1,recentLimit:1,maxScannedMessages:1});
 assert.deepEqual(recent.recentChats.map(item=>item.chat.id),[active.id]);
 const all=f.store.getAllChatPage({product:'branches',limit:1});
 assert.deepEqual(all.items.map(item=>item.source.conversationId),[active.id]);
});

test('Branch trigger read and pause responses remain in Branches without a Dev Agent',async t=>{
 const f=setup(t),trigger=f.coordination.createTriggerDefinition({projectId:'',conversationId:'',branchId:f.branch.id,name:'Branch schedule',instructions:'Run',sourceKind:'schedule',sourceConfig:{scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'},enabled:true});
 const app=Fastify({rewriteUrl:rewriteProductUrl});t.after(()=>app.close());
 registerProductScope(app,f.store,f.workspace,()=>undefined,()=>false);
 app.get('/api/triggers',async()=>[f.coordination.getTriggerDefinition(trigger.id)]);
 app.patch('/api/triggers/:id',async request=>({ ...f.coordination.getTriggerDefinition(request.params.id),enabled:request.body.enabled }));
 const read=await app.inject('/api/branches/engine/triggers');assert.equal(read.statusCode,200);assert.equal(read.json()[0].id,trigger.id);
 const pause=await app.inject({method:'PATCH',url:`/api/branches/engine/triggers/${trigger.id}`,payload:{enabled:false}});assert.equal(pause.statusCode,200,pause.body);assert.equal(pause.json().enabled,false);
 const dev=await app.inject('/api/triggers');assert.deepEqual(dev.json(),[]);
});
