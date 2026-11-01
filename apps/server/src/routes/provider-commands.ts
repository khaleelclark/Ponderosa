import { registerNativeHistoryRoutes } from "./native-history.js";
import { NativeHistoryAuthority } from "../native-history-authority.js";
import { registerSourceEffectRoutes } from "./source-effects.js";
import { registerNativeControlRoutes } from "./native-controls.js";
import { registerContextRecoveryRoutes } from "./context-recovery.js";
import { randomUUID } from "node:crypto";
import type {
  CancelAgentRunRequest,
  CancelAgentRunResponse,
  EngineCapabilities,
  ModelOption,
  ProviderUsageStateDto,
  RuntimeProcessHandle,
  RuntimeSession,
} from "@ponderosa/core";
import { publicProviderFailure, runtimeRestrictions } from "@ponderosa/core";
import {
  CapabilityPolicyStore,
  CoordinationIdempotencyConflictError,
  MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES,
  type AgentStore,
  type CoordinationV3Store,
  type StoredLogEvent,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type {
  ActiveRun,
  CapabilityDiscoveryAuthority,
  CapabilityDiscoveryProcess,
  EngineRegistration,
  PersistentRuntime,
} from "../app-contracts.js";
import {
  concreteRuntimeSelection,
  providerSessionContractHash,
} from "../runtime-selection.js";
import type { ServerContext } from "../server-context.js";
import type { ProviderProcessAuthority } from "../provider-process-authority.js";
import type { AgentWorkingCopyService } from "../agent-working-copy-service.js";
import { evaluateContextRolloverPressure } from "../context-rollover-pressure.js";
import {
  guardedProviderExceptionStringProperty,
  restrictedProviderExceptionLogDetail,
} from "../provider-exception-properties.js";
import {
  projectProviderCapabilities,
  projectProviderCommandResult,
} from "../provider-success-projection.js";
import {
  readProviderContextUsage,
  readProviderSessionIdentifier,
} from "../provider-session-success.js";
import {
  providerProcessHandleFacade,
  providerRuntimeOperation,
  providerSessionFacade,
} from "../provider-session-facade.js";
import { registerAgentRunHistoryRoute } from "./agent-audit.js";

interface ProviderCommandRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  activeRuns: Map<string, ActiveRun>;
  scheduledSessionRollovers: Map<string, string>;
  deletingProjectIds: ReadonlySet<string>;
  deletingAgentIds: ReadonlySet<string>;
  engineCapabilityDiscoveryAuthorities: Set<CapabilityDiscoveryAuthority>;
  serverContext: ServerContext;
  isClosed(): boolean;
  notifyScheduler(): void;
  reusableRuntime(agentId: string): PersistentRuntime | undefined;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  retireCompletedContextRolloverSession(input: {
    agentId: string;
    projectId?: string;
    rolloverId?: string;
    providerSessionGeneration?: string;
  }): Promise<boolean>;
  closeRunBrowser(agentId: string, run: ActiveRun, reason: string): Promise<void>;
  publishMessageDeliveryChanged(agentId: string): void;
  publish(agentId: string, stored: StoredLogEvent): void;
  cachedModelOptions(
    adapter: EngineRegistration["adapter"],
    projectId?: string,
  ): ModelOption[] | undefined;
  closeCapabilityDiscoveryAuthority(authority: CapabilityDiscoveryAuthority): Promise<void>;
  closeCapabilityDiscoveryProcess(state: CapabilityDiscoveryProcess): Promise<void>;
  providerUsageState(
    registration: EngineRegistration,
    refresh?: "none" | "stale" | "force",
  ): Promise<ProviderUsageStateDto>;
  reportRuntimeCapabilitiesChanged(projectId: string, engineId: string): void;
  providerProcessAuthority: ProviderProcessAuthority;
  workingCopies: AgentWorkingCopyService;
}

export function authorizedManualRolloverConversationId(
  agent: { conversationId: string },
  sourceConversationId?: string,
  sourceRunHasCommunication = sourceConversationId !== undefined,
): string | undefined {
  // Internal handoff Runs have no authored Communication of their own. Their
  // accepted provider session can still contain collaboration from the
  // Agent's owning Chat, which must retain that exact Chat authority.
  if (!sourceRunHasCommunication) return agent.conversationId;
  return sourceConversationId === agent.conversationId ? agent.conversationId : undefined;
}

class NativeContextUnavailableError extends Error {}

function publicProviderCommandFailure(error: unknown): {
  error: string;
  category: ReturnType<typeof publicProviderFailure>["category"];
  remediation: string;
  retryable?: false;
} {
  if (error instanceof NativeContextUnavailableError) return { error: error.message, category: "unknown",
    remediation: "Use Context Refresh after resolving any unfinished work or uncertain outcome.", retryable: false };
  const code = guardedProviderExceptionStringProperty(error, "code")
    ?? guardedProviderExceptionStringProperty(error, "errorCode");
  const category = guardedProviderExceptionStringProperty(error, "category")
    ?? guardedProviderExceptionStringProperty(error, "failureCategory");
  const failure = publicProviderFailure({
    detail: guardedProviderExceptionStringProperty(error, "message"),
    code,
    category,
  });
  return {
    error: failure.summary,
    category: failure.category,
    remediation: failure.remediation,
  };
}

