import type {MemoryMutationHoldDto,MemoryMutationPreserveUnknownInput,MemoryMutationPreserveUnknownReceipt} from '@ponderosa/core';
export interface MemoryPreserveCommand {id:string;holdSha256:string;body:MemoryMutationPreserveUnknownInput}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
export function memoryPreserveCommandValid(value:unknown,id:string):value is MemoryPreserveCommand {
 if(!object(value)||value.id!==id||!hash(value.holdSha256)||!object(value.body))return false;
 const body=value.body;
 return Object.keys(value).every(key=>['id','holdSha256','body'].includes(key))&&Object.keys(body).every(key=>['commandKey','reviewSha256','reason','preserveUnknown'].includes(key))&&typeof body.commandKey==='string'&&Boolean(body.commandKey.trim())&&body.commandKey.length<=256&&hash(body.reviewSha256)&&typeof body.reason==='string'&&body.reason.trim().length>=16&&body.reason.length<=4096&&body.preserveUnknown===true;
}
export function memoryPreserveReceiptMatches(command:MemoryPreserveCommand,value:unknown):value is MemoryMutationPreserveUnknownReceipt {
 if(!memoryPreserveCommandValid(command,command.id)||!object(value))return false;
 return value.version===1&&value.id===command.id&&value.holdSha256===command.holdSha256&&value.commandKey===command.body.commandKey&&value.reviewSha256===command.body.reviewSha256&&value.reason===command.body.reason&&value.operatorId==='local-operator'&&value.disposition==='preserve_unknown'&&value.outcome==='unknown'&&value.held===true&&value.replayed===false&&value.backendModified===false;
}
export function memoryPreserveHoldValid(hold:MemoryMutationHoldDto,id:string):boolean {
 if(!hold||hold.id!==id||hold.state!=='unsettled'||!hash(hold.sha256)||!hash(hold.preserveUnknownReviewSha256))return false;
 if(hold.disposition===undefined)return true;
 const receipt=hold.disposition;
 if(!object(receipt))return false;
 return memoryPreserveReceiptMatches({id,holdSha256:hold.sha256,body:{commandKey:receipt.commandKey,reviewSha256:hold.preserveUnknownReviewSha256!,reason:receipt.reason,preserveUnknown:true}},receipt);
}
export function restoreMemoryPreserveCommand(key:string,id:string):{command?:MemoryPreserveCommand;error?:string} {
 try{
  const bytes=localStorage.getItem(key);if(bytes===null)return {};
  const command:unknown=JSON.parse(bytes);
  if(!memoryPreserveCommandValid(command,id))throw Error('Invalid original command');
  return {command};
 }catch{return {error:'Retained Preserve unknown input unavailable · new commands held'};}
}
