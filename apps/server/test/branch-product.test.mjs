import {registerNotificationListRoute,registerNotificationMutationRoutes} from '../dist/routes/notifications.js';
import {AgentWorkProjection,registerAgentWorkRoutes} from '../dist/routes/agent-work.js';
import {registerCommunicationDocumentRoutes} from '../dist/routes/communication-documents.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,BranchStore,WorkspaceStore} from '@ponderosa/agents';
import {registerProductScope,rewriteProductUrl,productPreferences,mergeProductPreferencePatch,resourceInProduct} from '../dist/product-scope.js';
import {BranchInstallationService} from '../dist/branch-installation-service.js';
import {registerAgentPackageRoutes} from '../dist/routes/agent-packages.js';
import {registerBranchRoutes} from '../dist/routes/branches.js';
import {AssetStore} from '../dist/assets.js';
const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
const definition={schema:'ponderosa.branch.v1',name:'Installed',trigger:{kind:'manual'},entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Review',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
function pkg(){return {schema:'ponderosa.branch-installation.v1',packageId:'portable-application',mode:'template',exportedAt:new Date().toISOString(),definition,chats:[{ref:'review',title:'Security review',agents:[{ref:'lead',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Security',rootRef:'lead',agents:[{ref:'lead',title:'Security lead',engine:'codex',managementPermissions:permissions}]}}]}],agentBindings:{lead:{chatRef:'review',agentRef:'lead'}},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}}}
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'branch-product-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),workspace=new WorkspaceStore(dir),assets=new AssetStore(dir),app=Fastify({rewriteUrl:rewriteProductUrl});
 const installations=new BranchInstallationService(store,branches,async id=>{const c=store.getConversation(id);if(!c)return;const agents=store.listAgents(c.projectId).filter(a=>a.conversationId===id);for(const a of agents)store.deleteAgent(a.id);store.markConversationDeletionPending(id);store.commitConversationDeletion(id,()=>{});},async id=>store.deleteAgent(id),branchId=>workspace.forEachNotification(notification=>{if(notification.branchId===branchId&&(notification.status??'open')==='open')workspace.setNotificationStatus(notification.id,'resolved')}));
 registerProductScope(app,store,workspace,()=>undefined,()=>false);
 let runtimeRefreshes=0;registerBranchRoutes(app,{store,branches,installations,sources:{async refresh(){runtimeRefreshes++},async applyDefinitionChange(){},async reconcileBranch(){}},notify(){}});
 registerAgentPackageRoutes(app,{dataDir:dir,store,coordination,assets,branchInstallations:installations,engines:new Map([['codex',{adapter:{id:'codex',listModels:()=>[],listEfforts:()=>[]}}]]),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:()=>[],createOperationalNotification(){}});
 app.get('/api/agents/:id',async req=>store.getAgent(req.params.id));
 app.get('/api/projects/:id',async req=>store.getProject(req.params.id));
 const agentWorkProjection=new AgentWorkProjection(store,coordination,workspace);
 registerAgentWorkRoutes(app,{store,projection:agentWorkProjection});
 const documents=new Map();
 registerCommunicationDocumentRoutes(app,(_projectId,documentId)=>documents.get(documentId),store);
 app.get('/api/decisions/:id/action',async req=>workspace.getDecision(req.params.id)??{error:'missing'});
 app.post('/api/decisions/:id/respond',async req=>workspace.getDecision(req.params.id)??{error:'missing'});
 const notifications={workspace,store,publishWorkspaceSince(){}};registerNotificationListRoute(app,notifications);registerNotificationMutationRoutes(app,notifications);
 app.put('/api/notification-settings/:kind/:id',async()=>({updated:true}));
 app.post('/api/workspace/recent-resources/use',async req=>workspace.markResourceUsed(req.body.kind,req.body.resourceId));
 let closed=false;const close=async()=>{if(closed)return;closed=true;await app.close();assets.close();store.close();};
 t.after(async()=>{await close();rmSync(dir,{recursive:true,force:true})});
 return {dir,store,workspace,branches,app,installations,documents,close,runtimeRefreshes:()=>runtimeRefreshes,bindings:{agents:{},directories:{workspace:dir},engines:{codex:'codex',default:'codex'}}};
}

test('background package publication refreshes live trigger sources',async t=>{
 const f=await fixture(t),plan=f.installations.preview(pkg(),f.bindings);
 const result=await f.installations.confirm(plan.id);assert.equal(result.state,'completed',result.error);assert.equal(f.runtimeRefreshes(),1);
});

test('imported webhook trigger stays paused until its visible secret is rotated',async t=>{
 const f=await fixture(t),p=pkg();p.chats=[];p.agentBindings={};p.definition={...p.definition,trigger:{kind:'webhook',configRef:'source'}};p.triggers={source:{enabled:true,sourceConfig:{replayWindowSeconds:300}}};
 const plan=f.installations.preview(p,{...f.bindings,triggers:p.triggers}),result=await f.installations.confirm(plan.id);assert.equal(result.state,'completed',result.error);
 const trigger=f.branches.trigger(result.branchId);assert.equal(trigger.sourceKind,'webhook');assert.equal(trigger.enabled,false);assert.equal(trigger.secretFingerprint,undefined);assert.equal(trigger.secretCiphertext,undefined);
});

test('import twice creates distinct local identities; product APIs reject foreign Agents',async t=>{
 const f=await fixture(t),p=pkg();
 const first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),second=await f.installations.confirm(f.installations.preview(p,f.bindings).id);
 assert.equal(first.state,'completed',first.error);assert.equal(second.state,'completed',second.error);assert.notEqual(first.branchId,second.branchId);
 const a=f.branches.localConfiguration(first.branchId).agents.lead,b=f.branches.localConfiguration(second.branchId).agents.lead;assert.notEqual(a,b);assert.notEqual(a,'lead');
 assert.equal(f.store.getConversation(f.store.getAgent(a).conversationId).branchId,first.branchId);
 assert.equal((await f.app.inject('/api/agents/'+a)).statusCode,404);
 assert.equal((await f.app.inject('/api/branches/engine/agents/'+a)).statusCode,200);
 const dev=f.store.createProject({label:'Dev',hostPath:f.dir,defaultEngine:'codex'}),devAgent=f.store.createAgent(dev.id,{title:'Dev worker',engine:'codex',conversationId:dev.lastConversationId});
 assert.equal((await f.app.inject('/api/branches/engine/agents/'+devAgent.id)).statusCode,404);
 assert.equal((await f.app.inject('/api/agents/'+devAgent.id)).statusCode,200);
});
test('preview changes no live resources; exact identity update preserves Agent history',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id);assert.equal(first.state,'completed',first.error);
 const a=f.branches.localConfiguration(first.branchId).agents.lead;f.store.setImportedHistory(a,'Earlier context',[{role:'assistant',text:'Keep this expertise'}]);
 p.chats[0].agents[0].definition.agents[0].title='Updated lead';
 const preview=f.installations.preview(p,f.bindings,first.branchId);
 assert.equal(f.store.getAgent(a).title,'Security lead');
 const result=await f.installations.confirm(preview.id);assert.equal(result.state,'completed',result.error);
 assert.equal(f.branches.localConfiguration(first.branchId).agents.lead,a);assert.equal(f.store.getAgent(a).title,'Updated lead');assert.equal(f.store.getImportedHistory(a).messages[0].text,'Keep this expertise');
 const replay=await f.installations.confirm(preview.id);assert.equal(replay.state,'completed');
});
test('package update replaces an incompatible configured parameter atomically',async t=>{
 const f=await fixture(t),p=pkg();p.definition={...p.definition,parameters:{count:{type:'text'}}};p.parameters={count:'old'};
 const first=await f.installations.confirm(f.installations.preview(p,f.bindings).id);assert.equal(first.state,'completed',first.error);
 p.definition={...p.definition,parameters:{count:{type:'number'}}};p.parameters={count:42};
 const plan=f.installations.preview(p,f.bindings,first.branchId),updated=await f.installations.confirm(plan.id);
 assert.equal(updated.state,'completed',updated.error);assert.deepEqual(f.branches.configuration(first.branchId).parameters,{count:42});
 assert.equal(f.installations.status(plan.id).error,undefined);
});

test('a failed installation does not starve unrelated plans and can be stopped safely',async t=>{
 const f=await fixture(t),bad=pkg(),good=pkg();bad.packageId='bad-package';bad.definition={...bad.definition,name:'Broken update'};good.packageId='good-package';good.definition={...good.definition,name:'Healthy update'};
 f.installations.setPublisher((input,configuration)=>{if(input.definition.name==='Broken update')throw new Error('permanent publisher rejection');return f.branches.deploy(input,new Date().toISOString(),undefined,configuration)});
 const badPlan=f.installations.preview(bad,f.bindings),failed=await f.installations.confirm(badPlan.id);assert.equal(failed.state,'applying');assert.match(failed.error,/permanent publisher rejection/);
 const goodPlan=f.installations.preview(good,f.bindings),completed=await f.installations.confirm(goodPlan.id);assert.equal(completed.state,'completed',completed.error);
 const stopped=await f.installations.cancel(badPlan.id);assert.equal(stopped.state,'canceled');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE branch_id=? AND state='staging'").get(failed.branchId).n,0);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_plans WHERE state='applying'").get().n,0);
});

test('removal retires a Chat until old snapshot drains, then deletes it',async t=>{
 const f=await fixture(t),p=pkg(),installed=await f.installations.confirm(f.installations.preview(p,f.bindings).id);assert.equal(installed.state,'completed',installed.error);
 const id=installed.branchId,a=f.branches.localConfiguration(id).agents.lead,chatId=f.store.getAgent(a).conversationId;
 const execution=f.branches.accept(id,'old','input');f.branches.advance();
 const removed={...p,chats:[],agentBindings:{}};const result=await f.installations.confirm(f.installations.preview(removed,f.bindings,id).id);assert.equal(result.state,'completed',result.error);
 assert.ok(f.store.getConversation(chatId));assert.equal((await f.app.inject(`/api/branches/${id}/chats`)).json().length,0);
 assert.throws(()=>f.store.markConversationDeletionPending(chatId),/drain/);
 f.branches.cancel(execution.id);await f.installations.tick();assert.equal(f.store.getConversation(chatId),undefined);
});
test('Branch with no Chats can publish and run; Dev Agent bindings are rejected',async t=>{
 const f=await fixture(t),b=f.branches.create('No Chat','create');
 const response=await f.app.inject({method:'POST',url:'/api/branches/deploy',payload:{chatId:'',branchId:b.id,expectedVersionId:'',idempotencyKey:'publish',definition,bindings:{agents:{},directories:{}}}});assert.equal(response.statusCode,200,response.body);
 assert.ok(f.branches.accept(b.id,'manual','').id);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_id=?').get(b.id).n,0);
});

test('publication and completion receipt roll back together and retry exactly once',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id);assert.equal(first.state,'completed');
 const before=f.branches.getBranch(first.branchId).versionId;p.definition={...p.definition,name:'Next definition'};
 const plan=f.installations.preview(p,f.bindings,first.branchId);
 f.store.sqlite.exec("CREATE TRIGGER interrupt_completion BEFORE UPDATE OF state ON branch_installation_plans WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'crash at completion receipt'); END");
 const interrupted=await f.installations.confirm(plan.id);assert.equal(interrupted.state,'applying');assert.equal(f.branches.getBranch(first.branchId).versionId,before);
 f.store.sqlite.exec('DROP TRIGGER interrupt_completion');f.store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL WHERE id=?').run(plan.id);await f.installations.tick();assert.equal(f.installations.status(plan.id).state,'completed');
 const after=f.branches.getBranch(first.branchId).versionId;assert.notEqual(after,before);await f.installations.confirm(plan.id);assert.equal(f.branches.getBranch(first.branchId).versionId,after);
});