export function registerProviderCommandRoutes(
  app: FastifyInstance,
  context: ProviderCommandRoutesContext,
): void {
  registerNativeControlRoutes(app, context);
  const {
    store,
    coordinationV3,
    workspace,
    engines,
    activeRuns,
    scheduledSessionRollovers,
    deletingProjectIds,
    deletingAgentIds,
    engineCapabilityDiscoveryAuthorities,
    serverContext,
    isClosed,
    notifyScheduler,
    reusableRuntime,
    persistentRuntimeForTermination,
    retireCompletedContextRolloverSession,
    closeRunBrowser,
    publishMessageDeliveryChanged,
    publish,
    cachedModelOptions,
    closeCapabilityDiscoveryAuthority,
    closeCapabilityDiscoveryProcess,
    providerUsageState,
    reportRuntimeCapabilitiesChanged,
    providerProcessAuthority,
    workingCopies,
  } = context;

  registerSourceEffectRoutes(app, { store });

const activeAgentProviderCommands = new Set<string>();
registerNativeHistoryRoutes(app,{store,coordinationV3,activeRuns,deletingAgentIds,deletingProjectIds,persistentRuntimeForTermination,isClosed,workingCopies,busy:activeAgentProviderCommands});
const activeContextRecoveries = new Map<string,{id:string;controller:AbortController;stopped?:boolean}>();
const retainedPermissionsMatch = (agentId:string, engineId:string, contract:import("@ponderosa/core").RetainedNormalRuntimeContract, sourceRunId?:string) => {
  const current=runtimeRestrictions(new CapabilityPolicyStore(store.sqlite).resolveForAgent(agentId,sourceRunId),engineId);
  const prior=contract.capabilityRestrictions;
  return Boolean(prior && current.filesystemWriteRestricted===prior.filesystemWriteRestricted &&
    JSON.stringify(current.restrictedCapabilityIds)===JSON.stringify(prior.restrictedCapabilityIds) &&
    JSON.stringify(current.restrictedConnectorNames)===JSON.stringify(prior.restrictedConnectorNames));
};
registerContextRecoveryRoutes(app, {store,coordinationV3,notifyScheduler,
  support:engineId=>engines.get(engineId)?.adapter.contextRecoverySupport,
  stopRecovery: async (agentId,recoveryId) => {
    const operation=activeContextRecoveries.get(agentId);
    if (!operation) {
      const recovery=coordinationV3.contextRecovery.active(agentId);
      const phase=recovery?.progress?.phase;
      if (recovery?.id!==recoveryId || !phase || !["reserved","drained","native_started"].includes(phase)) return false;
      if (activeRuns.has(agentId) || coordinationV3.activeAgentRun(agentId)) throw new Error("Recovery stop conflicts with a live Run");
      await providerProcessAuthority.terminateAgents(new Set([agentId]),"reconcile interrupted context recovery stop");
      if (providerProcessAuthority.count({agentId})!==0) throw new Error("Interrupted recovery process drain remains pending");
      coordinationV3.contextRecovery.advanceOperation(agentId,recoveryId,phase,"held",{message:"Interrupted recovery process exit observed; unknown native outcome retained without replay"});
      return true;
    }
    if(operation.id!==recoveryId)return false;
    operation.stopped=true;
    operation.controller.abort();
    await providerProcessAuthority.terminateAgents(new Set([agentId]),"human stop of context recovery");
    return true;
  },
  recover: async recovery => {
    const agent = store.getAgent(recovery.agentId);
    if (!agent) throw new Error("Recovery Agent no longer exists");
    const engine = engines.get(agent.activeEngine);
    const packet = store.acceptedProviderSessionInput(agent.id);
    const contract = packet?.sourceManifest.schemaVersion === 3 ? packet.sourceManifest.normalRuntimeContract : undefined;
    // Legacy unknown sessions cannot be reconstructed from hashes or authored Chat.
    if (!engine?.adapter.openSession || !contract || packet?.exactSystemPrompt === undefined ||
        contract.contractHash !== recovery.toolContractHash || contract.engineId !== agent.activeEngine ||
        contract.expectedBillingMode !== workspace.getPreferences().providerBillingModes?.[agent.activeEngine] ||
        !retainedPermissionsMatch(agent.id,agent.activeEngine,contract,recovery.sourceRunId)) return;
    const project = store.getChatContext(agent.conversationId);
    if (!project || project.id !== recovery.projectId) return;
    const release = workingCopies.beginUse(agent.id);
    let authority: CapabilityDiscoveryAuthority | undefined;
    let phase: import("@ponderosa/core").ProviderContextRecoveryProgress["phase"] = "reserved";
    let reserved = false;
    let acceptedUsage: {usedTokens:number;windowTokens?:number} | undefined;
    let failure: string | undefined;
    try {
      const workingCopy = await workingCopies.resolve(agent, project);
      workingCopies.assertRunAdmission(agent.id, workingCopy);
      if (workingCopy.id !== contract.workingCopyId || workingCopy.rootPath !== contract.cwd) return;
      if (!coordinationV3.contextRecovery.reserveOperation(agent.id,recovery.id)) return;
      reserved = true;
      const recoveryControl={id:recovery.id,controller:new AbortController()};
      activeContextRecoveries.set(agent.id,recoveryControl);
      activeAgentProviderCommands.add(agent.id);
      // Drain the retained normal process, including restart-recovered groups,
      // before opening the same native session. No replacement Agent/history.
      const retained = persistentRuntimeForTermination(agent.id);
      if (retained) await retained.session.close();
      await providerProcessAuthority.terminateAgents(new Set([agent.id]), "explicit context recovery drain");
      if (providerProcessAuthority.count({agentId:agent.id}) !== 0) throw new Error("Recovery old-process drain remains pending");
      coordinationV3.contextRecovery.advanceOperation(agent.id,recovery.id,phase,"drained"); phase="drained";
      if(recoveryControl.controller.signal.aborted || isClosed() || deletingAgentIds.has(agent.id) || deletingProjectIds.has(project.id))
        throw new Error("Recovery stopped before native input");
      authority = {projectId:project.id,agentId:agent.id,engineId:agent.activeEngine,
        key:`context-recovery:${recovery.id}`,controller:recoveryControl.controller,processes:new Set(),settled:false};
      engineCapabilityDiscoveryAuthorities.add(authority);
      const owner = authority;
      const operation = (async () => {
        const raw = await providerRuntimeOperation("open retained recovery session", () => engine.adapter.openSession!({
          agentId:agent.id,cwd:contract.cwd,resumeSessionId:recovery.providerSessionId,history:[],
          systemPrompt:packet.exactSystemPrompt,model:contract.model,effort:contract.effort,speed:contract.speed,
          expectedBillingMode:contract.expectedBillingMode,dynamicTools:contract.dynamicTools,
          capabilityRestrictions:contract.capabilityRestrictions,
          handleDynamicToolCall:async()=>{throw new Error("Recovery commands have no live Run tool authority");},
          handleElicitation:async()=>({action:"cancel" as const}),
          onRuntimeSpawned:rawHandle=>{
            const handle=providerProcessHandleFacade(rawHandle);
            owner.processes.add({handle});
            providerProcessAuthority.register(handle,{purpose:"context recovery",projectId:project.id,agentId:agent.id});
            if (isClosed() || deletingAgentIds.has(agent.id) || deletingProjectIds.has(project.id) || owner.controller.signal.aborted) {
              owner.controller.abort();
              throw new Error("Recovery interrupted during process admission");
            }
          },onRuntimeRootExit:()=>undefined,signal:owner.controller.signal,
        }));
        const session=providerSessionFacade(raw);
        if (readProviderSessionIdentifier(session)!==recovery.providerSessionId || !session.invokeCommand) throw new Error("Recovery native session changed or has no compaction command");
        if (owner.controller.signal.aborted || isClosed() || deletingAgentIds.has(agent.id) || deletingProjectIds.has(project.id)) throw new Error("Recovery stopped or interrupted by shutdown or deletion");
        if (!retainedPermissionsMatch(agent.id,agent.activeEngine,contract,recovery.sourceRunId) ||
            contract.expectedBillingMode!==workspace.getPreferences().providerBillingModes?.[agent.activeEngine])
          throw new Error("Human access or billing selection changed during recovery admission");
        // Commit before the mutating RPC. A lost acknowledgement is never retried.
        coordinationV3.contextRecovery.advanceOperation(agent.id,recovery.id,phase,"native_started"); phase="native_started";
        const result=projectProviderCommandResult(await session.invokeCommand("compact"));
        const usage=result.contextUsage;
        if (result.outcome!=="completed" || !usage || usage.providerSessionGeneration!==recovery.providerSessionId) {
          throw new Error(result.message ?? "Native compaction completion or fresh occupancy unavailable; do not replay");
        }
        acceptedUsage={usedTokens:usage.usedTokens,...(usage.windowTokens!==undefined?{windowTokens:usage.windowTokens}:{})};
      })();
      owner.operation=operation;
      await operation;
    } catch (error) {
      failure=publicProviderCommandFailure(error).error;
      app.log.error({providerError:restrictedProviderExceptionLogDetail(error),agentId:agent.id},"Context recovery held");
    } finally {
      // Acceptance follows observed exit of the recovery process too. Persisted
      // native_started after a crash stays held; no native query means no replay.
      const drain = async () => {
        if (!reserved) return;
        if (authority) { authority.settled=true; await closeCapabilityDiscoveryAuthority(authority); }
        await providerProcessAuthority.terminateAgents(new Set([agent.id]), "context recovery completion drain");
        if (providerProcessAuthority.count({agentId:agent.id})!==0) throw new Error("Recovery completion drain remains pending");
      };
      let drained = false;
      try {
        await drain(); drained = true;
        if (reserved) {
          if (acceptedUsage && !failure && !activeContextRecoveries.get(agent.id)?.stopped && !isClosed() && !deletingAgentIds.has(agent.id) && !deletingProjectIds.has(project.id) &&
              store.getAgent(agent.id)?.activeEngine===contract.engineId &&
              retainedPermissionsMatch(agent.id,agent.activeEngine,contract,recovery.sourceRunId) &&
              contract.expectedBillingMode===workspace.getPreferences().providerBillingModes?.[agent.activeEngine]) {
            const event=store.recordProviderRecoveryContextUsage(agent.id,recovery.id,acceptedUsage);
            if(!event)throw new Error("Recovery context-usage publication boundary changed");
            coordinationV3.contextRecovery.advanceOperation(agent.id,recovery.id,phase,"context_accepted",{...acceptedUsage,contextUsageEventSequence:event.seq});
            publish(agent.id,event);
          } else coordinationV3.contextRecovery.advanceOperation(agent.id,recovery.id,phase,"held",{message:failure ?? "Recovery admission incomplete"});
        }
      } finally {
        if (drained) { activeContextRecoveries.delete(agent.id); activeAgentProviderCommands.delete(agent.id); release(); }
        else {
          // Retain working-folder use and the admission barrier until exit is observed.
          void (async () => {
            for (;;) {
              await new Promise<void>(resolve => { const timer=setTimeout(resolve,1000); timer.unref?.(); });
              try {
                await drain();
                try { coordinationV3.contextRecovery.advanceOperation(agent.id,recovery.id,phase,"held",{message:"Recovery cleanup completed after an uncertain outcome; native input was not replayed"}); }
                catch (error) { app.log.error({providerError:restrictedProviderExceptionLogDetail(error),agentId:agent.id},"Recovery cleanup state requires reconciliation"); }
                activeContextRecoveries.delete(agent.id); activeAgentProviderCommands.delete(agent.id); release(); return;
              }
              catch (error) { app.log.error({providerError:restrictedProviderExceptionLogDetail(error),agentId:agent.id},"Recovery cleanup remains pending"); }
            }
          })();
        }
      }
    }
  },
  unavailable:(agentId,projectId)=>isClosed() || deletingAgentIds.has(agentId) || deletingProjectIds.has(projectId) ||
    activeAgentProviderCommands.has(agentId) || activeRuns.has(agentId) || Boolean(coordinationV3.activeAgentRun(agentId)) ||
    [...engineCapabilityDiscoveryAuthorities].some(authority=>authority.agentId===agentId),
});

for (const action of ['pause','resume'] as const) app.post<{Params:{id:string};Body:{targetRunId?:string;pauseId?:string;idempotencyKey?:string}}>(`/api/agents/:id/${action}`,async(request,reply)=>{
  const body=request.body;
  const key=body?.idempotencyKey?.trim(),target=action==='pause'?body?.targetRunId?.trim():body?.pauseId?.trim();
  if(!key||key.length>200||!target||target.length>200)return reply.code(400).send({error:'Exact target and idempotencyKey are required'});
  if(!store.getAgent(request.params.id))return reply.code(404).send({error:'Agent not found'});
  try {
    const result=action==='pause'?coordinationV3.pauseAgentRun({agentId:request.params.id,runId:target,idempotencyKey:key}):coordinationV3.resumeAgentRun({agentId:request.params.id,pauseId:target,idempotencyKey:key});
    notifyScheduler();publishMessageDeliveryChanged(request.params.id);
    return {accepted:true,...(result??{})};
  } catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}
});

