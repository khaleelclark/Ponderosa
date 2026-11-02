// Deferred: source only; run with the repository workspace loader after normal builds.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,destinationAdmissionHeld,workspaceCreationId} from '../../packages/agents/dist/index.js';
import {selectBranchUnit} from '../../packages/agents/dist/branch-unit-selection.js';
import {captureBranchHostCut} from '../../packages/agents/dist/branch-host-cut.js';
import {resourceCaptureFrontierHash} from '../../packages/agents/dist/branch-resource-capture.js';
import {payloadHash,stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
const now=()=>new Date().toISOString();

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'destination-admission-')),store=new AgentStore(dir),db=store.sqlite,coordination=new CoordinationV3Store(db),branches=new BranchStore(db,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Inert source',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Source'}),agent=store.createAgent(project.id,{title:'Source worker',engine:'codex',conversationId:chat.id});
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Source',trigger:{kind:'manual'},entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Retained task'}],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{worker:agent.id},directories:{}}});
 const source=branches.accept(branch.id,'source','input');
 for(let n=0;n<30&&!branches.detail(source.id).attempts[0]?.requestId;n++){branches.advance();await branches.unitSaver.drain();}
 const requestId=branches.detail(source.id).attempts[0].requestId;
 coordination.updateRequest({requestId,updateId:'old-question',kind:'question',actor:{kind:'agent',id:agent.id},payload:{text:'Original private question'}});
 // Synthetic inert retained resource inventory isolates the new runtime boundary from the Branch
 // consumer, which remains separately refused. The saved Request/update prefix is canonical.
 const selected=selectBranchUnit(db,source.id),resourceStepId=selected.steps[0]?.id??selected.attempts[0].step_execution_id;
 const resource={step_execution_id:resourceStepId,execution_id:source.id,chat_id:chat.id,generation:0,requested_count:1};selected.resources=[resource];
 const cut=db.transaction(()=>captureBranchHostCut(db,source.id,{...selectBranchUnit(db,source.id),resources:[]}))();
 cut.resources=[{row:resource,sha256:payloadHash(resource)}];
 const snapshot={selected,hostDependencies:cut},checkpointHash=payloadHash(snapshot);
 const checkpointId=Number(db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(source.id,stableJson(snapshot),checkpointHash).lastInsertRowid);
 coordination.updateRequest({requestId,updateId:'old-answer',kind:'answer',inReplyToUpdateId:'old-question',actor:{kind:'user'},payload:{text:'Later answer does not replace retained question'}});
 coordination.updateRequest({requestId,updateId:'old-completed',kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'Old effects settled'}});
 for(let n=0;n<30&&branches.execution(source.id).state!=='completed';n++){branches.advance();await branches.unitSaver.drain();}
 assert.equal(branches.execution(source.id).state,'completed');
 db.prepare("UPDATE agent_activations SET state='cancelled' WHERE state IN ('pending','retry_pending')").run();
 const execution=branches.accept(branch.id,'fresh','fresh'),creationKey='destination-chat',conversationId=workspaceCreationId('conversation',project.id,creationKey),freshStep=randomUUID();
 const custody={version:1,checkpointId:'fixture-custody',custodyId:createHash('sha256').update('fixture-custody').digest('hex'),sourceChatId:chat.id,agentIds:[agent.id],boundaryId:'fixture-source-boundary',sha256:'a'.repeat(64),byteLength:1,intent:{executionId:source.id,resourceStepId,resourceGeneration:0,frontierSha256:resourceCaptureFrontierHash(selected),bindingSha256:cut.bindingPin.sha256,configurationSha256:payloadHash({})}};
 const input={branchId:branch.id,sourceExecutionId:source.id,checkpointId,checkpointHash,commandKey:'fresh-command',operatorId:'fixture-human',reconcileEffects:true,custody,destination:{projectId:project.id,conversationId,executionId:execution.id,resourceStepId:freshStep,resourceGeneration:1}};
 let disclosureAllowed=true,disclosureRevision='revision-1';
 const authority={requireCustodyAndOwner(reservation){assert.deepEqual(reservation,input);return 'owner-revision-1';},authorizeDisclosure(review){assert.equal(disclosureAllowed,true,'disclosure revoked');assert.ok(review.facts.some(f=>f.kind==='update'&&f.id==='old-question'));return disclosureRevision;},resolveArtifact(){assert.fail('fixture has no artifacts');}};
 const reserved=db.transaction(()=>coordination.reserveCoordinationDestination(input,authority))();
 store.createConversation(project.id,{title:'Destination'},{idempotencyKey:creationKey,payloadHash:payloadHash({title:'Destination'})});
 const freshAgent=randomUUID(),operationId=randomUUID();
 db.prepare("INSERT INTO agent_creation_operations(id,project_id,actor_scope,kind,idempotency_key,payload_hash,status,created_at,updated_at) VALUES(?,?,'user:fixture','import','fixture-import',?,'preparing',?,?)").run(operationId,project.id,payloadHash({}),now(),now());
 db.prepare('INSERT INTO agent_creation_operation_members VALUES(?,?,0)').run(operationId,freshAgent);
 const stage={importPlan:{creationOperationId:operationId,projectId:project.id,conversationId,agents:[{sourceRef:agent.id,agentId:freshAgent}],artifacts:[]},agentMap:{[agent.id]:freshAgent},artifactMap:{}};
 db.transaction(()=>coordination.stageCoordinationDestination(reserved.admissionId,stage))();
 store.createAgent(project.id,{title:'Fresh worker',engine:'codex',conversationId},undefined,freshAgent);
 const review=()=>db.transaction(()=>coordination.reviewCoordinationDestination(reserved.admissionId,authority))();
 const compose=graph=>{
  db.prepare("INSERT INTO branch_step_executions(id,execution_id,step_id,path_id,invocation,state,input_text) VALUES(?,?,'agent','fixture-path',1,'waiting','input')").run(freshStep,execution.id);
  db.prepare("INSERT INTO branch_attempts(id,step_execution_id,number,state,request_id,input_hash,created_at,updated_at) VALUES(?,?,1,'waiting',?,?,?,?)").run(randomUUID(),freshStep,graph.requestMap[requestId],payloadHash('input'),now(),now());
  db.prepare("INSERT INTO branch_resources(step_execution_id,execution_id,template_ref,state,requested_count,root_agent_id,creation_key,chat_id,generation) VALUES(?,?,'fixture','active',1,?,'fixture-resource',?,1)").run(freshStep,execution.id,freshAgent,conversationId);
  db.prepare("INSERT INTO branch_resource_members(agent_id,step_execution_id,origin) VALUES(?,?,'template')").run(freshAgent,freshStep);
  db.prepare("UPDATE agent_creation_operations SET status='completed',result_json='{}' WHERE id=?").run(operationId);
  db.prepare('INSERT INTO branch_commands(execution_id,command_key,input_hash,result_json,created_at) VALUES(?,?,?,?,?)').run(execution.id,'fixture-owner',payloadHash(input),stableJson({coordinationDestination:graph}),now());
  return {executionId:execution.id,resourceStepId:freshStep,resourceGeneration:1,creationOperationId:operationId,receiptId:'fixture-owner',requestBindings:[{sourceRequestId:requestId,requestId:graph.requestMap[requestId],stepExecutionId:freshStep}]};
 };
 return {store,db,coordination,branches,agent,freshAgent,conversationId,input,authority,reserved,stage,requestId,review,compose,setDisclosure(allowed,revision=disclosureRevision){disclosureAllowed=allowed;disclosureRevision=revision;}};
}

