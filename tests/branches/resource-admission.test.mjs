import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {BranchResourceService} from '../../apps/server/dist/branch-resource-service.js';
import {withFixture,until} from '../shared/fixture.mjs';

function deployTemplate(branches,root,key,failure={action:'stop'}){
 const owner=branches.create('Temporary work',key),permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
 const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Worker',rootRef:'worker',agents:[{ref:'worker',title:'Temporary worker',engine:'codex',managementPermissions:permissions},{ref:'child',title:'Temporary child',managerRef:'worker',engine:'codex',managementPermissions:permissions}]};
 return branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:key+'-deploy',definition:{schema:'ponderosa.branch.v1',name:'Temporary work',trigger:{kind:'manual'},entry:'team',templates:{team:template},steps:[{id:'team',kind:'agent',target:{kind:'ephemeral_organization',templateRef:'team'},instructions:'Complete the canonical Request'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,maxEphemeralAgents:2,failure}},bindings:{agents:{},directories:{workspace:root},engines:{codex:'codex'}}});
}

test('historical retry context cleanup survives reopen without deleting the current generation or user folders',{timeout:15000},async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-historical-context-'));let store,branches,resources,fail=true,passed=false;const seen=[];
 const open=()=>{
  store=new AgentStore(root);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  resources=new BranchResourceService(branches,store,async()=>{throw Error('Historical catch-up must not delete Agents')},async()=>{throw Error('No provisioning allowed')},async id=>{
   seen.push(id);const receipt=store.markConversationDeletionPending(id);
   if(fail){fail=false;throw Error('Controlled interrupted Chat deletion')}
   store.commitConversationDeletion(id);store.finishConversationDeletionStorageCleanup(receipt);store.markConversationDeletionServerCleanupComplete(id);
  });
 };open();
 t.after(async()=>{await resources.stop();store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const branch=deployTemplate(branches,root,'historical-retry'),execution=branches.accept(branch.id,'input','Review');branches.advance();const provision=branches.resourceProvisions()[0];
 const create=(label,owner)=>{const project=store.createProject({label,hostPath:root,defaultEngine:'codex',chatOwned:true,...owner});return store.getConversation(project.lastConversationId)};
 const owner={branchId:branch.id,executionId:execution.id},old=create('Old generation',owner);branches.bindResourceChat(provision.stepExecutionId,old.id);
 // Reproduce the old release's persisted pointer reset, retaining its context.
 store.sqlite.prepare("UPDATE branch_resources SET chat_id=NULL,generation=generation+1,creation_key=creation_key||':retry' WHERE step_execution_id=?").run(provision.stepExecutionId);
 const current=create('Current generation',owner);branches.bindResourceChat(provision.stepExecutionId,current.id);const unrelated=create('Unrelated Chat');
 writeFileSync(path.join(root,'keep-source.txt'),'user source');
 await resources.tick(false);assert.deepEqual(seen,[old.id]);assert.ok(store.getConversation(old.id,{includeDeleting:true}));assert.ok(store.getConversation(current.id));assert.ok(store.getConversation(unrelated.id));
 assert.match(store.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(old.id).error,/interrupted/);
 await resources.stop();store.close();open();await resources.tick(false);
 assert.deepEqual(seen,[old.id,old.id]);assert.equal(store.getConversation(old.id),undefined);assert.equal(store.getConversationDeletionReceipt(old.id).serverCleanupCompleted,true);
 assert.equal(store.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(old.id),undefined);
 assert.ok(store.getConversation(current.id));assert.ok(store.getConversation(unrelated.id));assert.equal(readFileSync(path.join(root,'keep-source.txt'),'utf8'),'user source');
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM branch_ephemeral_contexts WHERE step_execution_id=?').get(provision.stepExecutionId).n,2);passed=true;
});

for(const interruption of ['shutdown','cancellation','cleanup_failure','retired_cleanup'])test(`${interruption} during temporary Chat creation cannot start a new Agent import`,{timeout:15000},async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-resource-current-')),store=new AgentStore(root),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 let release,entered,imports=0,deletions=0,passed=false;
 const ready=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
 const createChat=async(input,key,owner)=>{
  entered();await gate;
  const project=store.createProject({...input,...owner,chatOwned:true,hostPath:root},{idempotencyKey:key,payloadHash:'reviewed resource'});
  return store.getConversation(project.lastConversationId);
 };
 const resources=new BranchResourceService(branches,store,async ids=>{assert.deepEqual(ids,[])},createChat,async id=>{
  if(++deletions===1&&['cleanup_failure','retired_cleanup'].includes(interruption))throw Error('Controlled Chat cleanup failure');
  const receipt=store.commitConversationDeletion(id);store.finishConversationDeletionStorageCleanup(receipt);store.markConversationDeletionServerCleanupComplete(id);
 });
 resources.setImporter(async()=>{imports++;throw Error('Unexpected Agent import after interruption')});
 t.after(async()=>{release();let clean=false;try{await resources.stop();clean=true}finally{store.close();if(passed&&clean)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)}});
 const owner=branches.create('Temporary work','owner'),permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
 const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Worker',rootRef:'worker',agents:[{ref:'worker',title:'Worker',engine:'codex',managementPermissions:permissions}]};
 const branch=branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Temporary work',trigger:{kind:'manual'},entry:'team',templates:{team:template},steps:[{id:'team',kind:'agent',target:{kind:'ephemeral_organization',templateRef:'team'},instructions:'Review the input'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,maxEphemeralAgents:2,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:root},engines:{codex:'codex'}}});
 const execution=branches.accept(branch.id,'input','Review');branches.advance();
 const pending=resources.tick(true);
 try{
  await ready;
  if(interruption==='shutdown')resources.requestStop();else branches.cancel(execution.id);
 }finally{release();await pending}
 assert.equal(imports,0);
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM agents').get().n,0);
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,0);
 let resource=store.sqlite.prepare('SELECT * FROM branch_resources').get();assert.ok(resource.chat_id);
 if(['cleanup_failure','retired_cleanup'].includes(interruption)){
  const id=resource.chat_id;assert.equal(resource.state,'reserved');assert.match(resource.error,/cleanup failure/);assert.ok(store.getConversation(id));
  // Model the previously released implementation, which retired the resource
  // after deleting Agents but omitted its Chat. Maintenance must catch it up.
  if(interruption==='retired_cleanup')branches.resourceRetired(resource.step_execution_id);
  await resources.tick(false);resource=store.sqlite.prepare('SELECT * FROM branch_resources').get();assert.equal(resource.chat_id,id);
 }
 const chat=store.getConversation(resource.chat_id);
 if(interruption==='shutdown'){assert.equal(chat.branchId,branch.id);assert.equal(chat.executionId,execution.id)}
 else{assert.equal(chat,undefined);assert.equal(store.getConversationDeletionReceipt(resource.chat_id).storageCleanupCompleted,true)}
 assert.equal(resource.state,interruption==='shutdown'?'reserved':'retired');
 if(interruption!=='shutdown')assert.equal(branches.execution(execution.id).state,'canceled');
 passed=true;
});

