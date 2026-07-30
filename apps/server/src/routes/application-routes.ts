import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DecisionDto,
  GlobalChatSearchResponseDto,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  BrowserSessionError,
  type BrowserScope,
} from "../browser-session-manager.js";
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
import type { ServerContext } from "../server-context.js";
import type { RuntimeElicitationBroker } from "../runtime-elicitation-broker.js";
import { registerAgentAuditRoutes } from "./agent-audit.js";
import { registerAgentCreationRoutes } from "./agent-creation.js";
import { registerAgentMaintenanceRoutes } from "./agent-maintenance.js";
import { registerAgentMessageRunRoute } from "./agent-message-run.js";
import { registerAgentPackageRoutes } from "./agent-packages.js";
import { registerAgentPresetRoutes } from "./agent-presets.js";
import { registerAgentUsageRoute, registerUsageRoutes } from "./usage.js";
import { registerAgentWorkRoutes } from "./agent-work.js";
import { registerArtifactRoutes } from "./artifacts.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerBrowserRoutes } from "./browsers.js";
import { registerCollaborationRoutes } from "./collaboration.js";
import { registerCommunicationDocumentRoutes } from "./communication-documents.js";
import { registerConversationCorrectionRoutes } from "./conversation-corrections.js";
import { registerConversationDeliveryRoutes } from "./conversation-deliveries.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerDraftRoutes } from "./drafts.js";
import { registerEngineRoutes } from "./engines.js";
import { registerLegacyFilesRoute, registerLegacyWorkspaceRoutes } from "./legacy-workspace.js";
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
import { registerTriggerRoutes } from "./triggers.js";
import { registerWikiRoutes } from "./wiki.js";
import { registerWorkspacePreferenceRoutes } from "./workspace-preferences.js";

type ApplicationRoutesContext =
  Parameters<typeof registerProjectRoutes>[1] &
  Omit<Parameters<typeof registerProjectDeletionRoutes>[1],
    "logError" | "projectDeletionCleanupFaults"> &
  Omit<Parameters<typeof registerConversationRoutes>[1],
    "hasActiveRun" | "handleAgentConversationRemoval" | "refreshTriggers"> &
  Omit<Parameters<typeof registerConversationDeliveryRoutes>[1],
    "projectDeletionInProgress" | "assetMetadata"> &
  Parameters<typeof registerQueuedMessageRoutes>[1] &
  Parameters<typeof registerConversationCorrectionRoutes>[1] &
  Omit<Parameters<typeof registerCollaborationRoutes>[1],
    "projectDeletionInProgress" | "assetMetadata" | "afterCommunicationArtifactCommit"> &
  Omit<Parameters<typeof registerAgentCreationRoutes>[1], "messageLifecycleFaults"> &
  Omit<Parameters<typeof registerAgentPackageRoutes>[1], "dataDir" | "coordination"> &
  Parameters<typeof registerAgentMaintenanceRoutes>[1] &
  Omit<Parameters<typeof registerAgentMessageRunRoute>[1],
    "deploymentDraining" | "assetMetadata"> &
  Parameters<typeof registerWorkspacePreferenceRoutes>[1] &
  Parameters<typeof registerNotificationListRoute>[1] &
  Omit<Parameters<typeof registerPushRoutes>[1], "configuration"> &
  Omit<Parameters<typeof registerStreamRoutes>[1],
    "serverClosed" | "maxSubscribersPerStream" | "agentSubscriberCount"> &
  Omit<Parameters<typeof registerBrowserRoutes>[1],
    "projectExists" | "projectDeletionInProgress" | "operatorBrowserScope" |
    "getProjectBrowserGrant" | "setProjectBrowserGrant" |
    "deleteProjectBrowserGrant" | "activeProjectBrowserController"> &
  Parameters<typeof registerProviderCommandRoutes>[1] &
  Omit<Parameters<typeof registerArtifactRoutes>[1],
    "dataDir" | "projectFileAuthority"> &
  Omit<Parameters<typeof registerEngineRoutes>[1],
    "authStatuses" | "availability" | "projectDeletionInProgress" |
    "discoverModelCatalog" | "validateModel" | "discoverCapabilities" |
    "readCapabilities"> & {
    serverContext: ServerContext;
    registerLinkPreviewRoutes(app: FastifyInstance): void;
    agentWorkProjection: Parameters<typeof registerAgentWorkRoutes>[1]["projection"];
    triggerSources: Parameters<typeof registerAgentPackageRoutes>[1]["triggerSources"];
    webhookRawBodies: Parameters<typeof registerTriggerRoutes>[1]["webhookRawBodies"];
    agentMessages: Parameters<typeof registerAgentPackageRoutes>[1]["agentMessages"];
    authoritativeCommunicationDocument: Parameters<typeof registerCommunicationDocumentRoutes>[1];
    projectCommunicationToAgentAudit: Parameters<typeof registerCollaborationRoutes>[1]["projectCommunicationToAgentAudit"];
    ensureDecisionResponseActivation(decision: DecisionDto): string | undefined;
    vapid: {
      publicKey?: string;
      privateKey?: string;
      subject: string;
    };
    webPushConfiguration: "active" | "missing" | "invalid";
    webPushConfigurationDetail: string;
    webPushConfigured: boolean;
    engineAuthStatuses: Parameters<typeof registerEngineRoutes>[1]["authStatuses"];
    reconcileTriggerOperationalNotifications: Parameters<typeof registerTriggerRoutes>[1]["reconcileOperationalNotifications"];
    browserScopeForRun(agentId: string, run: ActiveRun): BrowserScope | undefined;
    rejectQuarantinedTriggerMutation: Parameters<typeof registerTriggerRoutes>[1]["rejectQuarantinedMutation"];
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
    workspace,
    workspaceSubscribers,
    liveSseClosures,
    appendWorkspace,
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
    reconcileCommunicationFailureNotifications,
    reconcileCoordinationAttentionNotifications,
    reconcileProjectWorkspace,
    reconcileTriggerOperationalNotifications,
    resolveOperationalNotification,
    cancelAgentDecisions,
    awaitProjectDeletionBarrier,
    commitAgentDeletion,
    contextCursors,
    browserScopeForRun,
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
    waitBeforeRuntimePersist,
    agentHealth,
    agentMessages,
    canonicalConversationContext,
    collaborationViewDetail,
    conversationDetail,
    ensureDecisionResponseActivation,
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
    triggerSources,
    webhookRawBodies,
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
  } = context;