test('staged destination rejects ordinary intake across reopened runtime and exact changed-map replay',async t=>{
 const f=await fixture(t);assert.ok(destinationAdmissionHeld(f.db,f.freshAgent));assert.equal(f.store.agentCreationPending(f.freshAgent),true);
 const reopened=new CoordinationV3Store(f.db);
 assert.throws(()=>reopened.coordinate({projectId:f.input.destination.projectId,conversationId:f.conversationId,actorScope:'user:fixture',idempotencyKey:'forbidden',requests:[{recipientAgentId:f.freshAgent,lifetime:{kind:'indefinite'},payload:{text:'must remain held'}}]}),/staged/);
 assert.throws(()=>f.db.transaction(()=>reopened.stageCoordinationDestination(f.reserved.admissionId,{...f.stage,agentMap:{[f.agent.id]:randomUUID()}}))(),/conflict/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(f.freshAgent).n,0);
});

test('mapped historical question uses fresh recipient and live answer authority; lost-response readback creates no duplicate',async t=>{
 const f=await fixture(t),review=f.review(),receipt=f.db.transaction(()=>f.coordination.admitCoordinationDestination(f.reserved.admissionId,review.reviewHash,f.authority,f.compose))();
 assert.notEqual(receipt.requestMap[f.requestId],f.requestId);assert.equal(destinationAdmissionHeld(f.db,f.freshAgent),false);
 const fresh=f.coordination.getRequest(receipt.requestMap[f.requestId]);assert.equal(fresh.recipientAgentId,f.freshAgent);assert.equal(fresh.state,'awaiting_answer');
 const question=f.db.prepare('SELECT kind,actor_kind,actor_id FROM coordination_request_updates WHERE id=?').get(receipt.updateMap['old-question']);assert.deepEqual(question,{kind:'historical_question',actor_kind:'system',actor_id:'host-cut-restoration'});
 const before=f.db.prepare('SELECT COUNT(*) n FROM agent_activations').get().n;
 const replay=f.db.transaction(()=>f.coordination.admitCoordinationDestination(f.reserved.admissionId,review.reviewHash,f.authority,()=>assert.fail('must not recompose')))();assert.equal(replay.replayed,true);assert.deepEqual(replay.requestMap,receipt.requestMap);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM agent_activations').get().n,before);
 assert.throws(()=>f.coordination.updateRequest({requestId:fresh.id,updateId:'forged-answer',kind:'answer',inReplyToUpdateId:receipt.updateMap['old-question'],actor:{kind:'agent',id:f.agent.id},payload:{text:'Source Agent has no fresh authority'}}));
 f.coordination.updateRequest({requestId:fresh.id,updateId:'fresh-answer',kind:'answer',inReplyToUpdateId:receipt.updateMap['old-question'],actor:{kind:'user'},payload:{text:'Fresh authorized answer'}});
 assert.equal(f.coordination.getRequest(fresh.id).state,'in_progress');
 const read=f.coordination.readCoordinationDestination(receipt.admissionId,receipt.reservationHash,f.authority);assert.deepEqual(read.updateMap,receipt.updateMap);
 f.setDisclosure(false);assert.throws(()=>f.coordination.readCoordinationDestination(receipt.admissionId,receipt.reservationHash,f.authority),/disclosure revoked/);
});