app.post<{ Params: { id: string }; Body?: CancelAgentRunRequest }>("/api/agents/:id/cancel", async (request, reply) => {
  const idempotencyKey = request.body?.idempotencyKey?.trim();
  const targetRunId = request.body?.targetRunId?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200 || !targetRunId || targetRunId.length > 200) {
    return reply.code(400).send({ error: "targetRunId and an idempotencyKey of at most 200 characters are required" });
  }
  const current = activeRuns.get(request.params.id);
  let result: ReturnType<CoordinationV3Store["cancelAgentRun"]>;
  try {
    result = coordinationV3.cancelAgentRun({
      agentId: request.params.id,
      idempotencyKey,
      expectedRunId: targetRunId,
    });
  } catch (error) {
    if (error instanceof CoordinationIdempotencyConflictError) {
      return reply.code(409).send({
        error: "the cancellation key belongs to a different Run",
        cancelled: false,
        replayed: false,
      });
    }
    throw error;
  }
  if (!result.cancelled) {
    const authoritative = coordinationV3.agentSnapshot(request.params.id).activeRun;
    return reply.code(409).send({
      error: "the targeted Run is no longer active",
      cancelled: false,
      replayed: result.replayed,
      ...(authoritative ? { currentRunId: authoritative.id } : {}),
    });
  }
  const ownedTarget = current && current.runId === result.runId ? current : undefined;
  if (!result.replayed && ownedTarget) {
    // The scheduler cancellation is already canonical at this point. Reflect
    // that loss of live execution authority immediately so health projections
    // do not keep advertising a responding Run while process teardown drains.
    ownedTarget.ownershipState = "cancelling";
    // A rollover requested by this exact Run is part of the cancelled work,
    // not an independent queued user instruction. Do not let it immediately
    // manufacture a successor after the operator stops the Run.
    scheduledSessionRollovers.delete(request.params.id);
    const abandonedHandoff = store.continuationHandoffForRun(request.params.id, result.runId!);
    if (abandonedHandoff && !abandonedHandoff.consumedAt) {
      store.consumeContinuationHandoff(request.params.id, abandonedHandoff.id, result.runId!);
    }
    void closeRunBrowser(request.params.id, ownedTarget, "run_cancelled");
  }
  if (!result.replayed && ownedTarget && store.getAgent(request.params.id)) {
    const lifecycle = store.appendEvent(request.params.id, {
      type: "agent_lifecycle", status: "cancelled", reason: "agent_cancelled",
      executionId: result.runId!,
    });
    publish(request.params.id, lifecycle);
  }
  notifyScheduler();
  publishMessageDeliveryChanged(request.params.id);
  return { cancelled: true, replayed: result.replayed } satisfies CancelAgentRunResponse;
});

