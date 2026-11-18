import {createHash} from 'node:crypto';
import type {CheckpointPackageReceipt,CheckpointPackageSource} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import type {Selected} from './branch-script-continuation.js';

export interface BranchResourceCapture {
 schema:'branch-resource-capture.v1';state:'capturing'|'retained'|'releasing'|'released';
 source:CheckpointPackageSource;receipt?:CheckpointPackageReceipt;error?:string;
}
/** The capture journal cannot hash itself; every selected frontier fact still participates. */
export function resourceCaptureFrontierHash(selected:Selected):string {
 const copy=JSON.parse(stableJson(selected)) as Selected;
 for(const r of copy.resources??[])delete r.capture_json;
 return payloadHash(copy);
}
export function resourceCapture(row:Record<string,any>):BranchResourceCapture|undefined {
 if(!row.capture_json)return;
 const c=JSON.parse(row.capture_json) as BranchResourceCapture;
 if(stableJson(c)!==row.capture_json||c.schema!=='branch-resource-capture.v1'||!['capturing','retained','releasing','released'].includes(c.state))throw Error('Resource capture journal integrity failure');
 return c;
}
export function receiptMatchesSource(receipt:CheckpointPackageReceipt,source:CheckpointPackageSource):boolean {
 const {version,custodyId,boundaryId,sha256,byteLength,...original}=receipt;
 return version===1&&custodyId===createHash('sha256').update(source.checkpointId).digest('hex')&&typeof boundaryId==='string'&&!!boundaryId
  &&/^[a-f0-9]{64}$/.test(sha256)&&Number.isSafeInteger(byteLength)&&byteLength>0&&stableJson(original)===stableJson(source);
}
export function retainedResourceCapture(selected:Selected):BranchResourceCapture|undefined {
 try{
  if(selected.resources?.length!==1)return;
  const r=selected.resources[0]!,c=resourceCapture(r),e=selected.execution?.[0];
  if(!c||c.state!=='retained'||!c.receipt||!e||!receiptMatchesSource(c.receipt,c.source))return;
  const i=c.source.intent,chat=JSON.parse(r.chat_operation_json),imported=JSON.parse(r.import_operation_json);
  if(i.executionId!==e.id||i.resourceStepId!==r.step_execution_id||i.resourceGeneration!==r.generation||i.frontierSha256!==resourceCaptureFrontierHash(selected)
   ||c.source.sourceChatId!==r.chat_id||stableJson(c.source.agentIds)!==stableJson(imported.result?.agentIds)
   ||chat?.state!=='completed'||chat.result?.chatId!==r.chat_id||imported?.state!=='completed'||!imported.creationOperationId
   ||imported.result?.rootAgentId!==r.root_agent_id||c.source.agentIds.length!==r.requested_count||!c.source.agentIds.includes(r.root_agent_id))return;
  return c;
 }catch{return;}
}
