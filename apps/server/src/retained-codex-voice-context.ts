import {createHash} from 'node:crypto';
import type {AgentStore} from '@ponderosa/agents';
import type {LocalMemoryService} from './local-memory.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type Input={store:AgentStore;memory:LocalMemoryService;agentId:string;chatId:string;sessionId:string;
 sourceRunId:string;currentRunId?:string;contractHash:string;systemPromptHash:string};
/** Reuse a completed managed generation, not the original task's transition
 * marker. Extend its memory proof through every subsequently completed turn. */
export async function proveRetainedManagedVoiceContext(input:Input):Promise<{isCurrent:()=>boolean}|undefined>{
 const inspect=():{snapshot:string;origin:string;signature:string}|undefined=>{try{
  const {store,memory,agentId,chatId,sessionId,sourceRunId,currentRunId}=input,db=store.sqlite;
  const agent=store.getAgent(agentId),accepted=store.resumeSessionState(agentId),seed=store.acceptedProviderSessionInput(agentId);
  const contract=seed?.sourceManifest.schemaVersion===3?seed.sourceManifest.normalRuntimeContract:undefined;
  if(!agent||agent.conversationId!==chatId||accepted?.sessionId!==sessionId||accepted.toolContractHash!==input.contractHash||
    !seed||!contract||contract.contractHash!==input.contractHash||contract.engineId!==agent.activeEngine||
    contract.workingCopyId!==agent.workingCopy.id||contract.cwd!==agent.workingCopy.rootPath||agent.workingCopy.state!=='ready'||
    typeof seed.exactSystemPrompt!=='string'||hash(seed.exactSystemPrompt)!==input.systemPromptHash||seed.systemPromptHash!==input.systemPromptHash)return;
  const rows=db.prepare(`SELECT r.*,h.payload_json FROM context_rollovers r
    JOIN activation_sources x ON x.source_kind='context_rollover' AND x.source_id=r.id
    JOIN agent_activations h ON h.id=x.activation_id AND h.kind='context_rollover_handoff'
    WHERE r.agent_id=? AND r.project_id=? AND r.conversation_id=? AND r.scope_key=?
      AND r.state='completed' AND r.completion_reason='replacement_verified'
      AND r.replacement_run_id=? AND r.replacement_session_id=?`).all(agentId,agent.projectId,chatId,`conversation:${chatId}`,seed.executionId,sessionId) as any[];
  if(rows.length!==1)return;const rollover=rows[0],marker=JSON.parse(rollover.payload_json)?.settingsTransition;
  if(!marker||marker.oldSessionId!==rollover.old_provider_session_id||marker.sourceRunId!==rollover.source_run_id||
     !marker.authorizationOriginRunId||!marker.authorizationSignatureHash||marker.targetModel!==contract.model||
     marker.targetEffort!==contract.effort||marker.targetSpeed!==(contract.speed??'standard')||
     marker.targetSystemPromptHash&&marker.targetSystemPromptHash!==input.systemPromptHash)return;
  const source=db.prepare(`SELECT id,fencing_token,scope_key,status,prompt_injection_state,provider_session_id FROM scheduler_runs
    WHERE id=? AND agent_id=?`).get(sourceRunId,agentId) as any;
  if(!source||source.scope_key!==rollover.scope_key||source.status!=='completed'||source.prompt_injection_state!=='injected'||source.provider_session_id!==sessionId)return;
  const current=currentRunId?db.prepare(`SELECT id,fencing_token,scope_key,status,prompt_injection_state FROM scheduler_runs WHERE id=? AND agent_id=?`).get(currentRunId,agentId) as any:undefined;
  if(currentRunId&&(!current||!['leased','running'].includes(current.status)||current.scope_key!==source.scope_key||
    current.fencing_token<=source.fencing_token||!['not_injected','injecting','injected'].includes(current.prompt_injection_state)))return;
  if(db.prepare(`SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id<>? AND fencing_token>? LIMIT 1`)
    .get(agentId,currentRunId??'',source.fencing_token))return;
  const authorization=memory.transitionAuthorization(agentId,chatId,sessionId,seed.executionId,sourceRunId);
  if(!authorization||authorization.signature!==marker.authorizationSignatureHash)return;
  return {snapshot:JSON.stringify([accepted,agent.workingCopy,seed.promptHash,contract,rollover,source,current&&[current.id,current.fencing_token,current.scope_key]]),origin:seed.executionId,signature:authorization.signature};
 }catch{return;}};
 const initial=inspect();if(!initial)return;
 if(!await input.memory.validateTransitionReads(input.agentId,input.chatId,initial.origin,input.sourceRunId,
   input.currentRunId??input.sourceRunId,initial.signature))return;
 const isCurrent=()=>inspect()?.snapshot===initial.snapshot&&input.memory.transitionAuthorizationStillValid(input.agentId,input.chatId,
   initial.origin,input.sourceRunId,input.currentRunId??input.sourceRunId,initial.signature);
 return isCurrent()?{isCurrent}:undefined;
}
/** This proves only the accepted first generation. A separate failed fresh
 * replacement keeps its own uncertainty and is never resumed or replayed here. */
