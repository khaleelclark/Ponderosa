import type {AgentImportLifecycleReconcileInput,CheckpointCaptureAbandonmentInput,CheckpointCustodyReconcileInput,DestinationRetirementChoice,MemoryMutationReconcileInput,BranchCustodyCheckpointRetirementInput} from '@ponderosa/core';
export type LifecycleInput=AgentImportLifecycleReconcileInput|CheckpointCaptureAbandonmentInput|CheckpointCustodyReconcileInput|DestinationRetirementChoice|MemoryMutationReconcileInput|BranchCustodyCheckpointRetirementInput;
export interface LifecycleCommand {path:string;id:string;action:string;body:LifecycleInput;approved?:boolean}
/** Damaged retained input is an unresolved outcome, never permission for a new command. */
export function restoreLifecycleCommand(key:string):{command?:LifecycleCommand;error?:string} {
 try {
  const bytes=localStorage.getItem(key);if(bytes===null)return {};
  const command=JSON.parse(bytes);
  if(!command||typeof command.path!=='string'||typeof command.id!=='string'||typeof command.action!=='string'||!command.body||typeof command.body.commandKey!=='string')throw Error('Invalid retained command');
  return {command};
 } catch {return {error:'Retained lifecycle command cannot be read. Preserve browser storage and reconcile the original outcome before new changes.'};}
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
export const sameLifecycleInput=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
/** A changed receipt cannot release an ambiguous command or authorize the next stage. */
export function lifecycleReceiptMatches(command:LifecycleCommand,value:unknown):boolean {
 if(!value||typeof value!=='object')return false;
 const receipt=value as Record<string,unknown>,body=command.body;
 if(command.action==='approve')return receipt.admissionId===command.id&&receipt.reviewHash===('expectedReviewHash' in body?body.expectedReviewHash:undefined)&&sameLifecycleInput(receipt.choice,body);
 if('checkpoints' in body)return receipt.schema==='branch-custody-checkpoint-retirement.v1'&&receipt.state==='retired'&&receipt.custodyId===command.id&&sameLifecycleInput(receipt.input,body);
 if(receipt.commandKey!==body.commandKey)return false;
 if(command.path?.includes('/destination-groups/')&&(!Array.isArray(receipt.resources)||receipt.resources.length<2||receipt.resources.length>32||!Array.isArray(receipt.groupChats)||typeof receipt.evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.evidenceSha256)))return false;
 if('expectedReviewHash' in body)return receipt.admissionId===command.id&&receipt.reviewHash===body.expectedReviewHash&&receipt.releasedSourcePins===body.releaseSourcePins&&typeof receipt.retiredAt==='string';
 if('captureKey' in body)return receipt.custodyId===command.id&&receipt.reviewSha256===body.reviewSha256&&receipt.state==='abandoned';
 if(receipt.reviewSha256!==body.reviewSha256)return false;
 if('backendDrainEvidence' in body)return receipt.id===command.id&&receipt.state==='reconciled'&&receipt.backendDrainEvidence===body.backendDrainEvidence&&typeof receipt.backendSha256==='string';
 if('action' in body)return receipt.operationId===command.id&&receipt.state===(body.action==='preserve_unresolved'?'preserved_unresolved':'retired');
 return receipt.custodyId===command.id&&receipt.state==='reconciled'&&typeof receipt.filesSha256==='string';
}
