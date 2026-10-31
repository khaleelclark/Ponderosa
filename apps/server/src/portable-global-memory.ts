import {createHash} from 'node:crypto';
import type {GlobalMemorySelectionDto,PortableGlobalMemorySnapshotDto} from '@ponderosa/core';
import {validateMemorySnapshot,MEMORY_SNAPSHOT_MAX_BYTES} from './portable-memory-snapshot.js';

const fail=(detail:string):never=>{throw Error('Global memory transfer: '+detail);};
export function validateGlobalMemory(value:unknown,signature?:string):PortableGlobalMemorySnapshotDto {
 if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>MEMORY_SNAPSHOT_MAX_BYTES)fail('invalid or oversized snapshot');
 const s=value as PortableGlobalMemorySnapshotDto;
 if(Object.keys(s).some(k=>!['schema','signature','sourcePrincipal','chunks','conflicts'].includes(k))||s.schema!=='ponderosa.selected-global-memory.v1'||typeof s.sourcePrincipal!=='string'||!s.sourcePrincipal.trim()||s.sourcePrincipal.length>512||!Array.isArray(s.chunks)||!Array.isArray(s.conflicts))fail('unsupported snapshot fields');
 // Reuse the package validator for vectors, credentials, metadata, complete lineage and conflict references.
 const convert=(rows:typeof s.chunks)=>rows.map(row=>{
  const stamp=row?.stamp;
  if(!stamp||stamp.principal!==s.sourcePrincipal||stamp.scope!=='global'||stamp.ownerChat!=='global'||stamp.audience!=='installation-global'||(stamp.provenance?.actor?.kind==='agent'?stamp.sourceType!=='ai_inference':stamp.sourceType!=='user_statement'))fail('foreign scope or source provenance');
  return {...row,stamp:{...stamp,scope:'chat:global-transfer',ownerChat:'global-transfer',audience:'chat:global-transfer:team'}};
 });
 validateMemorySnapshot({schema:'ponderosa.chat-memory.v1',signature:s.signature,sourceChatId:'global-transfer',agentIds:[],excludedScopes:['global'],chunks:convert(s.chunks),conflicts:convert(s.conflicts)},signature);
 return s;
}
export function selectGlobalMemory(value:unknown,selection:GlobalMemorySelectionDto,signature?:string){
 const s=validateGlobalMemory(value,signature);
 if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(k=>!['chunkIds','conflictIds'].includes(k)))fail('explicit record selection required');
 for(const [ids,rows]of [[selection.chunkIds,s.chunks],[selection.conflictIds,s.conflicts]] as const){
  if(!Array.isArray(ids)||ids.length>10000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!rows.some(row=>row.id===id)))fail('unknown or duplicate selected record');
 }
 if(!selection.chunkIds.length)fail('select at least one memory record');
 return validateGlobalMemory({...s,chunks:s.chunks.filter(r=>selection.chunkIds.includes(r.id)).sort((a,b)=>a.id.localeCompare(b.id)),conflicts:s.conflicts.filter(r=>selection.conflictIds.includes(r.id)).sort((a,b)=>a.id.localeCompare(b.id))},signature);
}
export function globalMemoryHash(value:unknown):string {
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
