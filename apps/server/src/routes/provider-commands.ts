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
import { publicProviderFailure } from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  StoredLogEvent,
  WorkspaceStore,
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
  closeRunBrowser(agentId: string, run: ActiveRun, reason: string): Promise<void>;
  publishMessageDeliveryChanged(agentId: string): void;
  publish(agentId: string, stored: StoredLogEvent): void;
  cachedModelOptions(
    adapter: EngineRegistration["adapter"],
    projectId?: string,
  ): ModelOption[];
  closeCapabilityDiscoveryAuthority(authority: CapabilityDiscoveryAuthority): Promise<void>;
  closeCapabilityDiscoveryProcess(state: CapabilityDiscoveryProcess): Promise<void>;
  providerUsageState(
    registration: EngineRegistration,
    refresh?: "none" | "stale" | "force",
  ): Promise<ProviderUsageStateDto>;
  reportRuntimeCapabilitiesChanged(projectId: string, engineId: string): void;
  providerProcessAuthority: ProviderProcessAuthority;
}

export function authorizedManualRolloverConversationId(
  agent: { conversationIds: readonly string[] },
  sourceConversationId?: string,
): string | undefined {
  return sourceConversationId && agent.conversationIds.includes(sourceConversationId)
    ? sourceConversationId
    : undefined;
}

function publicProviderCommandFailure(error: unknown): {
  error: string;
  category: ReturnType<typeof publicProviderFailure>["category"];
  remediation: string;
} {
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
    closeRunBrowser,
    publishMessageDeliveryChanged,
    publish,
    cachedModelOptions,
    closeCapabilityDiscoveryAuthority,
    closeCapabilityDiscoveryProcess,
    providerUsageState,
    reportRuntimeCapabilitiesChanged,
    providerProcessAuthority,
  } = context;