test('removed Agent drains only pre-update executions while its Chat remains active',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),id=first.branchId,a=f.branches.localConfiguration(id).agents.lead;
 const old=f.branches.accept(id,'old','');f.branches.advance();
 p.chats[0].agents=[];p.agentBindings={};assert.equal((await f.installations.confirm(f.installations.preview(p,f.bindings,id).id)).state,'completed');
 const current=f.branches.accept(id,'new','');f.branches.advance();assert.ok(f.store.getAgent(a));f.branches.cancel(old.id);await f.installations.tick();
 assert.equal(f.store.getAgent(a),undefined);assert.equal(f.branches.execution(current.id).state,'waiting');
});

test('notification batch mutations and resource settings cannot cross product scope',async t=>{
 const f=await fixture(t),first=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id),id=f.branches.localConfiguration(first.branchId).agents.lead;
 const notification=f.workspace.createNotification({kind:'direct_response',title:'Branch result',body:'Private workflow result',branchId:first.branchId,requiresAction:false});
 assert.equal((await f.app.inject({method:'POST',url:'/api/notifications/read-batch',payload:{notificationIds:[notification.id]}})).statusCode,404);
 assert.equal((await f.app.inject({method:'PUT',url:`/api/notification-settings/agent/${id}`,payload:{mode:'muted'}})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url:'/api/workspace/recent-resources/use',payload:{kind:'agent',resourceId:id}})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url:'/api/branches/engine/workspace/recent-resources/use',payload:{kind:'agent',resourceId:id}})).statusCode,200);
 const preferences={...f.workspace.getPreferences(),agentOrder:[id],notificationScopes:{['agent:'+id]:'muted'}};
 assert.deepEqual(productPreferences(f.store,preferences,'dev').agentOrder,[]);assert.deepEqual(productPreferences(f.store,preferences,'dev').notificationScopes,{});
 assert.deepEqual(mergeProductPreferencePatch(f.store,preferences,{agentOrder:[]},'dev').agentOrder,[id]);
});

test('export excludes retiring Agents and preview contains concrete proposed changes',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),id=first.branchId;
 f.branches.accept(id,'old','');f.branches.advance();p.chats[0].agents=[];p.chats[0].instructions='New instructions';p.agentBindings={};p.limits.maxCallDepth=7;
 const preview=f.installations.preview(p,f.bindings,id);
 assert.ok(preview.operations.some(op=>op.resource==='Chat instructions'&&op.after.instructions==='New instructions'));
 assert.ok(preview.operations.some(op=>op.resource==='Execution limits'&&op.after?.maxCallDepth===7));
 assert.equal((await f.installations.confirm(preview.id)).state,'completed');
 const exported=await f.installations.export(id,'template');assert.deepEqual(exported.chats[0].agents,[]);
});

test('confirmation rejects stale resource settings as well as stale definitions',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),id=first.branchId;
 const plan=f.installations.preview(p,f.bindings,id),agent=f.branches.localConfiguration(id).agents.lead;f.store.updateAgent(agent,{title:'Manual change after preview'});
 await assert.rejects(()=>f.installations.confirm(plan.id),/settings changed/);assert.equal(f.store.getAgent(agent).title,'Manual change after preview');assert.equal(f.installations.status(plan.id).state,'preview');
});

test('secret values and bindings stay outside ordinary settings and packages',async t=>{
 const f=await fixture(t),p=pkg();p.definition={...p.definition,parameters:{credential:{type:'secret'}}};
 const first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),id=first.branchId;
 const initial=(await f.app.inject(`/api/branches/${id}/settings`)).json();
 f.branches.configure(id,{parameters:{},limits:p.limits,secretBindings:{credential:'engine-owned-binding'}},initial.revision);
 const settings=(await f.app.inject(`/api/branches/${id}/settings`)).json();assert.equal(settings.configuration.secretBindings,undefined);assert.equal(settings.secretStatus.credential,'configured');
 const exported=await f.installations.export(id,'full',true);assert.equal(JSON.stringify(exported).includes('engine-owned-binding'),false);
 const forged=await f.app.inject({method:'PUT',url:`/api/branches/${id}/settings`,payload:{revision:settings.revision,configuration:{...settings.configuration,secretBindings:{credential:'plaintext-value'}}}});assert.equal(forged.statusCode,409);
 assert.throws(()=>f.installations.preview({...p,parameters:{credential:'secret-bytes'}},f.bindings),/Secrets/);
});

