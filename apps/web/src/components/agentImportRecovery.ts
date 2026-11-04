import {AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_METADATA_MAX_BYTES,type ImportAgentPackageRequest} from '@ponderosa/core';
import {AGENT_IMPORT_FINGERPRINT_ALGORITHM,type AgentImportFingerprint} from './agentImportFingerprint';
type Product='dev'|'branches';
export type AgentImportMetadata=Omit<ImportAgentPackageRequest,'package'>;
export type PendingAgentImport={version:1;requestId:string;projectId:string;conversationId:string;product:Product;metadata:AgentImportMetadata;fingerprint:AgentImportFingerprint};
const id=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const prefix=(product:Product,projectId:string)=>`ponderosa-agent-import-v1:${product}:${encodeURIComponent(projectId)}:`;
const key=(value:PendingAgentImport)=>prefix(value.product,value.projectId)+value.requestId;
/** Invalid original evidence remains held; it never authorizes a new request. */
export function pendingAgentImportValid(value:unknown,product:Product,projectId:string):value is PendingAgentImport{
 if(!object(value)||Object.keys(value).sort().join(',')!=='conversationId,fingerprint,metadata,product,projectId,requestId,version'||value.version!==1||value.product!==product||value.projectId!==projectId||!id(value.requestId,128)||! /^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)||!id(value.conversationId,200)||!object(value.metadata)||value.metadata.conversationId!==value.conversationId||!object(value.fingerprint))return false;
 const f=value.fingerprint;
 if(Object.keys(f).sort().join(',')!=='algorithm,bytes,digest'||f.algorithm!==AGENT_IMPORT_FINGERPRINT_ALGORITHM||!Number.isSafeInteger(f.bytes)||Number(f.bytes)<0||Number(f.bytes)>AGENT_PACKAGE_MAX_BYTES||typeof f.digest!=='string'||! /^[0-9a-f]{64}$/.test(f.digest))return false;
 try{return new TextEncoder().encode(JSON.stringify(value.metadata)).byteLength<=AGENT_PACKAGE_METADATA_MAX_BYTES;}catch{return false;}
}
export function listPendingAgentImports(product:Product,projectId:string):PendingAgentImport[]{
 const start=prefix(product,projectId),found:PendingAgentImport[]=[];
 for(let i=0;i<localStorage.length;i++){
  const name=localStorage.key(i);if(!name?.startsWith(start))continue;
  const bytes=localStorage.getItem(name);if(bytes===null)throw Error('Saved import changed while being read.');
  let value:unknown;try{value=JSON.parse(bytes);}catch{throw Error('Saved import information cannot be read.');}
  if(!pendingAgentImportValid(value,product,projectId)||name!==key(value))throw Error('Saved import information is invalid.');
  found.push(value);
 }
 return found.sort((a,b)=>a.requestId.localeCompare(b.requestId));
}
export function retainPendingAgentImport(value:PendingAgentImport):void{
 if(!pendingAgentImportValid(value,value.product,value.projectId))throw Error('Import request cannot be saved.');
 const name=key(value),bytes=JSON.stringify(value),previous=localStorage.getItem(name);
 if(previous!==null&&previous!==bytes)throw Error('A different import request is already saved.');
 if(previous===null)localStorage.setItem(name,bytes);
 if(localStorage.getItem(name)!==bytes)throw Error('Import request could not be saved.');
}
export function releasePendingAgentImport(value:PendingAgentImport):void{
 const name=key(value),bytes=localStorage.getItem(name);
 if(bytes===null)return;
 if(bytes!==JSON.stringify(value))throw Error('Saved import changed; the original request is retained.');
 localStorage.removeItem(name);
}
