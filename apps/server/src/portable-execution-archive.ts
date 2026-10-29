import {randomUUID} from 'node:crypto';
import type {AgentStore} from '@ponderosa/agents';
import type {PortableArtifactDto} from '@ponderosa/core';
import {AGENT_PACKAGE_ARTIFACT_MAX_BYTES,agentPackageTextIsWellFormed} from '@ponderosa/core';
import {exactObjectFields,validatedObject} from './object-validation.js';

export const EXECUTION_ARCHIVE_MEDIA_TYPE = 'application/vnd.ponderosa.execution-archive+json';
const SCHEMA = 'ponderosa.execution-archive.v1';
// Known credential fields are never portable. Free-form historical text still
// needs the full-export sensitive-data warning.
const secretField = /^(?:authorization|password|passwd|credentials|secrets?|secretBindings|token|authToken|capabilityToken|messageCapability|bearerToken|signingSecret|vapidPrivateKey|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)$/i;
function withoutSecrets(value:unknown,depth=0):unknown {
  if(depth>64)throw new Error('Execution archive exceeds the supported nesting depth');
  if(typeof value==='string'&&/^[\s]*[\[{]/.test(value)){
    let parsed:unknown;try{parsed=JSON.parse(value);}catch{return value;}
    const safe=withoutSecrets(parsed,depth+1);
    return JSON.stringify(parsed)===JSON.stringify(safe)?value:JSON.stringify(safe);
  }
  if(Array.isArray(value))return value.map(item=>withoutSecrets(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!secretField.test(key)).map(([key,item])=>[key,withoutSecrets(item,depth+1)]));
  return value;
}

/** Historical evidence only; imports publish these bytes as an ordinary log artifact. */
export function executionArchive(store:AgentStore,agentId:string,maxBytes:number):PortableArtifactDto|undefined {
  const agent=store.getAgent(agentId);if(!agent)throw new Error('Execution archive Agent is unavailable');
  const budget=Math.min(maxBytes,64*1024*1024,AGENT_PACKAGE_ARTIFACT_MAX_BYTES);
  const events:unknown[]=[];let bytes=0,seq=0;
  for(;;){
    const batch=store.readEventsSince(agentId,seq,256);
    for(const row of batch){
      const retained=withoutSecrets(row);bytes+=Buffer.byteLength(JSON.stringify(retained));
      if(bytes>budget)throw Object.assign(new Error('Execution archive exceeds the portable artifact byte limit'),{statusCode:413});
      events.push(retained);seq=row.seq;
    }
    if(batch.length<256)break;
  }
  // Deliberately select historical facts, never leases, fences, prompts,
  // capability tokens, provider profiles, activations or operational outboxes.
  const runs:unknown[]=[];
  for(const row of store.sqlite.prepare(`SELECT id,status,created_at,started_at,terminal_at
    FROM scheduler_runs WHERE agent_id=? ORDER BY created_at,id`).iterate(agentId)){
    bytes+=Buffer.byteLength(JSON.stringify(row));
    if(bytes>budget)throw Object.assign(new Error('Execution archive exceeds the portable artifact byte limit'),{statusCode:413});
    runs.push(row);
  }
  if(!events.length&&!runs.length)return undefined;
  const data=Buffer.from(JSON.stringify({schema:SCHEMA,sourceAgentId:agentId,sourceProjectId:agent.projectId,events,runs}));
  if(data.length>budget)throw Object.assign(new Error('Execution archive exceeds the portable artifact byte limit'),{statusCode:413});
  return {ref:randomUUID(),kind:'log',path:'execution-history.json',summary:'Imported execution evidence (historical; never scheduled)',createdAt:new Date().toISOString(),mediaType:EXECUTION_ARCHIVE_MEDIA_TYPE,dataBase64:data.toString('base64')};
}

/** Validate the versioned envelope before any destination Agent/files are created. */
export function validateExecutionArchive(data:Uint8Array):void {
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
  if(JSON.stringify(withoutSecrets(archive))!==JSON.stringify(archive))throw new Error('Execution archives cannot contain known credential fields');
}
