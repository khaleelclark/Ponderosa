import type {BranchRunCountsDto} from '@ponderosa/core';
import type {SemanticStatusKind} from '../SemanticStatus';

/** Counts are projections, never a substitute for decisions or Run outcomes. */
export function branchRunStatus(counts?:BranchRunCountsDto,unavailable=false):{status:SemanticStatusKind;label:string;compact:string;lines:string[]} {
  if(!counts||![counts.running,counts.waiting,counts.queued].every(value=>Number.isSafeInteger(value)&&value>=0)){
    const label=unavailable?'Run status unavailable':'Run status loading…';
    return {status:unavailable?'needs_attention':'waiting',label,compact:unavailable?'!':'…',lines:['Workflow Runs',label]};
  }
  const pending=counts.waiting+counts.queued;
  return {status:counts.running>0?'running':pending>0?'waiting':'idle',label:counts.running+' Running'+(pending?' · '+pending+' Pending':''),
    compact:counts.running+(pending?' / '+pending:''),lines:['Workflow Runs','Running: '+counts.running,'Waiting: '+counts.waiting,'Queued: '+counts.queued,...(unavailable?['Updates delayed']:[])]};
}
