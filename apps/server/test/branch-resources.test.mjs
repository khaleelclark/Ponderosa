import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
import {AssetStore} from '../dist/assets.js';
import {BranchResourceService} from '../dist/branch-resource-service.js';
import {AgentWorkingCopyService} from '../dist/agent-working-copy-service.js';
import {registerAgentPackageRoutes} from '../dist/routes/agent-packages.js';
const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:'2026-09-17T00:00:00.000Z',sourceLabel:'Review team',rootRef:'lead',agents:[{ref:'lead',title:'Lead',engine:'codex',initialInstructions:'Lead the work',managementPermissions:permissions},{ref:'worker',title:'Worker',engine:'codex',managerRef:'lead',managementPermissions:permissions}]};
async function fixture(t,policy={maxConcurrentExecutions:2,maxEphemeralAgents:3,failure:{action:'stop'}},managedFolder=false,workspacePath){
 const dir=mkdtempSync(join(tmpdir(),'branch-resources-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),assets=new AssetStore(dir),app=Fastify();
 const project=store.createProject({label:'Resources',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Work'});let rejectDrain=false,drainHook;
 const deletionErrors=[],deleteAgent=store.deleteAgent.bind(store);store.deleteAgent=(...args)=>{try{return deleteAgent(...args)}catch(error){deletionErrors.push(error.message);throw error}};
 const resources=new BranchResourceService(branches,store,async ids=>{if(drainHook)await drainHook(ids);if(rejectDrain)throw new Error('unobserved process exit')});
 registerAgentPackageRoutes(app,{dataDir:dir,store,coordination,assets,branchResources:resources,engines:new Map([['codex',{adapter:{id:'codex',listModels:()=>[],listEfforts:()=>[]}}]]),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:()=>[],createOperationalNotification(){}});
 t.after(async()=>{await resources.stop();await app.close();assets.close();store.close();rmSync(dir,{recursive:true,force:true})});
 const definition={schema:'ponderosa.branch.v1',name:'Ephemeral review',trigger:{kind:'manual'},entry:'team',templates:{team:template},steps:[{id:'team',kind:'agent',target:{kind:'ephemeral_organization',templateRef:'team'},instructions:'Review this input and return the result'}],controls:[],edges:[],policy};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:managedFolder?{}:{workspace:workspacePath??dir},engines:{codex:'codex'}}}),execution=branches.accept(branch.id,'one','Input');
 return {store,coordination,branches,resources,get project(){const id=store.sqlite.prepare('SELECT chat_id FROM branch_resources LIMIT 1').get()?.chat_id;return id?store.getProject(store.getConversation(id).projectId):project},get chat(){const id=store.sqlite.prepare('SELECT chat_id FROM branch_resources LIMIT 1').get()?.chat_id;return id?store.getConversation(id):chat},branch,execution,deletionErrors,setRejectDrain(value){rejectDrain=value},setDrainHook(value){drainHook=value}};
}
async function provision(f){f.branches.advance();await f.resources.tick(true);const detail=f.branches.detail(f.execution.id);assert.ok(detail.attempts[0].requestId,JSON.stringify(f.store.sqlite.prepare('SELECT * FROM branch_resources').all()));return detail.attempts[0]}
function finishRequest(f,attempt,failed=false){const request=f.coordination.getRequest(attempt.requestId);f.coordination.updateRequest({requestId:attempt.requestId,updateId:'result:'+attempt.id,kind:failed?'failed':'completed',actor:{kind:'agent',id:request.recipientAgentId},payload:{text:failed?'retry':'Result'}});f.branches.advance()}

function completeRun(f,lease){
 f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 const injection={injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken};
 f.coordination.preparePromptInjection({...injection,prompt:'Review input'});f.coordination.markPromptSubmitted(injection);f.coordination.acknowledgePromptInjection(injection);
 f.coordination.completeRun(lease.runId,lease.fencingToken);
}

test('tracked template import atomically binds one root Request and retains the organization after archival',async t=>{
 const f=await fixture(t),attempt=await provision(f),row=f.store.sqlite.prepare('SELECT * FROM branch_resources').get();
 const members=f.store.sqlite.prepare('SELECT agent_id FROM branch_resource_members').all();assert.equal(members.length,2);
 const operation=f.store.findAgentCreationOperation({projectId:f.project.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:row.creation_key});assert.equal(operation.status,'completed');
 assert.equal(operation.result.rootAgentId,row.root_agent_id);assert.equal(f.store.getAgent(members.find(m=>m.agent_id!==row.root_agent_id).agent_id).managerAgentId,row.root_agent_id);
 await f.resources.tick(true);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resource_members').get().n,2);
 const lease=f.coordination.leaseNextRun({workerId:'test'});assert.ok(lease);finishRequest(f,attempt);
 await f.resources.tick(false);assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 completeRun(f,lease);await f.resources.tick(false);
 assert.equal(f.branches.execution(f.execution.id).state,'completed',JSON.stringify(f.store.sqlite.prepare('SELECT * FROM branch_resources').all()));for(const m of members)assert.equal(f.store.getAgent(m.agent_id).archived,true);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_creation_operations').get().n,1);
});

test('known failure retry reuses the same recorded organization identities',async t=>{
 const f=await fixture(t,{maxConcurrentExecutions:2,maxEphemeralAgents:2,failure:{action:'retry',maxAttempts:2,delayMs:0}}),first=await provision(f);
 const root=f.store.sqlite.prepare('SELECT root_agent_id id FROM branch_resources').get().id;finishRequest(f,first,true);f.branches.advance();
 const second=f.branches.detail(f.execution.id).attempts[1];assert.ok(second.requestId);assert.equal(f.coordination.getRequest(second.requestId).recipientAgentId,root);
 await f.resources.tick(true);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resource_members').get().n,2);
});

test('resource budget fails before import and descendant creation cannot exceed the execution budget',async t=>{
 const small=await fixture(t,{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}});small.branches.advance();await small.resources.tick(true);
 assert.equal(small.branches.execution(small.execution.id).state,'failed');assert.equal(small.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_creation_operations').get().n,0);
 const f=await fixture(t);await provision(f);const root=f.store.sqlite.prepare('SELECT root_agent_id id FROM branch_resources').get().id;
 const child=f.store.createAgent(f.project.id,{title:'Child',engine:'codex',conversationId:f.chat.id,managerAgentId:root});
 assert.ok(f.store.sqlite.prepare('SELECT 1 FROM branch_resource_members WHERE agent_id=?').get(child.id));
 assert.throws(()=>f.store.createAgent(f.project.id,{title:'Too many',engine:'codex',conversationId:f.chat.id,managerAgentId:root}),/budget/);
});

test('failed cleanup prevents terminal execution until observed cleanup succeeds',async t=>{
 const f=await fixture(t),attempt=await provision(f),lease=f.coordination.leaseNextRun({workerId:'test'});finishRequest(f,attempt);completeRun(f,lease);
 f.setRejectDrain(true);await f.resources.tick(false);assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_resources').get().state,'active');
 f.setRejectDrain(false);await f.resources.tick(false);assert.equal(f.branches.execution(f.execution.id).state,'completed',JSON.stringify(f.store.sqlite.prepare('SELECT * FROM branch_resources').all()));
});

test('cancel before provisioning creates no Agents and drains the reservation',async t=>{
 const f=await fixture(t);f.branches.advance();f.branches.cancel(f.execution.id);await f.resources.tick(true);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_creation_operations').get().n,0);assert.equal(f.branches.execution(f.execution.id).state,'canceled');
});


test('failed resource commit rolls back its opening Request and tracked creation can retry',async t=>{
 const f=await fixture(t,{maxConcurrentExecutions:1,maxEphemeralAgents:2,failure:{action:'retry',maxAttempts:2,delayMs:0}});
 f.store.sqlite.exec("CREATE TRIGGER reject_resource_binding BEFORE UPDATE OF state ON branch_resources WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT,'injected binding failure'); END");
 f.branches.advance();await f.resources.tick(true);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n,0,JSON.stringify({deletionErrors:f.deletionErrors,agents:f.store.sqlite.prepare('SELECT id,manager_agent_id,archived,deleted_at FROM agents').all(),operation:f.store.sqlite.prepare('SELECT status,last_error FROM agent_creation_operations').all(),resource:f.store.sqlite.prepare('SELECT * FROM branch_resources').all()}));
 assert.equal(f.store.sqlite.prepare('SELECT status FROM agent_creation_operations').get().status,'rolled_back');
 f.store.sqlite.exec('DROP TRIGGER reject_resource_binding');f.branches.advance();await f.resources.tick(true);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n,2);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,1);
});

