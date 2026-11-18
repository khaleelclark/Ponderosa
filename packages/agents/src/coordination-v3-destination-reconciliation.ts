import {destinationResourceEvidence} from './coordination-v3-destination-resource-evidence.js';
import type Database from 'better-sqlite3';
import type {CoordinationDestinationReservation,CoordinationDestinationReconciliationInput,CoordinationDestinationReconciliationReview,CoordinationDestinationReconciliationReceipt,CoordinationDestinationGroupReconciliationReview,CoordinationDestinationGroupReconciliationSlot,CoordinationDestinationStage} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';

type Row=Record<string,any>;
export interface CoordinationDestinationReconciliationAuthority {
 /** Current operator access/ownership (including deleted-owner authority), observed process/provider
  * exit and resolved import/effect outcomes. Throws for unknown outcomes; never just a stop signal.
  * Enumerate ALL Branch/capture/restore/package/owner references, excluding this admission's own pins.
  * Run synchronously under the same owner transaction; revision binds the human-reviewed evidence. */
 inspect(input:{operatorId:string;reservation:CoordinationDestinationReservation;stage:unknown;groupChats?:CoordinationDestinationGroupReconciliationSlot[]}):{revision:string;references:string[]};
 /** Verify explicit durable human approval of this exact review and requested pin disposition. */
 requireApproval(input:CoordinationDestinationReconciliationInput,review:CoordinationDestinationReconciliationReview):void;
}
/** Whole-group observer and approval; a singular observer cannot authorize the first slot only. */
export interface CoordinationDestinationGroupReconciliationAuthority {
 inspectGroup(input:{operatorId:string;reservation:CoordinationDestinationGroupReconciliationReview['reservation'];stage:unknown;groupChats:CoordinationDestinationGroupReconciliationSlot[]}):{revision:string;references:string[]};
 requireGroupApproval(input:CoordinationDestinationReconciliationInput,review:CoordinationDestinationGroupReconciliationReview):void;
}
export function groupReconciliationAuthority(authority:CoordinationDestinationGroupReconciliationAuthority):CoordinationDestinationReconciliationAuthority {
 return {inspect:input=>{
  if(!input.reservation.resources||!input.groupChats)throw Error('Whole group reconciliation evidence required');
  return authority.inspectGroup({...input,reservation:{...input.reservation,resources:input.reservation.resources},groupChats:input.groupChats});
 },requireApproval:(input,review)=>{
  if(!review.reservation.resources||!('groupChats' in review))throw Error('Whole group approval required');
  return authority.requireGroupApproval(input,review as CoordinationDestinationGroupReconciliationReview);
 }};
}
const sync=<T>(v:T):T=>{if(v&&typeof v==='object'&&'then' in v)throw Error('Reconciliation authority must be synchronous');return v;};
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=512;
export class CoordinationV3DestinationReconciliation {
 constructor(private readonly db:Database.Database,private readonly group=false){}
 private transaction(){if(!this.db.inTransaction)throw Error('Destination reconciliation requires the owner transaction');}
 review(id:string,operatorId:string,authority:CoordinationDestinationReconciliationAuthority):CoordinationDestinationReconciliationReview {
  this.transaction();if(!text(id)||!text(operatorId))throw Error('Exact destination and operator required');
  if(this.db.prepare('SELECT 1 FROM coordination_destination_retirements WHERE admission_id=?').get(id))throw Error('Destination already retired; read its receipt');
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(id) as Row|undefined;
  if(!row||row.state==='admitted'||row.receipt_json)throw Error('Only unadmitted destinations may retire');
  const reservation=JSON.parse(row.reservation_json),stage=row.stage_json?JSON.parse(row.stage_json):null;
  if(Boolean(reservation.resources)!==this.group)throw Error('Use the exact singular or group reconciliation API');
  if(this.group)return this.reviewGroup(row,reservation,stage,operatorId,authority);
  if(payloadHash(reservation)!==row.reservation_hash)throw Error('Reservation evidence differs');
  // No surviving identity may be made dispatchable or stripped of its retention witnesses.
  if(this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(row.conversation_id)
   ||this.db.prepare(`SELECT 1 FROM agents WHERE conversation_id=? OR (deleted_at IS NULL AND id IN
    (SELECT agent_id FROM coordination_destination_members WHERE admission_id=?))`).get(row.conversation_id,id))throw Error('Destination identities must finish canonical deletion before retirement');
  const members=this.db.prepare('SELECT * FROM coordination_destination_members WHERE admission_id=? ORDER BY agent_id').all(id) as Row[];
  for(const member of members){
   if(this.db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown')").get(member.agent_id)
    ||this.db.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending','outcome_unknown')").get(member.agent_id))throw Error('Destination runtime is not drained');
  }
  const operations=this.db.prepare('SELECT * FROM agent_creation_operations WHERE conversation_id=? ORDER BY id').all(row.conversation_id) as Row[];
  if(operations.some(op=>op.status!=='rolled_back'))throw Error('Import outcomes must be canonically rolled back');
  if(stage&&!operations.some(op=>op.id===stage.importPlan.creationOperationId))throw Error('Staged import settlement receipt missing');
  const evidence=sync(authority.inspect({operatorId,reservation,stage}));
  if(!evidence||!text(evidence.revision)||!Array.isArray(evidence.references)||evidence.references.some(ref=>!text(ref)))throw Error('Current ownership, drain and reference evidence required');
  const references=[...new Set(evidence.references)].sort();
  const review={admissionId:id,reservation,state:row.state,stage,evidenceRevision:evidence.revision,references};
  return {...review,reviewHash:payloadHash({operatorId,review,row,members,operations})};
 }
 private groupSlots(id:string,reservation:CoordinationDestinationGroupReconciliationReview['reservation']):CoordinationDestinationGroupReconciliationSlot[] {
  const resources=reservation.resources;
  if(!Array.isArray(resources)||resources.length<2||resources.length>32
   ||new Set(resources.map(r=>r.custody.sourceChatId)).size!==resources.length
   ||new Set(resources.map(r=>r.destination.conversationId)).size!==resources.length
   ||new Set(resources.map(r=>r.custody.intent.resourceStepId)).size!==resources.length
   ||new Set(resources.map(r=>r.destination.resourceStepId)).size!==resources.length
   ||resources.some(r=>r.destination.projectId!==reservation.destination.projectId)
   ||stableJson(resources[0])!==stableJson({custody:reservation.custody,destination:reservation.destination}))throw Error('Invalid whole-group retirement inventory');
  const slots=this.db.prepare('SELECT admission_id,source_chat_id,source_execution_id,conversation_id,stage_json FROM coordination_destination_group_chats WHERE admission_id=? ORDER BY source_chat_id').all(id) as CoordinationDestinationGroupReconciliationSlot[];
  const expected=resources.map(r=>({admission_id:id,source_chat_id:r.custody.sourceChatId,source_execution_id:r.custody.intent.executionId,conversation_id:r.destination.conversationId})).sort((a,b)=>a.source_chat_id<b.source_chat_id?-1:1);
  if(stableJson(slots.map(({stage_json,...identity})=>identity))!==stableJson(expected))throw Error('Exhaustive group slot ownership differs');
  return slots;
 }
 private reviewGroup(row:Row,reservation:CoordinationDestinationGroupReconciliationReview['reservation'],stage:CoordinationDestinationStage|null,operatorId:string,authority:CoordinationDestinationReconciliationAuthority):CoordinationDestinationGroupReconciliationReview {
  if(stableJson(reservation)!==row.reservation_json||payloadHash(reservation)!==row.reservation_hash
   ||stableJson(JSON.parse(row.snapshot_json))!==row.snapshot_json||payloadHash(JSON.parse(row.snapshot_json))!==reservation.checkpointHash
   ||row.branch_id!==reservation.branchId||row.source_execution_id!==reservation.sourceExecutionId||row.checkpoint_id!==reservation.checkpointId
   ||row.project_id!==reservation.destination.projectId||row.conversation_id!==reservation.destination.conversationId)throw Error('Group reservation evidence differs');
  destinationResourceEvidence(JSON.parse(row.snapshot_json),reservation);
  if(stage&&stableJson(stage)!==row.stage_json)throw Error('Group stage bytes differ');
  const groupChats=this.groupSlots(row.id,reservation),members=this.db.prepare('SELECT * FROM coordination_destination_members WHERE admission_id=? ORDER BY agent_id').all(row.id) as Row[];
  const operations:Row[]=[],expectedMembers:{admission_id:string;source_agent_id:string;agent_id:string}[]=[],operationIds=new Set<string>();
  if(stage&&(!stage.imports||stableJson(Object.keys(stage.imports).sort())!==stableJson(groupChats.map(s=>s.source_chat_id))
   ||stableJson(stage.importPlan)!==stableJson(stage.imports[reservation.custody.sourceChatId])))throw Error('Whole-group staged imports differ');
  if(stage&&groupChats.some(s=>s.stage_json)&&groupChats.some(s=>!s.stage_json))throw Error('Partially assembled group stage differs');
  const maps:Record<string,string>={},artifacts:Record<string,string>={};
  for(const slot of groupChats){
   if(this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(slot.conversation_id)
    ||this.db.prepare('SELECT 1 FROM agents WHERE conversation_id=?').get(slot.conversation_id))throw Error('Every group Chat must finish canonical deletion');
   const resource=reservation.resources.find(r=>r.custody.sourceChatId===slot.source_chat_id)!;
   const partial=slot.stage_json?JSON.parse(slot.stage_json) as CoordinationDestinationStage:null;
   if(partial&&(stableJson(partial)!==slot.stage_json||partial.imports))throw Error('Group slot stage differs');
   const plan=stage?.imports?.[slot.source_chat_id]??partial?.importPlan;
   const agentMap=stage?Object.fromEntries(resource.custody.agentIds.map(id=>[id,stage.agentMap[id]])):partial?.agentMap;
   if(stage&&partial&&(stableJson(plan)!==stableJson(partial.importPlan)||stableJson(agentMap)!==stableJson(partial.agentMap)))throw Error('Group slot and assembled stage differ');
   const ops=this.db.prepare('SELECT * FROM agent_creation_operations WHERE conversation_id=? ORDER BY id').all(slot.conversation_id) as Row[];
   if(ops.some(op=>op.status!=='rolled_back'))throw Error('Every group import outcome must be canonically rolled back');
   operations.push(...ops);
   if(plan){
    if(plan.projectId!==row.project_id||plan.conversationId!==slot.conversation_id||operationIds.has(plan.creationOperationId)
     ||!ops.some(op=>op.id===plan.creationOperationId&&op.project_id===row.project_id))throw Error('Exact group import rollback receipt missing');
    operationIds.add(plan.creationOperationId);
    if(!agentMap||stableJson(Object.keys(agentMap).sort())!==stableJson([...resource.custody.agentIds].sort())
     ||stableJson(plan.agents.map(a=>({sourceRef:a.sourceRef,agentId:a.agentId})).sort((a,b)=>a.sourceRef<b.sourceRef?-1:1))
       !==stableJson(Object.entries(agentMap).map(([sourceRef,agentId])=>({sourceRef,agentId})).sort((a,b)=>a.sourceRef<b.sourceRef?-1:1)))throw Error('Exact group import member inventory differs');
    for(const [source,agent] of Object.entries(agentMap)){
     if(!text(source)||!text(agent)||source===agent||Object.hasOwn(maps,source)||Object.values(maps).includes(agent))throw Error('Group participant identities alias');
     maps[source]=agent;expectedMembers.push({admission_id:row.id,source_agent_id:source,agent_id:agent});
    }
    if(partial)for(const [source,artifact] of Object.entries(partial.artifactMap)){
     if(Object.hasOwn(artifacts,source)||Object.values(artifacts).includes(artifact))throw Error('Group artifact identities alias');artifacts[source]=artifact;
    }
   }else if(partial||agentMap)throw Error('Group slot import plan missing');
  }
  if(stage&&(stableJson(maps)!==stableJson(stage.agentMap)||groupChats.every(s=>s.stage_json)&&stableJson(artifacts)!==stableJson(stage.artifactMap)))throw Error('Assembled group identity inventory differs');
  expectedMembers.sort((a,b)=>a.agent_id<b.agent_id?-1:1);
  if(stableJson(members)!==stableJson(expectedMembers))throw Error('Group member retention inventory differs');
  for(const member of members){
   if(this.db.prepare('SELECT 1 FROM agents WHERE id=? AND deleted_at IS NULL').get(member.agent_id))throw Error('Every group Agent must finish canonical deletion');
   if(this.db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown')").get(member.agent_id)
    ||this.db.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending','outcome_unknown')").get(member.agent_id))throw Error('Group destination runtime is not drained');
  }
  const evidence=sync(authority.inspect({operatorId,reservation,stage,groupChats}));
  if(!evidence||!text(evidence.revision)||!Array.isArray(evidence.references)||evidence.references.some(ref=>!text(ref)))throw Error('Whole-group ownership, drain and reference evidence required');
  const review={admissionId:row.id,reservation,state:row.state,stage,evidenceRevision:evidence.revision,references:[...new Set(evidence.references)].sort(),groupChats};
  return {...review,reviewHash:payloadHash({operatorId,review,row,members,operations})};
 }
 retire(input:CoordinationDestinationReconciliationInput,authority:CoordinationDestinationReconciliationAuthority,now=new Date().toISOString()):CoordinationDestinationReconciliationReceipt {
  this.transaction();return this.db.transaction(()=>{
   if(!text(input.commandKey)||!text(input.operatorId)||typeof input.releaseSourcePins!=='boolean'||!/^[a-f0-9]{64}$/.test(input.expectedReviewHash))throw Error('Exact reviewed retirement command required');
   const prior=this.db.prepare('SELECT * FROM coordination_destination_retirements WHERE admission_id=?').get(input.admissionId) as Row|undefined;
   if(prior){if(prior.input_json!==stableJson(input))throw Error('Retirement command conflict');return this.read(input.admissionId)!;}
   const review=this.review(input.admissionId,input.operatorId,authority);
   if(review.reviewHash!==input.expectedReviewHash)throw Error('Destination reconciliation review changed');
   if(input.releaseSourcePins&&review.references.length)throw Error('Source pins are still referenced');
   sync(authority.requireApproval(input,review));
   // Approval must not mutate the evidence that was reviewed.
   if(this.review(input.admissionId,input.operatorId,authority).reviewHash!==review.reviewHash)throw Error('Approval changed reconciliation evidence');
   const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(input.admissionId) as Row;
   const members=this.db.prepare('SELECT * FROM coordination_destination_members WHERE admission_id=? ORDER BY agent_id').all(input.admissionId);
   const groupChats=this.group?(review as CoordinationDestinationGroupReconciliationReview).groupChats:undefined;
   const operations=groupChats?.flatMap(slot=>this.db.prepare('SELECT * FROM agent_creation_operations WHERE conversation_id=? ORDER BY id').all(slot.conversation_id));
   const evidence={review,row,...(groupChats?{groupChats,members,operations}: {})};
   const receipt:CoordinationDestinationReconciliationReceipt={admissionId:input.admissionId,commandKey:input.commandKey,operatorId:input.operatorId,reviewHash:review.reviewHash,releasedSourcePins:input.releaseSourcePins,retiredAt:now,...(groupChats?{resources:review.reservation.resources,groupChats,evidenceSha256:payloadHash(evidence)}: {})};
   this.db.prepare(`INSERT INTO coordination_destination_retirements VALUES(?,?,?,?,?,?,?,?)`).run(input.admissionId,row.branch_id,row.command_key,row.conversation_id,stableJson(input),stableJson(receipt),stableJson(evidence),stableJson(members));
   if(input.releaseSourcePins){
    if(this.group)this.db.prepare('DELETE FROM coordination_destination_group_chats WHERE admission_id=?').run(input.admissionId);
    this.db.prepare('DELETE FROM coordination_destination_members WHERE admission_id=?').run(input.admissionId);
    this.db.prepare("DELETE FROM coordination_destination_admissions WHERE id=? AND state!='admitted'").run(input.admissionId);
   }
   return receipt;
  })();
 }
 read(id:string):CoordinationDestinationReconciliationReceipt|null {
  const row=this.db.prepare('SELECT * FROM coordination_destination_retirements WHERE admission_id=?').get(id) as Row|undefined;
  if(!row)return null;
  const receipt=JSON.parse(row.receipt_json),evidence=JSON.parse(row.evidence_json);
  if(Boolean(evidence.review?.reservation?.resources)!==this.group)throw Error('Use the exact singular or group reconciliation API');
  if(this.group){
   if(stableJson(receipt)!==row.receipt_json||stableJson(evidence)!==row.evidence_json||receipt.evidenceSha256!==payloadHash(evidence)
    ||receipt.admissionId!==id||receipt.reviewHash!==evidence.review.reviewHash||evidence.row.id!==id
    ||payloadHash(JSON.parse(evidence.row.reservation_json))!==evidence.row.reservation_hash
    ||stableJson(JSON.parse(evidence.row.reservation_json))!==stableJson(evidence.review.reservation)
    ||stableJson(receipt.resources)!==stableJson(evidence.review.reservation.resources)
    ||stableJson(receipt.groupChats)!==stableJson(evidence.groupChats)||stableJson(evidence.groupChats)!==stableJson(evidence.review.groupChats)
    ||stableJson(evidence.members)!==row.members_json)throw Error('Group retirement retained evidence differs');
   const snapshot=JSON.parse(evidence.row.snapshot_json);
   if(stableJson(snapshot)!==evidence.row.snapshot_json||payloadHash(snapshot)!==evidence.review.reservation.checkpointHash)throw Error('Retired checkpoint differs');
   destinationResourceEvidence(snapshot,evidence.review.reservation);
   const {reviewHash,...review}=evidence.review;
   if(reviewHash!==payloadHash({operatorId:receipt.operatorId,review,row:evidence.row,members:evidence.members,operations:evidence.operations}))throw Error('Group retirement review evidence differs');
   const input=JSON.parse(row.input_json);
   if(input.admissionId!==id||input.commandKey!==receipt.commandKey||input.operatorId!==receipt.operatorId
    ||input.expectedReviewHash!==receipt.reviewHash||input.releaseSourcePins!==receipt.releasedSourcePins)throw Error('Group retirement command receipt differs');
  }
  return receipt;
 }
}