registerLinkPreviewRoutes(app);

registerProjectRoutes(app, {
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
  coordinationV3,
  engines,
  triggerSources,
  activeRuns,
  runtimeAuthorities,
  engineCapabilityDiscoveryAuthorities,
  engineModelCatalogDiscoveryAuthorities,
  deletingProjectIds,
  deletingAgentIds,
  projectDeletionInFlightIds,
  projectBrowserGrants,
  browserSessions,
  projectBrowserSessions,
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
  appendWorkspace,
  createOperationalNotification,
  resolveOperationalNotification,
  agentHealth,
  logError: (meta, message) => app.log.error(meta, message),
  projectDeletionCleanupFaults: opts.projectDeletionCleanupFaults,
});

registerAgentWorkRoutes(app, { store, projection: agentWorkProjection });

registerUsageRoutes(app, serverContext);

registerConversationRoutes(app, {
  store,
  workspace,
  engines,
  cachedModelOptions,
  appendWorkspace,
  publishWorkspaceSince,
  generateConversationTitle,
  conversationDetail,
  agentHealth,
  teamDirectory,
  hasActiveRun: agentId => activeRuns.has(agentId),
  handleAgentConversationRemoval: (agentId, conversationId) =>
    coordinationV3.handleAgentConversationRemoval(agentId, conversationId),
  refreshTriggers: () => triggerSources.refresh(),
  draftAttachmentSurfaceDir,
});

registerConversationDeliveryRoutes(app, {
  store,
  coordinationV3,
  assets,
  projectDeletionInProgress: (projectId) => deletingProjectIds.has(projectId),
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
  afterCommunicationArtifactCommit: opts.messageLifecycleFaults?.afterCommunicationArtifactCommit,
});

registerQueuedMessageRoutes(app, {
  store,
  coordinationV3,
  workspace,
  prepareUserCommunicationText,
  runtimeArtifactMetadata,
  appendWorkspace,
  publishWorkspaceSince,
  publishCoordinationV3Changed,
  publishMessageDeliveryChanged,
  notifyScheduler: notifyScheduler,
  afterQueuedEditSqliteCommit: opts.messageLifecycleFaults?.afterQueuedEditSqliteCommit,
});
registerConversationCorrectionRoutes(app, {
  store,
  coordinationV3,
  recordCommunication,
  appendWorkspace,
  publishCoordinationV3Changed,
  notifyScheduler: notifyScheduler,
});

