import { chatBrowserOwnerId } from "@ponderosa/core";
import { createReadStream, promises as fs } from "@ponderosa/native-host/fs";
import os from "node:os";
import path from "node:path";
import { createBrotliCompress, createGzip } from "node:zlib";
import type {
  DecisionDto,
  GlobalChatSearchResponseDto,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  BrowserSessionError,
  type BrowserScope,
} from "../browser-session-manager.js";
import { BrowserProfileError } from "../browser-profile-authority.js";
import { publicationOwnerIsCurrent } from "../file-publication.js";
import {
  type ActiveRun,
  type AgentMessageCapability,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_SSE_SUBSCRIBERS_PER_STREAM,
  type PonderosaServer,
} from "../app-contracts.js";
import {
  cacheControlForStatic,
  contentTypeForStatic,
} from "../static-content.js";
import {
  pathExists,
  safeRelativePath,
} from "../project-files.js";
import { runtimeSelectionError } from "../runtime-selection.js";
import { displayProjectPath } from "../project-path-display.js";
import type { ServerContext } from "../server-context.js";
import type { RuntimeElicitationBroker } from "../runtime-elicitation-broker.js";
import { registerAgentAuditRoutes } from "./agent-audit.js";
import { registerAgentCreationRoutes } from "./agent-creation.js";
import { registerAgentMaintenanceRoutes } from "./agent-maintenance.js";
import { registerAgentOrganizationRoutes } from "./agent-organization.js";
import { registerAgentMessageRunRoute } from "./agent-message-run.js";
import { registerAgentPackageRoutes } from "./agent-packages.js";
import { registerAgentPresetRoutes } from "./agent-presets.js";
import { applyCollectionPageHeaders, collectionGenerationKey, sendCollectionPageError, sqliteCollectionPage, type CollectionQuery } from "../collection-page.js";
import { registerAgentUsageRoute, registerUsageRoutes } from "./usage.js";
import { registerAgentWorkRoutes } from "./agent-work.js";
import { registerArtifactRoutes } from "./artifacts.js";
import { attachmentDeletionKey, registerAttachmentRoutes } from "./attachments.js";
import { registerBrowserRoutes } from "./browsers.js";
import { registerCollaborationRoutes } from "./collaboration.js";
import { registerCommunicationDocumentRoutes } from "./communication-documents.js";
import { registerConversationDeliveryRoutes } from "./conversation-deliveries.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerDraftRoutes } from "./drafts.js";
import { registerEngineRoutes } from "./engines.js";
import { registerAgentWorkspaceRoutes, registerFilesRoute } from "./workspace-files.js";
import { registerLimitsRoutes } from "./limits.js";
import {
  registerNotificationListRoute,
  registerNotificationMutationRoutes,
  registerPushRoutes,
} from "./notifications.js";
import { registerProjectDeletionRoutes } from "../project-deletion-coordinator.js";
import { ProjectFileAuthority, registerProjectFileRoutes } from "./project-files.js";
import { registerProjectRoutes } from "./projects.js";
import { registerProviderCommandRoutes } from "./provider-commands.js";
import { registerQueuedMessageRoutes } from "./queued-messages.js";
import { registerSearchRoutes } from "./search.js";
import { registerStreamRoutes } from "./streams.js";
import { registerWorkspaceDirectoryRoutes } from "./workspace-directory.js";
import { registerWorkspacePreferenceRoutes } from "./workspace-preferences.js";
import { pendingAgentQuarantine } from "./pending-agent-quarantine.js";

