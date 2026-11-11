import {encodePortableArtifactData} from "./agent-package-codec.js";
import {setImmediate as yieldToLoop} from "node:timers/promises";
import {withoutPortableSecrets,assertPortableSecretsAbsent,PORTABLE_SECRET_MAX_BYTES} from './portable-secrets.js';
import {randomUUID} from 'node:crypto';
import type {AgentStore} from '@ponderosa/agents';
import type {PortableArtifactDto} from '@ponderosa/core';
import {AGENT_PACKAGE_ARTIFACT_MAX_BYTES,AGENT_PACKAGE_MAX_BYTES,agentPackageJsonUtf8Bytes,agentPackageTextIsWellFormed} from '@ponderosa/core';
import {exactObjectFields,validatedObject} from './object-validation.js';

export const EXECUTION_ARCHIVE_MEDIA_TYPE = 'application/vnd.ponderosa.execution-archive+json';
const SCHEMA = 'ponderosa.execution-archive.v1';
/** Historical evidence only; imports publish these bytes as an ordinary log artifact. */
// Each part remains an ordinary, independently validated managed file. Parts
// preserve original sequence numbers and provenance; no history is summarized.
export async function executionArchives(store:AgentStore,agentId:string,maxBytes:number):Promise<PortableArtifactDto[]> {
  const agent=store.getAgent(agentId);if(!agent)throw new Error('Execution archive Agent is unavailable');
  const budget=Math.min(maxBytes,AGENT_PACKAGE_ARTIFACT_MAX_BYTES);
  const parts:PortableArtifactDto[]=[];
  let events:unknown[]=[],runs:unknown[]=[],partBytes=0,totalBytes=0,wireBytes=0,seq=0;
  const flush=async()=>{
    if(!events.length&&!runs.length)return;
    const data=Buffer.from(JSON.stringify({schema:SCHEMA,sourceAgentId:agentId,sourceProjectId:agent.projectId,events,runs}));
    totalBytes+=data.length;
    if(totalBytes>budget)throw Object.assign(new Error('Execution archive exceeds the portable artifact byte limit'),{statusCode:413});
    validateExecutionArchive(data);
    const artifact:PortableArtifactDto={ref:randomUUID(),kind:'log',path:parts.length?`execution-history-${parts.length+1}.json`:'execution-history.json',summary:'Imported execution evidence (historical; never scheduled)',createdAt:new Date().toISOString(),mediaType:EXECUTION_ARCHIVE_MEDIA_TYPE,...await encodePortableArtifactData(data)};
    wireBytes+=agentPackageJsonUtf8Bytes(artifact);
    if(wireBytes>AGENT_PACKAGE_MAX_BYTES)throw Object.assign(new Error('Execution archive exceeds the serialized package byte limit; no events were omitted'),{statusCode:413});
    parts.push(artifact);
    events=[];runs=[];partBytes=0;
    await yieldToLoop();
  };
  const add=async(row:unknown,kind:'event'|'run')=>{
    const retained=withoutPortableSecrets(row);
    const bytes=Buffer.byteLength(JSON.stringify(retained))+1;
    if(totalBytes+partBytes+bytes>budget)throw Object.assign(new Error('Execution archive exceeds the portable artifact byte limit'),{statusCode:413});
    // Leave inspection headroom for nested/encoded diagnostics. Individual
    // rows still use the existing 64 MiB structured-data admission unchanged.
    if(partBytes+bytes>8*1024*1024)await flush();
    (kind==='event'?events:runs).push(retained);partBytes+=bytes;
  };
  for(;;){
    const batch=store.readEventsSince(agentId,seq,256);
    for(const row of batch){await add(row,'event');seq=row.seq;}
    if(batch.length<256)break;
  }
  // Retain historical facts, never live leases/fences/prompts or outboxes.
  for(const row of store.sqlite.prepare(`SELECT id,status,created_at,started_at,terminal_at
    FROM scheduler_runs WHERE agent_id=? ORDER BY created_at,id`).iterate(agentId))await add(row,'run');
  await flush();
  return parts;
}

/** Validate the versioned envelope before any destination Agent/files are created. */
export function validateExecutionArchive(data:Uint8Array):void {
  if(data.byteLength>PORTABLE_SECRET_MAX_BYTES)throw Object.assign(new Error('Execution archive exceeds the portable artifact byte limit'),{statusCode:413});
  let value:unknown;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw new Error('Execution archive must contain valid UTF-8 JSON');}
  const archive=validatedObject(value,'Execution archive');
  exactObjectFields(archive,['schema','sourceAgentId','sourceProjectId','events','runs'],'Execution archive');
  if(archive.schema!==SCHEMA)throw new Error(`Unsupported execution archive schema: ${String(archive.schema)}; expected ${SCHEMA}`);
  for(const key of ['sourceAgentId','sourceProjectId'])if(typeof archive[key]!=='string'||!archive[key]||!agentPackageTextIsWellFormed(archive[key] as string))throw new Error(`Execution archive ${key} is invalid`);
  if(!Array.isArray(archive.events)||!Array.isArray(archive.runs))throw new Error('Execution archive events and Runs must be arrays');
  let previous=0;
  for(const item of archive.events){
    const row=validatedObject(item,'Execution archive event');exactObjectFields(row,['seq','ts','event'],'Execution archive event');
    const event=validatedObject(row.event,'Execution archive event payload');
    if(!Number.isSafeInteger(row.seq)||(row.seq as number)<=previous||typeof row.ts!=='string'||!Number.isFinite(Date.parse(row.ts))||typeof event.type!=='string'||!event.type)throw new Error('Execution archive event sequence, timestamp or type is invalid');
    previous=row.seq as number;
  }
  const ids=new Set<string>();
  for(const item of archive.runs){
    const row=validatedObject(item,'Execution archive Run');exactObjectFields(row,['id','status','created_at','started_at','terminal_at'],'Execution archive Run');
    if(typeof row.id!=='string'||!row.id||ids.has(row.id)||!['leased','running','completed','failed','cancelled','outcome_unknown'].includes(String(row.status)))throw new Error('Execution archive Run identity or status is invalid');
    ids.add(row.id);
    for(const key of ['created_at','started_at','terminal_at'])if(!(key!=='created_at'&&row[key]===null)&&(typeof row[key]!=='string'||!Number.isFinite(Date.parse(row[key] as string))))throw new Error(`Execution archive Run ${key} is invalid`);
  }
  assertPortableSecretsAbsent(archive,'Execution archives');
}