test('mixed Projects scope each Agent by its owning Chat and hide inactive installation resources',async t=>{
 const f=await fixture(t),project=f.store.createProject({label:'Mixed',hostPath:f.dir,defaultEngine:'codex'}),devChat=f.store.getConversation(project.lastConversationId),branchChat=f.store.createConversation(project.id,{title:'Branch Chat'}),branch=f.branches.create('Mixed Branch','mixed');
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
 const devAgent=f.store.createAgent(project.id,{title:'Dev Agent',engine:'codex',conversationId:devChat.id}),branchAgent=f.store.createAgent(project.id,{title:'Branch Agent',engine:'codex',conversationId:branchChat.id});
 assert.equal(resourceInProduct(f.store,'project',project.id,'dev'),true);assert.equal(resourceInProduct(f.store,'project',project.id,'branches'),true);assert.equal(resourceInProduct(f.store,'agent',devAgent.id,'dev'),true);assert.equal(resourceInProduct(f.store,'agent',devAgent.id,'branches'),false);assert.equal(resourceInProduct(f.store,'agent',branchAgent.id,'branches'),true);assert.equal(resourceInProduct(f.store,'agent',branchAgent.id,'dev'),false);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'staging')").run(branch.id,'mixed-package','mixed-chat','mixed-agent',branchAgent.id);
 assert.equal(resourceInProduct(f.store,'agent',branchAgent.id,'branches'),false);assert.equal((await f.app.inject(`/api/branches/engine/agents/${branchAgent.id}`)).statusCode,404);
});

test('mixed Project Agent Work filters before gzip serialization and direct detail reads',async t=>{
 const f=await fixture(t),project=f.store.createProject({label:'Mixed work',hostPath:f.dir,defaultEngine:'codex'});
 const devChat=f.store.getConversation(project.lastConversationId),branchChat=f.store.createConversation(project.id,{title:'Branch work'}),branch=f.branches.create('Work Branch','mixed-work');
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
 const devAgent=f.store.createAgent(project.id,{title:'Dev Work Agent',engine:'codex',conversationId:devChat.id});
 const branchAgent=f.store.createAgent(project.id,{title:'Branch Work Agent',engine:'codex',conversationId:branchChat.id});
 const devDecision=f.workspace.createDecision({projectId:project.id,conversationId:devChat.id,agentId:devAgent.id,question:'Dev question',options:[],mode:'text',allowOther:true,idempotencyKey:'dev-work'});
 const branchDecision=f.workspace.createDecision({projectId:project.id,conversationId:branchChat.id,agentId:branchAgent.id,question:'Branch question',options:[],mode:'text',allowOther:true,idempotencyKey:'branch-work'});
 const read=async url=>{
  const response=await f.app.inject({method:'GET',url,headers:{'accept-encoding':'gzip'}});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.headers['content-encoding'],'gzip');
  return JSON.parse(gunzipSync(response.rawPayload).toString('utf8'));
 };
 const dev=await read(`/api/projects/${project.id}/agent-work`);
 assert.deepEqual(dev.agents.map(agent=>agent.id),[devAgent.id]);
 assert.deepEqual(dev.items.filter(item=>item.kind==='decision').map(item=>item.recordId),[devDecision.id]);
 const branches=await read(`/api/branches/engine/projects/${project.id}/agent-work`);
 assert.deepEqual(branches.agents.map(agent=>agent.id),[branchAgent.id]);
 assert.deepEqual(branches.items.filter(item=>item.kind==='decision').map(item=>item.recordId),[branchDecision.id]);
 assert.equal((await f.app.inject(`/api/projects/${project.id}/agent-work/items/decision/${branchDecision.id}`)).statusCode,404);
 assert.equal((await f.app.inject(`/api/branches/engine/projects/${project.id}/agent-work/items/decision/${devDecision.id}`)).statusCode,404);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'retiring')").run(branch.id,'scope-package','scope-chat','scope-agent',branchAgent.id);
 let retired=await read(`/api/branches/engine/projects/${project.id}/agent-work`);
 assert.deepEqual(retired.agents,[]);assert.deepEqual(retired.items,[]);
 f.store.sqlite.prepare("DELETE FROM branch_installation_resources WHERE local_id=?").run(branchAgent.id);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'retiring')").run(branch.id,'scope-package','scope-chat','',branchChat.id);
 const inactiveProject=await f.app.inject(`/api/branches/engine/projects/${project.id}/agent-work`);
 assert.equal(inactiveProject.statusCode,404,"retiring-only Branch Projects are not live");
});

test('mixed Project decisions and Project last Chat pointers use canonical Chat ownership',async t=>{
 const f=await fixture(t),project=f.store.createProject({label:'Mixed decisions',hostPath:f.dir,defaultEngine:'codex'});
 const devChat=f.store.getConversation(project.lastConversationId),branchChat=f.store.createConversation(project.id,{title:'Branch decisions'}),branch=f.branches.create('Decision Branch','mixed-decisions');
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
 const devAgent=f.store.createAgent(project.id,{title:'Dev Decision Agent',engine:'codex',conversationId:devChat.id});
 const branchAgent=f.store.createAgent(project.id,{title:'Branch Decision Agent',engine:'codex',conversationId:branchChat.id});
 const devDecision=f.workspace.createDecision({projectId:project.id,conversationId:devChat.id,agentId:devAgent.id,question:'Dev?',options:[],mode:'text',allowOther:true,idempotencyKey:'dev-decision'});
 const branchDecision=f.workspace.createDecision({projectId:project.id,conversationId:branchChat.id,agentId:branchAgent.id,question:'Branch?',options:[],mode:'text',allowOther:true,idempotencyKey:'branch-decision'});
 assert.equal((await f.app.inject({method:'POST',url:`/api/decisions/${branchDecision.id}/respond`,payload:{text:'no'}})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url:`/api/branches/engine/decisions/${devDecision.id}/respond`,payload:{text:'no'}})).statusCode,404);
 assert.equal((await f.app.inject(`/api/decisions/${branchDecision.id}/action`)).statusCode,404);
 assert.equal((await f.app.inject(`/api/branches/engine/decisions/${devDecision.id}/action`)).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url:`/api/decisions/${devDecision.id}/respond`,payload:{text:'yes'}})).statusCode,200);
 assert.equal((await f.app.inject({method:'POST',url:`/api/branches/engine/decisions/${branchDecision.id}/respond`,payload:{text:'yes'}})).statusCode,200);
 f.store.markProjectUsed(project.id,branchChat.id);
 const devProject=(await f.app.inject(`/api/projects/${project.id}`)).json();
 const branchProject=(await f.app.inject(`/api/branches/engine/projects/${project.id}`)).json();
 assert.equal(devProject.lastConversationId,undefined);
 assert.equal(branchProject.lastConversationId,branchChat.id);
 f.store.markProjectUsed(project.id,devChat.id);
 assert.equal((await f.app.inject(`/api/projects/${project.id}`)).json().lastConversationId,devChat.id);
 assert.equal((await f.app.inject(`/api/branches/engine/projects/${project.id}`)).json().lastConversationId,undefined);
});

