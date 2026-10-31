import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,CapabilityPolicyStore} from '../../packages/agents/dist/index.js';
import {BranchResourceService} from '../../apps/server/dist/branch-resource-service.js';
import {BranchScriptService} from '../../apps/server/dist/branch-script-service.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const edge=(id,from,to,on='success')=>({id,from,to,on});
async function fixture(t,mode='async'){
 const dir=mkdtempSync(join(tmpdir(),'resource-checkpoint-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination),services=[];
 t.after(async()=>{for(const s of services)await s.stop();await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Resource safety',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Owner'});
 const base={schema:'ponderosa.branch.v1',trigger:{kind:'manual'},controls:[],edges:[],policy:{maxConcurrentExecutions:8,maxEphemeralAgents:4,failure:{action:'stop'}}};
 const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
 const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Worker',rootRef:'worker',agents:[{ref:'worker',title:'Worker',engine:'codex',managementPermissions:permissions}]};
 const child=branches.deploy({chatId:chat.id,idempotencyKey:'child',definition:{...base,name:'Child',entry:'team',templates:{team:template},steps:[{id:'team',kind:'agent',target:{kind:'ephemeral_organization',templateRef:'team'},instructions:'Inert opening'}]},bindings:{agents:{},directories:{workspace:dir},engines:{codex:'codex'}}});
 const delays=Array.from({length:8},(_,i)=>`delay${i}`);
 const parent=branches.deploy({chatId:chat.id,idempotencyKey:'parent',definition:{...base,name:'Parent',entry:'fork',steps:[{id:'call',kind:'branch_call',branchRef:'child'},{id:'gate',kind:'human_gate',prompt:'Approve?',editable:false}],controls:[{id:'fork',kind:'fork',joinId:'join'},...delays.map(id=>({id,kind:'condition',predicate:{source:'input',equals:'input'},otherwise:'gate'})),{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['call-arm','gate-arm']}],edges:[edge('call-arm','fork','call','selected'),edge('gate-arm','fork',delays[0],'selected'),...delays.flatMap((id,i)=>[edge(`${id}-yes`,id,delays[i+1]??'gate','selected'),edge(`${id}-no`,id,'gate','failure')]),edge('call-end','call','join'),edge('gate-end','gate','join','approved')]},bindings:{agents:{},directories:{},branches:{child:child.id}}});
 for(const branch of [child,parent])branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode},0);
 const pe=branches.accept(parent.id,'parent','input');let resource;
 const gateAvailability=value=>branches.unitTransaction(()=>{store.sqlite.prepare("UPDATE branch_attempts SET available_at=? WHERE step_execution_id IN (SELECT id FROM branch_step_executions WHERE execution_id=? AND step_id='gate')").run(value,pe.id);branches.selectedWrite(pe.id);})();
 for(let n=0;n<50;n++){
  await branches.unitSaver.drain();branches.unitTransaction(()=>branches.advance())();
  if(store.sqlite.prepare("SELECT 1 FROM branch_step_executions WHERE execution_id=? AND step_id='gate'").get(pe.id))gateAvailability('2099-01-01T00:00:00.000Z');
  resource=store.sqlite.prepare('SELECT * FROM branch_resources').get();
  if(resource&&store.sqlite.prepare("SELECT 1 FROM branch_step_executions WHERE execution_id=? AND step_id='gate'").get(pe.id))break;
 }
 assert.ok(resource);assert.equal(branches.detail(pe.id).gates.length,0);await branches.unitSaver.drain();
 const create=async(input,key,owner)=>{const p=store.createProject({...input,...owner,hostPath:dir,chatOwned:true},{idempotencyKey:key,payloadHash:'inert Chat boundary'});return store.getConversation(p.lastConversationId);};
 const deleteAgents=async ids=>{if(!ids.length)return;const preview=store.previewAgentDeletion(ids);store.deleteAgentSubtrees(ids,preview.previewHash,id=>coordination.handleAgentDeletion(id));};
 const deleteChat=async id=>{if(!store.getConversation(id,{includeDeleting:true}))return;const receipt=store.commitConversationDeletion(id);store.finishConversationDeletionStorageCleanup(receipt);store.markConversationDeletionServerCleanupComplete(id);};
 const service=(createChat=create)=>{const r=new BranchResourceService(branches,store,deleteAgents,createChat,deleteChat);services.push(r);return r;};
 const openGate=async()=>{gateAvailability(null);for(let n=0;n<30&&!branches.detail(pe.id).gates.length;n++){await branches.unitSaver.drain();branches.advance();}assert.equal(branches.detail(pe.id).gates[0].state,'waiting');return branches.execution(pe.id).checkpointInvocation;};
 const approve=()=>{const gate=branches.detail(pe.id).gates[0];branches.resolveGate(gate.id,{commandKey:'approve',expectedRevision:gate.revision,decision:'approve'});};
 const step=async()=>{await branches.unitSaver.drain();branches.advance();};
 const importPlan=async(provision,hooks)=>{
  const operation=store.beginAgentCreationOperation({projectId:provision.projectId,conversationId:provision.chatId,actorScope:'resource-inert',kind:'import',idempotencyKey:provision.creationKey,payloadHash:'inert'}).operation,id=randomUUID();
  store.addAgentCreationOperationMember(operation.id,id,0);await hooks.plan([id],operation.id);return {operation,id};
 };
 const importCommit=(provision,hooks,plan)=>{
  const agent=store.createAgent(provision.projectId,{title:'Inert imported worker',engine:'codex',conversationId:provision.chatId},undefined,plan.id);
  const result={rootAgentId:agent.id,agentIds:[agent.id]};
  const commit=()=>{hooks.commit(result);store.updateAgentCreationOperation(plan.operation.id,{status:'completed',result});};
  if(hooks.transaction)hooks.transaction(commit);else store.sqlite.transaction(commit)();return result;
 };
 return {dir,store,branches,coordination,child,parent,pe,resource,create,service,openGate,approve,step,importPlan,importCommit};
}