type ApplicationRoutesContext =
  Parameters<typeof registerProjectRoutes>[1] &
  Omit<Parameters<typeof registerProjectDeletionRoutes>[1], "logError"> &
  Omit<Parameters<typeof registerConversationRoutes>[1],
    "hasActiveRun" | "projectDeletionInProgress"> &
  Omit<Parameters<typeof registerConversationDeliveryRoutes>[1],
    "projectDeletionInProgress" | "agentDeletionInProgress" | "attachmentDeletionInProgress" |
    "assetReconciliationInProgress" | "assetMetadata"> &
  Omit<Parameters<typeof registerQueuedMessageRoutes>[1],
    "projectDeletionInProgress" | "conversationDeletionInProgress" |
    "agentDeletionInProgress" | "removeRuntimeArtifactReservation"> &
  Omit<Parameters<typeof registerCollaborationRoutes>[1],
    "projectDeletionInProgress" | "agentDeletionInProgress" | "attachmentDeletionInProgress" |
    "assetReconciliationInProgress" | "assetMetadata"> &
  Omit<Parameters<typeof registerAttachmentRoutes>[1], "agentDeletionInProgress" | "conversationDeletionInProgress"> &
  Omit<Parameters<typeof registerAgentCreationRoutes>[1], "dataDir"> &
  Omit<Parameters<typeof registerAgentPackageRoutes>[1], "dataDir" | "coordination"> &
  Omit<Parameters<typeof registerAgentMaintenanceRoutes>[1], "workingCopies"> &
  Omit<Parameters<typeof registerAgentMessageRunRoute>[1],
    "attachmentDeletionInProgress" | "conversationDeletionInProgress" |
    "deploymentDraining" | "assetMetadata" |
    "assetReconciliationInProgress" | "workingCopies"> &
  Parameters<typeof registerWorkspacePreferenceRoutes>[1] &
  Parameters<typeof registerNotificationListRoute>[1] &
  Omit<Parameters<typeof registerPushRoutes>[1], "configuration"> &
  Omit<Parameters<typeof registerStreamRoutes>[1],
    "serverClosed" | "maxSubscribersPerStream" | "agentSubscriberCount"> &
  Omit<Parameters<typeof registerBrowserRoutes>[1],
    "projectExists" | "agentExists" | "projectDeletionInProgress" | "agentDeletionInProgress" | "operatorBrowserScope" | "browserOwnerForAgent" |
    "getProjectBrowserGrant" | "setProjectBrowserGrant" |
    "deleteProjectBrowserGrant" | "activeProjectBrowserController"> &
  Omit<Parameters<typeof registerProviderCommandRoutes>[1], "workingCopies"> &
  Omit<Parameters<typeof registerArtifactRoutes>[1],
    "dataDir" | "projectFileAuthority"> &
  Omit<Parameters<typeof registerEngineRoutes>[1],
    "authStatuses" | "availability" | "projectDeletionInProgress" |
    "discoverModelCatalog" | "validateModel" | "discoverCapabilities" |
    "readCapabilities"> & {
    serverContext: ServerContext;
    registerLinkPreviewRoutes(app: FastifyInstance): void;
    agentWorkProjection: Parameters<typeof registerAgentWorkRoutes>[1]["projection"];
    agentMessages: Parameters<typeof registerAgentPackageRoutes>[1]["agentMessages"];
    authoritativeCommunicationDocument: Parameters<typeof registerCommunicationDocumentRoutes>[1];
    projectCommunicationToAgentAudit: Parameters<typeof registerCollaborationRoutes>[1]["projectCommunicationToAgentAudit"];
    ensureDecisionResponseActivation(decision: DecisionDto): string | undefined;
    applyResolvedSavedBrowserApproval(decision: DecisionDto): boolean;
    vapid: {
      publicKey?: string;
      privateKey?: string;
      subject: string;
    };
    webPushConfiguration: "active" | "missing" | "invalid";
    webPushConfigurationDetail: string;
    webPushConfigured: boolean;
    engineAuthStatuses: Parameters<typeof registerEngineRoutes>[1]["authStatuses"];
    browserScopeForRun(agentId: string, run: ActiveRun): BrowserScope | undefined;
    capabilityOwnsAuthoritativeRun(
      capability: AgentMessageCapability,
      run: ActiveRun | undefined,
    ): boolean;
    readEngineCapabilities: Parameters<
      typeof registerEngineRoutes
    >[1]["readCapabilities"];
    validateEngineModel: Parameters<typeof registerEngineRoutes>[1]["validateModel"];
    drainDeploymentIdleAuthorities(): void;
    isClosed(): boolean;
    isDeploymentDraining(): boolean;
    notifyScheduler(): void;
    runtimeElicitations: RuntimeElicitationBroker;
    setMaxConcurrentRuns: Parameters<typeof registerWorkspacePreferenceRoutes>[1]["setMaxConcurrentRuns"];
  };