test('mixed Project notification reads and every mutation use one Chat-aware predicate',async t=>{
 const f=await fixture(t),project=f.store.createProject({label:'Mixed notifications',hostPath:f.dir,defaultEngine:'codex'});
 const devChat=f.store.getConversation(project.lastConversationId),branchChat=f.store.createConversation(project.id,{title:'Branch notifications'}),branch=f.branches.create('Notification Branch','mixed-notifications');
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
 const devAgent=f.store.createAgent(project.id,{title:'Dev Notify Agent',engine:'codex',conversationId:devChat.id});
 const branchAgent=f.store.createAgent(project.id,{title:'Branch Notify Agent',engine:'codex',conversationId:branchChat.id});
 const dev=f.workspace.createNotification({projectId:project.id,conversationId:devChat.id,agentId:devAgent.id,communicationEventId:'dev-event',kind:'direct_response',title:'Dev',body:'Dev only'});
 const branches=f.workspace.createNotification({projectId:project.id,conversationId:branchChat.id,agentId:branchAgent.id,communicationEventId:'branch-event',kind:'direct_response',title:'Branch',body:'Branch only'});
 const ambiguous=f.workspace.createNotification({projectId:project.id,kind:'operational',severity:'info',title:'Ambiguous',body:'No canonical owner'});
 assert.deepEqual((await f.app.inject('/api/notifications')).json().items.map(item=>item.id),[dev.id]);
 assert.deepEqual((await f.app.inject('/api/branches/engine/notifications')).json().items.map(item=>item.id),[branches.id]);
 for(const [prefix,foreign,own] of [['',branches,dev],['/branches/engine',dev,branches]]){
  assert.equal((await f.app.inject({method:'POST',url:`/api${prefix}/notifications/active`,payload:{notificationIds:[foreign.id]}})).statusCode,404);
  assert.equal((await f.app.inject({method:'POST',url:`/api${prefix}/notifications/read-batch`,payload:{notificationIds:[foreign.id]}})).statusCode,404);
  assert.equal((await f.app.inject({method:'POST',url:`/api${prefix}/notifications/acknowledge-batch`,payload:{notificationIds:[foreign.id]}})).statusCode,404);
  assert.equal((await f.app.inject({method:'POST',url:`/api${prefix}/notifications/${foreign.id}/status`,payload:{status:'dismissed'}})).statusCode,404);
  assert.equal((await f.app.inject({method:'POST',url:`/api${prefix}/notifications/${foreign.id}/read`})).statusCode,404);
  assert.equal((await f.app.inject({method:'POST',url:`/api${prefix}/notifications/read-visible`,payload:{communicationEventIds:[foreign.communicationEventId]}})).json().read,0);
  assert.equal((await f.app.inject({method:'POST',url:`/api${prefix}/notifications/read-visible`,payload:{communicationEventIds:[own.communicationEventId]}})).json().read,1);
 }
 assert.equal(f.workspace.getNotification(ambiguous.id).readAt,undefined);
 assert.equal((await f.app.inject({method:'POST',url:`/api/notifications/read-batch`,payload:{notificationIds:[ambiguous.id]}})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url:`/api/branches/engine/notifications/read-batch`,payload:{notificationIds:[ambiguous.id]}})).statusCode,404);
});

test('communication document metadata and downloads follow event Chat and author ownership',async t=>{
 const f=await fixture(t),project=f.store.createProject({label:'Mixed documents',hostPath:f.dir,defaultEngine:'codex'});
 const devChat=f.store.getConversation(project.lastConversationId),branchChat=f.store.createConversation(project.id,{title:'Branch documents'}),branch=f.branches.create('Document Branch','mixed-documents');
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
 const devAgent=f.store.createAgent(project.id,{title:'Dev Doc Agent',engine:'codex',conversationId:devChat.id});
 const branchAgent=f.store.createAgent(project.id,{title:'Branch Doc Agent',engine:'codex',conversationId:branchChat.id});
 const make=(id,conversationId,agentId,content)=>({
  event:{eventId:`event-${id}`,schemaVersion:2,projectId:project.id,conversationId,sender:{kind:'agent',agentId,executionId:`run-${id}`},text:'Attached',intent:'broadcast',audience:{kind:'organization',organizationId:conversationId},createdAt:new Date().toISOString()},
  document:{id,title:id,mediaType:'text/markdown',artifactId:id,byteLength:Buffer.byteLength(content),authorAgentId:agentId,executionId:`run-${id}`,createdAt:new Date().toISOString(),content},
 });
 f.documents.set('dev-doc',make('dev-doc',devChat.id,devAgent.id,'dev content'));
 f.documents.set('branch-doc',make('branch-doc',branchChat.id,branchAgent.id,'branch content'));
 f.documents.set('cross-author',make('cross-author',branchChat.id,devAgent.id,'invalid'));
 const path=id=>`/projects/${project.id}/communication-documents/${id}`;
 assert.equal((await f.app.inject('/api'+path('dev-doc'))).statusCode,200);
 assert.equal((await f.app.inject('/api/branches/engine'+path('dev-doc'))).statusCode,404);
 assert.equal((await f.app.inject('/api'+path('branch-doc'))).statusCode,404);
 assert.equal((await f.app.inject('/api/branches/engine'+path('branch-doc'))).json().content,'branch content');
 assert.equal((await f.app.inject('/api'+path('branch-doc')+'/download')).statusCode,404);
 assert.equal((await f.app.inject('/api/branches/engine'+path('branch-doc')+'/download')).body,'branch content');
 assert.equal((await f.app.inject('/api/branches/engine'+path('cross-author'))).statusCode,404);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'retiring')").run(branch.id,'doc-package','doc-chat','doc-agent',branchAgent.id);
 assert.equal((await f.app.inject('/api/branches/engine'+path('branch-doc'))).statusCode,404);
 f.store.sqlite.prepare("DELETE FROM branch_installation_resources WHERE local_id=?").run(branchAgent.id);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,?,?,?,'retiring')").run(branch.id,'doc-package','doc-chat','',branchChat.id);
 assert.equal((await f.app.inject('/api/branches/engine'+path('branch-doc'))).statusCode,404);
});

test('foreign-only folders are omitted and their metadata cannot be changed',async t=>{
 const f=await fixture(t),first=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id),id=f.branches.localConfiguration(first.branchId).agents.lead,chat=f.store.getAgent(id).conversationId;
 const folder={id:'branch-folder',name:'Branch-only',expanded:true,conversationIds:[chat]},preferences={...f.workspace.getPreferences(),chatFolders:[folder]};
 assert.deepEqual(productPreferences(f.store,preferences,'dev').chatFolders,[]);
 assert.deepEqual(mergeProductPreferencePatch(f.store,preferences,{chatFolders:[{...folder,name:'Changed by Dev',expanded:false,conversationIds:[]}]},'dev').chatFolders,[folder]);
});

test('unchanged package does not report false Agent binding or organization changes',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),preview=f.installations.preview(p,f.bindings,first.branchId);
 assert.equal(preview.operations.some(op=>op.kind==='change'&&op.resource==='Local bindings'),false);
 assert.equal(preview.operations.some(op=>op.kind==='change'&&op.resource==='Organization relationships'),false);
});

