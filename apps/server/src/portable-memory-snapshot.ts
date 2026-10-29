import {agentPackageTextIsWellFormed} from '@ponderosa/core';
import {assertPortableSecretsAbsent} from './portable-secrets.js';

export const MEMORY_SNAPSHOT_MAX_BYTES=16*1024*1024;
export const MEMORY_SNAPSHOT_MAX_ROWS=10000;
export type {PortableMemoryRowDto as PortableMemoryRow,PortableChatMemorySnapshotDto as PortableMemorySnapshot} from '@ponderosa/core';
import type {PortableChatMemorySnapshotDto as PortableMemorySnapshot,PortableMemoryRowDto as PortableMemoryRow} from '@ponderosa/core';
const fail=(detail:string):never=>{throw Error('Memory snapshot: '+detail);};
const object=(v:unknown):v is Record<string,any>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!v.includes('\0')&&agentPackageTextIsWellFormed(v);
const fields=(v:object,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const provenance=(p:any)=>object(p)&&fields(p,['actor','runId','fenceToken','at'])&&object(p.actor)&&fields(p.actor,['kind','id'])&&['agent','user'].includes(p.actor.kind)&&text(p.actor.id)&&text(p.runId)&&text(p.fenceToken)&&text(p.at,64)&&Number.isFinite(Date.parse(p.at));
export function validateMemorySnapshot(value:unknown,signature?:string):PortableMemorySnapshot{
 let bytes;try{bytes=Buffer.byteLength(JSON.stringify(value));}catch{fail('JSON data required');}
 if(bytes!>MEMORY_SNAPSHOT_MAX_BYTES)fail('16 MiB byte limit exceeded');
 if(!object(value)||!fields(value,['schema','signature','sourceChatId','agentIds','excludedScopes','chunks','conflicts'])||value.schema!=='ponderosa.chat-memory.v1')fail('unsupported schema or fields');
 const s=value as PortableMemorySnapshot;
 if(!text(s.signature)||signature!==undefined&&s.signature!==signature)fail('incompatible embedding signature');
 if(!text(s.sourceChatId)||!Array.isArray(s.agentIds)||s.agentIds.length>10000||s.agentIds.some(id=>!text(id))||new Set(s.agentIds).size!==s.agentIds.length||JSON.stringify(s.excludedScopes)!=='["global"]')fail('invalid Chat, Agent inventory or excluded scopes');
 if(!Array.isArray(s.chunks)||!Array.isArray(s.conflicts)||s.chunks.length+s.conflicts.length>MEMORY_SNAPSHOT_MAX_ROWS)fail('10000 row limit exceeded');
 const scope='chat:'+s.sourceChatId,audiences=new Set([scope+':team',...s.agentIds.map(id=>scope+':agent:'+id)]),ids=new Map<string,PortableMemoryRow>();
 for(const [rows,log] of [[s.chunks,false],[s.conflicts,true]] as const){
  const seen=new Set<string>();
  for(const row of rows){
   if(!object(row)||!fields(row,['id','text','metadata','embedding','stamp'])||!text(row.id)||seen.has(row.id)||typeof row.text!=='string'||!agentPackageTextIsWellFormed(row.text)||!object(row.metadata)||!Array.isArray(row.embedding)||row.embedding.length!==384||!row.embedding.every(n=>Number.isFinite(n)&&Number.isFinite(Math.fround(n)))||!row.embedding.some(n=>Math.fround(n)!==0))fail('invalid row, duplicate ID or vector');
   seen.add(row.id);
   if(Object.entries(row.metadata).some(([k,v])=>k.startsWith('host_')||!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&!agentPackageTextIsWellFormed(v)))fail('unsupported metadata or known credential field');
   assertPortableSecretsAbsent(row.metadata,'Memory snapshot: metadata');
   assertPortableSecretsAbsent(row.stamp,'Memory snapshot: source provenance');
   const p=row.stamp;
   if(!object(p)||!fields(p,['format','principal','id','scope','audience','ownerChat','sourceType','provenance','origin'])||p.format!==1||!text(p.principal)||p.id!==row.id||p.scope!==scope||p.ownerChat!==s.sourceChatId||!audiences.has(p.audience)||!['user_statement','ai_inference'].includes(p.sourceType)||p.sourceType!==row.metadata.source_type||!provenance(p.provenance)||p.origin!==undefined&&!provenance(p.origin))fail('invalid scope or source provenance');
   if(!log){if(typeof row.metadata.confidence!=='number'||typeof row.metadata.deprecated!=='boolean')fail('invalid chunk metadata');ids.set(row.id,row);}
  }
 }
 const origin=(r:PortableMemoryRow)=>JSON.stringify(r.stamp.origin??r.stamp.provenance);
 for(const row of s.chunks){
  const seen=new Set([row.id]);let current=row;
  while(current.metadata.supersedes){const parent=ids.get(String(current.metadata.supersedes));if(!parent||parent.stamp.audience!==row.stamp.audience||origin(parent)!==origin(row)||seen.has(parent.id))fail('missing, cyclic or cross-audience lineage');seen.add(parent!.id);current=parent!;}
 }
 for(const row of s.conflicts){
  let affected;try{affected=JSON.parse(String(row.metadata.chunk_ids_affected??row.metadata.chunk_ids));}catch{fail('invalid conflict references');}
  if(!Array.isArray(affected)||!affected.length||affected.some(id=>typeof id!=='string'||ids.get(id)?.stamp.audience!==row.stamp.audience))fail('missing or cross-audience conflict references');
 }
 return s;
}
