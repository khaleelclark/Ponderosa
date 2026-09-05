import { AgentStore, CoordinationV3Store, WorkspaceStore, type LogEvent } from "@ponderosa/agents";
import { windowsJobObjectsSupported } from "@ponderosa/native-host";
import type {
  TokenUsageRangeDto,
  TokenUsageSummaryDto,
  WorkspaceEventEnvelope
} from "@ponderosa/core";
import Fastify, { type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createAgentDeletionAuthority } from "./agent-deletion-authority.js";
import { AgentWorkingCopyService } from "./agent-working-copy-service.js";
import {
  type ActiveRun,
  type AgentMessageCapability,
  type AgentRuntimeAuthority,
  type CreateServerOptions,
  type ManagementOperation,
  type ManagementPlan,
  type OneShotRuntimeTeardown,
  type OpeningPersistentRuntime,
  type PersistentRuntime,
  type PersistentRuntimeTeardown,
  type PonderosaServer,
  type Subscriber
} from "./app-contracts.js";
import { ASSET_LIMITS, AssetStore } from "./assets.js";
import { createBrowserAuthority } from "./browser-authority.js";
import { createCommunicationArtifactAuthority } from "./communication-artifacts.js";
import { createCommunicationJournal } from "./communication-journal.js";
import { createCommunicationProjectionReconciler } from "./communication-projection-reconciler.js";
import { ContextCursorStore } from "./context-cursors.js";
import { createCoordinationScheduler } from "./coordination-scheduler-service.js";
import { createDeploymentControl } from "./deployment-control.js";
import { EngineAuthStatusCache } from "./engine-auth-cache.js";
import { EngineAvailabilityStore } from "./engine-availability-store.js";
import {
  createEngineControlPlane,
  ProviderAdapterBoundaryError,
} from "./engine-control-plane.js";
import { createLinkPreviewService } from "./link-preview-service.js";
import { createLauncherSecurity } from "./launcher-security.js";
import { createOperationalNotifications } from "./operational-notifications.js";
import {
  descriptorRelativeFilesystemCapability
} from "./project-file-access.js";
import {
  publicWebAssetPaths,
  publicWebAssetRequest,
} from "./public-web-assets.js";
import { ProviderUsageCache } from "./provider-usage-cache.js";
import { providerUnavailableNotificationBody } from "./provider-availability-detail.js";
import { restrictedProviderExceptionLogDetail } from "./provider-exception-properties.js";
import { ProviderProcessAuthority } from "./provider-process-authority.js";
import { registerAgentSurface } from "./routes/agent-surface.js";
import { registerApplicationRoutes } from "./routes/application-routes.js";
import { DraftService } from "./routes/drafts.js";
import {
  createProjectFolderPathBoundary
} from "./routes/project-folders.js";
import { registerServerControlRoutes } from "./routes/server-control.js";
import { createRuntimeAuthority } from "./runtime-authority.js";
import { createRuntimeEventAuthority } from "./runtime-event-authority.js";
import { RuntimeElicitationBroker } from "./runtime-elicitation-broker.js";
import {
  cleanupAgentRuntimeAttachments,
  cleanupAllRuntimeAttachments,
} from "./runtime-attachments.js";
import type { ServerContext } from "./server-context.js";
import { registerServerLifecycle } from "./server-lifecycle.js";
import {
  publishWorkspaceEvent,
  reconcileCommittedProjectDeletion as reconcileProjectDeletionWorkspace,
  reconcileCommittedProjectDeletions as reconcileProjectDeletionsWorkspace,
} from "./project-deletion-workspace-reconciliation.js";
import { createServerReadModels } from "./server-read-models.js";
import {
  registerBodyParsers,
  registerRequestSecurityHooks,
} from "./server-request-hooks.js";
import { TriggerSourceService } from "./trigger-service.js";
import { createWebPushConfiguration } from "./web-push-configuration.js";
export {
  collectReachableArtifactIds,
  rewritePortableArtifactReferences
} from "./artifact-refs.js";
export {
  conciseConversationTitle,
  semanticConversationTitle
} from "./conversation-titles.js";
export {
  normalizeExternalCitations
} from "./external-content.js";
export {
  parseGitStatus
} from "./git-status.js";
export {
  notificationKindForCommunication,
  notificationPreferenceMatches, workspaceAgentEventCategory
} from "./notification-routing.js";
export {
  isProjectFileReferenceAllowed
} from "./project-files.js";
export {
  boundedContinuationHistory,
  boundedSeedHistory,
  runtimeIdentityPrompt
} from "./prompts.js";
export {
  PROVIDER_TOOL_CONTRACT_HASH,
  providerSessionContractHash
} from "./runtime-selection.js";
export {
  parseTokenUsageRange
} from "./token-usage.js";

export type { CreateServerOptions, EngineRegistration, PonderosaServer } from "./app-contracts.js";