test('failed publication preserves active Chat metadata, Agent settings, and reporting lines',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId;
 const leadId=f.branches.localConfiguration(branchId).agents.lead,lead=f.store.getAgent(leadId),chat=f.store.getConversation(lead.conversationId);
 p.chats[0].title='Changed Chat';p.chats[0].instructions='Changed instructions';p.chats[0].agents[0].managerRef='worker';p.chats[0].agents[0].definition.agents[0].title='Changed lead';
 p.chats[0].agents.push({ref:'worker',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Worker',rootRef:'worker',agents:[{ref:'worker',title:'Worker',engine:'codex',managementPermissions:permissions}]}});
 f.installations.setPublisher(()=>{throw new Error('publication rejected')});
 const plan=f.installations.preview(p,f.bindings,branchId),failed=await f.installations.confirm(plan.id);assert.equal(failed.state,'applying');assert.match(failed.error,/publication rejected/);
 assert.equal(f.store.getConversation(chat.id).title,chat.title);assert.equal(f.store.getConversation(chat.id).instructions,chat.instructions);
 assert.equal(f.store.getAgent(leadId).title,lead.title);assert.equal(f.store.getAgent(leadId).handle,lead.handle);assert.equal(f.store.getAgent(leadId).managerAgentId,lead.managerAgentId);
 await f.installations.cancel(plan.id);await f.installations.tick();
});

test('stop during an awaited import fences publication and retires the late imported Agent',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId,before=f.branches.getBranch(branchId).versionId;
 p.chats[0].agents.push({ref:'late',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Late',rootRef:'late',agents:[{ref:'late',title:'Late Agent',engine:'codex',managementPermissions:permissions}]}});
 let release,started;const gate=new Promise(resolve=>{release=resolve}),began=new Promise(resolve=>{started=resolve});let importedId;
 f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,chatId,_pkg,_mapping,_key,options){const id=crypto.randomUUID();options.branchHooks.plan([id],crypto.randomUUID());const a=f.store.createAgent(projectId,{title:'Late Agent',engine:'codex',conversationId:chatId},undefined,id);importedId=a.id;started();await Promise.race([gate,new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))]);const result={rootAgentId:a.id,agentIds:[a.id]};options.branchHooks.commit(result);return result}});
 const plan=f.installations.preview(p,f.bindings,branchId),confirmation=f.installations.confirm(plan.id);await began;
 const stopped=await f.installations.cancel(plan.id);assert.ok(['canceling','canceled'].includes(stopped.state));release();
 const result=await confirmation;assert.ok(['canceling','canceled'].includes(result.state));for(let i=0;i<3&&f.installations.status(plan.id)?.state==='canceling';i++)await f.installations.tick();assert.equal(f.installations.status(plan.id).state,'canceled');assert.equal(f.branches.getBranch(branchId).versionId,before);assert.equal(f.store.getAgent(importedId),undefined);
});

test('Branch deletion cancels an active package update before owned resources are removed',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId;
 p.chats[0].agents.push({ref:'late',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Late',rootRef:'late',agents:[{ref:'late',title:'Late Agent',engine:'codex',managementPermissions:permissions}]}});
 let started;const began=new Promise(resolve=>{started=resolve});let importedId;
 f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,chatId,_pkg,_mapping,_key,options){const id=crypto.randomUUID();options.branchHooks.plan([id],crypto.randomUUID());const a=f.store.createAgent(projectId,{title:'Late Agent',engine:'codex',conversationId:chatId},undefined,id);importedId=a.id;started();await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));throw new Error('unreachable')}});
 const plan=f.installations.preview(p,f.bindings,branchId),confirmation=f.installations.confirm(plan.id);await began;
 const deletion=await f.installations.delete(branchId);assert.equal(deletion.pending,true);await confirmation;for(let i=0;i<5&&f.branches.getBranch(branchId);i++)await f.installations.tick();
 assert.equal(f.branches.getBranch(branchId),undefined);assert.equal(f.store.getAgent(importedId),undefined);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_id=?').get(branchId).n,0);
});

test('a rolled-back pre-binding is replaced before retry publication',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId;
 p.chats[0].agents.push({ref:'retry',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Retry',rootRef:'retry',agents:[{ref:'retry',title:'Retry Agent',engine:'codex',managementPermissions:permissions}]}});let failedId;
 f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,_chatId,_pkg,_mapping,key,options){failedId=crypto.randomUUID();const operationId=crypto.randomUUID(),now=new Date().toISOString();f.store.sqlite.prepare("INSERT INTO agent_creation_operations(id,project_id,actor_scope,kind,idempotency_key,payload_hash,status,artifact_ids_json,created_at,updated_at) VALUES(?,?,'user:local-operator','import',?,?,'rolled_back','[]',?,?)").run(operationId,projectId,key,'hash',now,now);f.store.sqlite.prepare('INSERT INTO agent_creation_operation_members(operation_id,agent_id,position) VALUES(?,?,0)').run(operationId,failedId);options.branchHooks.plan([failedId],operationId);throw new Error('import rolled back')}});
 const plan=f.installations.preview(p,f.bindings,branchId),failed=await f.installations.confirm(plan.id);assert.equal(failed.state,'applying');assert.equal(f.store.getAgent(failedId),undefined);
 let replacementId;f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,chatId,_pkg,_mapping,_key,options){replacementId=crypto.randomUUID();options.branchHooks.plan([replacementId],crypto.randomUUID());const agent=f.store.createAgent(projectId,{title:'Retry Agent',engine:'codex',conversationId:chatId},undefined,replacementId);const result={rootAgentId:agent.id,agentIds:[agent.id]};options.branchHooks.commit(result);return result}});
 f.store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL WHERE id=?').run(plan.id);await f.installations.tick();assert.equal(f.installations.status(plan.id).state,'completed');assert.notEqual(replacementId,failedId);assert.ok(f.store.getAgent(replacementId));
});

test('a staged Agent cannot publish until its exact creation receipt is completed',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId,before=f.branches.getBranch(branchId).versionId;
 p.chats[0].agents.push({ref:'quarantined',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Quarantined',rootRef:'quarantined',agents:[{ref:'quarantined',title:'Quarantined Agent',engine:'codex',managementPermissions:permissions}]}});
 let operationId,agentId;f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,chatId,_pkg,_mapping,key,options){operationId=crypto.randomUUID();agentId=crypto.randomUUID();const now=new Date().toISOString();f.store.sqlite.prepare("INSERT INTO agent_creation_operations(id,project_id,actor_scope,kind,idempotency_key,payload_hash,status,artifact_ids_json,created_at,updated_at) VALUES(?,?,'user:local-operator','import',?,?,'rolling_back','[]',?,?)").run(operationId,projectId,key,'hash',now,now);f.store.sqlite.prepare('INSERT INTO agent_creation_operation_members(operation_id,agent_id,position) VALUES(?,?,0)').run(operationId,agentId);options.branchHooks.plan([agentId],operationId);f.store.createAgent(projectId,{title:'Quarantined Agent',engine:'codex',conversationId:chatId},undefined,agentId);throw new Error('rollback cleanup remains pending')}});
 const plan=f.installations.preview(p,f.bindings,branchId),failed=await f.installations.confirm(plan.id);assert.equal(failed.state,'applying');assert.ok(f.store.getAgent(agentId));
 f.store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL WHERE id=?').run(plan.id);await f.installations.tick();assert.equal(f.installations.status(plan.id).state,'applying');assert.equal(f.branches.getBranch(branchId).versionId,before);
 f.store.sqlite.prepare("UPDATE agent_creation_operations SET status='completed',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({rootAgentId:agentId,agentIds:[agentId]}),new Date().toISOString(),operationId);f.store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL WHERE id=?').run(plan.id);await f.installations.tick();assert.equal(f.installations.status(plan.id).state,'completed');assert.notEqual(f.branches.getBranch(branchId).versionId,before);assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_installation_resources WHERE local_id=?').get(agentId).state,'active');
});

test('cancellation stays nonterminal while an exactly owned staging Chat cannot be deleted',async t=>{
 const f=await fixture(t),installations=new BranchInstallationService(f.store,f.branches,async()=>{throw new Error('simulated Chat cleanup failure')},async()=>{}),p=pkg();
 installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(_projectId,_chatId,_pkg,_mapping,_key,options){const id=crypto.randomUUID();options.branchHooks.plan([id],crypto.randomUUID());throw new Error('stop before Agent creation')}});
 const plan=installations.preview(p,f.bindings),failed=await installations.confirm(plan.id);assert.equal(failed.state,'applying');const owned=f.store.sqlite.prepare("SELECT staging_plan_id,state FROM branch_installation_resources WHERE branch_id=?").all(failed.branchId);assert.ok(owned.length>=2);assert.ok(owned.every(row=>row.staging_plan_id===plan.id&&row.state==='staging'));
 const stopped=await installations.cancel(plan.id);assert.equal(stopped.state,'canceling');assert.equal(installations.status(plan.id).state,'canceling');assert.ok(f.store.sqlite.prepare("SELECT 1 FROM branch_installation_resources WHERE staging_plan_id=? AND state='retiring'").get(plan.id));
});