for(const interruption of ['shutdown','deadline'])test(`${interruption} aborts a pending template import without releasing its tracked work early`,{timeout:15000},async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-import-cancel-')),store=new AgentStore(root),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 let entered,signal,passed=false;const ready=new Promise(resolve=>{entered=resolve});
 const resources=new BranchResourceService(branches,store,async()=>{},async(input,key,owner)=>{
  const project=store.createProject({...input,...owner,chatOwned:true,hostPath:root},{idempotencyKey:key,payloadHash:'cancel fixture'});return store.getConversation(project.lastConversationId);
 },async()=>{});
 resources.setImporter(async(_input,_hooks,abortSignal)=>{signal=abortSignal;entered();await new Promise((_,reject)=>{abortSignal.addEventListener('abort',()=>reject(abortSignal.reason),{once:true})})});
 t.after(async()=>{await resources.stop();store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const branch=deployTemplate(branches,root,'cancel-import');branches.accept(branch.id,'input','Review');branches.advance();
 if(interruption==='deadline')t.mock.timers.enable({apis:['setTimeout']});
 const pending=resources.tick(true);await ready;assert.equal(resources.activeOperationCount(),1);
 if(interruption==='shutdown')resources.requestStop();else t.mock.timers.tick(5*60*1000);
 assert.equal(signal.aborted,true);await pending;assert.equal(resources.activeOperationCount(),0);
 const row=store.sqlite.prepare('SELECT * FROM branch_resources').get();assert.equal(row.state,'reserved');assert.ok(store.getConversation(row.chat_id));assert.match(row.error,interruption==='shutdown'?/shutdown/:/deadline/);passed=true;
});

test('fresh-context retry deletes the previous generation Chat before resetting and completing its replacement',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const original=store.updateAgentCreationOperation.bind(store);let injected=false;
  store.updateAgentCreationOperation=(id,patch)=>{
   const operation=original(id,patch);
   if(!injected&&patch.status==='completed'&&operation.kind==='import'){
    injected=true;f.plans.set(operation.agentIds[0],[{run:async session=>{const result=await session.tool('ponderosa_update_request',{kind:'failed',text:'Controlled first-generation failure'});assert.equal(result.success,true,result.text)}}]);
   }
   return operation;
  };
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)),branch=deployTemplate(branches,f.root,'fresh-retry',{action:'retry',maxAttempts:2,delayMs:0,freshContext:true}),execution=branches.accept(branch.id,'input','Retry safely');
  const resource=await until(()=>{const row=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(execution.id);return row?.state==='retired'&&row.generation===1&&row},'replacement resource retirement');
  assert.equal(injected,true);assert.equal(branches.execution(execution.id).state,'completed');
  const contexts=store.sqlite.prepare('SELECT * FROM branch_ephemeral_contexts WHERE step_execution_id=? ORDER BY generation').all(resource.step_execution_id);assert.equal(contexts.length,2);assert.notEqual(contexts[0].chat_id,contexts[1].chat_id);
  for(const context of contexts){assert.equal(store.getConversation(context.chat_id),undefined);const receipt=store.getConversationDeletionReceipt(context.chat_id);assert.equal(receipt.storageCleanupCompleted,true);assert.equal(receipt.serverCleanupCompleted,true)}
 },{storeFactory:root=>(store=new AgentStore(root))});
});