for(const mode of ['async','sync','exit'])test(`in-flight Chat creation holds ancestor; known completion cannot start import through gate (${mode})`,{timeout:15000},async t=>{
 const f=await fixture(t,mode),entered=deferred(),release=deferred();let imports=0;
 const r=f.service(async(...args)=>{entered.resolve();await release.promise;return f.create(...args);});
 r.setImporter(async(p,h)=>{imports++;const plan=await f.importPlan(p,h);f.importCommit(p,h,plan);});
 const pending=r.tick(true);await entered.promise;
 let closing;
 try{closing=await f.openGate();assert.equal(closing.state,'interrupting','an actual create await is outstanding');}
 finally{release.resolve();await pending;}
 await f.branches.unitSaver.drain();
 assert.equal(imports,0);assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'chat').state,'completed');
 assert.equal(f.branches.execution(f.pe.id).checkpointInvocation.state,'interrupted');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
 await r.tick(true);assert.equal(imports,0);f.approve();await r.tick(true);assert.equal(imports,0);
 f.branches.advance();await r.tick(true);if(mode==='sync')assert.equal(imports,0,'fresh sync invocation coverage still required');
 if(imports)assert.notEqual(f.branches.execution(f.pe.id).checkpointInvocation.id,closing.id);
 for(let n=0;n<30&&!imports;n++){await f.step();await r.tick(true);}
 assert.equal(imports,1);assert.notEqual(f.branches.execution(f.pe.id).checkpointInvocation.id,closing.id);
 for(let n=0;n<15&&!f.store.sqlite.prepare('SELECT 1 FROM coordination_requests').get();n++){await f.step();await r.tick(true);}
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,1);
});