export function registerApplicationRoutes(
  app: PonderosaServer,
  context: ApplicationRoutesContext,
): void {
  const {
    opts,
    store,
    assets,
    coordinationV3,
    communicationArtifactAccess,
    prepareUserCommunicationText,
    projectCommunicationArtifact,
    runtimeArtifactMetadata,
    coordinationV3WorkerId,
    providerProcessAuthority,
    workspace,
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
    resourceAdmissionHeld,
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
    agentAttachmentDeletionInProgress,
    projectDeletionInFlightIds,
    communicationReconciliation,
    dirtyCommunicationProjects,
    generateConversationTitle,
    recordCommunication,
    refreshCommunicationReconciliation,
    leaseExpiry,
    cancelRuntimeIdleClose,
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
    runtimeElicitations,
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
    reconcileRuntimeCommunicationProjections,
    notifyManagerOfChildFailure,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    publish,
    subscribe,
    agentCanReadRuntimeArtifact,
    authoritativeCommunicationDocument,
    managedProjectArtifactAgreesWithRuntime,
    isClosed,
    isDeploymentDraining,
    notifyScheduler,
    setMaxConcurrentRuns,
    drainDeploymentIdleAuthorities,
    workingCopies,
    serverMetrics,
  } = context;

app.addHook("preHandler", pendingAgentQuarantine(store));
registerLinkPreviewRoutes(app);

const managedProjectFolders = registerProjectRoutes(app, {
  store,
  workspace,
  engines,
  managedWorkspacesRoot,
  projectFolderPathBoundary,
  activeRuns,
  scheduledSessionRollovers,
  organizationEnvelopeStates,
  cachedModelOptions,
  appendWorkspace,
  refreshCommunicationReconciliation,
  clearAgentResumeSession,
  persistentRuntimeForTermination,
  teardownPersistentRuntime,
});

registerProjectDeletionRoutes(app, {
  store,
  reconcileManagedProjectFolders: managedProjectFolders.reconcileManagedProjectFolders,
  coordinationV3,
  engines,
  activeRuns,
  runtimeAuthorities,
  engineCapabilityDiscoveryAuthorities,
  engineModelCatalogDiscoveryAuthorities,
  deletingProjectIds,
  deletingAgentIds,
  reconcilingAssetAgentIds,
  agentAttachmentDeletionInProgress,
  agentCreationConversationLeases,
  conversationDeliveryLeases,
  agentDeliveryLeases,
  projectDeletionInFlightIds,
  projectBrowserGrants,
  browserSessions,
  projectBrowserSessions,
  browserProfiles,
  agentMessageCapabilities,
  subscribers,
  scheduledSessionRollovers,
  contextCursors,
  communicationReconciliation,
  dirtyCommunicationProjects,
  clearRunLeaseTimer,
  clearRunLivenessTimer,
  closeLinkPreviewsForAgent,
  drainProviderRuntimeAuthority,
  drainEngineCapabilityDiscoveries,
  drainEngineModelCatalogDiscoveries,
  awaitProjectDeletionBarrier,
  cancelAgentDecisions,
  invalidateEngineCapabilities,
  reconcileCommittedProjectDeletion,
  createOperationalNotification,
  resolveOperationalNotification,
  agentHealth,
  logError: (meta, message) => app.log.error(meta, message),
  providerProcessAuthority,
  workingCopies,
  drafts,
  workspace,
  processConversationDeletionCleanup,
  processAgentDeletionCleanup,
  assets,
});

registerAgentWorkRoutes(app, { store, projection: agentWorkProjection });

registerUsageRoutes(app, serverContext);

registerConversationRoutes(app, {
  store,
  workspace,
  engines,
  cachedModelOptions,
  appendWorkspace,
  generateConversationTitle,
  conversationDetail,
  agentHealth,
  teamDirectory,
  hasActiveRun: agentId => activeRuns.has(agentId),
  projectDeletionInProgress: projectId => deletingProjectIds.has(projectId),
  deletingConversationIds,
  agentCreationConversationLeases,
  conversationDeliveryLeases,
  processConversationDeletionCleanup,
});

registerConversationDeliveryRoutes(app, {
  withMessagePresentation,
  store,
  coordinationV3,
  assets,
  projectDeletionInProgress: (projectId) => deletingProjectIds.has(projectId),
  agentDeletionInProgress: (agentId) => deletingAgentIds.has(agentId),
  attachmentDeletionInProgress: (agentId, attachmentId) =>
    deletingAttachmentKeys.has(attachmentDeletionKey(agentId, attachmentId)),
  assetReconciliationInProgress: agentId => reconcilingAssetAgentIds.has(agentId),
  conversationDeliveryLeases,
  agentDeliveryLeases,
  assetMetadata,
  prepareUserCommunicationText,
  runtimeArtifactMetadata,
  recordCommunication,
  reconcileRuntimeCommunicationProjections,
  projectCommunicationArtifact,
  communicationArtifactAccess,
  projectBroadcastToAgentAudits,
  projectCommunicationToAgentAudit,
  appendWorkspace,
  publishCoordinationV3Changed,
  notifyScheduler: notifyScheduler,
});

registerQueuedMessageRoutes(app, {
  store,
  coordinationV3,
  workspace,
  projectDeletionInProgress: projectId => deletingProjectIds.has(projectId),
  conversationDeletionInProgress: conversationId => deletingConversationIds.has(conversationId),
  agentDeletionInProgress: agentId => deletingAgentIds.has(agentId),
  conversationDeliveryLeases,
  agentDeliveryLeases,
  prepareUserCommunicationText,
  runtimeArtifactMetadata,
  removeRuntimeArtifactReservation: (projectId, artifactId) =>
    assets.removeRuntimeArtifactReservation(projectId, artifactId),
  appendWorkspace,
  publishWorkspaceSince,
  publishCoordinationV3Changed,
  publishMessageDeliveryChanged,
  notifyScheduler: notifyScheduler,
});
registerCollaborationRoutes(app, {
  store,
  coordinationV3,
  assets,
  projectDeletionInProgress: projectId => deletingProjectIds.has(projectId),
  agentDeletionInProgress: agentId => deletingAgentIds.has(agentId),
  attachmentDeletionInProgress: (agentId, attachmentId) =>
    deletingAttachmentKeys.has(attachmentDeletionKey(agentId, attachmentId)),
  assetReconciliationInProgress: agentId => reconcilingAssetAgentIds.has(agentId),
  conversationDeliveryLeases,
  agentDeliveryLeases,
  collaborationViewDetail,
  assetMetadata,
  prepareUserCommunicationText,
  runtimeArtifactMetadata,
  recordCommunication,
  reconcileRuntimeCommunicationProjections,
  projectCommunicationArtifact,
  communicationArtifactAccess,
  projectCommunicationToAgentAudit,
  appendWorkspace,
  publishCoordinationV3Changed,
  notifyScheduler: notifyScheduler,
});

app.get<{ Params: { id: string }; Querystring: CollectionQuery }>("/api/projects/:id/agents", async (request, reply) => {
  if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
  try {
    const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
    const page = sqliteCollectionPage(store.sqlite, request.query, {
      baseSql: `
        SELECT id, title, updated_at
        FROM agents
        WHERE project_id = ? AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM agent_creation_operation_members members
            JOIN agent_creation_operations operations ON operations.id = members.operation_id
            WHERE members.agent_id = agents.id
              AND operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
          )
          ${normalizedSearch ? "AND lower(title || ' ' || active_engine || ' ' || COALESCE(model, '')) LIKE ? ESCAPE '\\\\'" : ""}
      `,
      params: normalizedSearch
        ? [request.params.id, `%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`]
        : [request.params.id],
      order: "updated",
      scope: `project-agents:${request.params.id}`,
      generationKeys: [collectionGenerationKey("agents", `project:${request.params.id}`)],
      hydrate: id => store.getAgent(id),
    });
    applyCollectionPageHeaders(reply, page);
    return page.items;
  } catch (error) {
    return sendCollectionPageError(reply, error);
  }
});

registerAgentOrganizationRoutes(app, { store, agentHealth });

registerAgentPresetRoutes(app, {
  store,
  validateRuntimeSelection: (input, projectId) => {
    if (!input.engine) return undefined;
    const configured = engines.get(input.engine);
    if (!configured) return "unknown engine";
    return runtimeSelectionError(
      configured.adapter,
      input.model ?? undefined,
      input.effort ?? undefined,
      cachedModelOptions(configured.adapter, projectId),
    );
  },
});

registerAgentCreationRoutes(app, {
  appendWorkspace,
  dataDir: opts.dataDir,
  store,
  coordinationV3,
  workspace,
  assets,
  drafts,
  engines,
  deletingAgentIds,
  deletingProjectIds,
  deletingConversationIds,
  agentCreationConversationLeases,
  agentDeliveryLeases,
  cachedModelOptions,
  recordCommunication,
  prepareUserCommunicationText,
  runtimeArtifactMetadata,
  projectCommunicationArtifact,
  communicationArtifactAccess,
  reconcileRuntimeCommunicationProjections,
  publish,
  publishMessageDeliveryChanged,
  notifyScheduler: notifyScheduler,
});

registerWorkspaceDirectoryRoutes(app, {
  store,
  workspace,
  agentHealth,
  projectDisplayPath: (hostPath) => displayProjectPath({
    hostPath,
    homePath: os.homedir(),
    managedWorkspacesRoot: path.resolve(opts.dataDir, "workspaces"),
  }),
});

registerAgentAuditRoutes(app, serverContext);

app.get<{ Params: { id: string; seq: string } }>(
  "/api/agents/:id/run-output/:seq/text",
  async (request, reply) => {
    if (!store.getAgentDetail(request.params.id, 1, false)) {
      return reply.code(404).send({ error: "agent not found" });
    }
    const seq = Number(request.params.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      return reply.code(400).send({ error: "invalid run output sequence" });
    }
    try {
      return store.getRunOutputText(request.params.id, seq)
        ?? reply.code(404).send({ error: "run output segment not found" });
    } catch (error) {
      if (error instanceof RangeError) {
        return reply.code(413).send({ error: error.message });
      }
      throw error;
    }
  },
);

registerAgentPackageRoutes(app, {
  dataDir: opts.dataDir,
  store,
  coordination: coordinationV3,
  assets,
  engines,
  deletingProjectIds,
  deletingConversationIds,
  deletingAgentIds,
  agentCreationConversationLeases,
  cachedModelOptions,
  appendWorkspace,
  agentMessages,
  createOperationalNotification,
});

registerAgentUsageRoute(app, serverContext);

registerAgentMaintenanceRoutes(app, {
  store, coordinationV3, engines, deletingAgentIds,
  cachedModelOptions, commitAgentDeletion,
  activeRuns, workingCopies, clearAgentResumeSession,
  persistentRuntimeForTermination, teardownPersistentRuntime,
  notifyScheduler: notifyScheduler,
  appendWorkspace,
});

const globalChatSearch = (query: {
  q?: string;
  limit?: string | number;
  kind?: string;
  distinct?: string;
}): GlobalChatSearchResponseDto => {
  const q = String(query.q ?? "").trim();
  if (q.length > 200) throw new Error("search query must be 200 characters or fewer");
  const chatKind = query.kind || undefined;
  if (chatKind !== undefined && chatKind !== "conversation" && chatKind !== "agent") {
    throw new Error("search kind must be conversation or agent");
  }
  const requestedLimit = Number(query.limit ?? 30);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 30;
  return store.searchGlobalChats({
    query: q,
    limit,
    chatKind,
    distinctChats: query.distinct === "chats",
    notificationState: (input) => workspace.notificationSearchState(input),
  });
};


registerSearchRoutes(app, {
  ...serverContext,
  store,
  globalChatSearch,
  workspace,
  coordinationV3,
});

async function assetMetadata(agentId: string, id: string) {
  const agent = store.getAgent(agentId);
  const conversation = agent ? undefined : store.getConversation(agentId);
  const projectId = agent?.projectId ?? conversation?.projectId;
  if (!projectId) return undefined;
  const metadata = await assets.read(projectId, agentId, id);
  if (conversation && metadata?.conversationId !== conversation.id) return undefined;
  if (agent && metadata?.conversationId) return undefined;
  return metadata && await assets.content(projectId, agentId, id, false) ? metadata : undefined;
}

registerLimitsRoutes(app, serverContext);

registerAttachmentRoutes(app, {
  dataDir: opts.dataDir,
  agentDeliveryLeases,
  conversationDeliveryLeases,
  conversationDeletionInProgress: conversationId => deletingConversationIds.has(conversationId),
  agentDeletionInProgress: agentId => deletingAgentIds.has(agentId),
  assets,
  deletingAttachmentKeys,
  reconcilingAssetAgentIds,
  store,
});

registerAgentMessageRunRoute(app, {
  opts, store, workspace, coordinationV3, assets, drafts, engines, engineAvailability,
  contextCursors, activeRuns, agentMessageCapabilities, runtimeAuthorities,
  organizationEnvelopeStates, scheduledSessionRollovers, contextRolloverPending,
  engineModelCatalogCache, deletingProjectIds, deletingAgentIds,
  conversationDeletionInProgress: conversationId => deletingConversationIds.has(conversationId),
  attachmentDeletionInProgress: (agentId, attachmentId) =>
    deletingAttachmentKeys.has(attachmentDeletionKey(agentId, attachmentId)),
  conversationDeliveryLeases,
  agentDeliveryLeases,
  assetReconciliationInProgress: agentId => reconcilingAssetAgentIds.has(agentId),
  coordinationV3WorkerId, v3DispatchKey, deploymentDraining: isDeploymentDraining,
  isClosed: isClosed, providerEnabled, resourceAdmissionHeld, leaseExpiry, reusableRuntime, openingRuntime,
  closingRuntime, oneShotRuntime, runtimeAuthority, pruneRuntimeAuthority, clearAgentResumeSession,
  assetMetadata, recordCommunication, reconcileRuntimeCommunicationProjections,
  notifyManagerOfChildFailure, notifyScheduler: notifyScheduler,
  cachedModelOptions, discoverEngineModelCatalog, markEngineModelUnavailable,
  discoverEngineCapabilities,
  reportRuntimeCapabilitiesChanged, refreshProviderUsageAfterRun, ownsActiveRunForAuditDrain,
  persistentRootExited, scheduleRuntimeIdleClose, teardownOneShotRuntime, teardownOpeningRuntime,
  teardownPersistentRuntime, teardownPersistentRuntimeInBackground, claimActiveRun,
  persistRuntimeEvent, receiveRuntimeEvent, releaseActiveRun, renewExecutionLease,
  communicationArtifactAccess, prepareUserCommunicationText,
  projectCommunicationArtifact, runtimeArtifactMetadata, projectCommunicationToAgentAudit,
  publish, publishCoordinationV3Changed, publishMessageDeliveryChanged, observeRuntimeStalls,
  canonicalConversationContext, agentCanReadRuntimeArtifact,
  createOperationalNotification, resolveOperationalNotification, reconcileProjectWorkspace,
  drainDeploymentIdleAuthorities, publishWorkspaceSince, runtimeElicitations,
  ownsActiveRun, cancelRuntimeIdleClose, reconcileAgentRuntimeAuthority,
  retireCompletedContextRolloverSession,
  scheduleRuntimeLivenessHeartbeat,
  providerProcessAuthority,
  workingCopies,
});

registerWorkspacePreferenceRoutes(app, {
  opts, store, coordinationV3, workspace, engines, activeRuns, scheduledSessionRollovers,
  organizationEnvelopeStates, engineModelCatalogCache, cachedModelOptions,
  applyOperatorModelOptions, publishWorkspaceSince,
  setMaxConcurrentRuns: setMaxConcurrentRuns,
  clearAgentResumeSession, persistentRuntimeForTermination, teardownPersistentRuntime,
});

registerDraftRoutes(
  app,
  drafts,
  workspace,
  MAX_ATTACHMENTS_PER_MESSAGE,
  publishWorkspaceSince,
);

const notificationRoutesOptions = {
  workspace,
  store,
  publishWorkspaceSince,
};
registerNotificationListRoute(app, notificationRoutesOptions);
app.get<{ Querystring: { projectId?: string; conversationId?: string; agentId?: string; status?: string } }>("/api/decisions", async (request, reply) => {
  const status = request.query.status;
  if (status && !["pending", "resolved", "cancelled"].includes(status)) return reply.code(400).send({ error: "invalid Decision status" });
  return workspace.listDecisions({
    projectId: request.query.projectId,
    conversationId: request.query.conversationId,
    agentId: request.query.agentId,
    status: status as "pending" | "resolved" | "cancelled" | undefined,
  });
});
app.get<{ Params: { id: string } }>("/api/decisions/:id/action", async (request, reply) => {
  const current = workspace.getDecision(request.params.id);
  if (!current || !current.runtimeAction) return reply.code(404).send({ error: "Connection request not found" });
  if (current.status !== "pending") return reply.code(409).send({ error: "Connection request is no longer pending" });
  const action = runtimeElicitations.action(current.id);
  if (!action) return reply.code(410).send({ error: "Connection request expired. Ask the Agent to try connecting again." });
  return reply.header("cache-control", "no-store").send(action);
});
app.post<{ Params: { id: string }; Body: { optionId?: string; text?: string; content?: unknown; skip?: true } }>("/api/decisions/:id/respond", async (request, reply) => {
  const current = workspace.getDecision(request.params.id);
  if (!current) return reply.code(404).send({ error: "Decision not found" });
  if (deletingProjectIds.has(current.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
  if (request.body?.skip !== undefined && (request.body.skip !== true ||
      request.body.optionId !== undefined || request.body.text !== undefined || request.body.content !== undefined)) {
    return reply.code(400).send({ error: "Skip question cannot include an answer, approval or submitted fields" });
  }
  if (request.body?.skip && current.status === "resolved") {
    return reply.code(409).send({ error: "This question has already been answered" });
  }
  if (current.status !== "pending") {
    if (current.status === "resolved" || (current.status === "cancelled" && current.response?.skipped)) {
      if (current.approvalScope?.kind === "saved_browser" && current.response?.optionId === "approve") {
        try {
          if (!applyResolvedSavedBrowserApproval(current)) {
            return reply.code(409).send({ error: "This saved-browser approval is no longer valid. No access was granted." });
          }
        } catch (error) {
          return reply.code(error instanceof BrowserProfileError ? error.statusCode : 503)
            .send({ error: "Saved-browser approval is recorded, but access is not ready. Retry this Decision response." });
        }
      }
      ensureDecisionResponseActivation(current);
      notifyScheduler();
    }
    return current;
  }
  const optionId = request.body?.optionId?.trim();
  const text = request.body?.text?.trim();
  if (request.body?.skip !== undefined) {
    if (deletingAgentIds.has(current.agentId) ||
        (current.conversationId && deletingConversationIds.has(current.conversationId))) {
      return reply.code(409).send({ error: "The Decision owner is being deleted" });
    }
    const at = new Date().toISOString();
    if (current.approvalScope?.kind === "agent_management" &&
        !store.resolveAgentManagementApproval(current.id, false, at)) {
      return reply.code(409).send({ error: "The scoped management approval record is unavailable" });
    }
    const cursor = workspace.cursor();
    const decision = workspace.cancelDecision(current.id, at, true)!;
    publishWorkspaceSince(cursor);
    if (current.runtimeAction && runtimeElicitations.action(current.id)) {
      runtimeElicitations.respond(current.id, { action: "decline" });
    }
    ensureDecisionResponseActivation(decision);
    publishMessageDeliveryChanged(decision.agentId);
    notifyScheduler();
    return decision;
  }
  if (optionId && text) return reply.code(400).send({ error: "choose an option or enter another response, not both" });
  if (optionId && !current.options.some((option) => option.id === optionId)) return reply.code(400).send({ error: "unknown Decision option" });
  if (!optionId && !text) return reply.code(400).send({ error: "choose an option or enter a response" });
  if (!optionId && !current.runtimeAction && current.mode !== "text" && !current.allowOther) return reply.code(400).send({ error: "this Decision does not accept another response" });
  const liveRuntimeAction = current.runtimeAction
    ? runtimeElicitations.action(current.id)
    : undefined;
  if (current.runtimeAction) {
    if (!liveRuntimeAction) {
      return reply.code(410).send({ error: "Connection request expired. Ask the Agent to try connecting again." });
    }
    if (!text) {
      if (current.runtimeAction.mode === "url" && optionId !== "accept" && optionId !== "decline") {
        return reply.code(400).send({ error: "Confirm the connection, choose Not Now, or send another response to the Agent" });
      }
      if (current.runtimeAction.mode !== "url" &&
          optionId !== "submit" && optionId !== "allow_run" && optionId !== "decline") {
        return reply.code(400).send({ error: "Submit the requested information, choose Not Now, or send another response to the Agent" });
      }
      if (optionId === "submit" && request.body?.content === undefined) {
        return reply.code(400).send({ error: "The requested form is incomplete" });
      }
      if (optionId === "allow_run" && !runtimeElicitations.canRememberForRun(liveRuntimeAction)) {
        return reply.code(400).send({ error: "Only confirmation requests can be allowed for the rest of this run" });
      }
    }
  }
  const respondedAt = new Date().toISOString();
  if (current.approvalScope?.kind === "artifact_publication" && optionId === "approve") {
    if (!publicationOwnerIsCurrent(store, current) || deletingAgentIds.has(current.agentId) ||
        deletingConversationIds.has(current.approvalScope.conversationId)) {
      return reply.code(409).send({ code: "publication_cancelled", error: "The publication owner changed or is being deleted. Nothing was published." });
    }
    if (Date.parse(current.approvalScope.expiresAt) <= Date.now()) {
      return reply.code(410).send({ code: "publication_expired", error: "This single-file publication request expired. Nothing was published." });
    }
  }
  if (current.approvalScope?.kind === "agent_management") {
    try {
      if (!store.resolveAgentManagementApproval(current.id, optionId === "approve", respondedAt)) {
        return reply.code(409).send({ error: "the scoped management approval record is unavailable" });
      }
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "management approval could not be resolved" });
    }
  }
  const savedBrowserRequest = current.approvalScope?.kind === "saved_browser" ? current.approvalScope : undefined;
  if (savedBrowserRequest && optionId === "approve") {
    const saved = browserProfiles.savedBrowser();
    const agent = store.getAgent(savedBrowserRequest.agentId);
    if (!saved || saved.profileId !== savedBrowserRequest.profileId ||
        current.projectId !== savedBrowserRequest.projectId || current.agentId !== savedBrowserRequest.agentId ||
        agent?.projectId !== savedBrowserRequest.projectId || deletingAgentIds.has(savedBrowserRequest.agentId)) {
      return reply.code(409).send({ error: "This saved-browser request is no longer valid. No access was granted." });
    }
    try {
      browserProfiles.prepareSavedBrowserApproval(
        current.id, savedBrowserRequest.profileId, savedBrowserRequest.projectId, savedBrowserRequest.agentId,
      );
    } catch (error) {
      return reply.code(error instanceof BrowserProfileError ? error.statusCode : 503)
        .send({ error: error instanceof Error ? error.message : "Saved-browser approval could not be prepared." });
    }
  }
  const cursor = workspace.cursor();
  let decision: DecisionDto;
  try {
    decision = workspace.resolveDecision(current.id, { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}), respondedAt })!;
  } catch (error) {
    if (current.approvalScope?.kind === "artifact_publication") {
      return reply.code(503).send({ code: "publication_approval_storage_failure", error: "Publication approval was not recorded. Nothing was published. Retry this Decision response." });
    }
    throw error;
  }
  if (savedBrowserRequest && optionId === "approve") {
    try {
      if (!applyResolvedSavedBrowserApproval(decision)) {
        return reply.code(409).send({ error: "This saved-browser approval was revoked or changed. No access was granted." });
      }
    } catch (error) {
      return reply.code(error instanceof BrowserProfileError ? error.statusCode : 503)
        .send({ error: "The Decision was recorded, but saved-browser access is not ready. Retry this Decision response." });
    }
  }
  publishWorkspaceSince(cursor);
  if (current.runtimeAction) {
    if (text) {
      // Free-form answers are for the Agent, not fabricated provider form
      // fields. Decline the live provider request, then resume the Agent with
      // the canonical Decision response.
      runtimeElicitations.respond(current.id, { action: "decline" });
      ensureDecisionResponseActivation(decision);
      notifyScheduler();
    } else if (optionId === "allow_run") {
      runtimeElicitations.rememberForRun(current.runId, liveRuntimeAction!);
      runtimeElicitations.respond(current.id, { action: "accept", content: {} });
    } else {
      runtimeElicitations.respond(current.id, optionId === "decline"
        ? { action: "decline" }
        : optionId === "submit"
          ? { action: "accept", content: request.body.content }
          : { action: "accept" });
    }
  } else {
    ensureDecisionResponseActivation(decision);
  }
  publishMessageDeliveryChanged(decision.agentId);
  notifyScheduler();
  return decision;
});
registerNotificationMutationRoutes(app, notificationRoutesOptions);
registerPushRoutes(app, {
  workspace,
  publishWorkspaceSince,
  configuration: {
    configured: webPushConfigured,
    state: webPushConfiguration,
    detail: webPushConfigurationDetail,
    ...(webPushConfigured ? { publicKey: vapid.publicKey } : {}),
  },
});