app.post<{
  Params: { projectId: string };
  Body: { engineId?: string; model?: string; effort?: string; name?: string; argumentsText?: string };
}>("/api/projects/:projectId/provider-commands", async (request, reply) => {
  const project = store.getProject(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "project not found" });
  const engineId = request.body?.engineId?.trim() ?? "";
  const engine = engines.get(engineId);
  if (!engine) return reply.code(400).send({ error: "unknown engine" });
  const name = request.body?.name?.trim().replace(/^\/+/, "") ?? "";
  if (["native-model", "native-permission-mode"].includes(name)) return reply.code(409).send({ error: "Use Agent Settings native controls to change the retained runtime" });
  const argumentsText = request.body?.argumentsText?.trim();
  if (!name || (request.body?.argumentsText !== undefined && typeof request.body.argumentsText !== "string")) {
    return reply.code(400).send({ error: "provider command name and optional argumentsText are required" });
  }
  if (engine.adapter.providerUsageCommand?.name === name) {
    if (argumentsText) return reply.code(400).send({ error: `/${name} does not accept arguments` });
    try {
      return {
        invoked: true,
        name,
        usage: await providerUsageState(engine, "stale"),
      };
    } catch (error) {
      return reply.code(409).send(publicProviderCommandFailure(error));
    }
  }
  if (name.startsWith("goal")) return reply.code(409).send({ error: "Native goal operations require an individual Agent’s live accepted session" });
  if (!engine.adapter.openSession) {
    return reply.code(409).send({ error: "this provider cannot open a command-only session" });
  }
  const selection = concreteRuntimeSelection(engine.adapter, [
    { model: request.body?.model, effort: request.body?.effort },
    project.defaultEngine === engineId ? { model: project.defaultModel, effort: project.defaultEffort } : undefined,
    workspace.getPreferences().engineDefaults?.[engineId],
  ], cachedModelOptions(engine.adapter, project.id));
  const authority: CapabilityDiscoveryAuthority = {
    projectId: project.id,
    engineId,
    key: `project-provider-command:${project.id}:${randomUUID()}`,
    controller: new AbortController(),
    processes: new Set(),
    settled: false,
  };
  const registerProcess = (handle: RuntimeProcessHandle): void => {
    handle = providerProcessHandleFacade(handle);
    const state: CapabilityDiscoveryProcess = { handle };
    authority.processes.add(state);
    providerProcessAuthority.register(handle, {
      purpose: `${engineId} Project provider command`,
      projectId: project.id,
    });
    if (isClosed() || deletingProjectIds.has(project.id) || authority.controller.signal.aborted) {
      void closeCapabilityDiscoveryProcess(state).catch((error) => {
        app.log.error({
          providerError: restrictedProviderExceptionLogDetail(error),
          projectId: project.id,
        }, "project provider-command process cleanup remains pending");
      });
    }
  };
  let invocation: { catalog: EngineCapabilities; message?: string } | undefined;
  const operation = Promise.resolve().then(async () => {
    const rawSession = await providerRuntimeOperation("open provider command session", () => engine.adapter.openSession!({
      agentId: `project-command:${project.id}:${randomUUID()}`,
      cwd: project.hostPath,
      history: [],
      model: selection.model,
      effort: selection.effort,
      onRuntimeSpawned: registerProcess,
      onRuntimeRootExit: () => undefined,
      onCapabilitiesChanged: () => reportRuntimeCapabilitiesChanged(project.id, engineId),
      signal: authority.controller.signal,
    }));
    const session = providerSessionFacade(rawSession);
    const catalog = session.capabilities
      ? projectProviderCapabilities(await session.capabilities())
      : {
          steering: false,
          persistentSessions: false,
          commands: [],
          mcpServers: [],
          composerCapabilities: [],
        };
    const command = catalog.commands.find((candidate) => candidate.name === name);
    if (!session.capabilities || !session.invokeCommand) {
      throw new Error("this provider does not support structured runtime commands");
    }
    if (!command || command.invocation !== "runtime" || command.status !== "available") {
      const error = new Error(command?.unavailableReason ?? `/${name} is no longer available`);
      Object.assign(error, { catalogVersion: catalog.catalogVersion });
      throw error;
    }
    const result = projectProviderCommandResult(await session.invokeCommand(name, argumentsText));
    invocation = { catalog, ...(result.message ? { message: result.message } : {}) };
    return catalog;
  });
  authority.operation = operation;
  engineCapabilityDiscoveryAuthorities.add(authority);
  try {
    await operation;
    reportRuntimeCapabilitiesChanged(project.id, engineId);
    return {
      invoked: true,
      name,
      catalogVersion: invocation?.catalog.catalogVersion,
      ...(invocation?.message ? { message: invocation.message } : {}),
    };
  } catch (error) {
    return reply.code(409).send(publicProviderCommandFailure(error));
  } finally {
    authority.settled = true;
    try {
      await closeCapabilityDiscoveryAuthority(authority);
    } catch (error) {
      app.log.error({
        providerError: restrictedProviderExceptionLogDetail(error),
        projectId: project.id,
      }, "project provider-command process cleanup remains pending");
    }
  }
});

