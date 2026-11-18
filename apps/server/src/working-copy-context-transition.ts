import {createHash} from 'node:crypto';
import {CapabilityPolicyStore,type AgentStore,type CoordinationV3Store,type WorkspaceStore} from '@ponderosa/agents';
import {filterRuntimeToolsForCapabilities,runtimeRestrictions,PONDEROSA_HISTORY_TOOL,type AgentDto,type AgentWorkingCopyMode} from '@ponderosa/core';
import {MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES} from '@ponderosa/core/seed-history';
import {CodexAdapter,ClaudeAdapter} from '@ponderosa/engines';
import type {EngineRegistration} from './app-contracts.js';
import type {AgentWorkingCopyService} from './agent-working-copy-service.js';
import type {EngineAuthStatusCache} from './engine-auth-cache.js';
import type {LocalMemoryService} from './local-memory.js';
import {evaluateContextRolloverPressure,contextRecoveryRequired} from './context-rollover-pressure.js';
import {workingCopyDiagnostic} from './working-copy-diagnostic.js';
import {assertRetainedNativeAuthentication,communicationV3SessionPrompt,providerDynamicTools,providerRuntimeSessionContractHash,providerSessionContractHash,providerToolContractHash} from './runtime-selection.js';

type Context={memory?:LocalMemoryService;store:AgentStore;coordinationV3:CoordinationV3Store;workspace:WorkspaceStore;
 engines:ReadonlyMap<string,EngineRegistration>;engineAuthStatuses:Pick<EngineAuthStatusCache,"snapshot">;workingCopies:AgentWorkingCopyService;
 drainRuntime?(id:string,projectId:string):Promise<void>};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function settingsHash(ctx:Context,agent:AgentDto):string{
 const project=ctx.store.getChatContext(agent.conversationId),prefs=ctx.workspace.getPreferences();
 const restrictions=runtimeRestrictions(new CapabilityPolicyStore(ctx.store.sqlite).resolveForAgent(agent.id),agent.activeEngine);
 return hash({id:agent.id,projectId:agent.projectId,conversationId:agent.conversationId,title:agent.title,handle:agent.handle,engine:agent.activeEngine,model:agent.model,effort:agent.effort,speed:agent.speed,role:agent.role,
  project:project&&{id:project.id,hostPath:project.hostPath,instructions:project.instructions,defaultEngine:project.defaultEngine,defaultModel:project.defaultModel,defaultEffort:project.defaultEffort},
  instructions:prefs.globalInstructions,profile:prefs.profile,defaults:prefs.engineDefaults,restrictions,memory:Boolean(ctx.memory)});
}

/** Projection only. Canonical workingCopy never reports a pending choice as saved. */
export function workingCopyChangeStatus(ctx:Pick<Context,'store'|'coordinationV3'>,agentId:string):AgentDto{
 const agent=ctx.store.getAgent(agentId);if(!agent)throw Error('Agent not found');
 const current=ctx.coordinationV3.workingCopyTransitionForAgent(agentId);if(!current)return agent;
 const {rollover:r,change}=current;
 const kept=r.state==='completed'&&change.keptCurrent===true;
 const completed=kept||r.state==='completed'&&r.completionReason==='replacement_verified';
 const held=!completed&&['failed','outcome_unknown','completed'].includes(r.state);
 const known=change.appliedCopy??change.oldCopy;
 const knownCopy=agent.workingCopy.id===known.id&&agent.workingCopy.mode===known.mode&&agent.workingCopy.rootPath===known.rootPath;
 return {...agent,workingCopyChange:{rolloverId:r.id,mode:change.mode,
  phase:kept?'kept_current':completed?'completed':held?'held':r.state==='requested'?'handoff':agent.workingCopy.mode===change.mode&&agent.workingCopy.state==='ready'?'verifying':'preparing',
  retryable:r.state==='failed'&&Boolean(r.handoffEventId)&&!r.replacementRunId&&!r.replacementSessionId&&knownCopy,
  canKeepCurrent:ctx.coordinationV3.canKeepWorkingCopyTransition(r.id),
  ...(held?{message:change.failureMessage??agent.workingCopy.failure??r.lastError??'Working-folder context is unconfirmed. Inspect Activity before another change.'}:{})}};
}

