import {hostUpdateFact,verifyHostProvenance} from './branch-host-provenance.js';
import type {BranchDefinition} from '@ponderosa/core';
import type {Selected} from './branch-script-continuation.js';
import {verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {validateHistoricalRequest} from './coordination-v3-cut-restoration-authority.js';
import {branchText} from './branch-definition.js';

/** Shared ownership boundary; graph replay must separately prove each binding and audit event. */
export function issuedRequestFrontierSupported(selected:Selected,definition:BranchDefinition,hostCut?:BranchHostCut):boolean {
 try {
  const issued=selected.attempts?.filter(a=>a.request_id)??[];
  if(issued.length){
    if(!hostCut||!verifyBranchHostCut(hostCut,selected.execution![0]!.id)||!hostCut.coverage.complete
      ||hostCut.roots.length!==issued.length||new Set(hostCut.roots.map(root=>root.attemptId)).size!==issued.length
      ||new Set(issued.map(a=>a.request_id)).size!==issued.length||hostCut.resources.length)return false;
    verifyHostProvenance(hostCut);
    for(const a of issued){
      const s=selected.steps!.find(s=>s.id===a.step_execution_id),node=definition.steps.find(n=>n.id===s?.step_id),r=hostCut.requests.find(({row})=>row.id===a.request_id)?.row;
      if(node?.kind!=='agent'||!('ref' in node.target)||!r||r.id!==`branch:${a.id}`&&!hostCut.provenance?.restorations.some(e=>Object.values(JSON.parse(e.row.receipt.receipt_json).requestMap).includes(r.id))||r.requester_agent_id!==null||r.communication_event_id!==null
        ||!hostCut.roots.some(root=>root.attemptId===a.id&&root.requestId===r.id&&!root.recoveryOfRequestId)
        ||!['open','in_progress','awaiting_answer','waiting_dependency','completed'].includes(r.state)||a.fence!==0
        ||!['waiting','completed'].includes(a.state)||a.state==='completed'&&r.state!=='completed'||r.state==='completed'&&node.requireUserCommunication)return false;
      validateHistoricalRequest(r,hostCut.updates.filter(({row})=>row.request_id===r.id).map(({row})=>row).sort((a,b)=>a.resulting_version-b.resulting_version),hostCut);
    }
  }
  return true;
 }catch{return false;}
}

/** Only an exact selected terminal version can supply a historical Step result. */
export function retainedAgentResult(cut:BranchHostCut|undefined,requestId:string):{failed:false;output?:string}|undefined {
 const request=cut?.requests.find(({row})=>row.id===requestId)?.row;
 const update=cut?.updates.find(({row})=>row.request_id===requestId&&row.resulting_version===request?.version)?.row;
 if(request?.state!=='completed'||!update||update.resulting_state!=='completed')return;
 const payload=hostUpdateFact(cut!,update).payload as Record<string,any>,output=typeof payload?.text==='string'?branchText(payload.text):undefined;
 return {failed:false,...(output!==undefined?{output}:{})};
}