test('stopping a queued import returns before an unrelated active import drains',async t=>{
 const f=await fixture(t),first=pkg(),second=pkg();second.packageId='queued-cancel';second.definition={...second.definition,name:'Queued cancel'};
 let release,started;const gate=new Promise(resolve=>{release=resolve}),began=new Promise(resolve=>{started=resolve});let calls=0;
 f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,chatId,_pkg,_mapping,_key,options){calls++;const id=crypto.randomUUID();options.branchHooks.plan([id],crypto.randomUUID());const agent=f.store.createAgent(projectId,{title:'Imported Agent',engine:'codex',conversationId:chatId},undefined,id);started();await gate;const result={rootAgentId:agent.id,agentIds:[agent.id]};options.branchHooks.commit(result);return result}});
 const firstPlan=f.installations.preview(first,f.bindings),firstConfirmation=f.installations.confirm(firstPlan.id);await began;
 const secondPlan=f.installations.preview(second,f.bindings),secondConfirmation=f.installations.confirm(secondPlan.id);
 let stopped;try{stopped=await Promise.race([f.installations.cancel(secondPlan.id),new Promise((_,reject)=>setTimeout(()=>reject(new Error('queued cancellation waited for unrelated import')),1000))]);}finally{release();}
 assert.equal(stopped.state,'canceling');assert.equal(calls,1);await firstConfirmation;await secondConfirmation;
 for(let i=0;i<3&&f.installations.status(secondPlan.id)?.state==='canceling';i++)await f.installations.tick();
 assert.equal(f.installations.status(secondPlan.id).state,'canceled');assert.equal(calls,1);
});

test('shutdown fences queued imports before the current import drains',async t=>{
 const f=await fixture(t),first=pkg(),second=pkg();second.packageId='queued-after-stop';let started;const began=new Promise(resolve=>{started=resolve});let calls=0;
 f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(_projectId,_chatId,_pkg,_mapping,_key,options){calls++;const id=crypto.randomUUID();options.branchHooks.plan([id],crypto.randomUUID());started();await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));throw new Error('unreachable')}});
 const firstPlan=f.installations.preview(first,f.bindings),firstConfirmation=f.installations.confirm(firstPlan.id);await began;const secondPlan=f.installations.preview(second,f.bindings),secondConfirmation=f.installations.confirm(secondPlan.id);f.installations.requestStop();await firstConfirmation;await secondConfirmation;await f.installations.stop();assert.equal(calls,1);assert.equal(f.installations.status(secondPlan.id).state,'applying');
});

test('stopping a first-time import removes its empty Branch after late work drains',async t=>{
 const f=await fixture(t),p=pkg();let release,started;const gate=new Promise(resolve=>{release=resolve}),began=new Promise(resolve=>{started=resolve});let importedId;
 f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,chatId,_pkg,_mapping,_key,options){const id=crypto.randomUUID();options.branchHooks.plan([id],crypto.randomUUID());const a=f.store.createAgent(projectId,{title:'Late Agent',engine:'codex',conversationId:chatId},undefined,id);importedId=a.id;started();await Promise.race([gate,new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))]);const result={rootAgentId:a.id,agentIds:[a.id]};options.branchHooks.commit(result);return result}});
 const plan=f.installations.preview(p,f.bindings),confirmation=f.installations.confirm(plan.id);await began;const branchId=f.installations.status(plan.id).branchId;assert.ok(branchId);
 assert.ok(['canceling','canceled'].includes((await f.installations.cancel(plan.id)).state));release();assert.ok(['canceling','canceled'].includes((await confirmation).state));for(let i=0;i<3&&f.installations.status(plan.id)?.state==='canceling';i++)await f.installations.tick();assert.equal(f.installations.status(plan.id).state,'canceled');
 assert.equal(f.branches.getBranch(branchId),undefined);assert.equal(f.store.getAgent(importedId),undefined);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_id=?').get(branchId).n,0);
});

test('expired package previews cannot be confirmed',async t=>{
 const f=await fixture(t),plan=f.installations.preview(pkg(),f.bindings);f.store.sqlite.prepare("UPDATE branch_installation_plans SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(plan.id);await f.installations.tick();
 assert.equal(f.installations.status(plan.id).state,'expired');await assert.rejects(()=>f.installations.confirm(plan.id),/no longer available/);
});

test('eligible failures back off without starving the eleventh installation',async t=>{
 const f=await fixture(t);f.installations.setPublisher((input,configuration)=>{if(input.definition.name.startsWith('Broken'))throw new Error('permanent rejection');return f.branches.deploy(input,new Date().toISOString(),undefined,configuration)});
 const failures=[];for(let i=0;i<10;i++){const p=pkg();p.packageId=`broken-${i}`;p.definition={...p.definition,name:`Broken ${i}`};const plan=f.installations.preview(p,f.bindings);failures.push(plan.id);assert.equal((await f.installations.confirm(plan.id)).state,'applying');}
 f.store.sqlite.prepare("UPDATE branch_installation_plans SET next_attempt_at=NULL WHERE state='applying'").run();
 const good=pkg();good.packageId='eleventh';good.definition={...good.definition,name:'Healthy eleventh'};const plan=f.installations.preview(good,f.bindings);await f.installations.confirm(plan.id);for(let i=0;i<11&&f.installations.status(plan.id).state==='applying';i++)await f.installations.tick();const result=f.installations.status(plan.id);
 assert.equal(result.state,'completed',result.error);for(const id of failures){const row=f.store.sqlite.prepare('SELECT attempt_count,next_attempt_at FROM branch_installation_plans WHERE id=?').get(id);assert.ok(row.attempt_count>=2);assert.ok(row.next_attempt_at);}
});

test('installation plan payload retention is bounded and expired previews keep a lightweight receipt',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId;
 const completed=f.store.sqlite.prepare('SELECT id,package_json,bindings_json,preview_json FROM branch_installation_plans WHERE branch_id=? AND state=\'completed\'').get(branchId);assert.deepEqual({package_json:completed.package_json,bindings_json:completed.bindings_json,preview_json:completed.preview_json},{package_json:'{}',bindings_json:'{}',preview_json:'[]'});
 f.store.sqlite.prepare("UPDATE branch_installation_plans SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(completed.id);await f.installations.tick();assert.equal(f.installations.status(completed.id),undefined);
 const plans=[];for(let i=0;i<8;i++)plans.push(f.installations.preview(p,f.bindings,branchId));assert.throws(()=>f.installations.preview(p,f.bindings,branchId),/Too many outstanding/);
 f.store.sqlite.prepare("UPDATE branch_installation_plans SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(plans[0].id);
 assert.ok(f.installations.preview(p,f.bindings,branchId).id);const expired=f.store.sqlite.prepare('SELECT state,package_json,bindings_json,preview_json FROM branch_installation_plans WHERE id=?').get(plans[0].id);
 assert.deepEqual(expired,{state:'expired',package_json:'{}',bindings_json:'{}',preview_json:'[]'});
});

test('Chat retirement deletes all logical mappings and the same package identity can be applied again',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId;
 const removed={...p,chats:[],agentBindings:{}};assert.equal((await f.installations.confirm(f.installations.preview(removed,f.bindings,branchId).id)).state,'completed');await f.installations.tick();
 const states=f.store.sqlite.prepare('SELECT state FROM branch_installation_resources WHERE branch_id=? AND package_id=?').all(branchId,p.packageId);assert.ok(states.length>=2);assert.ok(states.every(row=>row.state==='deleted'));
 const reapplied=await f.installations.confirm(f.installations.preview(p,f.bindings,branchId).id);assert.equal(reapplied.state,'completed',reapplied.error);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE branch_id=? AND package_id=? AND state='active'").get(branchId,p.packageId).n,2);
});

test('canceling installation work cannot starve the twenty-sixth plan',async t=>{
 const f=await fixture(t),installed=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id),branchId=installed.branchId;
 const execution=f.branches.accept(branchId,'cancellation-fairness','');f.branches.advance();
 const insertPlan=f.store.sqlite.prepare("INSERT INTO branch_installation_plans(id,branch_id,package_json,bindings_json,preview_json,state,error,created_at,updated_at) VALUES(?,?, '{}','{}','[]','canceling','Stopping update and restoring prior resource state',?,?)");
 const insertResource=f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state,staging_plan_id) VALUES(?,?,?,'',?,'retiring',?)");
 for(let i=0;i<25;i++){
  const id='blocked-cancel-'+String(i).padStart(2,'0'),chatId='blocked-chat-'+i,at='2026-01-01T00:00:'+String(i).padStart(2,'0')+'.000Z';
  insertPlan.run(id,branchId,at,at);insertResource.run(branchId,'blocked-package-'+i,'blocked-ref-'+i,chatId,id);
  f.store.sqlite.prepare('INSERT INTO branch_resource_references VALUES(?,?)').run(execution.id,chatId);
 }
 insertPlan.run('ready-cancel-26',null,'2026-01-01T00:01:00.000Z','2026-01-01T00:01:00.000Z');
 await f.installations.tick();
 assert.equal(f.installations.status('ready-cancel-26').state,'canceled');
 assert.equal(f.installations.status('blocked-cancel-00').state,'canceling');
});