registerStreamRoutes(app, {
  store,
  workspace,
  serverClosed: isClosed,
  maxSubscribersPerStream: MAX_SSE_SUBSCRIBERS_PER_STREAM,
  workspaceSubscribers,
  agentSubscriberCount: (agentId) => subscribers.get(agentId)?.size ?? 0,
  subscribe,
  liveSseClosures,
  serverMetrics,
});

registerBrowserRoutes(app, {
  browserOwnerForAgent: (projectId, agentId) => {
    const agent = store.getAgent(agentId);
    if (!agent || agent.projectId !== projectId) throw new BrowserSessionError("Browser Agent owner is unavailable.", 404);
    return chatBrowserOwnerId(agent.conversationId);
  },
  browserProfiles,
  browserSessions,
  projectBrowserSessions,
  liveSseClosures,
  projectExists: (id) => {
    try { const scope = projectBrowserScope(id); return Boolean(scope.owner && (scope.owner.kind === "saved" || store.getConversation(scope.conversationId!))); }
    catch { return false; }
  },
  agentExists: (id, agentId) => {
    const agent = store.getAgent(agentId);
    try { const scope = projectBrowserScope(id); return Boolean(agent && scope.owner?.kind === "chat" && agent.projectId === scope.projectId && agent.conversationId === scope.conversationId); }
    catch { return false; }
  },
  projectDeletionInProgress: (id) => {
    try { const scope = projectBrowserScope(id); return deletingProjectIds.has(scope.projectId) || Boolean(scope.conversationId && deletingConversationIds.has(scope.conversationId)); }
    catch { return true; }
  },
  agentDeletionInProgress: (agentId) => deletingAgentIds.has(agentId),
  operatorBrowserScope: (params) => {
    const agent = store.getAgent(params.id);
    if (!agent || agent.projectId !== params.projectId) {
      throw new BrowserSessionError("agent not found", 404);
    }
    if (deletingProjectIds.has(agent.projectId) || deletingAgentIds.has(agent.id)) {
      throw new BrowserSessionError("Project deletion is in progress", 409);
    }
    const run = activeRuns.get(agent.id);
    if (!run || run.runId !== params.runId || !ownsActiveRun(agent.id, run)) {
      throw new BrowserSessionError("browser access requires the exact active run", 404);
    }
    const scope = browserScopeForRun(agent.id, run);
    if (!scope) throw new BrowserSessionError("Exact live Agent/Run Chat ownership is required.", 403, "browser_owner_mismatch");
    return scope;
  },
  projectBrowserScope,
  projectBrowserDto,
  getProjectBrowserGrant: (projectId) => projectBrowserGrants.get(projectId),
  setProjectBrowserGrant: (projectId, grant) => projectBrowserGrants.set(projectId, grant),
  deleteProjectBrowserGrant: (projectId) => {
    projectBrowserGrants.delete(projectId);
  },
  activeProjectBrowserController: (ownerId, agentId) => {
    let scope: BrowserScope;
    try { scope = projectBrowserScope(ownerId); } catch { return undefined; }
    const projectId = scope.projectId;
    const agent = agentId ? store.getAgent(agentId) : undefined;
    const run = agent ? activeRuns.get(agent.id) : undefined;
    if (!agent || agent.projectId !== projectId || agent.conversationId !== scope.conversationId || deletingProjectIds.has(projectId) ||
        deletingConversationIds.has(agent.conversationId) || deletingAgentIds.has(agent.id) || !run || run.conversationId !== agent.conversationId || !ownsActiveRun(agent.id, run)) return undefined;
    return {
      grant: { agentId: agent.id, runId: run.runId },
      privateScope: () => browserScopeForRun(agent.id, run),
    };
  },
});

