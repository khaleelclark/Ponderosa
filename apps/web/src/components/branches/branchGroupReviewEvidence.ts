import type {BranchIssuedGroupDestinationDto} from '@ponderosa/core';
import {sameLifecycleInput} from '../lifecycle/lifecycleCommand';
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const positive=(value:unknown):value is number=>count(value)&&value>0;
const nullableText=(value:unknown)=>value===null||text(value);
const map=(value:unknown):value is Record<string,string>=>object(value)&&Object.keys(value).length>0&&Object.entries(value).every(([a,b])=>text(a)&&text(b))&&new Set(Object.values(value)).size===Object.keys(value).length;
/** Validate present saved evidence; missing legacy evidence never supplies substitute numbers. */
export function groupReviewEvidenceMatches(target:BranchIssuedGroupDestinationDto):boolean {
 try{
 const v=target.reviewEvidence;
 if(v===undefined)return true;
 if(!v||typeof v!=='object')return false;
 if(v.state==='unavailable')return v.reason==='legacy_missing_saved_evidence'&&Object.keys(v).every(k=>['state','reason'].includes(k));
 if(v.state!=='verified'||!/^[a-f0-9]{64}$/.test(v.evidenceHash)||!['prospective','committed'].includes(v.ancestry)||target.state==='admitted'&&v.ancestry!=='committed'||target.state!=='admitted'&&v.ancestry!=='prospective'||!map(v.idMap)||!map(v.ownerMap)||!Array.isArray(v.owners)||!Array.isArray(target.resources))return false;
 const originals=[...new Set(target.resources.map(r=>r.custody.intent.executionId))];
 if(v.owners.length!==originals.length||new Set(v.owners.map(o=>o?.sourceExecutionId)).size!==originals.length||!sameLifecycleInput(Object.keys(v.ownerMap).sort(),originals.sort())||target.ownerMap&&!sameLifecycleInput(v.ownerMap,target.ownerMap)||Object.values(v.ownerMap).some(id=>originals.includes(id)))return false;
 const roots=v.owners.filter(o=>o?.sourceParentExecutionId===null);
 if(roots.length!==1||v.owners.some(o=>o!==roots[0]&&o.sourceParentExecutionId!==roots[0]!.sourceExecutionId))return false;
 return v.owners.every(o=>{
  if(!o||!text(o.branchId)||!originals.includes(o.sourceExecutionId)||o.destinationExecutionId!==v.ownerMap[o.sourceExecutionId]||!target.resources.filter(r=>r.custody.intent.executionId===o.sourceExecutionId).every(r=>r.destination.executionId===o.destinationExecutionId&&v.idMap[r.custody.intent.resourceStepId]===r.destination.resourceStepId))return false;
  if(![o.sourceParentExecutionId,o.sourceParentAttemptId,o.destinationParentExecutionId,o.destinationParentAttemptId].every(nullableText))return false;
  if(o.sourceParentExecutionId===null){if(o.sourceParentAttemptId!==null||o.destinationParentExecutionId!==null||o.destinationParentAttemptId!==null)return false;}
  else if(o.sourceParentAttemptId===null||v.ownerMap[o.sourceParentExecutionId]!==o.destinationParentExecutionId||v.idMap[o.sourceParentAttemptId]!==o.destinationParentAttemptId)return false;
  const c=o.counters,u=o.selectedUsage,p=o.policy,capacity=o.capacity,limits=o.limits,a=o.acceptance,b=a?.budget;
  if(!object(c)||!(['traversals','loopIterations','recoveryTraversals','callDepth','depthCeiling'] as const).every(k=>count(c[k]))||!Array.isArray(c.paths)||!Array.isArray(c.steps)||!Array.isArray(c.loops))return false;
  if(!c.paths.every(x=>x&&text(x.sourcePathId)&&v.idMap[x.sourcePathId]===x.destinationPathId&&count(x.traversals))||new Set(c.paths.map(x=>x.sourcePathId)).size!==c.paths.length)return false;
  if(!c.steps.every(x=>x&&text(x.sourceStepExecutionId)&&v.idMap[x.sourceStepExecutionId]===x.destinationStepExecutionId&&positive(x.invocation))||new Set(c.steps.map(x=>x.sourceStepExecutionId)).size!==c.steps.length)return false;
  if(!c.loops.every(x=>x&&text(x.sourcePathId)&&v.idMap[x.sourcePathId]===x.destinationPathId&&text(x.edgeId)&&count(x.iterations)))return false;
  if(!object(u)||u.paths!==c.paths.length||u.stepInvocations!==c.steps.length||!count(u.requestedAgents)||!object(capacity)||!(['maxConcurrentExecutions','maxPathInstances','maxStepInvocations','maxEphemeralAgents'] as const).every(k=>positive(capacity[k]))||!object(limits)||!['maxCallDepth','maxLoopIterations','maxTraversals'].every(k=>positive(limits[k])))return false;
  if(!object(p)||p.maxConcurrentExecutions!==capacity.maxConcurrentExecutions||(['maxPathInstances','maxStepInvocations','maxEphemeralAgents'] as const).some(k=>p[k]!==undefined&&p[k]!==capacity[k])||!object(p.failure)||!['stop','ask_human','retry','recover'].includes(String(p.failure.action)))return false;
  if(!a||!text(a.source)||!text(a.admittedAt)||!['manual','charged','unlimited'].includes(a.kind)||!b||b.branchId!==o.branchId||!['revision','used','allowance','heldCount'].every(k=>count(b[k as keyof typeof b]))||!text(b.observedAt)||!nullableText(b.periodId)||!nullableText(b.periodStartedAt)||b.resetsAt!==undefined&&!text(b.resetsAt))return false;
  if((p.failure.action==='retry'||p.failure.action==='recover')&&(!positive(p.failure.maxAttempts)||p.failure.maxAttempts>100))return false;
  if(p.failure.action==='retry'&&(!count(p.failure.delayMs)||p.failure.freshContext!==undefined&&typeof p.failure.freshContext!=='boolean')||p.failure.action==='recover'&&!text(p.failure.agentRef))return false;
  if(b.policy!==null&&(!object(b.policy)||!positive(b.policy.limit)||!['day','week','month','lifetime'].includes(b.policy.period)))return false;
  return true;
 });
 }catch{return false;}
}