export function createServer(opts: CreateServerOptions): PonderosaServer {
  // Provider processes and their opaque sessions do not survive a daemon
  // restart, so no runtime-only attachment path can remain authoritative.
  cleanupAllRuntimeAttachments(opts.dataDir);
  const {
    networkSecurity,
    launcherNow,
    launcherRandomToken,
    launcherBootstrapTtlMs,
    launcherSessionTtlMs,
    launcherBootstraps,
    launcherSessions,
    purgeLauncherSecurityState,
    validLauncherSession,
  } = createLauncherSecurity(opts);
  const store = opts.store ?? new AgentStore(opts.dataDir);
  const publicWebAssets = publicWebAssetPaths(opts.webDist);
  const artifactFilesystem = descriptorRelativeFilesystemCapability(opts.dataDir);
  const processContainment = process.platform === "win32"
    ? windowsJobObjectsSupported()
      ? { ok: true, detail: "Windows Job Object authority is available" }
      : { ok: false, detail: "Windows Job Object authority is unavailable" }
    : { ok: true, detail: "POSIX process-group authority is available" };
  const artifactFilesystemError = () => !artifactFilesystem.ok
    ? `artifact-dependent work is unavailable: ${artifactFilesystem.detail}`
    : !processContainment.ok
      ? `durable work is unavailable: ${processContainment.detail}`
      : undefined;
  const assets = new AssetStore(opts.dataDir);
  store.configureCommunicationAttachmentMetadataAuthority((projectId, artifact) =>
    assets.managedProjectArtifactMetadataIsAuthoritative(projectId, artifact));
  const coordinationV3 = new CoordinationV3Store(store.sqlite, {
    attachmentAuthority: {
      resolve: (projectId, agentId, attachmentId) =>
        assets.authoritativeRuntimeAttachment(projectId, agentId, attachmentId),
      reserveCommunication: (communicationId, bindings) =>
        assets.reserveRuntimeCommunication(communicationId, bindings),
      compensateCommunication: (receipt) =>
        assets.compensateRuntimeCommunicationReservation(receipt),
    },
    artifactAuthority: (projectId, artifact) =>
      assets.authoritativeRuntimeArtifact(projectId, artifact),
    managedArtifactAttachmentAuthority: ({ projectId, artifactIds, sender, audience }) => {
      if (sender.kind !== "agent") throw new Error("managed artifacts may only be attached by an Agent");
      let totalBytes = 0;
      for (const artifactId of artifactIds) {
        const artifact = store.getProjectArtifact(projectId, artifactId);
        if (!artifact || artifact.projectId !== projectId ||
            !store.agentCanReadProjectArtifact(projectId, artifactId, sender.agentId) ||
            !assets.managedProjectArtifactMetadataIsAuthoritative(projectId, artifact)) {
          throw new Error("managed artifact attachment is unavailable or unauthorized");
        }
        totalBytes += artifact.size ?? 0;
        if (totalBytes > ASSET_LIMITS.maxMessageBytes) {
          throw new Error("managed artifact attachments exceed the message byte limit");
        }
        switch (audience.kind) {
          case "organization":
            if (audience.organizationId !== projectId ||
                !store.projectArtifactIsOrganizationVisible(projectId, artifactId)) {
              throw new Error("managed artifact attachment audience is unauthorized");
            }
            break;
          case "agents":
            if (audience.agentIds.some((agentId) =>
              !store.agentCanReadProjectArtifact(projectId, artifactId, agentId))) {
              throw new Error("managed artifact attachment audience is unauthorized");
            }
            break;
          case "user_agent":
            if (!store.operatorCanReadProjectArtifact(projectId, artifactId) ||
                !store.agentCanReadProjectArtifact(projectId, artifactId, audience.agentId)) {
              throw new Error("managed artifact attachment audience is unauthorized");
            }
            break;
          case "user_agents":
            if (!store.operatorCanReadProjectArtifact(projectId, artifactId) ||
                audience.agentIds.some((agentId) =>
                  !store.agentCanReadProjectArtifact(projectId, artifactId, agentId))) {
              throw new Error("managed artifact attachment audience is unauthorized");
            }
            break;
          case "user":
            if (!store.operatorCanReadProjectArtifact(projectId, artifactId)) {
              throw new Error("managed artifact attachment audience is unauthorized");
            }
            break;
          default: {
            const unhandledAudience: never = audience;
            void unhandledAudience;
            throw new Error("managed artifact attachment audience is unsupported");
          }
        }
      }
    },
    managedArtifactAttachmentRevalidator: ({ projectId, artifactIds }) => {
      for (const artifactId of artifactIds) {
        const artifact = store.getProjectArtifact(projectId, artifactId);
        if (!artifact || !assets.managedProjectArtifactIsAvailable(projectId, artifact)) {
          throw new Error("managed artifact attachment bytes are unavailable");
        }
      }
    },
  });
  const {
    communicationArtifactAccess,
    prepareUserCommunicationText,
    projectCommunicationArtifact,
    requestArtifactAccess,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
  } = createCommunicationArtifactAuthority({ dataDir: opts.dataDir, assets, store });
  const coordinationV3WorkerId = `server:${randomUUID()}`;
  const providerProcessAuthority = new ProviderProcessAuthority(store.sqlite, coordinationV3WorkerId);
  const workspace = new WorkspaceStore(opts.dataDir);
  const runtimeElicitations = new RuntimeElicitationBroker();
  // Startup recovery terminates any surviving prior-boot provider group before
  // readiness. Retire prompts whose sensitive live half cannot cross the boot.
  for (const decision of workspace.listDecisions({ status: "pending" })) {
    if (!decision.runtimeAction) continue;
    workspace.cancelDecision(decision.id);
  }
  const workspaceSubscribers = new Set<(event: WorkspaceEventEnvelope) => void>();
  const liveSseClosures = new Set<() => void>();
  const publishWorkspace = (event: WorkspaceEventEnvelope): void => {
    publishWorkspaceEvent(workspaceSubscribers, event, error => {
      app.log.warn({ err: error, workspaceEventId: event.id }, "workspace subscriber publication failed");
    });
  };
  const appendWorkspace = (event: Parameters<WorkspaceStore["append"]>[0]): WorkspaceEventEnvelope => {
    const stored = workspace.append(event);
    publishWorkspace(stored);
    return stored;
  };
  const publishWorkspaceSince = (cursor: number): void => {
    for (const event of workspace.readSince(cursor)) publishWorkspace(event);
  };
  const reconcileCommittedProjectDeletion = (projectId: string): WorkspaceEventEnvelope => {
    return reconcileProjectDeletionWorkspace(workspace, publishWorkspace, projectId);
  };
  const reconcileCommittedProjectDeletions = (): void => {
    reconcileProjectDeletionsWorkspace(store, workspace, publishWorkspace);
  };
  const { vapid, webPushConfiguration, webPushConfigurationDetail, webPushConfigured, webPushDelivery } =
    createWebPushConfiguration(opts.dataDir, workspace, publishWorkspaceSince);
  store.recoverInterruptedExecutions();
  const engines = new Map(opts.engines.map((engine) => [engine.adapter.id, engine]));
  const applyOperatorModelOptions = (): void => {
    const models = workspace.getPreferences().claudeModelOptions.map((model) => ({
      id: model.id,
      label: model.label ?? model.id,
      ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
      kind: "exact" as const,
      source: "operator" as const,
      ...(model.validatedAt ? { validatedAt: model.validatedAt } : {}),
      availability: model.availability ?? "available" as const,
      ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}),
    }));
    for (const { adapter } of engines.values()) {
      adapter.setOperatorModelOptions?.(models);
    }
  };
  applyOperatorModelOptions();
  const tokenUsage = (
    scope: { type: "overall" } | { type: "project" | "agent"; id: string },
    range: TokenUsageRangeDto = {},
  ): TokenUsageSummaryDto => store.getTokenUsage(scope, range);
  const activeRuns = new Map<string, ActiveRun>();
  const managementPlans = new Map<string, ManagementPlan>(
    store.listAgentManagementPlans().map((plan) => [plan.id, plan]),
  );
  const isArtifactDependentWorkIntake = (method: string, url: string, body?: unknown): boolean => {
    if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return false;
    const pathname = url.split("?", 1)[0]!;
    if (method === "DELETE") return /^\/api\/triggers\/[^/]+$/u.test(pathname);
    if (pathname === "/api/agent-management") {
      if (method !== "POST" || !body || typeof body !== "object" || Array.isArray(body)) return false;
      const input = body as { action?: unknown; operations?: unknown; planId?: unknown };
      if (input.action === "plan") {
        return Array.isArray(input.operations) && input.operations.some((operation) =>
          operation && typeof operation === "object" && !Array.isArray(operation) &&
          (operation as { kind?: unknown }).kind === "create_agent");
      }
      if (input.action === "apply" && typeof input.planId === "string") {
        return Boolean(managementPlans.get(input.planId.trim())?.operations.some((operation) => operation.kind === "create_agent"));
      }
      return false;
    }
    // Draft attachments remain ephemeral editor state. They do not enter the
    // Agent asset authority or scheduling state until a separately fenced send.
    return pathname === "/api/agent-messages" || pathname === "/api/agent-coordinate" ||
      pathname === "/api/agent-request-updates" || pathname === "/api/agent-spawn" ||
      /^\/api\/agents\/[^/]+\/(?:messages|attachments)$/u.test(pathname) ||
      /^\/api\/conversations\/[^/]+\/(?:messages|direct-messages|collaboration\/messages)$/u.test(pathname) ||
      /^\/api\/requests\/[^/]+\/retry$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/agents$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/import-agents$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/(?:import-agent-package|copy-agent|agent-import-operations)$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/message-deliveries\/[^/]+\/(?:retry|cancel)$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/triggers$/u.test(pathname) ||
      /^\/api\/triggers\/[^/]+(?:\/(?:rotate-secret|allow-runs))?$/u.test(pathname) ||
      /^\/api\/trigger-webhooks\/[^/]+$/u.test(pathname) ||
      /^\/api\/decisions\/[^/]+\/respond$/u.test(pathname);
  };
  const publicManagementOperations = (operations: ManagementOperation[]): ManagementOperation[] => operations.map((operation) => {
    const providerOperation = { ...operation };
    delete providerOperation.targetRunId;
    return providerOperation;
  });
  const {
    closeLinkPreviewPair,
    closeLinkPreviewRegistration,
    closeLinkPreviewsForAgent,
    linkPreviewCloseGraceMs,
    linkPreviewHeartbeatMs,
    linkPreviewMaxConnectionLifetimeMs,
    linkPreviewMaxIdleMs,
    linkPreviewOwned,
    linkPreviews,
    linkPreviewUpgrade,
    linkPreviewWss,
    registerRoutes: registerLinkPreviewRoutes,
  } = createLinkPreviewService({
    options: opts.linkPreviewScheduling,
    store,
    activeRuns,
    ownsActiveRun: (agentId, run) => ownsActiveRun(agentId, run),
  });
  const runtimeAuthorities = new Map<string, AgentRuntimeAuthority>();
  const runtimeAuthority = (agentId: string, create = false): AgentRuntimeAuthority | undefined => {
    const existing = runtimeAuthorities.get(agentId);
    if (existing || !create) return existing;
    const created: AgentRuntimeAuthority = { oneShots: new Map(), retryAttempt: 0 };
    runtimeAuthorities.set(agentId, created);
    return created;
  };
  const pruneRuntimeAuthority = (agentId: string, authority: AgentRuntimeAuthority): void => {
    if (!authority.opening && !authority.reusable && !authority.closing && authority.oneShots.size === 0 && !authority.retryTimer &&
        !authority.retryInProgress &&
        runtimeAuthorities.get(agentId) === authority) {
      runtimeAuthorities.delete(agentId);
    }
  };
  const reusableRuntime = (agentId: string): PersistentRuntime | undefined => runtimeAuthority(agentId)?.reusable;
  const openingRuntime = (agentId: string): OpeningPersistentRuntime | undefined => runtimeAuthority(agentId)?.opening;
  const closingRuntime = (agentId: string): PersistentRuntimeTeardown | undefined => runtimeAuthority(agentId)?.closing;
  const oneShotRuntime = (agentId: string, runId: string): OneShotRuntimeTeardown | undefined =>
    runtimeAuthority(agentId)?.oneShots.get(runId);
  const organizationEnvelopeStates = new Map<string, { sessionId: string; hash: string }>();
  const engineAuthStatuses = new EngineAuthStatusCache();
  const engineAvailability = new EngineAvailabilityStore(opts.dataDir);
  const providerUsage = new ProviderUsageCache(opts.dataDir, undefined, undefined, (handle, providerId) => {
    providerProcessAuthority.register(handle, { purpose: `${providerId} provider usage` });
  }, (event) => {
    app.log.warn(event, "provider usage retrieval failed");
  });
  const providerEnabled = (engineId: string): boolean => workspace.getPreferences().providerAvailability[engineId] !== false;
  const {
    agentWorkProjection,
    createOperationalNotification,
    reconcileCommunicationFailureNotifications,
    reconcileContextRolloverFormatNotifications,
    reconcileCoordinationAttentionNotifications,
    reconcileProjectDeletionOperationalNotifications,
    reconcileProjectWorkspace,
    reconcileTriggerOperationalNotifications,
    resolveOperationalNotification,
  } = createOperationalNotifications({
    store,
    coordinationV3,
    workspace,
    publishWorkspaceSince,
  });
  for (const engineId of engines.keys()) {
    const denial = engineAvailability.denial(engineId);
    if (denial && providerEnabled(engineId)) createOperationalNotification({
      dedupeKey: `provider:${engineId}:unavailable`,
      category: "provider",
      severity: "attention",
      title: `${engines.get(engineId)?.adapter.displayName ?? engineId} is unavailable`,
      body: providerUnavailableNotificationBody(denial.detail, denial.failureCategory),
      action: { kind: "open_settings", targetId: engineId },
    });
    if (!providerEnabled(engineId)) resolveOperationalNotification(`provider:${engineId}:unavailable`);
  }
  const deletingProjectIds = new Set(store.listPendingProjectDeletions().map((entry) => entry.projectId));
  const deletingAgentIds = new Set<string>([...deletingProjectIds].flatMap((projectId) =>
    store.listAgents(projectId, { includePendingCreation: true }).map((agent) => agent.id)));
  for (const operation of store.listRecoverableAgentCreationOperations()) {
    for (const agentId of operation.agentIds) deletingAgentIds.add(agentId);
  }
  const deletingConversationIds = new Set<string>();
  const agentCreationConversationLeases = new Map<string, number>();
  const conversationDeliveryLeases = new Map<string, number>();
  const agentDeliveryLeases = new Map<string, number>();
  const deletingAttachmentKeys = new Set<string>();
  const reconcilingAssetAgentIds = new Set<string>();
  const contextCursors = new ContextCursorStore(opts.dataDir);
  const {
    browserScopeForRun,
    browserProfiles,
    browserSessions,
    closeAgentBrowsers,
    closeRunBrowser,
    projectBrowserDto,
    projectBrowserGrants,
    projectBrowserScope,
    projectBrowserSessions,
  } = createBrowserAuthority({
    dataDir: opts.dataDir,
    store,
    activeRuns,
    publish: (agentId, stored) => publish(agentId, stored),
    logWarn: (meta, message) => app.log.warn(meta, message),
    persistRuntimeEvent: (agentId, run, event) => persistRuntimeEvent(agentId, run, event as LogEvent),
    providerProcessAuthority,
    browserAdmissionAllowed: (scope) =>
      !deletingProjectIds.has(scope.projectId) &&
      !deletingAgentIds.has(scope.agentId) &&
      !(scope.actorAgentId && deletingAgentIds.has(scope.actorAgentId)),
  });
  const managedWorkspacesRoot = path.resolve(opts.dataDir, "workspaces");
  const projectFolderPathBoundary = createProjectFolderPathBoundary({
    managedWorkspacesRoot,
    allowedBrowseRoots: opts.allowedBrowseRoots,
  });
  const drafts = new DraftService(opts.dataDir, store, workspace);
  const draftAttachmentSurfaceDir = (draftId: string) => drafts.surfaceDir(draftId);
  const agentMessageCapabilities = new Map<string, AgentMessageCapability>();
  // An agent can request rollover while its capability is live. The reset is
  // applied only after the turn ends, so it never destroys an in-flight session.
  const scheduledSessionRollovers = new Map<string, string>();
  // Crossing a context threshold at the end of one Run schedules a handoff
  // instruction for the next Run that continues the same provider session.
  const contextRolloverPending = new Map<string, {
    sessionId: string;
    usedTokens: number;
    at: string;
  }>();
  const clearAgentResumeSession = (
    agentId: string,
    reason: Parameters<typeof store.clearResumeSession>[1],
  ): boolean => {
    contextRolloverPending.delete(agentId);
    if (!activeRuns.has(agentId)) {
      cleanupAgentRuntimeAttachments(opts.dataDir, agentId);
    }
    return store.clearResumeSession(agentId, reason);
  };
  // Capability used only by this server's queue dispatcher. It prevents a client
  // from attaching arbitrary collaboration history to a direct agent request.
  // Prevent an internal dequeue from being appended to the tail if another
  // request claims the agent in the tiny dispatch race window.
  // Capability used by Project chat to invoke the same active-run send path as
  // Agent chat without allowing clients to forge canonical communication IDs.
  const v3DispatchKey = randomUUID();
  const subscribers = new Map<string, Set<Subscriber>>();
  const rejectQuarantinedTriggerMutation = (
    target: { projectId: string; agentId: string },
    reply: FastifyReply,
  ): boolean => {
    if (!deletingProjectIds.has(target.projectId) && !deletingAgentIds.has(target.agentId)) return false;
    void reply.code(409).send({ error: "Automation Project or execution Agent deletion is in progress" });
    return true;
  };
  // A crashed daemon may leave scheduler Runs or Activations behind. Reapply
  // the durable Project deletion fence before scheduler leasing starts.
  for (const projectId of deletingProjectIds) coordinationV3.prepareProjectDeletion(projectId);
  const projectDeletionInFlightIds = new Set<string>();
  let closed = false;
  const {
    communicationReconciliation,
    dirtyCommunicationProjects,
    generateConversationTitle,
    recordCommunication,
    refreshCommunicationReconciliation,
    scheduleCommunicationReconciliation,
    stopCommunicationReconciliation,
  } = createCommunicationJournal({
    store,
    workspace,
    webPushConfigured,
    webPushDelivery,
    publishWorkspaceSince,
    appendWorkspace,
    isClosed: () => closed,
  });
  const executionLeaseMs = 6 * 60 * 1000;
  const executionHeartbeatMs = Math.max(1, Math.floor(executionLeaseMs / 3));
  // Once provider execution is claimed, its scheduler fence must remain valid
  // for at least the host execution lease. A shorter dispatch lease is useful
  // before acceptance but must never expire healthy provider work.
  const coordinationV3LeaseMs = Math.max(opts.communicationV3?.leaseMs ?? executionLeaseMs, executionLeaseMs);
  const executionLeaseNow = Date.now;
  const setExecutionLeaseTimer = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs);
  const clearExecutionLeaseTimer = clearTimeout;
  const leaseExpiry = () => new Date(executionLeaseNow() + executionLeaseMs).toISOString();
  const runtimeStallAfterMs = 30_000;
  const runtimeIdleTtlMs = 90_000;
  const configuredMaxIdleSessions = Number.parseInt(process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS ?? "", 10);
  const requestedMaxIdleSessions = configuredMaxIdleSessions;
  const runtimeMaxIdleSessions = Number.isInteger(requestedMaxIdleSessions) && requestedMaxIdleSessions >= 0
    ? requestedMaxIdleSessions
    : 0;
  const runtimeSessionNow = Date.now;
  const setRuntimeIdleTimer = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs);
  const clearRuntimeIdleTimer = clearTimeout;
  const runtimeAuthorityRetryBaseMs = 500;
  const runtimeAuthorityRetryMaxMs = 30_000;
  const runtimeAuthorityRetryRandom = Math.random;
  const setRuntimeAuthorityRetryTimer = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs);
  const clearRuntimeAuthorityRetryTimer = clearTimeout;

  const {
    cancelRuntimeIdleClose,
    capabilityMatchesCleanupRun,
    capabilityOwnsAuthoritativeRun,
    detachPersistentRuntime,
    drainProviderRuntimeAuthority,
    ownsActiveRun,
    ownsActiveRunForAuditDrain,
    pendingRuntimeAuthorityCount,
    persistentRootExited,
    persistentRuntimeForTermination,
    reconcileAgentRuntimeAuthority,
    retireCompletedContextRolloverSession,
    runAuthorization,
    scheduleRuntimeIdleClose,
    teardownOneShotRuntime,
    teardownOpeningRuntime,
    teardownPersistentRuntime,
    teardownPersistentRuntimeInBackground,
  } = createRuntimeAuthority({
    runtimeAuthorities,
    activeRuns,
    agentMessageCapabilities,
    organizationEnvelopeStates,
    scheduledSessionRollovers,
    store,
    coordinationV3,
    coordinationV3WorkerId,
    runtimeAuthorityRetryBaseMs,
    runtimeAuthorityRetryMaxMs,
    runtimeAuthorityRetryRandom,
    runtimeIdleTtlMs,
    runtimeMaxIdleSessions,
    runtimeSessionNow,
    setRuntimeIdleTimer,
    clearRuntimeIdleTimer,
    setRuntimeAuthorityRetryTimer,
    clearRuntimeAuthorityRetryTimer,
    runtimeAuthority,
    pruneRuntimeAuthority,
    reusableRuntime,
    openingRuntime,
    closingRuntime,
    clearAgentResumeSession,
    closeRunBrowser,
    closeLinkPreviewsForAgent,
    publish: (agentId, stored) => publish(agentId, stored),
    publishMessageDeliveryChanged: (agentId) => publishMessageDeliveryChanged(agentId),
    createOperationalNotification,
    resolveOperationalNotification,
    notifyScheduler: () => coordinationV3Scheduler?.notify(),
    isClosed: () => closed,
    logError: (meta, message) => app.log.error(meta, message),
    transitionRun: (agentId, run, state) => transitionRun(agentId, run, state),
    clearRunLeaseTimer: (run) => clearRunLeaseTimer(run),
    clearRunLivenessTimer: (run) => clearRunLivenessTimer(run),
  });

  const {
    claimActiveRun,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    persistRuntimeEvent,
    receiveRuntimeEvent,
    releaseActiveRun,
    renewExecutionLease,
    scheduleRuntimeLivenessHeartbeat,
    transitionRun,
  } = createRuntimeEventAuthority({
    opts,
    activeRuns,
    store,
    coordinationV3,
    coordinationV3WorkerId,
    assets,
    executionLeaseNow,
    executionHeartbeatMs,
    executionLeaseMs,
    setExecutionLeaseTimer,
    clearExecutionLeaseTimer,
    leaseExpiry,
    ownsActiveRunForAuditDrain,
    closeRunBrowser,
    closeLinkPreviewsForAgent,
    publish: (agentId, stored) => publish(agentId, stored),
    publishMessageDeliveryChanged: (agentId) => publishMessageDeliveryChanged(agentId),
    notifyManagerOfChildFailure: (agentId, executionId, failure) =>
      notifyManagerOfChildFailure(agentId, executionId, failure),
    notifyScheduler: () => coordinationV3Scheduler?.notify(),
    isClosed: () => closed,
    logWarn: (meta, message) => app.log.warn(meta, message),
    drainDeploymentIdleAuthorities,
    agentMessageCapabilities,
    scheduledSessionRollovers,
    persistentRuntimeForTermination,
    teardownPersistentRuntimeInBackground,
    coordinationV3LeaseMs,
  });

  const {
    agentDetail,
    agentHealth,
    agentMessages,
    canonicalConversationContext,
    collaborationViewDetail,
    conversationDetail,
    ensureDecisionResponseActivation,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    teamDirectory,
  } = createServerReadModels({
    store,
    coordinationV3,
    workspace,
    managementPlans,
    activeRuns,
    scheduledSessionRollovers,
    runtimeStallAfterMs,
    reusableRuntime,
    transitionRun,
    appendWorkspace,
    publish: (agentId, stored) => publish(agentId, stored),
    reconcileCommunicationNotifications: reconcileCommunicationFailureNotifications,
    reconcileCoordinationAttentionNotifications,
    isClosed: () => closed,
  });

  const app = Fastify({
    bodyLimit: ASSET_LIMITS.maxRequestBytes,
    // Startup recovery intentionally completes before the listener accepts work.
    // Large durable datasets can require several minutes to reconcile, so
    // keep the boundary bounded without forcing a restart loop.
    pluginTimeout: 10 * 60_000,
    logger: opts.logger === false ? false : {
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-ponderosa-prompt-access"],
        censor: "[REDACTED]",
      },
    },
  }) as unknown as PonderosaServer;
  app.setErrorHandler((error, request, reply) => {
    if (!(error instanceof ProviderAdapterBoundaryError)) throw error;
    request.log.error({
      providerError: restrictedProviderExceptionLogDetail(error),
      engineId: error.engineId,
      operation: error.operation,
    }, "provider adapter operation failed at public boundary");
    return reply.code(503).send(error.publicResponse);
  });
  app.log.info(store.startupProfile(), "agent store startup completed");
  // Repair operational projections before the listener accepts reads. Further
  // reconciliation is driven by canonical coordination/delivery mutations.
  reconcileCommunicationFailureNotifications();
  reconcileContextRolloverFormatNotifications();
  reconcileCoordinationAttentionNotifications();
  const limits = { ...ASSET_LIMITS, maxAttachmentsPerMessage: ASSET_LIMITS.maxAssetsPerMessage };
  const serverContext: ServerContext = { opts, limits, agentDetail, store, tokenUsage };
  const {
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
  } = createEngineControlPlane({
    engines,
    store,
    workspace,
    engineAuthStatuses,
    engineAvailability,
    providerUsage,
    providerEnabled,
    reusableRuntime,
    activeRuns,
    appendWorkspace,
    applyOperatorModelOptions,
    publishWorkspaceSince,
    app,
    deletingProjectIds,
    isClosed: () => closed,
    providerProcessAuthority,
  });
