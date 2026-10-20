import { createHash, randomUUID } from "node:crypto";
import {
  normalizeEngineModelValidationError,
  publicProviderFailure,
} from "@ponderosa/core";
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
  ProviderFailureCategory,
} from "@ponderosa/core";
import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { EngineAuthStatusCache } from "./engine-auth-cache.js";
import type { EngineAvailabilityStore } from "./engine-availability-store.js";
import type { ProviderUsageCache, ProviderUsageTarget } from "./provider-usage-cache.js";
import type { ProviderProcessAuthority } from "./provider-process-authority.js";
import {
  guardedProviderExceptionStringProperty,
  restrictedProviderExceptionLogDetail,
} from "./provider-exception-properties.js";
import {
  publicProviderAvailabilityDetail,
  publicProviderExceptionResponse,
} from "./provider-availability-detail.js";
import {
  projectProviderCapabilities,
  projectProviderEffortOptions,
  projectProviderModelCatalog,
  projectProviderModelIdentifier,
  projectProviderModelOptions,
  projectProviderModelValidation,
} from "./provider-success-projection.js";
import { providerProcessHandleFacade } from "./provider-session-facade.js";
import type {
  CapabilityDiscoveryAuthority,
  CapabilityDiscoveryProcess,
  EngineRegistration,
  ModelCatalogDiscoveryAuthority,
  ActiveRun,
  PersistentRuntime,
} from "./app-contracts.js";

interface EngineControlPlaneContext {
  resourceAdmission?: import("./resource-admission.js").ResourceAdmission;
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
  providerProcessAuthority: ProviderProcessAuthority;
}

export class ProviderAdapterBoundaryError extends Error {
  readonly engineId: string;
  readonly operation: string;
  readonly publicResponse: ReturnType<typeof publicProviderExceptionResponse>;
  readonly restrictedDetail?: string;