registerCollaborationRoutes(app, {
  store,
  coordinationV3,
  assets,
  projectDeletionInProgress: projectId => deletingProjectIds.has(projectId),
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
  afterCommunicationArtifactCommit: opts.messageLifecycleFaults?.afterCommunicationArtifactCommit,
});

app.get<{ Params: { id: string } }>("/api/projects/:id/agents", async (request, reply) => {
  if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
  return store.listAgents(request.params.id);
});

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
  store,
  coordinationV3,
  workspace,
  assets,
  drafts,
  engines,
  deletingAgentIds,
  deletingProjectIds,
  cachedModelOptions,
  recordCommunication,
  prepareUserCommunicationText,
  runtimeArtifactMetadata,
  projectCommunicationArtifact,
  communicationArtifactAccess,
  publish,
  publishMessageDeliveryChanged,
  notifyScheduler: notifyScheduler,
  messageLifecycleFaults: opts.messageLifecycleFaults,
});

registerTriggerRoutes(app, {
  store,
  coordination: coordinationV3,
  sources: triggerSources,
  webhookRawBodies,
  rejectQuarantinedMutation: rejectQuarantinedTriggerMutation,
  appendWorkspace,
  reconcileOperationalNotifications: reconcileTriggerOperationalNotifications,
  resolveOperationalNotification,
  notifyScheduler: notifyScheduler,
});

app.get<{ Params: { id: string } }>("/api/agent-trigger-occurrences/:id", async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const capability = token ? agentMessageCapabilities.get(token) : undefined;
  const active = capability ? activeRuns.get(capability.agentId) : undefined;
  if (!capability || !active || !capabilityOwnsAuthoritativeRun(capability, active) || active.messageCapability !== token) {
    return reply.code(401).send({ error: "Trigger occurrence capability is not authorized for an active Run" });
  }
  const occurrence = coordinationV3.getTriggerOccurrence(request.params.id);
  if (!occurrence || occurrence.agentId !== capability.agentId) return reply.code(404).send({ error: "Trigger occurrence not found" });
  if (!occurrence.activationId || coordinationV3.activationPayloads(capability.agentId, [occurrence.activationId], capability.runId).length !== 1) {
    return reply.code(404).send({ error: "Trigger occurrence is not attached to this Run" });
  }
  return occurrence;
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
  cachedModelOptions,
  triggerSources,
  appendWorkspace,
  agentMessages,
});

registerAgentUsageRoute(app, serverContext);

registerAgentMaintenanceRoutes(app, {
  store, coordinationV3, workspace, engines, triggerSources, deletingAgentIds,
  cachedModelOptions, commitAgentDeletion,
  notifyScheduler: notifyScheduler,
});

const globalChatSearch = (query: { q?: string; limit?: string | number }): GlobalChatSearchResponseDto => {
  const q = String(query.q ?? "").trim();
  if (q.length > 200) throw new Error("search query must be 200 characters or fewer");
  const requestedLimit = Number(query.limit ?? 30);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 30;
  return store.searchGlobalChats({ query: q, limit, notifications: workspace.listNotifications() });
};

registerWikiRoutes(app, serverContext);

registerSearchRoutes(app, { ...serverContext, globalChatSearch, workspace });

async function assetMetadata(agentId: string, id: string) {
  const agent = store.getAgent(agentId);
  if (!agent) return undefined;
  const metadata = await assets.read(agent.projectId, agent.id, id);
  return metadata && await assets.content(agent.projectId, agent.id, id, false) ? metadata : undefined;
}

registerLimitsRoutes(app, serverContext);

registerAttachmentRoutes(app, { assets, store });

