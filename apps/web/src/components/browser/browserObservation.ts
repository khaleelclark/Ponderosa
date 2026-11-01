import type {BrowserConsoleQuery,BrowserConsoleResult,BrowserOperatorObservationContext,BrowserOperatorRecordingResult,BrowserRecordingData,BrowserRecordingStatus} from '@ponderosa/core';

const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;
export type RecordingCommand={context:BrowserOperatorObservationContext}&({operation:'start';pageId:string;previousRecordingId?:string}|{operation:'stop';recordingId:string});
export function recordingCommandValid(value:unknown):value is RecordingCommand {
 if(!value||typeof value!=='object')return false;
 const v=value as RecordingCommand;
 return !!v.context&&id(v.context.sessionId)&&Number.isSafeInteger(v.context.expectedControlEpoch)&&v.context.expectedControlEpoch>=0&&
  ((v.operation==='start'&&id(v.pageId)&&(v.previousRecordingId===undefined||id(v.previousRecordingId)))||(v.operation==='stop'&&id(v.recordingId)));
}
export function recordingStatusValid(value:unknown):value is BrowserRecordingStatus {
 const v=value as BrowserRecordingStatus;
 return !!v&&id(v.id)&&id(v.pageId)&&typeof v.startedAt==='string'&&Number.isFinite(Date.parse(v.startedAt));
}
const reasons=['explicit_stop','duration_limit','frame_limit','byte_limit','page_closed'];
export function recordingArtifactValid(value:unknown,projectId:string):value is BrowserOperatorRecordingResult {
 const v=value as BrowserOperatorRecordingResult;
 return !!v&&id(v.artifactId)&&v.artifactRef===`ponderosa://artifact/${v.artifactId}`&&v.path===`browser/${v.artifactId}.recording.json`&&v.mediaType==='application/json'&&Number.isSafeInteger(v.frames)&&v.frames>0&&v.frames<=120&&reasons.includes(v.reason)&&
  v.downloadUrl===`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(v.artifactId)}/download`;
}
export function consoleResultValid(value:unknown,pageId:string,after?:number,level?:BrowserConsoleQuery['level']):value is BrowserConsoleResult {
 const v=value as BrowserConsoleResult;
 if(!v||!Array.isArray(v.entries)||v.entries.length>100||!Number.isSafeInteger(v.next)||v.next<0||typeof v.truncated!=='boolean')return false;
 let previous=after??0;
 return v.entries.every(entry=>{
  if(!entry||!Number.isSafeInteger(entry.sequence)||entry.sequence<=previous||entry.sequence>v.next||entry.pageId!==pageId||(level!==undefined&&entry.level!==level)||!['log','info','warning','error'].includes(entry.level)||typeof entry.text!=='string'||entry.text.length>4000||!Number.isFinite(Date.parse(entry.at)))return false;
  previous=entry.sequence;return true;
 })&&(after===undefined||v.next>=after);
}
/** Validate managed frame bytes before using a data URL; no HTML, remote images or invented video. */
export function recordingDataValid(value:unknown,status:BrowserRecordingStatus,artifact:BrowserOperatorRecordingResult):value is BrowserRecordingData {
 const v=value as BrowserRecordingData;
 if(!v||v.format!=='ponderosa.browser-recording.v1'||v.id!==status.id||v.pageId!==status.pageId||v.startedAt!==status.startedAt||!Number.isFinite(Date.parse(v.endedAt))||Date.parse(v.endedAt)<Date.parse(v.startedAt)||v.reason!==artifact.reason||!Array.isArray(v.frames)||v.frames.length!==artifact.frames||v.frames.length>120||v.frames.length===0)return false;
 let previous=-1,bytes=0;
 return v.frames.every(frame=>{
  if(!frame||!Number.isFinite(frame.atMs)||frame.atMs<previous||frame.atMs<0||frame.atMs>60000||typeof frame.jpeg!=='string'||!/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(frame.jpeg)||frame.jpeg.length%4!==0)return false;
  previous=frame.atMs;bytes+=frame.jpeg.length;return bytes<=8*1024*1024;
 });
}
