import type {CoordinationDestinationReservation} from '@ponderosa/core';
import {retainedBranchHostGraph} from './branch-tree-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {receiptMatchesSource,resourceCaptureFrontierHash} from './branch-resource-capture.js';
type Row=Record<string,any>;
/** Retained evidence only: does not grant current custody, disclosure or dispatch authority. */
export function destinationResourceEvidence(snapshot:Row,reservation:CoordinationDestinationReservation) {
 const {cut,owners}=retainedBranchHostGraph(snapshot,reservation.sourceExecutionId,true,true);
 if(owners.find(o=>o.executionId===reservation.sourceExecutionId)?.branchId!==reservation.branchId)throw Error('Destination retained root owner differs');
 const tree=snapshot.continuation?.schema==='ponderosa.branch.script-tree-continuation.v1';
 const selected=tree?snapshot.continuation.owners.flatMap((o:Row)=>o.selected.resources):snapshot.selected.resources;
 const resources=reservation.resources??[{custody:reservation.custody,destination:reservation.destination}];
 const ids=(values:string[])=>stableJson([...values].sort());
 if(ids(selected.map((r:Row)=>r.step_execution_id))!==ids(resources.map(r=>r.custody.intent.resourceStepId))
  ||ids(cut.resources.map(e=>e.row.step_execution_id))!==ids(resources.map(r=>r.custody.intent.resourceStepId))
  ||new Set(resources.map(r=>r.custody.sourceChatId)).size!==resources.length)throw Error('Destination retained resource inventory differs');
 for(const r of resources){
  const c=r.custody,owner=owners.find(o=>o.executionId===c.intent.executionId);
  const pin=tree?snapshot.continuation.owners.find((o:Row)=>o.executionId===c.intent.executionId):snapshot.issuedContinuation;
  const local=tree?pin?.selected:snapshot.selected,original=local?.resources.find((v:Row)=>v.step_execution_id===c.intent.resourceStepId);
  const {version,custodyId,boundaryId,sha256,byteLength,...source}=c;
  if(!owner||!pin||!original||local.execution?.[0]?.id!==c.intent.executionId||original.execution_id!==c.intent.executionId
   ||!receiptMatchesSource(c,source)||original.chat_id!==c.sourceChatId||original.generation!==c.intent.resourceGeneration
   ||c.intent.frontierSha256!==resourceCaptureFrontierHash(local)||c.intent.hostCutSha256!==payloadHash(owner.cut)
   ||c.intent.bindingSha256!==pin.bindingHash||c.intent.configurationSha256!==payloadHash(pin.configuration)
   ||stableJson(c.agentIds)!==stableJson(JSON.parse(original.import_operation_json).result.agentIds)
   ||ids(c.agentIds)!==ids(owner.cut.resourceMembers.filter(e=>e.row.step_execution_id===original.step_execution_id).map(e=>e.row.agent_id)))throw Error('Destination retained per-owner custody differs');
 }
 return {cut,owners};
}