app.post<{ Params: { id: string }; Body: { name?: string; argumentsText?: string } }>(
  "/api/agents/:id/provider-commands",
  async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    if(coordinationV3.contextRecovery.active(agent.id)) return reply.code(409).send({code:"context_recovery_held",error:"An explicit context recovery hold is active"});
    if(new NativeHistoryAuthority(store).held(agent.id))return reply.code(409).send({error:"Native history operation is prepared or uncertain"});
    if(activeAgentProviderCommands.has(agent.id)) return reply.code(409).send({error:"An Agent provider command is already active"});
    activeAgentProviderCommands.add(agent.id);
    try {
    if(store.sqlite.prepare("SELECT 1 FROM agent_run_pauses WHERE agent_id=? AND state IN ('paused','resume_requested')").get(agent.id))
      return reply.code(409).send({error:'Agent is paused; Resume or Stop before a provider command'});
    const project = store.getChatContext(agent.conversationId);
    if (!project || project.id !== agent.projectId) return reply.code(409).send({ error: "Agent Chat context is unavailable" });
    const engine = engines.get(agent.activeEngine);
    if (!engine) return reply.code(400).send({ error: "unknown engine" });
    const name = request.body?.name?.trim().replace(/^\/+/, "") ?? "";
    if (["native-model", "native-permission-mode"].includes(name)) return reply.code(409).send({ error: "Use Agent Settings native controls to change the retained runtime" });
    const argumentsText = request.body?.argumentsText?.trim();
    if (!name || (request.body?.argumentsText !== undefined && typeof request.body.argumentsText !== "string")) {
      return reply.code(400).send({ error: "provider command name and optional argumentsText are required" });
    }
    if (engine.adapter.providerUsageCommand?.name === name) {
      if (argumentsText) return reply.code(400).send({ error: `/${name} does not accept arguments` });
      try {
        return {
          invoked: true,
          name,
          usage: await providerUsageState(engine, "stale"),
        };
      } catch (error) {
        return reply.code(409).send(publicProviderCommandFailure(error));
      }
    }
    const invoke = async (session: RuntimeSession): Promise<{ catalog: EngineCapabilities; message?: string; outcome?: "completed" | "failed" | "outcome_unknown"; goal?: import("@ponderosa/core").NativeGoalSnapshot | null; goalCleared?: boolean }> => {
      const catalog = session.capabilities
        ? projectProviderCapabilities(await session.capabilities())
        : {
            steering: false,
            persistentSessions: false,
            commands: [],
            mcpServers: [],
            composerCapabilities: [],
          };
      const command = catalog.commands.find((candidate) => candidate.name === name);
      if (activeRuns.has(agent.id) || coordinationV3.activeAgentRun(agent.id)) {
        throw new Error("structured provider commands require an idle runtime");
      }
      if (!session.capabilities || !session.invokeCommand) {
        throw new Error("this provider does not support structured runtime commands");
      }
      if (!command || command.invocation !== "runtime" || command.status !== "available") {
        const error = new Error(command?.unavailableReason ?? `/${name} is no longer available`);
        Object.assign(error, { catalogVersion: catalog.catalogVersion });
        throw error;
      }
      if(coordinationV3.contextRecovery.active(agent.id)) throw new NativeContextUnavailableError("An explicit context recovery hold is active");
      const commandBoundary = name === "compact" ? store.providerCommandContextBoundary(agent.id) : undefined;
      const invocationId = randomUUID();
      if (name === "compact") {
        if (!commandBoundary || readProviderSessionIdentifier(session) !== commandBoundary.providerSessionId) {
          throw new NativeContextUnavailableError("Native /compact requires the accepted compatible provider runtime. Use Context Refresh to rebuild this Agent's context.");
        }
        // Persist before the asynchronous provider call: an acknowledgement,
        // rejection or lost reply cannot certify the old context measurement.
        // This internal, payload-free event never enters Chat or public SSE.
        if (!store.beginProviderCommandContextMutation(agent.id, commandBoundary, invocationId)) {
          throw new NativeContextUnavailableError("A previous native operation or unfinished work has unconfirmed context. Do not repeat Compact; use Context Refresh after resolving any pending work.");
        }
      }
      if (name.startsWith("goal")) {
        const accepted = store.acceptedProviderSessionInput(agent.id);
        const contract = accepted?.sourceManifest.schemaVersion === 3 ? accepted.sourceManifest.normalRuntimeContract : undefined;
        const saved = store.resumeSessionState(agent.id);
        if (!saved || !contract || contract.engineId !== agent.activeEngine || saved.toolContractHash !== contract.contractHash ||
            saved.sessionId !== readProviderSessionIdentifier(session) || !retainedPermissionsMatch(agent.id, agent.activeEngine, contract) ||
            contract.expectedBillingMode !== workspace.getPreferences().providerBillingModes?.[agent.activeEngine] ||
            isClosed() || deletingAgentIds.has(agent.id) || deletingProjectIds.has(project.id)) throw new Error("Native goal operation requires the current accepted session and human limits");
      }
      const result = projectProviderCommandResult(await session.invokeCommand(name, argumentsText));
      if (name === "compact") {
        result.outcome ??= "outcome_unknown";
        try {
          const usage = result.contextUsage;
          const providerSessionId = readProviderSessionIdentifier(session);
          const stored = result.outcome === "completed" && usage && commandBoundary && providerSessionId === commandBoundary.providerSessionId &&
              usage.providerSessionGeneration === providerSessionId && !isClosed() &&
              !deletingAgentIds.has(agent.id) && !deletingProjectIds.has(project.id)
            ? store.recordProviderCommandContextUsage(agent.id, commandBoundary, { ...usage, providerSessionGeneration: providerSessionId }, invocationId) : undefined;
          if (stored) {
            publish(agent.id, stored);
            const cancelled = coordinationV3.retireContextRolloverAfterHeadroomRecovery({
              agentId: agent.id, providerSessionGeneration: providerSessionId,
              providerSessionId, usedTokens: usage!.usedTokens,
            });
            if (cancelled) { scheduledSessionRollovers.delete(agent.id); notifyScheduler(); }
          } else {
            result.message ??= "Compaction was invoked; updated context usage could not be recorded. Do not repeat the command solely to refresh telemetry. Context Refresh is required before more work.";
          }
        } catch (error) {
          // Native compaction was invoked. An audit/ownership/telemetry failure
          // must not turn it into a retryable command or trust a stale getter.
          app.log.warn({ providerError: restrictedProviderExceptionLogDetail(error), agentId: agent.id }, "native compact context observation was not recorded");
          result.message ??= "Compaction was invoked; updated context usage could not be recorded. Do not repeat the command solely to refresh telemetry. Context Refresh is required before more work.";
        }
      }
      return { catalog, ...(result.message ? { message: result.message } : {}), ...(result.outcome ? { outcome: result.outcome } : {}),
        ...(result.goal === undefined ? {} : { goal: result.goal }), ...(result.goalCleared === undefined ? {} : { goalCleared: result.goalCleared }) };
    };
    let releaseWorkingCopyUse: () => void;
    try {
      releaseWorkingCopyUse = workingCopies.beginUse(agent.id);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "This Agent's working folder is changing.",
        retryable: true,
      });
    }
    let cleanupOwnsWorkingCopyUse = false;
    try {
      // Recheck every deletion authority after registering this use. A delete
      // that quarantines later must await this use; one that quarantined first
      // makes this command release immediately without opening a process.
      if (isClosed() || deletingProjectIds.has(project.id) || deletingAgentIds.has(agent.id)) {
        return reply.code(409).send({ error: "this Agent is unavailable for provider commands", retryable: true });
      }
      if (activeRuns.has(agent.id) || coordinationV3.activeAgentRun(agent.id)) {
        return reply.code(409).send({ error: "structured provider commands require an idle runtime", retryable: true });
      }
      try {
      await retireCompletedContextRolloverSession({
        agentId: agent.id,
        projectId: project.id,
      });
      } catch (error) {
        return reply.code(409).send(publicProviderCommandFailure(error));
      }
      const liveSession = reusableRuntime(agent.id)?.session;
      if (liveSession) {
        try {
          const result = await invoke(liveSession);
          reportRuntimeCapabilitiesChanged(agent.projectId, agent.activeEngine);
          return {
            invoked: true,
            name,
            catalogVersion: result.catalog.catalogVersion,
            ...(result.outcome ? { outcome: result.outcome } : {}),
            ...(result.message ? { message: result.message } : {}),
            ...(result.goal === undefined ? {} : { goal: result.goal }), ...(result.goalCleared === undefined ? {} : { goalCleared: result.goalCleared }),
          };
        } catch (error) {
          return reply.code(409).send(publicProviderCommandFailure(error));
        }
      }
      if (name.startsWith("goal")) return reply.code(409).send({ error: "Native goal operations require a live accepted session. Resuming an active native goal can start unscheduled work, so this command does not open a session." });
      if (!engine.adapter.openSession) {
        return reply.code(409).send({ error: "this provider cannot open a command-only session" });
      }

    // Read-only provider commands such as /status should work before an Agent
    // has a warm runtime. Open a short-lived provider session, invoke exactly
    // one structured command, and close it without creating a chat message,
    // Activation, or provider turn. The authority registry makes Project
    // deletion and daemon shutdown wait for the transient process as well.
      let workingCopy: Awaited<ReturnType<AgentWorkingCopyService["resolve"]>>;
      try {
        workingCopy = await workingCopies.resolve(agent, project);
        workingCopies.assertRunAdmission(agent.id, workingCopy);
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "This Agent's working folder is unavailable.",
        });
      }
      const latestRun = store.getLatestRun(agent.id);
      const selection = concreteRuntimeSelection(engine.adapter, [
      { model: latestRun?.model ?? agent.model ?? agent.presetSnapshot?.model, effort: latestRun?.effort ?? agent.effort ?? agent.presetSnapshot?.effort },
      project.defaultEngine === agent.activeEngine ? { model: project.defaultModel, effort: project.defaultEffort } : undefined,
      workspace.getPreferences().engineDefaults?.[agent.activeEngine],
    ], cachedModelOptions(engine.adapter, project.id));
      const persisted = store.resumeSessionState(agent.id);
      const runtimeSessionContractHash = providerSessionContractHash(
      agent.activeEngine,
      workingCopy.id,
      selection.model,
      selection.effort,
    );
      const acceptedInput = store.acceptedProviderSessionInput(agent.id);
      const retainedContract = acceptedInput?.sourceManifest.schemaVersion === 3
        ? acceptedInput.sourceManifest.normalRuntimeContract : undefined;
      const exactContract = retainedContract?.version === 1 && persisted &&
        retainedContract.contractHash === persisted.toolContractHash &&
        retainedContract.engineId === agent.activeEngine && retainedContract.workingCopyId === workingCopy.id &&
        retainedContract.cwd === workingCopy.rootPath && acceptedInput?.exactSystemPrompt !== undefined &&
        retainedContract.expectedBillingMode === workspace.getPreferences().providerBillingModes?.[agent.activeEngine] &&
        retainedPermissionsMatch(agent.id,agent.activeEngine,retainedContract,latestRun?.id)
        ? retainedContract : undefined;
      const resumeSessionId = exactContract ? persisted!.sessionId :
        persisted?.toolContractHash === runtimeSessionContractHash ? persisted.sessionId : undefined;
      if (name === "compact" && (!exactContract || !resumeSessionId || !store.providerCommandContextBoundary(agent.id))) {
        return reply.code(409).send({ error: "Native /compact requires the accepted compatible provider runtime. Use Context Refresh to rebuild this Agent's context." });
      }
      const authority: CapabilityDiscoveryAuthority = {
        projectId: project.id,
        agentId: agent.id,
        engineId: engine.adapter.id,
        key: `provider-command:${agent.id}:${randomUUID()}`,
        controller: new AbortController(),
        processes: new Set(),
        settled: false,
      };
      const registerProcess = (handle: RuntimeProcessHandle): void => {
      handle = providerProcessHandleFacade(handle);
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      providerProcessAuthority.register(handle, {
        purpose: `${engine.adapter.id} Agent provider command`,
        projectId: project.id,
        agentId: agent.id,
      });
      if (isClosed() || deletingProjectIds.has(project.id) || deletingAgentIds.has(agent.id) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error({
            providerError: restrictedProviderExceptionLogDetail(error),
            agentId: agent.id,
          }, "transient provider-command process cleanup remains pending");
        });
      }
      };
      let invocation: Awaited<ReturnType<typeof invoke>> | undefined;
      const operation = Promise.resolve().then(async () => {
      const rawSession = await providerRuntimeOperation("open provider command session", () => engine.adapter.openSession!({
        agentId: agent.id,
        cwd: workingCopy.rootPath,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        history: [],
        model: exactContract?.model ?? selection.model,
        effort: exactContract?.effort ?? selection.effort,
        ...(exactContract ? {
          systemPrompt: acceptedInput!.exactSystemPrompt,
          speed: exactContract.speed,
          expectedBillingMode: exactContract.expectedBillingMode,
          dynamicTools: exactContract.dynamicTools,
          capabilityRestrictions: exactContract.capabilityRestrictions,
          // A command is not a scheduler Run. Keep the native tool declarations,
          // but never lend a finished Run's capability to a native tool request.
          handleDynamicToolCall: async () => { throw new Error("Provider commands have no live Run tool authority"); },
          handleElicitation: async () => ({ action: "cancel" as const }),
        } : {}),
        onRuntimeSpawned: registerProcess,
        onRuntimeRootExit: () => undefined,
        onCapabilitiesChanged: () => reportRuntimeCapabilitiesChanged(project.id, engine.adapter.id),
        signal: authority.controller.signal,
      }));
      const session = providerSessionFacade(rawSession);
      invocation = await invoke(session);
      return invocation.catalog;
      });
      authority.operation = operation;
      engineCapabilityDiscoveryAuthorities.add(authority);
      cleanupOwnsWorkingCopyUse = true;
      try {
        await operation;
        reportRuntimeCapabilitiesChanged(agent.projectId, agent.activeEngine);
        return {
          invoked: true,
          name,
          catalogVersion: invocation?.catalog.catalogVersion,
          ...(invocation?.outcome ? { outcome: invocation.outcome } : {}),
          ...(invocation?.message ? { message: invocation.message } : {}),
        };
      } catch (error) {
        return reply.code(409).send(publicProviderCommandFailure(error));
      } finally {
        authority.settled = true;
        try {
          await closeCapabilityDiscoveryAuthority(authority);
          cleanupOwnsWorkingCopyUse = false;
          releaseWorkingCopyUse();
        } catch (error) {
          app.log.error({
            providerError: restrictedProviderExceptionLogDetail(error),
            agentId: agent.id,
          }, "transient provider-command process cleanup remains pending and blocks working-folder changes");
          // Keep the use lease until process-group exit is actually confirmed.
          // Retrying in the background lets a transient teardown failure heal
          // without ever making destructive folder replacement unsafe.
          void (async () => {
            let retryDelayMs = 250;
            for (;;) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, retryDelayMs);
                timer.unref?.();
              });
              try {
                await closeCapabilityDiscoveryAuthority(authority);
                releaseWorkingCopyUse();
                return;
              } catch (retryError) {
                retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
                app.log.warn({
                  providerError: restrictedProviderExceptionLogDetail(retryError),
                  agentId: agent.id,
                }, "transient provider-command process cleanup is still pending");
              }
            }
          })();
        }
      }
    } finally {
      if (!cleanupOwnsWorkingCopyUse) releaseWorkingCopyUse();
    }
    } finally { activeAgentProviderCommands.delete(agent.id); }
  },
);