async function attachChat(f){
 const chat=await f.create({label:'Known setup Chat',defaultEngine:'codex'},'known-setup',{branchId:f.child.id,executionId:f.resource.execution_id});
 f.branches.bindResourceChat(f.resource.step_execution_id,chat.id);await f.branches.unitSaver.drain();return chat;
}
for(const mode of ['async','sync','exit'])test(`in-flight import records known result but holds opening Request until fresh ancestor release (${mode})`,{timeout:15000},async t=>{
 const f=await fixture(t,mode);await attachChat(f);const entered=deferred(),release=deferred(),r=f.service();let calls=0;
 r.setImporter(async(p,h)=>{calls++;const plan=await f.importPlan(p,h);entered.resolve();await release.promise;f.importCommit(p,h,plan);});
 const pending=r.tick(true);await entered.promise;
 const closing=await f.openGate();assert.equal(closing.state,'interrupting');
 release.resolve();await pending;await f.branches.unitSaver.drain();
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'completed');
 assert.equal(f.branches.execution(f.pe.id).checkpointInvocation.state,'interrupted');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agents').get().n,1);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
 for(let n=0;n<3;n++){await f.step();await r.tick(true);}assert.equal(calls,1);
 f.approve();await r.tick(true);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
 for(let n=0;n<25&&!f.store.sqlite.prepare('SELECT 1 FROM coordination_requests').get();n++){await f.step();await r.tick(true);}
 assert.equal(calls,1);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,1);
 assert.notEqual(f.branches.execution(f.pe.id).checkpointInvocation.id,closing.id);
});

for(const mode of ['async','sync','exit'])test(`uncertain import throw stays durable, visible and unreplayed (${mode})`,{timeout:15000},async t=>{
 const f=await fixture(t,mode);await attachChat(f);const entered=deferred(),release=deferred(),r=f.service();let calls=0;
 r.setImporter(async(p,h)=>{calls++;await f.importPlan(p,h);entered.resolve();await release.promise;throw Error('controlled uncertain import');});
 const pending=r.tick(true);await entered.promise;await f.openGate();release.resolve();await pending;
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'unknown');
 assert.match(r.errors()[0].message,/uncertain import/);assert.equal(f.branches.execution(f.pe.id).checkpointInvocation.state,'interrupting');
 f.approve();for(let n=0;n<4;n++){await f.step();await r.tick(true);}assert.equal(calls,1);
 const fresh=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));
 assert.equal(fresh.resourceOperation(f.resource.step_execution_id,'import').state,'unknown');assert.deepEqual(fresh.resourceProvisions(),[]);
 assert.equal(f.branches.resourceCanRetire(f.resource.step_execution_id,[]),false);f.branches.cancel(f.pe.id);
 assert.equal(f.store.sqlite.prepare('SELECT cancel_requested FROM branch_executions WHERE id=?').get(f.pe.id).cancel_requested,1);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
});

test('unstarted reservations close safely and a delayed plan revalidates the current ancestor gate',{timeout:15000},async t=>{
 const f=await fixture(t,'sync');await attachChat(f);const waiting=await f.openGate();
 assert.equal(waiting.state,'interrupted');await f.branches.unitSaver.drain();
 assert.throws(()=>f.branches.planResource(f.resource.step_execution_id,[randomUUID()]),/release is held/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resource_members').get().n,0);
 const r=f.service();let calls=0;r.setImporter(async()=>{calls++;});await r.tick(true);assert.equal(calls,0);
});

test('known full rollback closes an in-flight import without treating an uncertain effect as retryable',{timeout:15000},async t=>{
 const f=await fixture(t);await attachChat(f);const entered=deferred(),release=deferred(),r=f.service();
 r.setImporter(async(p,h)=>{const plan=await f.importPlan(p,h);entered.resolve();await release.promise;f.store.updateAgentCreationOperation(plan.operation.id,{status:'rolled_back'});throw Error('known rolled-back import');});
 const pending=r.tick(true);await entered.promise;await f.openGate();release.resolve();await pending;
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'rolled_back');
 assert.equal(f.branches.execution(f.pe.id).checkpointInvocation.state,'interrupted');assert.match(r.errors()[0].message,/rolled-back/);
});

test('cancellation cannot retire an in-flight import; known completion permits mandatory exact cleanup',{timeout:15000},async t=>{
 const f=await fixture(t);const chat=await attachChat(f),entered=deferred(),release=deferred(),r=f.service();
 r.setImporter(async(p,h)=>{const plan=await f.importPlan(p,h);entered.resolve();await release.promise;f.importCommit(p,h,plan);});
 const pending=r.tick(true);await entered.promise;f.branches.cancel(f.pe.id);
 assert.equal(f.branches.resourceCanRetire(f.resource.step_execution_id,[]),false);
 const maintenance=r.tick(false);release.resolve();await Promise.all([pending,maintenance]);
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'completed');
 assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_resources').get().state,'retired');
 assert.equal(f.store.getConversation(chat.id),undefined);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
 for(let n=0;n<15&&f.branches.execution(f.pe.id).state!=='canceled';n++)await f.step();
 assert.equal(f.branches.execution(f.pe.id).state,'canceled');
});

