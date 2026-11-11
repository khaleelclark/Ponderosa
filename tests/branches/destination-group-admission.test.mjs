// Deferred whole-group Runtime fixture; synthetic resource/custody inventory is not Branch/provider qualification.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,destinationAdmissionHeld,workspaceCreationId,CapabilityPolicyStore} from '../../packages/agents/dist/index.js';
import {selectBranchUnit} from '../../packages/agents/dist/branch-unit-selection.js';
import {captureBranchHostCut} from '../../packages/agents/dist/branch-host-cut.js';
import {resourceCaptureFrontierHash} from '../../packages/agents/dist/branch-resource-capture.js';
import {payloadHash,stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
const now=()=>new Date().toISOString();

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'destination-admission-')),store=new AgentStore(dir),db=store.sqlite,coordination=new CoordinationV3Store(db),branches=new BranchStore(db,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Inert source',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Source'}),agent=store.createAgent(project.id,{title:'Source worker',engine:'codex',conversationId:chat.id});
 const secondChat=store.createConversation(project.id,{title:'Second source'}),secondAgent=store.createAgent(project.id,{title:'Second source worker',engine:'codex',conversationId:secondChat.id});
 const secondRequest=coordination.coordinate({projectId:project.id,conversationId:secondChat.id,actorScope:'user:fixture',idempotencyKey:'second-source',requests:[{recipientAgentId:secondAgent.id,lifetime:{kind:'indefinite'},payload:{text:'Second private task'}}]}).requestIds[0];
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Source',trigger:{kind:'manual'},entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Retained task'}],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{worker:agent.id},directories:{}}});
 const source=branches.accept(branch.id,'source','input');
 for(let n=0;n<30&&!branches.detail(source.id).attempts[0]?.requestId;n++){branches.advance();await branches.unitSaver.drain();}
 const requestId=branches.detail(source.id).attempts[0].requestId;
 coordination.updateRequest({requestId,updateId:'old-question',kind:'question',actor:{kind:'agent',id:agent.id},payload:{text:'Original private question'}});
 // Synthetic inert retained resource inventory isolates the new runtime boundary from the Branch
 // consumer, which remains separately refused. The saved Request/update prefix is canonical.
 const selected=selectBranchUnit(db,source.id),resourceStepId=selected.steps[0]?.id??selected.attempts[0].step_execution_id;
 const resource={step_execution_id:resourceStepId,execution_id:source.id,chat_id:chat.id,generation:0,requested_count:1,import_operation_json:stableJson({result:{agentIds:[agent.id]}})},secondResource={...resource,step_execution_id:randomUUID(),chat_id:secondChat.id,import_operation_json:stableJson({result:{agentIds:[secondAgent.id]}})};selected.resources=[resource,secondResource];
 const cut=db.transaction(()=>captureBranchHostCut(db,source.id,{...selectBranchUnit(db,source.id),resources:[]}))();
 cut.resources=[resource,secondResource].map(row=>({row,sha256:payloadHash(row)}));
 cut.resourceMembers=[{step_execution_id:resourceStepId,agent_id:agent.id,origin:'template'},{step_execution_id:secondResource.step_execution_id,agent_id:secondAgent.id,origin:'template'}].map(row=>({row,sha256:payloadHash(row)}));
 const secondRow=db.prepare('SELECT * FROM coordination_requests WHERE id=?').get(secondRequest);cut.requests.push({row:secondRow,sha256:payloadHash(secondRow)});cut.coverage.requestVersions.push({requestId:secondRequest,version:0,updatePrefixComplete:true});
 const snapshot={selected,hostDependencies:cut,issuedContinuation:{bindingHash:cut.bindingPin.sha256,configuration:{}}},checkpointHash=payloadHash(snapshot);
 const checkpointId=Number(db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(source.id,stableJson(snapshot),checkpointHash).lastInsertRowid);
 coordination.updateRequest({requestId,updateId:'old-answer',kind:'answer',inReplyToUpdateId:'old-question',actor:{kind:'user'},payload:{text:'Later answer does not replace retained question'}});
 coordination.updateRequest({requestId,updateId:'old-completed',kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'Old effects settled'}});
 coordination.updateRequest({requestId:secondRequest,updateId:'second-complete',kind:'completed',actor:{kind:'agent',id:secondAgent.id},payload:{text:'Second effects settled'}});
 for(let n=0;n<30&&branches.execution(source.id).state!=='completed';n++){branches.advance();await branches.unitSaver.drain();}
 assert.equal(branches.execution(source.id).state,'completed');
 db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const execution=branches.accept(branch.id,'fresh','fresh'),creationKey='destination-chat',conversationId=workspaceCreationId('conversation',project.id,creationKey),freshStep=randomUUID();
 const custody={version:1,checkpointId:'fixture-custody',custodyId:createHash('sha256').update('fixture-custody').digest('hex'),sourceChatId:chat.id,agentIds:[agent.id],boundaryId:'fixture-source-boundary',sha256:'a'.repeat(64),byteLength:1,intent:{executionId:source.id,resourceStepId,resourceGeneration:0,frontierSha256:resourceCaptureFrontierHash(selected),hostCutSha256:payloadHash(cut),bindingSha256:cut.bindingPin.sha256,configurationSha256:payloadHash({})}};

 const secondCreationKey='second-destination-chat',secondConversationId=workspaceCreationId('conversation',project.id,secondCreationKey),secondStep=randomUUID();
 const resources=[{custody,destination:{projectId:project.id,conversationId,executionId:execution.id,resourceStepId:freshStep,resourceGeneration:1}},
  {custody:{...custody,checkpointId:'fixture-custody-2',custodyId:createHash('sha256').update('fixture-custody-2').digest('hex'),sourceChatId:secondChat.id,agentIds:[secondAgent.id],intent:{...custody.intent,resourceStepId:secondResource.step_execution_id}},destination:{projectId:project.id,conversationId:secondConversationId,executionId:execution.id,resourceStepId:secondStep,resourceGeneration:1}}];
 const input={branchId:branch.id,sourceExecutionId:source.id,checkpointId,checkpointHash,commandKey:'group',operatorId:'fixture-human',reconcileEffects:true,resources};
 let disclosureAllowed=true;
 const authority={requireGroupCustodyAndOwner:r=>{assert.deepEqual(r.resources,resources);return 'whole-group-owner';},authorizeGroupDisclosure:review=>{assert.ok(disclosureAllowed,'group disclosure revoked');assert.equal(Object.keys(review.stage.imports).length,2);assert.ok(review.facts.some(f=>f.id===secondRequest));return 'whole-group-disclosure';},resolveArtifact:()=>assert.fail('no fixture artifacts')};
 const reserved=db.transaction(()=>coordination.reserveCoordinationDestinationGroup(input,authority))();
 const stages=[],freshAgents=[];
 for(const [index,r] of resources.entries()){
  assert.equal(destinationAdmissionHeld(db,undefined,r.destination.conversationId),true,'every prospective Chat held');
  store.createConversation(project.id,{title:'Destination '+index},{idempotencyKey:index?secondCreationKey:creationKey,payloadHash:payloadHash({title:'Destination '+index})});
  db.prepare('UPDATE conversations SET branch_id=?,branch_execution_id=? WHERE id=?').run(branch.id,execution.id,r.destination.conversationId);
  const freshAgent=randomUUID(),operationId=randomUUID();freshAgents.push(freshAgent);
  db.prepare("INSERT INTO agent_creation_operations(id,project_id,actor_scope,kind,idempotency_key,payload_hash,status,created_at,updated_at) VALUES(?,?,'user:fixture','import',?,?,'preparing',?,?)").run(operationId,project.id,'group-import-'+index,payloadHash({}),now(),now());
  db.prepare('UPDATE agent_creation_operations SET conversation_id=? WHERE id=?').run(r.destination.conversationId,operationId);
  db.prepare('INSERT INTO agent_creation_operation_members VALUES(?,?,0)').run(operationId,freshAgent);
  const stage={importPlan:{creationOperationId:operationId,projectId:project.id,conversationId:r.destination.conversationId,agents:[{sourceRef:r.custody.agentIds[0],agentId:freshAgent}],artifacts:[]},agentMap:{[r.custody.agentIds[0]]:freshAgent},artifactMap:{}};stages.push(stage);
  db.transaction(()=>coordination.stageCoordinationDestinationGroupResource(reserved.admissionId,r.custody.sourceChatId,stage))();
  store.createAgent(project.id,{title:'Fresh '+index,engine:'codex',conversationId:r.destination.conversationId},undefined,freshAgent);
  if(!index)assert.throws(()=>db.transaction(()=>coordination.reviewCoordinationDestinationGroup(reserved.admissionId,authority))(),/not staged/);
 }
 const review=()=>db.transaction(()=>coordination.reviewCoordinationDestinationGroup(reserved.admissionId,authority))();
 const beforeOutbox=db.prepare('SELECT count(*) n FROM activation_outbox').get().n;
 const compose=graph=>resources.map((r,index)=>{
  assert.equal(db.prepare('SELECT count(*) n FROM activation_outbox').get().n,beforeOutbox,'no wakes during resource composition');
  assert.ok(freshAgents.every(id=>destinationAdmissionHeld(db,id)),'all identities held throughout composer');
  const step=r.destination.resourceStepId,stage=stages[index],freshAgent=freshAgents[index];
  db.prepare("INSERT INTO branch_step_executions(id,execution_id,step_id,path_id,invocation,state,input_text) VALUES(?,?,'agent',?,1,'waiting','input')").run(step,execution.id,'fixture-path-'+index);
  if(!index)db.prepare("INSERT INTO branch_attempts(id,step_execution_id,number,state,request_id,input_hash,created_at,updated_at) VALUES(?,?,1,'waiting',?,?,?,?)").run(randomUUID(),step,graph.requestMap[requestId],payloadHash('input'),now(),now());
  db.prepare("INSERT INTO branch_resources(step_execution_id,execution_id,template_ref,state,requested_count,root_agent_id,creation_key,chat_id,generation) VALUES(?,?,'fixture','active',1,?,?,?,1)").run(step,execution.id,freshAgent,'fixture-resource-'+index,r.destination.conversationId);
  db.prepare("INSERT INTO branch_resource_members(agent_id,step_execution_id,origin) VALUES(?,?,'template')").run(freshAgent,step);
  db.prepare("UPDATE agent_creation_operations SET status='completed',result_json='{}' WHERE id=?").run(stage.importPlan.creationOperationId);
  const receiptId='fixture-owner-'+index;
  db.prepare('INSERT INTO branch_commands(execution_id,command_key,input_hash,result_json,created_at) VALUES(?,?,?,?,?)').run(execution.id,receiptId,payloadHash(input),stableJson({coordinationDestination:graph}),now());
  return {executionId:execution.id,resourceStepId:step,resourceGeneration:1,creationOperationId:stage.importPlan.creationOperationId,receiptId,requestBindings:index?[]:[{sourceRequestId:requestId,requestId:graph.requestMap[requestId],stepExecutionId:step}]};
 });
 return {store,db,coordination,resources,input,authority,reserved,stages,freshAgents,requestId,secondRequest,review,compose,setDisclosure:allowed=>disclosureAllowed=allowed};
}

