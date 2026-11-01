import type Database from 'better-sqlite3';
import type {CoordinationDestinationReservation,CoordinationDestinationReconciliationInput,CoordinationDestinationReconciliationReview,CoordinationDestinationReconciliationReceipt} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';

type Row=Record<string,any>;
export interface CoordinationDestinationReconciliationAuthority {
 /** Current operator access/ownership (including deleted-owner authority), observed process/provider
  * exit and resolved import/effect outcomes. Throws for unknown outcomes; never just a stop signal.
  * Enumerate ALL Branch/capture/restore/package/owner references, excluding this admission's own pins.
  * Run synchronously under the same owner transaction; revision binds the human-reviewed evidence. */
 inspect(input:{operatorId:string;reservation:CoordinationDestinationReservation;stage:unknown}):{revision:string;references:string[]};
 /** Verify explicit durable human approval of this exact review and requested pin disposition. */
 requireApproval(input:CoordinationDestinationReconciliationInput,review:CoordinationDestinationReconciliationReview):void;
}
const sync=<T>(v:T):T=>{if(v&&typeof v==='object'&&'then' in v)throw Error('Reconciliation authority must be synchronous');return v;};
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=512;
export class CoordinationV3DestinationReconciliation {
 constructor(private readonly db:Database.Database){}
 private transaction(){if(!this.db.inTransaction)throw Error('Destination reconciliation requires the owner transaction');}
 review(id:string,operatorId:string,authority:CoordinationDestinationReconciliationAuthority):CoordinationDestinationReconciliationReview {
  this.transaction();if(!text(id)||!text(operatorId))throw Error('Exact destination and operator required');
  if(this.db.prepare('SELECT 1 FROM coordination_destination_retirements WHERE admission_id=?').get(id))throw Error('Destination already retired; read its receipt');
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(id) as Row|undefined;
  if(!row||row.state==='admitted'||row.receipt_json)throw Error('Only unadmitted destinations may retire');
  const reservation=JSON.parse(row.reservation_json),stage=row.stage_json?JSON.parse(row.stage_json):null;
  if(reservation.resources)throw Error('Group retirement requires exhaustive group lifecycle reconciliation');
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
 retire(input:CoordinationDestinationReconciliationInput,authority:CoordinationDestinationReconciliationAuthority,now=new Date().toISOString()):CoordinationDestinationReconciliationReceipt {
  this.transaction();return this.db.transaction(()=>{
   if(!text(input.commandKey)||!text(input.operatorId)||typeof input.releaseSourcePins!=='boolean'||!/^[a-f0-9]{64}$/.test(input.expectedReviewHash))throw Error('Exact reviewed retirement command required');
   const prior=this.db.prepare('SELECT * FROM coordination_destination_retirements WHERE admission_id=?').get(input.admissionId) as Row|undefined;
   if(prior){if(prior.input_json!==stableJson(input))throw Error('Retirement command conflict');return JSON.parse(prior.receipt_json);}
   const review=this.review(input.admissionId,input.operatorId,authority);
   if(review.reviewHash!==input.expectedReviewHash)throw Error('Destination reconciliation review changed');
   if(input.releaseSourcePins&&review.references.length)throw Error('Source pins are still referenced');
   sync(authority.requireApproval(input,review));
   // Approval must not mutate the evidence that was reviewed.
   if(this.review(input.admissionId,input.operatorId,authority).reviewHash!==review.reviewHash)throw Error('Approval changed reconciliation evidence');
   const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(input.admissionId) as Row;
   const members=this.db.prepare('SELECT * FROM coordination_destination_members WHERE admission_id=? ORDER BY agent_id').all(input.admissionId);
   const receipt:CoordinationDestinationReconciliationReceipt={admissionId:input.admissionId,commandKey:input.commandKey,operatorId:input.operatorId,reviewHash:review.reviewHash,releasedSourcePins:input.releaseSourcePins,retiredAt:now};
   this.db.prepare(`INSERT INTO coordination_destination_retirements VALUES(?,?,?,?,?,?,?,?)`).run(input.admissionId,row.branch_id,row.command_key,row.conversation_id,stableJson(input),stableJson(receipt),stableJson({review,row}),stableJson(members));
   if(input.releaseSourcePins){
    this.db.prepare('DELETE FROM coordination_destination_members WHERE admission_id=?').run(input.admissionId);
    this.db.prepare("DELETE FROM coordination_destination_admissions WHERE id=? AND state!='admitted'").run(input.admissionId);
   }
   return receipt;
  })();
 }
 read(id:string):CoordinationDestinationReconciliationReceipt|null {
  const row=this.db.prepare('SELECT receipt_json FROM coordination_destination_retirements WHERE admission_id=?').get(id) as Row|undefined;
  return row?JSON.parse(row.receipt_json):null;
 }
}
