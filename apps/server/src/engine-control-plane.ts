import { randomUUID } from "node:crypto";
import type {
  Adapter,
  EngineCapabilities,
  EngineDto,
  EngineModelOption,
  EngineModelValidationDto,
  ModelOption,
  ProjectEngineModelCatalogDto,
  ProviderUsageCenterDto,
  ProviderUsageStateDto,
  RuntimeProcessHandle,
} from "@ponderosa/core";
import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { EngineAuthStatusCache } from "./engine-auth-cache.js";
import type { EngineAvailabilityStore } from "./engine-availability-store.js";
import type { ProviderUsageCache, ProviderUsageTarget } from "./provider-usage-cache.js";
import type {
  CapabilityDiscoveryAuthority,
  CapabilityDiscoveryProcess,
  EngineRegistration,
  ModelCatalogDiscoveryAuthority,
  ActiveRun,
  PersistentRuntime,
} from "./app-contracts.js";

interface EngineControlPlaneContext {
  engines: ReadonlyMap<string, EngineRegistration>;
  store: AgentStore;
  workspace: WorkspaceStore;
  engineAuthStatuses: EngineAuthStatusCache;
  engineAvailability: EngineAvailabilityStore;
  providerUsage: ProviderUsageCache;
  providerEnabled(engineId: string): boolean;
  reusableRuntime(agentId: string): PersistentRuntime | undefined;
  applyOperatorModelOptions(): void;
  publishWorkspaceSince(cursor: number): void;
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  app: FastifyInstance;
  deletingProjectIds: ReadonlySet<string>;
  isClosed(): boolean;
}

