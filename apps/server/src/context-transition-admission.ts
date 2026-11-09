import {proveRetainedCodexVoiceContext} from './retained-codex-voice-context.js';
import { freshFailureDiagnostic } from './working-copy-diagnostic.js';
import { createHash } from 'node:crypto';
import { CapabilityPolicyStore, type AgentStore, type CoordinationV3Store, type WorkspaceStore } from '@ponderosa/agents';
import { CAPABILITY_IDS, isGrantOnlyRestrictionsChange, filterRuntimeToolsForCapabilities, runtimeRestrictions, PONDEROSA_HISTORY_TOOL, type Adapter, type ModelOption, type AgentDto, type ProjectDto } from '@ponderosa/core';
import { MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES } from '@ponderosa/core/seed-history';
import { ClaudeAdapter, CodexAdapter } from '@ponderosa/engines';
import type { PonderosaServer, CreateServerOptions, EngineRegistration } from './app-contracts.js';
import type { EngineAuthStatusCache } from './engine-auth-cache.js';
import type { createOperationalNotifications } from './operational-notifications.js';
import { localMemoryFor } from './local-memory.js';
import { runtimeManagedRules, runtimeSystemPrompt } from './prompts.js';
import { runtimeEnvironmentFacts, environmentFactsPrompt } from './runtime-environment-facts.js';
import { evaluateContextRolloverPressure } from './context-rollover-pressure.js';
import { assertRetainedNativeAuthentication, communicationV3SessionPrompt, concreteRuntimeSelection, normalizedRuntimeSelection, providerDynamicTools, providerRuntimeSessionContractHash, providerSessionContractHash, providerToolContractHash } from './runtime-selection.js';

type TransitionDispatch={engine?:unknown;model?:unknown;effort?:unknown;speed?:unknown;voiceReply?:unknown};
export function settingsTransitionTarget(agent:AgentDto,project:ProjectDto,adapter:Adapter,
 preferences:ReturnType<WorkspaceStore["getPreferences"]>,optionsInput:ModelOption[]|undefined,dispatch:TransitionDispatch|undefined){
 const options=optionsInput;
 const recovered=concreteRuntimeSelection(adapter,[{model:agent.model??agent.presetSnapshot?.model,effort:agent.effort??agent.presetSnapshot?.effort},project.defaultEngine===agent.activeEngine?{model:project.defaultModel,effort:project.defaultEffort}:undefined,preferences.engineDefaults?.[agent.activeEngine]],options);
 const hasModel=typeof dispatch?.model==='string',hasEffort=typeof dispatch?.effort==='string';
 const targetModel=hasModel?(dispatch!.model as string).trim()||undefined:agent.model??agent.presetSnapshot?.model??recovered.model;
 const targetEffort=hasEffort?(dispatch!.effort as string).trim()||undefined:hasModel
    ? concreteRuntimeSelection(adapter,[{model:targetModel},preferences.engineDefaults?.[agent.activeEngine]],options).effort
    : targetModel&&options&&!options.some(model=>model.id===targetModel)?agent.effort??agent.presetSnapshot?.effort
    : normalizedRuntimeSelection(adapter,targetModel,agent.effort??agent.presetSnapshot?.effort??recovered.effort,options).effort;
 const targetSpeed=typeof dispatch?.speed==='string'&&dispatch.speed.trim()?dispatch.speed.trim():'standard';
 return {targetModel,targetEffort,targetSpeed};
}

async function transitionSystemPromptHash(agent:AgentDto,project:ProjectDto,preferences:ReturnType<WorkspaceStore['getPreferences']>,opts:CreateServerOptions):Promise<string>{
 const environment=environmentFactsPrompt(await runtimeEnvironmentFacts({cwd:agent.workingCopy.rootPath,agentId:agent.id,allowedImportRoots:opts.allowedImportRoots}));
 const prompt=runtimeSystemPrompt(agent,runtimeManagedRules(agent,preferences.globalInstructions.trim(),
  project.instructions?.trim()??'',preferences.profile,communicationV3SessionPrompt(),environment));
 return createHash('sha256').update(prompt).digest('hex');
}

const unrecordedHolds=new WeakMap<CoordinationV3Store,Map<string,string>>();
type TransitionNotices=ReturnType<typeof createOperationalNotifications>;
type TransitionContext={app:PonderosaServer;store:AgentStore;coordinationV3:CoordinationV3Store;workspace:WorkspaceStore;
 createOperationalNotification:TransitionNotices['createOperationalNotification'];resolveOperationalNotification:TransitionNotices['resolveOperationalNotification']};
