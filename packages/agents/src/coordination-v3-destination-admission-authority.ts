import {readPinnedRetainedIssuedSource} from './coordination-v3-retained-destination-source.js';
import {destinationResourceEvidence} from './coordination-v3-destination-resource-evidence.js';
import {branchContinuationIds} from './branch-continuation-remap.js';
import {CoordinationV3DestinationReconciliation} from './coordination-v3-destination-reconciliation.js';
import {readDestinationHistoricalPartition,destinationHistoricalFacts,commitDestinationHistoricalPartition,verifyDestinationHistoricalPartition} from './coordination-v3-historical-partition.js';
import {randomUUID,createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
 CoordinationDestinationReservation,CoordinationDestinationStage,CoordinationDestinationReview,
 CoordinationDestinationReceipt,CoordinationDestinationOwnerReceipt,CoordinationDestinationGroupResource,
} from '@ponderosa/core';
import {TERMINAL_REQUEST_STATES} from '@ponderosa/core';
import type {RuntimeArtifactInputV3} from './coordination-v3-types.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {retainedBranchHostGraph} from './branch-tree-host-cut.js';
import {verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {verifyHostProvenance} from './branch-host-provenance.js';
import {resourceCaptureFrontierHash,receiptMatchesSource} from './branch-resource-capture.js';
import {CapabilityPolicyStore} from './capability-policy-store.js';
import {runtimeArtifactMetadataIsValid} from './coordination-v3-runtime-validation.js';
import {validateRetainedCoordinationGraph,writeRetainedCoordinationGraph,restoredRequestUpdatePayload} from './coordination-v3-cut-restoration-authority.js';
import type {CreateActivationV3Input} from './coordination-v3-runtime-communication-authority.js';

type Row=Record<string,any>;
/** Current host authority callbacks, never values supplied by a provider or imported package.
 * Every callback is synchronous, throws on refusal and is re-evaluated at final commit. */
export interface CoordinationDestinationAuthority {
 /** Verifies retained custody bytes/receipt and current Branch owner/Step/generation/pins. */
 requireCustodyAndOwner(reservation:CoordinationDestinationReservation):string;
 /** Authorizes this HUMAN to read original private facts AND disclose each to these destinations.
  * Return a current authority revision bound to the exact review, not a blanket source grant. */
 authorizeDisclosure(review:Omit<CoordinationDestinationReview,'reviewHash'|'disclosureRevision'>):string;
 /** Re-admitted content must be independently retained and authorized for this exact new audience. */
 resolveArtifact(input:{source:Row;destinationId:string;importArtifactId:string;projectId:string;agentIds:string[]}):RuntimeArtifactInputV3;
}
/** Distinct group callbacks prevent a legacy singular adapter from approving only the first resource. */
export interface CoordinationDestinationGroupAuthority {
 requireGroupCustodyAndOwner(reservation:CoordinationDestinationReservation&{resources:CoordinationDestinationGroupResource[]}):string;
 authorizeGroupDisclosure(review:Omit<CoordinationDestinationReview,'reviewHash'|'disclosureRevision'>):string;
 resolveArtifact:CoordinationDestinationAuthority['resolveArtifact'];
}
export function groupDestinationAuthority(authority:CoordinationDestinationGroupAuthority):CoordinationDestinationAuthority {
 return {requireCustodyAndOwner:r=>{if(!r.resources)throw Error('Group reservation required');return authority.requireGroupCustodyAndOwner({...r,resources:r.resources});},
  authorizeDisclosure:r=>authority.authorizeGroupDisclosure(r),resolveArtifact:i=>authority.resolveArtifact(i)};
}
const hashPattern=/^[a-f0-9]{64}$/;
const synchronous=<T>(value:T):T=>{if(value&&typeof value==='object'&&'then' in value)throw Error('Destination admission requires synchronous authority and composition');return value;};
const unique=(ids:string[])=>[...new Set(ids)].sort();
const exactKeys=(map:Record<string,unknown>,ids:string[])=>stableJson(Object.keys(map).sort())===stableJson(unique(ids));
const nonempty=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=512;

const resourcesOf=(r:CoordinationDestinationReservation):CoordinationDestinationGroupResource[]=>r.resources??[{custody:r.custody,destination:r.destination}];
const resourceStage=(r:CoordinationDestinationGroupResource,s:CoordinationDestinationStage,cut:BranchHostCut):CoordinationDestinationStage=>({
 importPlan:s.imports?.[r.custody.sourceChatId]??s.importPlan,
 agentMap:Object.fromEntries(r.custody.agentIds.map(id=>[id,s.agentMap[id]!])),
 artifactMap:Object.fromEntries(cut.artifactRefs.filter(e=>{
  const u=cut.updates.find(u=>u.row.id===e.row.owner_id),q=cut.requests.find(q=>q.row.id===u?.row.request_id);
  return q?.row.conversation_id===r.custody.sourceChatId;
 }).map(e=>[e.row.id,s.artifactMap[e.row.id]!])),
});

/** Shared final-policy projection, also rechecked by the explicit human disclosure adapter.
 * Does not authorize disclosure or assert fresh admission eligibility. */
export function destinationDisclosurePolicy(db:Database.Database,reservation:CoordinationDestinationReservation,stage:CoordinationDestinationStage):unknown {
 const d=reservation.destination,policies=new CapabilityPolicyStore(db);
 if(!db.prepare(`SELECT 1 FROM conversations c WHERE c.id=? AND c.project_id=?
  AND NOT EXISTS(SELECT 1 FROM project_deletion_pending p WHERE p.project_id=c.project_id)
  AND NOT EXISTS(SELECT 1 FROM conversation_deletion_receipts r WHERE r.conversation_id=c.id)`).get(d.conversationId,d.projectId))throw Error('Destination policy scope unavailable');
 for(const id of Object.values(stage.agentMap))if(!db.prepare(`SELECT 1 FROM agents a WHERE a.id=? AND a.project_id=? AND a.conversation_id=? AND a.deleted_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM agent_deletion_pending p WHERE p.agent_id=a.id)`).get(id,d.projectId,d.conversationId))throw Error('Destination policy participant unavailable');
 const op=db.prepare('SELECT artifact_ids_json FROM agent_creation_operations WHERE id=? AND project_id=?').get(stage.importPlan.creationOperationId,d.projectId) as Row|undefined;
 if(!op)throw Error('Destination policy import unavailable');
 const chat=policies.resolveForChat(d.conversationId),agents=Object.values(stage.agentMap).map(agentId=>({agentId,policy:policies.resolveForAgent(agentId)}));
 const layers=[...chat.layers,...agents.flatMap(a=>a.policy.layers)];
 const revisions=[...new Map(layers.map(l=>[`${l.scopeKind}:${l.scopeId}`,{scopeKind:l.scopeKind,scopeId:l.scopeId,revision:policies.get(l.scopeKind,l.scopeId)?.revision??0}] as const)).values()];
 return {chat,agents,revisions,importArtifacts:JSON.parse(op.artifact_ids_json)};
}

/** Server-owned staged admission. Ordinary coordinate/updateRequest actor rules are unchanged. */
export class CoordinationV3DestinationAdmissionAuthority {
 constructor(private readonly db:Database.Database,private readonly deliver:(input:CreateActivationV3Input)=>string,private readonly group=false){}
 private transaction():void {if(!this.db.inTransaction)throw Error('Destination admission requires the same Branch owner transaction');}
 private row(id:string):Row {
  if(this.db.prepare('SELECT 1 FROM coordination_destination_retirements WHERE admission_id=?').get(id))throw Error('Destination retired');
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(id) as Row|undefined;
  if(!row)throw Error('Destination admission unavailable');
  if(Boolean(JSON.parse(row.reservation_json).resources)!==this.group)throw Error('Use the exact singular or group admission API');return row;
 }
 private source(row:Row,context:'current'|'audit'='current'):{reservation:CoordinationDestinationReservation;cut:BranchHostCut} {
  const reservation=JSON.parse(row.reservation_json) as CoordinationDestinationReservation,snapshot=JSON.parse(row.snapshot_json);
  if(stableJson(reservation)!==row.reservation_json||payloadHash(reservation)!==row.reservation_hash
    ||stableJson(snapshot)!==row.snapshot_json||payloadHash(snapshot)!==reservation.checkpointHash)throw Error('Destination retained evidence differs');
  const retained=reservation.retainedSourceId?readPinnedRetainedIssuedSource(this.db,reservation.retainedSourceId):undefined;
  if(retained&&(this.group||retained.source.branch_id!==reservation.branchId||retained.source.local_execution_id!==reservation.sourceExecutionId
   ||retained.source.original_checkpoint_key!==String(reservation.checkpointId)||retained.source.original_checkpoint_sha256!==reservation.checkpointHash
   ||retained.source.original_snapshot_json!==row.snapshot_json))throw Error('Retained destination source binding differs');
  const originalExecutionId=retained?.source.original_execution_id??reservation.sourceExecutionId;
  const {cut}=this.group?destinationResourceEvidence(snapshot,reservation):retainedBranchHostGraph(snapshot,originalExecutionId,true,true);
  if(!verifyBranchHostCut(cut,originalExecutionId)||!cut.coverage.complete)throw Error('Destination retained cut is incomplete');
  if(this.group&&row.id&&context==='current'){
   const chats=this.db.prepare('SELECT source_chat_id,source_execution_id,conversation_id FROM coordination_destination_group_chats WHERE admission_id=? ORDER BY source_chat_id').all(row.id);
   const expected=resourcesOf(reservation).map(r=>({source_chat_id:r.custody.sourceChatId,source_execution_id:r.custody.intent.executionId,conversation_id:r.destination.conversationId})).sort((a,b)=>a.source_chat_id<b.source_chat_id?-1:a.source_chat_id>b.source_chat_id?1:0);
   if(stableJson(chats)!==stableJson(expected))throw Error('Group Chat reservation map differs');
  }
  verifyHostProvenance(cut);readDestinationHistoricalPartition(this.db,reservation,undefined,cut,row.state==='admitted'?row.id:undefined);return {reservation,cut};
 }
 reserve(input:CoordinationDestinationReservation,authority:CoordinationDestinationAuthority,now:string):{admissionId:string;state:string} {
  this.transaction();return this.db.transaction(()=>this.reserveInTransaction(input,authority,now))();
 }
 private reserveInTransaction(input:CoordinationDestinationReservation,authority:CoordinationDestinationAuthority,now:string):{admissionId:string;state:string} {
  this.transaction();input=JSON.parse(stableJson(input));
  if(Boolean(input.resources)!==this.group)throw Error('Use the exact singular or group admission API');
  const resources=resourcesOf(input);
  if(this.group&&(!Array.isArray(input.resources)||resources.length<2||resources.length>32
   ||unique(resources.map(r=>r.custody?.sourceChatId)).length!==resources.length
   ||unique(resources.map(r=>r.destination?.conversationId)).length!==resources.length
   ||unique(resources.map(r=>r.custody?.intent?.resourceStepId)).length!==resources.length
   ||unique(resources.map(r=>r.destination?.resourceStepId)).length!==resources.length
   ||resources.some(r=>r.destination?.projectId!==input.destination.projectId)
   ||stableJson(resources[0])!==stableJson({custody:input.custody,destination:input.destination})))throw Error('Invalid atomic group resource inventory');
  if(![input.branchId,input.sourceExecutionId,input.commandKey,input.operatorId,input.destination?.projectId,input.destination?.conversationId,input.destination?.executionId,input.destination?.resourceStepId].every(nonempty)
   ||input.reconcileEffects!==true||!Number.isSafeInteger(input.checkpointId)||input.checkpointId<1||!hashPattern.test(input.checkpointHash)
   ||!Number.isSafeInteger(input.destination.resourceGeneration)||input.destination.resourceGeneration<0
   ||input.custody?.version!==1||!hashPattern.test(input.custody.sha256)||!hashPattern.test(input.custody.custodyId)
   ||!nonempty(input.custody.boundaryId)||!Number.isSafeInteger(input.custody.byteLength)||input.custody.byteLength<1
   ||!Array.isArray(input.custody.agentIds)||input.custody.agentIds.length<1||input.custody.agentIds.length>128
   ||input.custody.agentIds.some(id=>!nonempty(id))||unique(input.custody.agentIds).length!==input.custody.agentIds.length
   ||!nonempty(input.custody.intent.executionId))throw Error('Invalid destination reservation');
  if(this.db.prepare('SELECT 1 FROM coordination_destination_retirements WHERE branch_id=? AND command_key=? OR conversation_id=?').get(input.branchId,input.commandKey,input.destination.conversationId))throw Error('Destination retired; identity and command cannot be reused');
  const prior=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE branch_id=? AND command_key=?').get(input.branchId,input.commandKey) as Row|undefined;
  if(prior){if(prior.reservation_hash!==payloadHash(input)||prior.reservation_json!==stableJson(input))throw Error('Destination command input conflict');return {admissionId:prior.id,state:prior.state};}
  if(!nonempty(synchronous(authority.requireCustodyAndOwner(input))))throw Error('Current custody/owner authority revision required');
  const retained=input.retainedSourceId?readPinnedRetainedIssuedSource(this.db,input.retainedSourceId):undefined;
  const saved=retained?{snapshot_json:retained.source.original_snapshot_json,content_hash:retained.source.original_checkpoint_sha256}:this.db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(input.checkpointId,input.sourceExecutionId) as Row|undefined;
  const execution=this.db.prepare('SELECT branch_id,state FROM branch_executions WHERE id=?').get(input.sourceExecutionId) as Row|undefined;
  if(!saved||saved.content_hash!==input.checkpointHash||execution?.branch_id!==input.branchId||!(retained?execution.state==='waiting':['completed','failed','canceled'].includes(execution.state)))throw Error('Source owner must settle before destination reservation');
  // All prospective identities are reserved before any destination creation effects.
  for(const r of resources){
   const c=r.custody,d=r.destination;
   if(!c||c.version!==1||!hashPattern.test(c.sha256)||!hashPattern.test(c.custodyId)||!nonempty(c.sourceChatId)
    ||!nonempty(c.boundaryId)||!Number.isSafeInteger(c.byteLength)||c.byteLength<1||!Array.isArray(c.agentIds)||!c.agentIds.length||c.agentIds.length>128
    ||c.agentIds.some(id=>!nonempty(id))||unique(c.agentIds).length!==c.agentIds.length||!nonempty(c.intent?.executionId)
    ||![d?.projectId,d?.conversationId,d?.executionId,d?.resourceStepId].every(nonempty)||!Number.isSafeInteger(d.resourceGeneration)||d.resourceGeneration<0)throw Error('Invalid destination resource reservation');
   if(this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(d.conversationId)
    ||this.db.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(d.projectId)
    ||this.db.prepare('SELECT 1 FROM coordination_destination_admissions WHERE conversation_id=?').get(d.conversationId)
    ||this.db.prepare('SELECT 1 FROM coordination_destination_group_chats WHERE conversation_id=?').get(d.conversationId)
    ||this.db.prepare("SELECT 1 FROM coordination_destination_retirements WHERE conversation_id=? OR EXISTS(SELECT 1 FROM json_each(receipt_json,'$.resources') r WHERE json_extract(r.value,'$.destination.conversationId')=?)").get(d.conversationId,d.conversationId))throw Error('Reserve every fresh destination Chat identity before creation');
  }
  const row={reservation_json:stableJson(input),reservation_hash:payloadHash(input),snapshot_json:saved.snapshot_json};
  const {cut}=this.source(row),snapshot=JSON.parse(saved.snapshot_json);
  const selectedResources=snapshot.continuation?.schema==='ponderosa.branch.script-tree-continuation.v1'?snapshot.continuation.owners.flatMap((o:Row)=>o.selected.resources):snapshot.selected.resources;
  if(this.group&&stableJson(unique(selectedResources.map((r:Row)=>r.step_execution_id)))!==stableJson(unique(cut.resources.map(e=>e.row.step_execution_id))))throw Error('Whole owner-tree resource inventory is not captured');
  if(cut.resources.length!==resources.length||cut.requests.some(e=>!resources.some(r=>r.custody.sourceChatId===e.row.conversation_id))
    ||cut.joins.some(e=>!resources.some(r=>r.custody.sourceChatId===e.row.conversation_id)))throw Error('Exhaustive captured resource/Chat inventory required');
  if(unique(resources.flatMap(r=>r.custody.agentIds)).length!==resources.flatMap(r=>r.custody.agentIds).length)throw Error('Resource participant inventories alias');
  for(const r of resources){
   const c=r.custody,sourceOwner=this.db.prepare('SELECT state FROM branch_executions WHERE id=?').get(r.custody.intent.executionId) as Row|undefined;
   if(this.group&&(!sourceOwner||!['completed','failed','canceled'].includes(sourceOwner.state)))throw Error('Every source resource owner must settle');
   const resource=cut.resources.find(e=>e.row.chat_id===c.sourceChatId)?.row;
   if(!resource||resource.step_execution_id!==c.intent.resourceStepId||resource.generation!==c.intent.resourceGeneration||resource.execution_id!==c.intent.executionId)throw Error('Custody resource generation differs from the host cut');
   const owner=snapshot.continuation?.schema==='ponderosa.branch.script-tree-continuation.v1'?snapshot.continuation.owners.find((o:Row)=>o.executionId===c.intent.executionId):null;
   const selected=owner?.selected??snapshot.selected;
   const {version,custodyId,boundaryId,sha256,byteLength,...source}=c;
   if(!selected||!receiptMatchesSource(c,source)||source.intent.frontierSha256!==resourceCaptureFrontierHash(selected)
    ||selected.execution?.[0]?.id!==source.intent.executionId||source.intent.bindingSha256!==(owner?.bindingHash??cut.bindingPin.sha256))throw Error('Custody is not the exact selected host frontier');
   const retainedMembers=cut.resourceMembers.filter(e=>e.row.step_execution_id===resource.step_execution_id).map(e=>e.row.agent_id);
   if(this.group&&stableJson(unique(retainedMembers))!==stableJson(unique(c.agentIds)))throw Error('Group custody participant inventory differs from captured resource');
  }
  if(!cut.requests.length||!cut.roots.some(r=>r.requestId)||cut.bindingPin.requiredSecretRefs.length)throw Error('Issued nonsecret host Request frontier required');
  validateRetainedCoordinationGraph(cut,now);
  for(const {row:r} of cut.requests){
   const live=this.db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(r.id) as Row|undefined;
   if(live&&(!TERMINAL_REQUEST_STATES.has(live.state)||live.state==='outcome_unknown'))throw Error('Original Request effects must settle before fresh admission');
   for(const id of [r.requester_agent_id,r.recipient_agent_id].filter(Boolean))if(this.db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? LIMIT 1").get(id,id))throw Error('Original participant runtime must drain');
  }
  const admissionId=randomUUID();
  this.db.prepare(`INSERT INTO coordination_destination_admissions(id,branch_id,source_execution_id,checkpoint_id,source_kind,retained_source_id,command_key,reservation_hash,reservation_json,snapshot_json,project_id,conversation_id,state,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(admissionId,input.branchId,input.sourceExecutionId,retained?null:input.checkpointId,retained?'retained_foreign':'native',input.retainedSourceId??null,input.commandKey,row.reservation_hash,row.reservation_json,row.snapshot_json,input.destination.projectId,input.destination.conversationId,now,now);
  if(this.group)for(const r of resources)this.db.prepare('INSERT INTO coordination_destination_group_chats(admission_id,source_chat_id,source_execution_id,conversation_id) VALUES(?,?,?,?)').run(admissionId,r.custody.sourceChatId,r.custody.intent.executionId,r.destination.conversationId);
  return {admissionId,state:'reserved'};
 }
 stage(admissionId:string,input:CoordinationDestinationStage,now:string):void {
  this.transaction();return this.db.transaction(()=>this.stageInTransaction(admissionId,input,now))();
 }
 private stageInTransaction(admissionId:string,input:CoordinationDestinationStage,now:string):void {
  this.transaction();input=JSON.parse(stableJson(input));const row=this.row(admissionId),{reservation,cut}=this.source(row);
  if(row.stage_json){if(row.stage_json!==stableJson(input))throw Error('Destination import map conflict');return;}
  if(row.state!=='reserved')throw Error('Destination is not reserved');
  if(this.group&&this.db.prepare('SELECT 1 FROM coordination_destination_group_chats WHERE admission_id=? AND stage_json IS NOT NULL').get(admissionId))throw Error('Finish the reserved incremental group staging path');
  if(Boolean(input.imports)!==this.group)throw Error('Use the exact singular or group import map');
  const resources=resourcesOf(reservation);
  if(this.group&&(!exactKeys(input.imports!,resources.map(r=>r.custody.sourceChatId))||stableJson(input.importPlan)!==stableJson(input.imports![resources[0]!.custody.sourceChatId])))throw Error('Exhaustive group import plans required');
  if(!exactKeys(input.agentMap,resources.flatMap(r=>r.custody.agentIds))||unique(Object.values(input.agentMap)).length!==Object.keys(input.agentMap).length)throw Error('Exhaustive nonaliasing participant map required');
  if(!exactKeys(input.artifactMap,cut.artifactRefs.map(e=>e.row.id))||unique(Object.values(input.artifactMap)).length!==cut.artifactRefs.length)throw Error('Exhaustive fresh artifact map required');
  if(cut.artifactRefs.some(({row:a})=>a.owner_kind!=='request_update'))throw Error('Communication-owned artifact restoration requires separate publication');
  const participants=unique([...cut.requests.flatMap(e=>[e.row.requester_agent_id,e.row.recipient_agent_id]),...cut.joins.map(e=>e.row.owner_agent_id),...cut.suspensions.map(e=>e.row.owner_agent_id)].filter(Boolean));
  if(participants.some(id=>!input.agentMap[id]))throw Error('Every historical participant needs a fresh imported destination');
  const operationIds:string[]=[],artifactDestinations:string[]=[];
  for(const resource of resources){
   const stage=resourceStage(resource,input,cut);
   this.stageResourceImport(admissionId,resource,stage,cut,resources);
   operationIds.push(stage.importPlan.creationOperationId);artifactDestinations.push(...stage.importPlan.artifacts.map(a=>a.destinationId));
  }
  if(unique(operationIds).length!==resources.length||unique(artifactDestinations).length!==artifactDestinations.length)throw Error('Group import operations/artifacts alias');
  this.validateChatParticipants(cut,resources);
  this.db.prepare("UPDATE coordination_destination_admissions SET stage_json=?,state='staged',updated_at=? WHERE id=?").run(stableJson(input),now,admissionId);
 }
 private stageResourceImport(admissionId:string,resource:CoordinationDestinationGroupResource,stage:CoordinationDestinationStage,cut:BranchHostCut,resources:CoordinationDestinationGroupResource[]):void {
   const plan=stage.importPlan;
   if(!plan||plan.projectId!==resource.destination.projectId||plan.conversationId!==resource.destination.conversationId||!nonempty(plan.creationOperationId))throw Error('Destination import reservation differs');
   const op=this.db.prepare('SELECT project_id,conversation_id,kind,status FROM agent_creation_operations WHERE id=?').get(plan.creationOperationId) as Row|undefined;
   if(!op||op.project_id!==plan.projectId||this.group&&op.conversation_id!==plan.conversationId||op.kind!=='import'||!['preparing','canonical_committed'].includes(op.status))throw Error('Destination import is not staged');
   if(!Array.isArray(plan.agents)||plan.agents.length!==resource.custody.agentIds.length||unique(plan.agents.map(a=>a.sourceRef)).length!==plan.agents.length
    ||plan.agents.some(a=>!nonempty(a.agentId)||stage.agentMap[a.sourceRef]!==a.agentId||resources.some(r=>r.custody.agentIds.includes(a.agentId))))throw Error('Explicit fresh import source-ref map required');
   const members=this.db.prepare('SELECT agent_id FROM agent_creation_operation_members WHERE operation_id=? ORDER BY agent_id').all(plan.creationOperationId) as {agent_id:string}[];
   if(stableJson(members.map(m=>m.agent_id))!==stableJson(unique(plan.agents.map(a=>a.agentId))))throw Error('Import member receipt differs from explicit map');
   if(!Array.isArray(plan.artifacts)||unique(plan.artifacts.map(a=>a.sourceRef)).length!==plan.artifacts.length||unique(plan.artifacts.map(a=>a.destinationId)).length!==plan.artifacts.length)throw Error('Invalid import artifact inventory');
   for(const sourceId of Object.keys(stage.artifactMap)){
    const source=cut.artifactRefs.find(e=>e.row.id===sourceId)!.row,imported=plan.artifacts.find(a=>a.sourceRef===sourceId);
    if(!imported||!nonempty(imported.destinationId)||imported.sha256!==source.blob_hash||imported.byteLength!==source.byte_length)throw Error('Artifact map differs from actual import receipt');
   }
   for(const agent of plan.agents){
    if(this.db.prepare('SELECT 1 FROM agents WHERE id=?').get(agent.agentId)||this.db.prepare('SELECT 1 FROM scheduler_runs WHERE agent_id=?').get(agent.agentId))throw Error('Stage group import map before creating fresh Agents');
    this.db.prepare('INSERT INTO coordination_destination_members VALUES(?,?,?)').run(admissionId,agent.sourceRef,agent.agentId);
   }
 }
 /** Actual importer stage hook: each resource is held and mapped before its Agent effects.
  * No graph rows or activations exist until all slots form one reviewed group. */
 stageGroupResource(admissionId:string,sourceChatId:string,input:CoordinationDestinationStage,now:string):void {
  this.transaction();return this.db.transaction(()=>{
   input=JSON.parse(stableJson(input));const row=this.row(admissionId),{reservation,cut}=this.source(row);
   if(!this.group||row.state==='admitted'||input.imports)throw Error('Group resource import requires a reserved group');
   const resources=resourcesOf(reservation),resource=resources.find(r=>r.custody.sourceChatId===sourceChatId);
   if(!resource)throw Error('Group source Chat is not reserved');
   const slot=this.db.prepare('SELECT stage_json FROM coordination_destination_group_chats WHERE admission_id=? AND source_chat_id=?').get(admissionId,sourceChatId) as Row|undefined;
   if(!slot)throw Error('Group import slot missing');
   if(slot.stage_json){if(slot.stage_json!==stableJson(input))throw Error('Group import slot conflict');return;}
   if(row.stage_json)throw Error('Whole group already staged');
   const expected=resourceStage(resource,input,cut);
   if(!exactKeys(input.agentMap,resource.custody.agentIds)||stableJson(expected.agentMap)!==stableJson(input.agentMap)
    ||!exactKeys(input.artifactMap,Object.keys(expected.artifactMap))||stableJson(expected.artifactMap)!==stableJson(input.artifactMap)
    ||unique(Object.values(input.agentMap)).length!==resource.custody.agentIds.length||unique(Object.values(input.artifactMap)).length!==Object.keys(input.artifactMap).length)throw Error('Exact per-resource participant/artifact maps required');
   const others=this.db.prepare('SELECT stage_json FROM coordination_destination_group_chats WHERE admission_id=? AND stage_json IS NOT NULL').all(admissionId) as Row[];
   for(const prior of others){const stage=JSON.parse(prior.stage_json) as CoordinationDestinationStage;
    if(stage.importPlan.creationOperationId===input.importPlan.creationOperationId
     ||Object.values(input.artifactMap).some(id=>Object.values(stage.artifactMap).includes(id))
     ||input.importPlan.artifacts.some(a=>stage.importPlan.artifacts.some(b=>a.destinationId===b.destinationId)))throw Error('Group import operations/artifacts alias');
   }
   this.stageResourceImport(admissionId,resource,input,cut,resources);
   this.db.prepare('UPDATE coordination_destination_group_chats SET stage_json=? WHERE admission_id=? AND source_chat_id=? AND stage_json IS NULL').run(stableJson(input),admissionId,sourceChatId);
   const slots=this.db.prepare('SELECT source_chat_id,stage_json FROM coordination_destination_group_chats WHERE admission_id=? ORDER BY source_chat_id').all(admissionId) as Row[];
   if(slots.some(slot=>!slot.stage_json))return;
   const imports:Record<string,CoordinationDestinationStage['importPlan']>={},agentMap:Record<string,string>={},artifactMap:Record<string,string>={};
   for(const slot of slots){const stage=JSON.parse(slot.stage_json) as CoordinationDestinationStage;imports[slot.source_chat_id]=stage.importPlan;Object.assign(agentMap,stage.agentMap);Object.assign(artifactMap,stage.artifactMap);}
   if(!exactKeys(agentMap,resources.flatMap(r=>r.custody.agentIds))||!exactKeys(artifactMap,cut.artifactRefs.map(e=>e.row.id))||cut.artifactRefs.some(e=>e.row.owner_kind!=='request_update'))throw Error('Group graph participant/artifact closure differs');
   const staged={importPlan:imports[reservation.custody.sourceChatId]!,imports,agentMap,artifactMap};
   this.validateChatParticipants(cut,resources);
   this.db.prepare("UPDATE coordination_destination_admissions SET stage_json=?,state='staged',updated_at=? WHERE id=? AND state='reserved'").run(stableJson(staged),now,admissionId);
  })();
 }
 private validateChatParticipants(cut:BranchHostCut,resources:CoordinationDestinationGroupResource[]):void {
  for(const fact of [...cut.requests,...cut.joins]){
   const r=resources.find(r=>r.custody.sourceChatId===fact.row.conversation_id);
   if(!r||[fact.row.requester_agent_id,fact.row.recipient_agent_id,fact.row.owner_agent_id].filter(Boolean).some(id=>!r.custody.agentIds.includes(id)))throw Error('Historical participant crosses its mapped resource Chat');
  }
 }
 private checkDestination(reservation:CoordinationDestinationReservation,stage:CoordinationDestinationStage):unknown {
  if(!this.group)return this.checkResourceDestination(reservation,stage);
  const {cut}=this.source({reservation_json:stableJson(reservation),reservation_hash:payloadHash(reservation),snapshot_json:this.rowByReservation(reservation).snapshot_json});
  return resourcesOf(reservation).map(resource=>({sourceChatId:resource.custody.sourceChatId,policy:this.checkResourceDestination({...reservation,custody:resource.custody,destination:resource.destination},resourceStage(resource,stage,cut))}));
 }
 private rowByReservation(reservation:CoordinationDestinationReservation):Row {
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE branch_id=? AND command_key=?').get(reservation.branchId,reservation.commandKey) as Row|undefined;
  if(!row)throw Error('Destination reservation missing');return row;
 }
 private checkResourceDestination(reservation:CoordinationDestinationReservation,stage:CoordinationDestinationStage):unknown {
  if(reservation.retainedSourceId){
   const proof=readPinnedRetainedIssuedSource(this.db,reservation.retainedSourceId).proof;
   const artifacts=proof.selectedCustody.package.agents.flatMap((a:Row)=>a.artifacts??[]);
   const expected=artifacts.map((a:Row)=>({sourceRef:a.ref,sha256:createHash('sha256').update(Buffer.from(a.dataBase64,'base64')).digest('hex'),byteLength:Buffer.from(a.dataBase64,'base64').length})).sort((a:Row,b:Row)=>a.sourceRef.localeCompare(b.sourceRef));
   const actual=stage.importPlan.artifacts.map(({destinationId,...a})=>a).sort((a,b)=>a.sourceRef.localeCompare(b.sourceRef));
   if(stableJson(actual)!==stableJson(expected)||Object.keys(stage.artifactMap).length)throw Error('Final working artifact receipt differs');
  }
  const d=reservation.destination,chat=this.db.prepare(`SELECT c.project_id FROM conversations c WHERE c.id=?
   AND NOT EXISTS(SELECT 1 FROM conversation_deletion_receipts r WHERE r.conversation_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM project_deletion_pending r WHERE r.project_id=c.project_id)`).get(d.conversationId) as Row|undefined;
  if(!chat||chat.project_id!==d.projectId)throw Error('Destination Chat unavailable');
  const members=this.db.prepare('SELECT agent_id FROM agent_creation_operation_members WHERE operation_id=? ORDER BY agent_id').all(stage.importPlan.creationOperationId) as {agent_id:string}[];
  if(stableJson(members.map(m=>m.agent_id))!==stableJson(unique(Object.values(stage.agentMap))))throw Error('Destination import member ownership changed');
  const liveIds=this.db.prepare('SELECT id FROM agents WHERE conversation_id=? AND deleted_at IS NULL ORDER BY id').all(d.conversationId) as {id:string}[];
  const chatMembers=this.db.prepare('SELECT agent_id FROM agent_conversation_memberships WHERE conversation_id=? ORDER BY agent_id').all(d.conversationId) as {agent_id:string}[];
  if(stableJson(liveIds.map(a=>a.id))!==stableJson(unique(Object.values(stage.agentMap)))||stableJson(chatMembers.map(a=>a.agent_id))!==stableJson(unique(Object.values(stage.agentMap))))throw Error('Destination organization membership is not closed');
  
  for(const id of Object.values(stage.agentMap)){
   const agent=this.db.prepare(`SELECT 1 FROM agents a WHERE a.id=? AND a.project_id=? AND a.conversation_id=? AND a.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM agent_deletion_pending p WHERE p.agent_id=a.id)
    AND EXISTS(SELECT 1 FROM agent_conversation_memberships m WHERE m.agent_id=a.id AND m.conversation_id=a.conversation_id)`).get(id,d.projectId,d.conversationId);
   if(!agent||this.db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? LIMIT 1").get(id,id)
    ||this.db.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending','attached')").get(id)
    ||this.db.prepare('SELECT 1 FROM coordination_requests WHERE requester_agent_id=? OR recipient_agent_id=?').get(id,id))throw Error('Destination participant must be fresh, idle and staged');

  }
  const op=this.db.prepare('SELECT project_id,conversation_id,kind,status,artifact_ids_json FROM agent_creation_operations WHERE id=?').get(stage.importPlan.creationOperationId) as Row|undefined;
  if(!op||op.project_id!==d.projectId||this.group&&op.conversation_id!==d.conversationId||op.kind!=='import'||!['preparing','canonical_committed'].includes(op.status))throw Error('Destination import has not reached its final admission transaction');
  return destinationDisclosurePolicy(this.db,reservation,stage);
 }
 private facts(cut:BranchHostCut,stage:CoordinationDestinationStage):CoordinationDestinationReview['facts'] {
  const facts:CoordinationDestinationReview['facts']=[];
  const add=(kind:CoordinationDestinationReview['facts'][number]['kind'],id:string,sha256:string,originalAgentIds:string[],originalAudience:unknown={kind:'request_participants',agentIds:originalAgentIds.filter(Boolean)},originalActor?:unknown,additionalOriginalRecipients:string[]=[])=>{
   const originals=unique(originalAgentIds.filter(Boolean)),destinations=unique([...originals,...additionalOriginalRecipients]).map(id=>{const mapped=stage.agentMap[id];if(!mapped)throw Error('Private fact audience lacks a destination mapping');return mapped;});
   if(destinations.some(id=>!id))throw Error('Private fact audience lacks a destination mapping');
   facts.push({kind,id,sha256,originalAgentIds:originals,destinationAgentIds:destinations,originalAudience,...(originalActor?{originalActor}:{})});
  };
  for(const {row:r,sha256} of cut.requests){
   const audience=[r.requester_agent_id,r.recipient_agent_id],joinRecipients=cut.joins.filter(j=>cut.members.some(m=>m.row.join_id===j.row.id&&m.row.request_id===r.id)||JSON.parse(j.row.continuation_request_ids_json).includes(r.id)).map(j=>j.row.owner_agent_id);add('request',r.id,sha256,audience,undefined,undefined,joinRecipients);
   for(const u of cut.updates.filter(e=>e.row.request_id===r.id))add('update',u.row.id,u.sha256,audience,undefined,{kind:u.row.actor_kind,id:u.row.actor_id},joinRecipients);
   if(r.communication_event_id){const c=cut.communications.find(e=>e.row.id===r.communication_event_id);if(!c)throw Error('Original private Communication unavailable');add('communication',c.row.id,c.sha256,audience,JSON.parse(c.row.audience_json),JSON.parse(c.row.sender_json),joinRecipients);}
  }
  for(const j of cut.joins)add('join',j.row.id,j.sha256,[j.row.owner_agent_id]);
  return facts;
 }
 /** Host-only human preview. No approval callback is bypassed to obtain this inventory;
  * this method cannot admit or grant anything. Caller must establish operator audit-read. */
 inspectDisclosure(admissionId:string,requireCustodyAndOwner:CoordinationDestinationAuthority['requireCustodyAndOwner'],now:string) {
  this.transaction();const row=this.row(admissionId);
  if(row.state!=='staged'||!row.stage_json)throw Error('Disclosure preview requires a staged destination');
  const {reservation,cut}=this.source(row),stage=JSON.parse(row.stage_json) as CoordinationDestinationStage;
  if(!nonempty(synchronous(requireCustodyAndOwner(reservation))))throw Error('Current custody/owner authority required');
  validateRetainedCoordinationGraph(cut,now);
  if(cut.artifactRefs.length||!reservation.retainedSourceId&&(stage.imports?Object.values(stage.imports).some(p=>p.artifacts.length):stage.importPlan.artifacts.length)||Object.keys(stage.artifactMap).length)throw Error('Disclosure preview supports no runtime artifacts');
  const policy=this.checkDestination(reservation,stage);
  return {review:{admissionId,reservation,stage,facts:[...this.facts(cut,stage),...destinationHistoricalFacts(readDestinationHistoricalPartition(this.db,reservation,stage,cut))]},policy};
 }
 private reviewed(row:Row,authority:CoordinationDestinationAuthority,now:string):CoordinationDestinationReview {
  if(row.state!=='staged'||!row.stage_json)throw Error('Destination explicit import map is not staged');
  const {reservation,cut}=this.source(row),stage=JSON.parse(row.stage_json) as CoordinationDestinationStage;
  const ownerRevision=synchronous(authority.requireCustodyAndOwner(reservation));
  if(!nonempty(ownerRevision))throw Error('Current custody/owner authority revision required');
  validateRetainedCoordinationGraph(cut,now);
  const policy=this.checkDestination(reservation,stage),facts=[...this.facts(cut,stage),...destinationHistoricalFacts(readDestinationHistoricalPartition(this.db,reservation,stage,cut))];
  const review={admissionId:row.id,reservation,stage,facts};
  const disclosureRevision=synchronous(authority.authorizeDisclosure(review));
  if(!nonempty(disclosureRevision))throw Error('Current human disclosure authority revision required');
  const artifacts=this.artifacts(cut,stage,reservation,authority);
  return {...review,disclosureRevision,reviewHash:payloadHash({review,disclosureRevision,ownerRevision,policy,artifacts})};
 }
 review(admissionId:string,authority:CoordinationDestinationAuthority,now:string):CoordinationDestinationReview {
  this.transaction();return this.reviewed(this.row(admissionId),authority,now);
 }
 private artifacts(cut:BranchHostCut,stage:CoordinationDestinationStage,reservation:CoordinationDestinationReservation,authority:CoordinationDestinationAuthority):RuntimeArtifactInputV3[] {
  return cut.artifactRefs.map(({row:source})=>{
   const update=cut.updates.find(e=>e.row.id===source.owner_id)?.row,request=cut.requests.find(e=>e.row.id===update?.request_id)?.row;
   if(!request)throw Error('Artifact owner is outside the retained Request graph');
   const resource=resourcesOf(reservation).find(r=>r.custody.sourceChatId===request.conversation_id);if(!resource)throw Error('Artifact resource mapping unavailable');
   const plan=stage.imports?.[resource.custody.sourceChatId]??stage.importPlan;
   const destinationId=stage.artifactMap[source.id];if(!destinationId)throw Error('Destination artifact mapping unavailable');
   const artifact=synchronous(authority.resolveArtifact({source,destinationId,importArtifactId:plan.artifacts.find(a=>a.sourceRef===source.id)!.destinationId,projectId:resource.destination.projectId,agentIds:this.facts(cut,stage).find(f=>f.kind==='update'&&f.id===source.owner_id)!.destinationAgentIds}));
   if(!runtimeArtifactMetadataIsValid(artifact)||artifact.id!==stage.artifactMap[source.id]||artifact.id===source.id||artifact.blobHash!==source.blob_hash||artifact.byteLength!==source.byte_length||artifact.role!==source.role||artifact.originAgentId||artifact.executionId)throw Error('Destination artifact lacks fresh authorized immutable content');
   if(this.db.prepare('SELECT 1 FROM runtime_artifacts WHERE id=?').get(artifact.id))throw Error('Destination artifact already has canonical ownership');
   return artifact;
  });
 }
 admit(admissionId:string,reviewHash:string,authority:CoordinationDestinationAuthority,compose:(graph:import('@ponderosa/core').BranchHostGraphRestoreDto)=>CoordinationDestinationOwnerReceipt|CoordinationDestinationOwnerReceipt[],now:string):CoordinationDestinationReceipt {
  this.transaction();return this.db.transaction(()=>this.admitInTransaction(admissionId,reviewHash,authority,compose,now))();
 }
 private admitInTransaction(admissionId:string,reviewHash:string,authority:CoordinationDestinationAuthority,compose:(graph:import('@ponderosa/core').BranchHostGraphRestoreDto)=>CoordinationDestinationOwnerReceipt|CoordinationDestinationOwnerReceipt[],now:string):CoordinationDestinationReceipt {
  this.transaction();const row=this.row(admissionId);
  if(row.state==='admitted')return this.read(admissionId,row.reservation_hash,authority,reviewHash);
  const review=this.reviewed(row,authority,now);
  if(!hashPattern.test(reviewHash)||reviewHash!==review.reviewHash)throw Error('Destination disclosure/policy changed; review again');
  const {reservation,cut}=this.source(row),stage=review.stage,pending:CreateActivationV3Input[]=[];
  const mapping={admissionId,...(reservation.retainedSourceId?{retainedSourceId:reservation.retainedSourceId}:{}),projectId:reservation.destination.projectId,conversationId:reservation.destination.conversationId,agentMap:stage.agentMap,artifactMap:stage.artifactMap,...(this.group?{conversationMap:Object.fromEntries(resourcesOf(reservation).map(r=>[r.custody.sourceChatId,r.destination.conversationId]))}:{})};
  const artifacts=this.artifacts(cut,stage,reservation,authority);
  const policySnapshot=()=>this.group?resourcesOf(reservation).map(r=>({sourceChatId:r.custody.sourceChatId,policy:destinationDisclosurePolicy(this.db,{...reservation,custody:r.custody,destination:r.destination},resourceStage(r,stage,cut))})):destinationDisclosurePolicy(this.db,reservation,stage);
  const beforePolicy=payloadHash(policySnapshot());
  const graph=writeRetainedCoordinationGraph(this.db,input=>{pending.push(input);return `staged:${pending.length}`;},reservation.branchId,reservation.sourceExecutionId,
   {checkpointId:reservation.checkpointId,expectedHash:reservation.checkpointHash,reviewHash,commandKey:`destination:${admissionId}`,reconcileEffects:true},cut,now,mapping);
  for(const [i,{row:source}] of cut.artifactRefs.entries()){
   const a=artifacts[i]!;
   this.db.prepare(`INSERT INTO runtime_artifacts(id,owner_kind,owner_id,project_id,role,title,media_type,blob_path,blob_hash,byte_length,created_at) VALUES(?,'request_update',?,?,?,?,?,?,?,?,?)`)
    .run(a.id,graph.updateMap[source.owner_id],mapping.projectId,a.role,a.title,a.mediaType,a.blobPath,a.blobHash,a.byteLength,now);
  }
  // Composer completes the real import and Branch owner-tree references before readiness/wakes.
  const composed=synchronous(compose(graph)),owners=Array.isArray(composed)?composed:[composed],resources=resourcesOf(reservation);
  if(Array.isArray(composed)!==this.group||owners.length!==resources.length||unique(owners.map(o=>o.resourceStepId)).length!==resources.length)throw Error('Exhaustive group owner receipts required');
  this.verifyOwners(owners,reservation,stage,cut,graph,admissionId);
  if(payloadHash(policySnapshot())!==beforePolicy||synchronous(authority.authorizeDisclosure({admissionId,reservation,stage,facts:review.facts}))!==review.disclosureRevision)throw Error('Composer changed reviewed policy or disclosure authority');
  if(stableJson(destinationHistoricalFacts(readDestinationHistoricalPartition(this.db,reservation,stage,cut)))!==stableJson(review.facts.filter(f=>f.kind==='historical_generation')))throw Error('Composer changed reviewed historical evidence');
  const historicalPartition=commitDestinationHistoricalPartition(this.db,admissionId,reservation,stage,cut,reviewHash);
  const owner=owners.find(o=>o.resourceStepId===reservation.destination.resourceStepId)!,d=reservation.destination;
  const receipt:CoordinationDestinationReceipt={...graph,admissionId,reservationHash:row.reservation_hash,stageHash:payloadHash(stage),reviewHash,destination:d,agentMap:stage.agentMap,artifactMap:stage.artifactMap,activationIds:[],owner,...(historicalPartition.length?{historicalPartition}:{}),...(this.group?{owners,resources:reservation.resources}: {})};
  this.db.prepare("UPDATE coordination_destination_admissions SET state='admitted',updated_at=? WHERE id=?").run(now,admissionId);
  for(const input of pending){if(Buffer.byteLength(stableJson(input.payload))>256_000)throw Error('Destination delivery exceeds bounded context');receipt.activationIds.push(this.deliver(input));}
  this.db.prepare('UPDATE coordination_destination_admissions SET receipt_json=? WHERE id=?').run(stableJson(receipt),admissionId);
  return receipt;
 }
 private verifyOwners(owners:CoordinationDestinationOwnerReceipt[],reservation:CoordinationDestinationReservation,stage:CoordinationDestinationStage,cut:BranchHostCut,graph:import('@ponderosa/core').BranchHostGraphRestoreDto,admissionId:string,audit=false):void {
  const resources=resourcesOf(reservation);
  if(owners.length!==resources.length||unique(owners.map(o=>o.resourceStepId)).length!==resources.length||owners.some(o=>!Array.isArray(o.requestBindings)))throw Error('Exact resource owner inventory required');
  const allBindings=owners.flatMap(o=>o.requestBindings);
  if(allBindings.length!==cut.roots.filter(r=>r.requestId).length||unique(allBindings.map(b=>b.sourceRequestId)).length!==allBindings.length)throw Error('Issued root bindings must be exhaustive and nonaliasing');
  for(const resourceInput of resources){
  const d=resourceInput.destination,owner=owners.find(o=>o.resourceStepId===d.resourceStepId);
  if(this.group){
  const sourceOwner=cut.resources.find(e=>e.row.step_execution_id===resourceInput.custody.intent.resourceStepId)?.row.execution_id;
  const retained=JSON.parse((this.db.prepare('SELECT snapshot_json FROM coordination_destination_admissions WHERE id=?').get(admissionId) as Row).snapshot_json);
  const branch=retainedBranchHostGraph(retained,reservation.sourceExecutionId,true,true).owners.find(o=>o.executionId===sourceOwner)?.branchId;
  const chat=this.db.prepare('SELECT project_id,branch_id,branch_execution_id AS execution_id FROM conversations WHERE id=?').get(d.conversationId) as Row|undefined;
  const execution=this.db.prepare('SELECT branch_id FROM branch_executions WHERE id=?').get(d.executionId) as Row|undefined;
  if(execution&&execution.branch_id!==branch)throw Error('Destination execution owner Branch differs');
  if((!audit||chat)&&(!chat||!execution||chat.project_id!==d.projectId||chat.branch_id!==branch||chat.execution_id!==d.executionId))throw Error('Destination resource owner Branch differs');
  }
  if(!owner)throw Error('Group resource owner receipt missing');
  const localStage=resourceStage(resourceInput,stage,cut),roots=cut.roots.filter(r=>cut.requests.find(e=>e.row.id===r.requestId)?.row.conversation_id===resourceInput.custody.sourceChatId);
  if(owner.executionId!==d.executionId||owner.resourceStepId!==d.resourceStepId||owner.resourceGeneration!==d.resourceGeneration||owner.creationOperationId!==localStage.importPlan.creationOperationId||!nonempty(owner.receiptId)
   ||!Array.isArray(owner.requestBindings)||owner.requestBindings.length!==roots.filter(r=>r.requestId).length||unique(owner.requestBindings.map(b=>b.sourceRequestId)).length!==roots.filter(r=>r.requestId).length
   ||roots.some(r=>r.requestId&&!owner.requestBindings.some(b=>b.sourceRequestId===r.requestId&&b.requestId===graph.requestMap[r.requestId!]&&nonempty(b.stepExecutionId)))
   ||(!audit||this.db.prepare('SELECT 1 FROM agent_creation_operations WHERE id=?').get(owner.creationOperationId))&&!this.db.prepare("SELECT 1 FROM agent_creation_operations WHERE id=? AND status='completed'").get(owner.creationOperationId))throw Error('Branch composer did not complete exact issued-step/import receipts');
  if(this.group&&(!audit||this.db.prepare('SELECT 1 FROM agent_creation_operations WHERE id=?').get(owner.creationOperationId))&&!this.db.prepare("SELECT 1 FROM agent_creation_operations WHERE id=? AND project_id=? AND conversation_id=? AND status='completed'").get(owner.creationOperationId,d.projectId,d.conversationId))throw Error('Group import ownership differs');
  for(const binding of owner.requestBindings){
   if((!audit||this.db.prepare('SELECT 1 FROM branch_step_executions WHERE id=?').get(binding.stepExecutionId))&&!this.db.prepare(`SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id
    WHERE a.request_id=? AND s.id=? AND s.execution_id=?`).get(binding.requestId,binding.stepExecutionId,d.executionId))throw Error('Branch issued-step reference was not persisted by composer');
  }
  const resource=this.db.prepare('SELECT execution_id,chat_id,generation,requested_count FROM branch_resources WHERE step_execution_id=?').get(d.resourceStepId) as Row|undefined;
  const resourceMembers=this.db.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(d.resourceStepId) as {agent_id:string}[];
  const command=this.db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(d.executionId,owner.receiptId) as Row|undefined;
  if(audit&&!resource&&resourceMembers.length)throw Error('Orphan group resource members');
  if((!audit||resource)&&(!resource||resource.execution_id!==d.executionId||resource.chat_id!==d.conversationId||resource.generation!==d.resourceGeneration||resource.requested_count!==Object.keys(localStage.agentMap).length
   ||stableJson(resourceMembers.map(m=>m.agent_id))!==stableJson(unique(Object.values(localStage.agentMap)))
    ))throw Error('Branch resource/owner command receipts were not persisted by composer');
  if((!audit||command)&&(!command||stableJson(JSON.parse(command.result_json).coordinationDestination)!==stableJson(graph)))throw Error('Branch owner command graph differs');
  }
 }
 /** Verify retained original group evidence without consulting or substituting live owner authority. */
 inspectGroupAudit(admissionId:string){
  if(!this.group)throw Error('Group audit reader required');
  const tombstone=this.db.prepare('SELECT evidence_json FROM coordination_destination_retirements WHERE admission_id=?').get(admissionId) as Row|undefined;
  const retirement=tombstone?new CoordinationV3DestinationReconciliation(this.db,true).read(admissionId):null;
  const archived=tombstone?JSON.parse(tombstone.evidence_json):undefined;
  const current=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(admissionId) as Row|undefined;
  const row=archived?.row??current;if(!row||current&&archived&&stableJson(current)!==stableJson(row))throw Error('Original group admission evidence unavailable or conflicting');
  const {reservation,cut}=this.source(row,'audit'),snapshot=JSON.parse(row.snapshot_json),resources=reservation.resources;
  if(!resources||resources.length<2||resources.length>32||row.id!==admissionId||row.branch_id!==reservation.branchId||row.source_execution_id!==reservation.sourceExecutionId||row.checkpoint_id!==reservation.checkpointId
   ||row.project_id!==reservation.destination.projectId||row.conversation_id!==reservation.destination.conversationId||reservation.operatorId!=='local-operator'
   ||snapshot.selected?.execution?.[0]?.id!==reservation.sourceExecutionId||snapshot.selected.execution[0].branch_id!==reservation.branchId
   ||unique(resources.map(r=>r.custody.sourceChatId)).length!==resources.length||unique(resources.map(r=>r.destination.conversationId)).length!==resources.length
   ||unique(resources.map(r=>r.destination.resourceStepId)).length!==resources.length||resources.some(r=>r.destination.projectId!==row.project_id)
   ||stableJson(resources[0])!==stableJson({custody:reservation.custody,destination:reservation.destination})
   ||snapshot.issuedGroupCustody?.length!==resources.length||resources.some(r=>!snapshot.issuedGroupCustody.some((c:Row)=>stableJson(c)===stableJson(r.custody))))throw Error('Original group audit resource inventory differs');
  const checkpoint=this.db.prepare('SELECT execution_id,snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=?').get(reservation.checkpointId) as Row|undefined;
  if(checkpoint&&(checkpoint.execution_id!==reservation.sourceExecutionId||checkpoint.content_hash!==reservation.checkpointHash||checkpoint.snapshot_json!==row.snapshot_json))throw Error('Original group checkpoint differs');
  const slots=(archived?.groupChats??this.db.prepare('SELECT admission_id,source_chat_id,source_execution_id,conversation_id,stage_json FROM coordination_destination_group_chats WHERE admission_id=? ORDER BY source_chat_id').all(admissionId)) as Row[];
  const expected=resources.map(r=>({admission_id:admissionId,source_chat_id:r.custody.sourceChatId,source_execution_id:r.custody.intent.executionId,conversation_id:r.destination.conversationId})).sort((a,b)=>a.source_chat_id<b.source_chat_id?-1:1);
  const slotIdentities=slots.map(({stage_json,...identity})=>identity);
  if(row.state==='admitted'&&!archived){
   if(new Set(slots.map(slot=>slot.source_chat_id)).size!==slots.length||slotIdentities.some(identity=>!expected.some(e=>stableJson(e)===stableJson(identity))))throw Error('Original group audit slots differ');
  }else if(stableJson(slotIdentities)!==stableJson(expected))throw Error('Original group audit slots differ');
  const stage=row.stage_json?JSON.parse(row.stage_json):null,agentMap:Record<string,string>={},imports:{sourceChatId:string;operationId:string;status:string|'absent'}[]=[];
  for(const resource of resources){
   const slot=slots.find(slot=>slot.source_chat_id===resource.custody.sourceChatId);
   // Admitted audit uses the retained canonical stage when a live slot was removed.
   const local=slot?(slot.stage_json?JSON.parse(slot.stage_json):null):stage&&row.state==='admitted'?resourceStage(resource,stage,cut):null;
   const chat=this.db.prepare('SELECT project_id,branch_id,branch_execution_id AS execution_id FROM conversations WHERE id=?').get(resource.destination.conversationId) as Row|undefined;
   const sourceOwner=retainedBranchHostGraph(snapshot,reservation.sourceExecutionId,true,true).owners.find(o=>o.executionId===resource.custody.intent.executionId);
   if(chat&&(chat.project_id!==resource.destination.projectId||chat.branch_id!==sourceOwner?.branchId||chat.execution_id!==resource.destination.executionId))throw Error('Original group audit Chat ownership differs');
   if(!local)continue;
   if((slot&&stableJson(local)!==slot.stage_json)||!exactKeys(local.agentMap,resource.custody.agentIds)||unique(Object.values(local.agentMap) as string[]).length!==resource.custody.agentIds.length
    ||local.importPlan?.projectId!==resource.destination.projectId||local.importPlan?.conversationId!==resource.destination.conversationId
    ||local.importPlan.agents.length!==resource.custody.agentIds.length||Object.values(local.agentMap).some(id=>resource.custody.agentIds.includes(id as string))
    ||stableJson(Object.fromEntries(local.importPlan.agents.map((a:Row)=>[a.sourceRef,a.agentId])))!==stableJson(local.agentMap)
    ||stage&&(stableJson(stage.imports?.[resource.custody.sourceChatId])!==stableJson(local.importPlan)||resource.custody.agentIds.some(id=>stage.agentMap[id]!==local.agentMap[id])))throw Error('Original group audit import map differs');
   for(const id of Object.values(local.agentMap)){
    const agent=this.db.prepare('SELECT project_id,conversation_id FROM agents WHERE id=?').get(id) as Row|undefined;
    if(agent&&(agent.project_id!==resource.destination.projectId||agent.conversation_id!==resource.destination.conversationId))throw Error('Original group audit Agent ownership differs');
   }
   Object.assign(agentMap,local.agentMap);
   const op=this.db.prepare('SELECT project_id,conversation_id,status FROM agent_creation_operations WHERE id=?').get(local.importPlan.creationOperationId) as Row|undefined;
   if(op&&(op.project_id!==resource.destination.projectId||op.conversation_id!==resource.destination.conversationId))throw Error('Original group audit import ownership differs');
   imports.push({sourceChatId:resource.custody.sourceChatId,operationId:local.importPlan.creationOperationId,status:op?.status??'absent'});
  }
  const members=(archived?.members??this.db.prepare('SELECT * FROM coordination_destination_members WHERE admission_id=? ORDER BY agent_id').all(admissionId)) as Row[];
  const expectedMembers=Object.entries(agentMap).map(([source_agent_id,agent_id])=>({admission_id:admissionId,source_agent_id,agent_id})).sort((a,b)=>a.agent_id<b.agent_id?-1:1);
  if(stableJson(members)!==stableJson(expectedMembers))throw Error('Original group audit participant map differs');
  if(stage&&(!exactKeys(stage.imports,resources.map(r=>r.custody.sourceChatId))||stableJson(stage.importPlan)!==stableJson(stage.imports[reservation.custody.sourceChatId])))throw Error('Original group audit complete import map differs');
  if(unique(Object.values(agentMap)).length!==Object.keys(agentMap).length||stage&&stableJson(stage.agentMap)!==stableJson(agentMap))throw Error('Original group audit full Agent map differs');
  const receipt=!retirement&&row.state==='admitted'?this.readGroupAudit(admissionId,row.reservation_hash):null;
  return {reservation,reservationHash:row.reservation_hash,state:retirement?'retired':row.state,agentMap,imports,receipt,retirement,sourceIds:unique((snapshot.continuation?.schema==='ponderosa.branch.script-tree-continuation.v1'?snapshot.continuation.owners.map((o:Row)=>o.selected):[snapshot.selected]).flatMap((selected:Row)=>branchContinuationIds(selected))),snapshotSha256:payloadHash(snapshot),evidenceSha256:payloadHash({row,slots,retirement})};
 }
 /** Operator-retained evidence only. Never used by admission/replay or current disclosure reads. */
 readGroupAudit(admissionId:string,reservationHash:string):import('@ponderosa/core').CoordinationDestinationGroupReceipt {
  if(!this.group)throw Error('Group audit reader required');
  return this.db.transaction(()=>this.readInTransaction(admissionId,reservationHash,undefined,undefined,true))() as import('@ponderosa/core').CoordinationDestinationGroupReceipt;
 }
 /** Exact terminal retained receipt only; operator audit access grants no live admission. */
 readRetainedFinalAudit(admissionId:string,reservationHash:string,authorize:(reservation:CoordinationDestinationReservation)=>string):CoordinationDestinationReceipt {
  return this.db.transaction(()=>{
   const row=this.row(admissionId),{reservation}=this.source(row,'audit'),d=reservation.destination;
   const owner=this.db.prepare('SELECT branch_id,state FROM branch_executions WHERE id=?').get(d.executionId) as Row|undefined;
   const resource=this.db.prepare('SELECT execution_id,chat_id,state,generation FROM branch_resources WHERE step_execution_id=?').get(d.resourceStepId) as Row|undefined;
   if(this.group||!reservation.retainedSourceId||owner?.branch_id!==reservation.branchId||owner.state!=='completed'
    ||resource?.execution_id!==d.executionId||resource.chat_id!==d.conversationId||resource.generation!==0||resource.state!=='retired'
    ||!nonempty(synchronous(authorize(reservation))))throw Error('Terminal retained destination operator audit unavailable');
   const receipt=this.readInTransaction(admissionId,reservationHash,undefined,undefined,true);
   if(receipt.activationIds.length)throw Error('Terminal retained audit cannot represent replayed work');
   return {...receipt,replayed:true};
  })();
 }
 read(admissionId:string,reservationHash:string,authority:CoordinationDestinationAuthority,expectedReviewHash?:string):CoordinationDestinationReceipt {
  return this.db.transaction(()=>this.readInTransaction(admissionId,reservationHash,authority,expectedReviewHash))();
 }
 private readInTransaction(admissionId:string,reservationHash:string,authority:CoordinationDestinationAuthority|undefined,expectedReviewHash?:string,audit=false):CoordinationDestinationReceipt {
  const row=this.row(admissionId);
  if(row.reservation_hash!==reservationHash||row.state!=='admitted'||!row.receipt_json)throw Error('Exact committed destination receipt unavailable');
  const receipt=JSON.parse(row.receipt_json) as CoordinationDestinationReceipt,{reservation,cut}=this.source(row,audit?'audit':'current'),stage=JSON.parse(row.stage_json) as CoordinationDestinationStage;
  if(audit&&(stableJson(receipt)!==row.receipt_json||stableJson(stage)!==row.stage_json))throw Error('Noncanonical retained group receipt/stage');
  if(expectedReviewHash&&expectedReviewHash!==receipt.reviewHash)throw Error('Destination admission replay review conflict');
  // Readback needs current disclosure permission, not surviving original objects or retained package bytes.
  verifyDestinationHistoricalPartition(this.db,admissionId,reservation,stage,cut,receipt);
  const facts=[...this.facts(cut,stage),...destinationHistoricalFacts(readDestinationHistoricalPartition(this.db,reservation,stage,cut,admissionId))];
  if(!audit&&(!authority||!nonempty(synchronous(authority.authorizeDisclosure({admissionId,reservation,stage,facts})))))throw Error('Current receipt disclosure authority required');
  if(receipt.admissionId!==admissionId||receipt.checkpointHash!==reservation.checkpointHash||receipt.checkpointId!==reservation.checkpointId||stableJson(receipt.destination)!==stableJson(reservation.destination)||receipt.reservationHash!==reservationHash||receipt.stageHash!==payloadHash(stage)||stableJson(receipt.agentMap)!==stableJson(stage.agentMap)||stableJson(receipt.artifactMap)!==stableJson(stage.artifactMap))throw Error('Destination receipt map differs');
  const canonical=this.db.prepare('SELECT receipt_json FROM coordination_cut_restorations WHERE id=?').get(receipt.restorationId) as Row|undefined;
  if(!canonical)throw Error('Destination graph receipt unavailable');
  const graph=JSON.parse(canonical.receipt_json);
  for(const [field,records] of [['requestMap',cut.requests],['updateMap',cut.updates],['joinMap',cut.joins]] as const){
   const map=receipt[field];
   if(!exactKeys(map,records.map(e=>e.row.id))||unique(Object.values(map)).length!==records.length||stableJson(map)!==stableJson(graph[field]))throw Error('Destination canonical graph map differs');
  }
  if(graph.destination?.admissionId!==admissionId||graph.destination.projectId!==reservation.destination.projectId||stableJson(graph.destination.agentMap)!==stableJson(stage.agentMap)||stableJson(graph.destination.artifactMap)!==stableJson(stage.artifactMap)||resourcesOf(reservation).some(r=>{const id=(stage.imports?.[r.custody.sourceChatId]??stage.importPlan).creationOperationId;return (!audit||this.db.prepare('SELECT 1 FROM agent_creation_operations WHERE id=?').get(id))&&!this.db.prepare("SELECT 1 FROM agent_creation_operations WHERE id=? AND status='completed'").get(id);}))throw Error('Destination owner/import readback unavailable');
  for(const {row:r} of cut.requests){
   const fresh=this.db.prepare('SELECT * FROM coordination_requests WHERE id=?').get(receipt.requestMap[r.id]) as Row|undefined;
   if(audit&&!fresh)continue;
   if(!fresh||fresh.project_id!==reservation.destination.projectId||fresh.conversation_id!==(graph.destination.conversationMap?.[r.conversation_id]??reservation.destination.conversationId)||fresh.requester_agent_id!==(r.requester_agent_id?stage.agentMap[r.requester_agent_id]:null)||fresh.recipient_agent_id!==stage.agentMap[r.recipient_agent_id]||fresh.version<r.version)throw Error('Destination Request receipt scope differs');
   const payload=JSON.parse(fresh.payload_json);
   if(payload.destinationAdmissionId!==admissionId||stableJson(payload.historicalPayload)!==r.payload_json||stableJson(payload.historicalOrigin)!==stableJson({restorationId:receipt.restorationId,sourceRequestId:r.id,historical:true})
    ||fresh.version===r.version&&(fresh.open_question_update_id??null)!==(r.open_question_update_id?receipt.updateMap[r.open_question_update_id]:null))throw Error('Destination Request historical prefix differs');
  }
  for(const {row:u} of cut.updates){const fresh=this.db.prepare('SELECT * FROM coordination_request_updates WHERE id=?').get(receipt.updateMap[u.id]) as Row|undefined;if(audit&&!fresh)continue;if(!fresh)throw Error('Destination historical update unavailable');restoredRequestUpdatePayload(this.db,fresh);}
  for(const {row:a} of cut.artifactRefs){
   const fresh=this.db.prepare('SELECT * FROM runtime_artifacts WHERE id=?').get(stage.artifactMap[a.id]) as Row|undefined;
   if(audit&&!fresh)continue;
   if(!fresh||fresh.owner_kind!=='request_update'||fresh.owner_id!==receipt.updateMap[a.owner_id]||fresh.project_id!==reservation.destination.projectId||fresh.blob_hash!==a.blob_hash||fresh.byte_length!==a.byte_length||fresh.role!==a.role)throw Error('Destination artifact receipt ownership/content differs');
  }
  for(const {row:j} of cut.joins){
   const fresh=this.db.prepare('SELECT * FROM coordination_joins WHERE id=?').get(receipt.joinMap[j.id]) as Row|undefined;
   const members=this.db.prepare('SELECT request_id,position FROM coordination_join_members WHERE join_id=? ORDER BY position').all(receipt.joinMap[j.id]);
   const expected=cut.members.filter(e=>e.row.join_id===j.id).map(e=>({request_id:receipt.requestMap[e.row.request_id],position:e.row.position})).sort((a,b)=>a.position-b.position);
   if(audit&&!fresh){if(members.length)throw Error('Orphan destination Join members');continue;}
   if(!fresh||fresh.project_id!==reservation.destination.projectId||fresh.owner_agent_id!==stage.agentMap[j.owner_agent_id]||fresh.conversation_id!==(graph.destination.conversationMap?.[j.conversation_id]??reservation.destination.conversationId)
    ||fresh.continuation_request_ids_json!==stableJson(JSON.parse(j.continuation_request_ids_json).map((id:string)=>receipt.requestMap[id]))||stableJson(members)!==stableJson(expected))throw Error('Destination Join receipt differs');
  }
  for(const {row:s} of cut.suspensions){
   if((!audit||this.db.prepare('SELECT 1 FROM coordination_question_suspensions WHERE question_update_id=? AND request_id=?').get(receipt.updateMap[s.question_update_id],receipt.requestMap[s.request_id]))&&!this.db.prepare(`SELECT 1 FROM coordination_question_suspensions WHERE question_update_id=? AND request_id=? AND owner_agent_id=? AND dependency_kind='join' AND dependency_id=?`)
    .get(receipt.updateMap[s.question_update_id],receipt.requestMap[s.request_id],stage.agentMap[s.owner_agent_id],receipt.joinMap[s.dependency_id]))throw Error('Destination suspension receipt differs');
  }
  if(this.group&&(stableJson((receipt as import('@ponderosa/core').CoordinationDestinationGroupReceipt).resources)!==stableJson(reservation.resources)
    ||stableJson(graph.destination.conversationMap)!==stableJson(Object.fromEntries(resourcesOf(reservation).map(r=>[r.custody.sourceChatId,r.destination.conversationId])))))throw Error('Destination group receipt inventory differs');
  const owners=receipt.owners??[receipt.owner];
  this.verifyOwners(owners,reservation,stage,cut,graph,admissionId,audit);
  if(stableJson(receipt.owner)!==stableJson(owners.find(o=>o.resourceStepId===reservation.destination.resourceStepId)))throw Error('Anchored owner receipt differs');
  for(const id of receipt.activationIds){
   const activation=this.db.prepare('SELECT * FROM agent_activations WHERE id=?').get(id) as Row|undefined;
   if(audit&&!activation)continue;
   if(!activation||activation.project_id!==reservation.destination.projectId||!Object.values(stage.agentMap).includes(activation.agent_id)||!resourcesOf(reservation).some(r=>activation.scope_key===`conversation:${r.destination.conversationId}`&&r.custody.agentIds.some(source=>stage.agentMap[source]===activation.agent_id)))throw Error('Destination activation receipt unavailable');
   const payload=JSON.parse(activation.payload_json),source=payload.updateId?['request_update',payload.updateId]:payload.joinId?['join',payload.joinId]:['request',payload.requestId];
   if(!this.db.prepare('SELECT 1 FROM activation_sources WHERE activation_id=? AND source_kind=? AND source_id=?').get(id,...source))throw Error('Destination activation lineage differs');
  }
  return audit?receipt:{...receipt,replayed:true};
 }
}
