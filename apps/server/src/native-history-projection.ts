import { isProxy } from "node:util/types";
import type { NativeHistoryCatalog, NativeFileRewindResult } from "@ponderosa/core";
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid native history data");
  const out: Record<string,unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) throw new Error("Unexpected native history field");
    const d=Object.getOwnPropertyDescriptor(value,key);
    if (!d || !("value" in d)) throw new Error("Invalid native history descriptor");
    out[key]=d.value;
  }
  return out;
}
function text(v: unknown, max=200): string {
  if (typeof v !== "string" || !v || v.length>max || /[\u0000-\u001f\u007f]/u.test(v)) throw new Error("Invalid native history string");
  return v;
}
function array<T>(v: unknown, project:(v:unknown)=>T): T[] {
  if (!v || typeof v!=="object" || isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v)!==Array.prototype || v.length>10000) throw new Error("Invalid native history list");
  const out:T[]=[];
  for(let i=0;i<v.length;i++) {
    const d=Object.getOwnPropertyDescriptor(v,String(i));
    if(!d || !("value" in d)) throw new Error("Invalid native history list entry");
    out.push(project(d.value));
  }
  if(Reflect.ownKeys(v).length!==v.length+1) throw new Error("Unexpected native history list field");
  return out;
}
export function projectNativeHistory(value: unknown): NativeHistoryCatalog {
  const r=record(value,["sessionId","checkpoints","forkPoints","fileRewindSupported","transcriptForkSupported","trackingEnabled"]);
  if(typeof r.fileRewindSupported!=="boolean" || typeof r.transcriptForkSupported!=="boolean") throw new Error("Invalid history support");
  if(r.trackingEnabled!==undefined && typeof r.trackingEnabled!=="boolean")throw new Error("Invalid tracking flag");
  const sessionId=text(r.sessionId);
  return {...(typeof r.trackingEnabled==="boolean"?{trackingEnabled:r.trackingEnabled}:{}),sessionId,fileRewindSupported:r.fileRewindSupported,transcriptForkSupported:r.transcriptForkSupported,
    forkPoints:array(r.forkPoints,v=>text(v)),checkpoints:array(r.checkpoints,v=>{
      const c=record(v,["sessionId","messageId"]);
      if(c.sessionId!==sessionId) throw new Error("Checkpoint owner changed");
      return {sessionId,messageId:text(c.messageId)};
    })};
}
export function projectNativeRewind(value: unknown): NativeFileRewindResult {
  const r=record(value,["sessionId","messageId","dryRun","outcome","canRewind","error","filesChanged","insertions","deletions","skippedLinks"]);
  if(typeof r.dryRun!=="boolean" || !["completed","outcome_unknown"].includes(String(r.outcome))) throw new Error("Invalid rewind outcome");
  const out:NativeFileRewindResult={sessionId:text(r.sessionId),messageId:text(r.messageId),dryRun:r.dryRun,outcome:r.outcome as NativeFileRewindResult['outcome']};
  if(r.canRewind!==undefined) {if(typeof r.canRewind!=="boolean")throw new Error("Invalid canRewind");out.canRewind=r.canRewind;}
  if(r.error!==undefined)out.error=text(r.error,8192);
  if(r.filesChanged!==undefined)out.filesChanged=array(r.filesChanged,v=>text(v,4096));
  for(const key of ["insertions","deletions","skippedLinks"] as const) {
    if(r[key]===undefined)continue;
    if(!Number.isSafeInteger(r[key]) || (r[key] as number)<0)throw new Error("Invalid native rewind count");
    out[key]=r[key] as number;
  }
  if(out.outcome==='completed' && out.canRewind===undefined)throw new Error("Missing native rewind receipt");
  return out;
}