test('cancellation during tracked import fences the opening and rolls back created Agents',async t=>{
 const f=await fixture(t),record=f.store.recordProjectArtifacts.bind(f.store);
 f.store.recordProjectArtifacts=(...args)=>{const result=record(...args);f.branches.cancel(f.execution.id);return result};
 f.branches.advance();await f.resources.tick(true);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n,0,JSON.stringify({deletionErrors:f.deletionErrors,agents:f.store.sqlite.prepare('SELECT id,manager_agent_id,archived,deleted_at FROM agents').all(),operation:f.store.sqlite.prepare('SELECT status,last_error FROM agent_creation_operations').all(),resource:f.store.sqlite.prepare('SELECT * FROM branch_resources').all()}));
 assert.equal(f.branches.execution(f.execution.id).state,'canceled');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_deletion_tombstones').get().n,2,'historical deletion receipts remain for custody replay');
});

for(const running of [false,true])test(`cancel drains owned delegated ${running?'running':'pending'} work without touching borrowed Agents`,async t=>{
 const f=await fixture(t),attempt=await provision(f),root=f.coordination.getRequest(attempt.requestId).recipientAgentId;
 const rootLease=f.coordination.leaseNextRun({workerId:'root'});completeRun(f,rootLease);
 const worker=f.store.sqlite.prepare('SELECT agent_id id FROM branch_resource_members WHERE agent_id!=?').get(root).id;
 const borrowed=f.store.createAgent(f.project.id,{title:'Unrelated',engine:'codex',conversationId:f.chat.id});
 f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,actorScope:'user:local-operator',idempotencyKey:'delegated',requests:[{requestId:'delegated',recipientAgentId:worker,lifetime:{kind:'indefinite'},payload:{text:'Work'}},{requestId:'unrelated',recipientAgentId:borrowed.id,lifetime:{kind:'indefinite'},payload:{text:'Other work'}}]});
 const lease=running?f.coordination.leaseNextRun({workerId:'worker'}):undefined;
 if(lease){assert.equal(lease.agentId,worker);f.coordination.markRunStarted(lease.runId,lease.fencingToken)}
 f.branches.cancel(f.execution.id);
 // No additional owned Agent may be leased while cancellation drains.
 const next=f.coordination.leaseNextRun({workerId:'after-cancel'});if(next)assert.equal(next.agentId,borrowed.id);
 await f.resources.tick(false);await f.resources.tick(false);
 assert.equal(f.coordination.getRequest('delegated').state,running?'outcome_unknown':'cancelled');
 assert.notEqual(f.coordination.getRequest('unrelated').state,'cancelled');assert.equal(f.store.getAgent(borrowed.id).archived,false);
 if(lease)assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(lease.runId).status,'cancelled');
 assert.equal(f.branches.execution(f.execution.id).state,'canceled',JSON.stringify({resources:f.store.sqlite.prepare('SELECT * FROM branch_resources').all(),activations:f.store.sqlite.prepare('SELECT agent_id,state FROM agent_activations').all(),requests:f.store.sqlite.prepare('SELECT recipient_agent_id,state FROM coordination_requests').all()}));
});