app.server.on("upgrade", linkPreviewUpgrade);
  const workingCopies = new AgentWorkingCopyService(opts.dataDir, store);
  const {
    cancelAgentDecisions,
    awaitProjectDeletionBarrier,
    terminateRuntimeHandle,
    processAgentDeletionCleanup,
    commitAgentDeletion,
  } = createAgentDeletionAuthority({
    opts,
    store,
    coordinationV3,
    workspace,
    runtimeElicitations,
    activeRuns,
    subscribers,
    scheduledSessionRollovers,
    contextRolloverPending,
    deletingAgentIds,
    agentDeliveryLeases,
    agentAttachmentDeletionInProgress: agentId => [...deletingAttachmentKeys]
      .some((key) => key.startsWith(`${agentId}\0`)),
    reconcilingAssetAgentIds,
    contextCursors,
    appendWorkspace,
    publishWorkspaceSince,
    closeLinkPreviewsForAgent,
    detachPersistentRuntime,
    teardownPersistentRuntime,
    drainProviderRuntimeAuthority,
    drainEngineCapabilityDiscoveries,
    draftAttachmentSurfaceDir,
    refreshTriggerSources: () => triggerSources.refresh(),
    notifyScheduler: () => coordinationV3Scheduler.notify(),
    createOperationalNotification,
    resolveOperationalNotification,
    providerProcessAuthority,
    browserProfiles,
    closeAgentBrowsers,
    workingCopies,
  });
  const coordinationV3Scheduler = createCoordinationScheduler(app, {
    opts,
    store,
    assets,
    coordinationV3,
    workspace,
    activeRuns,
    runtimeAuthorities,
    deletingAgentIds,
    engines,
    runtimeStatus,
    agentMessageCapabilities,
    scheduledSessionRollovers,
    coordinationV3WorkerId,
    coordinationV3LeaseMs,
    v3DispatchKey,
    appendWorkspace,
    closeLinkPreviewsForAgent,
    reconcileTriggerOperationalNotifications,
    terminateRuntimeHandle,
    closeRunBrowser,
    persistentRuntimeForTermination,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    renewExecutionLease,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    drainDeploymentIdleAuthorities,
    communicationArtifactAccess,
    projectCommunicationArtifact,
    providerProcessAuthority,
  });
  let deploymentControl!: ReturnType<typeof createDeploymentControl>;
  function drainDeploymentIdleAuthorities(): void {
    deploymentControl.drainIdleAuthorities();
  }
  deploymentControl = createDeploymentControl(app, {
    store,
    coordinationV3,
    activeRuns,
    runtimeAuthorities,
    liveSseClosures,
    projectBrowserGrants,
    browserSessions,
    projectBrowserSessions,
    providerUsage,
    setClosed: () => { closed = true; },
    pendingRuntimeAuthorityCount,
    teardownPersistentRuntimeInBackground,
  });
  const deploymentDrainSnapshot = deploymentControl.snapshot;
  const triggerSources = new TriggerSourceService({
    store,
    coordination: coordinationV3,
    dataDir: opts.dataDir,
    projectAvailable: (projectId) => !deletingProjectIds.has(projectId),
    sourceAvailable: () => artifactFilesystem.ok,
    notify: (triggerId) => {
      coordinationV3Scheduler.notify();
      if (!triggerId) return;
      const trigger = coordinationV3.getTriggerDefinition(triggerId);
      if (trigger) appendWorkspace({ type: "trigger_changed", projectId: trigger.projectId, agentId: trigger.targetAgentId, triggerId, action: "occurrence" });
    },
    onSourceFailure: ({ trigger, kind, error }) => {
      createOperationalNotification({
        dedupeKey: `trigger:${trigger.id}:${kind === "watcher" ? "watcher-failed" : "filesystem-persistence"}`,
        category: "trigger",
        severity: "attention",
        title: kind === "watcher" ? `${trigger.name} filesystem watcher stopped` : `${trigger.name} could not persist filesystem activity`,
        body: kind === "watcher"
          ? `The Automation was disabled after its Project watcher failed: ${error}`
          : `Filesystem activity remains durably pending when possible, but the latest watcher event could not be persisted: ${error}`,
        projectId: trigger.projectId,
        conversationId: trigger.conversationId,
        action: { kind: "open_agent", targetId: trigger.targetAgentId },
      });
    },
    onSourceRecovered: (triggerId, kind) => {
      resolveOperationalNotification(`trigger:${triggerId}:${kind === "watcher" ? "watcher-failed" : "filesystem-persistence"}`);
    },
    onBudgetReset: () => {
      reconcileTriggerOperationalNotifications();
      coordinationV3Scheduler.notify();
    },
  });
  const webhookRawBodies = registerBodyParsers(app);

  const {
    reconcileConversationRuntimeCommunicationProjections,
    reconcileRuntimeCommunicationProjections,
  } = createCommunicationProjectionReconciler({
    store,
    coordinationV3,
    assets,
    projectDeletionInProgress: projectId => deletingProjectIds.has(projectId),
    agentDeletionInProgress: agentId => deletingAgentIds.has(agentId),
    conversationDeletionInProgress: conversationId => deletingConversationIds.has(conversationId),
    attachmentDeletionInProgress: (agentId, attachmentId) =>
      deletingAttachmentKeys.has(`${agentId}\0${attachmentId}`),
    assetReconciliationInProgress: agentId => reconcilingAssetAgentIds.has(agentId),
    conversationDeliveryLeases,
    agentDeliveryLeases,
    recordCommunication,
    projectCommunicationArtifact,
    communicationArtifactAccess,
    scheduleCommunicationReconciliation,
    logError: (meta, message) => app.log.error(meta, message),
    logInfo: (meta, message) => app.log.info(meta, message),
    projectCommunicationToAgentAudit: (agentId, event, renderedText, attachments) =>
      projectCommunicationToAgentAudit(agentId, event, renderedText, attachments),
  });

  registerRequestSecurityHooks(app, {
    opts,
    v3DispatchKey,
    agentMessageCapabilities,
    deletingAgentIds,
    validLauncherSession,
    artifactFilesystemError,
    isArtifactDependentWorkIntake,
    isPublicWebAssetRequest: (method, url) =>
      publicWebAssetRequest(method, url, publicWebAssets),
  });

  registerServerLifecycle(app, {
    opts,
    store,
    assets,
    coordinationV3,
    workspace,
    reconcileCommittedProjectDeletions,
    artifactFilesystem,
    processContainment,
    coordinationV3WorkerId,
    activeRuns,
    runtimeAuthorities,
    agentMessageCapabilities,
    agentDeliveryLeases,
    deletingAgentIds,
    attachmentDeletionInProgress: agentId => [...deletingAttachmentKeys]
      .some((key) => key.startsWith(`${agentId}\0`)),
    reconcilingAssetAgentIds,
    projectBrowserGrants,
    browserSessions,
    projectBrowserSessions,
    providerUsage,
    webPushDelivery,
    coordinationV3Scheduler,
    triggerSources,
    processAgentDeletionCleanup,
    reconcileRuntimeCommunicationProjections,
    retireCompletedContextRolloverSession,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    isClosed: () => closed,
    setClosed: () => { closed = true; },
    projectCommunicationArtifact,
    requestArtifactAccess,
    drainEngineCapabilityDiscoveries,
    drainEngineModelCatalogDiscoveries,
    engineCapabilityDiscoveries,
    engineCapabilityDiscoveryAuthorities,
    engineModelCatalogDiscoveries,
    engineModelCatalogDiscoveryAuthorities,
    closeLinkPreviewPair,
    closeLinkPreviewRegistration,
    linkPreviewCloseGraceMs,
    linkPreviewHeartbeatMs,
    linkPreviewMaxConnectionLifetimeMs,
    linkPreviewMaxIdleMs,
    linkPreviewOwned,
    linkPreviews,
    linkPreviewUpgrade,
    linkPreviewWss,
    createOperationalNotification,
    reconcileProjectDeletionOperationalNotifications,
    reconcileTriggerOperationalNotifications,
    resolveOperationalNotification,
    drainProviderRuntimeAuthority,
    ensureDecisionResponseActivation,
    refreshCommunicationReconciliation,
    stopCommunicationReconciliation,
    closeRunBrowser,
    providerProcessAuthority,
  });

  const {
    notifyManagerOfChildFailure,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    publish,
    subscribe,
    agentCanReadRuntimeArtifact,
    authoritativeCommunicationDocument,
    managedProjectArtifactAgreesWithRuntime,
  } = registerAgentSurface(app, {
    opts,
    store,
    coordinationV3,
    subscribers,
    recordCommunication,
    collaborationViewDetail,
    refreshProviderUsageAfterRun,
    appendWorkspace,
    publishCoordinationV3Changed,
    workspace,
    agentMessageCapabilities,
    activeRuns,
    capabilityOwnsAuthoritativeRun,
    publishWorkspaceSince,
    engines,
    managementPlans,
    deletingAgentIds,
    deletingProjectIds,
    deletingConversationIds,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    cachedModelOptions,
    publicManagementOperations,
    commitAgentDeletion,
    assets,
    browserSessions,
    projectBrowserSessions,
    projectBrowserGrants,
    projectBrowserScope,
    teamDirectory,
    runAuthorization,
    capabilityMatchesCleanupRun,
    projectCommunicationArtifact,
    requestArtifactAccess,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
    communicationArtifactAccess,
    reconcileRuntimeCommunicationProjections,
    resolveOperationalNotification,
    notifyScheduler: () => coordinationV3Scheduler.notify(),
    isClosed: () => closed,
  });

  registerServerControlRoutes(app, {
    opts,
    serverContext,
    store,
    coordinationV3,
    engines,
    activeRuns,
    launcherNow,
    launcherRandomToken,
    launcherBootstrapTtlMs,
    launcherSessionTtlMs,
    launcherBootstraps,
    launcherSessions,
    purgeLauncherSecurityState,
    networkSecurity,
    artifactFilesystem,
    processContainment,
    artifactFilesystemError,
    communicationReconciliation,
    coordinationV3Scheduler,
    isClosed: () => closed,
    setDeploymentDraining: deploymentControl.setDraining,
    deploymentDrainSnapshot,
    drainDeploymentIdleAuthorities,
    refreshTriggerSources: () => triggerSources.refresh(),
    runtimeStatus,
  });

  registerApplicationRoutes(app, {
    opts,
    store,
    assets,
    coordinationV3,
    communicationArtifactAccess,
    prepareUserCommunicationText,
    projectCommunicationArtifact,
    runtimeArtifactMetadata,
    coordinationV3WorkerId,
    workspace,
    runtimeElicitations,
    providerProcessAuthority,
    workspaceSubscribers,
    liveSseClosures,
    appendWorkspace,
    reconcileCommittedProjectDeletion,
    publishWorkspaceSince,
    vapid,
    webPushConfiguration,
    webPushConfigurationDetail,
    webPushConfigured,
    engines,
    applyOperatorModelOptions,
    activeRuns,
    closeLinkPreviewsForAgent,
    registerLinkPreviewRoutes,
    runtimeAuthorities,
    runtimeAuthority,
    pruneRuntimeAuthority,
    reusableRuntime,
    openingRuntime,
    closingRuntime,
    oneShotRuntime,
    organizationEnvelopeStates,
    engineAuthStatuses,
    engineAvailability,
    providerEnabled,
    agentWorkProjection,
    createOperationalNotification,
    reconcileProjectWorkspace,
    reconcileTriggerOperationalNotifications,
    resolveOperationalNotification,
    cancelAgentDecisions,
    awaitProjectDeletionBarrier,
    commitAgentDeletion,
    contextCursors,
    browserScopeForRun,
    browserProfiles,
    browserSessions,
    closeRunBrowser,
    projectBrowserDto,
    projectBrowserGrants,
    projectBrowserScope,
    projectBrowserSessions,
    managedWorkspacesRoot,
    projectFolderPathBoundary,
    drafts,
    draftAttachmentSurfaceDir,
    agentMessageCapabilities,
    scheduledSessionRollovers,
    contextRolloverPending,
    clearAgentResumeSession,
    v3DispatchKey,
    subscribers,
    deletingProjectIds,
    deletingAgentIds,
    deletingConversationIds,
    agentCreationConversationLeases,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    deletingAttachmentKeys,
    reconcilingAssetAgentIds,
    agentAttachmentDeletionInProgress: agentId => [...deletingAttachmentKeys]
      .some((key) => key.startsWith(`${agentId}\0`)),
    rejectQuarantinedTriggerMutation,
    projectDeletionInFlightIds,
    communicationReconciliation,
    dirtyCommunicationProjects,
    generateConversationTitle,
    recordCommunication,
    refreshCommunicationReconciliation,
    leaseExpiry,
    cancelRuntimeIdleClose,
    capabilityOwnsAuthoritativeRun,
    drainProviderRuntimeAuthority,
    ownsActiveRun,
    ownsActiveRunForAuditDrain,
    persistentRootExited,
    persistentRuntimeForTermination,
    reconcileAgentRuntimeAuthority,
    retireCompletedContextRolloverSession,
    scheduleRuntimeIdleClose,
    teardownOneShotRuntime,
    teardownOpeningRuntime,
    teardownPersistentRuntime,
    teardownPersistentRuntimeInBackground,
    claimActiveRun,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    persistRuntimeEvent,
    receiveRuntimeEvent,
    releaseActiveRun,
    renewExecutionLease,
    scheduleRuntimeLivenessHeartbeat,
    agentHealth,
    agentMessages,
    canonicalConversationContext,
    collaborationViewDetail,
    conversationDetail,
    ensureDecisionResponseActivation,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    teamDirectory,
    serverContext,
    cachedModelOptions,
    closeCapabilityDiscoveryAuthority,
    closeCapabilityDiscoveryProcess,
    discoverEngineCapabilities,
    discoverEngineModelCatalog,
    drainEngineCapabilityDiscoveries,
    drainEngineModelCatalogDiscoveries,
    engineCapabilityDiscoveryAuthorities,
    engineDto,
    engineModelCatalogCache,
    engineModelCatalogDiscoveryAuthorities,
    invalidateEngineCapabilities,
    markEngineModelUnavailable,
    providerUsageCenter,
    providerUsageState,
    readEngineCapabilities,
    refreshProviderUsageAfterRun,
    reportRuntimeCapabilitiesChanged,
    validateEngineModel,
    triggerSources,
    webhookRawBodies,
    reconcileConversationRuntimeCommunicationProjections,
    reconcileRuntimeCommunicationProjections,
    notifyManagerOfChildFailure,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    publish,
    subscribe,
    agentCanReadRuntimeArtifact,
    authoritativeCommunicationDocument,
    managedProjectArtifactAgreesWithRuntime,
    drainDeploymentIdleAuthorities,
    isClosed: () => closed,
    isDeploymentDraining: deploymentControl.isDraining,
    notifyScheduler: () => coordinationV3Scheduler.notify(),
    setMaxConcurrentRuns: (value) => coordinationV3Scheduler.setMaxConcurrentRuns(value),
    workingCopies,
  });

  return app;
}