export function proveRetainedCodexVoiceContext(input:Input):{isCurrent:()=>boolean}|undefined{
 const inspect=():string|undefined=>{try{
  const {store,memory,agentId,chatId,sessionId,sourceRunId,currentRunId}=input,db=store.sqlite;
  const agent=store.getAgent(agentId),accepted=store.resumeSessionState(agentId);
  if(!agent||agent.activeEngine!=='codex'||agent.conversationId!==chatId||accepted?.sessionId!==sessionId||
    accepted.toolContractHash!==input.contractHash)return;
  const origin=db.prepare(`SELECT type,payload_json FROM events WHERE agent_id=? AND type IN
    ('session_snapshot','context_rollover_session_accepted') ORDER BY seq LIMIT 1`).get(agentId) as any;
  const event=JSON.parse(origin?.payload_json??'null');
  if(origin?.type!=='session_snapshot'||event?.sessionId!==sessionId||event.toolContractHash!==input.contractHash||typeof event.executionId!=='string')return;
  if(db.prepare(`SELECT 1 FROM coordination_idempotency WHERE operation='native_history' AND json_extract(result_json,'$.targetAgentId')=? LIMIT 1`).get(agentId))return;
  const first=db.prepare('SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(event.executionId,agentId) as any;
  const source=db.prepare('SELECT fencing_token,scope_key,status,prompt_injection_state,provider_session_id FROM scheduler_runs WHERE id=? AND agent_id=?').get(sourceRunId,agentId) as any;
  if(!first||!source||source.status!=='completed'||source.prompt_injection_state!=='injected'||source.provider_session_id!==sessionId||first.fencing_token>source.fencing_token||first.scope_key!==source.scope_key||first.scope_key!==`conversation:${chatId}`)return;
  const current=currentRunId?db.prepare(`SELECT fencing_token,scope_key FROM scheduler_runs WHERE id=? AND agent_id=? AND status IN ('leased','running')`).get(currentRunId,agentId) as any:undefined;
  if(currentRunId&&(!current||current.scope_key!==first.scope_key||current.fencing_token<=source.fencing_token))return;
  if(db.prepare(`SELECT 1 FROM scheduler_runs WHERE agent_id=? AND id<>? AND
    (fencing_token>? OR fencing_token<? AND (prompt_injection_state<>'not_injected' OR provider_session_id IS NOT NULL OR status IN ('leased','running','outcome_unknown'))) LIMIT 1`)
    .get(agentId,currentRunId??'',source.fencing_token,first.fencing_token))return;
  const rows=db.prepare(`SELECT id,project_id,agent_id,fencing_token,scope_key,status,provider_session_id,prompt_injection_state
    FROM scheduler_runs WHERE agent_id=? AND fencing_token>=? AND fencing_token<=? ORDER BY fencing_token,id`).all(agentId,first.fencing_token,source.fencing_token) as any[];
  if(rows[0]?.id!==event.executionId||rows.at(-1)?.id!==sourceRunId)return;
  const snapshot:any[]=[origin.payload_json,accepted,agent.workingCopy];let excludedCandidates=0;
  for(const row of rows){
   const packet=store.getProviderInput(row.id,true),m=packet?.sourceManifest;
   if(!packet||packet.schedulerRunId!==row.id||typeof packet.exactPrompt!=='string'||hash(packet.exactPrompt)!==packet.promptHash||
     typeof packet.exactSystemPrompt!=='string'||hash(packet.exactSystemPrompt)!==packet.systemPromptHash||
     m?.schemaVersion!==3||m.conversationId!==chatId||!Array.isArray(m.sources)||!Array.isArray(m.memoryScopes)||m.memoryScopes.length!==0)return;
   snapshot.push(row,packet.promptHash,packet.systemPromptHash,m);
   if(row.status==='completed'&&row.prompt_injection_state==='injected'&&row.provider_session_id===sessionId&&row.scope_key===first.scope_key){
    if(m.providerSessionDisposition!==(row.id===event.executionId?'fresh_task':'continued_session')||
      m.sources.some(s=>['continuation_handoff','pause_checkpoint','memory'].includes(s.kind))||
      !Array.isArray(m.normalRuntimeContract?.dynamicTools))return;
    if(row.id===event.executionId&&(m.normalRuntimeContract?.contractHash!==input.contractHash||packet.systemPromptHash!==input.systemPromptHash))return;
    continue;
   }
   // Reseeded is not by itself a fresh-session proof: require the exact owned
   // continuation/handoff branch that clears resumeSessionState before open.
   if(row.status!=='failed'||row.prompt_injection_state!=='not_injected'||row.provider_session_id!==null||
      m.providerSessionDisposition!=='reseeded'||m.retainedSessionSourceCount!==0||row.scope_key!==first.scope_key||m.normalRuntimeContract?.engineId!=='codex'||m.sources.some(s=>s.delivery==='retained_session'))return;
   const candidates=db.prepare(`SELECT r.*,a.kind continuation_kind,a.payload_json continuation_payload,h.text handoff_text,h.source_execution_id handoff_run
    FROM context_rollovers r JOIN scheduler_run_activations attached ON attached.run_id=r.replacement_run_id AND attached.activation_id=r.continuation_activation_id
    JOIN agent_activations a ON a.id=attached.activation_id AND a.kind='context_rollover_continuation' AND a.agent_id=r.agent_id AND a.project_id=r.project_id AND a.scope_key=r.scope_key
    JOIN activation_sources owner ON owner.activation_id=a.id AND owner.source_kind='context_rollover' AND owner.source_id=r.id
    JOIN continuation_handoffs h ON h.id=r.handoff_event_id AND h.agent_id=r.agent_id
    JOIN scheduler_runs handoff_run ON handoff_run.id=h.source_execution_id AND handoff_run.agent_id=r.agent_id AND handoff_run.project_id=r.project_id AND handoff_run.scope_key=r.scope_key
    WHERE r.replacement_run_id=? AND r.agent_id=? AND r.project_id=?`).all(row.id,agentId,row.project_id) as any[];
   if(candidates.length!==1)return;const c=candidates[0],payload=JSON.parse(c.continuation_payload);
   const handoff=m.sources.filter(s=>s.kind==='continuation_handoff');
   if(!['failed','outcome_unknown'].includes(c.state)||!c.terminal_at||c.completion_reason!==null||c.old_provider_session_id!==sessionId||c.scope_key!==first.scope_key||c.conversation_id!==chatId||
      c.replacement_session_id!==null||c.replacement_session_at!==null||c.replacement_verified_at!==null||!c.replacement_input_committed_at||
      c.replacement_prompt_hash!==packet.promptHash||c.replacement_system_prompt_hash!==packet.systemPromptHash||
      !payload||payload.rolloverId!==c.id||handoff.length!==1||handoff[0]?.ref!==c.handoff_event_id||handoff[0]?.hash!==hash(c.handoff_text)||handoff[0]?.delivery!=='submitted'||
      db.prepare(`SELECT 1 FROM scheduler_run_activations x JOIN activation_sources s ON s.activation_id=x.activation_id WHERE x.run_id=? AND s.source_kind='context_rollover_recovery' LIMIT 1`).get(row.id))return;
   const raw=db.prepare('SELECT source_manifest_json FROM provider_inputs WHERE execution_id=? AND scheduler_run_id=?').get(row.id,row.id) as any;
   if(!raw||hash(raw.source_manifest_json)!==c.replacement_manifest_hash)return;
   const owner=db.prepare(`SELECT a.id FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
    JOIN scheduler_run_activations x ON x.activation_id=a.id AND x.run_id=?
    WHERE a.kind='context_rollover_handoff' AND a.agent_id=? AND a.project_id=? AND a.scope_key=? AND s.source_kind='context_rollover' AND s.source_id=? AND json_extract(a.payload_json,'$.rolloverId')=?
    AND EXISTS(SELECT 1 FROM scheduler_prompt_injections i,json_each(i.activation_ids_json) member WHERE i.run_id=x.run_id AND i.state='acknowledged' AND member.value=a.id)`)
    .get(c.handoff_run,agentId,row.project_id,first.scope_key,c.id,c.id);
   if(db.prepare(`SELECT 1 FROM events WHERE agent_id=? AND type='context_rollover_session_accepted' AND json_extract(payload_json,'$.executionId')=? LIMIT 1`).get(agentId,row.id))return;
   if(!owner||db.prepare(`SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND
     (state<>'cancelled' OR submitted_at IS NOT NULL OR acknowledged_at IS NOT NULL OR provider_turn_id IS NOT NULL) LIMIT 1`).get(row.id))return;
   excludedCandidates++;snapshot.push(c,raw.source_manifest_json);
  }
  // Other generations retain their established managed-voice admission path.
  if(excludedCandidates===0)return;
  const proof=memory.prepareUnusedRetainedGenerationProof({agentId,chatId,runIds:rows.map(r=>r.id),signatureRunId:currentRunId??sourceRunId});
  if(!proof?.isCurrent())return;
  snapshot.push(db.prepare(`SELECT e.run_id,e.agent_id,e.chat_id,e.fencing_token,e.authorization_hash,e.attempted,e.pending,e.uncertain,e.unverified,e.mutation_epoch,e.checked_epoch FROM memory_exposure_runs e WHERE e.run_id IN (SELECT value FROM json_each(?)) ORDER BY e.run_id`).all(JSON.stringify(rows.map(r=>r.id))));
  return JSON.stringify(snapshot);
 }catch{return;}};
 const initial=inspect();return initial?{isCurrent:()=>inspect()===initial}:undefined;
}
