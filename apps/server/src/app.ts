import { chatBrowserOwnerId, browserOwnerId } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store, ProjectDeletionInProgressError, WorkspaceStore, type LogEvent } from "@ponderosa/agents";
import { windowsJobObjectsSupported } from "@ponderosa/native-host";
import type {
  DecisionDto,
  RuntimeProcessHandle,
  TokenUsageRangeDto,
  TokenUsageSummaryDto,
  WorkspaceEventEnvelope
} from "@ponderosa/core";
import Fastify from "fastify";
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
import { ResourceAdmission } from "./resource-admission.js";
import { providerProcessHandleFacade } from "./provider-session-facade.js";
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
import { LauncherRecordAuthority } from "./launcher-record-authority.js";
import { createConversationDeletionAuthority } from "./conversation-deletion-authority.js";
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
import { createWebPushConfiguration } from "./web-push-configuration.js";
import { ServerMetrics } from "./server-metrics.js";
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
  boundedSeedHistory
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
  const store = opts.store ?? new AgentStore(opts.dataDir);
  const startupDisposers: Array<() => void> = opts.store ? [] : [() => store.abortStartup()];
  try {
  AgentStore.assertCurrent(store);
  const admission = store.stateAdmission();
  try {
    admission.assertRoot(opts.dataDir);
    if (opts.launcherRecords) LauncherRecordAuthority.assertCurrent(opts.launcherRecords, admission);
    opts = { ...opts, reportedDataDir: opts.reportedDataDir ?? opts.dataDir, dataDir: admission.dataDir };
  } finally { admission.close(); }
  cleanupAllRuntimeAttachments(opts.dataDir);
  const {
    networkSecurity,
    launcherNow,
    launcherRandomToken,
    launcherBootstrapTtlMs,
    launcherSessionTtlMs,
    launcherBootstraps,
    issueLauncherSession,
    purgeLauncherSecurityState,
    validLauncherSession,
  } = createLauncherSecurity(opts, store.sqlite);
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
  startupDisposers.push(() => assets.close());
  const workspace = new WorkspaceStore(opts.dataDir);
  startupDisposers.push(() => workspace.close());
  store.configureCommunicationAttachmentMetadataAuthority((projectId, artifact) =>
    assets.managedProjectArtifactMetadataIsAuthoritative(projectId, artifact));
  const coordinationV3 = new CoordinationV3Store(store.sqlite, {
    canonicalTaskDecisions: runIds => workspace.decisionsForRuns(runIds),
    attachmentAuthority: {
      resolve: (projectId, agentId, attachmentId) =>
        assets.authoritativeRuntimeAttachment(projectId, agentId, attachmentId),
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
  const engines = new Map(opts.engines.map((engine) => {
    const diagnostic = <T>(kind: string, probe: (options?: import("@ponderosa/core").EngineProbeOptions) => Promise<T>) => async (): Promise<T> => {
      const purpose = `${engine.adapter.id} ${kind} diagnostic`;
      await providerProcessAuthority.terminatePurpose(purpose);
      return probe({ onRuntimeSpawned: (raw: RuntimeProcessHandle) => {
        providerProcessAuthority.register(providerProcessHandleFacade(raw), { purpose });
      } });
    };
    return [engine.adapter.id, { ...engine,
      ...(engine.authStatus ? { authStatus: diagnostic("authentication", options => engine.authStatus!(options)) } : {}),
      ...(engine.availabilityProbe ? { availabilityProbe: diagnostic("availability", options => engine.availabilityProbe!(options)) } : {}),
    }];
  }));
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
    scope: { type: "overall" } | { type: "project" | "agent" | "conversation"; id: string },
    range: TokenUsageRangeDto = {},
  ): TokenUsageSummaryDto => store.getTokenUsage(scope, range);
  const activeRuns = new Map<string, ActiveRun>();
  const managementPlans = new Map<string, ManagementPlan>(
    store.listAgentManagementPlans().map((plan) => [plan.id, plan]),
  );
  const isArtifactDependentWorkIntake = (method: string, url: string, body?: unknown): boolean => {
    if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return false;
    const pathname = url.split("?", 1)[0]!;
    if (method === "DELETE") return false;
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
  const providerStatusChanged = (engineId?: string) => { appendWorkspace({ type: "provider_status_changed", ...(engineId ? { engineId } : {}) }); };
  const resourceAdmission = new ResourceAdmission(opts.resourceAdmission ?? {
    enabled: process.env.PONDEROSA_RESOURCE_ADMISSION !== "off",
    ...(process.env.PONDEROSA_RESOURCE_RESERVE_MIB ? { reserveBytes: Number(process.env.PONDEROSA_RESOURCE_RESERVE_MIB) * 1024 * 1024 } : {}),
    ...(process.env.PONDEROSA_RESOURCE_STARTUP_MIB ? { startupBytes: Number(process.env.PONDEROSA_RESOURCE_STARTUP_MIB) * 1024 * 1024 } : {}),
  }, opts.resourceAdmissionObservation?.sample, opts.resourceAdmissionObservation?.now,
  opts.resourceAdmissionObservation?.platform, () => providerStatusChanged());
  const engineAuthStatuses = new EngineAuthStatusCache(providerStatusChanged);
  const engineAvailability = new EngineAvailabilityStore(
    opts.dataDir,
    opts.buildRevision?.trim() || "development",
    providerStatusChanged,
  );
  // Usage helpers only query the provider account; they need an ordinary cwd,
  // not the opaque reference reserved for application-owned storage I/O.
  const providerUsage = new ProviderUsageCache(process.platform === "linux" ? opts.dataDir : process.cwd(), undefined, undefined, (handle, providerId) => {
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
  const deletingConversationIds = new Set(
    store.listPendingConversationDeletionReceipts().map((receipt) => receipt.conversationId),
  );
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
    closeRunBrowserAfterRun,
    projectBrowserDto,
    projectBrowserGrants,
    projectBrowserScope,
    projectBrowserSessions,
    restoreSharedBrowsers,
  } = createBrowserAuthority({
    dataDir: opts.dataDir,
    browserServiceSocket: opts.browserServiceSocket,
    store,
    activeRuns,
    publish: (agentId, stored) => publish(agentId, stored),
    logWarn: (meta, message) => app.log.warn(meta, message),
    persistRuntimeEvent: (agentId, run, event) => persistRuntimeEvent(agentId, run, event as LogEvent),
    providerProcessAuthority,
    browserAdmissionAllowed: (scope) => {
      if (!scope.owner || deletingProjectIds.has(scope.projectId) || deletingAgentIds.has(scope.agentId) ||
          (scope.conversationId && deletingConversationIds.has(scope.conversationId)) ||
          (scope.actorAgentId && deletingAgentIds.has(scope.actorAgentId))) return false;
      if (scope.owner.kind === "chat") {
        const chat = store.getConversation(scope.owner.conversationId);
        if (!chat || chat.deletedAt || chat.projectId !== scope.projectId || scope.conversationId !== chat.id) return false;
      }
      const shared = scope.agentId === browserOwnerId(scope.owner) || scope.agentId === "project-browser:saved-browser";
      const actorId = scope.actorAgentId ?? (!shared ? scope.agentId : undefined);
      if (!actorId) return true;
      const actor = store.getAgent(actorId), run = activeRuns.get(actorId);
      if (!actor || !run || run.runId !== (scope.actorRunId ?? scope.runId) || run.conversationId !== actor.conversationId || !ownsActiveRun(actorId, run)) return false;
      const actorChat = store.getConversation(actor.conversationId);
      if (!actorChat || actorChat.deletedAt || actorChat.projectId !== actor.projectId || deletingConversationIds.has(actorChat.id)) return false;
      if (scope.owner.kind === "chat" && actor.conversationId !== scope.owner.conversationId) return false;
      if (scope.owner.kind === "saved" && !browserProfiles.hasSavedBrowserAccess(actor.projectId, actor.id)) return false;
      if (shared) {
        const grant = projectBrowserGrants.get(browserOwnerId(scope.owner));
        if (!grant || grant.agentId !== actorId || grant.runId !== run.runId) return false;
      }
      return true;
    },
  });
  startupDisposers.push(() => browserProfiles.close());
  const applyResolvedSavedBrowserApproval = (decision: DecisionDto): boolean => {
    const scope = decision.approvalScope;
    if (scope?.kind !== "saved_browser" || decision.status !== "resolved" ||
        decision.response?.optionId !== "approve") return true;
    const agent = store.getAgent(scope.agentId);
    if (decision.projectId !== scope.projectId || decision.agentId !== scope.agentId ||
        !agent || agent.projectId !== scope.projectId ||
        deletingProjectIds.has(scope.projectId) || deletingAgentIds.has(scope.agentId) ||
        browserProfiles.savedBrowser()?.profileId !== scope.profileId) return false;
    return browserProfiles.applySavedBrowserApproval(decision.id, scope.profileId, scope.projectId, scope.agentId);
  };
  const managedWorkspacesRoot = path.resolve(opts.dataDir, "workspaces");
  const projectFolderPathBoundary = createProjectFolderPathBoundary({
    managedWorkspacesRoot,
    allowedBrowseRoots: opts.allowedBrowseRoots,
  });
  const drafts = new DraftService(opts.dataDir, store, workspace, assets);
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
    closeRunBrowser: closeRunBrowserAfterRun,
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
    onRunClaimed: (agentId, run) => {
      const agent = store.getAgent(agentId);
      if (agent) {
        projectBrowserSessions.bindNextRun(projectBrowserScope(chatBrowserOwnerId(agent.conversationId)), agentId, run.runId, run.conversationId);
        projectBrowserSessions.bindNextRun(projectBrowserScope("saved-browser"), agentId, run.runId, run.conversationId);
      }
    },
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
    closeRunBrowser: closeRunBrowserAfterRun,
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
    observeRuntimeStalls,
    agentMessages,
    canonicalConversationContext,
    collaborationViewDetail,
    conversationDetail,
    withMessagePresentation,
    ensureDecisionResponseActivation,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    teamDirectory,
  } = createServerReadModels({
    runtimeCleanupPending: (agentId) => {
      const authority = runtimeAuthority(agentId);
      return Boolean(authority?.closing || authority?.opening?.lastError ||
        [...(authority?.oneShots.values() ?? [])].some(state => state.operation || state.lastError));
    },
    admissionBlocker: (agent) => {
      const registration = engines.get(agent.activeEngine);
      return registration ? runtimeAdmissionBlocker(agent.activeEngine, registration) : { kind: "provider_unavailable", providerId: agent.activeEngine.slice(0, 128) };
    },
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
    // A bounded two-upload lane permits an 80 MiB phone upload without
    // weakening the ordinary JSON/text body limits.
    requestTimeout: 120_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    maxRequestsPerSocket: 1_000,
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
  const serverMetrics = new ServerMetrics(opts.dataDir, store.startupProfile());
  serverMetrics.install(app);
  app.addHook("onReady", restoreSharedBrowsers);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProjectDeletionInProgressError) {
      return reply.code(409).send({ error: error.message });
    }
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
    prepareEngineModels,
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
  } = createEngineControlPlane({
    resourceAdmission,
    engines,
    store,
    workspace,
    engineAuthStatuses,
    engineAvailability,
    providerUsage,
    providerEnabled,
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
    drafts,
    notifyScheduler: () => coordinationV3Scheduler.notify(),
    createOperationalNotification,
    resolveOperationalNotification,
    providerProcessAuthority,
    browserProfiles,
    closeAgentBrowsers,
    workingCopies,
    assets,
  });
  const coordinationV3Scheduler = createCoordinationScheduler(app, {
    resourceAdmission,
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
    terminateRuntimeHandle,
    closeRunBrowser: closeRunBrowserAfterRun,
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
    dataDir: opts.dataDir,
    startDrained: opts.startDrained,
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
  const drainAttachmentUploads = registerBodyParsers(app);

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
  const { processConversationDeletionCleanup } = createConversationDeletionAuthority({
    closeChatBrowsers: async conversationId => {
      await browserSessions.closeChat(conversationId, "chat_deleted", [projectBrowserSessions]);
      const key = chatBrowserOwnerId(conversationId);
      projectBrowserGrants.delete(key);
      browserProfiles.deleteChat(key);
    },
    assets,
    store,
    workspace,
    drafts,
    deletingConversationIds,
    agentCreationConversationLeases,
    conversationDeliveryLeases,
    reconcileConversationRuntimeCommunicationProjections,
    commitAgentDeletion,
    purgeCommunicationV4Conversation: conversationId =>
      coordinationV3.purgeCommunicationV4Conversation(conversationId),
    publishWorkspace,
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
    appendWorkspace,
    drainAttachmentUploads,
    opts,
    store,
    assets,
    drafts,
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
    browserProfiles,
    browserSessions,
    projectBrowserSessions,
    providerUsage,
    webPushDelivery,
    coordinationV3Scheduler,
    processAgentDeletionCleanup,
    processConversationDeletionCleanup,
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
    resolveOperationalNotification,
    drainProviderRuntimeAuthority,
    ensureDecisionResponseActivation,
    applyResolvedSavedBrowserApproval,
    refreshCommunicationReconciliation,
    stopCommunicationReconciliation,
    closeRunBrowser: closeRunBrowserAfterRun,
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
    providerEnabled,
    opts,
    store,
    coordinationV3,
    subscribers,
    recordCommunication,
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
    browserProfiles,
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
    issueLauncherSession,
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
    runtimeStatus,
    serverMetrics,
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
    resourceAdmissionHeld: async () => (await resourceAdmission.observe()).state === "held",
    agentWorkProjection,
    createOperationalNotification,
    reconcileProjectWorkspace,
    resolveOperationalNotification,
    cancelAgentDecisions,
    awaitProjectDeletionBarrier,
    commitAgentDeletion,
    processAgentDeletionCleanup,
    processConversationDeletionCleanup,
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
    observeRuntimeStalls,
    agentMessages,
    canonicalConversationContext,
    collaborationViewDetail,
    conversationDetail,
    withMessagePresentation,
    ensureDecisionResponseActivation,
    applyResolvedSavedBrowserApproval,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    teamDirectory,
    serverContext,
    cachedModelOptions,
    prepareEngineModels,
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
    serverMetrics,
  });

  return app;
  } catch (error) {
    const errors: unknown[] = [error];
    for (const dispose of startupDisposers.reverse()) {
      try { dispose(); } catch (disposeError) { errors.push(disposeError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "server construction failed; admission disposal was incomplete");
    throw error;
  }
}