test('one whole-cut group maps both Chats, publishes only final wakes and reads exact receipt without recomposition',async t=>{
 const f=await fixture(t),review=f.review();
 const receipt=f.db.transaction(()=>f.coordination.admitCoordinationDestinationGroup(f.reserved.admissionId,review.reviewHash,f.authority,f.compose))();
 assert.equal(receipt.owners.length,2);assert.equal(receipt.resources.length,2);
 for(const [index,id] of [f.requestId,f.secondRequest].entries()){
  const request=f.coordination.getRequest(receipt.requestMap[id]);
  assert.equal(request.conversationId,f.resources[index].destination.conversationId);
  assert.equal(request.recipientAgentId,f.freshAgents[index]);assert.equal(destinationAdmissionHeld(f.db,f.freshAgents[index]),false);
 }
 const count=f.db.prepare('SELECT count(*) n FROM activation_outbox').get().n;
 const replay=f.db.transaction(()=>f.coordination.admitCoordinationDestinationGroup(f.reserved.admissionId,review.reviewHash,f.authority,()=>assert.fail('recompose')))();
 assert.equal(replay.replayed,true);assert.equal(f.db.prepare('SELECT count(*) n FROM activation_outbox').get().n,count);
 assert.equal(f.db.prepare('SELECT count(*) n FROM coordination_cut_restorations').get().n,1,'one graph writer');
 f.setDisclosure(false);assert.throws(()=>f.coordination.readCoordinationDestinationGroup(receipt.admissionId,receipt.reservationHash,f.authority),/revoked/);
});
test('second-resource policy change and incomplete composer roll back the whole group, including caught savepoint failure',async t=>{
 const f=await fixture(t),review=f.review(),counts=()=>['coordination_requests','coordination_cut_restorations','activation_outbox','branch_resources'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n),before=counts();
 const policies=new CapabilityPolicyStore(f.db);policies.put({scopeKind:'chat',scopeId:f.resources[1].destination.conversationId,expectedRevision:0,restrictedCapabilityIds:[]});
 assert.throws(()=>f.db.transaction(()=>f.coordination.admitCoordinationDestinationGroup(f.reserved.admissionId,review.reviewHash,f.authority,f.compose))(),/review again/);assert.deepEqual(counts(),before);
 const current=f.review();f.db.transaction(()=>{assert.throws(()=>f.coordination.admitCoordinationDestinationGroup(f.reserved.admissionId,current.reviewHash,f.authority,g=>f.compose(g).slice(0,1)),/owner receipts/);})();
 assert.deepEqual(counts(),before);assert.ok(f.freshAgents.every(id=>destinationAdmissionHeld(f.db,id)));
 for(const stage of f.stages)assert.equal(f.db.prepare('SELECT status FROM agent_creation_operations WHERE id=?').get(stage.importPlan.creationOperationId).status,'preparing');
});
test('incremental stage replay refuses changed maps and singular entrypoints cannot adopt a group',async t=>{
 const f=await fixture(t),stage=f.stages[0],source=f.resources[0].custody.sourceChatId;
 f.db.transaction(()=>f.coordination.stageCoordinationDestinationGroupResource(f.reserved.admissionId,source,stage))();
 assert.throws(()=>f.db.transaction(()=>f.coordination.stageCoordinationDestinationGroupResource(f.reserved.admissionId,source,{...stage,agentMap:{[f.resources[0].custody.agentIds[0]]:randomUUID()}}))(),/conflict/);
 assert.throws(()=>f.db.transaction(()=>f.coordination.reviewCoordinationDestination(f.reserved.admissionId,{}))(),/singular or group/);
 assert.throws(()=>f.db.transaction(()=>f.coordination.reviewCoordinationDestinationReconciliation(f.reserved.admissionId,'operator',{}))(),/singular or group/);
});