  constructor(engineId: string, operation: string, cause: unknown) {
    const publicResponse = publicProviderExceptionResponse(cause);
    super(publicResponse.error, { cause });
    this.name = "ProviderAdapterBoundaryError";
    this.engineId = engineId;
    this.operation = operation;
    this.publicResponse = publicResponse;
    this.restrictedDetail = guardedProviderExceptionStringProperty(cause, "restrictedDetail")
      ?? guardedProviderExceptionStringProperty(cause, "message");
  }
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
    providerProcessAuthority,
  } = context;

  const publicAuthStatusExceptionDetail = (_error: unknown): string =>
    "runtime authentication could not be checked";

  const providerAdapterCall = <T>(
    adapter: Adapter,
    operation: string,
    callback: () => T,
  ): T => {
    try {
      return callback();
    } catch (error) {
      throw new ProviderAdapterBoundaryError(adapter.id, operation, error);
    }
  };
  const providerAdapterOperation = async <T>(
    adapter: Adapter,
    operation: string,
    callback: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await callback();
    } catch (error) {
      throw new ProviderAdapterBoundaryError(adapter.id, operation, error);
    }
  };

  const providerInstalled = (id: string, registration = engines.get(id)): boolean => {
    const installed = registration?.isInstalled?.() !== false;
    if (!installed) engineAuthStatuses.invalidate(id);
    return installed;
  };
  const providerDiscoveryEnabled = (id: string): boolean =>
    providerEnabled(id) && providerInstalled(id);
  const providerInactiveError = (): Error => Object.assign(
    new Error("Provider is not installed or is disabled on this host."),
    { statusCode: 409, code: "PROVIDER_INACTIVE" },
  );

  const runtimeFailureDetail = (engineId: string): string | undefined => {
    const denial = engineAvailability.denial(engineId);
    return denial
      ? publicProviderAvailabilityDetail(denial.detail, denial.failureCategory)
      : undefined;
  };
  const runtimeAdmissionBlocker = (id: string, registration: EngineRegistration): import("@ponderosa/core").QueuedAdmissionBlockerDto | undefined => {
    const providerId = id.slice(0, 128);
    if (!providerEnabled(id)) return { kind: "provider_disabled", providerId };
    if (!providerInstalled(id, registration)) return { kind: "provider_unavailable", providerId };
    const resources = context.resourceAdmission?.snapshot(activeRuns.size);
    if (resources?.state === "held") return { kind: "host_resource_pressure", providerId, observedAt: resources.observedAt, resourceAdmission: resources };
    const auth = registration.authStatus ? engineAuthStatuses.snapshot(id) : { state: "known" as const, authenticated: true };
    if (auth.state === "unknown") return { kind: "authentication_unknown", providerId,
      ...(auth.lastKnown ? { lastKnownAuthentication: auth.lastKnown } : {}) };
    if (!auth.authenticated) return { kind: "authentication_required", providerId, ...(auth.observedAt ? { observedAt: auth.observedAt } : {}) };
    const denial = engineAvailability.denial(id);
    return denial ? { kind: "provider_unavailable", providerId, observedAt: denial.observedAt } : undefined;
  };
  const runtimeStatus = async (
    id: string,
    registration: EngineRegistration,
  ): Promise<{
    configured: true;
    installed?: boolean;
    authentication: "authenticated" | "unauthenticated" | "error";
    intakeReady: boolean;
    reachability: "unverified" | "reachable" | "degraded";
    authDetail?: string;
    authObservedAt?: string;
    authReason?: import("@ponderosa/core").EngineAuthStatus["reason"];
    authSource?: import("@ponderosa/core").EngineAuthStatus["source"];
    availabilityDetail?: string;
    availabilityCategory?: ProviderFailureCategory;
    availabilityObservedAt?: string;
    availabilitySource?: "provider_run" | "operator_probe";
    availabilityBuildRevision?: string;
    availabilityInstanceId?: string;
    authLastKnown?: { authenticated: boolean; observedAt: string };
  }> => {
    if (!providerInstalled(id, registration)) return {
      configured: true, installed: false, authentication: "unauthenticated",
      intakeReady: false, reachability: "unverified",
      availabilityDetail: "Provider CLI is not installed on this host. Install it, then recheck sign-in.",
    };
    let auth: import("@ponderosa/core").EngineAuthStatus;
    try {
      auth = registration.authStatus
        ? await engineAuthStatuses.read(id, registration.authStatus, context.resourceAdmission?.snapshot().state !== "held")
        : { authenticated: true, detail: "runtime registered (authentication status not reported)" };
    } catch (error) {
      app.log.warn({
        providerError: restrictedProviderExceptionLogDetail(error),
        engineId: id,
      }, "provider authentication status failed");
      const authDetail = publicAuthStatusExceptionDetail(error);
      return {
        configured: true,
        authentication: "error",
        intakeReady: false,
        reachability: engineAvailability.get(id) ? engineAvailability.get(id)!.available ? "reachable" : "degraded" : "unverified",
        authDetail,
        ...(engineAuthStatuses.snapshot(id).lastKnown ? { authLastKnown: engineAuthStatuses.snapshot(id).lastKnown } : {}),
        availabilityDetail: "runtime authentication could not be checked",
        availabilityCategory: "unavailable",
      };
    }
    const unknown = auth.status === "unknown";
    const authDetail = unknown ? "Provider authentication could not be checked."
      : auth.authenticated
      ? "Provider authentication is available."
      : "Provider authentication is required.";
    const denial = runtimeFailureDetail(id);
    const evidence = engineAvailability.get(id);
    const enabled = providerEnabled(id);
    return {
      configured: true,
      installed: true,
      authentication: unknown ? "error" : auth.authenticated ? "authenticated" : "unauthenticated",
      intakeReady: enabled && !unknown && auth.authenticated && !denial && context.resourceAdmission?.snapshot(activeRuns.size).state !== "held",
      authObservedAt: engineAuthStatuses.snapshot(id).observedAt,
      ...(auth.reason ? { authReason: auth.reason } : {}),
      ...(auth.source ? { authSource: auth.source } : {}),
      ...(unknown && engineAuthStatuses.snapshot(id).lastKnown ? { authLastKnown: engineAuthStatuses.snapshot(id).lastKnown } : {}),
      reachability: evidence ? (evidence.available ? "reachable" : "degraded") : "unverified",
      ...(evidence ? {
        availabilityObservedAt: evidence.observedAt,
        availabilitySource: evidence.source,
        ...(evidence.buildRevision ? { availabilityBuildRevision: evidence.buildRevision } : {}),
        ...(evidence.instanceId ? { availabilityInstanceId: evidence.instanceId } : {}),
      } : {}),
      ...(authDetail ? { authDetail } : {}),
      ...(evidence && !evidence.available
        ? { availabilityCategory: evidence.failureCategory ?? "unknown" }
        : {}),
      ...(!enabled ? { availabilityDetail: "disabled by the operator; queued work is held" }
        : !auth.authenticated
        ? { availabilityDetail: authDetail ?? "runtime is not authenticated" }
        : denial ? { availabilityDetail: denial }
          : evidence?.available
            ? { availabilityDetail: "Provider access check succeeded." }
            : { availabilityDetail: "provider intake is enabled; reachability has not yet been verified by real work" }),
    };
  };
  const engineDto = async (registration: EngineRegistration): Promise<EngineDto> => {
    const { adapter } = registration;
    let status: Awaited<ReturnType<typeof runtimeStatus>>;
    try {
      status = await runtimeStatus(adapter.id, registration);
    } catch (error) {
      const authDetail = publicAuthStatusExceptionDetail(error);
      status = {
        configured: true,
        authentication: "error",
        intakeReady: false,
        reachability: "degraded",
        authDetail,
        availabilityDetail: "runtime authentication could not be checked",
        availabilityCategory: "unavailable",
      };
    }
    try {
      const models = projectProviderModelOptions(
        providerAdapterCall(adapter, "list models", () => adapter.listModels()),
      );
      const defaultModel = projectProviderModelIdentifier(adapter.defaultModel?.())
        ?? models.find((model) => model.id)?.id;
      const defaultEffort = projectProviderModelIdentifier(adapter.defaultEffort?.(defaultModel))
        ?? models.find((model) => model.id === defaultModel)?.defaultEffort
        ?? projectProviderEffortOptions(adapter.listEfforts(defaultModel))[0]?.id;
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        ...(adapter.providerUsageCommand ? { providerUsageCommand: adapter.providerUsageCommand.name } : {}),
        models: models.map((model) => ({
          ...model,
          ...(model.efforts !== undefined
            ? { efforts: model.efforts }
            : !adapter.modelSpecificEfforts || !model.id
              ? { efforts: projectProviderEffortOptions(adapter.listEfforts(model.id || undefined)) }
              : {}),
        })),
        ...(adapter.configuredModelOptions
          ? { configuredModels: projectProviderModelOptions(adapter.configuredModelOptions()) }
          : {}),
        efforts: projectProviderEffortOptions(adapter.listEfforts()),
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultEffort ? { defaultEffort } : {}),
        modelCatalogKnown: !adapter.modelSpecificEfforts || models.some((model) => Boolean(model.id)),
        enabled: providerEnabled(adapter.id),
        servingBuildRevision: engineAvailability.servingBuildRevision,
        servingInstanceId: engineAvailability.servingInstanceId,
        ...(context.resourceAdmission ? { resourceAdmission: context.resourceAdmission.snapshot(activeRuns.size) } : {}),
        ...status,
      };
    } catch (error) {
      throw new ProviderAdapterBoundaryError(adapter.id, "read engine configuration", error);
    }
  };
  const providerUsageTarget = async (registration: EngineRegistration): Promise<ProviderUsageTarget> => {
    const enabled = providerEnabled(registration.adapter.id);
    const auth = !providerDiscoveryEnabled(registration.adapter.id) ? { authenticated: false } : registration.authStatus
      ? await engineAuthStatuses.get(registration.adapter.id, registration.authStatus)
      : { authenticated: true, detail: "authenticated provider" };
    if (!enabled || !auth.authenticated) {
      providerUsage.invalidateUnavailable(registration.adapter.id);
      return {
        adapter: registration.adapter,
        displayName: registration.adapter.displayName,
        enabled,
        authenticated: auth.authenticated,
        accountKey: !enabled ? "disabled" : auth.status === "unknown" ? "authentication_unknown" : "unauthenticated",
      };
    }
    const detail = auth.detail?.trim();
    const accountKey = detail
      ? createHash("sha256").update(`${registration.adapter.id}\0${detail}`, "utf8").digest("hex")
      : "authenticated";
    return {
      adapter: registration.adapter,
      displayName: registration.adapter.displayName,
      enabled,
      authenticated: auth.authenticated,
      accountKey,
      ...(registration.adapter.id === "codex"
          ? { accountLabel: "ChatGPT account" }
          : {}),
    };
  };
  const providerUsageState = async (
    registration: EngineRegistration,
    refresh: "none" | "stale" | "force" = "none",
  ): Promise<ProviderUsageStateDto> => {
    try {
      const target = await providerUsageTarget(registration);
      return refresh === "none"
        ? providerUsage.state(target)
        : providerUsage.refresh(target, refresh === "force");
    } catch (error) {
      const target: ProviderUsageTarget = {
        adapter: registration.adapter,
        displayName: registration.adapter.displayName,
        enabled: providerEnabled(registration.adapter.id),
        authenticated: false,
        accountKey: "provider-status-unavailable",
      };
      app.log.warn({
        providerError: restrictedProviderExceptionLogDetail(error),
        engineId: registration.adapter.id,
      }, "provider usage target could not be resolved");
      return providerUsage.unavailableState(target, "server_environment_invalid");
    }
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
      app.log.warn({
        providerError: restrictedProviderExceptionLogDetail(error),
        engineId,
      }, "provider usage refresh after Run failed");
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
  const drainEngineCapabilityDiscoveries = async (
    projectId?: string,
    agentIds?: ReadonlySet<string>,
  ): Promise<void> => {
    for (let pass = 0; pass < 100; pass += 1) {
      const entries = [...engineCapabilityDiscoveryAuthorities]
        .filter((authority) => (!projectId || authority.projectId === projectId) &&
          (!agentIds || (authority.agentId !== undefined && agentIds.has(authority.agentId))));
      if (entries.length === 0) return;
      for (const authority of entries) authority.controller.abort();
      // Close every process before awaiting adapter settlement. A command can
      // own a working-folder lease until its operation settles; waiting first
      // would deadlock deletion against the teardown it needs to cause that
      // settlement.
      const cleanup = await Promise.allSettled(entries.map(closeCapabilityDiscoveryAuthority));
      const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Engine capability-discovery authority did not drain");
      await Promise.allSettled(entries.flatMap((authority) => authority.operation ? [authority.operation] : []));
      const finalCleanup = await Promise.allSettled(entries.map(closeCapabilityDiscoveryAuthority));
      const finalFailures = finalCleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (finalFailures.length) {
        throw new AggregateError(finalFailures, "Engine capability-discovery authority did not finish draining");
      }
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
    if (!providerDiscoveryEnabled(adapter.id)) return Promise.resolve(undiscoveredEngineCapabilities);
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
      handle = providerProcessHandleFacade(handle);
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      providerProcessAuthority.register(handle, {
        purpose: `${adapter.id} capability discovery`,
        projectId,
      });
      if (isClosed() || deletingProjectIds.has(projectId) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error({
            providerError: restrictedProviderExceptionLogDetail(error),
            projectId,
            engineId: adapter.id,
          }, "late capability-discovery process cleanup remains pending");
        });
      }
    };
    const adapterOperation = Promise.resolve()
      .then(() => providerAdapterOperation(adapter, "discover capabilities", async () =>
        projectProviderCapabilities(await adapter.capabilities!(hostPath, {
          ...(model ? { model } : {}),
          signal: authority.controller.signal,
          onRuntimeSpawned: registerProcess,
        }))));
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
          throw new ProviderAdapterBoundaryError(
            adapter.id,
            "clean up capability discovery",
            new AggregateError([error, closeError], `${adapter.id} capability discovery and cleanup failed`),
          );
        }
        throw error;
      });
    authority.operation = promise;
    engineCapabilityDiscoveries.set(key, authority);
    if (!forceRefresh && cached) {
      void promise.catch((error) => {
        app.log.warn({
          providerError: restrictedProviderExceptionLogDetail(error),
          projectId,
          engineId: adapter.id,
        }, "background capability refresh failed; serving last-known capabilities");
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
    if (!providerDiscoveryEnabled(adapter.id)) return { capabilities: undiscoveredEngineCapabilities, discovered: false, refreshing: false };
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
          {
            providerError: restrictedProviderExceptionLogDetail(error),
            projectId,
            engineId: adapter.id,
          },
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
    providerAdapterCall(
      adapter,
      "read model catalog configuration",
      () => projectProviderModelIdentifier(adapter.modelCatalogConfigurationKey?.() ?? "default")!,
    ),
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
      let live: EngineCapabilities | undefined;
      try {
        live = session?.capabilities
          ? projectProviderCapabilities(await session.capabilities())
          : undefined;
      } catch (error) {
        throw new ProviderAdapterBoundaryError(
          adapter.id,
          "read live model catalog",
          error,
        );
      }
      if (!live?.modelCatalog) continue;
      return {
        models: adapter.configuredModelCatalog
          ? providerAdapterCall(
              adapter,
              "normalize configured model catalog",
              () => projectProviderModelCatalog({
                models: adapter.configuredModelCatalog!(live.modelCatalog!.models),
                cliVersion: live.modelCatalog!.cliVersion,
                configurationKey: "live",
              }).models,
            )
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
    if (!providerDiscoveryEnabled(adapter.id)) return Promise.reject(providerInactiveError());
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
      handle = providerProcessHandleFacade(handle);
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      providerProcessAuthority.register(handle, {
        purpose: `${adapter.id} model catalog discovery`,
        projectId: project.id,
      });
      if (isClosed() || deletingProjectIds.has(project.id) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error({
            providerError: restrictedProviderExceptionLogDetail(error),
            projectId: project.id,
            engineId: adapter.id,
          }, "late model-catalog process cleanup remains pending");
        });
      }
    };
    const operation = Promise.resolve()
      .then(async () => {
        const live = await liveProjectModelCatalog(project.id, adapter);
        const rawCatalog = live
          ? {
              models: live.models,
              cliVersion: live.cliVersion,
              configurationKey: providerAdapterCall(
                adapter,
                "read model catalog configuration",
                () => projectProviderModelIdentifier(
                  adapter.modelCatalogConfigurationKey?.() ?? "default",
                )!,
              ),
            }
          : await providerAdapterOperation(
              adapter,
              "discover model catalog",
              () => adapter.discoverModelCatalog!(project.hostPath, {
                signal: authority.controller.signal,
                onRuntimeSpawned: registerProcess,
              }),
            );
        const catalog = providerAdapterCall(
          adapter,
          "project model catalog",
          () => projectProviderModelCatalog(rawCatalog),
        );
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
          throw new ProviderAdapterBoundaryError(
            adapter.id,
            "clean up model discovery",
            new AggregateError([error, closeError], `${adapter.id} model discovery and cleanup failed`),
          );
        }
        throw error;
      });
    authority.operation = operation;
    engineModelCatalogDiscoveries.set(key, authority);
    if (!forceRefresh && cached) {
      void operation.catch((error) => {
        app.log.warn({
          providerError: restrictedProviderExceptionLogDetail(error),
          projectId: project.id,
          engineId: adapter.id,
        }, "background model refresh failed; serving last-known choices");
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
    if (!providerDiscoveryEnabled(adapter.id)) throw providerInactiveError();
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
      handle = providerProcessHandleFacade(handle);
      const state: CapabilityDiscoveryProcess = { handle };
      authority.processes.add(state);
      providerProcessAuthority.register(handle, {
        purpose: `${adapter.id} model validation`,
        projectId: project.id,
      });
      if (isClosed() || deletingProjectIds.has(project.id) || authority.controller.signal.aborted) {
        void closeCapabilityDiscoveryProcess(state).catch((error) => {
          app.log.error(
            {
              providerError: restrictedProviderExceptionLogDetail(error),
              projectId: project.id,
              engineId: adapter.id,
            },
            "late model-validation cleanup remains pending",
          );
        });
      }
    };
    const operation = providerAdapterCall(
      adapter,
      "validate model",
      () => adapter.validateModel!(project.hostPath, modelId, {
        signal: authority.controller.signal,
        onRuntimeSpawned: registerProcess,
      }),
    );
    authority.operation = operation;
    try {
      const result = projectProviderModelValidation(await operation);
      if (result.valid) return result;
      const errorCode = normalizeEngineModelValidationError(result.errorCode);
      const publicFailure = publicProviderFailure({
        detail: result.error,
        code: errorCode,
      });
      return {
        valid: false,
        errorCode,
        error: publicFailure.summary,
      };
    } catch (error) {
      app.log.warn({
        providerError: restrictedProviderExceptionLogDetail(error),
        engineId: adapter.id,
      }, "provider model validation failed");
      const publicFailure = publicProviderExceptionResponse(error);
      return {
        valid: false,
        errorCode: "provider_error",
        error: publicFailure.error,
      };
    } finally {
      authority.settled = true;
      try {
        await closeModelCatalogDiscoveryAuthority(authority);
      } catch (error) {
        throw new ProviderAdapterBoundaryError(
          adapter.id,
          "clean up model validation",
          error,
        );
      }
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
    runtimeAdmissionBlocker,
    validateEngineModel,
  };
}