test('changed human review and thrown composer never partially admit identities or publish wakes',async t=>{
 const f=await fixture(t),review=f.review(),counts=()=>['coordination_requests','coordination_request_updates','coordination_cut_restorations','activation_outbox'].map(table=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 f.setDisclosure(true,'revision-2');assert.throws(()=>f.db.transaction(()=>f.coordination.admitCoordinationDestination(f.reserved.admissionId,review.reviewHash,f.authority,f.compose))(),/review again/);assert.deepEqual(counts(),before);
 const current=f.review();
 f.db.transaction(()=>{assert.throws(()=>f.coordination.admitCoordinationDestination(f.reserved.admissionId,current.reviewHash,f.authority,graph=>{f.compose(graph);throw Error('controlled composer failure');}),/controlled composer failure/);})();
 assert.deepEqual(counts(),before,'caught failure still rolls back the nested admission savepoint');assert.equal(destinationAdmissionHeld(f.db,f.freshAgent),true);
 const receipt=f.db.transaction(()=>f.coordination.admitCoordinationDestination(f.reserved.admissionId,current.reviewHash,f.authority,f.compose))();assert.ok(receipt.restorationId);
});


test('missing private participant mapping refuses review without dropping facts or publishing work',async t=>{
 const f=await fixture(t),row=f.db.prepare('SELECT stage_json FROM coordination_destination_admissions WHERE id=?').get(f.reserved.admissionId),stage=JSON.parse(row.stage_json);
 delete stage.agentMap[f.agent.id];
 // First prove the durable identity trigger rejects this corruption. Then bypass only
 // that trigger in this disposable adversarial fixture to exercise the reader boundary.
 assert.throws(()=>f.db.prepare('UPDATE coordination_destination_admissions SET stage_json=? WHERE id=?').run(stableJson(stage),f.reserved.admissionId),/immutable/);
 f.db.exec('DROP TRIGGER coordination_destination_identity_immutable');
 f.db.prepare('UPDATE coordination_destination_admissions SET stage_json=? WHERE id=?').run(stableJson(stage),f.reserved.admissionId);
 const counts=()=>['coordination_requests','coordination_cut_restorations','activation_outbox'].map(table=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),before=counts();
 assert.throws(()=>f.review(),/Destination import member ownership changed/);
 assert.deepEqual(counts(),before);assert.equal(destinationAdmissionHeld(f.db,f.freshAgent),true);
});
