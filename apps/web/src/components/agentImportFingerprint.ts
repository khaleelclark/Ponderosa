import {AGENT_PACKAGE_MAX_BYTES} from '@ponderosa/core';
/** Bounded, deterministic fingerprint for retaining the identity of an
 * Agent-package Blob across reloads without storing or buffering the package. */
export const AGENT_IMPORT_FINGERPRINT_ALGORITHM='sha256-4m-v1' as const;
const CHUNK_BYTES=4*1024*1024;
const DOMAIN='ponderosa-agent-import:sha256-4m-v1\0';
export type AgentImportFingerprint={algorithm:typeof AGENT_IMPORT_FINGERPRINT_ALGORITHM;bytes:number;digest:string};

export async function fingerprintAgentImport(blob:Blob):Promise<AgentImportFingerprint>{
 if(!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>AGENT_PACKAGE_MAX_BYTES||!globalThis.crypto?.subtle)throw Error('Package fingerprint is unavailable.');
 const count=Math.ceil(blob.size/CHUNK_BYTES),prefix=new TextEncoder().encode(DOMAIN+blob.size+'\0'+CHUNK_BYTES+'\0'+count+'\0');
 const input=new Uint8Array(prefix.length+count*32);input.set(prefix);
 for(let index=0;index<count;index++){
  const chunk=await blob.slice(index*CHUNK_BYTES,Math.min(blob.size,(index+1)*CHUNK_BYTES)).arrayBuffer();
  const hash=await crypto.subtle.digest('SHA-256',chunk);input.set(new Uint8Array(hash),prefix.length+index*32);
 }
 const hash=await crypto.subtle.digest('SHA-256',input);
 return {algorithm:AGENT_IMPORT_FINGERPRINT_ALGORITHM,bytes:blob.size,digest:[...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
}
export function sameAgentImportFingerprint(a:AgentImportFingerprint,b:AgentImportFingerprint):boolean{
 return a.algorithm===b.algorithm&&a.bytes===b.bytes&&a.digest===b.digest;
}
