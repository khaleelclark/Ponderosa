import type {NativeTaskInventory,NativeTaskStopRequest,NativeTaskStopReceipt} from '@ponderosa/core';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=4096):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export function nativeTaskCommandValid(v:unknown):v is NativeTaskStopRequest {
 return object(v)&&Object.keys(v).length===5&&text(v.runId,200)&&Number.isSafeInteger(v.sourceFence)&&(v.sourceFence as number)>0&&text(v.sessionId)&&text(v.taskKey)&&text(v.idempotencyKey,200);
}
export function nativeTaskInventoryValid(v:unknown):v is NativeTaskInventory {
 if(!object(v)||!text(v.runId,200)||!Number.isSafeInteger(v.sourceFence)||(v.sourceFence as number)<1||!text(v.sessionId)||!Array.isArray(v.tasks)||v.tasks.length>1000)return false;
 return v.tasks.every(t=>object(t)&&text(t.taskKey)&&text(t.taskId)&&text(t.kind)&&typeof t.cancellable==='boolean'&&['taskRunId','itemId','processId'].every(k=>t[k]===undefined||text(t[k])))&&new Set(v.tasks.map(t=>t.taskKey)).size===v.tasks.length;
}
export const nativeTaskTarget=(v:NativeTaskStopRequest)=>JSON.stringify([v.runId,v.sourceFence,v.sessionId,v.taskKey]);
export function nativeTaskReceiptMatches(command:NativeTaskStopRequest,v:unknown):v is NativeTaskStopReceipt {
 return nativeTaskCommandValid(command)&&object(v)&&nativeTaskCommandValid({runId:v.runId,sourceFence:v.sourceFence,sessionId:v.sessionId,taskKey:v.taskKey,idempotencyKey:v.idempotencyKey})&&nativeTaskTarget(v as unknown as NativeTaskStopRequest)===nativeTaskTarget(command)&&v.idempotencyKey===command.idempotencyKey&&object(v)&&['acknowledged','terminated','not_found','unknown'].includes(String(v.outcome))&&v.processDrainObserved===false;
}
export function nativeTaskRecoveryPath(base:string,c:NativeTaskStopRequest):string {
 return `${base}/stops/${encodeURIComponent(c.idempotencyKey)}?${new URLSearchParams({runId:c.runId,sourceFence:String(c.sourceFence),sessionId:c.sessionId,taskKey:c.taskKey})}`;
}
