import type {CheckpointPackageSource,LifecycleGroupCaptureEntry,CheckpointGroupCaptureAbandonmentInput,CheckpointGroupCaptureAbandonmentReviewDto} from '@ponderosa/core';
import {sameLifecycleInput} from './lifecycleCommand';
export const groupCaptureAbandonmentPath='/api/lifecycle/checkpoint-capture-groups/abandon';
export interface GroupAbandonmentCommand {entry:LifecycleGroupCaptureEntry;input:CheckpointGroupCaptureAbandonmentInput;review:CheckpointGroupCaptureAbandonmentReviewDto}
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(text);
function sourcesValid(sources:CheckpointPackageSource[],executionId:string):boolean {
 return Array.isArray(sources)&&sources.length>=2&&sources.length<=32&&new Set(sources.map(s=>s?.checkpointId)).size===sources.length&&new Set(sources.map(s=>s?.sourceChatId)).size===sources.length&&new Set(sources.map(s=>s?.intent?.resourceStepId)).size===sources.length&&sources.every(s=>s&&text(s.checkpointId)&&text(s.sourceChatId)&&strings(s.agentIds)&&s.agentIds.length>0&&s.intent?.executionId===executionId&&text(s.intent.resourceStepId)&&s.intent.resourceGeneration===0&&hash(s.intent.frontierSha256)&&hash(s.intent.bindingSha256)&&hash(s.intent.configurationSha256)&&hash(s.intent.hostCutSha256))&&new Set(sources.flatMap(s=>s.agentIds)).size===sources.flatMap(s=>s.agentIds).length;
}
export function groupCaptureEntryValid(value:LifecycleGroupCaptureEntry):boolean {
 return Boolean(value&&text(value.executionId)&&typeof value.captureKey==='string'&&/^issued-group-capture:[a-f0-9]{64}$/.test(value.captureKey)&&value.state==='capturing'&&['current','retained_only'].includes(value.sourceOwner)&&hash(value.evidenceSha256)&&sourcesValid(value.sources,value.executionId)&&strings(value.capturedCheckpointIds)&&new Set(value.capturedCheckpointIds).size===value.capturedCheckpointIds.length&&value.capturedCheckpointIds.every(id=>value.sources.some(s=>s.checkpointId===id)));
}
export function groupAbandonmentReviewMatches(value:CheckpointGroupCaptureAbandonmentReviewDto,entry:Pick<LifecycleGroupCaptureEntry,'executionId'|'captureKey'|'sources'>):boolean {
 return Boolean(value&&value.executionId===entry.executionId&&value.captureKey===entry.captureKey&&hash(value.groupId)&&hash(value.captureSha256)&&text(value.branchRevision)&&hash(value.reviewSha256)&&strings(value.references)&&strings(value.blockers)&&Array.isArray(value.packages)&&sourcesValid(entry.sources,entry.executionId)&&sameLifecycleInput(value.packages.map(p=>p?.source),entry.sources)&&new Set(value.packages.map(p=>p?.custodyId)).size===entry.sources.length&&value.packages.every(p=>p&&hash(p.custodyId)&&hash(p.reviewSha256)&&strings(p.references)&&strings(p.blockers)&&Array.isArray(p.files)&&p.files.length<=128&&new Set(p.files.map(f=>f.name)).size===p.files.length&&p.files.every(f=>text(f.name)&&hash(f.sha256)&&Number.isSafeInteger(f.byteLength)&&f.byteLength>=0)));
}
export const groupAbandonmentHeld=(review:CheckpointGroupCaptureAbandonmentReviewDto)=>Boolean(review.references.length||review.blockers.length||review.packages.some(p=>p.references.length||p.blockers.length));
export function restoreGroupAbandonment(key:string,entry:LifecycleGroupCaptureEntry):{command?:GroupAbandonmentCommand;error?:string} {
 try {
  const bytes=localStorage.getItem(key);if(bytes===null)return {};
  const command=JSON.parse(bytes) as GroupAbandonmentCommand,input=command?.input;
  if(!groupCaptureEntryValid(command?.entry)||!sameLifecycleInput(command.entry.sources,entry.sources)||command.entry.executionId!==entry.executionId||command.entry.captureKey!==entry.captureKey||!input||Object.keys(input).sort().join(',')!=='captureKey,commandKey,executionId,preserveEvidence,reviewSha256'||input.executionId!==entry.executionId||input.captureKey!==entry.captureKey||!text(input.commandKey)||input.commandKey.length>200||input.preserveEvidence!==true||!groupAbandonmentReviewMatches(command.review,entry)||input.reviewSha256!==command.review.reviewSha256||groupAbandonmentHeld(command.review))throw Error('Invalid original group command');
  return {command};
 }catch{return {error:'Retained whole-group command is unreadable or differs. Preserve browser storage and original evidence; new choices are blocked.'};}
}
/** The host verifies archives; the client binds every returned package to the original reviewed command. */
export function groupAbandonmentReceiptMatches(command:GroupAbandonmentCommand,value:unknown):boolean {
 if(!value||typeof value!=='object')return false;
 const r=value as Record<string,any>,{input,review}=command,b=r.branch;
 return r.state==='abandoned'&&r.groupId===review.groupId&&r.commandKey===input.commandKey&&r.reviewSha256===input.reviewSha256&&hash(r.captureArchiveSha256)&&b?.schema==='branch-group-custody-abandon.v1'&&b.state==='abandoned'&&sameLifecycleInput(b.input,{executionId:input.executionId,captureKey:input.captureKey,commandKey:input.commandKey,captureSha256:review.captureSha256,expectedRevision:review.branchRevision})&&sameLifecycleInput(b.sources,review.packages.map(p=>p.source))&&Array.isArray(b.packageRetirements)&&b.packageRetirements.every((p:any)=>p&&typeof p==='object')&&new Set(b.packageRetirements.map((p:any)=>p.custodyId)).size===review.packages.length&&b.packageRetirements.length===review.packages.length&&Array.isArray(r.packages)&&r.packages.every((p:any)=>p&&typeof p==='object')&&r.packages.length===review.packages.length&&new Set(r.packages.map((p:any)=>p.custodyId)).size===review.packages.length&&review.packages.every(p=>{
  const receipt=r.packages.find((v:any)=>v.custodyId===p.custodyId),proof=b.packageRetirements.find((v:any)=>v.custodyId===p.custodyId);
  return receipt?.state==='reconciled'&&receipt.commandKey===input.commandKey&&receipt.reviewSha256===p.reviewSha256&&hash(receipt.filesSha256)&&receipt.preservedBytes===p.files.reduce((n,f)=>n+f.byteLength,0)&&proof&&hash(proof.sourceSha256)&&hash(proof.revision);
 });
}
/** Branch receipts also retain raw private snapshots; display only disposition metadata. */
export function groupAbandonmentReceiptSummary(value:unknown):unknown {
 const r=value as Record<string,any>,b=r.branch;
 return {state:r.state,groupId:r.groupId,commandKey:r.commandKey,reviewSha256:r.reviewSha256,captureArchiveSha256:r.captureArchiveSha256,packages:r.packages,branch:{schema:b.schema,state:b.state,input:b.input,sources:b.sources,packageRetirements:b.packageRetirements,createdAt:b.createdAt}};
}

export function groupAbandonmentStorageKey(origin:string,scope:unknown,entry:Pick<LifecycleGroupCaptureEntry,'executionId'|'captureKey'>):string {
 return JSON.stringify(['group-capture-abandonment',origin,scope,entry.executionId,entry.captureKey]);
}
export function retainedGroupAbandonments(origin:string,scope:unknown):{entries:LifecycleGroupCaptureEntry[];error?:string} {
 const entries:LifecycleGroupCaptureEntry[]=[];
 try {
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);if(!key)continue;
   let parts:unknown;try{parts=JSON.parse(key);}catch{continue;}
   if(!Array.isArray(parts)||!sameLifecycleInput(parts.slice(0,3),['group-capture-abandonment',origin,scope]))continue;
   const value=JSON.parse(localStorage.getItem(key)??'null');
   if(!groupCaptureEntryValid(value?.entry)||groupAbandonmentStorageKey(origin,scope,value.entry)!==key||restoreGroupAbandonment(key,value.entry).error)throw Error('Invalid retained group input');
   entries.push(value.entry);
  }
  return {entries};
 }catch{return {entries,error:'Some saved whole-group commands cannot be read. Preserve browser storage; unreadable outcomes remain held.'};}
}