registerProviderCommandRoutes(app, {
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
  isClosed: isClosed,
  notifyScheduler: notifyScheduler,
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
});

registerCommunicationDocumentRoutes(app, authoritativeCommunicationDocument);
const projectFileAuthority = new ProjectFileAuthority(store, workingCopies);
registerArtifactRoutes(app, {
  store,
  assets,
  dataDir: opts.dataDir,
  projectFileAuthority,
  publish,
  managedProjectArtifactAgreesWithRuntime,
});

registerFilesRoute(app, serverContext);

registerProjectFileRoutes(app, projectFileAuthority, store);

registerAgentWorkspaceRoutes(app, serverContext, workingCopies);

registerEngineRoutes(app, {
  engines,
  store,
  workspace,
  engineDto,
  resourceAdmissionHeld,
  providerUsageCenter,
  providerUsageState,
  publishWorkspaceSince,
  notifyScheduler: notifyScheduler,
  authStatuses: engineAuthStatuses,
  availability: engineAvailability,
  createOperationalNotification,
  resolveOperationalNotification,
  projectDeletionInProgress: (projectId) => deletingProjectIds.has(projectId),
  discoverModelCatalog: discoverEngineModelCatalog,
  validateModel: validateEngineModel,
  discoverCapabilities: discoverEngineCapabilities,
  readCapabilities: readEngineCapabilities,
});