test('completed template workflows retire their exact Chats through tracked deletion and preserve working files across reopen',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const branch=deployTemplate(branches,f.root,'cleanup-owner');
  const normal=await f.createChat('Unrelated Chat'),sentinel=path.join(f.root,'keep-working-file.txt');writeFileSync(sentinel,'user source');
  const chats=[];
  for(let index=0;index<2;index++){
   const execution=branches.accept(branch.id,'cleanup-'+index,'Review');
   const resource=await until(()=>{const row=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(execution.id);return row?.state==='retired'&&row},'temporary resource retirement');
   assert.equal(branches.execution(execution.id).state,'completed');assert.ok(resource.chat_id);chats.push(resource.chat_id);
   assert.equal(store.getConversation(resource.chat_id),undefined);
   const receipt=store.getConversationDeletionReceipt(resource.chat_id);assert.equal(receipt.canonicalDeletionCompleted,true);assert.equal(receipt.storageCleanupCompleted,true);assert.equal(receipt.serverCleanupCompleted,true);
   assert.equal(store.sqlite.prepare('SELECT count(*) n FROM agents WHERE deleted_at IS NULL AND conversation_id=?').get(resource.chat_id).n,0);
  }
  assert.notEqual(chats[0],chats[1]);assert.ok(store.getConversation(normal.id));assert.equal(readFileSync(sentinel,'utf8'),'user source');
  await f.reopen();for(const id of chats)assert.equal(store.getConversation(id),undefined);
  assert.ok(store.getConversation(normal.id));assert.equal(readFileSync(sentinel,'utf8'),'user source');
 },{storeFactory:root=>(store=new AgentStore(root))});
});
