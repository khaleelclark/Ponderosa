import {createHash} from 'node:crypto';
import {REQUEST_SOURCE_LINEAGE_CTE,type AgentStore} from '@ponderosa/agents';
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
export async function voiceMemoryExposure(ports:VoiceExposurePorts,input:{agentId:string;projectId:string;conversationId:string;messageId:string;runId?:string;sourceKind?:'communication'|'request'}):Promise<Exposure>{
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
  if(m?.schemaVersion!==3||m.conversationId!==input.conversationId||m.memorySessionResetSeq!==seq||!Array.isArray(m.memoryScopes)||m.memoryScopes.length||!Array.isArray(m.sources)||m.sources.some((s:{kind?:string})=>s.kind==='memory'))return invalid;
  if(input.sourceKind==='request'){
   if(!Array.isArray(m.activationIds)||m.activationIds.some((id:unknown)=>typeof id!=='string')||!db.prepare(`${REQUEST_SOURCE_LINEAGE_CTE}
    SELECT 1 FROM request_source_lineage lineage JOIN scheduler_run_activations attached ON attached.activation_id=lineage.activation_id
    JOIN coordination_requests request ON request.id=lineage.request_id
    WHERE attached.run_id=? AND lineage.request_id=? AND request.recipient_agent_id=? AND request.project_id=? AND request.conversation_id=?
    AND lineage.activation_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .get(input.runId,input.messageId,input.agentId,input.projectId,input.conversationId,JSON.stringify(m.activationIds)))return invalid;
  }else if(!Array.isArray(m.communicationEventIds)||!m.communicationEventIds.includes(input.messageId)){
   // Steering is absent from the initial provider-input manifest. Admit only
   // this exact canonical source on an acknowledged, hash-verified injection;
   // all original memory/session checks above and below still apply.
   const injected=db.prepare(`SELECT injection.exact_prompt AS prompt,injection.prompt_hash FROM scheduler_prompt_injections injection
    JOIN scheduler_run_activations attached ON attached.run_id=injection.run_id
    JOIN agent_activations activation ON activation.id=attached.activation_id
    JOIN json_each(injection.activation_ids_json) member ON member.value=activation.id
    WHERE injection.run_id=? AND injection.kind='steer' AND injection.state='acknowledged'
      AND activation.agent_id=? AND activation.project_id=?
      AND json_extract(activation.payload_json,'$.communication.eventId')=?
      AND json_extract(activation.payload_json,'$.dispatch.voiceReply')=1 LIMIT 1`)
    .get(input.runId,input.agentId,input.projectId,input.messageId) as {prompt:string;prompt_hash:string}|undefined;
   if(!injected){
    const awaiting=db.prepare(`SELECT 1 FROM agent_activations activation JOIN scheduler_run_activations attached ON attached.activation_id=activation.id
     WHERE attached.run_id=? AND activation.agent_id=? AND activation.project_id=?
       AND json_extract(activation.payload_json,'$.communication.eventId')=?
       AND json_extract(activation.payload_json,'$.dispatch.voiceReply')=1
       AND activation.state IN ('pending','retry_pending','attached') LIMIT 1`)
      .get(input.runId,input.agentId,input.projectId,input.messageId);
    return awaiting ? {state:'pending',runId:input.runId} : invalid;
   }
   if(createHash('sha256').update(injected.prompt).digest('hex')!==injected.prompt_hash)return invalid;
  }
  if(ports.opts.localMemory){if(!ports.validateMemory)return invalid;const valid=await ports.validateMemory(input.runId);if(valid===undefined)return {state:'pending',runId:input.runId};if(!valid)return invalid;return {state:'valid',runId:input.runId,sessionResetSeq:seq};}
  return {state:'disabled',runId:input.runId,sessionResetSeq:seq};
 }catch{return invalid}
}
