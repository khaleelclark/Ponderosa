import type {BranchRunStatus,BranchExecutionDto,BranchRunCountsDto} from '@ponderosa/core';
import {semanticAgentStatus,type SemanticStatusKind} from '../SemanticStatus';

/** Labels and filter order for the server's single effective-status projection. */
export const BRANCH_STATUS_FILTERS:ReadonlyArray<{value:BranchRunStatus;label:string}>=[
 {value:'queued',label:'Queued'},{value:'running',label:'Running'},{value:'waiting',label:'Waiting'},{value:'retrying',label:'Retrying'},
 {value:'stopping',label:'Stopping'},{value:'needs_attention',label:'Needs Attention'},{value:'completed',label:'Completed'},
 {value:'failed',label:'Failed'},{value:'canceled',label:'Canceled'},{value:'skipped',label:'Skipped'},{value:'merged',label:'Merged'}];
const label=new Map(BRANCH_STATUS_FILTERS.map(item=>[item.value,item.label]));
const countKeys=[['running','Running'],['queued','Queued'],['waiting','Waiting'],['retrying','Retrying'],['stopping','Stopping'],['needsAttention','Needs Attention']] as const;

/** A Run's displayed status: the server classification while active, its stored outcome once terminal. */
export function branchExecutionStatusValue(run:BranchExecutionDto):BranchRunStatus {
 return ['queued','running','waiting'].includes(run.state)?run.effectiveStatus??run.state:run.state;
}

export function branchExecutionStatus(run:BranchExecutionDto):{status:SemanticStatusKind;label:string} {
 const value=branchExecutionStatusValue(run);
 return {status:value==='needs_attention'?'needs_attention':value==='running'?'running':['queued','waiting','retrying','stopping'].includes(value)?'waiting':semanticAgentStatus(value),label:label.get(value)??value};
}

/** Counts are projections, never a substitute for decisions or Run outcomes. */
export function branchRunStatus(counts?:BranchRunCountsDto,unavailable=false):{status:SemanticStatusKind;label:string;compact:string;lines:string[];total?:number} {
 if(!counts||!countKeys.every(([key])=>Number.isSafeInteger(counts[key])&&counts[key]>=0)){
  const text=unavailable?'Run status unavailable':'Run status loading…';
  return {status:unavailable?'needs_attention':'waiting',label:text,compact:unavailable?'!':'…',lines:['Workflow Runs',text]};
 }
 const present=countKeys.filter(([key])=>counts[key]>0),total=countKeys.reduce((sum,[key])=>sum+counts[key],0),other=total-counts.running;
 return {status:counts.needsAttention>0?'needs_attention':counts.running>0?'running':total>0?'waiting':'idle',
  label:present.length?present.map(([key,name])=>counts[key]+' '+name).join(' · '):'0 Running',
  compact:counts.running+(other?' / '+other:''),total,
  lines:['Workflow Runs',...countKeys.map(([key,name])=>name+': '+counts[key]),...(unavailable?['Updates delayed']:[])]};
}
