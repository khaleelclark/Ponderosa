import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { type Socket } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, promises as fs, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import webpush from "web-push";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type {
  Adapter,
  AgentMessageChannel,
  AgentEvent,
  CommunicationEvent,
  CommunicationRevisionEvent,
  AgentHealthProjectionDto,
  ArtifactDto,
  ChatMessage,
  EngineAuthStatus,
  EngineAvailabilityStatus,
  EngineCapabilities,
  EngineDto,
  EngineModelOption,
  EngineModelValidationDto,
  ProjectEngineModelCatalogDto,
  CreateProjectRequest,
  UpdateProjectRequest,
  ReadinessDto,
  ConversationMessageDto,
  ConversationDetailDto,
  CollaborationViewDto,
  CreateCollaborationMessageRequest,
  AssetDto,
  ImageAttachmentDto,
  QueuedConversationMessageDto,
  CorrectConversationMessageRequest,
  CorrectConversationMessageResponse,
  SendAgentMessageRequest,
  AgentDto,
  MessageDto,
  ModelOption,
  RuntimeProcessHandle,
  RuntimeSession,
  ProviderRootExitDetail,
  UpdateAgentRequest,
  UpdateAgentOrganizationRequest,
  TeamDirectoryDto,
  TokenUsageRangeDto,
  TokenUsageSummaryDto,
  ProviderUsageCenterDto,
  ProviderUsageStateDto,
  PutConversationDraftRequest,
  DraftAttachmentDto,
  UpdateWorkspacePreferencesRequest,
  WorkspaceEventEnvelope,
  WorkspaceEvent,
  WorkspaceNotificationDto,
  DecisionDto,
  NotificationPreferencesDto,
  NotificationPreference,
  VerifiedCitationDto,
  CancelAgentRunRequest,
  CancelAgentRunResponse,
  CreateLinkPreviewRequest,
  LinkPreviewDto,
  GlobalChatSearchResponseDto,
  ProjectBrowserSessionDto,
  AgentDeletionPreviewRequest,
  AgentDeletionPreviewDto,
  CommitAgentDeletionRequest,
  CommitAgentDeletionResponse,
  ProviderInputSourceManifest,
  CommunicationReconciliationReport,
} from "@ponderosa/core";
import {
  agentRoleProfile,
  INLINE_TEXT_MAX_CODE_POINTS,
  LONG_TEXT_MAX_UTF8_BYTES,
  canonicalizeProviderText,
  deriveCommunicationBehavior,
  PONDEROSA_COORDINATE_TOOL,
  PONDEROSA_CONTEXT_TOOL,
  PONDEROSA_DOCS_TOOL,
  PONDEROSA_ROLLOVER_TOOL,
  PONDEROSA_RESULT_TOOL,
  PONDEROSA_TEAM_DIRECTORY_TOOL,
  PONDEROSA_MESSAGE_TOOL,
  PONDEROSA_UPDATE_REQUEST_TOOL,
  PONDEROSA_CREATE_MANAGED_AGENT_TOOL,
  PONDEROSA_DECISION_TOOL,
  PONDEROSA_MANAGE_TOOL,
  PONDEROSA_BROWSER_TOOLS,
  shouldBackTextWithArtifact,
  truncateUnicodeCodePoints,
  TERMINAL_REQUEST_STATES,
  unicodeCodePointLength,
  type CoordinationRequestState,
  type CoordinationRequestUpdateKind,
  type RequestLifetime,
} from "@ponderosa/core";
import { artifactContentPath, publishManagedArtifactContent, repairManagedArtifactContent, attachmentPath, attachmentsDir, type LogEvent, type ConversationDeliveryIntent, type ManagedArtifactAccess, type ManagedArtifactAsyncReadFaults, type StoredLogEvent, AgentStore, AgentDeletionConflictError, WorkspaceStore, CoordinationV3Store, PendingActivationCapacityError } from "@ponderosa/agents";
import { classifyProviderFailure, renderSeedPrompt, shouldRolloverEngineSession } from "@ponderosa/engines";
import { ASSET_LIMITS, AssetError, AssetStore, contentDisposition, type AuthoritativeRuntimeAttachment } from "./assets.js";
import { ContextCursorStore } from "./context-cursors.js";
import { EngineAuthStatusCache } from "./engine-auth-cache.js";
import { EngineAvailabilityStore } from "./engine-availability-store.js";
import { projectAgentHealth, type ActiveRunObservation } from "./agent-health.js";
import { CoordinationV3Scheduler } from "./coordination-v3-scheduler.js";
import { createCoordinationScheduler } from "./coordination-scheduler-service.js";
import { createDeploymentControl } from "./deployment-control.js";
import {
  registerBodyParsers,
  registerRequestSecurityHooks,
} from "./server-request-hooks.js";
import { registerServerLifecycle } from "./server-lifecycle.js";
import { WebPushDeliveryManager, type WebPushSender } from "./web-push-delivery.js";
import { resolveAgentMentionBindings } from "./mention-bindings.js";
import { TriggerSourceService } from "./trigger-service.js";
import { documentationReferences } from "./documentation-reference/index.js";
import { isManagedOperatorAvatarId, MAX_OPERATOR_AVATAR_BYTES, OPERATOR_AVATAR_MEDIA_TYPES, readOperatorProfileImage } from "./operator-profile-images.js";
import { ProviderUsageCache, type ProviderUsageTarget } from "./provider-usage-cache.js";
import {
  descriptorRelativeFilesystemCapability,
  readWorkspaceArtifactFile,
  type WorkspaceArtifactReadFaults,
} from "./project-file-access.js";
import {
  BrowserSessionError,
  BrowserSessionManager,
  chromeBrowserDriverFactory,
  type BrowserDriverFactory,
  type BrowserScope,
} from "./browser-session-manager.js";
import {
  RESULT_PAGE_MIN_BYTES,
  RESULT_PAGE_DEFAULT_BYTES,
  RESULT_PAGE_MAX_BYTES,
  encodeTimelineCursor,
  decodeTimelineCursor,
  encodeResultCursor,
  decodeResultCursor,
  parseResultRef,
} from "./cursors.js";
import {
  collectReachableArtifactIds,
  rewritePortableArtifactReferences,
} from "./artifact-refs.js";
export {
  collectReachableArtifactIds,
  rewritePortableArtifactReferences,
} from "./artifact-refs.js";
import {
  utf8Page,
  utf8PageEnd,
  boundedUtf8Preview,
  contentTypeForStatic,
  cacheControlForStatic,
} from "./static-content.js";
import {
  workspaceAgentEventCategory,
  notificationKindForCommunication,
  notificationPreferenceMatches,
} from "./notification-routing.js";
export {
  workspaceAgentEventCategory,
  notificationKindForCommunication,
  notificationPreferenceMatches,
} from "./notification-routing.js";
import {
  conciseConversationTitle,
  semanticConversationTitle,
} from "./conversation-titles.js";
export {
  conciseConversationTitle,
  semanticConversationTitle,
} from "./conversation-titles.js";
import {
  MAX_FILE_BYTES,
  pathExists,
  safeRelativePath,
  isProjectFileReferenceAllowed,
} from "./project-files.js";
export {
  isProjectFileReferenceAllowed,
} from "./project-files.js";
export {
  parseGitStatus,
} from "./git-status.js";
export {
  parseTokenUsageRange,
} from "./token-usage.js";
import {
  externalFaviconTarget,
  loadExternalFavicon,
  normalizeExternalCitations,
} from "./external-content.js";
export {
  normalizeExternalCitations,
} from "./external-content.js";
import {
  derivedRunActionKey,
  secretEqual,
} from "./security.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLimitsRoutes } from "./routes/limits.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerOperatorProfileImageRoutes } from "./routes/operator-profile-images.js";
import {
  createProjectFolderPathBoundary,
  registerProjectFolderRoutes,
} from "./routes/project-folders.js";
import { registerAgentAuditRoutes, registerAgentRunHistoryRoute } from "./routes/agent-audit.js";
import { registerAgentWorkRoutes } from "./routes/agent-work.js";
import { registerAgentPresetRoutes } from "./routes/agent-presets.js";
import { registerAgentPackageRoutes } from "./routes/agent-packages.js";
import {
  registerConversationDeliveryRoutes,
  type PreparedCommunicationArtifact,
} from "./routes/conversation-deliveries.js";
import {
  registerQueuedMessageRoutes,
  type QueuedEditRevisionOutboxPayload,
} from "./routes/queued-messages.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerConversationCorrectionRoutes } from "./routes/conversation-corrections.js";
import { registerCollaborationRoutes } from "./routes/collaboration.js";
import { registerAgentUsageRoute, registerUsageRoutes } from "./routes/usage.js";
import { registerCommunicationDocumentRoutes } from "./routes/communication-documents.js";
import {
  registerNotificationListRoute,
  registerNotificationMutationRoutes,
  registerPushRoutes,
} from "./routes/notifications.js";
import { registerLegacyFilesRoute, registerLegacyWorkspaceRoutes } from "./routes/legacy-workspace.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerBrowserRoutes } from "./routes/browsers.js";
import { registerEngineRoutes } from "./routes/engines.js";
import { createCommunicationArtifactAuthority } from "./communication-artifacts.js";
import { createEngineControlPlane } from "./engine-control-plane.js";
import { createServerReadModels } from "./server-read-models.js";
import { createOperationalNotifications } from "./operational-notifications.js";
import { createRuntimeAuthority } from "./runtime-authority.js";
import { createRuntimeEventAuthority } from "./runtime-event-authority.js";
import { createLinkPreviewService } from "./link-preview-service.js";
import { createBrowserAuthority } from "./browser-authority.js";
import { createCommunicationJournal } from "./communication-journal.js";
import { createAgentEventService } from "./agent-event-service.js";
import { registerAgentDecisionRoutes } from "./routes/agent-decisions.js";
import { registerAgentManagementRoutes } from "./routes/agent-management.js";
import { registerAgentRuntimeToolRoutes } from "./routes/agent-runtime-tools.js";
import { registerAgentDirectoryRoutes } from "./routes/agent-directory.js";
import { registerAgentCoordinationRoutes } from "./routes/agent-coordination.js";
import { registerAgentRequestCommandRoutes } from "./routes/agent-request-commands.js";
import { registerAgentCommunicationRoutes } from "./routes/agent-communications.js";
import { createCommunicationDocumentAuthority } from "./communication-document-authority.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProjectDeletionRoutes } from "./project-deletion-coordinator.js";
import { registerAgentCreationRoutes } from "./routes/agent-creation.js";
import { registerAgentMaintenanceRoutes } from "./routes/agent-maintenance.js";
import { registerWorkspacePreferenceRoutes } from "./routes/workspace-preferences.js";
import { registerAgentMessageRunRoute } from "./routes/agent-message-run.js";
import { registerProviderCommandRoutes } from "./routes/provider-commands.js";
import { registerServerControlRoutes } from "./routes/server-control.js";
import { registerAgentSurface } from "./routes/agent-surface.js";
import { registerApplicationRoutes } from "./routes/application-routes.js";
import { createCommunicationProjectionReconciler } from "./communication-projection-reconciler.js";
import { registerStreamRoutes } from "./routes/streams.js";
import { registerWikiRoutes } from "./routes/wiki.js";
import { ProjectFileAuthority, registerProjectFileRoutes } from "./routes/project-files.js";
import { registerTriggerRoutes } from "./routes/triggers.js";
import { DraftService, registerDraftRoutes } from "./routes/drafts.js";
import type { ServerContext } from "./server-context.js";
import {
  MAX_AGENT_MENTION_REPLAY_WINDOW,
  agentMentionHandle,
  mentionRelayFingerprint,
  advanceMentionTrail,
  mentionedAgents,
  hasEveryoneMention,
  stripLeadingScopeTag,
  renderScopedMessage,
  inboundContext,
} from "./agent-mentions.js";
import {
  MAX_SEED_HISTORY_MESSAGES,
  boundedContinuationHistory,
  boundedHistoryOmitted,
  boundedSeedHistory,
  byteBoundScopedContext,
  contextSection,
  continuationPrompt,
  conversationPrompt,
  directUserRequestCompletionPrompt,
  individualChatPrompt,
  managerRelationshipPrompt,
  mergeScopedContextSources,
  olderContextPrompt,
  runtimeIdentityPrompt,
  sharedBroadcastContextPrompt,
  sharedRequestCompletionPrompt,
  teamDirectoryPrompt,
  type ScopedContextMessage,
} from "./prompts.js";
export {
  boundedContinuationHistory,
  boundedSeedHistory,
  runtimeIdentityPrompt,
} from "./prompts.js";
import { isAgentStreamEvent } from "./sse.js";
import {
  communicationV3Prompt,
  PROVIDER_DYNAMIC_TOOLS,
  PROVIDER_TOOL_CONTRACT_HASH,
  providerSessionContractHash,
  runtimeSelectionError,
  normalizedRuntimeSelection,
  concreteRuntimeSelection,
} from "./runtime-selection.js";
import {
  canonicalAudienceIncludes,
  recipientCollaborationMessages,
  organizationalMasterMessages,
} from "./communication-scoping.js";
export {
  PROVIDER_TOOL_CONTRACT_HASH,
  providerSessionContractHash,
} from "./runtime-selection.js";