app.post<{ Params: { id: string }; Body?: CancelAgentRunRequest }>("/api/agents/:id/cancel", async (request, reply) => {
  const idempotencyKey = request.body?.idempotencyKey?.trim();
  const targetRunId = request.body?.targetRunId?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200 || !targetRunId || targetRunId.length > 200) {
    return reply.code(400).send({ error: "targetRunId and an idempotencyKey of at most 200 characters are required" });
  }
  const current = activeRuns.get(request.params.id);
  const result = coordinationV3.cancelAgentRun({
    agentId: request.params.id,
    idempotencyKey,
    expectedRunId: targetRunId,
  });
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
    const project = store.getProject(agent.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const engine = engines.get(agent.activeEngine);
    if (!engine) return reply.code(400).send({ error: "unknown engine" });
    const name = request.body?.name?.trim().replace(/^\/+/, "") ?? "";
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
    const invoke = async (session: RuntimeSession): Promise<{ catalog: EngineCapabilities; message?: string }> => {
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
      if (activeRuns.has(agent.id)) {
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
      const result = projectProviderCommandResult(await session.invokeCommand(name, argumentsText));
      if (name === "compact") {
        let usage: ReturnType<typeof readProviderContextUsage>;
        try {
          usage = readProviderContextUsage(session);
        } catch {
          // Native compaction already succeeded. Invalid optional telemetry
          // must not invite a duplicate command retry or influence rollover.
          usage = undefined;
        }
        const providerSessionGeneration = usage?.providerSessionGeneration;
        if (usage && providerSessionGeneration) {
          const providerSessionId = readProviderSessionIdentifier(session);
          const cancelled = coordinationV3.cancelContextRolloverAfterNativeCompaction({
            agentId: agent.id,
            providerSessionGeneration,
            providerSessionId,
            usedTokens: usage.usedTokens,
          });
          if (cancelled) {
            scheduledSessionRollovers.delete(agent.id);
            notifyScheduler();
          }
        }
      }
      return { catalog, ...(result.message ? { message: result.message } : {}) };
    };
    const liveSession = activeRuns.get(agent.id)?.runtimeSession ??
      reusableRuntime(agent.id)?.session;
    if (liveSession) {
      try {
        const result = await invoke(liveSession);
        reportRuntimeCapabilitiesChanged(agent.projectId, agent.activeEngine);
        return {
          invoked: true,
          name,
          catalogVersion: result.catalog.catalogVersion,
          ...(result.message ? { message: result.message } : {}),
        };
      } catch (error) {
        return reply.code(409).send(publicProviderCommandFailure(error));
      }
    }
    if (activeRuns.has(agent.id)) {
      return reply.code(409).send({ error: "the active provider session is still opening", retryable: true });
    }
    if (!engine.adapter.openSession) {
      return reply.code(409).send({ error: "this provider cannot open a command-only session" });
    }

    // Read-only provider commands such as /status should work before an Agent
    // has a warm runtime. Open a short-lived provider session, invoke exactly
    // one structured command, and close it without creating a chat message,
    // Activation, or provider turn. The authority registry makes Project
    // deletion and daemon shutdown wait for the transient process as well.
    const latestRun = store.getRuns(agent.id).at(-1);
    const selection = concreteRuntimeSelection(engine.adapter, [
      { model: latestRun?.model ?? agent.model ?? agent.presetSnapshot?.model, effort: latestRun?.effort ?? agent.effort ?? agent.presetSnapshot?.effort },
      project.defaultEngine === agent.activeEngine ? { model: project.defaultModel, effort: project.defaultEffort } : undefined,
      workspace.getPreferences().engineDefaults?.[agent.activeEngine],
    ], cachedModelOptions(engine.adapter, project.id));
    const persisted = store.resumeSessionState(agent.id);
    const runtimeSessionContractHash = providerSessionContractHash(
      agent.activeEngine,
      selection.model,
      selection.effort,
    );
    const resumeSessionId = persisted?.toolContractHash === runtimeSessionContractHash ? persisted.sessionId : undefined;
    const authority: CapabilityDiscoveryAuthority = {
      projectId: project.id,
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
    let invocation: { catalog: EngineCapabilities; message?: string } | undefined;
    const operation = Promise.resolve().then(async () => {
      const rawSession = await providerRuntimeOperation("open provider command session", () => engine.adapter.openSession!({
        agentId: agent.id,
        cwd: project.hostPath,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        history: [],
        model: selection.model,
        effort: selection.effort,
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
    try {
      await operation;
      reportRuntimeCapabilitiesChanged(agent.projectId, agent.activeEngine);
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
          agentId: agent.id,
        }, "transient provider-command process cleanup remains pending");
      }
    }
  },
);

app.post<{ Params: { id: string } }>("/api/agents/:id/compact", async (request, reply) => {
  const agent = store.getAgent(request.params.id);
  if (!agent) return reply.code(404).send({ error: "agent not found" });
  if (activeRuns.has(request.params.id)) {
    return reply.code(409).send({ error: "cannot compact an agent with an active run", retryable: true });
  }
  const persisted = store.resumeSessionState(agent.id);
  const latestRun = store.getRuns(agent.id).at(-1);
  if (!persisted || !latestRun) {
    return reply.code(409).send({ error: "the agent has no accepted provider session to roll over" });
  }
  const runtime = persistentRuntimeForTermination(request.params.id);
  let usage: ReturnType<typeof readProviderContextUsage>;
  try {
    usage = readProviderContextUsage(runtime?.session);
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
  const sourceCommunication = latestRun.communicationEventId
    ? store.getCommunicationEvent(agent.projectId, latestRun.communicationEventId)
    : undefined;
  const rolloverConversationId = authorizedManualRolloverConversationId(
    agent,
    sourceCommunication?.conversationId,
  );
  let rolloverBoundary: ReturnType<typeof store.bindContextRolloverBoundary>;
  try {
    rolloverBoundary = store.bindContextRolloverBoundary({
      agentId: agent.id,
      ...(rolloverConversationId
        ? { currentConversationId: rolloverConversationId }
        : {}),
      submittedCommunicationEventIds: acceptedSessionTail,
    });
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "the exact canonical rollover boundary is unavailable",
      retryable: false,
    });
  }
  const requested = coordinationV3.requestContextRollover({
    projectId: agent.projectId,
    agentId: agent.id,
    oldProviderSessionId: persisted.sessionId,
    providerSessionGeneration: usage?.providerSessionGeneration ?? persisted.sessionId,
    detectedOccupancy: usage?.usedTokens ?? pressure.threshold,
    ...(usage?.aggregateTokens !== undefined ? { aggregateTokens: usage.aggregateTokens } : {}),
    threshold: pressure.threshold,
    ...(usage?.windowTokens !== undefined ? { contextWindow: usage.windowTokens } : {}),
    lowWaterMark: pressure.lowWaterMark,
    triggerKind: "human",
    compactionCutoffOrdinal: rolloverBoundary.canonicalOrdinal,
    compactionCutoffEventId: rolloverBoundary.communicationEventId,
    recentTail: rolloverBoundary.recentTail,
    sourceRunId: latestRun.id,
    sourceActivationIds: [],
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
  notifyScheduler();
  return {
    compacted: true,
    mode: "durable_rollover" as const,
    rolloverId: requested.rollover.id,
    replayed: !requested.created,
  };
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