test('retry during asynchronous drain keeps the organization available for its accepted retry',async t=>{
 const f=await fixture(t),attempt=await provision(f),lease=f.coordination.leaseNextRun({workerId:'first'});finishRequest(f,attempt,true);completeRun(f,lease);
 let release,entered;const started=new Promise(resolve=>{entered=resolve});f.setDrainHook(()=>{entered();return new Promise(resolve=>{release=resolve})});
 const cleanup=f.resources.tick(false);await started;
 f.branches.intervene(f.execution.id,{commandKey:'retry',expectedRevision:f.branches.execution(f.execution.id).revision,action:'retry',attemptId:attempt.id,reason:'Corrected input'});
 release();await cleanup;
 assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_resources').get().state,'active');
 const root=f.coordination.getRequest(attempt.requestId).recipientAgentId;assert.equal(f.store.getAgent(root).archived,false);
 f.branches.advance();assert.equal(f.branches.detail(f.execution.id).attempts.length,2);assert.ok(f.branches.detail(f.execution.id).attempts[1].requestId);
});

test('more than twenty blocked cleanups cannot starve later ready resources',async t=>{
 const f=await fixture(t,{maxConcurrentExecutions:30,maxEphemeralAgents:2,failure:{action:'stop'}});
 for(let i=0;i<21;i++){
  if(i)f.execution=f.branches.accept(f.branch.id,'batch:'+i,'Input');
  const attempt=await provision(f),lease=f.coordination.leaseNextRun({workerId:'batch:'+i});finishRequest(f,attempt);completeRun(f,lease);
  // Keep the first resources blocked until the entire batch is ready.
  f.setRejectDrain(true);
 }
 const final=f.execution.id;f.setRejectDrain(false);f.setDrainHook(ids=>{const owner=f.store.sqlite.prepare('SELECT r.execution_id id FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id WHERE m.agent_id=?').get(ids[0]);if(owner.id!==final)throw new Error('Blocked earlier process')});
 await f.resources.tick(false);await f.resources.tick(false);await f.resources.tick(false);
 assert.equal(f.branches.execution(final).state,'completed');assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_resources WHERE state='active'").get().n,20);
});