export type { CreateServerOptions, EngineRegistration, PonderosaServer } from "./app-contracts.js";
import {
  CONTEXT_ROLLOVER_INSTRUCTION,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CONFIGURABLE_AGENT_RUN_CONCURRENCY,
  MAX_SSE_SUBSCRIBERS_PER_STREAM,
  MAX_TEXT_LENGTH,
  MIN_CONFIGURABLE_AGENT_RUN_CONCURRENCY,
  agentMessageEndpoint,
  type ActiveRun,
  type AgentMessageCapability,
  type AgentRuntimeAuthority,
  type CapabilityDiscoveryAuthority,
  type CapabilityDiscoveryProcess,
  type CreateServerOptions,
  type EngineRegistration,
  type LinkPreviewRegistration,
  type LinkPreviewSocketPair,
  type ManagementOperation,
  type ManagementPlan,
  type ModelCatalogDiscoveryAuthority,
  type OneShotRuntimeTeardown,
  type OpeningPersistentRuntime,
  type PendingTurn,
  type PersistentRuntime,
  type PersistentRuntimeTeardown,
  type PonderosaServer,
  type RuntimeOwnershipState,
  type Subscriber,
} from "./app-contracts.js";

export function createServer(opts: CreateServerOptions): PonderosaServer {
  const networkSecurity: ReadinessDto["networkSecurity"] = opts.networkSecurity ?? {
    mode: opts.authToken ? "authenticated" : "loopback",
    bindHost: "127.0.0.1",
    authenticationRequired: Boolean(opts.authToken),
    detail: opts.authToken
      ? "Operator API access requires bearer authentication on this loopback listener."
      : "Operator access is limited to clients on this host.",
  };
  const launcherNow = opts.launcherSecurity?.now ?? Date.now;
  const launcherRandomToken = opts.launcherSecurity?.randomToken ??
    (() => randomBytes(32).toString("base64url"));
  const launcherBootstrapTtlMs = Math.max(5_000, Math.min(
    opts.launcherSecurity?.bootstrapTtlMs ?? 60_000,
    5 * 60_000,
  ));
  const launcherSessionTtlMs = Math.max(60_000, Math.min(
    opts.launcherSecurity?.sessionTtlMs ?? 12 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
  ));
  const launcherBootstraps = new Map<string, number>();
  const launcherSessions = new Map<string, number>();
  const purgeLauncherSecurityState = (): void => {
    const now = launcherNow();
    for (const [token, expiresAt] of launcherBootstraps) {
      if (expiresAt <= now) launcherBootstraps.delete(token);
    }
    for (const [token, expiresAt] of launcherSessions) {
      if (expiresAt <= now) launcherSessions.delete(token);
    }
  };
  const cookieValue = (header: string | undefined, name: string): string | undefined =>
    header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const validLauncherSession = (header: string | undefined): boolean => {
    purgeLauncherSecurityState();
    const token = cookieValue(header, "ponderosa_session");
    return Boolean(token && (launcherSessions.get(token) ?? 0) > launcherNow());
  };
  const store = opts.store ?? new AgentStore(opts.dataDir);
  const artifactFilesystem = (opts.artifactFilesystemCapabilityProbe ??
    (() => descriptorRelativeFilesystemCapability(opts.dataDir)))();
  const artifactFilesystemError = () => artifactFilesystem.ok
    ? undefined
    : `artifact-dependent work is unavailable: ${artifactFilesystem.detail}`;
  const assets = new AssetStore(opts.dataDir);
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
  });
  const resultCursorSecret = randomBytes(32);
  const {
    communicationArtifactAccess,
    prepareUserCommunicationText,
    projectCommunicationArtifact,
    requestArtifactAccess,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
  } = createCommunicationArtifactAuthority({ dataDir: opts.dataDir, assets, store });
  const coordinationV3WorkerId = `server:${process.pid}`;
  const workspace = new WorkspaceStore(opts.dataDir);
  const workspaceSubscribers = new Set<(event: WorkspaceEventEnvelope) => void>();
  const liveSseClosures = new Set<() => void>();
  const publishWorkspace = (event: WorkspaceEventEnvelope): void => {
    for (const subscriber of workspaceSubscribers) subscriber(event);
  };
  const appendWorkspace = (event: Parameters<WorkspaceStore["append"]>[0]): WorkspaceEventEnvelope => {
    const stored = workspace.append(event);
    publishWorkspace(stored);
    return stored;
  };
  const publishWorkspaceSince = (cursor: number): void => {
    for (const event of workspace.readSince(cursor)) publishWorkspace(event);
  };
  const vapid = {
    publicKey: (opts.webPush?.publicKey ?? process.env.PONDEROSA_VAPID_PUBLIC_KEY)?.trim(),
    privateKey: (opts.webPush?.privateKey ?? process.env.PONDEROSA_VAPID_PRIVATE_KEY)?.trim(),
    subject: (opts.webPush?.subject ?? process.env.PONDEROSA_VAPID_SUBJECT)?.trim() || "mailto:admin@localhost",
  };
  let webPushConfiguration: "active" | "missing" | "invalid" = "missing";
  let webPushConfigurationDetail = "This host has no VAPID keypair. Run the setup command, then restart Ponderosa.";
  let webPushSender: WebPushSender | undefined;
  if (Boolean(vapid.publicKey) !== Boolean(vapid.privateKey)) {
    webPushConfiguration = "invalid";
    webPushConfigurationDetail = "The host VAPID configuration is incomplete. Regenerate the protected configuration file.";
  } else if (vapid.publicKey && vapid.privateKey) {
    try {
      if (!opts.webPush?.sender) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
      webPushSender = opts.webPush?.sender ?? {
        async send(subscription, payload, options) {
          await webpush.sendNotification(subscription, payload, options);
        },
      };
      webPushConfiguration = "active";
      webPushConfigurationDetail = "Host VAPID configuration is active.";
    } catch {
      webPushConfiguration = "invalid";
      webPushConfigurationDetail = "The host VAPID configuration is invalid. Regenerate the protected configuration file.";
    }
  }
  const webPushConfigured = webPushConfiguration === "active";
  const webPushDelivery = webPushSender ? new WebPushDeliveryManager({
    store: workspace,
    sender: webPushSender,
    onWorkspaceEvents: publishWorkspaceSince,
    ...(opts.webPush?.retryDelaysMs ? { retryDelaysMs: opts.webPush.retryDelaysMs } : {}),
    ...(opts.webPush?.now ? { now: opts.webPush.now } : {}),
    ...(opts.webPush?.setTimer ? { setTimer: opts.webPush.setTimer } : {}),
    ...(opts.webPush?.clearTimer ? { clearTimer: opts.webPush.clearTimer } : {}),
  }) : undefined;
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
  const managementPlans = new Map<string, ManagementPlan>();
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
      /^\/api\/conversations\/[^/]+\/messages\/[^/]+\/corrections$/u.test(pathname) ||
      /^\/api\/requests\/[^/]+\/retry$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/agents$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/import-agents$/u.test(pathname) ||
      /^\/api\/projects\/[^/]+\/message-deliveries\/[^/]+\/(?:retry|cancel)$/u.test(pathname) ||
      /^\/api\/agents\/[^/]+\/triggers$/u.test(pathname) ||
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
    linkPreviewMaxHttpPerRegistration,
    linkPreviewMaxIdleMs,
    linkPreviewMaxPathBytes,
    linkPreviewOwned,
    linkPreviews,
    linkPreviewTtlMs,
    linkPreviewUpgrade,
    linkPreviewWss,
    registerRoutes: registerLinkPreviewRoutes,
  } = createLinkPreviewService({
    options: opts.linkPreviewScheduling,
    store,
    activeRuns,
    ownsActiveRun: (agentId, run) => ownsActiveRun(agentId, run),
    linkFaviconLoader: opts.linkFaviconLoader,
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
  const providerUsage = new ProviderUsageCache(opts.dataDir);
  const providerEnabled = (engineId: string): boolean => workspace.getPreferences().providerAvailability[engineId] !== false;
  const {
    agentWorkProjection,
    createOperationalNotification,
    projectWorkspaceNotificationKey,
    reconcileCommunicationFailureNotifications,
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
  const cancelAgentDecisions = (agentIds: Iterable<string>): void => {
    const cursor = workspace.cursor();
    for (const agentId of agentIds) for (const decision of workspace.cancelDecisionsForAgent(agentId)) {
      coordinationV3.releaseDecisionQuestionSuspensions(decision.id);
      const notification = workspace.listNotifications().find((item) => item.dedupeKey === `decision:${decision.id}` && (item.status ?? "open") === "open");
      if (notification) workspace.setNotificationStatus(notification.id, "resolved");
    }
    publishWorkspaceSince(cursor);
  };
  const deletionRuntimeTerminationTimeoutMs = Math.max(
    1,
    opts.agentDeletionCleanupFaults?.runtimeTerminationTimeoutMs ?? 5_000,
  );
  const awaitRuntimeTerminationOperation = async (operation: Promise<void>, label: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), deletionRuntimeTerminationTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const projectDeletionCleanupTimeoutMs = Math.max(1, opts.projectDeletionCleanupTimeoutMs ?? 5_000);
  const awaitProjectDeletionBarrier = async (operation: Promise<unknown>, label: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation.then(() => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), projectDeletionCleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const runtimeTerminationAttempts = new Map<object, Promise<string | undefined>>();
  const terminateRuntimeHandle = async (
    agentId: string,
    run: ActiveRun | undefined,
    runtime: PersistentRuntime | undefined,
    reason = "provider cancellation",
    projectId?: string,
  ): Promise<string | undefined> => {
    const session = runtime?.session ?? run?.runtimeSession;
    const handle = session ?? run?.completion;
    if (!handle) return undefined;
    const existing = runtimeTerminationAttempts.get(handle);
    if (existing) return existing;
    const attempt = (async (): Promise<string | undefined> => {
      if (!session) {
        try {
          await awaitRuntimeTerminationOperation(run!.completion!, `${agentId} runtime cancellation`);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : "runtime cancellation was not acknowledged";
        }
      }
      if (runtime) detachPersistentRuntime(agentId, runtime, reason, projectId);
      let interruptError: string | undefined;
      try {
        await awaitRuntimeTerminationOperation(session.interrupt(), `${agentId} runtime interrupt`);
      } catch (error) {
        // close() is the authoritative termination acknowledgement. Retain
        // interrupt detail only when close also fails.
        interruptError = error instanceof Error ? error.message : "runtime interrupt failed";
      }
      try {
        await awaitRuntimeTerminationOperation(
          runtime
            ? teardownPersistentRuntime(agentId, runtime, reason, projectId)
            : session.close(),
          `${agentId} runtime close`,
        );
        return undefined;
      } catch (error) {
        const closeError = error instanceof Error ? error.message : "runtime close failed";
        return interruptError ? `${interruptError}; ${closeError}` : closeError;
      }
    })();
    runtimeTerminationAttempts.set(handle, attempt);
    try { return await attempt; }
    finally {
      if (runtimeTerminationAttempts.get(handle) === attempt) runtimeTerminationAttempts.delete(handle);
    }
  };
  const processAgentDeletionCleanup = async (receipt: import("@ponderosa/agents").AgentDeletionReceipt): Promise<boolean> => {
    if (receipt.serverCleanupCompleted) return true;
    try { await opts.agentDeletionCleanupFaults?.beforeServerCleanup?.(receipt.id); }
    catch (error) {
      try { store.recordAgentDeletionCleanupError(receipt.id, error instanceof Error ? error.message : "injected cleanup failure"); }
      catch { /* the receipt itself remains pending */ }
      return false;
    }
    const errors: string[] = [];
    try { cancelAgentDecisions(receipt.deletedAgentIds); }
    catch (error) { errors.push(error instanceof Error ? error.message : "Decision cleanup failed"); }
    const deletedAgentIds = new Set(receipt.deletedAgentIds);
    await Promise.allSettled(receipt.deletedAgentIds.flatMap((agentId) => {
      const session = activeRuns.get(agentId)?.runtimeSession;
      return session ? [Promise.resolve().then(() => awaitRuntimeTerminationOperation(
        session.interrupt(),
        `${agentId} runtime interrupt`,
      ))] : [];
    }));
    try {
      await awaitRuntimeTerminationOperation(
        drainProviderRuntimeAuthority("Agent deletion", deletedAgentIds),
        "Agent deletion runtime close",
      );
    } catch (error) {
      const details = error instanceof AggregateError
        ? error.errors.map((item) => item instanceof Error ? item.message : String(item)).join("; ")
        : undefined;
      errors.push(error instanceof Error
        ? `${error.message}${details ? `: ${details}` : ""}`
        : "Agent deletion provider authority drain failed");
    }
    for (const agentId of receipt.deletedAgentIds) {
      try {
        subscribers.delete(agentId);
        scheduledSessionRollovers.delete(agentId);
        contextRolloverPending.delete(agentId);
      } catch (error) {
        errors.push(`${agentId}: ${error instanceof Error ? error.message : "runtime cleanup failed"}`);
      }
      try {
        workspace.deleteDraft(`agent:${agentId}`);
        await fs.rm(draftAttachmentSurfaceDir(`agent:${agentId}`), { recursive: true, force: true });
      } catch (error) {
        errors.push(`${agentId}: ${error instanceof Error ? error.message : "draft cleanup failed"}`);
      }
    }
    try { contextCursors.deleteAgents(new Set(receipt.deletedAgentIds)); }
    catch (error) { errors.push(error instanceof Error ? error.message : "context cleanup failed"); }
    try { await triggerSources.refresh(); }
    catch (error) { errors.push(error instanceof Error ? error.message : "Trigger refresh failed"); }
    if (errors.length > 0) {
      try { store.recordAgentDeletionCleanupError(receipt.id, errors.join("; ")); }
      catch { /* the durable receipt remains pending for startup reconciliation */ }
      try {
        createOperationalNotification({
          dedupeKey: `agent-deletion:${receipt.id}:cleanup-pending`,
          category: "system",
          severity: "attention",
          title: "Agent deletion cleanup needs attention",
          body: `The Agents were deleted, but runtime or background cleanup is still retrying. ${errors.join("; ").slice(0, 1_000)}`,
          projectId: receipt.projectId,
        });
      } catch { /* the durable receipt remains the authoritative retry signal */ }
      return false;
    }
    try { store.markAgentDeletionServerCleanupComplete(receipt.id); }
    catch (error) {
      try { store.recordAgentDeletionCleanupError(receipt.id, error instanceof Error ? error.message : "could not complete deletion receipt"); }
      catch { /* startup reconciliation will retry */ }
      return false;
    }
    try { resolveOperationalNotification(`agent-deletion:${receipt.id}:cleanup-pending`); }
    catch { /* notification repair cannot reopen completed provider cleanup */ }
    try { coordinationV3Scheduler.notify(); }
    catch { /* scheduler polling and restart reconciliation remain authoritative */ }
    // Live invalidation is best effort after the durable cleanup receipt is
    // complete. A WebSocket publication failure cannot reopen cleanup.
    try { appendWorkspace({ type: "project_changed", projectId: receipt.projectId, action: "updated" }); }
    catch { /* clients reconcile from durable state on reconnect */ }
    return true;
  };
  const commitAgentDeletion = async (
    rootAgentIds: string[],
    previewHash: string,
    authorization?: import("@ponderosa/agents").AgentManagementAuthorization,
  ): Promise<CommitAgentDeletionResponse> => {
    const previous = store.getAgentDeletionReceiptByPreviewHash(previewHash);
    if (previous) {
      const normalized = [...new Set(rootAgentIds)].sort();
      if (JSON.stringify(normalized) !== JSON.stringify(previous.rootAgentIds)) {
        throw new Error("deletion receipt does not match the requested roots");
      }
      if (!previous.storageCleanupCompleted) {
        try { store.finishAgentDeletionStorageCleanup(previous); }
        catch (error) { store.recordAgentDeletionCleanupError(previous.id, error instanceof Error ? error.message : "storage cleanup failed"); }
      }
      await processAgentDeletionCleanup(store.getAgentDeletionReceiptByPreviewHash(previewHash)!);
      const refreshed = store.getAgentDeletionReceiptByPreviewHash(previewHash)!;
      return {
        deleted: true,
        deletedAgentIds: refreshed.deletedAgentIds,
        deletionReceiptId: refreshed.id,
        cleanupPending: !(refreshed.storageCleanupCompleted && refreshed.serverCleanupCompleted),
        replayed: true,
      };
    }
    const current = store.previewAgentDeletion(rootAgentIds);
    if (current.previewHash !== previewHash) throw new AgentDeletionConflictError(current);
    if (authorization) store.sqlite.transaction(() => store.authorizeAgentManagementPlan(
      authorization,
      current.affectedAgents.map((agent) => agent.id),
      false,
    ))();
    const expectedAgentIds = current.affectedAgents.map((agent) => agent.id);
    if (expectedAgentIds.some((agentId) => deletingAgentIds.has(agentId))) {
      throw new AgentDeletionConflictError(store.previewAgentDeletion(current.rootAgentIds));
    }
    // Reserve the exact confirmed topology before the first await. All server
    // mutation paths reject a reserved Agent, so cleanup cannot open a gap in
    // which the previewed cascade changes before the atomic store commit.
    expectedAgentIds.forEach((agentId) => deletingAgentIds.add(agentId));
    let committed: AgentDeletionPreviewDto;
    try {
      for (const agentId of expectedAgentIds) {
        closeLinkPreviewsForAgent(agentId, "agent deleted");
        const run = activeRuns.get(agentId);
        if (run) await closeRunBrowser(agentId, run, "agent_deleted");
      }
      committed = store.deleteAgentSubtrees(
        current.rootAgentIds,
        previewHash,
        (agentId) => coordinationV3.handleAgentDeletion(agentId),
        authorization,
      );
    } catch (error) {
      expectedAgentIds.forEach((agentId) => deletingAgentIds.delete(agentId));
      throw error;
    }
    const deletedAgentIds = new Set(committed.affectedAgents.map((agent) => agent.id));
    try {
      const receipt = store.getAgentDeletionReceiptByPreviewHash(previewHash)!;
      await processAgentDeletionCleanup(receipt);
    } finally {
      deletedAgentIds.forEach((agentId) => deletingAgentIds.delete(agentId));
    }
    const receipt = store.getAgentDeletionReceiptByPreviewHash(previewHash)!;
    return {
      deleted: true,
      deletedAgentIds: [...deletedAgentIds],
      deletionReceiptId: receipt.id,
      cleanupPending: !(receipt.storageCleanupCompleted && receipt.serverCleanupCompleted),
    };
  };
  for (const engineId of engines.keys()) {
    const denial = engineAvailability.denial(engineId);
    if (denial && providerEnabled(engineId)) createOperationalNotification({
      dedupeKey: `provider:${engineId}:unavailable`,
      category: "provider",
      severity: "attention",
      title: `${engines.get(engineId)?.adapter.displayName ?? engineId} is unavailable`,
      body: `${denial.detail ?? "The provider rejected runtime access."} Queued work is held until access is explicitly rechecked or a successful authorized Run proves recovery.`,
      action: { kind: "open_settings", targetId: engineId },
    });
    if (!providerEnabled(engineId)) resolveOperationalNotification(`provider:${engineId}:unavailable`);
  }
  const contextCursors = new ContextCursorStore(opts.dataDir);
  const {
    browserScopeForRun,
    browserSessions,
    closeRunBrowser,
    projectBrowserDto,
    projectBrowserGrants,
    projectBrowserScope,
    projectBrowserSessions,
  } = createBrowserAuthority({
    dataDir: opts.dataDir,
    driverFactory: opts.browserDriverFactory,
    store,
    activeRuns,
    publish: (agentId, stored) => publish(agentId, stored),
    persistRuntimeEvent: (agentId, run, event) => persistRuntimeEvent(agentId, run, event as LogEvent),
  });
  const managedWorkspacesRoot = path.resolve(opts.dataDir, "workspaces");
  const projectFolderPathBoundary = createProjectFolderPathBoundary({
    managedWorkspacesRoot,
    allowedBrowseRoots: opts.allowedBrowseRoots,
  });
  const drafts = new DraftService(opts.dataDir, store, workspace);
  const normalizedDraftOwner = (value: unknown) => drafts.normalizedOwner(value);
  const draftAttachmentSurfaceDir = (draftId: string) => drafts.surfaceDir(draftId);
  const draftAttachmentFiles = (draftId: string, ownerId: string, id: string) =>
    drafts.files(draftId, ownerId, id);
  const readDraftAttachment = (draftId: string, ownerId: string, id: string) =>
    drafts.read(draftId, ownerId, id);
  const validDraftId = (draftId: string) => drafts.validId(draftId);
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
  const deletingProjectIds = new Set(store.listPendingProjectDeletions().map((entry) => entry.projectId));
  const deletingAgentIds = new Set<string>([...deletingProjectIds].flatMap((projectId) =>
    store.listAgents(projectId).map((agent) => agent.id)));
  const rejectQuarantinedTriggerMutation = (
    target: { projectId: string; agentId: string },
    reply: FastifyReply,
  ): boolean => {
    if (!deletingProjectIds.has(target.projectId) && !deletingAgentIds.has(target.agentId)) return false;
    void reply.code(409).send({ error: "Trigger owner deletion is in progress" });
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
    messageLifecycleFaults: opts.messageLifecycleFaults,
    webPushConfigured,
    webPushDelivery,
    publishWorkspaceSince,
    appendWorkspace,
    isClosed: () => closed,
  });
  const executionLeaseMs = opts.executionLeaseScheduling?.leaseMs ?? 6 * 60 * 1000;
  const executionHeartbeatMs = opts.executionLeaseScheduling?.heartbeatMs ?? Math.max(1, Math.floor(executionLeaseMs / 3));
  // Once provider execution is claimed, its scheduler fence must remain valid
  // for at least the host execution lease. A shorter dispatch lease is useful
  // before acceptance but must never expire healthy provider work.
  const coordinationV3LeaseMs = Math.max(opts.communicationV3?.leaseMs ?? executionLeaseMs, executionLeaseMs);
  const executionLeaseNow = opts.executionLeaseScheduling?.now ?? Date.now;
  const setExecutionLeaseTimer = opts.executionLeaseScheduling?.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearExecutionLeaseTimer = opts.executionLeaseScheduling?.clearTimer ?? clearTimeout;
  const leaseExpiry = () => new Date(executionLeaseNow() + executionLeaseMs).toISOString();
  const runtimeStallAfterMs = opts.runtimeEventFaults?.stallAfterMs ?? 30_000;
  const runtimeIdleTtlMs = opts.runtimeSessionScheduling?.idleTtlMs ?? 90_000;
  const configuredMaxIdleSessions = Number.parseInt(process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS ?? "", 10);
  const requestedMaxIdleSessions = opts.runtimeSessionScheduling?.maxIdleSessions ?? configuredMaxIdleSessions;
  const runtimeMaxIdleSessions = Number.isInteger(requestedMaxIdleSessions) && requestedMaxIdleSessions >= 0
    ? requestedMaxIdleSessions
    : 0;
  const runtimeSessionNow = opts.runtimeSessionScheduling?.now ?? Date.now;
  const setRuntimeIdleTimer = opts.runtimeSessionScheduling?.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearRuntimeIdleTimer = opts.runtimeSessionScheduling?.clearTimer ?? clearTimeout;
  const runtimeAuthorityRetryBaseMs = Math.max(1, opts.runtimeAuthorityRetryScheduling?.baseDelayMs ?? 500);
  const runtimeAuthorityRetryMaxMs = Math.max(runtimeAuthorityRetryBaseMs, opts.runtimeAuthorityRetryScheduling?.maxDelayMs ?? 30_000);
  const runtimeAuthorityRetryRandom = opts.runtimeAuthorityRetryScheduling?.random ?? Math.random;
  const setRuntimeAuthorityRetryTimer = opts.runtimeAuthorityRetryScheduling?.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearRuntimeAuthorityRetryTimer = opts.runtimeAuthorityRetryScheduling?.clearTimer ?? clearTimeout;

  const {
    cancelRuntimeIdleClose,
    capabilityMatchesCleanupRun,
    capabilityOwnsAuthoritativeRun,
    clearRuntimeAuthorityRetry,
    clearRuntimeAuthorityRetryIfUnblocked,
    detachPersistentRuntime,
    drainProviderRuntimeAuthority,
    ownsActiveRun,
    ownsActiveRunForAuditDrain,
    ownsV3Run,
    pendingRuntimeAuthorityCount,
    persistentRootExited,
    persistentRuntimeForTermination,
    reconcileAgentRuntimeAuthority,
    runAuthorization,
    scheduleRuntimeAuthorityRetry,
    scheduleRuntimeIdleClose,
    teardownOneShotRuntime,
    teardownOpeningRuntime,
    teardownPersistentRuntime,
    teardownPersistentRuntimeInBackground,
    trimIdleRuntimeSessions,
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
    generatedArtifactMediaType,
    normalizeProviderFileDiff,
    normalizeRuntimeFileChange,
    persistRuntimeEvent,
    receiveRuntimeEvent,
    releaseActiveRun,
    renewExecutionLease,
    scheduleRuntimeLivenessHeartbeat,
    transitionRun,
    waitBeforeRuntimePersist,
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
    withMessagePresentation,
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
    isClosed: () => closed,
  });

  const app = Fastify({
    bodyLimit: ASSET_LIMITS.maxRequestBytes,
    // Startup recovery intentionally completes before the listener accepts work.
    // Large durable test datasets can require several minutes to reconcile, so
    // keep the boundary bounded without forcing a restart loop.
    pluginTimeout: 10 * 60_000,
    logger: opts.logger === false ? false : {
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-ponderosa-prompt-access"],
        censor: "[REDACTED]",
      },
    },
  }) as unknown as PonderosaServer;
  const limits = { ...ASSET_LIMITS, maxAttachmentsPerMessage: ASSET_LIMITS.maxAssetsPerMessage };
  const serverContext: ServerContext = { opts, documentationReferences, limits, agentDetail, store, tokenUsage };
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
  });
  app.server.on("upgrade", linkPreviewUpgrade);
  const coordinationV3Scheduler = createCoordinationScheduler(app, {
    opts,
    store,
    assets,
    coordinationV3,
    workspace,
    engines,
    activeRuns,
    runtimeAuthorities,
    engineAvailability,
    agentMessageCapabilities,
    scheduledSessionRollovers,
    coordinationV3WorkerId,
    coordinationV3LeaseMs,
    v3DispatchKey,
    appendWorkspace,
    closeLinkPreviewsForAgent,
    providerEnabled,
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
      if (trigger) appendWorkspace({ type: "trigger_changed", projectId: trigger.projectId, agentId: trigger.agentId, triggerId, action: "occurrence" });
    },
    onSourceFailure: ({ trigger, kind, error }) => {
      createOperationalNotification({
        dedupeKey: `trigger:${trigger.id}:${kind === "watcher" ? "watcher-failed" : "filesystem-persistence"}`,
        category: "trigger",
        severity: "attention",
        title: kind === "watcher" ? `${trigger.name} filesystem watcher stopped` : `${trigger.name} could not persist filesystem activity`,
        body: kind === "watcher"
          ? `The Trigger was disabled after its Project watcher failed: ${error}`
          : `Filesystem activity remains durably pending when possible, but the latest watcher event could not be persisted: ${error}`,
        projectId: trigger.projectId,
        conversationId: trigger.conversationId,
        action: { kind: "open_agent", targetId: trigger.agentId },
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

  const { reconcileRuntimeCommunicationProjections } = createCommunicationProjectionReconciler({
    store,
    coordinationV3,
    assets,
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
    agentMessageCapabilities,
    deletingAgentIds,
    validLauncherSession,
    artifactFilesystemError,
    isArtifactDependentWorkIntake,
  });

  registerServerLifecycle(app, {
    opts,
    store,
    assets,
    coordinationV3,
    workspace,
    artifactFilesystem,
    coordinationV3WorkerId,
    activeRuns,
    runtimeAuthorities,
    agentMessageCapabilities,
    projectBrowserGrants,
    browserSessions,
    projectBrowserSessions,
    providerUsage,
    webPushDelivery,
    coordinationV3Scheduler,
    triggerSources,
    processAgentDeletionCleanup,
    reconcileRuntimeCommunicationProjections,
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
  });

  const {
    appendBlockedMentionWarnings,
    appendCollaborationSystemNotice,
    notifyManagerOfChildFailure,
    projectBroadcastToAgentAudit,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    publish,
    resolveCollaborationIntents,
    resolveExplicitCollaborationIntents,
    subscribe,
    agentCanReadDocument,
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
    cachedModelOptions,
    publicManagementOperations,
    commitAgentDeletion,
    assets,
    resultCursorSecret,
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
    agentMessageCapabilities,
    scheduledSessionRollovers,
    launcherNow,
    launcherRandomToken,
    launcherBootstrapTtlMs,
    launcherSessionTtlMs,
    launcherBootstraps,
    launcherSessions,
    purgeLauncherSecurityState,
    networkSecurity,
    artifactFilesystem,
    artifactFilesystemError,
    communicationReconciliation,
    coordinationV3Scheduler,
    isClosed: () => closed,
    setDeploymentDraining: deploymentControl.setDraining,
    deploymentDrainSnapshot,
    drainDeploymentIdleAuthorities,
    refreshTriggerSources: () => triggerSources.refresh(),
    capabilityOwnsAuthoritativeRun,
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
    drainDeploymentIdleAuthorities,
    isClosed: () => closed,
    isDeploymentDraining: deploymentControl.isDraining,
    notifyScheduler: () => coordinationV3Scheduler.notify(),
    setMaxConcurrentRuns: (value) => coordinationV3Scheduler.setMaxConcurrentRuns(value),
  });

  return app;
}
