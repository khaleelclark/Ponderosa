import {createHash} from 'node:crypto';
import type {AgentStore} from '@ponderosa/agents';
import type {VoiceReplyStatus} from '@ponderosa/core';
import type {CreateServerOptions} from './app-contracts.js';
import {activeChatResourceOwner} from './branch-resource-owner.js';
type Exposure=NonNullable<VoiceReplyStatus['memoryExposure']>;
export type VoiceExposurePorts={store:AgentStore;validateMemory?:(runId:string)=>Promise<boolean|undefined>;opts:CreateServerOptions & {memoryEnabled?:boolean;localMemory?:unknown};unavailable(projectId:string,agentId?:string,conversationId?:string):boolean};
export function memorySessionResetSeq(store:AgentStore,agentId:string):number{
 return (store.sqlite.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE agent_id=? AND type='session_reset'").get(agentId) as {seq:number}).seq;
}
/** Verify the canonical input packet and revalidate explicitly read private.6 sources.
 * Exposure state is ephemeral; unknown completed Runs fail closed after restart. */
export async function voiceMemoryExposure(ports:VoiceExposurePorts,input:{agentId:string;projectId:string;conversationId:string;messageId:string;runId?:string}):Promise<Exposure>{
 if(!input.runId)return {state:'pending'};
 const invalid:Exposure={state:'invalid',runId:input.runId};
 try{
  if(ports.opts.memoryEnabled)return invalid;
  if(ports.unavailable(input.projectId,input.agentId,input.conversationId)||!activeChatResourceOwner(ports.store,'agent',input.agentId)||!activeChatResourceOwner(ports.store,'conversation',input.conversationId))return invalid;
  const db=ports.store.sqlite,run=db.prepare('SELECT agent_id,project_id FROM scheduler_runs WHERE id=?').get(input.runId) as {agent_id:string;project_id:string}|undefined;
  if(!run||run.agent_id!==input.agentId||run.project_id!==input.projectId)return invalid;
  const packet=db.prepare('SELECT scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json FROM provider_inputs WHERE execution_id=?').get(input.runId) as {scheduler_run_id:string;agent_id:string;project_id:string;provider_prompt:string;prompt_hash:string;source_manifest_json:string}|undefined;
  if(!packet||!db.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND kind='turn' AND state IN ('submitted','acknowledged') AND submitted_at IS NOT NULL").get(input.runId))return {state:'pending',runId:input.runId};
  if(packet.scheduler_run_id!==input.runId||packet.agent_id!==input.agentId||packet.project_id!==input.projectId||createHash('sha256').update(packet.provider_prompt).digest('hex')!==packet.prompt_hash)return invalid;
  const m=JSON.parse(packet.source_manifest_json),seq=memorySessionResetSeq(ports.store,input.agentId);
  if(m?.schemaVersion!==3||m.conversationId!==input.conversationId||m.memorySessionResetSeq!==seq||!Array.isArray(m.memoryScopes)||m.memoryScopes.length||!Array.isArray(m.sources)||m.sources.some((s:{kind?:string})=>s.kind==='memory')||!Array.isArray(m.communicationEventIds)||!m.communicationEventIds.includes(input.messageId))return invalid;
  if(ports.opts.localMemory){if(!ports.validateMemory)return invalid;const valid=await ports.validateMemory(input.runId);if(valid===undefined)return {state:'pending',runId:input.runId};if(!valid)return invalid;return {state:'valid',runId:input.runId,sessionResetSeq:seq};}
  return {state:'disabled',runId:input.runId,sessionResetSeq:seq};
 }catch{return invalid}
}