test('projection rebuild preserves full-budget active and archived resource ownership without new admission',async t=>{
 const f=await fixture(t,{maxConcurrentExecutions:1,maxEphemeralAgents:2,failure:{action:'stop'}}),attempt=await provision(f);
 const ids=f.store.sqlite.prepare('SELECT agent_id id FROM branch_resource_members').all().map(r=>r.id);
 f.store.rebuildProjections();assert.ok(f.store.getProject(f.project.id));assert.ok(f.store.getConversation(f.chat.id));for(const id of ids)assert.ok(f.store.getAgent(id));
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resource_members').get().n,2);
 const lease=f.coordination.leaseNextRun({workerId:'replay'});finishRequest(f,attempt);completeRun(f,lease);await f.resources.tick(false);assert.equal(f.branches.execution(f.execution.id).state,'completed');
 f.store.rebuildProjections();assert.ok(f.store.getProject(f.project.id));for(const id of ids)assert.equal(f.store.getAgent(id).archived,true);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resource_members').get().n,2);
});

test('fresh retry drains the previous organization and records a new temporary Chat',async t=>{
 const f=await fixture(t,{maxConcurrentExecutions:1,maxEphemeralAgents:2,failure:{action:'retry',maxAttempts:2,delayMs:0,freshContext:true}}),first=await provision(f);
 const original=f.store.sqlite.prepare('SELECT chat_id,root_agent_id FROM branch_resources').get(),lease=f.coordination.leaseNextRun({workerId:'first'});finishRequest(f,first,true);completeRun(f,lease);
 for(let i=0;i<4;i++){await f.resources.tick(true);f.branches.advance();}
 const next=f.store.sqlite.prepare('SELECT chat_id,root_agent_id,generation FROM branch_resources').get();
 assert.notEqual(next.chat_id,original.chat_id);assert.notEqual(next.root_agent_id,original.root_agent_id);assert.equal(next.generation,1);assert.equal(f.store.getAgent(original.root_agent_id).archived,true);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_ephemeral_contexts').get().n,2);
 const second=f.branches.detail(f.execution.id).attempts[1];assert.equal(f.coordination.getRequest(second.requestId).recipientAgentId,next.root_agent_id);
});

test('startup projection replay during fresh-retry drain retains existing members and fences new descendants',async t=>{
 const f=await fixture(t,{maxConcurrentExecutions:1,maxEphemeralAgents:3,failure:{action:'retry',maxAttempts:2,delayMs:0,freshContext:true}}),first=await provision(f);
 const original=f.store.sqlite.prepare('SELECT root_agent_id,chat_id FROM branch_resources').get(),lease=f.coordination.leaseNextRun({workerId:'first'});finishRequest(f,first,true);completeRun(f,lease);
 assert.equal(f.store.sqlite.prepare('SELECT retry_draining FROM branch_resources').get().retry_draining,1);
 assert.doesNotThrow(()=>f.store.rebuildProjections());assert.ok(f.store.getAgent(original.root_agent_id));
 assert.throws(()=>f.store.createAgent(f.project.id,{title:'Late child',engine:'codex',conversationId:original.chat_id,managerAgentId:original.root_agent_id}),/draining/);
 for(let i=0;i<4;i++){await f.resources.tick(true);f.branches.advance();}
 assert.notEqual(f.store.sqlite.prepare('SELECT chat_id FROM branch_resources').get().chat_id,original.chat_id);
});