export async function requestWorkingCopyChange(ctx:Context,agent:AgentDto,mode:AgentWorkingCopyMode):Promise<AgentDto|undefined>{
 const previous=ctx.coordinationV3.workingCopyTransitionForAgent(agent.id);
 if(previous&&!(previous.rollover.state==='completed'&&(previous.rollover.completionReason==='replacement_verified'||previous.change.keptCurrent===true))){
  if(previous.change.mode!==mode)throw Error('A different working-folder choice is still pending. Inspect its status first.');
  if(workingCopyChangeStatus(ctx,agent.id).workingCopyChange?.retryable)ctx.coordinationV3.retryWorkingCopyTransition(previous.rollover.id);
  return workingCopyChangeStatus(ctx,agent.id);
 }
 if(agent.workingCopy.mode===mode&&agent.workingCopy.state==='ready')return undefined;
 const accepted=ctx.store.resumeSessionState(agent.id);if(!accepted)return undefined;
 const originalSettingsHash=settingsHash(ctx,agent);
 if(ctx.coordinationV3.activeContextRollover(agent.id)||ctx.coordinationV3.contextRecovery.active(agent.id))
  throw Error('Finish the existing context transition or recovery before changing the working folder.');
 const engine=ctx.engines.get(agent.activeEngine);
 if(!engine||![CodexAdapter.prototype,ClaudeAdapter.prototype].includes(Object.getPrototypeOf(engine.adapter))||Object.hasOwn(engine.adapter,'openSession'))
  throw Error('This provider cannot preserve context across a working-folder change; the original folder and context were retained.');
 const boundary=ctx.store.providerCommandContextBoundary(agent.id);
 const packet=boundary&&ctx.store.getProviderInput(boundary.executionId,true);
 const contract=packet?.sourceManifest.schemaVersion===3?packet.sourceManifest.normalRuntimeContract:undefined;
 if(!boundary||!packet?.exactSystemPrompt||!contract||contract.workingCopyId!==agent.workingCopy.id||contract.cwd!==agent.workingCopy.rootPath||
  contract.contractHash!==accepted.toolContractHash||boundary.providerSessionId!==accepted.sessionId||!contract.model)
  throw Error('The saved provider context cannot be verified; the working folder and history were retained.');
 assertRetainedNativeAuthentication(contract,ctx.engineAuthStatuses.snapshot(agent.activeEngine));
 const policy=new CapabilityPolicyStore(ctx.store.sqlite).resolveForAgent(agent.id),restrictions=runtimeRestrictions(policy,agent.activeEngine);
 const tools=filterRuntimeToolsForCapabilities([...providerDynamicTools(Boolean(ctx.memory)),PONDEROSA_HISTORY_TOOL],policy);
 const ordinary=providerToolContractHash(tools,communicationV3SessionPrompt());
 const toolHash=policy.restrictedCapabilityIds.length?hash({tools:ordinary,restrictions}):ordinary;
 const scopeKey=ctx.coordinationV3.runScopeKey(boundary.executionId,agent.id);
 if(!scopeKey||!(scopeKey===`agent:${agent.id}`||scopeKey===`conversation:${agent.conversationId}`))throw Error('The saved context scope is unavailable; the working folder was retained.');
 const conversationId=agent.conversationId;
 const exactHash=providerRuntimeSessionContractHash({runtimeSessionContractHash:providerSessionContractHash(agent.activeEngine,agent.workingCopy.id,contract.model,contract.effort,toolHash),
  speed:contract.speed,...(contract.observedBillingMode?{billingMode:contract.observedBillingMode}:{}),
  systemPromptHash:createHash('sha256').update(packet.exactSystemPrompt).digest('hex'),scopeKey},contract.contractHash);
 if(exactHash!==contract.contractHash)throw Error('The saved provider policy changed; review context before changing the working folder.');
 const memory=ctx.memory,memoryOrigin=memory?ctx.store.acceptedProviderSessionInput(agent.id):undefined;
 const authorization=memory&&memoryOrigin?memory.transitionAuthorization(agent.id,agent.conversationId,accepted.sessionId,memoryOrigin.executionId,boundary.executionId):undefined;
 const exposure=memory&&memoryOrigin?await memory.retainedMemoryExposureStatus(agent.id,agent.conversationId,accepted.sessionId,memoryOrigin.executionId,boundary.executionId):undefined;
 if(exposure==='changed')throw Error('Earlier memory access changed or was revoked; the working folder and context were retained.');
 if(memory&&(!memoryOrigin||exposure!=='valid'||!authorization||!await memory.validateTransitionReads(agent.id,agent.conversationId,memoryOrigin.executionId,boundary.executionId,boundary.executionId,authorization.signature)))
  throw Error('Earlier memory access changed or cannot be verified; the working folder and context were retained.');
 const tail=ctx.store.acceptedProviderSessionCommunicationEventIds(agent.id);if(!tail)throw Error('The exact saved context boundary is unavailable; the folder was retained.');
 const measured=ctx.store.acceptedProviderSessionContextUsage(agent.id)?.usage;
 const pressure=evaluateContextRolloverPressure(measured??{usedTokens:0},ctx.workspace.getPreferences());
 const frozen=ctx.store.bindContextRolloverBoundary({agentId:agent.id,...(conversationId?{currentConversationId:conversationId}:{}),submittedCommunicationEventIds:tail,
  maxUtf8Bytes:Math.min(pressure.lowWaterMark,MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES)});
 const current=ctx.store.getAgent(agent.id);if(!current||current.workingCopy.id!==agent.workingCopy.id||current.workingCopy.mode!==agent.workingCopy.mode||current.workingCopy.rootPath!==agent.workingCopy.rootPath||settingsHash(ctx,current)!==originalSettingsHash)throw Error('Working-folder ownership, settings or access changed before Save; the folder and context were retained.');
 ctx.coordinationV3.requestContextRollover({projectId:agent.projectId,agentId:agent.id,oldProviderSessionId:accepted.sessionId,providerSessionGeneration:accepted.sessionId,
  triggerKind:'human',...(measured?{detectedOccupancy:measured.usedTokens}:{}),threshold:pressure.threshold,lowWaterMark:pressure.lowWaterMark,
  sourceRunId:boundary.executionId,sourceActivationIds:[],scopeKey,...(conversationId?{conversationId}:{}),
  compactionCutoffOrdinal:frozen.canonicalOrdinal,compactionCutoffEventId:frozen.communicationEventId,recentTail:frozen.recentTail,
  workingCopyTransition:{mode,sourceRunId:boundary.executionId,oldSessionId:accepted.sessionId,oldCopy:{id:agent.workingCopy.id,mode:agent.workingCopy.mode,rootPath:agent.workingCopy.rootPath},sourceFence:boundary.fencingToken,
   oldContractHash:contract.contractHash,settingsHash:originalSettingsHash,...(authorization?{authorizationSignatureHash:authorization.signature,authorizationOriginRunId:memoryOrigin!.executionId}:{})}});
 return workingCopyChangeStatus(ctx,agent.id);
}

