import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
 CoordinationDestinationReservation,CoordinationDestinationStage,CoordinationDestinationReview,
 CoordinationDestinationReceipt,CoordinationDestinationOwnerReceipt,
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
const hashPattern=/^[a-f0-9]{64}$/;
const synchronous=<T>(value:T):T=>{if(value&&typeof value==='object'&&'then' in value)throw Error('Destination admission requires synchronous authority and composition');return value;};
const unique=(ids:string[])=>[...new Set(ids)].sort();
const exactKeys=(map:Record<string,string>,ids:string[])=>stableJson(Object.keys(map).sort())===stableJson(unique(ids));
const nonempty=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=512;

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
 constructor(private readonly db:Database.Database,private readonly deliver:(input:CreateActivationV3Input)=>string){}
 private transaction():void {if(!this.db.inTransaction)throw Error('Destination admission requires the same Branch owner transaction');}
 private row(id:string):Row {
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(id) as Row|undefined;
  if(!row)throw Error('Destination admission unavailable');return row;
 }
 private source(row:Row):{reservation:CoordinationDestinationReservation;cut:BranchHostCut} {
  const reservation=JSON.parse(row.reservation_json) as CoordinationDestinationReservation,snapshot=JSON.parse(row.snapshot_json);
  if(stableJson(reservation)!==row.reservation_json||payloadHash(reservation)!==row.reservation_hash
    ||stableJson(snapshot)!==row.snapshot_json||payloadHash(snapshot)!==reservation.checkpointHash)throw Error('Destination retained evidence differs');
  const {cut}=retainedBranchHostGraph(snapshot,reservation.sourceExecutionId,true,true);
  if(!verifyBranchHostCut(cut,reservation.sourceExecutionId)||!cut.coverage.complete)throw Error('Destination retained cut is incomplete');
  verifyHostProvenance(cut);return {reservation,cut};
 }
 reserve(input:CoordinationDestinationReservation,authority:CoordinationDestinationAuthority,now:string):{admissionId:string;state:string} {
  this.transaction();return this.db.transaction(()=>this.reserveInTransaction(input,authority,now))();
 }
 private reserveInTransaction(input:CoordinationDestinationReservation,authority:CoordinationDestinationAuthority,now:string):{admissionId:string;state:string} {
  this.transaction();input=JSON.parse(stableJson(input));
  if(![input.branchId,input.sourceExecutionId,input.commandKey,input.operatorId,input.destination?.projectId,input.destination?.conversationId,input.destination?.executionId,input.destination?.resourceStepId].every(nonempty)
   ||input.reconcileEffects!==true||!Number.isSafeInteger(input.checkpointId)||input.checkpointId<1||!hashPattern.test(input.checkpointHash)
   ||!Number.isSafeInteger(input.destination.resourceGeneration)||input.destination.resourceGeneration<0
   ||input.custody?.version!==1||!hashPattern.test(input.custody.sha256)||!hashPattern.test(input.custody.custodyId)
   ||!nonempty(input.custody.boundaryId)||!Number.isSafeInteger(input.custody.byteLength)||input.custody.byteLength<1
   ||!Array.isArray(input.custody.agentIds)||input.custody.agentIds.length<1||input.custody.agentIds.length>128
   ||input.custody.agentIds.some(id=>!nonempty(id))||unique(input.custody.agentIds).length!==input.custody.agentIds.length
   ||!nonempty(input.custody.intent.executionId))throw Error('Invalid destination reservation');
  const prior=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE branch_id=? AND command_key=?').get(input.branchId,input.commandKey) as Row|undefined;
  if(prior){if(prior.reservation_hash!==payloadHash(input)||prior.reservation_json!==stableJson(input))throw Error('Destination command input conflict');return {admissionId:prior.id,state:prior.state};}
  if(!nonempty(synchronous(authority.requireCustodyAndOwner(input))))throw Error('Current custody/owner authority revision required');
  const saved=this.db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(input.checkpointId,input.sourceExecutionId) as Row|undefined;
  const execution=this.db.prepare('SELECT branch_id,state FROM branch_executions WHERE id=?').get(input.sourceExecutionId) as Row|undefined;
  if(!saved||saved.content_hash!==input.checkpointHash||execution?.branch_id!==input.branchId||!['completed','failed','canceled'].includes(execution.state))throw Error('Source owner must settle before destination reservation');
  // Reserve BEFORE the fresh Chat exists. A failed import never releases the hold implicitly.
  if(this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(input.destination.conversationId)
    ||this.db.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(input.destination.projectId))throw Error('Reserve a fresh destination Chat identity before creation');
  const row={reservation_json:stableJson(input),reservation_hash:payloadHash(input),snapshot_json:saved.snapshot_json};
  const {cut}=this.source(row);
  if(cut.requests.some(e=>e.row.conversation_id!==input.custody.sourceChatId)
   ||cut.joins.some(e=>e.row.conversation_id!==input.custody.sourceChatId)
   ||cut.resources.length!==1||cut.resources[0]?.row.chat_id!==input.custody.sourceChatId)throw Error('Only one captured resource organization scope is admitted');
  const resource=cut.resources.find(e=>e.row.chat_id===input.custody.sourceChatId)!.row;
  if(resource.step_execution_id!==input.custody.intent.resourceStepId||resource.generation!==input.custody.intent.resourceGeneration)throw Error('Custody resource generation differs from the host cut');
  const snapshot=JSON.parse(saved.snapshot_json),selected=snapshot.continuation?.schema==='ponderosa.branch.script-tree-continuation.v1'
    ?snapshot.continuation.owners.find((o:Row)=>o.executionId===input.custody.intent.executionId)?.selected:snapshot.selected;
  const {version,custodyId,boundaryId,sha256,byteLength,...source}=input.custody;
  if(!selected||!receiptMatchesSource(input.custody,source)||source.intent.frontierSha256!==resourceCaptureFrontierHash(selected)
    ||selected.execution?.[0]?.id!==source.intent.executionId||source.intent.bindingSha256!==(snapshot.continuation?.schema==='ponderosa.branch.script-tree-continuation.v1'?snapshot.continuation.owners.find((o:Row)=>o.executionId===source.intent.executionId)?.bindingHash:cut.bindingPin.sha256))throw Error('Custody is not the exact selected host frontier');
  if(!cut.requests.length||!cut.roots.some(r=>r.requestId)||cut.bindingPin.requiredSecretRefs.length)throw Error('Issued nonsecret host Request frontier required');
  validateRetainedCoordinationGraph(cut,now);
  for(const {row:r} of cut.requests){
   const live=this.db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(r.id) as Row|undefined;
   if(live&&(!TERMINAL_REQUEST_STATES.has(live.state)||live.state==='outcome_unknown'))throw Error('Original Request effects must settle before fresh admission');
   for(const id of [r.requester_agent_id,r.recipient_agent_id].filter(Boolean))if(this.db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? LIMIT 1").get(id,id))throw Error('Original participant runtime must drain');
  }
  const admissionId=randomUUID();
  this.db.prepare(`INSERT INTO coordination_destination_admissions(id,branch_id,source_execution_id,checkpoint_id,command_key,reservation_hash,reservation_json,snapshot_json,project_id,conversation_id,state,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(admissionId,input.branchId,input.sourceExecutionId,input.checkpointId,input.commandKey,row.reservation_hash,row.reservation_json,row.snapshot_json,input.destination.projectId,input.destination.conversationId,now,now);
  return {admissionId,state:'reserved'};
 }
 stage(admissionId:string,input:CoordinationDestinationStage,now:string):void {
  this.transaction();return this.db.transaction(()=>this.stageInTransaction(admissionId,input,now))();
 }
 private stageInTransaction(admissionId:string,input:CoordinationDestinationStage,now:string):void {
  this.transaction();input=JSON.parse(stableJson(input));const row=this.row(admissionId),{reservation,cut}=this.source(row),plan=input.importPlan;
  if(row.stage_json){if(row.stage_json!==stableJson(input))throw Error('Destination import map conflict');return;}
  if(row.state!=='reserved'||!plan||plan.projectId!==reservation.destination.projectId||plan.conversationId!==reservation.destination.conversationId||!nonempty(plan.creationOperationId))throw Error('Destination import reservation differs');
  const op=this.db.prepare('SELECT project_id,kind,status FROM agent_creation_operations WHERE id=?').get(plan.creationOperationId) as Row|undefined;
  if(!op||op.project_id!==plan.projectId||op.kind!=='import'||!['preparing','canonical_committed'].includes(op.status))throw Error('Destination import is not staged');
  if(!exactKeys(input.agentMap,reservation.custody.agentIds)||!Array.isArray(plan.agents)||plan.agents.length!==reservation.custody.agentIds.length
    ||unique(plan.agents.map(a=>a.sourceRef)).length!==plan.agents.length||unique(Object.values(input.agentMap)).length!==plan.agents.length
    ||plan.agents.some(a=>!nonempty(a.agentId)||input.agentMap[a.sourceRef]!==a.agentId||reservation.custody.agentIds.includes(a.agentId)))throw Error('Explicit source-ref destination Agent map required');
  const members=this.db.prepare('SELECT agent_id FROM agent_creation_operation_members WHERE operation_id=? ORDER BY agent_id').all(plan.creationOperationId) as {agent_id:string}[];
  if(stableJson(members.map(m=>m.agent_id))!==stableJson(unique(plan.agents.map(a=>a.agentId))))throw Error('Import member receipt differs from explicit map');
  const participants=unique([...cut.requests.flatMap(e=>[e.row.requester_agent_id,e.row.recipient_agent_id]),...cut.joins.map(e=>e.row.owner_agent_id),...cut.suspensions.map(e=>e.row.owner_agent_id)].filter(Boolean));
  if(participants.some(id=>!input.agentMap[id]))throw Error('Every historical participant needs an explicit fresh imported destination');
  if(!exactKeys(input.artifactMap,cut.artifactRefs.map(e=>e.row.id))||unique(Object.values(input.artifactMap)).length!==cut.artifactRefs.length)throw Error('Exhaustive fresh artifact map required');
  if(!Array.isArray(plan.artifacts)||new Set(plan.artifacts.map(a=>a.sourceRef)).size!==plan.artifacts.length)throw Error('Invalid import artifact inventory');
  if(cut.artifactRefs.some(({row:a})=>a.owner_kind!=='request_update'))throw Error('Communication-owned artifact restoration requires a separate evidence publication operation');
  for(const {row:a} of cut.artifactRefs){const imported=plan.artifacts.find(p=>p.sourceRef===a.id);
   if(!imported||!nonempty(imported.destinationId)||imported.sha256!==a.blob_hash||imported.byteLength!==a.byte_length)throw Error('Artifact map differs from actual import receipt');
  }
  for(const agent of plan.agents){
   if(this.db.prepare('SELECT 1 FROM agents WHERE id=?').get(agent.agentId)||this.db.prepare('SELECT 1 FROM scheduler_runs WHERE agent_id=?').get(agent.agentId))throw Error('Stage import map before creating fresh Agents');
   this.db.prepare('INSERT INTO coordination_destination_members VALUES(?,?,?)').run(admissionId,agent.sourceRef,agent.agentId);
  }
  this.db.prepare("UPDATE coordination_destination_admissions SET stage_json=?,state='staged',updated_at=? WHERE id=?").run(stableJson(input),now,admissionId);
 }
 private checkDestination(reservation:CoordinationDestinationReservation,stage:CoordinationDestinationStage):unknown {
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
  const op=this.db.prepare('SELECT project_id,kind,status,artifact_ids_json FROM agent_creation_operations WHERE id=?').get(stage.importPlan.creationOperationId) as Row|undefined;
  if(!op||op.project_id!==d.projectId||op.kind!=='import'||!['preparing','canonical_committed'].includes(op.status))throw Error('Destination import has not reached its final admission transaction');
  return destinationDisclosurePolicy(this.db,reservation,stage);
 }
 private facts(cut:BranchHostCut,stage:CoordinationDestinationStage):CoordinationDestinationReview['facts'] {
  const facts:CoordinationDestinationReview['facts']=[];
  const add=(kind:CoordinationDestinationReview['facts'][number]['kind'],id:string,sha256:string,originalAgentIds:string[],originalAudience:unknown={kind:'request_participants',agentIds:originalAgentIds.filter(Boolean)},originalActor?:unknown)=>{
   const originals=unique(originalAgentIds.filter(Boolean)),destinations=originals.map(id=>stage.agentMap[id]);
   if(destinations.some(id=>!id))throw Error('Private fact audience lacks a destination mapping');
   facts.push({kind,id,sha256,originalAgentIds:originals,destinationAgentIds:destinations,originalAudience,...(originalActor?{originalActor}:{})});
  };
  for(const {row:r,sha256} of cut.requests){
   const audience=[r.requester_agent_id,r.recipient_agent_id];add('request',r.id,sha256,audience);
   for(const u of cut.updates.filter(e=>e.row.request_id===r.id))add('update',u.row.id,u.sha256,audience,undefined,{kind:u.row.actor_kind,id:u.row.actor_id});
   if(r.communication_event_id){const c=cut.communications.find(e=>e.row.id===r.communication_event_id);if(!c)throw Error('Original private Communication unavailable');add('communication',c.row.id,c.sha256,audience,JSON.parse(c.row.audience_json),JSON.parse(c.row.sender_json));}
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
  if(cut.artifactRefs.length||stage.importPlan.artifacts.length||Object.keys(stage.artifactMap).length)throw Error('Disclosure preview supports no runtime artifacts');
  const policy=this.checkDestination(reservation,stage);
  return {review:{admissionId,reservation,stage,facts:this.facts(cut,stage)},policy};
 }
 private reviewed(row:Row,authority:CoordinationDestinationAuthority,now:string):CoordinationDestinationReview {
  if(row.state!=='staged'||!row.stage_json)throw Error('Destination explicit import map is not staged');
  const {reservation,cut}=this.source(row),stage=JSON.parse(row.stage_json) as CoordinationDestinationStage;
  const ownerRevision=synchronous(authority.requireCustodyAndOwner(reservation));
  if(!nonempty(ownerRevision))throw Error('Current custody/owner authority revision required');
  validateRetainedCoordinationGraph(cut,now);
  const policy=this.checkDestination(reservation,stage),facts=this.facts(cut,stage);
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
   const artifact=synchronous(authority.resolveArtifact({source,destinationId:stage.artifactMap[source.id],importArtifactId:stage.importPlan.artifacts.find(a=>a.sourceRef===source.id)!.destinationId,projectId:reservation.destination.projectId,agentIds:[request.requester_agent_id,request.recipient_agent_id].filter(Boolean).map(id=>stage.agentMap[id])}));
   if(!runtimeArtifactMetadataIsValid(artifact)||artifact.id!==stage.artifactMap[source.id]||artifact.id===source.id||artifact.blobHash!==source.blob_hash||artifact.byteLength!==source.byte_length||artifact.role!==source.role||artifact.originAgentId||artifact.executionId)throw Error('Destination artifact lacks fresh authorized immutable content');
   if(this.db.prepare('SELECT 1 FROM runtime_artifacts WHERE id=?').get(artifact.id))throw Error('Destination artifact already has canonical ownership');
   return artifact;
  });
 }
 admit(admissionId:string,reviewHash:string,authority:CoordinationDestinationAuthority,compose:(graph:import('@ponderosa/core').BranchHostGraphRestoreDto)=>CoordinationDestinationOwnerReceipt,now:string):CoordinationDestinationReceipt {
  this.transaction();return this.db.transaction(()=>this.admitInTransaction(admissionId,reviewHash,authority,compose,now))();
 }
 private admitInTransaction(admissionId:string,reviewHash:string,authority:CoordinationDestinationAuthority,compose:(graph:import('@ponderosa/core').BranchHostGraphRestoreDto)=>CoordinationDestinationOwnerReceipt,now:string):CoordinationDestinationReceipt {
  this.transaction();const row=this.row(admissionId);
  if(row.state==='admitted')return this.read(admissionId,row.reservation_hash,authority,reviewHash);
  const review=this.reviewed(row,authority,now);
  if(!hashPattern.test(reviewHash)||reviewHash!==review.reviewHash)throw Error('Destination disclosure/policy changed; review again');
  const {reservation,cut}=this.source(row),stage=review.stage,pending:CreateActivationV3Input[]=[];
  const mapping={admissionId,projectId:reservation.destination.projectId,conversationId:reservation.destination.conversationId,agentMap:stage.agentMap,artifactMap:stage.artifactMap};
  const artifacts=this.artifacts(cut,stage,reservation,authority);
  const graph=writeRetainedCoordinationGraph(this.db,input=>{pending.push(input);return `staged:${pending.length}`;},reservation.branchId,reservation.sourceExecutionId,
   {checkpointId:reservation.checkpointId,expectedHash:reservation.checkpointHash,reviewHash,commandKey:`destination:${admissionId}`,reconcileEffects:true},cut,now,mapping);
  for(const [i,{row:source}] of cut.artifactRefs.entries()){
   const a=artifacts[i]!;
   this.db.prepare(`INSERT INTO runtime_artifacts(id,owner_kind,owner_id,project_id,role,title,media_type,blob_path,blob_hash,byte_length,created_at) VALUES(?,'request_update',?,?,?,?,?,?,?,?,?)`)
    .run(a.id,graph.updateMap[source.owner_id],mapping.projectId,a.role,a.title,a.mediaType,a.blobPath,a.blobHash,a.byteLength,now);
  }
  // Composer completes the real import and Branch owner-tree references before readiness/wakes.
  const owner=synchronous(compose(graph)),d=reservation.destination;
  if(owner.executionId!==d.executionId||owner.resourceStepId!==d.resourceStepId||owner.resourceGeneration!==d.resourceGeneration||owner.creationOperationId!==stage.importPlan.creationOperationId||!nonempty(owner.receiptId)
   ||!Array.isArray(owner.requestBindings)||owner.requestBindings.length!==cut.roots.filter(r=>r.requestId).length||unique(owner.requestBindings.map(b=>b.sourceRequestId)).length!==cut.roots.filter(r=>r.requestId).length
   ||cut.roots.some(r=>r.requestId&&!owner.requestBindings.some(b=>b.sourceRequestId===r.requestId&&b.requestId===graph.requestMap[r.requestId!]&&nonempty(b.stepExecutionId)))
   ||!this.db.prepare("SELECT 1 FROM agent_creation_operations WHERE id=? AND status='completed'").get(owner.creationOperationId))throw Error('Branch composer did not complete exact issued-step/import receipts');
  for(const binding of owner.requestBindings){
   if(!this.db.prepare(`SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id
    WHERE a.request_id=? AND s.id=? AND s.execution_id=?`).get(binding.requestId,binding.stepExecutionId,d.executionId))throw Error('Branch issued-step reference was not persisted by composer');
  }
  const resource=this.db.prepare('SELECT execution_id,chat_id,generation,requested_count FROM branch_resources WHERE step_execution_id=?').get(d.resourceStepId) as Row|undefined;
  const resourceMembers=this.db.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(d.resourceStepId) as {agent_id:string}[];
  const command=this.db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(d.executionId,owner.receiptId) as Row|undefined;
  if(!resource||resource.execution_id!==d.executionId||resource.chat_id!==d.conversationId||resource.generation!==d.resourceGeneration||resource.requested_count!==Object.keys(stage.agentMap).length
   ||stableJson(resourceMembers.map(m=>m.agent_id))!==stableJson(unique(Object.values(stage.agentMap)))
   ||!command||stableJson(JSON.parse(command.result_json).coordinationDestination)!==stableJson(graph))throw Error('Branch resource/owner command receipts were not persisted by composer');
  const receipt:CoordinationDestinationReceipt={...graph,admissionId,reservationHash:row.reservation_hash,stageHash:payloadHash(stage),reviewHash,destination:d,agentMap:stage.agentMap,artifactMap:stage.artifactMap,activationIds:[],owner};
  this.db.prepare("UPDATE coordination_destination_admissions SET state='admitted',updated_at=? WHERE id=?").run(now,admissionId);
  for(const input of pending){if(Buffer.byteLength(stableJson(input.payload))>256_000)throw Error('Destination delivery exceeds bounded context');receipt.activationIds.push(this.deliver(input));}
  this.db.prepare('UPDATE coordination_destination_admissions SET receipt_json=? WHERE id=?').run(stableJson(receipt),admissionId);
  return receipt;
 }
 read(admissionId:string,reservationHash:string,authority:CoordinationDestinationAuthority,expectedReviewHash?:string):CoordinationDestinationReceipt {
  return this.db.transaction(()=>this.readInTransaction(admissionId,reservationHash,authority,expectedReviewHash))();
 }
 private readInTransaction(admissionId:string,reservationHash:string,authority:CoordinationDestinationAuthority,expectedReviewHash?:string):CoordinationDestinationReceipt {
  const row=this.row(admissionId);
  if(row.reservation_hash!==reservationHash||row.state!=='admitted'||!row.receipt_json)throw Error('Exact committed destination receipt unavailable');
  const receipt=JSON.parse(row.receipt_json) as CoordinationDestinationReceipt,{reservation,cut}=this.source(row),stage=JSON.parse(row.stage_json) as CoordinationDestinationStage;
  if(expectedReviewHash&&expectedReviewHash!==receipt.reviewHash)throw Error('Destination admission replay review conflict');
  // Readback needs current disclosure permission, not surviving original objects or retained package bytes.
  const facts=this.facts(cut,stage);
  if(!nonempty(synchronous(authority.authorizeDisclosure({admissionId,reservation,stage,facts}))))throw Error('Current receipt disclosure authority required');
  if(receipt.reservationHash!==reservationHash||receipt.stageHash!==payloadHash(stage)||stableJson(receipt.agentMap)!==stableJson(stage.agentMap)||stableJson(receipt.artifactMap)!==stableJson(stage.artifactMap))throw Error('Destination receipt map differs');
  const canonical=this.db.prepare('SELECT receipt_json FROM coordination_cut_restorations WHERE id=?').get(receipt.restorationId) as Row|undefined;
  if(!canonical)throw Error('Destination graph receipt unavailable');
  const graph=JSON.parse(canonical.receipt_json);
  for(const [field,records] of [['requestMap',cut.requests],['updateMap',cut.updates],['joinMap',cut.joins]] as const){
   const map=receipt[field];
   if(!exactKeys(map,records.map(e=>e.row.id))||unique(Object.values(map)).length!==records.length||stableJson(map)!==stableJson(graph[field]))throw Error('Destination canonical graph map differs');
  }
  if(graph.destination?.admissionId!==admissionId||!this.db.prepare("SELECT 1 FROM agent_creation_operations WHERE id=? AND status='completed'").get(receipt.owner.creationOperationId))throw Error('Destination owner/import readback unavailable');
  for(const {row:r} of cut.requests){
   const fresh=this.db.prepare('SELECT * FROM coordination_requests WHERE id=?').get(receipt.requestMap[r.id]) as Row|undefined;
   if(!fresh||fresh.project_id!==reservation.destination.projectId||fresh.conversation_id!==reservation.destination.conversationId||fresh.requester_agent_id!==(r.requester_agent_id?stage.agentMap[r.requester_agent_id]:null)||fresh.recipient_agent_id!==stage.agentMap[r.recipient_agent_id]||fresh.version<r.version)throw Error('Destination Request receipt scope differs');
   const payload=JSON.parse(fresh.payload_json);
   if(payload.destinationAdmissionId!==admissionId||stableJson(payload.historicalPayload)!==r.payload_json||stableJson(payload.historicalOrigin)!==stableJson({restorationId:receipt.restorationId,sourceRequestId:r.id,historical:true})
    ||fresh.version===r.version&&(fresh.open_question_update_id??null)!==(r.open_question_update_id?receipt.updateMap[r.open_question_update_id]:null))throw Error('Destination Request historical prefix differs');
  }
  for(const {row:u} of cut.updates){const fresh=this.db.prepare('SELECT * FROM coordination_request_updates WHERE id=?').get(receipt.updateMap[u.id]) as Row|undefined;if(!fresh)throw Error('Destination historical update unavailable');restoredRequestUpdatePayload(this.db,fresh);}
  for(const {row:j} of cut.joins){
   const fresh=this.db.prepare('SELECT * FROM coordination_joins WHERE id=?').get(receipt.joinMap[j.id]) as Row|undefined;
   const members=this.db.prepare('SELECT request_id,position FROM coordination_join_members WHERE join_id=? ORDER BY position').all(receipt.joinMap[j.id]);
   const expected=cut.members.filter(e=>e.row.join_id===j.id).map(e=>({request_id:receipt.requestMap[e.row.request_id],position:e.row.position})).sort((a,b)=>a.position-b.position);
   if(!fresh||fresh.project_id!==reservation.destination.projectId||fresh.owner_agent_id!==stage.agentMap[j.owner_agent_id]||fresh.conversation_id!==reservation.destination.conversationId
    ||fresh.continuation_request_ids_json!==stableJson(JSON.parse(j.continuation_request_ids_json).map((id:string)=>receipt.requestMap[id]))||stableJson(members)!==stableJson(expected))throw Error('Destination Join receipt differs');
  }
  for(const {row:s} of cut.suspensions){
   if(!this.db.prepare(`SELECT 1 FROM coordination_question_suspensions WHERE question_update_id=? AND request_id=? AND owner_agent_id=? AND dependency_kind='join' AND dependency_id=?`)
    .get(receipt.updateMap[s.question_update_id],receipt.requestMap[s.request_id],stage.agentMap[s.owner_agent_id],receipt.joinMap[s.dependency_id]))throw Error('Destination suspension receipt differs');
  }
  const ownerCommand=this.db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(receipt.owner.executionId,receipt.owner.receiptId) as Row|undefined;
  if(!ownerCommand||stableJson(JSON.parse(ownerCommand.result_json).coordinationDestination)!==canonical.receipt_json)throw Error('Destination Branch owner command differs');
  for(const binding of receipt.owner.requestBindings)if(!this.db.prepare('SELECT 1 FROM branch_attempts WHERE request_id=? AND step_execution_id=?').get(binding.requestId,binding.stepExecutionId))throw Error('Destination issued-step receipt unavailable');
  for(const id of receipt.activationIds){
   const activation=this.db.prepare('SELECT * FROM agent_activations WHERE id=? AND project_id=? AND scope_key=?').get(id,reservation.destination.projectId,`conversation:${reservation.destination.conversationId}`) as Row|undefined;
   if(!activation||!Object.values(stage.agentMap).includes(activation.agent_id))throw Error('Destination activation receipt unavailable');
   const payload=JSON.parse(activation.payload_json),source=payload.updateId?['request_update',payload.updateId]:payload.joinId?['join',payload.joinId]:['request',payload.requestId];
   if(!this.db.prepare('SELECT 1 FROM activation_sources WHERE activation_id=? AND source_kind=? AND source_id=?').get(id,...source))throw Error('Destination activation lineage differs');
  }
  return {...receipt,replayed:true};
 }
}