test('a pending resource await does not hold unrelated dispatch; errors surface outside effect catches',{timeout:15000},async t=>{
 const f=await fixture(t);await attachChat(f);const entered=deferred(),release=deferred(),r=f.service();
 r.setImporter(async(p,h)=>{await f.importPlan(p,h);entered.resolve();await release.promise;throw Error('visible importer failure');});
 const pending=r.tick(true);await entered.promise;
 const x=f.branches.deploy({chatId:'',idempotencyKey:'X',definition:{schema:'ponderosa.branch.v1',name:'X',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'// inert override',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:f.dir}}});
 const execution=f.branches.accept(x.id,'X','input'),scripts=new BranchScriptService(f.branches,f.store,'inert',{resources:r});
 let launches=0;scripts.launch=async lease=>{launches++;f.branches.settleScript(lease,{failed:false,output:'X known'});};
 for(let n=0;n<15&&f.branches.execution(execution.id).state!=='completed';n++)await scripts.tick(true);
 assert.equal(launches,1);assert.equal(f.branches.execution(execution.id).state,'completed');
 release.resolve();await pending;
 const operation=f.branches.resourceOperation(f.resource.step_execution_id,'import');
 assert.throws(()=>f.branches.planResource(f.resource.step_execution_id,[randomUUID()],operation.token),/fenced/);
 assert.throws(()=>f.branches.bindResource(f.resource.step_execution_id,{rootAgentId:'unknown',agentIds:['unknown']}),/known committed/);
 await assert.rejects(scripts.tick(false),/checkpoint durability failed/);
 assert.equal(f.branches.detail(execution.id).sealedResults.length,1);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_attempts WHERE state='outcome_unknown'").get().n,0);
});


test('a gate opened before delayed planning prevents fresh Agent identities and permits proven rollback closure',{timeout:15000},async t=>{
 const f=await fixture(t,'sync');await attachChat(f);const entered=deferred(),release=deferred(),r=f.service();
 r.setImporter(async(p,h)=>{
  const operation=f.store.beginAgentCreationOperation({projectId:p.projectId,conversationId:p.chatId,actorScope:'delayed-plan',kind:'import',idempotencyKey:p.creationKey,payloadHash:'inert'}).operation,id=randomUUID();
  f.store.addAgentCreationOperationMember(operation.id,id,0);entered.resolve();await release.promise;
  try{await h.plan([id],operation.id);assert.fail('held plan must refuse');}catch(error){f.store.updateAgentCreationOperation(operation.id,{status:'rolled_back'});throw error;}
 });
 const pending=r.tick(true);await entered.promise;await f.openGate();release.resolve();await pending;
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resource_members').get().n,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agents').get().n,0);
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'rolled_back');
 assert.equal(f.branches.execution(f.pe.id).checkpointInvocation.state,'interrupted');assert.match(r.errors()[0].message,/release is held/);
});

test('uncertain Chat creation is visible and never automatically released again',{timeout:15000},async t=>{
 const f=await fixture(t),entered=deferred(),release=deferred();let calls=0;
 const r=f.service(async()=>{calls++;entered.resolve();await release.promise;throw Error('unknown Chat creation effect');});r.setImporter(async()=>assert.fail('no import'));
 const pending=r.tick(true);await entered.promise;await f.openGate();release.resolve();await pending;
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'chat').state,'unknown');
 assert.equal(f.branches.execution(f.pe.id).checkpointInvocation.state,'interrupting');
 for(let n=0;n<3;n++)await r.tick(true);assert.equal(calls,1);assert.match(r.errors()[0].message,/unknown Chat/);
});