/** Called before any cwd-dependent replacement input is prepared. */
export async function prepareWorkingCopyTransition(ctx:Context,agent:AgentDto,runId:string|undefined,fencingToken:number|undefined){
 const current=ctx.coordinationV3.workingCopyTransitionForAgent(agent.id);if(!current)return undefined;
 const {rollover:r,change}=current;
 if(r.state==='completed'&&(r.completionReason==='replacement_verified'||change.keptCurrent===true))return undefined;
 const activations=runId?ctx.coordinationV3.activationPayloads(agent.id,ctx.coordinationV3.activationIdsAttachedToRun(runId,agent.id),runId):[];
 const handoff=r.state==='requested'&&activations.some(a=>a.kind==='context_rollover_handoff'&&(a.payload as {rolloverId?:string})?.rolloverId===r.id);
 const candidate=runId&&ctx.coordinationV3.contextRolloverCandidateForRun(runId,agent.id);
 if(!handoff&&(!candidate||candidate.id!==r.id||r.state!=='continuation_ready'))
  throw contextRecoveryRequired('The working-folder change is still preserving or recovering context. Inspect its status; ordinary work remains queued.');
 const packet=ctx.store.getProviderInput(r.sourceRunId,true),contract=packet?.sourceManifest.schemaVersion===3?packet.sourceManifest.normalRuntimeContract:undefined;
 if(!contract||!packet?.exactSystemPrompt)throw Error('The exact working-folder source instructions are unavailable.');
 const assertCurrent=()=>{
  const owner=ctx.store.getAgent(agent.id),saved=ctx.store.resumeSessionState(agent.id);
  const run=runId&&ctx.store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND agent_id=? AND fencing_token=? AND status IN ('leased','running')").get(runId,agent.id,fencingToken);
  if(!run)throw Error('The working-folder transition lost its current Run authority; the operation remains held.');
  const latest=ctx.coordinationV3.contextRollover(r.id);
  const oldAccepted=saved?.sessionId===r.oldProviderSessionId&&saved.toolContractHash===change.oldContractHash;
  const replacementAccepted=latest?.state==='completed'&&latest.completionReason==='replacement_verified'&&saved?.sessionId===latest.replacementSessionId;
  if(!owner||settingsHash(ctx,owner)!==change.settingsHash||(!oldAccepted&&!replacementAccepted))
   throw Error('Settings or access changed during the working-folder handoff. Context remains held.');
  assertRetainedNativeAuthentication(contract,ctx.engineAuthStatuses.snapshot(owner.activeEngine));
  const memory=ctx.memory;
  if(memory&&(!change.authorizationSignatureHash||!change.authorizationOriginRunId||!memory.transitionAuthorizationStillValid(owner.id,owner.conversationId,change.authorizationOriginRunId,r.sourceRunId,runId!,change.authorizationSignatureHash)))
   throw Error('Memory access changed during the working-folder handoff. Context remains held.');
 };
 const validateSources=async()=>{
  assertCurrent();const memory=ctx.memory;
  if(memory&&(!change.authorizationSignatureHash||!change.authorizationOriginRunId||!await memory.validateTransitionReads(agent.id,agent.conversationId,change.authorizationOriginRunId,r.sourceRunId,runId!,change.authorizationSignatureHash)))
   throw Error('A previously used memory source changed; the working-folder transition remains held.');
  assertCurrent();
 };
 await validateSources();
 if(!handoff){
  if(!r.handoffEventId||!ctx.store.continuationHandoffForRollover(agent.id,r.handoffEventId))throw Error('The committed working-folder handoff is unavailable.');
  const release=ctx.workingCopies.beginModeChange(agent.id);
  try{
   await ctx.workingCopies.awaitUses(new Set([agent.id]));assertCurrent();
   const boundary=ctx.store.sqlite.prepare(`SELECT 1 FROM continuation_handoffs h JOIN scheduler_runs source ON source.id=h.source_execution_id
     WHERE h.id=? AND h.agent_id=? AND h.consumed_at IS NULL AND source.provider_session_id=? AND source.status='completed'
       AND source.prompt_injection_state='injected'
       AND NOT EXISTS(SELECT 1 FROM scheduler_prompt_injections i WHERE i.run_id=source.id AND i.state IN ('pending','submitted','outcome_unknown'))
       AND NOT EXISTS(SELECT 1 FROM scheduler_runs later WHERE later.agent_id=source.agent_id AND later.id<>? AND later.fencing_token>source.fencing_token AND later.prompt_injection_state<>'not_injected')`)
     .get(r.handoffEventId,agent.id,r.oldProviderSessionId,runId);
   if(!boundary)throw Error('The exact old-session handoff boundary changed or is unconfirmed; folder mutation remains held.');
   const before=ctx.store.getAgent(agent.id);if(!before)throw Error('Agent disappeared during working-folder change.');
   const knownCopy=change.appliedCopy??change.oldCopy;
   if(before.workingCopy.id!==knownCopy.id||before.workingCopy.mode!==knownCopy.mode||before.workingCopy.rootPath!==knownCopy.rootPath)
    throw Error('Working-folder ownership is not bound to this saved intent. Preserve its data and review Activity before another change.');
   const project=ctx.store.getProject(before.projectId);if(!project)throw Error('Agent Project is unavailable.');
   const changed=await ctx.workingCopies.setMode(before,project,change.mode,async()=>{
    assertCurrent();ctx.coordinationV3.updateWorkingCopyTransition(r.id,runId!,fencingToken!,{mutationStarted:true});
    if(!ctx.drainRuntime)throw Error('Working-folder runtime drain authority is unavailable.');
    await ctx.drainRuntime(agent.id,project.id);assertCurrent();
   });
   const copy={id:changed.workingCopy.id,mode:changed.workingCopy.mode,rootPath:changed.workingCopy.rootPath};
   ctx.coordinationV3.recordWorkingCopyTransitionCopy({id:r.id,runId:runId!,fencingToken:fencingToken!,previous:knownCopy,copy});
   change.appliedCopy=copy;
   if(changed.workingCopy.state!=='ready'||changed.workingCopy.mode!==change.mode)throw Error(changed.workingCopy.failure??'Working-folder creation is incomplete; inspect its retained state.');
   agent=changed;
  }catch(error){
   const message=workingCopyDiagnostic(error);
   try{ctx.coordinationV3.updateWorkingCopyTransition(r.id,runId!,fencingToken!,{failureMessage:message});}
   catch(recordError){throw Error(message+' Failure receipt could not be confirmed: '+workingCopyDiagnostic(recordError));}
   throw Error(message);
  }finally{release();}
 }
 return {agent,handoff,sourceSystemPrompt:packet.exactSystemPrompt,assertCurrent,validateSources};
}

