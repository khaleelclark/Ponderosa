import type {BranchGroupCaptureInput,BranchGroupCapturePreview,BranchDisclosureChoice,BranchDisclosureReviewDto,BranchIssuedDestinationInput,BranchIssuedGroupCaptureStatus,BranchIssuedGroupDestinationDto} from '@ponderosa/core';
import {sameLifecycleInput} from '../lifecycle/lifecycleCommand';
export type GroupCommand={kind:'capture';body:BranchGroupCaptureInput;resourceStepIds:string[];preview?:BranchGroupCapturePreview}|{kind:'prepare';body:BranchIssuedDestinationInput}|{kind:'choice';admissionId:string;body:BranchDisclosureChoice}|{kind:'admit';admissionId:string;body:{commandKey:string;reviewHash:string}};
export interface GroupJournal {capture?:Extract<GroupCommand,{kind:'capture'}>;prepare?:BranchIssuedDestinationInput;pending?:GroupCommand}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const key=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=200;
function validCommand(value:GroupCommand):boolean {
 if(!value||!value.body||!key(value.body.commandKey))return false;
 if(value.kind==='capture')return (value.body.reviewHash===undefined&&value.body.versionId===undefined||hash(value.body.reviewHash)&&key(value.body.versionId))&&(!value.preview||groupPreviewSupported(value.preview)&&value.preview.reviewHash===value.body.reviewHash&&value.preview.versionId===value.body.versionId&&sameLifecycleInput(value.preview.resources.map(r=>r.resourceStepId).sort(),[...value.resourceStepIds].sort()))&&Array.isArray(value.resourceStepIds)&&value.resourceStepIds.length>=2&&value.resourceStepIds.length<=32&&value.resourceStepIds.every(key)&&new Set(value.resourceStepIds).size===value.resourceStepIds.length;
 if(value.kind==='prepare')return Number.isSafeInteger(value.body.checkpointId)&&value.body.checkpointId>0&&hash(value.body.expectedHash)&&value.body.reconcileEffects===true;
 if(value.kind==='admit')return key(value.admissionId)&&hash(value.body.reviewHash);
 return value.kind==='choice'&&key(value.admissionId)&&['approve','revoke'].includes(value.body.action)&&hash(value.body.reviewHash)&&Number.isSafeInteger(value.body.expectedRevision)&&value.body.expectedRevision>=0;
}
export function restoreGroupJournal(storageKey:string):{journal:GroupJournal;error?:string} {
 try{
  const bytes=localStorage.getItem(storageKey);if(bytes===null)return {journal:{}};
  const value=JSON.parse(bytes);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['capture','prepare','pending'].includes(k))||value.capture&&(value.capture.kind!=='capture'||!validCommand(value.capture))||value.prepare&&!validCommand({kind:'prepare',body:value.prepare})||value.pending&&!validCommand(value.pending))throw Error('Invalid retained group input');
  if(value.pending?.kind==='capture'&&value.prepare||value.pending&&value.pending.kind!=='capture'&&!value.prepare)throw Error('Missing original group input');
  if(value.pending?.kind==='admit'&&value.pending.body.commandKey!==value.prepare.commandKey)throw Error('Admission command differs from original preparation');
  if(value.pending?.kind==='capture'&&!sameLifecycleInput(value.pending,value.capture)||value.pending?.kind==='prepare'&&!sameLifecycleInput(value.pending.body,value.prepare))throw Error('Retained group identities differ');
  return {journal:value};
 }catch{return {journal:{},error:'Retained group input cannot be read. Preserve browser storage and reconcile its outcome before new changes.'};}
}
/** Status never recreates packages. Only exact exhaustive retained seals unlock preparation. */
export function groupCaptureMatches(status:BranchIssuedGroupCaptureStatus,command:Extract<GroupCommand,{kind:'capture'}>):boolean {
 return Boolean(command.resourceStepIds.length>=2&&command.resourceStepIds.length<=32&&status&&Array.isArray(status.sources)&&status.sources.length===command.resourceStepIds.length&&new Set(status.sources.map(s=>s.checkpointId)).size===command.resourceStepIds.length&&new Set(status.sources.map(s=>s.sourceChatId)).size===command.resourceStepIds.length&&sameLifecycleInput(status.sources.map(s=>s.resourceStepId).sort(),[...command.resourceStepIds].sort())&&status.sources.every(s=>key(s.checkpointId)&&key(s.sourceChatId)&&typeof s.sealed==='boolean')&&(!command.preview||sameLifecycleInput(status.sources.map(s=>({step:s.resourceStepId,chat:s.sourceChatId})).sort((a,b)=>a.step.localeCompare(b.step)),command.preview.resources.map(r=>({step:r.resourceStepId,chat:r.sourceChatId})).sort((a,b)=>a.step.localeCompare(b.step))))&&status.abandonment==='unsupported'&&((status.state==='capturing'&&status.cleanupHeld===true)||(status.state==='retained'&&status.cleanupHeld===false&&status.sources.every(s=>s.sealed)&&Number.isSafeInteger(status.checkpointId)&&Number(status.checkpointId)>0&&hash(status.checkpointHash))));
}
export function groupDestinationMatches(target:BranchIssuedGroupDestinationDto,input:BranchIssuedDestinationInput,executionId:string,resourceStepIds:string[]):boolean {
 if(!target||target.commandKey!==input.commandKey||target.checkpointId!==input.checkpointId||target.checkpointHash!==input.expectedHash||!key(target.admissionId)||!Array.isArray(target.resources)||target.resources.length!==resourceStepIds.length||resourceStepIds.length<2||resourceStepIds.length>32)return false;
 if(new Set(resourceStepIds).size!==resourceStepIds.length)return false;
 const rs=target.resources;
 return new Set(rs.map(r=>r.custody.sourceChatId)).size===resourceStepIds.length&&new Set(rs.map(r=>r.destination.conversationId)).size===resourceStepIds.length&&new Set(rs.map(r=>r.custody.custodyId)).size===resourceStepIds.length&&new Set(rs.map(r=>r.destination.resourceStepId)).size===resourceStepIds.length&&new Set(rs.map(r=>r.destination.executionId)).size===1&&new Set(rs.map(r=>r.destination.projectId)).size===1&&rs.every(r=>r.custody.intent.executionId===executionId&&r.custody.intent.resourceGeneration===0&&r.destination.resourceGeneration===0&&hash(r.custody.sha256)&&['frontierSha256','hostCutSha256','bindingSha256','configurationSha256'].every(field=>{const k=field as keyof typeof r.custody.intent;return hash(r.custody.intent[k])&&r.custody.intent[k]===rs[0]!.custody.intent[k];}))&&sameLifecycleInput(rs.map(r=>r.custody.intent.resourceStepId).sort(),[...resourceStepIds].sort());
}
export function groupReviewMatches(review:BranchDisclosureReviewDto,target:BranchIssuedGroupDestinationDto,branchId:string,executionId:string):boolean {
 const r=review?.review?.reservation,policy=review?.policy;
 return Boolean(r&&review.admissionId===target.admissionId&&review.review.admissionId===target.admissionId&&r.branchId===branchId&&r.sourceExecutionId===executionId&&r.commandKey===target.commandKey&&r.checkpointId===target.checkpointId&&r.checkpointHash===target.checkpointHash&&hash(review.reviewHash)&&hash(review.hostCutSha256)&&hash(review.policyRevision)&&target.resources.every(s=>s.custody.intent.hostCutSha256===review.hostCutSha256)&&sameLifecycleInput(r.resources,target.resources)&&Array.isArray(policy)&&policy.length===target.resources.length&&sameLifecycleInput(policy.map(p=>p.sourceChatId).sort(),target.resources.map(s=>s.custody.sourceChatId).sort()));
}

/** Server preview is authoritative; reject malformed or broader inventories before offering capture. */
export function groupPreviewSupported(value:BranchGroupCapturePreview):boolean {
 return Boolean(value&&hash(value.reviewHash)&&key(value.versionId)&&key(value.bindingRevisionId)&&hash(value.frontierHash)&&hash(value.hostCutHash)&&Array.isArray(value.resources)&&value.resources.length>=2&&value.resources.length<=32&&new Set(value.resources.map(r=>r.resourceStepId)).size===value.resources.length&&new Set(value.resources.map(r=>r.sourceChatId)).size===value.resources.length&&value.resources.every(r=>key(r.resourceStepId)&&key(r.sourceChatId)&&r.generation===0&&Array.isArray(r.agentIds)&&r.agentIds.length>0&&r.agentIds.every(key)&&new Set(r.agentIds).size===r.agentIds.length));
}