export function createEngineControlPlane(context: EngineControlPlaneContext) {
  const {
    engines,
    store,
    workspace,
    engineAuthStatuses,
    engineAvailability,
    providerUsage,
    providerEnabled,
    reusableRuntime,
    applyOperatorModelOptions,
    publishWorkspaceSince,
    appendWorkspace,
    activeRuns,
    app,
    deletingProjectIds,
    isClosed,
  } = context;

  const runtimeFailureDetail = (engineId: string): string | undefined => {
    const denial = engineAvailability.denial(engineId);
    return denial ? denial.detail ?? "provider rejected runtime access" : undefined;
  };
  const runtimeStatus = async (
    id: string,
    registration: EngineRegistration,
  ): Promise<{ configured: true; authenticated: boolean; available: boolean; authDetail?: string; availabilityDetail?: string }> => {
    const auth = registration.authStatus
      ? await engineAuthStatuses.get(id, registration.authStatus)
      : { authenticated: true, detail: "runtime registered (authentication status not reported)" };
    const denial = runtimeFailureDetail(id);
    const enabled = providerEnabled(id);
    return {
      configured: true,
      authenticated: auth.authenticated,
      available: enabled && auth.authenticated && !denial,
      ...(auth.detail ? { authDetail: auth.detail } : {}),
      ...(!enabled ? { availabilityDetail: "disabled by the operator; queued work is held" }
        : !auth.authenticated
        ? { availabilityDetail: auth.detail ?? "runtime is not authenticated" }
        : denial ? { availabilityDetail: `provider rejected runtime access: ${denial}` }
          : { availabilityDetail: "provider access available" }),
    };
  };
  const engineDto = async (registration: EngineRegistration): Promise<EngineDto> => {
    const { adapter } = registration;
    let status: Awaited<ReturnType<typeof runtimeStatus>>;
    try {
      status = await runtimeStatus(adapter.id, registration);
    } catch (error) {
      status = {
        configured: true,
        authenticated: false,
        available: false,
        authDetail: error instanceof Error ? error.message : "auth status check failed",
        availabilityDetail: "runtime authentication could not be checked",
      };
    }
    const models = adapter.listModels();
    const defaultModel = adapter.defaultModel?.() ?? models.find((model) => model.id)?.id;
    const defaultEffort = adapter.defaultEffort?.(defaultModel)
      ?? models.find((model) => model.id === defaultModel)?.defaultEffort
      ?? adapter.listEfforts(defaultModel)[0]?.id;
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      ...(adapter.providerUsageCommand ? { providerUsageCommand: adapter.providerUsageCommand.name } : {}),
      models: models.map((model) => ({
        ...model,
        ...(model.efforts !== undefined
          ? { efforts: model.efforts }
          : !adapter.modelSpecificEfforts || !model.id
            ? { efforts: adapter.listEfforts(model.id || undefined) }
            : {}),
      })),
      ...(adapter.configuredModelOptions
        ? { configuredModels: adapter.configuredModelOptions() }
        : {}),
      efforts: adapter.listEfforts(),
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
      modelCatalogKnown: !adapter.modelSpecificEfforts || models.some((model) => Boolean(model.id)),
      enabled: providerEnabled(adapter.id),
      ...status,
    };
  };
  const providerUsageTarget = async (registration: EngineRegistration): Promise<ProviderUsageTarget> => {
    const auth = registration.authStatus
      ? await engineAuthStatuses.get(registration.adapter.id, registration.authStatus)
      : { authenticated: true, detail: "authenticated provider" };
    const detail = auth.detail?.trim();
    const accountMatch = detail ? /^logged in as (.+?)(?:\s+\(subscription\))?$/iu.exec(detail) : undefined;
    return {
      adapter: registration.adapter,
      displayName: registration.adapter.displayName,
      authenticated: auth.authenticated,
      accountKey: detail || (auth.authenticated ? "authenticated" : "unauthenticated"),
      ...(accountMatch?.[1] ? { accountLabel: accountMatch[1].trim() }
        : auth.authenticated && detail ? { accountLabel: detail } : {}),
    };
  };
  const providerUsageState = async (
    registration: EngineRegistration,
    refresh: "none" | "stale" | "force" = "none",
  ): Promise<ProviderUsageStateDto> => {
    const target = await providerUsageTarget(registration);
    return refresh === "none"
      ? providerUsage.state(target)
      : providerUsage.refresh(target, refresh === "force");
  };
  const providerUsageCenter = async (
    refresh: "none" | "stale" = "none",
  ): Promise<ProviderUsageCenterDto> => ({
    providers: await Promise.all([...engines.values()].map((registration) =>
      providerUsageState(registration, refresh)
    )),
  });
  const refreshProviderUsageAfterRun = (engineId: string): void => {
    if (isClosed()) return;
    const registration = engines.get(engineId);
    if (!registration?.adapter.readProviderUsage) return;
    void providerUsageState(registration, "stale").catch((error) => {
      app.log.warn({ err: error, engineId }, "provider usage refresh after Run failed");
    });
  };
  const engineCapabilityCacheTtlMs = 60_000;
  const engineCapabilityCache = new Map<string, {
    projectId: string;
    engineId: string;
    expiresAt: number;
    value: EngineCapabilities;
  }>();
  const engineCapabilityDiscoveries = new Map<string, CapabilityDiscoveryAuthority>();
  const engineCapabilityDiscoveryAuthorities = new Set<CapabilityDiscoveryAuthority>();
  const engineCapabilityGenerations = new Map<string, number>();
  const engineCapabilityScopeKey = (projectId: string, engineId: string): string =>
    `${projectId}\0${engineId}`;
  const engineCapabilityKey = (
    projectId: string,
    hostPath: string,
    engineId: string,
    model: string | undefined,
  ): string => `${projectId}\0${hostPath}\0${engineId}\0${model ?? "default"}`;
  const undiscoveredEngineCapabilities: EngineCapabilities = {
    steering: false,
    persistentSessions: false,
    commands: [],
    mcpServers: [],
    composerCapabilities: [],
  };
  const invalidateEngineCapabilities = (projectId: string, engineId: string): void => {
    const scopeKey = engineCapabilityScopeKey(projectId, engineId);
    engineCapabilityGenerations.set(scopeKey, (engineCapabilityGenerations.get(scopeKey) ?? 0) + 1);
    for (const [key, entry] of engineCapabilityCache) {
      if (entry.projectId === projectId && entry.engineId === engineId) {
        engineCapabilityCache.set(key, { ...entry, expiresAt: 0 });
      }
    }
  };
  const reportRuntimeCapabilitiesChanged = (projectId: string, engineId: string): void => {
    invalidateEngineCapabilities(projectId, engineId);
    appendWorkspace({ type: "runtime_capabilities_changed", projectId, engineId });
  };
  const closeCapabilityDiscoveryProcess = (state: CapabilityDiscoveryProcess): Promise<void> => {
    if (state.terminationConfirmed) return Promise.resolve();
    if (state.operation) return state.operation;
    const operation = Promise.resolve()
      .then(() => state.handle.close())
      .then(() => { state.terminationConfirmed = true; })
      .finally(() => {
        if (state.operation === operation) state.operation = undefined;
      });
    state.operation = operation;
    return operation;
  };
  const closeCapabilityDiscoveryAuthority = async (authority: CapabilityDiscoveryAuthority): Promise<void> => {
    authority.controller.abort();
    const processes = [...authority.processes].filter((state) => !state.terminationConfirmed);
    const results = await Promise.allSettled(processes.map(closeCapabilityDiscoveryProcess));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, `${authority.engineId} capability-discovery cleanup failed`);
    for (const process of [...authority.processes]) {
      if (process.terminationConfirmed) authority.processes.delete(process);
    }
    if (authority.settled && authority.processes.size === 0) {
      engineCapabilityDiscoveryAuthorities.delete(authority);
      if (engineCapabilityDiscoveries.get(authority.key) === authority) {
        engineCapabilityDiscoveries.delete(authority.key);
      }
    }
  };
  const drainEngineCapabilityDiscoveries = async (projectId?: string): Promise<void> => {
    for (let pass = 0; pass < 100; pass += 1) {
      const entries = [...engineCapabilityDiscoveryAuthorities]
        .filter((authority) => !projectId || authority.projectId === projectId);
      if (entries.length === 0) return;
      for (const authority of entries) authority.controller.abort();
      await Promise.allSettled(entries.flatMap((authority) => authority.operation ? [authority.operation] : []));
      const cleanup = await Promise.allSettled(entries.map(closeCapabilityDiscoveryAuthority));
      const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Engine capability-discovery authority did not drain");
    }
    throw new Error("Engine capability-discovery authority did not reach a fixed point");
  };
  const discoverEngineCapabilities = (
    projectId: string,
    hostPath: string,
    adapter: Adapter,
    model: string | undefined,
    forceRefresh: boolean,
  ): Promise<EngineCapabilities> => {
    if (isClosed() || deletingProjectIds.has(projectId)) {
      return Promise.reject(new Error("Project capability discovery is unavailable during deletion or shutdown"));
    }
    if (!adapter.capabilities) {
      return Promise.resolve({
        steering: false,
        persistentSessions: false,
        commands: [],
        mcpServers: [],
        composerCapabilities: [],
      });
    }
    const scopeKey = engineCapabilityScopeKey(projectId, adapter.id);
    const generation = engineCapabilityGenerations.get(scopeKey) ?? 0;
    const key = engineCapabilityKey(projectId, hostPath, adapter.id, model);
    const cached = engineCapabilityCache.get(key);
    const running = engineCapabilityDiscoveries.get(key);
    // A cache invalidation may make this result ineligible for storage, but it
    // must not create a second provider process beside discovery already in
    // progress. Ordinary readers keep receiving the last successful value;
    // only an explicit refresh waits for the discovery already in flight.
    if (running) {
      if (!forceRefresh && cached) return Promise.resolve(cached.value);
      return running.operation!;
    }
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

    const authority: CapabilityDiscoveryAuthority = {
      projectId,
      engineId: adapter.id,
      key,
      controller: new AbortController(),
      processes: new Set(),
      settled: false,
    };
    engineCapabilityDiscoveryAuthorities.add(authority);
    const registerProcess = (handle: RuntimeProcessHandle): void => {
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      if (isClosed() || deletingProjectIds.has(projectId) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error({ err: error, projectId, engineId: adapter.id }, "late capability-discovery process cleanup remains pending");
        });
      }
    };
    const adapterOperation = Promise.resolve()
      .then(() => adapter.capabilities!(hostPath, {
        ...(model ? { model } : {}),
        signal: authority.controller.signal,
        onRuntimeSpawned: registerProcess,
      }));
    const promise = adapterOperation
      .then(async (value) => {
        authority.settled = true;
        await closeCapabilityDiscoveryAuthority(authority);
        if ((engineCapabilityGenerations.get(scopeKey) ?? 0) === generation) {
          engineCapabilityCache.set(key, {
            projectId,
            engineId: adapter.id,
            expiresAt: Date.now() + engineCapabilityCacheTtlMs,
            value,
          });
          if (!cached || JSON.stringify(cached.value) !== JSON.stringify(value)) {
            appendWorkspace({ type: "runtime_capabilities_changed", projectId, engineId: adapter.id });
          }
        }
        return value;
      }, async (error: unknown) => {
        authority.settled = true;
        try {
          await closeCapabilityDiscoveryAuthority(authority);
        } catch (closeError) {
          throw new AggregateError([error, closeError], `${adapter.id} capability discovery and cleanup failed`);
        }
        throw error;
      });
    authority.operation = promise;
    engineCapabilityDiscoveries.set(key, authority);
    if (!forceRefresh && cached) {
      void promise.catch((error) => {
        app.log.warn({ err: error, projectId, engineId: adapter.id }, "background capability refresh failed; serving last-known capabilities");
      });
      return Promise.resolve(cached.value);
    }
    return promise;
  };
  const readEngineCapabilities = (
    projectId: string,
    hostPath: string,
    adapter: Adapter,
    model: string | undefined,
  ): {
    capabilities: EngineCapabilities;
    discovered: boolean;
    refreshing: boolean;
  } => {
    if (!adapter.capabilities) {
      return {
        capabilities: undiscoveredEngineCapabilities,
        discovered: true,
        refreshing: false,
      };
    }
    const key = engineCapabilityKey(projectId, hostPath, adapter.id, model);
    const cached = engineCapabilityCache.get(key);
    const running = engineCapabilityDiscoveries.has(key);
    if (cached && cached.expiresAt > Date.now() && !running) {
      return {
        capabilities: cached.value,
        discovered: true,
        refreshing: false,
      };
    }
    if (!running && !isClosed() && !deletingProjectIds.has(projectId)) {
      void discoverEngineCapabilities(
        projectId,
        hostPath,
        adapter,
        model,
        false,
      ).catch((error) => {
        app.log.warn(
          { err: error, projectId, engineId: adapter.id },
          "background capability discovery failed",
        );
      });
    }
    return {
      capabilities: cached?.value ?? undiscoveredEngineCapabilities,
      discovered: Boolean(cached),
      refreshing: running
        || (!isClosed() && !deletingProjectIds.has(projectId)),
    };
  };
  const engineModelCatalogCacheTtlMs = 5 * 60_000;
  const engineModelCatalogCache = new Map<string, {
    projectId: string;
    engineId: string;
    hostPath: string;
    configurationKey: string;
    expiresAt: number;
    value: ProjectEngineModelCatalogDto;
  }>();
  const latestEngineModelCatalogKeys = new Map<string, string>();
  const engineModelCatalogDiscoveries = new Map<string, ModelCatalogDiscoveryAuthority>();
  const engineModelCatalogDiscoveryAuthorities = new Set<ModelCatalogDiscoveryAuthority>();
  const engineModelCatalogKey = (
    projectId: string,
    hostPath: string,
    adapter: Adapter,
  ): string => [
    projectId,
    hostPath,
    adapter.id,
    adapter.modelCatalogConfigurationKey?.() ?? "default",
  ].join("\0");
  const closeModelCatalogDiscoveryAuthority = async (
    authority: ModelCatalogDiscoveryAuthority,
  ): Promise<void> => {
    authority.controller.abort();
    const processes = [...authority.processes].filter((state) => !state.terminationConfirmed);
    const results = await Promise.allSettled(processes.map(closeCapabilityDiscoveryProcess));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, `${authority.engineId} model-catalog cleanup failed`);
    for (const process of [...authority.processes]) {
      if (process.terminationConfirmed) authority.processes.delete(process);
    }
    if (authority.settled && authority.processes.size === 0) {
      engineModelCatalogDiscoveryAuthorities.delete(authority);
      if (engineModelCatalogDiscoveries.get(authority.key) === authority) {
        engineModelCatalogDiscoveries.delete(authority.key);
      }
    }
  };
  const drainEngineModelCatalogDiscoveries = async (projectId?: string): Promise<void> => {
    for (let pass = 0; pass < 100; pass += 1) {
      const entries = [...engineModelCatalogDiscoveryAuthorities]
        .filter((authority) => !projectId || authority.projectId === projectId);
      if (entries.length === 0) return;
      for (const authority of entries) authority.controller.abort();
      await Promise.allSettled(entries.flatMap((authority) => authority.operation ? [authority.operation] : []));
      const cleanup = await Promise.allSettled(entries.map(closeModelCatalogDiscoveryAuthority));
      const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Engine model-catalog authority did not drain");
    }
    throw new Error("Engine model-catalog authority did not reach a fixed point");
  };
  const liveProjectModelCatalog = async (
    projectId: string,
    adapter: Adapter,
  ): Promise<{ models: EngineModelOption[]; cliVersion: string } | undefined> => {
    for (const agent of store.listAgents(projectId)) {
      if (agent.activeEngine !== adapter.id) continue;
      const session = activeRuns.get(agent.id)?.runtimeSession ?? reusableRuntime(agent.id)?.session;
      const live = session?.capabilities ? await session.capabilities() : undefined;
      if (!live?.modelCatalog) continue;
      return {
        models: adapter.configuredModelCatalog
          ? adapter.configuredModelCatalog(live.modelCatalog.models)
          : live.modelCatalog.models,
        cliVersion: live.modelCatalog.cliVersion,
      };
    }
  };
  const discoverEngineModelCatalog = (
    project: { id: string; hostPath: string },
    adapter: Adapter,
    forceRefresh: boolean,
  ): Promise<ProjectEngineModelCatalogDto> => {
    if (isClosed() || deletingProjectIds.has(project.id)) {
      return Promise.reject(new Error("Project model discovery is unavailable during deletion or shutdown"));
    }
    if (!adapter.discoverModelCatalog) {
      return Promise.reject(new Error("this engine does not provide model discovery"));
    }
    const key = engineModelCatalogKey(project.id, project.hostPath, adapter);
    const cachedKey = latestEngineModelCatalogKeys.get(key);
    const cached = cachedKey ? engineModelCatalogCache.get(cachedKey) : undefined;
    const running = engineModelCatalogDiscoveries.get(key);
    if (running) {
      if (!forceRefresh && cached) {
        return Promise.resolve({ ...cached.value, refreshing: true });
      }
      return running.operation as Promise<ProjectEngineModelCatalogDto>;
    }
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.value);
    }

    const authority: ModelCatalogDiscoveryAuthority = {
      projectId: project.id,
      engineId: adapter.id,
      key,
      controller: new AbortController(),
      processes: new Set(),
      settled: false,
    };
    engineModelCatalogDiscoveryAuthorities.add(authority);
    const registerProcess = (handle: RuntimeProcessHandle): void => {
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      if (isClosed() || deletingProjectIds.has(project.id) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error({ err: error, projectId: project.id, engineId: adapter.id }, "late model-catalog process cleanup remains pending");
        });
      }
    };
    const operation = Promise.resolve()
      .then(async () => {
        const live = await liveProjectModelCatalog(project.id, adapter);
        const catalog = live
          ? {
              models: live.models,
              cliVersion: live.cliVersion,
              configurationKey: adapter.modelCatalogConfigurationKey?.() ?? "default",
            }
          : await adapter.discoverModelCatalog!(project.hostPath, {
              signal: authority.controller.signal,
              onRuntimeSpawned: registerProcess,
            });
        const value: ProjectEngineModelCatalogDto = {
          projectId: project.id,
          engineId: adapter.id,
          models: catalog.models,
          cliVersion: catalog.cliVersion,
          configurationKey: catalog.configurationKey,
          fetchedAt: new Date().toISOString(),
        };
        const versionedKey = [key, catalog.cliVersion].join("\0");
        engineModelCatalogCache.set(versionedKey, {
          projectId: project.id,
          engineId: adapter.id,
          hostPath: project.hostPath,
          configurationKey: catalog.configurationKey,
          expiresAt: Date.now() + engineModelCatalogCacheTtlMs,
          value,
        });
        latestEngineModelCatalogKeys.set(key, versionedKey);
        return value;
      })
      .then(async (value) => {
        authority.settled = true;
        await closeModelCatalogDiscoveryAuthority(authority);
        return value;
      }, async (error: unknown) => {
        authority.settled = true;
        try {
          await closeModelCatalogDiscoveryAuthority(authority);
        } catch (closeError) {
          throw new AggregateError([error, closeError], `${adapter.id} model discovery and cleanup failed`);
        }
        throw error;
      });
    authority.operation = operation;
    engineModelCatalogDiscoveries.set(key, authority);
    if (!forceRefresh && cached) {
      void operation.catch((error) => {
        app.log.warn({ err: error, projectId: project.id, engineId: adapter.id }, "background model refresh failed; serving last-known choices");
      });
      return Promise.resolve({ ...cached.value, refreshing: true });
    }
    return operation;
  };
  const validateEngineModel = async (
    project: { id: string; hostPath: string },
    adapter: Adapter,
    modelId: string,
  ): Promise<EngineModelValidationDto> => {
    const authority: ModelCatalogDiscoveryAuthority = {
      projectId: project.id,
      engineId: adapter.id,
      key: `validation\0${project.id}\0${adapter.id}\0${randomUUID()}`,
      controller: new AbortController(),
      processes: new Set(),
      settled: false,
    };
    engineModelCatalogDiscoveryAuthorities.add(authority);
    const registerProcess = (handle: RuntimeProcessHandle): void => {
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      if (isClosed() || deletingProjectIds.has(project.id) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error(
            { err: error, projectId: project.id, engineId: adapter.id },
            "late model-validation cleanup remains pending",
          );
        });
      }
    };
    const operation = adapter.validateModel!(project.hostPath, modelId, {
      signal: authority.controller.signal,
      onRuntimeSpawned: registerProcess,
    });
    authority.operation = operation;
    try {
      return await operation;
    } catch (error) {
      return {
        valid: false,
        errorCode: "provider_error",
        error: error instanceof Error ? error.message : "Claude model validation failed",
      };
    } finally {
      authority.settled = true;
      await closeModelCatalogDiscoveryAuthority(authority);
    }
  };
  const markEngineModelUnavailable = (
    project: { id: string; hostPath: string },
    adapter: Adapter,
    modelId: string,
    reason: string,
  ): void => {
    const now = new Date().toISOString();
    for (const [key, entry] of engineModelCatalogCache) {
      if (entry.projectId !== project.id || entry.engineId !== adapter.id) continue;
      const models = entry.value.models.map((model) => model.id === modelId
        ? { ...model, availability: "unavailable" as const, unavailableReason: reason }
        : model);
      engineModelCatalogCache.set(key, {
        ...entry,
        expiresAt: 0,
        value: { ...entry.value, models, fetchedAt: now },
      });
    }
    const preferences = workspace.getPreferences();
    if (!preferences.claudeModelOptions.some((model) => model.id === modelId)) return;
    const cursor = workspace.cursor();
    workspace.updatePreferences({
      claudeModelOptions: preferences.claudeModelOptions.map((model) => model.id === modelId
        ? { ...model, availability: "unavailable", unavailableReason: reason }
        : model),
    });
    applyOperatorModelOptions();
    publishWorkspaceSince(cursor);
  };
  const cachedModelOptions = (
    adapter: Adapter,
    projectId?: string,
  ): ModelOption[] => {
    const byId = new Map<string, ModelOption>();
    for (const key of new Set(latestEngineModelCatalogKeys.values())) {
      const entry = engineModelCatalogCache.get(key);
      if (!entry) continue;
      if (entry.engineId !== adapter.id || (projectId && entry.projectId !== projectId)) continue;
      for (const model of entry.value.models) {
        byId.set(model.id, {
          id: model.id,
          label: model.label,
          ...(model.supportedEffortLevels
            ? { efforts: model.supportedEffortLevels.map((effort) => ({ id: effort, label: effort })) }
            : {}),
        });
      }
    }
    return [...byId.values()];
  };

  return {
    cachedModelOptions,
    closeCapabilityDiscoveryAuthority,
    closeCapabilityDiscoveryProcess,
    discoverEngineCapabilities,
    discoverEngineModelCatalog,
    drainEngineCapabilityDiscoveries,
    drainEngineModelCatalogDiscoveries,
    engineCapabilityDiscoveries,
    engineCapabilityDiscoveryAuthorities,
    engineDto,
    engineModelCatalogCache,
    engineModelCatalogDiscoveries,
    engineModelCatalogDiscoveryAuthorities,
    invalidateEngineCapabilities,
    markEngineModelUnavailable,
    providerUsageCenter,
    providerUsageState,
    readEngineCapabilities,
    refreshProviderUsageAfterRun,
    reportRuntimeCapabilitiesChanged,
    runtimeStatus,
    validateEngineModel,
  };
}
