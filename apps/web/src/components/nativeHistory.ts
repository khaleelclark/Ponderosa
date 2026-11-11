import type {AgentDto,HistoryBoundary,HistoryReceipt,NativeHistoryInventory,NativeHistoryOperationRequest,NativeHistoryTrackingResponse,NativeRewindFileFact} from '@ponderosa/core';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=200):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const date=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export type SavedNativeHistoryCommand={boundary:HistoryBoundary;body:NativeHistoryOperationRequest;preview?:{body:Extract<NativeHistoryOperationRequest,{operation:'preview'}>;receipt:HistoryReceipt};cancelRequested?:true};
export async function nativeHistoryHash(value:unknown):Promise<string> {
 if(!globalThis.crypto?.subtle)throw Error('SHA-256 verification unavailable · native actions held');
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function nativeBoundaryValid(value:unknown):value is HistoryBoundary {
 if(!object(value))return false;
 return Object.keys(value).length===9&&['agentId','projectId','conversationId','engine','sessionId','runId'].every(key=>text(value[key]))&&count(value.fence)&&value.fence>0&&hash(value.toolContractHash)&&text(value.rootPath,4096);
}
export async function nativeInventoryValid(value:unknown,agent:AgentDto):Promise<boolean> {
 if(!object(value)||!nativeBoundaryValid(value.boundary)||!hash(value.boundaryHash)||typeof value.held!=='boolean'||!object(value.catalog)||!Array.isArray(value.eligibleTargets))return false;
 const b=value.boundary,c=value.catalog;
 if(agent.workingCopy.state!=='ready'||b.agentId!==agent.id||b.projectId!==agent.projectId||b.conversationId!==agent.conversationId||b.engine!==agent.activeEngine||b.rootPath!==agent.workingCopy.rootPath||await nativeHistoryHash(b)!==value.boundaryHash||c.sessionId!==b.sessionId||typeof c.fileRewindSupported!=='boolean'||typeof c.transcriptForkSupported!=='boolean'||(c.trackingEnabled!==undefined&&typeof c.trackingEnabled!=='boolean'))return false;
 if(!Array.isArray(c.checkpoints)||!Array.isArray(c.forkPoints)||c.checkpoints.length>10000||c.forkPoints.length>10000)return false;
 if(!c.checkpoints.every(v=>object(v)&&v.sessionId===b.sessionId&&text(v.messageId))||new Set(c.checkpoints.map(v=>v.messageId)).size!==c.checkpoints.length||!c.forkPoints.every(v=>text(v))||new Set(c.forkPoints).size!==c.forkPoints.length)return false;
 return value.eligibleTargets.every(v=>object(v)&&text(v.agentId)&&v.agentId!==b.agentId)&&new Set(value.eligibleTargets.map(v=>v.agentId)).size===value.eligibleTargets.length&&!(b.engine==='codex'&&c.fileRewindSupported);
}
export function nativeTrackingValid(value:unknown):value is NativeHistoryTrackingResponse {
 return object(value)&&object(value.preference)&&typeof value.preference.enabled==='boolean'&&value.preference.appliesTo==='next_native_session'&&(value.preference.updatedAt===undefined||date(value.preference.updatedAt))&&(value.currentSession===undefined||object(value.currentSession)&&text(value.currentSession.sessionId)&&typeof value.currentSession.trackingEnabled==='boolean');
}
export function nativeSavedCommandValid(value:unknown,agentId:string):value is SavedNativeHistoryCommand {
 if(!object(value)||Object.keys(value).some(key=>!['boundary','body','preview','cancelRequested'].includes(key))||!nativeBoundaryValid(value.boundary)||value.boundary.agentId!==agentId||!object(value.body)||(value.cancelRequested!==undefined&&value.cancelRequested!==true))return false;
 const b=value.body;
 if(!text(b.idempotencyKey)||!hash(b.boundaryHash))return false;
 const fields=b.operation==='preview'?['operation','idempotencyKey','boundaryHash','checkpointId']:b.operation==='rewind'?['operation','idempotencyKey','boundaryHash','checkpointId','previewKey','acknowledgeFileChanges']:b.operation==='fork'?['operation','idempotencyKey','boundaryHash','targetAgentId','throughId','acknowledgeHistoryCopy']:[];
 if(!fields.length||Object.keys(b).length!==fields.length||Object.keys(b).some(key=>!fields.includes(key)))return false;
 if(b.operation!=='rewind'&&value.preview!==undefined)return false;
 if(b.operation==='rewind'&&(!object(value.preview)||!nativeSavedCommandValid({boundary:value.boundary,body:value.preview.body},agentId)))return false;
 return (b.operation==='preview'&&text(b.checkpointId)||b.operation==='rewind'&&text(b.checkpointId)&&text(b.previewKey)&&b.acknowledgeFileChanges===true&&object(value.preview)&&object(value.preview.body)&&value.preview.body.operation==='preview'&&object(value.preview.receipt)||b.operation==='fork'&&text(b.throughId)&&text(b.targetAgentId)&&b.targetAgentId!==agentId&&b.acknowledgeHistoryCopy===true)&&(value.cancelRequested===undefined||b.operation==='fork');
}
export function nativeFactValid(value:unknown):value is NativeRewindFileFact {
 if(!object(value)||!text(value.path,4096)||!Array.isArray(value.ancestors)||!value.ancestors.length||value.ancestors.length>4096||!value.ancestors.every(v=>Array.isArray(v)&&v.length===6&&text(v[0],4096)&&v.slice(1).every(count)))return false;
 return value.type==='absent'&&Object.keys(value).every(key=>['path','ancestors','type'].includes(key))||value.type==='file'&&Object.keys(value).length===10&&['dev','ino','mode','uid','gid','size'].every(key=>count(value[key]))&&(value.size as number)<=16*1024*1024&&hash(value.hash);
}
export async function nativeReceiptMatches(command:SavedNativeHistoryCommand,value:unknown):Promise<boolean> {
 if(!nativeSavedCommandValid(command,command.boundary.agentId)||!object(value)||!text(value.id)||value.key!==command.body.idempotencyKey||value.kind!==command.body.operation||JSON.stringify(value.boundary)!==JSON.stringify(command.boundary)||!date(value.createdAt)||!hash(value.inputHash)||!hash(value.requestHash))return false;
 if(await nativeHistoryHash(command.boundary)!==command.body.boundaryHash||await nativeHistoryHash(command.body)!==value.requestHash||await nativeHistoryHash({boundary:command.boundary,kind:command.body.operation,input:command.body})!==value.inputHash)return false;
 if(command.body.operation==='rewind') {
  const preview=command.preview;
  if(!preview||preview.body.idempotencyKey!==command.body.previewKey||preview.body.boundaryHash!==command.body.boundaryHash||preview.body.checkpointId!==command.body.checkpointId||!await nativeReceiptMatches({boundary:command.boundary,body:preview.body},preview.receipt)||preview.receipt.kind!=='preview'||preview.receipt.state!=='completed'||preview.receipt.result?.native?.canRewind!==true)return false;
 }
 if(command.body.operation==='fork') {
  if(!['prepared','started','opened','cancelled'].includes(String(value.state))||value.targetAgentId!==command.body.targetAgentId||value.throughId!==command.body.throughId||!text(value.newSessionId)||value.newSessionId===command.boundary.sessionId)return false;
  if(value.targetRunId!==undefined&&!text(value.targetRunId)||value.targetFence!==undefined&&(!count(value.targetFence)||value.targetFence===0))return false;
  if((value.targetRunId===undefined)!==(value.targetFence===undefined))return false;
  if(value.state==='opened'&&(!object(value.result)||!value.targetRunId))return false;
  if(value.result!==undefined&&(!object(value.result)||value.result.nativeSessionId!==value.newSessionId||value.result.contextAccepted!==false||value.result.replayAuthorized!==false))return false;
  return true;
 }
 if(!['started','completed'].includes(String(value.state)))return false;
 if(value.result===undefined)return value.state==='started';
 if(!object(value.result)||value.result.boundaryHash!==command.body.boundaryHash||!object(value.result.native))return false;
 const n=value.result.native;
 if(n.sessionId!==command.boundary.sessionId||n.messageId!==command.body.checkpointId||n.dryRun!==(command.body.operation==='preview')||!['completed','outcome_unknown'].includes(String(n.outcome))||(n.canRewind!==undefined&&typeof n.canRewind!=='boolean')||(n.error!==undefined&&!text(n.error,8192)))return false;
 if(['insertions','deletions','skippedLinks'].some(key=>n[key]!==undefined&&!count(n[key]))||n.filesChanged!==undefined&&(!Array.isArray(n.filesChanged)||n.filesChanged.length>10000||!n.filesChanged.every(v=>text(v,4096))))return false;
 if(value.state==='completed'&&(n.outcome!=='completed'||typeof n.canRewind!=='boolean')||value.state==='started'&&n.outcome!=='outcome_unknown')return false;
 const facts=value.result.facts;
 if(facts!==undefined&&(!Array.isArray(facts)||facts.length>1000||!facts.every(nativeFactValid)||new Set(facts.map(v=>v.path)).size!==facts.length||facts.reduce((bytes,v)=>bytes+(v.type==='file'?v.size:0),0)>64*1024*1024||!facts.every(v=>factWithinRoot(v,command.boundary.rootPath))))return false;
 if(command.body.operation==='preview'&&value.state==='completed'&&(!Array.isArray(facts)||n.canRewind===true&&!Array.isArray(n.filesChanged)))return false;
 return true;
}
export function nativePreviewFresh(receipt:HistoryReceipt|undefined,inventory:NativeHistoryInventory|undefined,checkpointId:string,now=Date.now()):boolean {
 return !!receipt&&!!inventory&&!inventory.held&&receipt.kind==='preview'&&receipt.state==='completed'&&receipt.result?.native?.canRewind===true&&receipt.result.native.outcome==='completed'&&receipt.result.native.messageId===checkpointId&&receipt.result.boundaryHash===inventory.boundaryHash&&JSON.stringify(receipt.boundary)===JSON.stringify(inventory.boundary)&&now>=Date.parse(receipt.createdAt)&&now-Date.parse(receipt.createdAt)<=60000;
}

function factWithinRoot(fact:NativeRewindFileFact,root:string):boolean {
 const within=(path:string)=>path===root||((path.startsWith(root.endsWith('/')||root.endsWith('\\')?root:root+'/')||path.startsWith(root.endsWith('\\')?root:root+'\\'))&&!path.split(/[\\/]/).includes('..'));
 return fact.path!==root&&within(fact.path)&&fact.ancestors.at(-1)?.[0]===root&&fact.ancestors.every(row=>within(row[0]));
}