test('independent unstarted resource cleanup runs while another import is awaiting',{timeout:15000},async t=>{
 const f=await fixture(t);await attachChat(f);const entered=deferred(),release=deferred(),r=f.service();
 r.setImporter(async(p,h)=>{const plan=await f.importPlan(p,h);entered.resolve();await release.promise;f.importCommit(p,h,plan);});
 const pending=r.tick(true);await entered.promise;
 const x=f.branches.accept(f.child.id,'cleanup-X','input');let resource;
 for(let n=0;n<20&&!resource;n++){await f.step();resource=f.store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(x.id);}
 assert.ok(resource);const chat=await f.create({label:'Cleanup X',defaultEngine:'codex'},'cleanup-X',{branchId:f.child.id,executionId:x.id});f.branches.bindResourceChat(resource.step_execution_id,chat.id);f.branches.cancel(x.id);
 const maintenance=r.tick(false);
 for(let n=0;n<30&&f.store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id).state!=='retired';n++)await Promise.resolve();
 assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id).state,'retired');
 assert.equal(f.store.getConversation(chat.id),undefined);assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'running');
 release.resolve();await Promise.all([pending,maintenance]);
});

test('ancestor saver failure preserves known import, forbids opening/replay and leaves cancellation cleanup usable',{timeout:15000},async t=>{
 const f=await fixture(t,'sync');await attachChat(f);const entered=deferred(),release=deferred(),r=f.service();let calls=0;
 r.setImporter(async(p,h)=>{calls++;const plan=await f.importPlan(p,h);entered.resolve();await release.promise;f.importCommit(p,h,plan);});
 const pending=r.tick(true);await entered.promise;await f.openGate();await f.branches.unitSaver.drain();
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_resource_close BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${f.pe.id}' BEGIN SELECT RAISE(ABORT,'resource ancestor save failure'); END`);
 release.resolve();await pending;await assert.rejects(f.branches.unitSaver.drain(),/checkpoint|save|failure/i);
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'completed');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agents').get().n,1);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
 await r.tick(true);assert.equal(calls,1);assert.equal(r.errors().length,0,'checkpoint failure is not an importer failure');
 f.branches.cancel(f.pe.id);await r.tick(false);assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_resources').get().state,'retired');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_attempts WHERE state='outcome_unknown'").get().n,0);
});

test('an unrelated failed saver cannot abort a valid owner import plan',{timeout:15000},async t=>{
 const f=await fixture(t,'sync');await attachChat(f);const r=f.service();
 const xbranch=f.branches.deploy({chatId:'',idempotencyKey:'failed-X',definition:{schema:'ponderosa.branch.v1',name:'Failed X',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'// inert',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:f.dir}}});
 const x=f.branches.accept(xbranch.id,'failed-X','input');
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_unrelated BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${x.id}' BEGIN SELECT RAISE(ABORT,'unrelated X saver'); END`);
 await assert.rejects(f.branches.unitSaver.waitFor([x.id]));
 r.setImporter(async(p,h)=>{const plan=await f.importPlan(p,h);f.importCommit(p,h,plan);});
 await r.tick(true);
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'completed');assert.equal(r.errors().length,0);
 await f.branches.unitSaver.waitFor([f.pe.id,f.resource.execution_id]);await r.tick(true);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,1);
});


test('known import survives a later importer throw without losing the visible durable error or replaying',{timeout:15000},async t=>{
 const f=await fixture(t);await attachChat(f);const r=f.service();let calls=0;
 r.setImporter(async(p,h)=>{calls++;const plan=await f.importPlan(p,h);f.importCommit(p,h,plan);throw Error('failure after known import commit');});
 await r.tick(true);assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'import').state,'completed');
 await f.branches.unitSaver.waitFor([f.pe.id,f.resource.execution_id]);await r.tick(true);
 assert.equal(calls,1);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,1);
 assert.match(r.errors()[0].message,/after known import commit/);
 const fresh=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));assert.match(fresh.resourceErrors()[0].message,/after known import commit/);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_attempts WHERE state='outcome_unknown'").get().n,0);
});

test('current resource policy is checked again after Chat creation yields',{timeout:15000},async t=>{
 const f=await fixture(t),entered=deferred(),release=deferred();let imports=0;
 const r=f.service(async(...args)=>{entered.resolve();await release.promise;return f.create(...args);});r.setImporter(async()=>{imports++;});
 const pending=r.tick(true);await entered.promise;
 new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'branch',scopeId:f.child.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]});
 release.resolve();await pending;
 assert.equal(f.branches.resourceOperation(f.resource.step_execution_id,'chat').state,'completed');assert.equal(imports,0);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests').get().n,0);
});