test('blocked Branch deletions rotate so later ready deletion can finish',async t=>{
 const f=await fixture(t),blocked=[],dependents=[];
 for(let i=0;i<5;i++){blocked.push(f.branches.create('Blocked deletion '+i,'blocked-'+i));dependents.push(f.branches.create('Dependent '+i,'dependent-'+i));}
 const ready=f.branches.create('Ready deletion','ready-deletion');
 for(let i=0;i<5;i++){
  f.store.sqlite.prepare('INSERT INTO branch_dependencies(branch_id,target_branch_id,ref) VALUES(?,?,?)').run(dependents[i].id,blocked[i].id,'dependency-'+i);
  f.store.sqlite.prepare("UPDATE branches SET deleting=1,enabled=0,updated_at=? WHERE id=?").run('2026-01-01T00:00:0'+i+'.000Z',blocked[i].id);
 }
 f.store.sqlite.prepare("UPDATE branches SET deleting=1,enabled=0,updated_at='2026-01-01T00:00:05.000Z' WHERE id=?").run(ready.id);
 await f.installations.tick();assert.ok(f.branches.getBranch(ready.id));
 await f.installations.tick();assert.equal(f.branches.getBranch(ready.id),undefined);
 for(const branch of blocked)assert.ok(f.branches.getBranch(branch.id));
});

test('a deleting Branch reconciles resource retirement after a restart boundary',async t=>{
 const f=await fixture(t),first=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id),branchId=first.branchId;
 const notification=f.workspace.createNotification({branchId,kind:'operational',severity:'attention',title:'Review work',body:'Needs attention',action:{kind:'open_branch',targetId:branchId}});
 f.branches.beginDeletion(branchId);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE branch_id=? AND state='active'").get(branchId).n,2);
 await f.installations.tick();assert.equal(f.branches.getBranch(branchId),undefined);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_id=?').get(branchId).n,0);
 assert.equal(f.workspace.getNotification(notification.id).status,'resolved');
 const receipts=f.store.sqlite.prepare('SELECT package_json,bindings_json,preview_json FROM branch_installation_plans WHERE branch_id=?').all(branchId);assert.ok(receipts.every(row=>row.package_json==='{}'&&row.bindings_json==='{}'&&row.preview_json==='[]'));
});


test('Branches notification inbox filters before pagination and counts and cannot acknowledge Dev notifications',async t=>{
 const f=await fixture(t),installed=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id);
 const branchId=installed.branchId,agent=f.store.getAgent(f.branches.localConfiguration(branchId).agents.lead);
 const own=f.workspace.createNotification({branchId,kind:'operational',severity:'info',title:'Notify me',body:'Workflow result'});
 const chat=f.workspace.createNotification({projectId:agent.projectId,conversationId:agent.conversationId,kind:'direct_response',title:'Agent result',body:'Branch Agent result'});
 const globalUpdate=f.workspace.createNotification({kind:'direct_response',communicationEventId:'dev-global-event',title:'Global Dev update',body:'Dev only'});
 const dev=f.workspace.createNotification({kind:'operational',severity:'info',title:'Dev system',body:'Dev only'});
 const page=(await f.app.inject('/api/branches/engine/notifications?limit=1')).json();
 assert.equal(page.items.length,1);assert.ok([own.id,chat.id].includes(page.items[0].id));assert.equal(page.items[0].branchId,branchId);
 assert.equal(page.unacknowledgedActionCount,1);assert.equal(page.unreadUpdateCount,1);assert.ok(page.nextCursor);
 const older=(await f.app.inject('/api/branches/engine/notifications?limit=1&cursor='+encodeURIComponent(page.nextCursor))).json();
 assert.equal(older.items.length,1);assert.notEqual(older.items[0].id,page.items[0].id);assert.equal(older.items[0].branchId,branchId);
 const devPage=(await f.app.inject('/api/notifications')).json();assert.deepEqual(new Set(devPage.items.map(n=>n.id)),new Set([dev.id,globalUpdate.id]));
 assert.equal((await f.app.inject({method:'POST',url:'/api/branches/engine/notifications/read-visible',payload:{communicationEventIds:['dev-global-event']}})).statusCode,200);
 assert.equal((await f.app.inject('/api/notifications')).json().unreadUpdateCount,1);
 assert.equal((await f.app.inject({method:'POST',url:'/api/branches/engine/notifications/acknowledge-batch',payload:{notificationIds:[dev.id]}})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url:'/api/notifications/acknowledge-batch',payload:{notificationIds:[own.id]}})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url:'/api/branches/engine/notifications/acknowledge-batch',payload:{notificationIds:[own.id]}})).statusCode,200);
 assert.equal((await f.app.inject({method:'POST',url:'/api/branches/engine/notifications/'+chat.id+'/read'})).statusCode,200);
 const seen=(await f.app.inject('/api/branches/engine/notifications')).json();assert.equal(seen.unacknowledgedActionCount,0);assert.equal(seen.unreadUpdateCount,0);
 assert.equal((await f.app.inject('/api/notifications')).json().unacknowledgedActionCount,1);
 assert.equal((await f.app.inject({method:'POST',url:'/api/branches/engine/notifications/dismiss-all',payload:{kind:'updates'}})).statusCode,200);
 assert.equal((await f.app.inject('/api/notifications')).json().unreadUpdateCount,1);
});

test('notification Branch links follow exact Chat identity and omit ambiguous multi-Chat destinations',async t=>{
 const f=await fixture(t),a=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id),b=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id);
 const first=f.store.getAgent(f.branches.localConfiguration(a.branchId).agents.lead),second=f.store.getAgent(f.branches.localConfiguration(b.branchId).agents.lead);
 // Model a shared legacy project without letting project row order choose the link.
 f.store.sqlite.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(first.projectId,second.conversationId);
 const exact=f.workspace.createNotification({projectId:first.projectId,conversationId:second.conversationId,kind:'direct_response',title:'Second Chat',body:'Second Branch'});
 const ambiguous=f.workspace.createNotification({projectId:first.projectId,conversationIds:[first.conversationId,second.conversationId],kind:'direct_response',title:'Both Chats',body:'No single destination'});
 const items=(await f.app.inject('/api/branches/engine/notifications')).json().items;
 assert.equal(items.find(n=>n.id===exact.id).branchId,b.branchId);
 assert.equal(items.find(n=>n.id===ambiguous.id).branchId,undefined);
});