test('temporary organizations without a folder receive isolated durable internal folders and reuse them on retry',async t=>{
 const f=await fixture(t,{maxConcurrentExecutions:2,maxEphemeralAgents:3,failure:{action:'retry',maxAttempts:2,delayMs:0}},true);
 const first=await provision(f),folder=f.project.hostPath,chatId=f.chat.id;
 assert.ok(existsSync(folder));assert.match(folder,/projects[/\\][^/\\]+[/\\]workspace$/);
 assert.equal(f.store.getChatContext(chatId).hostPath,folder);
 finishRequest(f,first,true);await f.resources.tick(true);
 assert.equal(f.project.hostPath,folder);assert.equal(f.chat.id,chatId);
 const second=f.branches.accept(f.branch.id,'second','Other input');f.branches.advance();await f.resources.tick(true);
 const row=f.store.sqlite.prepare('SELECT chat_id FROM branch_resources WHERE execution_id=?').get(second.id);
 const other=f.store.getChatContext(row.chat_id).hostPath;assert.notEqual(other,folder);assert.ok(existsSync(other));
});

test('explicit relative workspace binding becomes a canonical Agent folder before import',async t=>{
 const f=await fixture(t,undefined,false,'.');await provision(f);
 const expected=realpathSync(process.cwd());
 assert.equal(f.project.hostPath,expected);
 assert.equal(f.store.getChatContext(f.chat.id).hostPath,expected);
 const agent=f.store.getAgent(f.store.sqlite.prepare('SELECT root_agent_id id FROM branch_resources').get().id);
 assert.equal(agent.workingCopy.rootPath,expected);
 const workingCopies=new AgentWorkingCopyService(expected,f.store);
 const admitted=await workingCopies.resolve(agent,f.project);
 assert.doesNotThrow(()=>workingCopies.assertRunAdmission(agent.id,admitted));
});

test('temporary organizations preserve an explicit working folder',async t=>{
 const f=await fixture(t),expected=realpathSync(f.project.hostPath);await provision(f);assert.equal(f.project.hostPath,expected);assert.equal(f.store.getChatContext(f.chat.id).hostPath,expected);
});

test('invalid temporary Agent folder fails durably instead of retrying provisioning forever',async t=>{
 const f=await fixture(t,undefined,false,join(tmpdir(),'missing-branch-workspace-for-test'));
 f.branches.advance();await f.resources.tick(true);
 assert.equal(f.branches.execution(f.execution.id).state,'failed');
 assert.match(f.branches.detail(f.execution.id).attempts[0].result.output,/working directory is unavailable/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resource_members').get().n,0);
});

test('interrupted temporary Chat binding reuses the committed internal folder',async t=>{
 const f=await fixture(t,undefined,true),bind=f.branches.bindResourceChat.bind(f.branches);let chatId;
 f.branches.bindResourceChat=(step,id)=>{chatId=id;throw new Error('interrupted after Chat creation')};
 f.branches.advance();await f.resources.tick(true);
 const folder=f.store.getChatContext(chatId).hostPath;assert.ok(existsSync(folder));
 f.branches.bindResourceChat=bind;await f.resources.tick(true);
 assert.equal(f.chat.id,chatId);assert.equal(f.project.hostPath,folder);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_execution_id=?').get(f.execution.id).n,1);
 assert.ok(f.branches.detail(f.execution.id).attempts[0].requestId);
});


test('internal folders reject nonexistent or mismatched Branch execution ownership',async t=>{
 const f=await fixture(t),before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM projects').get().n;
 const other=f.branches.create('Other Branch','other');
 for(const owner of [{},{chatOwned:true,branchId:f.branch.id,executionId:'missing'},{chatOwned:true,branchId:other.id,executionId:f.execution.id}]){
  assert.throws(()=>f.store.createProject({label:'Invalid owner',defaultEngine:'codex',...owner}),/existing execution of the owning Branch/);
 }
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM projects').get().n,before);
});