/** An explicit escape only when setMode never reached its beforeMutation hook. */
export async function keepCurrentWorkingCopy(ctx:Context,agent:AgentDto,id:string):Promise<AgentDto>{
 const current=ctx.coordinationV3.workingCopyTransitionForAgent(agent.id);
 if(!current||current.rollover.id!==id)throw Error('The saved working-folder choice changed; refresh its status.');
 if(current.rollover.state==='completed'&&current.change.keptCurrent===true)return workingCopyChangeStatus(ctx,agent.id);
 if(settingsHash(ctx,agent)!==current.change.settingsHash)throw Error('Settings or access changed. Review context before continuing in this folder.');
 const packet=ctx.store.getProviderInput(current.rollover.sourceRunId,true),contract=packet?.sourceManifest.schemaVersion===3?packet.sourceManifest.normalRuntimeContract:undefined;
 if(!contract)throw Error('The saved context contract is unavailable; the working folder remains held.');
 assertRetainedNativeAuthentication(contract,ctx.engineAuthStatuses.snapshot(agent.activeEngine));
 const memory=ctx.memory,change=current.change;
 if(memory&&(!change.authorizationSignatureHash||!change.authorizationOriginRunId||!await memory.validateTransitionReads(agent.id,agent.conversationId,change.authorizationOriginRunId,current.rollover.sourceRunId,current.rollover.sourceRunId,change.authorizationSignatureHash)))
  throw Error('Earlier memory access changed or cannot be verified; context remains held.');
 const owner=ctx.store.getAgent(agent.id);if(!owner||settingsHash(ctx,owner)!==change.settingsHash)throw Error('Settings or access changed before the folder choice could be retained.');
 ctx.coordinationV3.keepWorkingCopyTransition(id);
 return workingCopyChangeStatus(ctx,agent.id);
}
