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
  clearAgentResumeSession(agentId: string, reason: "explicit_compaction"): boolean;
  teardownPersistentRuntime(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
    projectId?: string,
  ): Promise<void>;
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
    clearAgentResumeSession,
    teardownPersistentRuntime,
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
    return {
      invoked: true,
      name,
      usage: await providerUsageState(engine, "stale"),
    };
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
    const state: CapabilityDiscoveryProcess = { handle };
    authority.processes.add(state);
    providerProcessAuthority.register(handle, {
      purpose: `${engineId} Project provider command`,
      projectId: project.id,
    });
    if (isClosed() || deletingProjectIds.has(project.id) || authority.controller.signal.aborted) {
      void closeCapabilityDiscoveryProcess(state).catch((error) => {
        app.log.error({ err: error, projectId: project.id }, "project provider-command process cleanup remains pending");
      });
    }
  };
  let invocation: { catalog: EngineCapabilities; message?: string } | undefined;
  const operation = Promise.resolve().then(async () => {
    const session = await engine.adapter.openSession!({
      agentId: `project-command:${project.id}:${randomUUID()}`,
      cwd: project.hostPath,
      history: [],
      model: selection.model,
      effort: selection.effort,
      onRuntimeSpawned: registerProcess,
      onRuntimeRootExit: () => undefined,
      onCapabilitiesChanged: () => reportRuntimeCapabilitiesChanged(project.id, engineId),
      signal: authority.controller.signal,
    });
    const catalog = session.capabilities
      ? await session.capabilities()
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
    const result = await session.invokeCommand(name, argumentsText);
    invocation = { catalog, ...(result?.message ? { message: result.message } : {}) };
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
    const catalogVersion = error && typeof error === "object" && "catalogVersion" in error
      ? (error as { catalogVersion?: string }).catalogVersion : undefined;
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "provider command failed",
      ...(catalogVersion ? { catalogVersion } : {}),
    });
  } finally {
    authority.settled = true;
    try {
      await closeCapabilityDiscoveryAuthority(authority);
    } catch (error) {
      app.log.error({ err: error, projectId: project.id }, "project provider-command process cleanup remains pending");
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
      return {
        invoked: true,
        name,
        usage: await providerUsageState(engine, "stale"),
      };
    }
    const invoke = async (session: RuntimeSession): Promise<{ catalog: EngineCapabilities; message?: string }> => {
      const catalog = session.capabilities
        ? await session.capabilities()
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
      const result = await session.invokeCommand(name, argumentsText);
      return { catalog, ...(result?.message ? { message: result.message } : {}) };
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
        const catalogVersion = error && typeof error === "object" && "catalogVersion" in error
          ? (error as { catalogVersion?: string }).catalogVersion : undefined;
        return reply.code(409).send({ error: error instanceof Error ? error.message : "provider command failed", ...(catalogVersion ? { catalogVersion } : {}) });
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
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      providerProcessAuthority.register(handle, {
        purpose: `${engine.adapter.id} Agent provider command`,
        projectId: project.id,
        agentId: agent.id,
      });
      if (isClosed() || deletingProjectIds.has(project.id) || deletingAgentIds.has(agent.id) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error({ err: error, agentId: agent.id }, "transient provider-command process cleanup remains pending");
        });
      }
    };
    let invocation: { catalog: EngineCapabilities; message?: string } | undefined;
    const operation = Promise.resolve().then(async () => {
      const session = await engine.adapter.openSession!({
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
      });
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
      const catalogVersion = error && typeof error === "object" && "catalogVersion" in error
        ? (error as { catalogVersion?: string }).catalogVersion : undefined;
      return reply.code(409).send({ error: error instanceof Error ? error.message : "provider command failed", ...(catalogVersion ? { catalogVersion } : {}) });
    } finally {
      authority.settled = true;
      try {
        await closeCapabilityDiscoveryAuthority(authority);
      } catch (error) {
        app.log.error({ err: error, agentId: agent.id }, "transient provider-command process cleanup remains pending");
      }
    }
  },
);

app.post<{ Params: { id: string } }>("/api/agents/:id/compact", async (request, reply) => {
  if (!store.getAgent(request.params.id)) return reply.code(404).send({ error: "agent not found" });
  if (activeRuns.has(request.params.id)) {
    return reply.code(409).send({ error: "cannot compact an agent with an active run", retryable: true });
  }
  const runtime = persistentRuntimeForTermination(request.params.id);
  if (runtime) {
    await teardownPersistentRuntime(request.params.id, runtime, "explicit compaction");
  }
  return { compacted: clearAgentResumeSession(request.params.id, "explicit_compaction") };
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