test('slow package import cannot overwrite a concurrent authorized Agent edit',async t=>{
 const f=await fixture(t),p=pkg(),first=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=first.branchId,leadId=f.branches.localConfiguration(branchId).agents.lead;
 p.chats[0].agents.push({ref:'late',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Late',rootRef:'late',agents:[{ref:'late',title:'Late Agent',engine:'codex',managementPermissions:permissions}]}});
 let release,started;const gate=new Promise(resolve=>{release=resolve}),began=new Promise(resolve=>{started=resolve});
 f.installations.setEngine({validateAgent(){},async exportAgent(){throw new Error('unused')},async importAgent(projectId,chatId,_pkg,_mapping,_key,options){const id=crypto.randomUUID();options.branchHooks.plan([id],crypto.randomUUID());const a=f.store.createAgent(projectId,{title:'Late Agent',engine:'codex',conversationId:chatId},undefined,id);started();await gate;const result={rootAgentId:a.id,agentIds:[a.id]};options.branchHooks.commit(result);return result}});
 const plan=f.installations.preview(p,f.bindings,branchId),confirmation=f.installations.confirm(plan.id);await began;
 f.store.updateAgent(leadId,{title:'Operator rename'});release();const result=await confirmation;
 assert.equal(result.state,'review_required');assert.match(result.error,/review the package again/);assert.equal(f.store.getAgent(leadId).title,'Operator rename');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE branch_id=? AND state='staging'").get(branchId).n,0);
});

test('ordinary Branch context reads hide every inactive installation resource state',async t=>{
 const f=await fixture(t),installed=await f.installations.confirm(f.installations.preview(pkg(),f.bindings).id),branchId=installed.branchId,agentId=f.branches.localConfiguration(branchId).agents.lead,chatId=f.store.getAgent(agentId).conversationId;
 for(const state of ['staging','retiring','deleted']){
  f.store.sqlite.prepare("UPDATE branch_installation_resources SET state=? WHERE branch_id=? AND local_id=? AND agent_ref=''").run(state,branchId,chatId);
  assert.equal((await f.app.inject('/api/branches/contexts')).json().some(chat=>chat.id===chatId),false,state);
  assert.equal((await f.app.inject('/api/branches/contexts/'+chatId)).statusCode,404,state);
  assert.equal((await f.app.inject('/api/branches/'+branchId+'/chats')).json().some(chat=>chat.id===chatId),false,state);
 }
 f.store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE branch_id=? AND local_id=? AND agent_ref=''").run(branchId,chatId);
 assert.equal((await f.app.inject('/api/branches/contexts/'+chatId)).statusCode,200);
});

test('durable before-images compensate canonical mutations after service and store reopen',async t=>{
 const f=await fixture(t),p=pkg(),installed=await f.installations.confirm(f.installations.preview(p,f.bindings).id),branchId=installed.branchId,leadId=f.branches.localConfiguration(branchId).agents.lead,chatId=f.store.getAgent(leadId).conversationId;
 const beforeChat=f.store.getConversation(chatId),beforeAgent=f.store.getAgent(leadId);p.chats[0].title='Unsafe new title';p.chats[0].agents[0].definition.agents[0].title='Unsafe new Agent title';
 const originalUpdate=f.store.updateConversation.bind(f.store);let updates=0;f.store.updateConversation=(...args)=>{updates++;if(updates===2)throw new Error('simulated crash during compensation');return originalUpdate(...args)};
 f.installations.setPublisher(()=>{throw new Error('simulated publication crash')});const plan=f.installations.preview(p,f.bindings,branchId),failed=await f.installations.confirm(plan.id);
 assert.equal(failed.state,'applying');assert.match(failed.error,/compensation/);assert.notEqual(f.store.sqlite.prepare('SELECT journal_json FROM branch_installation_plans WHERE id=?').get(plan.id).journal_json,'{}');
 f.store.updateConversation=originalUpdate;await f.close();
 const reopenedStore=new AgentStore(f.dir),reopenedCoordination=new CoordinationV3Store(reopenedStore.sqlite),reopenedBranches=new BranchStore(reopenedStore.sqlite,reopenedCoordination),recovered=new BranchInstallationService(reopenedStore,reopenedBranches,async()=>{},async()=>{});
 t.after(()=>reopenedStore.close());const stopped=await recovered.cancel(plan.id);assert.equal(stopped.state,'canceled');
 assert.equal(reopenedStore.getConversation(chatId).title,beforeChat.title);assert.equal(reopenedStore.getAgent(leadId).title,beforeAgent.title);assert.equal(reopenedStore.sqlite.prepare('SELECT journal_json FROM branch_installation_plans WHERE id=?').get(plan.id).journal_json,'{}');
});

test('full Branch imports disclose bounded Agent context and require a distinct acknowledgement',async t=>{
 const f=await fixture(t),p=pkg();p.mode='full';const node=p.chats[0].agents[0].definition;node.mode='full';node.agents[0].initialInstructions='Review security boundaries carefully.';node.agents[0].history=[{role:'user',text:'Earlier request'},{role:'assistant',text:'Earlier finding'}];node.agents[0].artifacts=[{ref:'report-1',kind:'document',path:'security/report.txt',createdAt:new Date().toISOString(),mediaType:'text/plain',dataBase64:Buffer.from('finding').toString('base64')}];
 const reviewed=await f.app.inject({method:'POST',url:'/api/branches/install-preview',payload:{package:p,bindings:f.bindings}});assert.equal(reviewed.statusCode,200,reviewed.body);const preview=reviewed.json();
 assert.equal(preview.fullImportReview.mode,'full');assert.match(preview.fullImportReview.warning,/history|context/i);assert.match(preview.fullImportReview.warning,/files/i);assert.deepEqual(preview.fullImportReview.agents.map(a=>({agent:a.agent,instructions:a.initialInstructions.bytes,messages:a.history.messages,files:a.artifacts.count,fileName:a.artifacts.items[0].name,fileType:a.artifacts.items[0].mediaType})),[{agent:'Security lead',instructions:Buffer.byteLength('Review security boundaries carefully.'),messages:2,files:1,fileName:'security/report.txt',fileType:'text/plain'}]);
 const rejected=await f.app.inject({method:'POST',url:`/api/branches/installations/${preview.id}/confirm`,payload:{}});assert.equal(rejected.statusCode,409);assert.match(rejected.body,/acknowledgement/i);assert.equal(f.installations.status(preview.id).state,'preview');
 const accepted=await f.app.inject({method:'POST',url:`/api/branches/installations/${preview.id}/confirm`,payload:{acknowledgeFullImport:true}});assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().state,'completed',accepted.body);
});

test('Branch package preview uses the standalone mutation-free nested Agent parser',async t=>{
 const f=await fixture(t),branch=f.branches.create('Existing','existing'),project=f.store.createProject({label:'Existing Chat',hostPath:f.dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id});f.store.createAgent(project.id,{title:'Existing Agent',engine:'codex',conversationId:project.lastConversationId});
 const base=pkg();base.mode='full';base.chats[0].agents[0].definition.mode='full';const before={plans:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_installation_plans').get().n,resources:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_installation_resources').get().n};
 const cases=[
  {name:'nested field',mutate:p=>{p.chats[0].agents[0].definition.agents[0].unexpected=true},error:/unknown Agent package node field/i},
  {name:'history',mutate:p=>{p.chats[0].agents[0].definition.agents[0].history=[{role:'operator',text:'invalid nested role'}]},error:/history/i},
  {name:'artifact',mutate:p=>{p.chats[0].agents[0].definition.agents[0].artifacts=[{ref:'bad-artifact',kind:'document',path:'bad.txt',createdAt:new Date().toISOString(),dataBase64:'%%%'}]},error:/base64/i},
  {name:'limit',mutate:p=>{p.chats[0].agents[0].definition.agents[0].history=Array.from({length:10_001},()=>({role:'user',text:''}))},error:/message limit/i},
 ];
 for(const item of cases){const candidate=structuredClone(base);item.mutate(candidate);const response=await f.app.inject({method:'POST',url:'/api/branches/install-preview',payload:{package:candidate,bindings:f.bindings,branchId:branch.id}});assert.equal(response.statusCode,400,`${item.name}: ${response.body}`);assert.match(response.body,item.error);assert.deepEqual({plans:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_installation_plans').get().n,resources:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_installation_resources').get().n},before,item.name);}
});
