import type {BranchGroupDiscoveryItem,GroupJournalAuditSelection,GroupJournalAuditReadback} from '@ponderosa/core';
import {sameLifecycleInput} from '../lifecycle/lifecycleCommand';
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512;
/** Only a server-discovered selector can address historical evidence. No key derivation. */
export function groupAuditSelectionMatches(row:BranchGroupDiscoveryItem):boolean {
 const s=row.auditSelection;
 return Boolean(s&&Object.keys(s).every(k=>['kind','branchId','executionId','journalKey','journalSha256','custodySha256','commandKey','admissionId','reservationHash'].includes(k))&&s.kind===row.kind&&s.branchId===row.branchId&&s.executionId===row.executionId&&text(s.journalKey)&&hash(s.journalSha256)&&hash(s.custodySha256)&&s.commandKey===row.commandKey&&(s.kind==='captures'?s.admissionId===undefined&&s.reservationHash===undefined:s.admissionId===row.admissionId&&text(s.admissionId)&&hash(s.reservationHash)));
}
/** Audit evidence is never a current-authority or action-eligibility result. */
export function groupAuditMatches(value:GroupJournalAuditReadback,selection:GroupJournalAuditSelection,count:number):boolean {
 if(!value||value.historical!==true||value.currentAuthority!==false||value.actionEligible!==false||value.held!==true||!sameLifecycleInput(value.selection,selection)||value.journalSha256!==selection.journalSha256||!hash(value.evidenceSha256)||typeof value.sourceOwnerPresent!=='boolean'||typeof value.state!=='string'||!Number.isSafeInteger(count)||count<2||count>32)return false;
 if(selection.kind==='captures')return Boolean(value.capture&&Array.isArray(value.capture.sources)&&value.capture.sources.length===count&&new Set(value.capture.sources.map(s=>s.checkpointId)).size===count&&Array.isArray(value.capture.receipts)&&value.capture.receipts.every(r=>value.capture!.sources.some(s=>s.checkpointId===r.checkpointId)));
 return Boolean(value.reservationHash===selection.reservationHash&&Array.isArray(value.resources)&&value.resources.length===count&&value.idMap&&typeof value.idMap==='object'&&!Array.isArray(value.idMap)&&value.agentMap&&typeof value.agentMap==='object'&&!Array.isArray(value.agentMap)&&Array.isArray(value.imports)&&Array.isArray(value.owners)&&value.owners.length===count&&value.resources.every(r=>value.owners!.some(o=>o.executionId===r.destination.executionId&&o.resourceStepId===r.destination.resourceStepId)));
}
/** The backend projection excludes private bodies; do not render unrecognized top-level fields. */
export function groupAuditProjection(value:GroupJournalAuditReadback):unknown {
 const c=value.capture,d=c?.disposition as {state?:string;commandKey?:string;packageRetirements?:unknown}|undefined;
 return {selection:value.selection,sourceOwnerPresent:value.sourceOwnerPresent,state:value.state,journalSha256:value.journalSha256,evidenceSha256:value.evidenceSha256,capture:c?{sources:c.sources,receipts:c.receipts,checkpointId:c.checkpointId,checkpointHash:c.checkpointHash,disposition:d?{state:d.state,commandKey:d.commandKey,packageRetirements:d.packageRetirements}:undefined}:undefined,reservationHash:value.reservationHash,resources:value.resources,idMap:value.idMap,agentMap:value.agentMap,imports:value.imports,owners:value.owners,receipt:value.receipt,retirement:value.retirement};
}
