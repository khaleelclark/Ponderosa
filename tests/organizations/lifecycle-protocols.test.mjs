// Deferred host protocol fixtures. Real Branch/native deletion drain qualification is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkpointCaptureAbandonment} from '../../apps/server/dist/checkpoint-capture-abandonment.js';
import {destinationLifecycle} from '../../apps/server/dist/destination-lifecycle.js';
import {lifecycleHash} from '../../apps/server/dist/lifecycle-journal.js';
import {stableJson,resourceCaptureFrontierHash} from '../../packages/agents/dist/index.js';
import {CoordinationV3DestinationReconciliation,groupReconciliationAuthority} from '../../packages/agents/dist/coordination-v3-destination-reconciliation.js';
const source={checkpointId:'capture',sourceChatId:'source-chat',agentIds:['source-agent'],intent:{executionId:'source',resourceStepId:'step',resourceGeneration:0,frontierSha256:'a'.repeat(64),bindingSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64)}};
const custodyId=createHash('sha256').update(source.checkpointId).digest('hex');
function fixture(t){
 const dataDir=mkdtempSync(path.join(tmpdir(),'lifecycle-protocol-')),db=new Database(':memory:');t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});
 mkdirSync(path.join(dataDir,'checkpoint-package-custody'),{mode:0o700});
 db.exec(`CREATE TABLE branches(id TEXT PRIMARY KEY);CREATE TABLE branch_unit_snapshots(id INTEGER PRIMARY KEY);
 CREATE TABLE branch_commands(execution_id TEXT,command_key TEXT,result_json TEXT);
 CREATE TABLE branch_executions(id TEXT PRIMARY KEY,state TEXT,parent_execution_id TEXT);
 CREATE TABLE scheduler_runs(agent_id TEXT,status TEXT);CREATE TABLE provider_process_authority(agent_id TEXT);
 CREATE TABLE agent_activations(agent_id TEXT,state TEXT);CREATE TABLE agent_creation_operation_members(operation_id TEXT,agent_id TEXT);
 CREATE TABLE agent_creation_operations(id TEXT,conversation_id TEXT,status TEXT,idempotency_key TEXT);
 CREATE TABLE branch_attempts(id TEXT,step_execution_id TEXT,state TEXT,process_identity_json TEXT,fence INTEGER);
 CREATE TABLE branch_step_executions(id TEXT,execution_id TEXT);CREATE TABLE branch_checkpoints(execution_id TEXT,kind TEXT,transition_key TEXT);
 CREATE TABLE coordination_requests(conversation_id TEXT,requester_agent_id TEXT,recipient_agent_id TEXT,state TEXT);
 CREATE TABLE coordination_joins(conversation_id TEXT,state TEXT);CREATE TABLE coordination_cut_restorations(receipt_json TEXT);
 CREATE TABLE project_deletion_pending(project_id TEXT);CREATE TABLE project_deletion_receipts(project_id TEXT,storage_cleanup_completed INTEGER,draft_cleanup_completed INTEGER,asset_authority_cleanup_completed INTEGER,completed_at TEXT);
 CREATE TABLE conversation_deletion_receipts(conversation_id TEXT,project_id TEXT,canonical_deletion_completed INTEGER,storage_cleanup_completed INTEGER,server_cleanup_completed INTEGER);
 CREATE TABLE agent_deletion_tombstones(agent_id TEXT,conversation_id TEXT);
 CREATE TABLE agent_deletion_pending(agent_id TEXT);CREATE TABLE agent_deletion_receipts(id TEXT,project_id TEXT,deleted_agent_ids_json TEXT,storage_cleanup_completed INTEGER,server_cleanup_completed INTEGER);
 CREATE TABLE capability_policies(scope_kind TEXT,scope_id TEXT,revision INTEGER);CREATE TABLE capability_policy_history(scope_kind TEXT,scope_id TEXT,revision INTEGER);
 CREATE TABLE conversations(id TEXT);CREATE TABLE agents(id TEXT,conversation_id TEXT,deleted_at TEXT);`);
 db.exec(readFileSync(new URL('../../packages/agents/src/schema/0040_lifecycle_reconciliation.sql',import.meta.url),'utf8'));
 return {dataDir,db};
}
test('package tombstone survives SQL rollback; exact retry preserves bytes and survives Branch owner removal',t=>{
 const {dataDir,db}=fixture(t),directory=path.join(dataDir,'checkpoint-package-custody');
 writeFileSync(path.join(directory,`${custodyId}.pending.json`),JSON.stringify(source));writeFileSync(path.join(directory,`${custodyId}.payload`),'private original');
 const captureValue={schema:'branch-resource-capture.v1',source,state:'capturing'};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?)').run('source','capture-key',stableJson(captureValue));
 let fail=true,ownerAvailable=true;
 const inspect=()=>{if(!ownerAvailable)throw Error('owner gone');return {custodyId,revision:'revision',references:[{kind:'command',ownerId:'source',key:'capture-key',sha256:lifecycleHash(captureValue)}],blockers:['not deleted'],abandonmentBlockers:[]};};
 const owner={inspect,abandonCapture(actual,input,publish){assert.equal(db.inTransaction,true);assert.equal(input.expectedRevision,'revision');const packageRetirement=publish();if(fail)throw Error('simulated SQL failure');return {state:'abandoned',packageRetirement};}};
 const api=checkpointCaptureAbandonment(dataDir,db,()=>owner),review=api.review({source,captureKey:'capture-key'}),input={source,captureKey:'capture-key',commandKey:'approve',reviewSha256:review.reviewSha256,preserveEvidence:true};
 assert.throws(()=>api.abandon(input),/SQL failure/);
 assert.equal(existsSync(path.join(directory,`${custodyId}.reconciled.json`)),true);
 assert.equal(db.prepare('SELECT count(*) n FROM host_lifecycle_commits').get().n,0);
 fail=false;const result=api.abandon(input);
 assert.equal(readFileSync(path.join(result.package.evidenceDirectory,`${custodyId}.payload`),'utf8'),'private original');
 ownerAvailable=false;assert.deepEqual(api.abandon(input),result);
 assert.throws(()=>api.abandon({...input,commandKey:'different'}),/conflict/);
 writeFileSync(path.join(result.package.evidenceDirectory,`${custodyId}.payload`),'changed');
 assert.throws(()=>api.abandon(input),/evidence changed/);
});
test('destination retirement binds observed destination cleanup and durable exact approval, not source drain',t=>{
 const {dataDir,db}=fixture(t);
 for(const name of ['0037_coordination_destination_admissions.sql','0038_coordination_destination_retirements.sql'])db.exec(readFileSync(new URL('../../packages/agents/src/schema/'+name,import.meta.url),'utf8'));
 db.exec("INSERT INTO branches VALUES('branch');INSERT INTO branch_executions(id,state) VALUES('source','completed');INSERT INTO branch_unit_snapshots VALUES(1)");
 const reservation={branchId:'branch',sourceExecutionId:'source',checkpointId:1,checkpointHash:'e'.repeat(64),commandKey:'reserve',operatorId:'local-operator',reconcileEffects:true,custody:{...source,custodyId},destination:{projectId:'project',conversationId:'destination',executionId:'destination-owner',resourceStepId:'destination-step',resourceGeneration:0}};
 db.prepare('INSERT INTO coordination_destination_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('admission','branch','source',1,'reserve',lifecycleHash(reservation),stableJson(reservation),'{}','project','destination','reserved',null,null,'now','now');
 const runtime=new CoordinationV3DestinationReconciliation(db),coordination={reviewCoordinationDestinationReconciliation:(...args)=>runtime.review(...args),retireCoordinationDestination:(...args)=>runtime.retire(...args),readCoordinationDestinationRetirement:id=>runtime.read(id)};
 let live=false,references=[];const owner={inspect:()=>({revision:'source-absent',references,blockers:[],ownerState:'absent'})};
 const api=destinationLifecycle({dataDir,store:{sqlite:db,getProject:()=>({id:'project'})},coordination,owner:()=>owner,runtimeIdle:()=>!live,creationLeases:new Map()});
 assert.throws(()=>api.review('admission'),/Chat deletion/);
 db.exec("INSERT INTO conversation_deletion_receipts VALUES('destination','project',1,1,1)");
 const stage={importPlan:{creationOperationId:'import',projectId:'project',conversationId:'destination',agents:[{sourceRef:'source-agent',agentId:'fresh'}],artifacts:[]},agentMap:{'source-agent':'fresh'},artifactMap:{}};
 db.prepare("UPDATE coordination_destination_admissions SET state='staged',stage_json=? WHERE id='admission'").run(stableJson(stage));
 db.exec("INSERT INTO coordination_destination_members VALUES('admission','source-agent','fresh');INSERT INTO agents VALUES('fresh',NULL,'deleted');INSERT INTO agent_deletion_tombstones VALUES('fresh','destination');INSERT INTO agent_creation_operations VALUES('import','destination','rolled_back','import-request')");
 assert.throws(()=>api.review('admission'),/Agent observed.*receipt missing/);
 db.exec(`INSERT INTO agent_deletion_receipts VALUES('deleted','project','["fresh"]',1,1)`);
 references=[{kind:'checkpoint',ownerId:'source',key:'1',sha256:'f'.repeat(64)}];
 const pinned=api.review('admission');assert.throws(()=>api.approve('admission',{commandKey:'pinned',expectedReviewHash:pinned.reviewHash,releaseSourcePins:true,authorizeDeletedOwner:true}),/pins remain referenced/);
 references=[];
 const reviewed=api.review('admission'),choice={commandKey:'retire',expectedReviewHash:reviewed.reviewHash,releaseSourcePins:true,authorizeDeletedOwner:true};
 assert.throws(()=>api.retire('admission',choice),/human retirement approval/);
 api.approve('admission',choice);live=true;assert.throws(()=>api.retire('admission',choice),/live provider/);
 live=false;const receipt=api.retire('admission',choice);assert.equal(receipt.releasedSourcePins,true);assert.deepEqual(api.retire('admission',choice),receipt);
 assert.equal(db.prepare('SELECT count(*) n FROM coordination_destination_admissions').get().n,0);
});

// Compose the real canonical group retirement with injected host inventory/runtime ports.
test('group host observes both resources, extra deleted members and stale approval before one canonical retirement',t=>{
 const {dataDir,db}=fixture(t);
 for(const name of ['0037_coordination_destination_admissions.sql','0038_coordination_destination_retirements.sql','0039_coordination_destination_group_chats.sql'])db.exec(readFileSync(new URL('../../packages/agents/src/schema/'+name,import.meta.url),'utf8'));
 db.exec("INSERT INTO branches VALUES('branch');INSERT INTO branch_executions(id,state) VALUES('source-0','completed'),('source-1','completed');INSERT INTO branch_unit_snapshots VALUES(1)");
 const evidence=row=>({row,sha256:lifecycleHash(row)});
 const owners=[0,1].map(index=>{
  const executionId=`source-${index}`;
  const resource={execution_id:executionId,step_execution_id:`source-step-${index}`,chat_id:`source-chat-${index}`,generation:0,import_operation_json:stableJson({result:{agentIds:[`source-agent-${index}`]}})};
  const selected={execution:[{id:executionId,branch_id:'branch',version_id:`version-${index}`,binding_revision_id:`binding-${index}`,...(index?{parent_execution_id:'source-0',parent_attempt_id:'call'}:{})}],resources:[resource],attempts:[{id:`attempt-${index}`,request_id:`request-${index}`},...(!index?[{id:'call'}]:[])]};
  const cut={schema:'ponderosa.branch.host-dependencies.v1',executionId,restoreAuthority:'fresh_admission_required',nativeState:'not_captured',artifactStorage:'references_only',bindingPin:{revisionId:`binding-${index}`,sha256:String(index).repeat(64),requiredSecretRefs:[]},coverage:{complete:true,missingReferences:[],requestVersions:[]},roots:[{attemptId:`attempt-${index}`,requestId:`request-${index}`}],...Object.fromEntries(['requests','updates','lateResults','joins','members','suspensions','communications','joinOutcomes','artifactRefs','resources','resourceMembers','resourceContexts','resourceReceipts'].map(k=>[k,[]]))};
  cut.resources=[evidence(resource)];cut.resourceMembers=[evidence({agent_id:`source-agent-${index}`,step_execution_id:resource.step_execution_id})];
  return {executionId,versionId:`version-${index}`,bindingRevisionId:`binding-${index}`,bindingHash:cut.bindingPin.sha256,configuration:{owner:index},selected,hostDependencies:cut,hostDependenciesHash:lifecycleHash(cut)};
 });
 const snapshot={selected:owners[0].selected,hostDependencies:owners[0].hostDependencies,continuation:{schema:'ponderosa.branch.script-tree-continuation.v1',rootExecutionId:'source-0',owners}};
 const resources=owners.map((owner,index)=>{
  const original={checkpointId:`capture-${index}`,sourceChatId:`source-chat-${index}`,agentIds:[`source-agent-${index}`],intent:{executionId:owner.executionId,resourceStepId:`source-step-${index}`,resourceGeneration:0,frontierSha256:resourceCaptureFrontierHash(owner.selected),hostCutSha256:lifecycleHash(owner.hostDependencies),bindingSha256:owner.bindingHash,configurationSha256:lifecycleHash(owner.configuration)}};
  return {custody:{version:1,...original,custodyId:createHash('sha256').update(original.checkpointId).digest('hex'),boundaryId:'original',sha256:'a'.repeat(64),byteLength:1},destination:{projectId:'project',conversationId:`destination-${index}`,executionId:`destination-owner-${index}`,resourceStepId:`step-${index}`,resourceGeneration:0}};
 });
 const reservation={branchId:'branch',sourceExecutionId:'source-0',checkpointId:1,checkpointHash:lifecycleHash(snapshot),commandKey:'reserve',operatorId:'local-operator',reconcileEffects:true,...resources[0],resources};
 db.prepare('INSERT INTO coordination_destination_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('group','branch','source-0',1,'reserve',lifecycleHash(reservation),stableJson(reservation),stableJson(snapshot),'project','destination-0','reserved',null,null,'now','now');
 for(const resource of resources)db.prepare('INSERT INTO coordination_destination_group_chats VALUES(?,?,?,?,NULL)').run('group',resource.custody.sourceChatId,resource.custody.intent.executionId,resource.destination.conversationId);
 const partial={importPlan:{creationOperationId:'partial-import',projectId:'project',conversationId:'destination-1',agents:[{sourceRef:'source-agent-1',agentId:'mapped'}],artifacts:[]},agentMap:{'source-agent-1':'mapped'},artifactMap:{}};
 db.prepare("UPDATE coordination_destination_group_chats SET stage_json=? WHERE source_chat_id='source-chat-1'").run(stableJson(partial));
 db.exec("INSERT INTO coordination_destination_members VALUES('group','source-agent-1','mapped');INSERT INTO agent_creation_operations VALUES('partial-import','destination-1','rolled_back','partial-request');INSERT INTO agents VALUES('mapped',NULL,'deleted');INSERT INTO agent_deletion_tombstones VALUES('mapped','destination-1')");
 db.exec(`INSERT INTO agent_deletion_receipts VALUES('deleted-mapped','project','["mapped"]',1,1)`);
 db.exec("ALTER TABLE agent_creation_operations ADD COLUMN project_id TEXT DEFAULT 'project'");
 let project={id:'project',policyRevision:1},live=false,retireCalls=0;
 const runtime=new CoordinationV3DestinationReconciliation(db,true);
 const coordination={
  reviewCoordinationDestinationGroupReconciliation:(id,operator,authority)=>runtime.review(id,operator,groupReconciliationAuthority(authority)),
  retireCoordinationDestinationGroup(input,authority){
   const prior=runtime.read(input.admissionId),receipt=runtime.retire(input,groupReconciliationAuthority(authority));if(!prior)retireCalls++;return receipt;
  },readCoordinationDestinationGroupRetirement:id=>runtime.read(id),
 };
 let references=[],sourceUnknown=false;
 const api=destinationLifecycle({dataDir,store:{sqlite:db,getProject:()=>project},coordination,owner:()=>({inspect:actual=>({revision:lifecycleHash(actual),references:actual.sourceChatId==='source-chat-1'?references:[],blockers:[],abandonmentBlockers:sourceUnknown?['owned_native_exit_unconfirmed']:[]})}),runtimeIdle:()=>!live,creationLeases:new Map()},true);
 db.exec("INSERT INTO conversation_deletion_receipts VALUES('destination-0','project',1,1,1)");
 assert.throws(()=>api.review('group'),/Chat deletion/);assert.equal(retireCalls,0);
 db.exec("INSERT INTO conversation_deletion_receipts VALUES('destination-1','project',1,1,1);INSERT INTO agent_deletion_tombstones VALUES('extra','destination-1')");
 assert.throws(()=>api.review('group'),/Agent observed.*receipt missing/);
 db.exec(`INSERT INTO agent_deletion_receipts VALUES('deleted-extra','project','["extra"]',1,1)`);
 const firstStage={importPlan:{creationOperationId:'first-import',projectId:'project',conversationId:'destination-0',agents:[{sourceRef:'source-agent-0',agentId:'mapped0'}],artifacts:[]},agentMap:{'source-agent-0':'mapped0'},artifactMap:{}};
 db.prepare("UPDATE coordination_destination_group_chats SET stage_json=? WHERE source_chat_id='source-chat-0'").run(stableJson(firstStage));
 const full={importPlan:firstStage.importPlan,imports:{'source-chat-0':firstStage.importPlan,'source-chat-1':partial.importPlan},agentMap:{...firstStage.agentMap,...partial.agentMap},artifactMap:{}};
 db.prepare("UPDATE coordination_destination_admissions SET state='staged',stage_json=? WHERE id='group'").run(stableJson(full));
 db.exec("INSERT INTO coordination_destination_members VALUES('group','source-agent-0','mapped0');INSERT INTO agent_creation_operations(id,conversation_id,status,idempotency_key,project_id) VALUES('first-import','destination-0','rolled_back','first-request','project');INSERT INTO agents VALUES('mapped0',NULL,'deleted');INSERT INTO agent_deletion_tombstones VALUES('mapped0','destination-0')");
 db.exec(`INSERT INTO agent_deletion_receipts VALUES('deleted-mapped0','project','["mapped0"]',1,1)`);

 references=[{kind:'checkpoint',ownerId:'source-1',key:'7',sha256:'7'.repeat(64)}];
 sourceUnknown=true;assert.throws(()=>api.review('group'),/source owner runtime/);sourceUnknown=false;
 const pinned=api.review('group');assert.equal(pinned.canReleaseSourcePins,false);
 assert.throws(()=>api.approve('group',{commandKey:'pins',expectedReviewHash:pinned.reviewHash,releaseSourcePins:true,authorizeDeletedOwner:true}),/pins remain referenced/);
 references=[];
 const first=api.review('group'),choice={commandKey:'first',expectedReviewHash:first.reviewHash,releaseSourcePins:true,authorizeDeletedOwner:true};
 assert.throws(()=>api.retire('group',choice),/human retirement approval/);api.approve('group',choice);
 db.exec("INSERT INTO capability_policies VALUES('branch','branch',2)");project={...project,policyRevision:2};assert.throws(()=>api.retire('group',choice),/review changed/);
 const current=api.review('group'),fresh={...choice,commandKey:'fresh',expectedReviewHash:current.reviewHash};api.approve('group',fresh);
 live=true;assert.throws(()=>api.retire('group',fresh),/live provider/);live=false;
 db.exec("INSERT INTO branch_step_executions VALUES('native-step','destination-owner-1');INSERT INTO branch_attempts VALUES('attempt','native-step','completed','process',2)");
 assert.throws(()=>api.retire('group',fresh),/native\/effect/);assert.equal(retireCalls,0);
 db.exec("INSERT INTO branch_checkpoints VALUES('destination-owner-1','script_process_exit','process-exit:attempt:2')");
 assert.throws(()=>api.retire('group',fresh),/review changed/);
 project=undefined;assert.throws(()=>api.review('group'),/deleted-Project/);
 db.exec("INSERT INTO project_deletion_receipts VALUES('project',1,1,1,'completed')");
 const settled=api.review('group'),settledChoice={...fresh,commandKey:'settled',expectedReviewHash:settled.reviewHash};api.approve('group',settledChoice);
 const result=api.retire('group',settledChoice);assert.equal(retireCalls,1);assert.deepEqual(api.receipt('group'),result);assert.deepEqual(api.retire('group',settledChoice),result);
 assert.equal(result.resources.length,2);assert.equal(result.groupChats.length,2);
 for(const table of ['coordination_destination_admissions','coordination_destination_members','coordination_destination_group_chats'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 db.exec('DELETE FROM agent_creation_operations;DELETE FROM branch_commands;DELETE FROM project_deletion_receipts');
 assert.deepEqual(api.receipt('group'),result);assert.deepEqual(api.retire('group',settledChoice),result);
 assert.throws(()=>api.retire('group',{...settledChoice,releaseSourcePins:false}),/conflict/);
});