app.post<{ Params: { id: string } }>("/api/agents/:id/compact", async (request, reply) => {
  const agent = store.getAgent(request.params.id);
  if (!agent) return reply.code(404).send({ error: "agent not found" });
  if(coordinationV3.contextRecovery.active(agent.id)) return reply.code(409).send({code:"context_recovery_held",error:"An explicit context recovery hold is active"});
  if(activeAgentProviderCommands.has(agent.id)) return reply.code(409).send({error:"An Agent provider command is already active"});
  activeAgentProviderCommands.add(agent.id);
  try {
  if(store.sqlite.prepare("SELECT 1 FROM agent_run_pauses WHERE agent_id=? AND state IN ('paused','resume_requested')").get(agent.id))
    return reply.code(409).send({error:'Agent is paused; Resume or Stop before Context Refresh'});
  if (activeRuns.has(request.params.id) || coordinationV3.activeAgentRun(request.params.id)) {
    return reply.code(409).send({ error: "cannot compact an agent with an active run", retryable: true });
  }
  try {
    await retireCompletedContextRolloverSession({
      agentId: agent.id,
      projectId: agent.projectId,
    });
  } catch (error) {
    return reply.code(409).send(publicProviderCommandFailure(error));
  }
  const persisted = store.resumeSessionState(agent.id);
  const latestRun = store.getLatestRun(agent.id);
  if (!persisted || !latestRun) {
    return reply.code(409).send({ error: "the agent has no accepted provider session to roll over" });
  }
  const commandBoundary = store.providerCommandContextBoundary(agent.id);
  const unmeasuredContext = !store.acceptedProviderSessionContextUsage(agent.id) && !store.acceptedProviderSessionInputEstimate(agent.id);
  if (unmeasuredContext && (!commandBoundary || commandBoundary.providerSessionId !== persisted.sessionId ||
      workspace.listDecisions({ projectId: agent.projectId, agentId: agent.id, status: "pending" }).length)) {
    return reply.code(409).send({ error: "Context Refresh is waiting for unfinished work, a Decision or an uncertain outcome. Resolve the existing recovery before refreshing.", retryable: false });
  }
  const runtime = persistentRuntimeForTermination(request.params.id);
  let usage: ReturnType<typeof readProviderContextUsage>;
  try {
    // An opaque native mutation invalidated the old getter as well as durable
    // occupancy. Explicit idle recovery must not manufacture a new measure.
    usage = unmeasuredContext ? undefined : readProviderContextUsage(runtime?.session);
  } catch {
    return reply.code(409).send({
      error: "Provider returned invalid structured data.",
      retryable: true,
    });
  }
  const preferences = workspace.getPreferences();
  const pressure = evaluateContextRolloverPressure(
    usage ?? { usedTokens: preferences.contextRolloverTokens },
    preferences,
  );
  const acceptedSessionTail = store.acceptedProviderSessionCommunicationEventIds(agent.id);
  if (!acceptedSessionTail) {
    return reply.code(409).send({
      error: "the accepted provider session predates exact input-boundary tracking and cannot be rolled over safely",
      retryable: false,
    });
  }
  const sourceRun = unmeasuredContext ? store.getLatestRun(agent.id, commandBoundary!.executionId) : latestRun;
  if (!sourceRun) return reply.code(409).send({ error: "The exact accepted source Run is unavailable; context was retained.", retryable: false });
  const sourceCommunication = sourceRun.communicationEventId
    ? store.getCommunicationEvent(agent.projectId, sourceRun.communicationEventId)
    : undefined;
  const rolloverConversationId = authorizedManualRolloverConversationId(
    agent,
    sourceCommunication?.conversationId,
    Boolean(sourceRun.communicationEventId),
  );
  let rolloverBoundary: ReturnType<typeof store.bindContextRolloverBoundary>;
  try {
    rolloverBoundary = store.bindContextRolloverBoundary({
      agentId: agent.id,
      ...(rolloverConversationId
        ? { currentConversationId: rolloverConversationId }
        : {}),
      submittedCommunicationEventIds: acceptedSessionTail,
      maxUtf8Bytes: Math.min(pressure.lowWaterMark, MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES),
    });
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "the exact canonical rollover boundary is unavailable",
      retryable: false,
    });
  }
  let requested: ReturnType<typeof coordinationV3.requestContextRollover>;
  try {
    requested = coordinationV3.requestContextRollover({
      projectId: agent.projectId,
      agentId: agent.id,
      oldProviderSessionId: persisted.sessionId,
      providerSessionGeneration: usage?.providerSessionGeneration ?? persisted.sessionId,
      ...(usage === undefined ? {} : { detectedOccupancy: usage.usedTokens }),
      ...(usage?.aggregateTokens !== undefined ? { aggregateTokens: usage.aggregateTokens } : {}),
      threshold: pressure.threshold,
      ...(usage?.windowTokens !== undefined ? { contextWindow: usage.windowTokens } : {}),
      lowWaterMark: pressure.lowWaterMark,
      triggerKind: "human",
      ...(unmeasuredContext ? { canonicalOnlyRefresh: { fencingToken: commandBoundary!.fencingToken } } : {}),
      compactionCutoffOrdinal: rolloverBoundary.canonicalOrdinal,
      compactionCutoffEventId: rolloverBoundary.communicationEventId,
      recentTail: rolloverBoundary.recentTail,
      sourceRunId: unmeasuredContext ? commandBoundary!.executionId : latestRun.id,
      sourceActivationIds: unmeasuredContext ? coordinationV3.activationIdsAttachedToRun(commandBoundary!.executionId, agent.id) : [],
      // Scheduler authorization accepts only canonical conversation or Agent
      // scopes. The rollover ID and provider generation already provide durable
      // dedupe; inventing a command-specific scope makes the handoff Activation
      // unauthorized and can strand the rollover in requested forever.
      scopeKey: rolloverConversationId
        ? `conversation:${rolloverConversationId}`
        : `agent:${agent.id}`,
      ...(rolloverConversationId
        ? { conversationId: rolloverConversationId }
        : {}),
    });
  } catch (error) {
    return reply.code(409).send({
      error: unmeasuredContext
        ? "Context Refresh is waiting for unfinished work or an uncertain outcome. Resolve its existing Request, Decision or recovery before refreshing."
        : error instanceof Error && error.message === "context_refresh_already_underway"
        ? "An automatic context refresh is already underway. Wait for it to finish before requesting a manual refresh."
        : "Context refresh conflicts with an existing durable boundary.",
      code: error instanceof Error && error.message === "context_refresh_already_underway"
        ? "context_refresh_already_underway" : "context_refresh_conflict",
      retryable: !unmeasuredContext,
    });
  }
  if (unmeasuredContext) {
    try {
      await retireCompletedContextRolloverSession({ agentId: agent.id, projectId: agent.projectId,
        rolloverId: requested.rollover.id, providerSessionGeneration: persisted.sessionId });
    } catch {
      return reply.code(409).send({ error: "Context Refresh is recorded, but the old runtime cleanup is still pending. New work remains blocked until cleanup succeeds.", retryable: false });
    }
  }
  notifyScheduler();
  return {
    compacted: true,
    mode: unmeasuredContext ? "canonical_refresh" as const : "durable_rollover" as const,
    rolloverId: requested.rollover.id,
    replayed: !requested.created,
  };
  } finally { activeAgentProviderCommands.delete(agent.id); }
});

registerAgentRunHistoryRoute(app, serverContext);

app.get<{ Params: { id: string }; Querystring: { exact?: string } }>("/api/runs/:id/provider-input", async (request, reply) => {
  const input = store.getProviderInput(request.params.id, request.query.exact === "1");
  return input ?? reply.code(404).send({ error: "provider input not found" });
});

app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/api/agents/:id/work-items", async (request, reply) => {
  if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
  const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
  try { return store.getWorkItemPage(request.params.id, { limit, cursor: request.query.cursor }); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid history cursor" }); }
});
}