registerAgentMessageRunRoute(app, {
  opts, store, workspace, coordinationV3, assets, drafts, engines, engineAvailability,
  contextCursors, activeRuns, agentMessageCapabilities, runtimeAuthorities,
  organizationEnvelopeStates, scheduledSessionRollovers, contextRolloverPending,
  engineModelCatalogCache, deletingProjectIds, deletingAgentIds,
  coordinationV3WorkerId, v3DispatchKey, deploymentDraining: isDeploymentDraining,
  isClosed: isClosed, providerEnabled, leaseExpiry, reusableRuntime, openingRuntime,
  closingRuntime, oneShotRuntime, runtimeAuthority, pruneRuntimeAuthority, clearAgentResumeSession,
  assetMetadata, recordCommunication, reconcileRuntimeCommunicationProjections,
  notifyManagerOfChildFailure, notifyScheduler: notifyScheduler,
  cachedModelOptions, discoverEngineModelCatalog, markEngineModelUnavailable,
  discoverEngineCapabilities,
  reportRuntimeCapabilitiesChanged, refreshProviderUsageAfterRun, ownsActiveRunForAuditDrain,
  persistentRootExited, scheduleRuntimeIdleClose, teardownOneShotRuntime, teardownOpeningRuntime,
  teardownPersistentRuntime, teardownPersistentRuntimeInBackground, claimActiveRun,
  persistRuntimeEvent, receiveRuntimeEvent, releaseActiveRun, renewExecutionLease,
  waitBeforeRuntimePersist, communicationArtifactAccess, prepareUserCommunicationText,
  projectCommunicationArtifact, runtimeArtifactMetadata, projectCommunicationToAgentAudit,
  publish, publishCoordinationV3Changed, publishMessageDeliveryChanged, teamDirectory,
  canonicalConversationContext, agentCanReadRuntimeArtifact,
  createOperationalNotification, resolveOperationalNotification, reconcileProjectWorkspace,
  drainDeploymentIdleAuthorities, publishWorkspaceSince, runtimeElicitations,
  ownsActiveRun, cancelRuntimeIdleClose, reconcileAgentRuntimeAuthority,
  scheduleRuntimeLivenessHeartbeat,
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
  reconcileCommunicationFailureNotifications,
  reconcileCoordinationAttentionNotifications,
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
app.post<{ Params: { id: string }; Body: { optionId?: string; text?: string; content?: unknown } }>("/api/decisions/:id/respond", async (request, reply) => {
  const current = workspace.getDecision(request.params.id);
  if (!current) return reply.code(404).send({ error: "Decision not found" });
  if (deletingProjectIds.has(current.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
  if (current.status !== "pending") {
    if (current.status === "resolved") {
      ensureDecisionResponseActivation(current);
      notifyScheduler();
    }
    return current;
  }
  const optionId = request.body?.optionId?.trim();
  const text = request.body?.text?.trim();
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
  if (current.approvalScope?.kind === "agent_management") {
    try {
      if (!store.resolveAgentManagementApproval(current.id, optionId === "approve", respondedAt)) {
        return reply.code(409).send({ error: "the scoped management approval record is unavailable" });
      }
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "management approval could not be resolved" });
    }
  }
  const cursor = workspace.cursor();
  const decision = workspace.resolveDecision(current.id, { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}), respondedAt })!;
  const notification = workspace.listNotifications().find((item) => item.dedupeKey === `decision:${decision.id}` && (item.status ?? "open") === "open");
  if (notification) workspace.setNotificationStatus(notification.id, "resolved");
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
});

registerBrowserRoutes(app, {
  browserSessions,
  projectBrowserSessions,
  projectExists: (projectId) => Boolean(store.getProject(projectId)),
  projectDeletionInProgress: (projectId) => deletingProjectIds.has(projectId),
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
    return browserScopeForRun(agent.id, run)!;
  },
  projectBrowserScope,
  projectBrowserDto,
  getProjectBrowserGrant: (projectId) => projectBrowserGrants.get(projectId),
  setProjectBrowserGrant: (projectId, grant) => projectBrowserGrants.set(projectId, grant),
  deleteProjectBrowserGrant: (projectId) => {
    projectBrowserGrants.delete(projectId);
  },
  activeProjectBrowserController: (projectId, agentId) => {
    const agent = agentId ? store.getAgent(agentId) : undefined;
    const run = agent ? activeRuns.get(agent.id) : undefined;
    if (!agent || agent.projectId !== projectId || !run || !ownsActiveRun(agent.id, run)) return undefined;
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
});

registerCommunicationDocumentRoutes(app, authoritativeCommunicationDocument);
const projectFileAuthority = new ProjectFileAuthority(
  store,
  opts.projectFilePreviewFaults,
);
registerArtifactRoutes(app, {
  store,
  assets,
  dataDir: opts.dataDir,
  projectFileAuthority,
  workspaceArtifactReadFaults: opts.workspaceArtifactReadFaults,
  managedArtifactReadFaults: opts.managedArtifactReadFaults,
  publish,
  managedProjectArtifactAgreesWithRuntime,
});

registerLegacyFilesRoute(app, serverContext);

registerProjectFileRoutes(app, projectFileAuthority, store);

registerLegacyWorkspaceRoutes(app, serverContext);

registerEngineRoutes(app, {
  engines,
  store,
  workspace,
  engineDto,
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
      return reply
        .header("Cache-Control", cacheControlForStatic(file))
        .type(contentTypeForStatic(file))
        .send(await fs.readFile(file));
    } catch {
      return reply.code(404).send();
    }
  });
}
}