if (opts.webDist) {
  app.get("/*", async (request, reply) => {
    try {
      const rawPath = request.url.split("?")[0] ?? "/";
      if (rawPath === "/api" || rawPath.startsWith("/api/")) return reply.code(404).send();
      const rel = rawPath === "/" ? "index.html" : safeRelativePath(decodeURIComponent(rawPath.slice(1)));
      const target = path.resolve(opts.webDist!, rel);
      const root = path.resolve(opts.webDist!);
      if (target !== root && !target.startsWith(root + path.sep)) return reply.code(404).send();
      const targetExists = await pathExists(target);
      const file = targetExists ? target : path.join(root, "index.html");
      if (!targetExists && !(await pathExists(file))) return reply.code(404).send();
      const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      if (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep)) return reply.code(404).send();
      const contentType = contentTypeForStatic(file);
      const accepts = String(request.headers["accept-encoding"] ?? "");
      const compressible = /^(?:text\/|application\/(?:javascript|json|manifest\+json))/u.test(contentType);
      const encoding = compressible && /(?:^|,)\s*br\s*(?:,|$)/iu.test(accepts)
        ? "br"
        : compressible && /(?:^|,)\s*gzip\s*(?:,|$)/iu.test(accepts)
          ? "gzip"
          : undefined;
      const body = encoding === "br"
        ? createReadStream(file).pipe(createBrotliCompress())
        : encoding === "gzip"
          ? createReadStream(file).pipe(createGzip())
          : createReadStream(file);
      if (encoding) reply.header("Content-Encoding", encoding).header("Vary", "Accept-Encoding");
      return reply
        .header("Cache-Control", cacheControlForStatic(file))
        .type(contentType)
        .send(body);
    } catch {
      return reply.code(404).send();
    }
  });
}
}