export function transitionFingerprint(ctx:Pick<TransitionContext,"app"|"store"|"workspace">,projectId:string,agentId:string,activationId:string):string{
 const {app,store,workspace}=ctx,agent=store.getAgent(agentId),chat=agent&&store.getConversation(agent.conversationId),
  project=agent&&store.getChatContext(agent.conversationId),memory=localMemoryFor(app),session=store.resumeSessionState(agentId);
 const row=store.sqlite.prepare('SELECT payload_json,state,scope_key FROM agent_activations WHERE id=? AND project_id=? AND agent_id=?').get(activationId,projectId,agentId);
 let grant:unknown;try{grant=memory&&agent?memory.getGrant(agent.conversationId,chat?.branchId?'branches':'dev'):undefined;}catch{grant='unavailable';}
 let policies:unknown;try{const p=new CapabilityPolicyStore(store.sqlite),resolved=p.resolveForAgent(agentId);policies=resolved.layers.map(layer=>[layer.scopeKind,layer.scopeId,p.get(layer.scopeKind,layer.scopeId)??null]);}catch{policies='unavailable';}
 const recovery=store.sqlite.prepare('SELECT id,state,progress_json FROM provider_context_recovery_requests WHERE agent_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(agentId);
 return createHash('sha256').update(JSON.stringify(['retained-codex-voice.v1',row,session,agent,project,workspace.getPreferences(),grant,policies,recovery,store.stoppedProviderSessionBoundary(agentId)])).digest('hex');
}
function transitionNotice(ctx:TransitionContext,projectId:string,agentId:string,activationId:string,reason:string){
 const existing=ctx.workspace.getNotificationByDedupeKey(`settings-transition:${activationId}`);
 if(existing&&(existing.status??'open')==='open')return;
 const agent=ctx.store.getAgent(agentId);
 ctx.createOperationalNotification({dedupeKey:`settings-transition:${activationId}`,renewAfterRecovery:true,category:'coordination',severity:'attention',
  title:'Agent context needs review',body:reason,projectId,agentId,...(agent?.conversationId?{conversationId:agent.conversationId}:{}),
  action:{kind:'open_agent',targetId:agentId}});
}
/** Recheck only durable, exact task holds. An unchanged fingerprint is never retried. */
export function reconcileSettingsTransitionReservations(ctx:TransitionContext){
 const rows=ctx.store.sqlite.prepare(`SELECT DISTINCT a.id,a.project_id,a.agent_id FROM activation_sources held
  JOIN agent_activations a ON a.id=held.activation_id WHERE held.source_kind='settings_transition_reservation_wait'`).all() as Array<{id:string;project_id:string;agent_id:string}>;
 for(const row of rows)try{
  const fingerprint=transitionFingerprint(ctx,row.project_id,row.agent_id,row.id);
  if(!ctx.coordinationV3.settingsTransitionReservationHeld({projectId:row.project_id,agentId:row.agent_id,activationId:row.id,fingerprint}))
   ctx.resolveOperationalNotification(`settings-transition:${row.id}`);
 }catch{/* A failed recheck never clears the existing hold. */}
 const terminal=ctx.store.sqlite.prepare(`SELECT DISTINCT a.id,a.project_id,a.agent_id FROM context_rollovers r
  JOIN activation_sources src ON src.source_kind='context_rollover' AND src.source_id=r.id
  JOIN agent_activations handoff ON handoff.id=src.activation_id AND handoff.kind='context_rollover_handoff'
  JOIN agent_activations a ON a.id=json_extract(handoff.payload_json,'$.settingsTransition.activationId')
  WHERE r.state IN ('failed','outcome_unknown') AND a.state IN ('pending','retry_pending') AND NOT EXISTS
   (SELECT 1 FROM activation_sources released WHERE released.activation_id=a.id AND released.source_kind='settings_transition_release' AND released.source_id=r.id)`).all() as Array<{id:string;project_id:string;agent_id:string}>;
 for(const row of terminal)try{transitionNotice(ctx,row.project_id,row.agent_id,row.id,
  'The context handoff did not finish or its result is unknown. The original work remains queued. Review the Agent’s activity before retrying; the handoff will not be replayed automatically.');}catch{/* The durable hold remains in place. */}
}

export function hasKnownRetainedMemory(store:AgentStore,agentId:string,originId:string,sourceId:string,sessionId:string):boolean{
 return Boolean(store.sqlite.prepare(`WITH RECURSIVE lineage(origin_id,source_id,session_id) AS (
      VALUES(?,?,?)
      UNION
      SELECT json_extract(h.payload_json,'$.settingsTransition.authorizationOriginRunId'),r.source_run_id,r.old_provider_session_id
      FROM lineage l JOIN context_rollovers r ON r.agent_id=? AND r.replacement_run_id=l.origin_id
        AND r.replacement_session_id=l.session_id AND r.state='completed' AND r.completion_reason='replacement_verified'
      JOIN activation_sources x ON x.source_kind='context_rollover' AND x.source_id=r.id
      JOIN agent_activations h ON h.id=x.activation_id AND h.kind='context_rollover_handoff'
      WHERE json_extract(h.payload_json,'$.settingsTransition.sourceRunId')=r.source_run_id
        AND json_extract(h.payload_json,'$.settingsTransition.oldSessionId')=r.old_provider_session_id
        AND json_type(h.payload_json,'$.settingsTransition.authorizationOriginRunId')='text'
     )
     SELECT 1 FROM lineage l JOIN scheduler_runs first ON first.id=l.origin_id AND first.agent_id=?
      JOIN scheduler_runs last ON last.id=l.source_id AND last.agent_id=first.agent_id AND last.scope_key=first.scope_key
      JOIN scheduler_runs r ON r.agent_id=first.agent_id AND r.scope_key=first.scope_key AND r.fencing_token BETWEEN first.fencing_token AND last.fencing_token
      JOIN memory_exposure_sources e ON e.run_id=r.id
     UNION
     SELECT 1 FROM lineage l JOIN scheduler_runs current ON current.id=l.origin_id AND current.agent_id=?
      JOIN context_rollovers parent ON parent.agent_id=current.agent_id AND parent.replacement_run_id=current.id
        AND parent.replacement_session_id=l.session_id AND parent.state='completed'
      JOIN scheduler_runs older ON older.agent_id=current.agent_id AND older.scope_key=current.scope_key AND older.fencing_token<current.fencing_token
      JOIN memory_exposure_sources e ON e.run_id=older.id
     UNION
     SELECT 1 FROM lineage l JOIN scheduler_runs first ON first.id=l.origin_id AND first.agent_id=?
      JOIN scheduler_runs last ON last.id=l.source_id AND last.agent_id=first.agent_id AND last.scope_key=first.scope_key
      JOIN scheduler_runs r ON r.agent_id=first.agent_id AND r.scope_key=first.scope_key AND r.fencing_token BETWEEN first.fencing_token AND last.fencing_token
      JOIN memory_exposure_runs e ON e.run_id=r.id WHERE e.pending<>0 OR e.uncertain<>0 OR e.unverified<>0
     UNION
     SELECT 1 FROM lineage l JOIN scheduler_runs current ON current.id=l.origin_id AND current.agent_id=?
      JOIN context_rollovers parent ON parent.agent_id=current.agent_id AND parent.replacement_run_id=current.id
        AND parent.replacement_session_id=l.session_id AND parent.state='completed'
      JOIN scheduler_runs older ON older.agent_id=current.agent_id AND older.scope_key=current.scope_key AND older.fencing_token<current.fencing_token
      JOIN memory_exposure_runs e ON e.run_id=older.id WHERE e.pending<>0 OR e.uncertain<>0 OR e.unverified<>0
     LIMIT 1`)
      .get(originId,sourceId,sessionId,agentId,agentId,agentId,agentId,agentId));
}

/** Reserve a real old-session handoff before eligible pending work is leased.
 * This only attempts a transition when the accepted policy and owner can be
 * checked against current state; all other admission paths keep their existing
 * behavior. requestContextRollover rechecks the source and queue transactionally. */
export async function requestSettingsTransition(input: {
  app:PonderosaServer; opts:CreateServerOptions; store:AgentStore; coordinationV3:CoordinationV3Store;
  workspace:WorkspaceStore; engines:ReadonlyMap<string,EngineRegistration>; engineAuthStatuses:EngineAuthStatusCache;
  cachedModelOptions:(adapter:Adapter,projectId?:string)=>ModelOption[]|undefined;
  excludedAgentIds:readonly string[];
  candidate:{activationId:string;agentId:string;projectId:string;scopeKey:string}|undefined;
  createOperationalNotification:TransitionNotices['createOperationalNotification'];resolveOperationalNotification:TransitionNotices['resolveOperationalNotification'];
}):Promise<boolean> {
 const {app,opts,store,coordinationV3,workspace,engines,engineAuthStatuses,cachedModelOptions,excludedAgentIds,candidate}=input;
 if(!candidate)return true;
 const pending=coordinationV3.pendingActivations(candidate.projectId).find(item=>item.id===candidate.activationId);
 if(!pending||pending.agentId!==candidate.agentId||!['human_message','coordination_request'].includes(pending.kind)||!['pending','retry_pending'].includes(pending.state))return true;
 let shouldHold=false;
 const localHolds=unrecordedHolds.get(coordinationV3)??new Map<string,string>();unrecordedHolds.set(coordinationV3,localHolds);
 let currentFingerprint:string;
 try{currentFingerprint=transitionFingerprint(input,pending.projectId,pending.agentId,pending.id);}catch{currentFingerprint='unavailable';}
 const priorLocalHold=localHolds.get(pending.id);
 if(priorLocalHold===currentFingerprint)return false;
 if(priorLocalHold)localHolds.delete(pending.id);
 const hold=(reason:string):boolean=>{
  try{const fingerprint=transitionFingerprint(input,pending.projectId,pending.agentId,pending.id);
   const held=coordinationV3.holdSettingsTransitionReservation({projectId:pending.projectId,agentId:pending.agentId,activationId:pending.id,fingerprint})||
    coordinationV3.holdUncertainSettingsTransitionReservation({projectId:pending.projectId,agentId:pending.agentId,activationId:pending.id,scopeKey:candidate.scopeKey,fingerprint});
   if(held){localHolds.delete(pending.id);try{transitionNotice(input,pending.projectId,pending.agentId,pending.id,reason);}catch{app.log.error({activationId:pending.id},'Context-review notice could not be recorded; the durable hold remains.');}}
   else localHolds.set(pending.id,fingerprint);
  }catch{localHolds.set(pending.id,currentFingerprint);app.log.error({activationId:pending.id},'Context hold could not be recorded; this work remains blocked locally.');}
  return false;
 };
  try{
   const row=store.sqlite.prepare(`SELECT a.scope_key,a.payload_json FROM agent_activations a WHERE a.id=? AND a.agent_id=? AND a.state IN ('pending','retry_pending') AND a.available_at<=? AND NOT EXISTS (SELECT 1 FROM activation_sources held WHERE held.activation_id=a.id AND held.source_kind IN ('task_decision_repair_wait','task_reply_repair_wait','branch_schedule_update','settings_transition_hold')) AND NOT EXISTS (SELECT 1 FROM activation_outbox audit WHERE audit.activation_id=a.id AND audit.event_kind='communication_revision' AND audit.processed_at IS NULL)`).get(pending.id,pending.agentId,new Date().toISOString()) as {scope_key:string;payload_json:string}|undefined;
   if(row&&!coordinationV3.settingsTransitionUnsubmittedActivation({projectId:pending.projectId,agentId:pending.agentId,activationId:pending.id,scopeKey:row.scope_key}))
    return hold('The earlier delivery attempt cannot be proven unsubmitted. The original work remains queued for review.');
   const payload=row?JSON.parse(row.payload_json) as {dispatch?:{engine?:unknown;model?:unknown;effort?:unknown;speed?:unknown;voiceReply?:unknown}}:undefined;
   const dispatch=payload?.dispatch,agent=store.getAgent(pending.agentId),project=agent&&store.getChatContext(agent.conversationId);
   const accepted=agent&&store.resumeSessionState(agent.id);
   const stopped=agent&&store.stoppedProviderSessionBoundary(agent.id);
   const stoppedUsage=stopped&&store.acceptedProviderSessionContextUsage(agent!.id);
   if(stopped&&row){
    if(!stopped.cleanupConfirmed)return hold('The earlier task stays stopped while its exact input or cleanup requires review. The new instruction remains queued; no provider input was sent.');
    if(row.scope_key!==stopped.scopeKey)return hold('The new instruction changes scope from the stopped context. Its earlier work is preserved; review the context before continuing.');
    if(!stoppedUsage||coordinationV3.contextRecovery.active(agent!.id))return hold('The earlier task stays stopped. Use Context recovery to preserve its native context for this new queued instruction; earlier effects will not be replayed.');
   }
   const recovered=agent&&store.acceptedProviderRecoveryBoundary(agent.id);
   if(agent&&row&&!stopped&&(coordinationV3.contextRecovery.active(agent.id)||store.uncertainProviderContextRecoveryBoundary(agent.id)))
    return hold('Earlier provider input or effects remain unconfirmed. Use Context recovery; this new instruction stays queued without replaying the original work.');
   const boundary=agent&&(store.providerCommandContextBoundary(agent.id)??recovered);
   // Only the existing accepted measurement after explicit hold dismissal may
   // expose a formerly interrupted packet here; this is not ordinary resume permission.
   const packet=agent&&(store.acceptedProviderSessionInput(agent.id)??(recovered?store.acceptedProviderSessionInput(agent.id,true):undefined));
   const contract=packet?.sourceManifest.schemaVersion===3?packet.sourceManifest.normalRuntimeContract:undefined;
   // Workspace guidance/profile edits must not bypass continuity merely because
   // the accepted boundary cannot support a verified native handoff.
   shouldHold=Boolean(row&&agent&&project&&accepted);
   if(shouldHold&&typeof packet?.exactSystemPrompt!=='string')
    return hold('The saved provider instructions are missing. The original work remains queued for context review.');
   const acceptedPromptChanged=Boolean(row&&agent&&project&&accepted&&typeof packet?.exactSystemPrompt==='string'&&
    await transitionSystemPromptHash(agent,project,workspace.getPreferences(),opts)!==createHash('sha256').update(packet.exactSystemPrompt).digest('hex'));
   if(currentFingerprint!==transitionFingerprint(input,pending.projectId,pending.agentId,pending.id))return false;
   shouldHold=acceptedPromptChanged;
   let grantExpansion=false;
   const unchangedOrHold=(reason:string)=>(acceptedPromptChanged||grantExpansion)?hold(reason+' The original work remains queued for context review.'):true;

   // Older accepted packets may have no runtime contract, while their Run
   // origin and a later explicit global-read removal are still available.
   // Treat that signal as a possible change, not proof of historical access.
   if(!contract&&row&&agent&&boundary&&accepted&&packet?.executionId&&
      boundary.providerSessionId===accepted.sessionId&&row.scope_key===`conversation:${agent.conversationId}`){
    const legacyMemory=localMemoryFor(app);
    if(legacyMemory){
     const status=await legacyMemory.retainedMemoryExposureStatus(agent.id,agent.conversationId,accepted.sessionId,packet.executionId,boundary.executionId);
     if(status==='changed'||status==='unavailable')
      return hold(status==='changed'?'A memory source previously used by this Agent was revoked or changed. The original work remains queued for context review.':
       'A previously used memory source could not be checked. The original work remains queued for context review.');
    }else{
     const known=hasKnownRetainedMemory(store,agent.id,packet.executionId,boundary.executionId,accepted.sessionId);
     if(known)return hold('A previously used memory source cannot be checked because Local Memory is unavailable. The original work remains queued for context review.');
    }
    if(legacyMemory?.legacyPossibleGlobalRevocation(agent.id,agent.conversationId,packet.executionId))
     return hold('Global memory access may have been removed since this older session began. Its earlier memory exposure is unavailable; the original work remains queued for context review.');
   }
   // A legacy packet may lack the full contract while still retaining the
   // accepted exact prompt. A demonstrable prompt change is not an unchanged
   // legacy session, and cannot safely use the ordinary reseed fallback.
   if(!contract && row && agent && project && accepted && typeof packet?.exactSystemPrompt==='string' &&
      agent.projectId===pending.projectId && project.id===pending.projectId &&
      row.scope_key===`conversation:${agent.conversationId}` && agent.workingCopy.state==='ready'){
    const currentHash=await transitionSystemPromptHash(agent,project,workspace.getPreferences(),opts);
    if(currentFingerprint!==transitionFingerprint(input,pending.projectId,pending.agentId,pending.id))return false;
    if(currentHash!==createHash('sha256').update(packet.exactSystemPrompt).digest('hex'))
     return hold('The earlier provider session has changed instructions but lacks a verified context boundary. The original work remains queued for review.');
   }
   // Do not silently reseed an explicitly changed/voice task when the old
   // accepted generation cannot be attributed to a completed boundary.
   const requiresKnownBoundary=Boolean(accepted&&agent&&row&&
     (dispatch?.voiceReply===true&&opts.localMemory || typeof dispatch?.model==='string' ||
      typeof dispatch?.effort==='string' || typeof dispatch?.speed==='string'));
   if(requiresKnownBoundary&&(!boundary||!packet||!contract||contract.version!==1))
    return hold('The earlier provider session lacks a complete, verified context boundary. The original work remains queued for review.');
   const policy=agent?new CapabilityPolicyStore(store.sqlite).resolveForAgent(agent.id):undefined;
   const restrictions=agent&&policy?runtimeRestrictions(policy,agent.activeEngine):undefined;
   const prior=contract?.capabilityRestrictions;
   grantExpansion=Boolean(restrictions&&isGrantOnlyRestrictionsChange(prior,restrictions));
   shouldHold ||= grantExpansion;
   if(agent&&coordinationV3.activeContextRollover(agent.id))return true;
   if(!row||!agent||!project||!boundary||!accepted||!packet||!contract||!policy||!restrictions||contract.version!==1||
      agent.projectId!==pending.projectId||project.id!==pending.projectId||row.scope_key!==`conversation:${agent.conversationId}`||
      boundary.providerSessionId!==accepted.sessionId||boundary.toolContractHash!==contract.contractHash||
      contract.engineId!==agent.activeEngine||contract.workingCopyId!==agent.workingCopy.id||
      agent.workingCopy.state!=='ready'||contract.cwd!==agent.workingCopy.rootPath||
      typeof packet.exactSystemPrompt!=='string'||typeof packet.executionId!=='string'||
      (typeof dispatch?.engine==='string'&&dispatch.engine!==agent.activeEngine))return unchangedOrHold('The saved provider boundary does not match the current Agent, Chat, runtime or queued work.');
   const memory=localMemoryFor(app);
   if(!memory){
    const known=hasKnownRetainedMemory(store,agent.id,packet.executionId,boundary.executionId,accepted.sessionId);
    if(known)return hold('A previously used memory source cannot be checked because Local Memory is unavailable. The original work remains queued for context review.');
   }
   const exposure=memory&&await memory.retainedMemoryExposureStatus(agent.id,agent.conversationId,accepted.sessionId,packet.executionId,boundary.executionId);
   if(exposure==='changed')
    return hold('A memory source previously used by this Agent was revoked or changed. Prior Agent text cannot yet be attributed safely; the original work remains queued for context review.');
   if(exposure==='unavailable')
    return hold('A previously used memory source could not be checked. The original work remains queued for context review.');
   if(exposure==='unknown'&&memory?.legacyPossibleGlobalRevocation(agent.id,agent.conversationId,packet.executionId))
    return hold('Global memory access may have been removed since this older session began. Its earlier memory exposure is unavailable; the original work remains queued for context review.');
   if(exposure==='unknown'&&contract.capabilityRestrictions&&
      !contract.capabilityRestrictions.restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead)&&
      new CapabilityPolicyStore(store.sqlite).resolveForAgent(agent.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead))
    return hold('Memory read access was removed since this older session began. Its earlier memory exposure is unavailable; the original work remains queued for context review.');
   // A verified replacement still belongs to this exact queued task. A
   // capability change after the handoff cannot silently adopt its summary.
   const completedTransition=store.sqlite.prepare(`SELECT h.payload_json FROM context_rollovers r
    JOIN activation_sources x ON x.source_kind='context_rollover' AND x.source_id=r.id
    JOIN agent_activations h ON h.id=x.activation_id AND h.kind='context_rollover_handoff'
    WHERE r.agent_id=? AND r.project_id=? AND r.state='completed' AND r.completion_reason='replacement_verified'
     AND r.replacement_run_id=? AND r.replacement_session_id=? AND json_extract(h.payload_json,'$.settingsTransition.activationId')=?
    ORDER BY r.updated_at DESC LIMIT 1`).get(agent.id,pending.projectId,boundary.executionId,accepted.sessionId,pending.id) as {payload_json:string}|undefined;
   const completedMarker=completedTransition?JSON.parse(completedTransition.payload_json)?.settingsTransition:undefined;
   if(completedMarker?.targetRestrictionsHash){
    const current=runtimeRestrictions(new CapabilityPolicyStore(store.sqlite).resolveForAgent(agent.id),agent.activeEngine);
    if(createHash('sha256').update(JSON.stringify(current)).digest('hex')!==completedMarker.targetRestrictionsHash)
     return hold('Access changed after the context handoff. The original work remains queued for review.');
   }
   const engine=engines.get(agent.activeEngine);
   if(!engine||![CodexAdapter.prototype,ClaudeAdapter.prototype].includes(Object.getPrototypeOf(engine.adapter))||Object.hasOwn(engine.adapter,'openSession'))return unchangedOrHold('This provider adapter does not support the verified context handoff.');
   const initialFingerprint=transitionFingerprint(input,pending.projectId,pending.agentId,pending.id);
   const {targetModel,targetEffort,targetSpeed}=settingsTransitionTarget(agent,project,engine.adapter,workspace.getPreferences(),cachedModelOptions(engine.adapter,project.id),dispatch);
   if(!targetModel?.trim()||!contract.model?.trim())return unchangedOrHold('The saved or target model is missing, so the instruction-change handoff cannot be verified.');
   const changed=targetModel!==contract.model||targetEffort!==contract.effort||targetSpeed!==(contract.speed??'standard');
   // A same-scope instruction change must bridge the old provider context,
   // even when model settings themselves are unchanged.
   const targetSystemPromptHash=await transitionSystemPromptHash(agent,project,workspace.getPreferences(),opts);
   if(initialFingerprint!==transitionFingerprint(input,pending.projectId,pending.agentId,pending.id))return false;
   const promptChanged=targetSystemPromptHash!==createHash('sha256').update(packet.exactSystemPrompt).digest('hex');
   const verifiedVoice=Boolean(opts.localMemory&&dispatch?.voiceReply===true&&store.sqlite.prepare(`SELECT 1
    FROM context_rollovers r JOIN activation_sources x ON x.source_kind='context_rollover' AND x.source_id=r.id
    JOIN agent_activations h ON h.id=x.activation_id AND h.kind='context_rollover_handoff'
    WHERE r.agent_id=? AND r.project_id=? AND r.state='completed' AND r.completion_reason='replacement_verified'
      AND r.replacement_run_id=? AND r.replacement_session_id=?
      AND json_extract(h.payload_json,'$.settingsTransition.activationId')=?
      AND json_extract(h.payload_json,'$.settingsTransition.targetModel')=?
      AND json_extract(h.payload_json,'$.settingsTransition.targetEffort') IS ?
      AND json_extract(h.payload_json,'$.settingsTransition.targetSpeed') IS ? LIMIT 1`)
    .get(agent.id,pending.projectId,boundary.executionId,accepted.sessionId,pending.id,targetModel,targetEffort??null,targetSpeed??null));
   const voiceBoundary=Boolean(opts.localMemory&&dispatch?.voiceReply===true&&!verifiedVoice);
   if(voiceBoundary&&!stopped&&!changed&&!promptChanged&&!grantExpansion&&memory&&
      agent.activeEngine==='codex'&&Object.getPrototypeOf(engine.adapter)===CodexAdapter.prototype&&!Object.hasOwn(engine.adapter,'openSession')&&
      prior&&restrictions.filesystemWriteRestricted===prior.filesystemWriteRestricted&&
      JSON.stringify(restrictions.restrictedCapabilityIds)===JSON.stringify(prior.restrictedCapabilityIds)&&
      JSON.stringify(restrictions.restrictedConnectorNames)===JSON.stringify(prior.restrictedConnectorNames)){
    assertRetainedNativeAuthentication(contract,engineAuthStatuses.snapshot(agent.activeEngine));
    const tools=filterRuntimeToolsForCapabilities([...providerDynamicTools(Boolean(opts.localMemory)),PONDEROSA_HISTORY_TOOL],policy);
    const ordinary=providerToolContractHash(tools,communicationV3SessionPrompt());
    const toolHash=policy.restrictedCapabilityIds.length?createHash('sha256').update(JSON.stringify({tools:ordinary,restrictions})).digest('hex'):ordinary;
    const runtimeHash=providerRuntimeSessionContractHash({runtimeSessionContractHash:providerSessionContractHash(agent.activeEngine,agent.workingCopy.id,targetModel,targetEffort,toolHash),
      speed:targetSpeed,...(contract.observedBillingMode?{billingMode:contract.observedBillingMode}:{}),systemPromptHash:targetSystemPromptHash,scopeKey:row.scope_key},contract.contractHash);
    if(runtimeHash===contract.contractHash){
     const retained=proveRetainedCodexVoiceContext({store,memory,agentId:agent.id,chatId:agent.conversationId,sessionId:accepted.sessionId,
       sourceRunId:boundary.executionId,contractHash:runtimeHash,systemPromptHash:targetSystemPromptHash});
     if(retained?.isCurrent()){
      store.sqlite.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_retry_pending'").run(pending.id);
      return true;
     }
    }
   }
   if(stopped&&(changed||voiceBoundary||promptChanged||grantExpansion))
    return hold('Recovered context from the stopped task is retained, but the requested settings or voice transition lacks a verified handoff. The new instruction remains queued for review.');
   if(grantExpansion&&(changed||voiceBoundary||promptChanged))return hold('Access expanded together with other runtime settings. The original work remains queued for context review.');
   if(!changed&&!voiceBoundary&&!promptChanged&&!grantExpansion){
    store.sqlite.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_retry_pending'").run(pending.id);
    return true;
   }
   if(exposure==='unknown')
    return hold('The Agent’s earlier memory exposure cannot be verified. The original work remains queued for context review.');
   shouldHold=true;
   assertRetainedNativeAuthentication(contract,engineAuthStatuses.snapshot(agent.activeEngine));
   if(Boolean(opts.localMemory)!==Boolean(memory))return hold('Memory access could not be verified. The original work remains queued; review the Agent’s context before retrying.');
   const authorization=memory?.transitionAuthorization(agent.id,agent.conversationId,accepted.sessionId,packet.executionId,boundary.executionId);
   if(memory&&!authorization)return hold('Earlier memory access could not be verified or a source changed. The original work remains queued; review the Agent’s context before retrying.');
   if(memory&&authorization&&!await memory.validateTransitionReads(agent.id,agent.conversationId,packet.executionId,boundary.executionId,boundary.executionId,authorization.signature))
    return hold('A memory source used by this Agent changed or is unavailable. The original work remains queued; review its context before retrying.');
   if(!grantExpansion&&(!prior||restrictions.filesystemWriteRestricted!==prior.filesystemWriteRestricted||
      JSON.stringify(restrictions.restrictedCapabilityIds)!==JSON.stringify(prior.restrictedCapabilityIds)||
      JSON.stringify(restrictions.restrictedConnectorNames)!==JSON.stringify(prior.restrictedConnectorNames)))return unchangedOrHold('Capability restrictions changed, so the retained context cannot be transferred under the current access policy.');
   const handoffPolicy=grantExpansion?{...policy,restrictedCapabilityIds:prior!.restrictedCapabilityIds}:policy;
   const handoffRestrictions=runtimeRestrictions(handoffPolicy,agent.activeEngine);
   if(grantExpansion&&(handoffRestrictions.filesystemWriteRestricted!==prior!.filesystemWriteRestricted||
    JSON.stringify(handoffRestrictions.restrictedCapabilityIds)!==JSON.stringify(prior!.restrictedCapabilityIds)||
    JSON.stringify(handoffRestrictions.restrictedConnectorNames)!==JSON.stringify(prior!.restrictedConnectorNames)))return hold('The saved restrictions cannot be verified. The original work remains queued for context review.');
   const tools=filterRuntimeToolsForCapabilities([...providerDynamicTools(Boolean(opts.localMemory)),PONDEROSA_HISTORY_TOOL],handoffPolicy);
   const communicationPrompt=communicationV3SessionPrompt(),preferences=workspace.getPreferences();
   // The old provider already has its accepted system prompt. Use its exact
   // recorded bytes for the old-session handoff; the replacement receives
   // current guidance after the handoff is verified.
   const systemPrompt=packet.exactSystemPrompt,systemPromptHash=createHash('sha256').update(systemPrompt).digest('hex');
   const ordinaryToolHash=providerToolContractHash(tools,communicationPrompt),toolHash=handoffPolicy.restrictedCapabilityIds.length?createHash('sha256').update(JSON.stringify({tools:ordinaryToolHash,restrictions:handoffRestrictions})).digest('hex'):ordinaryToolHash;
   const oldHash=providerRuntimeSessionContractHash({runtimeSessionContractHash:providerSessionContractHash(agent.activeEngine,agent.workingCopy.id,contract.model,contract.effort,toolHash),speed:contract.speed,...(contract.observedBillingMode?{billingMode:contract.observedBillingMode}:{}),systemPromptHash,scopeKey:row.scope_key},contract.contractHash);
   if(oldHash!==contract.contractHash)return hold('The prior provider context could not be verified. The original work remains queued; review the Agent’s context before retrying.');
   const acceptedTail=store.acceptedProviderSessionCommunicationEventIds(agent.id);if(!acceptedTail)return hold('The prior context boundary is unavailable. The original work remains queued; review the Agent’s context before retrying.');
   const measured=store.acceptedProviderSessionContextUsage(agent.id)?.usage;
   const pressure=evaluateContextRolloverPressure(measured?{usedTokens:measured.usedTokens,...(measured.windowTokens===undefined?{}:{windowTokens:measured.windowTokens})}:{usedTokens:0},preferences);
   const frozen=store.bindContextRolloverBoundary({agentId:agent.id,currentConversationId:agent.conversationId,submittedCommunicationEventIds:acceptedTail,maxUtf8Bytes:Math.min(pressure.lowWaterMark,MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES)});
   const reserved=store.sqlite.transaction(()=>{
   const selected=coordinationV3.peekNextRunnable({excludedAgentIds});
   if(!selected||selected.activationId!==candidate.activationId||selected.agentId!==candidate.agentId||selected.scopeKey!==candidate.scopeKey||
      initialFingerprint!==transitionFingerprint(input,pending.projectId,pending.agentId,pending.id))return false;
   coordinationV3.requestContextRollover({projectId:agent.projectId,agentId:agent.id,oldProviderSessionId:accepted.sessionId,providerSessionGeneration:accepted.sessionId,
    ...(measured?{detectedOccupancy:measured.usedTokens,...(measured.aggregateTokens===undefined?{}:{aggregateTokens:measured.aggregateTokens}),...(measured.windowTokens===undefined?{}:{contextWindow:measured.windowTokens})}:{}),
    threshold:pressure.threshold,lowWaterMark:pressure.lowWaterMark,sourceRunId:boundary.executionId,sourceActivationIds:coordinationV3.activationIdsAttachedToRun(boundary.executionId,agent.id),scopeKey:row.scope_key,conversationId:agent.conversationId,
    compactionCutoffOrdinal:frozen.canonicalOrdinal,compactionCutoffEventId:frozen.communicationEventId,recentTail:frozen.recentTail,
    settingsTransition:{reason:changed||grantExpansion?'settings':voiceBoundary?'voice':'prompt',targetSystemPromptHash,targetRestrictionsHash:createHash('sha256').update(JSON.stringify(restrictions)).digest('hex'),activationId:pending.id,sourceRunId:boundary.executionId,sourceFence:boundary.fencingToken,oldContractHash:contract.contractHash,oldSessionId:accepted.sessionId,engineId:agent.activeEngine,model:contract.model!,...(contract.effort?{effort:contract.effort}:{}),...(contract.speed?{speed:contract.speed}:{}),targetModel,...(targetEffort?{targetEffort}:{}),targetSpeed,...(authorization?{authorizationSignatureHash:authorization.signature,authorizationOriginRunId:packet.executionId}:{})},
   });
   store.sqlite.prepare("DELETE FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_retry_pending'").run(pending.id);
   return true;
   })();
   return reserved;
  }catch(cause){
   // If SQLite committed before a caller saw an exception, adopt the matching
   // durable rollover instead of replaying it or releasing the queued work.
   const existing=coordinationV3.activeContextRollover(pending.agentId);
   const owns=existing&&store.sqlite.prepare(`SELECT 1 FROM agent_activations WHERE kind='context_rollover_handoff'
    AND json_extract(payload_json,'$.rolloverId')=? AND json_extract(payload_json,'$.settingsTransition.activationId')=?`).get(existing.id,pending.id);
   if(owns)return false;
   return shouldHold?hold(freshFailureDiagnostic(cause,'Ponderosa could not prepare the context handoff. The original work remains queued; review the Agent’s activity before retrying.')):true;
  }
}
