import type {BranchDisclosureChoice,BranchDisclosureReviewDto,BranchIssuedDestinationInput,BranchIssuedGroupCaptureStatus,BranchIssuedGroupDestinationDto} from '@ponderosa/core';
import {sameLifecycleInput} from '../lifecycle/lifecycleCommand';
export type GroupCommand={kind:'capture';body:{commandKey:string};resourceStepIds:string[]}|{kind:'prepare';body:BranchIssuedDestinationInput}|{kind:'choice';admissionId:string;body:BranchDisclosureChoice}|{kind:'admit';admissionId:string;body:{commandKey:string;reviewHash:string}};
export interface GroupJournal {capture?:Extract<GroupCommand,{kind:'capture'}>;prepare?:BranchIssuedDestinationInput;pending?:GroupCommand}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const key=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=200;
function validCommand(value:GroupCommand):boolean {
 if(!value||!value.body||!key(value.body.commandKey))return false;
 if(value.kind==='capture')return Array.isArray(value.resourceStepIds)&&value.resourceStepIds.length===2&&value.resourceStepIds.every(key)&&new Set(value.resourceStepIds).size===2;
 if(value.kind==='prepare')return Number.isSafeInteger(value.body.checkpointId)&&value.body.checkpointId>0&&hash(value.body.expectedHash)&&value.body.reconcileEffects===true;
 if(value.kind==='admit')return key(value.admissionId)&&hash(value.body.reviewHash);
 return value.kind==='choice'&&key(value.admissionId)&&['approve','revoke'].includes(value.body.action)&&hash(value.body.reviewHash)&&Number.isSafeInteger(value.body.expectedRevision)&&value.body.expectedRevision>=0;
}
export function restoreGroupJournal(storageKey:string):{journal:GroupJournal;error?:string} {
 try{
  const bytes=localStorage.getItem(storageKey);if(bytes===null)return {journal:{}};
  const value=JSON.parse(bytes);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['capture','prepare','pending'].includes(k))||value.capture&&(value.capture.kind!=='capture'||!validCommand(value.capture))||value.prepare&&!validCommand({kind:'prepare',body:value.prepare})||value.pending&&!validCommand(value.pending))throw Error('Invalid retained group input');
  if(value.prepare&&!value.capture||value.pending?.kind==='capture'&&value.prepare||value.pending&&value.pending.kind!=='capture'&&!value.prepare)throw Error('Missing original group input');
  if(value.pending?.kind==='admit'&&value.pending.body.commandKey!==value.prepare.commandKey)throw Error('Admission command differs from original preparation');
  if(value.pending?.kind==='capture'&&!sameLifecycleInput(value.pending,value.capture)||value.pending?.kind==='prepare'&&!sameLifecycleInput(value.pending.body,value.prepare))throw Error('Retained group identities differ');
  return {journal:value};
 }catch{return {journal:{},error:'Retained group input cannot be read. Preserve browser storage and reconcile its outcome before new changes.'};}
}
/** Status never recreates packages. Only exact two-source retained seals unlock preparation. */
export function groupCaptureMatches(status:BranchIssuedGroupCaptureStatus,command:Extract<GroupCommand,{kind:'capture'}>):boolean {
 return Boolean(status&&Array.isArray(status.sources)&&status.sources.length===2&&new Set(status.sources.map(s=>s.checkpointId)).size===2&&new Set(status.sources.map(s=>s.sourceChatId)).size===2&&sameLifecycleInput(status.sources.map(s=>s.resourceStepId).sort(),[...command.resourceStepIds].sort())&&status.sources.every(s=>key(s.checkpointId)&&key(s.sourceChatId)&&typeof s.sealed==='boolean')&&status.abandonment==='unsupported'&&((status.state==='capturing'&&status.cleanupHeld===true)||(status.state==='retained'&&status.cleanupHeld===false&&status.sources.every(s=>s.sealed)&&Number.isSafeInteger(status.checkpointId)&&Number(status.checkpointId)>0&&hash(status.checkpointHash))));
}
export function groupDestinationMatches(target:BranchIssuedGroupDestinationDto,input:BranchIssuedDestinationInput,executionId:string,resourceStepIds:string[]):boolean {
 if(!target||target.commandKey!==input.commandKey||target.checkpointId!==input.checkpointId||target.checkpointHash!==input.expectedHash||!key(target.admissionId)||!Array.isArray(target.resources)||target.resources.length!==2)return false;
 const rs=target.resources;
 return new Set(rs.map(r=>r.custody.sourceChatId)).size===2&&new Set(rs.map(r=>r.destination.conversationId)).size===2&&new Set(rs.map(r=>r.custody.custodyId)).size===2&&new Set(rs.map(r=>r.destination.resourceStepId)).size===2&&new Set(rs.map(r=>r.destination.executionId)).size===1&&new Set(rs.map(r=>r.destination.projectId)).size===1&&rs.every(r=>r.custody.intent.executionId===executionId&&r.custody.intent.resourceGeneration===0&&r.destination.resourceGeneration===0&&hash(r.custody.sha256)&&['frontierSha256','hostCutSha256','bindingSha256','configurationSha256'].every(field=>{const k=field as keyof typeof r.custody.intent;return hash(r.custody.intent[k])&&r.custody.intent[k]===rs[0]!.custody.intent[k];}))&&sameLifecycleInput(rs.map(r=>r.custody.intent.resourceStepId).sort(),[...resourceStepIds].sort());
}
export function groupReviewMatches(review:BranchDisclosureReviewDto,target:BranchIssuedGroupDestinationDto,branchId:string,executionId:string):boolean {
 const r=review?.review?.reservation,policy=review?.policy;
 return Boolean(r&&review.admissionId===target.admissionId&&review.review.admissionId===target.admissionId&&r.branchId===branchId&&r.sourceExecutionId===executionId&&r.commandKey===target.commandKey&&r.checkpointId===target.checkpointId&&r.checkpointHash===target.checkpointHash&&hash(review.reviewHash)&&hash(review.hostCutSha256)&&hash(review.policyRevision)&&target.resources.every(s=>s.custody.intent.hostCutSha256===review.hostCutSha256)&&sameLifecycleInput(r.resources,target.resources)&&Array.isArray(policy)&&policy.length===2&&sameLifecycleInput(policy.map(p=>p.sourceChatId).sort(),target.resources.map(s=>s.custody.sourceChatId).sort()));
}
