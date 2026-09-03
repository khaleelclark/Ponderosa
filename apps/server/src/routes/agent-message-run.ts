import { createHash, randomUUID } from "node:crypto";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  unicodeCodePointLength,
  type AssetDto,
  type CommunicationEvent,
  type ConversationMessageDto,
  type EngineCapabilities,
} from "@ponderosa/core";
import {
  type AgentStore,
  type CoordinationV3Store,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { MAX_AGENT_MENTION_REPLAY_WINDOW } from "../agent-mentions.js";
import {
  ASSET_LIMITS,
  AssetError,
  type AssetStore,
} from "../assets.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TEXT_LENGTH,
  agentMessageEndpoint,
  type ActiveRun,
  type AgentMessageCapability,
  type AgentRuntimeAuthority,
  type CreateServerOptions,
  type EngineRegistration,
  type OneShotRuntimeTeardown,
  type OpeningPersistentRuntime,
  type PendingTurn,
  type PersistentRuntime,
  type PersistentRuntimeTeardown,
} from "../app-contracts.js";
import type { createAgentEventService } from "../agent-event-service.js";
import type { createCommunicationArtifactAuthority } from "../communication-artifacts.js";
import {
  ProviderAdapterBoundaryError,
  type createEngineControlPlane,
} from "../engine-control-plane.js";
import { projectProviderCapabilities } from "../provider-success-projection.js";
import type { EngineAvailabilityStore } from "../engine-availability-store.js";
import type { createRuntimeAuthority } from "../runtime-authority.js";
import type { createRuntimeEventAuthority } from "../runtime-event-authority.js";
import { secretEqual } from "../security.js";
import type { createServerReadModels } from "../server-read-models.js";
import type { createOperationalNotifications } from "../operational-notifications.js";
import type { createCommunicationDocumentAuthority } from "../communication-document-authority.js";
import type { ContextCursorStore } from "../context-cursors.js";
import type { RuntimeElicitationBroker } from "../runtime-elicitation-broker.js";
import type { AgentWorkingCopyService } from "../agent-working-copy-service.js";
import type { ProviderProcessAuthority } from "../provider-process-authority.js";
import {
  concreteRuntimeSelection,
  normalizedRuntimeSelection,
  runtimeSelectionError,
  runtimeSpeedSelectionError,
} from "../runtime-selection.js";
import type { DraftService } from "./drafts.js";
import {
  conversationDeliveryRequestFingerprint,
  type PreparedCommunicationArtifact,
} from "./conversation-deliveries.js";
import { cleanupRuntimeAttachments } from "../runtime-attachments.js";
import { leaseAgentDelivery, leaseConversationDelivery } from "../delivery-leases.js";
import { prepareAgentRun } from "./agent-run-preparation.js";
import { startProviderRunExecution } from "./provider-run-executor.js";

type ArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;
type EngineControlPlane = ReturnType<typeof createEngineControlPlane>;
type RuntimeAuthority = ReturnType<typeof createRuntimeAuthority>;
type RuntimeEventAuthority = ReturnType<typeof createRuntimeEventAuthority>;
type AgentEventService = ReturnType<typeof createAgentEventService>;
type ServerReadModels = ReturnType<typeof createServerReadModels>;
type OperationalNotifications = ReturnType<typeof createOperationalNotifications>;
type CommunicationDocumentAuthority = ReturnType<typeof createCommunicationDocumentAuthority>;

export function recoverRequiredReplyPublications(
  coordinationV3: CoordinationV3Store,
  runId: string,
  agentId: string,
): {
  fingerprints: Record<string, string>;
  communicationEventId?: string;
} {
  const fingerprints: Record<string, string> = {};
  const communicationEventIds = new Set<string>();
  for (const obligation of coordinationV3.requiredReplyObligationsForRun(runId)) {
    if (obligation.state !== "satisfied" || !obligation.satisfiedCommunicationId) continue;
    const runtime = coordinationV3.runtimeCommunication(obligation.satisfiedCommunicationId);
    const payload = runtime?.payload && typeof runtime.payload === "object" && !Array.isArray(runtime.payload)
      ? runtime.payload as Record<string, unknown>
      : undefined;
    const communication = payload?.communication && typeof payload.communication === "object"
      ? payload.communication as Partial<CommunicationEvent>
      : undefined;
    const fingerprint = payload?.requiredReplyFingerprint;
    if (
      typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      communication?.eventId !== obligation.satisfiedCommunicationId ||
      communication.sender?.kind !== "agent" ||
      communication.sender.agentId !== agentId ||
      communication.sender.executionId !== runId
    ) continue;
    const authorityKey = JSON.stringify({
      intent: obligation.replyAuthority.intent,
      ...(obligation.replyAuthority.recipientAgentIds?.length
        ? { recipientAgentIds: [...obligation.replyAuthority.recipientAgentIds].sort() }
        : {}),
    });
    const existing = fingerprints[authorityKey];
    if (existing && existing !== fingerprint) {
      throw new Error("durable required-reply publications conflict for one route");
    }
    fingerprints[authorityKey] = fingerprint;
    communicationEventIds.add(obligation.satisfiedCommunicationId);
  }
  return {
    fingerprints,
    ...(communicationEventIds.size === 1
      ? { communicationEventId: [...communicationEventIds][0] }
      : {}),
  };
}

export type AgentMessageRunContext =
  Pick<EngineControlPlane,
    "cachedModelOptions" | "discoverEngineCapabilities" | "discoverEngineModelCatalog" | "markEngineModelUnavailable" |
    "reportRuntimeCapabilitiesChanged" | "refreshProviderUsageAfterRun"> &
  Pick<RuntimeAuthority,
    "cancelRuntimeIdleClose" | "ownsActiveRun" | "ownsActiveRunForAuditDrain" |
    "persistentRootExited" | "reconcileAgentRuntimeAuthority" |
    "retireCompletedContextRolloverSession" | "scheduleRuntimeIdleClose" |
    "teardownOneShotRuntime" | "teardownOpeningRuntime" | "teardownPersistentRuntime" |
    "teardownPersistentRuntimeInBackground"> &
  Pick<RuntimeEventAuthority,
    "claimActiveRun" | "persistRuntimeEvent" | "receiveRuntimeEvent" | "releaseActiveRun" |
    "renewExecutionLease" | "scheduleRuntimeLivenessHeartbeat"> &
  Pick<ArtifactAuthority,
    "communicationArtifactAccess" | "prepareUserCommunicationText" |
    "projectCommunicationArtifact" | "runtimeArtifactMetadata"> &
  Pick<AgentEventService, "projectCommunicationToAgentAudit" | "publish"> &
  Pick<ServerReadModels,
    "canonicalConversationContext" | "publishCoordinationV3Changed" |
    "publishMessageDeliveryChanged" | "teamDirectory"> &
  Pick<CommunicationDocumentAuthority, "agentCanReadRuntimeArtifact"> &
  Pick<OperationalNotifications,
    "createOperationalNotification" | "resolveOperationalNotification"> & {
    opts: CreateServerOptions;
    store: AgentStore;
    workspace: WorkspaceStore;
    coordinationV3: CoordinationV3Store;
    assets: AssetStore;
    drafts: DraftService;
    engines: ReadonlyMap<string, EngineRegistration>;
    engineAvailability: EngineAvailabilityStore;
    contextCursors: ContextCursorStore;
    activeRuns: Map<string, ActiveRun>;
    agentMessageCapabilities: Map<string, AgentMessageCapability>;
    runtimeAuthorities: Map<string, AgentRuntimeAuthority>;
    organizationEnvelopeStates: Map<string, { sessionId: string; hash: string }>;
    scheduledSessionRollovers: Map<string, string>;
    contextRolloverPending: Map<string, {
      sessionId: string;
      usedTokens: number;
      at: string;
    }>;
    engineModelCatalogCache: EngineControlPlane["engineModelCatalogCache"];
    deletingProjectIds: ReadonlySet<string>;
    deletingAgentIds: ReadonlySet<string>;
    conversationDeletionInProgress(conversationId: string): boolean;
    attachmentDeletionInProgress(agentId: string, attachmentId: string): boolean;
    conversationDeliveryLeases: Map<string, number>;
    agentDeliveryLeases: Map<string, number>;
    assetReconciliationInProgress(agentId: string): boolean;
    coordinationV3WorkerId: string;
    v3DispatchKey: string;
    deploymentDraining(): boolean;
    isClosed(): boolean;
    providerEnabled(engineId: string): boolean;
    leaseExpiry(): string;
    reusableRuntime(agentId: string): PersistentRuntime | undefined;
    openingRuntime(agentId: string): OpeningPersistentRuntime | undefined;
    closingRuntime(agentId: string): PersistentRuntimeTeardown | undefined;
    oneShotRuntime(agentId: string, runId: string): OneShotRuntimeTeardown | undefined;
    runtimeAuthority(agentId: string, create?: boolean): AgentRuntimeAuthority | undefined;
    pruneRuntimeAuthority(agentId: string, authority: AgentRuntimeAuthority): void;
    clearAgentResumeSession(agentId: string, reason: string): void;
    assetMetadata(agentId: string, id: string): Promise<(AssetDto & {
      projectId: string;
      agentId: string;
      originalFile?: string;
      previewFile?: string;
      associatedAt?: string;
    }) | undefined>;
    recordCommunication(event: CommunicationEvent): CommunicationEvent;
    reconcileRuntimeCommunicationProjections(filter?: {
      projectId?: string;
      communicationEventId?: string;
    }): Promise<number>;
    notifyManagerOfChildFailure(agentId: string, executionId: string, failure: string): void;
    notifyScheduler(): void;
    reconcileProjectWorkspace(
      project: { id: string; hostPath: string },
      agent: { id: string; conversationId?: string },
    ): Promise<string | undefined>;
    drainDeploymentIdleAuthorities(): void;
    publishWorkspaceSince(cursor: number): void;
    runtimeElicitations: RuntimeElicitationBroker;
    providerProcessAuthority: ProviderProcessAuthority;
    workingCopies: AgentWorkingCopyService;
  };

export function registerAgentMessageRunRoute(
  app: FastifyInstance,
  runContext: AgentMessageRunContext,
): void {
  const {
    opts,
    store,
    workspace,
    coordinationV3,
    assets,
    drafts,
    engines,
    activeRuns,
    agentMessageCapabilities,
    deletingProjectIds,
    deletingAgentIds,
    conversationDeletionInProgress,
    attachmentDeletionInProgress,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    assetReconciliationInProgress,
    coordinationV3WorkerId,
    v3DispatchKey,
    leaseExpiry,
    reusableRuntime,
    assetMetadata,
    reconcileRuntimeCommunicationProjections,
    notifyScheduler,
    reconcileProjectWorkspace,
    cachedModelOptions,
    discoverEngineCapabilities,
    claimActiveRun,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    publish,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    workingCopies,
  } = runContext;

  app.post<{
    Params: { id: string };
    Body: {
      text: string;
      idempotencyKey?: string;
      model?: string;
      effort?: string;
      speed?: string;
      agentMentionDepth?: number;
      agentMentionTrail?: string[];
      sourceChannel?: "main";
      shareWithOrganization?: boolean;
      activeRunDelivery?: "steer" | "queue";
      sourceConversationId?: string;
      attachmentIds?: string[];
      draftAttachmentIds?: string[];
      draftId?: string;
      draftOwnerId?: string;
      /** Server-only Communication V3 execution identity. */
      v3SchedulerRunId?: string;
      v3FencingToken?: number;
      v3InjectionId?: string;
      /** Server-only provider-cache disposition derived from durable V3 causes. */
      v3FreshProviderSession?: boolean;
      /** Server-only durable activation bundle assembled by the scheduler. */
      v3ActivationPrompt?: string;
      /** Server-only canonical authored communication referenced by the activation. */
      v3CommunicationEventId?: string;
    };
  }>(
    "/api/agents/:id/messages",
    async (request, reply) => {
      const rawBody = request.body as unknown;
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return reply.code(400).send({ error: "message body must be an object" });
      }
      const candidate = rawBody as Record<string, unknown>;
      const allowedMessageFields = new Set([
        "text", "idempotencyKey", "model", "effort", "speed", "agentMentionDepth", "agentMentionTrail", "sourceChannel",
        "shareWithOrganization", "activeRunDelivery", "sourceConversationId",
        "attachmentIds", "draftAttachmentIds", "draftId", "draftOwnerId", "v3SchedulerRunId", "v3FencingToken", "v3InjectionId",
        "v3FreshProviderSession", "v3ActivationPrompt", "v3CommunicationEventId",
      ]);
      const unknownMessageFields = Object.keys(candidate).filter((key) => !allowedMessageFields.has(key));
      if (unknownMessageFields.length) {
        return reply.code(400).send({ error: `unknown message field(s): ${unknownMessageFields.join(", ")}` });
      }
      for (const key of ["text", "idempotencyKey", "model", "effort", "speed", "sourceConversationId", "draftId", "draftOwnerId", "v3SchedulerRunId", "v3InjectionId", "v3ActivationPrompt", "v3CommunicationEventId"] as const) {
        if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
          return reply.code(400).send({ error: `${key} must be a string` });
        }
      }
      if (candidate.agentMentionDepth !== undefined &&
          (!Number.isInteger(candidate.agentMentionDepth) || (candidate.agentMentionDepth as number) < 0)) {
        return reply.code(400).send({ error: "agentMentionDepth must be a non-negative integer" });
      }
      if (candidate.v3FencingToken !== undefined &&
          (!Number.isInteger(candidate.v3FencingToken) || (candidate.v3FencingToken as number) < 0)) {
        return reply.code(400).send({ error: "v3FencingToken must be a non-negative integer" });
      }
      for (const key of ["shareWithOrganization", "v3FreshProviderSession"] as const) {
        if (candidate[key] !== undefined && typeof candidate[key] !== "boolean") {
          return reply.code(400).send({ error: `${key} must be a boolean` });
        }
      }
      for (const key of ["agentMentionTrail", "attachmentIds", "draftAttachmentIds"] as const) {
        if (candidate[key] !== undefined &&
            (!Array.isArray(candidate[key]) || candidate[key].some((item) => typeof item !== "string"))) {
          return reply.code(400).send({ error: `${key} must be an array of strings` });
        }
      }
      if (candidate.sourceChannel !== undefined && candidate.sourceChannel !== "main") {
        return reply.code(400).send({ error: "sourceChannel must be main" });
      }
      if (candidate.activeRunDelivery !== undefined &&
          candidate.activeRunDelivery !== "steer" && candidate.activeRunDelivery !== "queue") {
        return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
      }
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const project = store.getProject(agent.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const text = request.body?.text?.trim() ?? "";
      const userMessageIdempotencyKey = request.body?.idempotencyKey?.trim();
      if (userMessageIdempotencyKey && userMessageIdempotencyKey.length > 200) {
        return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
      }
      const proposedCommunicationEventId = userMessageIdempotencyKey
        ? `user-message-${createHash("sha256").update(`${project.id}\0${agent.id}\0${userMessageIdempotencyKey}`).digest("hex")}`
        : undefined;
      const requestFingerprint = proposedCommunicationEventId
        ? conversationDeliveryRequestFingerprint({
            version: 1,
            agentId: agent.id,
            text,
            idempotencyKey: userMessageIdempotencyKey,
            model: request.body.model?.trim() ?? null,
            effort: request.body.effort?.trim() ?? null,
            speed: request.body.speed?.trim() ?? null,
            sourceChannel: request.body.sourceChannel ?? null,
            sourceConversationId: request.body.sourceConversationId ?? null,
            shareWithOrganization: request.body.shareWithOrganization === true,
            activeRunDelivery: request.body.activeRunDelivery ?? "steer",
            attachmentIds: request.body.attachmentIds ?? [],
            draftAttachmentIds: request.body.draftAttachmentIds ?? [],
            draftId: request.body.draftId ?? null,
            draftOwnerId: request.body.draftOwnerId ?? null,
            agentMentionDepth: request.body.agentMentionDepth ?? 0,
            agentMentionTrail: request.body.agentMentionTrail ?? [],
          })
        : undefined;
      const existingUserRuntime = proposedCommunicationEventId
        ? coordinationV3.runtimeCommunication(`dispatch:${proposedCommunicationEventId}:${agent.id}`)
        : undefined;
      const existingPayload = existingUserRuntime?.payload &&
        typeof existingUserRuntime.payload === "object" &&
        !Array.isArray(existingUserRuntime.payload)
        ? existingUserRuntime.payload as {
            requestFingerprint?: unknown;
            communication?: CommunicationEvent;
          }
        : undefined;
      const carriesSchedulerIdentity = [
        candidate.v3SchedulerRunId,
        candidate.v3FencingToken,
        candidate.v3InjectionId,
        candidate.v3FreshProviderSession,
        candidate.v3ActivationPrompt,
        candidate.v3CommunicationEventId,
      ].some((value) => value !== undefined);
      if (!carriesSchedulerIdentity && existingUserRuntime && existingPayload?.requestFingerprint) {
        if (existingPayload.requestFingerprint !== requestFingerprint) {
          return reply.code(409).send({ error: "runtime communication ID collision" });
        }
        const activationId = existingUserRuntime.activations
          ?.find((activation) => activation.agentId === agent.id)?.id;
        const replayConversationId = existingPayload.communication?.conversationId ?? agent.conversationId;
        const releaseReplayLease = replayConversationId
          ? leaseConversationDelivery(
              conversationDeliveryLeases,
              agentDeliveryLeases,
              replayConversationId,
              [agent.id],
            )
          : leaseAgentDelivery(agentDeliveryLeases, [agent.id]);
        try {
          await reconcileRuntimeCommunicationProjections({
            projectId: project.id,
            communicationEventId: proposedCommunicationEventId,
          });
          let position: number | undefined;
          try {
            const pending = coordinationV3.pendingActivations(project.id)
              .filter((activation) => activation.agentId === agent.id);
            const index = pending.findIndex((activation) => activation.id === activationId);
            if (index >= 0) position = index + 1;
          } catch { /* queue position remains a repairable projection */ }
          return reply.code(202).send({
            queued: true,
            ...(position !== undefined ? { position } : {}),
            ...(activationId ? { deliveryId: activationId } : {}),
            communicationEventId: proposedCommunicationEventId,
            ...((position === undefined || !activationId)
              ? { committed: true, recovering: true }
              : {}),
          });
        } catch {
          return reply.code(202).send({
            queued: true,
            ...(activationId ? { deliveryId: activationId } : {}),
            communicationEventId: proposedCommunicationEventId,
            committed: true,
            recovering: true,
          });
        } finally {
          releaseReplayLease();
        }
      }
      if (deletingAgentIds.has(request.params.id) || agent.archived) {
        return reply.code(404).send({ error: "agent not found" });
      }
      if (deletingProjectIds.has(project.id)) {
        return reply.code(409).send({ error: "Project deletion is already in progress" });
      }
      const agentConversation = agent.conversationId
        ? store.getConversation(agent.conversationId)
        : undefined;
      if (agent.conversationId && (!agentConversation || agentConversation.archived ||
          conversationDeletionInProgress(agent.conversationId))) {
        return reply.code(409).send({ error: "Agent Chat is unavailable; retry safely" });
      }
      if (assetReconciliationInProgress(agent.id)) {
        return reply.code(409).send({ error: "Agent asset maintenance is in progress; retry safely" });
      }
      const requestedAttachmentIds = request.body?.attachmentIds ?? [];
      if (!Array.isArray(requestedAttachmentIds) ||
          requestedAttachmentIds.some((attachmentId) => typeof attachmentId !== "string" || !attachmentId) ||
          requestedAttachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
          new Set(requestedAttachmentIds).size !== requestedAttachmentIds.length) {
        return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique attachments are allowed` });
      }
      if (requestedAttachmentIds.some((attachmentId) =>
        attachmentDeletionInProgress(agent.id, attachmentId))) {
        return reply.code(409).send({ error: "Asset deletion is in progress; retry safely" });
      }
      const releaseAgentDelivery = agent.conversationId
        ? leaseConversationDelivery(
            conversationDeliveryLeases,
            agentDeliveryLeases,
            agent.conversationId,
            [agent.id],
          )
        : leaseAgentDelivery(agentDeliveryLeases, [agent.id]);
      try {
      const priorRuns = store.getRuns(agent.id);
      const latestRun = priorRuns.at(-1);
      // Saved Agent runtime settings are next-Run defaults. A message delivered
      // into an already-running Run must keep that Run's captured provider and
      // runtime selection, even if Settings changed while it was working.
      const activeRunSnapshot = latestRun?.status === "running" ? latestRun : undefined;
      const runtimeEngineId = activeRunSnapshot?.engine ?? agent.activeEngine;
      const engine = engines.get(runtimeEngineId);
      if (!engine) return reply.code(400).send({ error: "unknown engine" });
      const internalV3Dispatch = typeof request.headers["x-ponderosa-v3-dispatch"] === "string" &&
        secretEqual(request.headers["x-ponderosa-v3-dispatch"], v3DispatchKey);
      const v3SchedulerRunId = request.body.v3SchedulerRunId;
      const v3FencingToken = request.body.v3FencingToken;
      const v3InjectionId = request.body.v3InjectionId;
      const v3FreshProviderSession = request.body.v3FreshProviderSession;
      const v3ActivationPrompt = request.body.v3ActivationPrompt;
      const v3CommunicationEventId = request.body.v3CommunicationEventId;
      if ((v3SchedulerRunId !== undefined || v3FencingToken !== undefined || v3InjectionId !== undefined ||
          v3FreshProviderSession !== undefined || v3ActivationPrompt !== undefined ||
          v3CommunicationEventId !== undefined) && !internalV3Dispatch) {
        return reply.code(403).send({ error: "V3 scheduler identity is server-controlled" });
      }
      if (internalV3Dispatch && (!v3SchedulerRunId || !Number.isSafeInteger(v3FencingToken) || !v3InjectionId ||
          typeof v3FreshProviderSession !== "boolean" || !v3ActivationPrompt)) {
        return reply.code(400).send({ error: "V3 scheduler run, fencing token, injection ID, and provider-session disposition are required" });
      }
      const sourceConversationId = request.body.sourceConversationId;
      if (sourceConversationId !== undefined && agent.conversationId !== sourceConversationId) {
        return reply.code(400).send({ error: "conversation does not belong to agent" });
      }
      if (request.body.sourceChannel === "main" && sourceConversationId) {
        const sourceMaster = store.getConversation(sourceConversationId);
        if (!sourceMaster || sourceMaster.archived) {
          return reply.code(400).send({ error: "archived conversations cannot route new turns" });
        }
      }
      const shareWithOrganization = request.body.shareWithOrganization === true;
      if (shareWithOrganization && (request.body.sourceChannel !== "main" || !sourceConversationId)) {
        return reply.code(400).send({ error: "shared turns must originate from a Conversation" });
      }
      const mentionDepth = request.body.agentMentionDepth;
      if (
        mentionDepth !== undefined &&
        (!Number.isInteger(mentionDepth) || mentionDepth < 0 || mentionDepth > MAX_AGENT_MENTION_REPLAY_WINDOW)
      ) {
        return reply.code(400).send({ error: "agentMentionDepth must be an integer from 0 to 64" });
      }
      const mentionTrail = request.body.agentMentionTrail ?? [];
      if (
        !Array.isArray(mentionTrail) ||
        mentionTrail.length > MAX_AGENT_MENTION_REPLAY_WINDOW ||
        mentionTrail.some((fingerprint) => typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) ||
        mentionTrail.length !== (mentionDepth ?? 0)
      ) {
        return reply.code(400).send({
          error: "agentMentionTrail must contain one relay fingerprint for each agentMentionDepth step",
        });
      }
      if (internalV3Dispatch && unicodeCodePointLength(text) > MAX_TEXT_LENGTH) {
        return reply.code(400).send({ error: "internal dispatch text must be 65536 characters or fewer" });
      }
      if (!internalV3Dispatch && Buffer.byteLength(text, "utf8") > LONG_TEXT_MAX_UTF8_BYTES) {
        return reply.code(413).send({ error: "text exceeds the 8 MiB limit" });
      }
      const stagedDraftIds = request.body?.draftAttachmentIds ?? [];
      const stagedDraftOwner = drafts.normalizedOwner(request.body?.draftOwnerId);
      const stagedDraftSurface = request.body?.draftId;
      if (!Array.isArray(stagedDraftIds) || stagedDraftIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(stagedDraftIds).size !== stagedDraftIds.length) {
        return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique draft attachments are allowed` });
      }
      if (requestedAttachmentIds.length + stagedDraftIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique attachments are allowed` });
      }
      if (stagedDraftIds.length && (!stagedDraftOwner || !stagedDraftSurface || !drafts.validId(stagedDraftSurface))) {
        return reply.code(400).send({ error: "draft surface and owner are required" });
      }
      if (!text && requestedAttachmentIds.length === 0 && stagedDraftIds.length === 0) {
        return reply.code(400).send({ error: "text or an attachment is required" });
      }
      if (internalV3Dispatch) {
        const workspaceIssue = await reconcileProjectWorkspace(project, agent);
        if (workspaceIssue) {
          return reply.code(422).send({
            code: "project_workspace_unavailable",
            error: workspaceIssue,
          });
        }
      }
      const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
      if (activeRunDelivery !== "steer" && activeRunDelivery !== "queue") {
        return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
      }
      const projectModelOptions = cachedModelOptions(engine.adapter, project.id);
      const recovered = concreteRuntimeSelection(engine.adapter, [
        activeRunSnapshot
          ? { model: activeRunSnapshot.model, effort: activeRunSnapshot.effort }
          : {
              model: agent.model ?? agent.presetSnapshot?.model,
              effort: agent.effort ?? agent.presetSnapshot?.effort,
            },
        project.defaultEngine === runtimeEngineId ? { model: project.defaultModel, effort: project.defaultEffort } : undefined,
        workspace.getPreferences().engineDefaults?.[runtimeEngineId],
      ], projectModelOptions);
      const hasModelOverride = !activeRunSnapshot && request.body.model !== undefined;
      const requestedModel = request.body.model?.trim() || undefined;
      if (hasModelOverride) {
        const modelError = runtimeSelectionError(engine.adapter, requestedModel, undefined, projectModelOptions);
        if (modelError) return reply.code(400).send({ error: modelError });
      }
      const effectiveModel = hasModelOverride ? requestedModel : recovered.model;
      const hasEffortOverride = !activeRunSnapshot && request.body.effort !== undefined;
      const requestedEffort = request.body.effort?.trim() || undefined;
      if (hasEffortOverride) {
        const effortError = runtimeSelectionError(engine.adapter, effectiveModel, requestedEffort, projectModelOptions);
        if (effortError) return reply.code(400).send({ error: effortError });
      }
      const effectiveEffort = hasEffortOverride
        ? requestedEffort
        : hasModelOverride
          ? concreteRuntimeSelection(engine.adapter, [{ model: effectiveModel }, workspace.getPreferences().engineDefaults?.[runtimeEngineId]], projectModelOptions).effort
          : normalizedRuntimeSelection(engine.adapter, effectiveModel, recovered.effort, projectModelOptions).effort;
      const hasSpeedOverride =
        !activeRunSnapshot && request.body.speed !== undefined;
      const requestedSpeed = request.body.speed?.trim() || undefined;
      if (hasSpeedOverride) {
        const speedError = runtimeSpeedSelectionError(
          engine.adapter,
          effectiveModel,
          requestedSpeed,
          projectModelOptions,
        );
        if (speedError) return reply.code(400).send({ error: speedError });
      }
      const effectiveSpeed =
        hasSpeedOverride && requestedSpeed ? requestedSpeed : "standard";
      const providerSlash = !internalV3Dispatch ? /^\/([\p{L}\p{N}_:-]+)(?:\s|$)/u.exec(text) : undefined;
      if (providerSlash) {
        const runtimeSession = activeRuns.get(agent.id)?.runtimeSession ?? reusableRuntime(agent.id)?.session;
        let catalog: EngineCapabilities;
        try {
          const rawCapabilities = await Promise.resolve(runtimeSession?.capabilities
            ? runtimeSession.capabilities()
            : engine.adapter.capabilities
              ? discoverEngineCapabilities(project.id, project.hostPath, engine.adapter, effectiveModel, false)
              : { steering: false, persistentSessions: false, commands: [], mcpServers: [], composerCapabilities: [] });
          catalog = projectProviderCapabilities(rawCapabilities);
        } catch (error) {
          throw error instanceof ProviderAdapterBoundaryError
            ? error
            : new ProviderAdapterBoundaryError(
                engine.adapter.id,
                "read runtime capabilities",
                error,
              );
        }
        const command = catalog.commands.find((candidate) => candidate.name === providerSlash[1]);
        if (!command || command.status !== "available") {
          return reply.code(409).send({
            error: command?.unavailableReason ?? `the active provider does not expose /${providerSlash[1]}`,
            catalogVersion: catalog.catalogVersion,
          });
        }
        if (command.invocation !== "prompt") {
          return reply.code(409).send({ error: `/${command.name} must be invoked through its structured provider action` });
        }
      }
      const promotedDraftAssets: AssetDto[] = [];
      try {
        for (const draftAttachmentId of stagedDraftIds) {
          const attachment = await drafts.prepared(
            stagedDraftSurface!,
            stagedDraftOwner!,
            draftAttachmentId,
          );
          if (!attachment) throw new AssetError(404, "draft attachment is missing or belongs to another draft");
          promotedDraftAssets.push(await assets.stage({
            projectId: agent.projectId,
            agentId: agent.id,
            body: attachment.body,
            prepared: attachment.prepared,
          }));
        }
      } catch (error) {
        await Promise.allSettled(promotedDraftAssets.map((attachment) => assets.remove(agent.projectId, agent.id, attachment.id)));
        if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
      let promotedDraftAssetsCommitted = false;
      try {
      const attachmentIds = [...requestedAttachmentIds, ...promotedDraftAssets.map((item) => item.id)];
      if (new Set(attachmentIds).size !== attachmentIds.length) {
        return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique attachments are allowed` });
      }
      if (attachmentIds.some((attachmentId) =>
        attachmentDeletionInProgress(agent.id, attachmentId))) {
        return reply.code(409).send({ error: "Asset deletion is in progress; retry safely" });
      }
      const attached = (await Promise.all(attachmentIds.map((id) => assetMetadata(agent.id, id))));
      if (attached.some((item) => !item || item.agentId !== agent.id)) return reply.code(404).send({ error: "asset not found" });
      const messageAttachments = (attached as NonNullable<(typeof attached)[number]>[]).map(({ projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile, associatedAt: _associatedAt, ...item }) => ({ ...item, state: "associated" as const })) as AssetDto[];
      if (messageAttachments.reduce((sum, item) => sum + item.size, 0) > ASSET_LIMITS.maxMessageBytes) return reply.code(413).send({ error: "message asset quota exceeded" });
      if (!text && messageAttachments.length === 0) return reply.code(400).send({ error: "text or an attachment is required" });
      const directMessageConversationId = sourceConversationId ?? agent.conversationId;
      const communicationEventIdentity = internalV3Dispatch
        ? undefined
        : proposedCommunicationEventId ?? randomUUID();
      const committedUserRuntime = communicationEventIdentity
        ? coordinationV3.runtimeCommunication(`dispatch:${communicationEventIdentity}:${agent.id}`)
        : undefined;
      const communicationCreatedAt = committedUserRuntime?.createdAt ?? new Date().toISOString();
      let userTextArtifact: PreparedCommunicationArtifact | undefined;
      let publishedText = text;
      let userDocument: CommunicationEvent["document"];
      if (communicationEventIdentity) {
        try {
          const prepared = await prepareUserCommunicationText({
            projectId: project.id, communicationId: communicationEventIdentity, text, createdAt: communicationCreatedAt,
          });
          publishedText = prepared.publishedText;
          userTextArtifact = prepared.artifact;
          userDocument = prepared.document;
        } catch (error) {
          const status = error instanceof AssetError ? error.statusCode : 409;
          return reply.code(status).send({ error: error instanceof Error ? error.message : "long-text artifact staging failed" });
        }
      }
      const proposedCommunication: CommunicationEvent | undefined = internalV3Dispatch
        ? undefined
        : shareWithOrganization ? {
            eventId: communicationEventIdentity!, schemaVersion: 2, projectId: project.id, conversationId: sourceConversationId!,
            sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
            audience: { kind: "organization", organizationId: project.id }, text: publishedText,
            ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
            ...(userDocument ? { document: userDocument } : {}),
            createdAt: communicationCreatedAt,
            ...(userMessageIdempotencyKey ? { idempotencyKey: `user-message:${agent.id}:${userMessageIdempotencyKey}` } : {}),
          } : {
            eventId: communicationEventIdentity!, schemaVersion: 2, projectId: project.id,
            ...((sourceConversationId ?? agent.conversationId) ? { conversationId: sourceConversationId ?? agent.conversationId } : {}),
            sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
            audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id }, text: publishedText,
            ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
            ...(userDocument ? { document: userDocument } : {}),
            createdAt: communicationCreatedAt,
            ...(userMessageIdempotencyKey ? { idempotencyKey: `user-message:${agent.id}:${userMessageIdempotencyKey}` } : {}),
          };
      const intendedCommunicationEventId = proposedCommunication?.eventId;
      let v3Intake: ReturnType<CoordinationV3Store["recordRuntimeCommunication"]> | undefined;
      if (!internalV3Dispatch && intendedCommunicationEventId && proposedCommunication) {
        try {
          v3Intake = coordinationV3.recordRuntimeCommunication({
            id: `dispatch:${intendedCommunicationEventId}:${agent.id}`,
            projectId: project.id,
            sender: proposedCommunication.sender,
            intent: proposedCommunication.intent,
            audience: proposedCommunication.audience,
            payload: {
              communication: proposedCommunication,
              ...(requestFingerprint && !committedUserRuntime ? { requestFingerprint } : {}),
              dispatch: {
                text: publishedText,
                ...(shareWithOrganization ? { conversationText: publishedText } : {}),
                conversationAttachmentIds: messageAttachments.map((attachment) => attachment.id),
                ...(userTextArtifact ? {
                  artifactId: userTextArtifact.id,
                  resultRef: `ponderosa://artifact/${userTextArtifact.id}`,
                } : {}),
                communicationEventId: intendedCommunicationEventId,
                sourceConversationId: sourceConversationId ?? null,
                sourceChannel: request.body.sourceChannel ?? null,
                shareWithOrganization,
                activeRunDelivery,
                attachments: messageAttachments.map((item) => ({
                  id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
                })),
                model: request.body.model ?? null,
                effort: request.body.effort ?? null,
                speed: request.body.speed ?? null,
              },
            },
            ...(userTextArtifact ? { artifacts: [runtimeArtifactMetadata(userTextArtifact)] } : {}),
            activation: {
              agentId: agent.id,
              kind: "human_message",
              priority: 100,
              dispatchPolicy: activeRunDelivery === "steer" ? "steer_or_run" : "next_run",
              promptClass: "human",
            },
            now: proposedCommunication.createdAt,
          });
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : "message intake failed" });
        }
      }
      const communicationEventId = internalV3Dispatch
        ? v3CommunicationEventId
        : proposedCommunication?.eventId;
      if (!internalV3Dispatch && proposedCommunication) {
        try {
          await reconcileRuntimeCommunicationProjections({
            projectId: proposedCommunication.projectId,
            communicationEventId: proposedCommunication.eventId,
          });
          promotedDraftAssetsCommitted = true;
        } catch {
          // SQLite now owns both the promoted assets and their communication.
          // Projection repair must still be able to read them after this request.
          promotedDraftAssetsCommitted = true;
          try {
            notifyScheduler();
            publishMessageDeliveryChanged(agent.id);
          } catch { /* the committed response remains recoverable */ }
          return reply.code(202).send({
            queued: true,
            deliveryId: v3Intake?.activationId,
            communicationEventId,
            committed: true,
            recovering: true,
          });
        }
      }
      let communication;
      try {
        communication = communicationEventId
          ? store.getCommunicationEvent(project.id, communicationEventId)
          : undefined;
      } catch {
        promotedDraftAssetsCommitted = true;
        try { notifyScheduler(); } catch { /* the committed response remains recoverable */ }
        return reply.code(202).send({
          queued: true,
          deliveryId: v3Intake?.activationId,
          communicationEventId,
          committed: true,
          recovering: true,
        });
      }
      const sharedCommunication = communication?.intent === "broadcast" ? communication : undefined;
      const sharedTaskTurn = Boolean(sharedCommunication && shareWithOrganization);
      const directUserTaskTurn = Boolean(
        communication?.intent === "user_dm" &&
        communication.sender.kind === "user" &&
        (communication.audience.kind === "user_agent"
          ? communication.audience.agentId === agent.id
          : communication.audience.kind === "user_agents" && communication.audience.agentIds.includes(agent.id)),
      );
      let sourceMasterMessage: ConversationMessageDto | undefined;
      try {
        sourceMasterMessage = communication && directMessageConversationId
          ? store.getProjectedConversationMessageById(
            directMessageConversationId, "main", communication.eventId,
          )
          : undefined;
      } catch {
        promotedDraftAssetsCommitted = true;
        try { notifyScheduler(); } catch { /* the committed response remains recoverable */ }
        return reply.code(202).send({
          queued: true,
          deliveryId: v3Intake?.activationId,
          communicationEventId,
          committed: true,
          recovering: true,
        });
      }
      const pendingTurn: PendingTurn = {
        text: publishedText,
        communicationEventId,
        model: request.body.model,
        effort: request.body.effort,
        speed: request.body.speed,
        agentMentionDepth: mentionDepth ?? 0,
        agentMentionTrail: mentionTrail,
        sourceChannel: request.body.sourceChannel === "main" ? "main" : undefined,
      };
      if (!internalV3Dispatch) {
        if (!v3Intake?.activationId) {
          promotedDraftAssetsCommitted = true;
          try { notifyScheduler(); } catch { /* the committed response remains recoverable */ }
          return reply.code(202).send({
            queued: true,
            communicationEventId,
            committed: true,
            recovering: true,
          });
        }
        promotedDraftAssetsCommitted = true;
        let position: number | undefined;
        try {
          const pendingForAgent = coordinationV3.pendingActivations(project.id)
            .filter((activation) => activation.agentId === agent.id);
          const pendingIndex = pendingForAgent.findIndex((activation) => activation.id === v3Intake.activationId);
          position = pendingIndex >= 0 ? pendingIndex + 1 : 1;
        } catch {
          // Queue position is a projection; omit it while repair catches up.
        }
        try {
          notifyScheduler();
          publishMessageDeliveryChanged(agent.id);
        } catch { /* the committed activation remains authoritative */ }
        return reply.code(202).send({
          queued: true,
          ...(position !== undefined ? { position } : {}),
          deliveryId: v3Intake.activationId,
          communicationEventId,
          ...(position === undefined ? { committed: true, recovering: true } : {}),
        });
      }
      const existingRun = activeRuns.get(agent.id);
      if (existingRun) {
        return reply.code(409).send({ error: "agent already has an active run", retryable: true });
      }

      const agentMessageUrl = agentMessageEndpoint(request, opts.agentBaseUrl);
      const preparedRun = await prepareAgentRun(runContext, {
        agent,
        project,
        runtimeEngineId,
        engine,
        text,
        internalV3Dispatch,
        v3SchedulerRunId,
        v3InjectionId,
        v3FreshProviderSession,
        v3ActivationPrompt,
        effectiveModel,
        effectiveEffort,
        messageAttachments,
        sourceConversationId,
        communicationEventId,
        communication,
        sharedCommunication,
        sharedTaskTurn,
        sourceMasterMessage,
        pendingTurn,
        requestedSourceChannel: request.body.sourceChannel,
      });
      const {
        routingConversationId,
        sourceChannel,
        runId,
        controller,
        reusablePersistentRuntime,
        messageCapability,
        resumeSessionId,
        continuationHandoff,
        mode,
        seedHistory,
        cursorChannel,
        cursorConversationId,
        cursorModel,
        previousCursor,
        incremental,
        roomMessages,
        roomCanonicalTipId,
        previousBroadcastCursor,
        broadcastIncremental,
        initialBroadcastContext,
        broadcastCanonicalTipId,
        roomDeltaOmitted,
        broadcastDeltaOmitted,
        routingHash,
        policySnapshotHash,
        systemPrompt,
        runtimeSessionContractHash: effectiveRuntimeSessionContractHash,
        workingCopy,
        availableRuntimeTools,
        availableRuntimeToolNames,
        historyRetrievalBoundary,
        historyRetrievalFrozenExclusions,
        prompt,
        freshPrompt,
        providerSessionDisposition,
        exactProviderInput,
        freshExactProviderInput,
        activationWakeCause,
        providerInputManifest,
        freshProviderInputManifest,
        manifestArtifactIds,
        pendingCommunicationV4NextRunDeliveryIds,
        runtimeAttachmentDirectory,
        runtimeAttachmentCleanupAfterRun,
      } = preparedRun;

      // No await may be introduced between this recheck and the claim. Deletion
      // marks the agent unavailable before its own first await.
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        if (runtimeAttachmentCleanupAfterRun) {
          await cleanupRuntimeAttachments(runtimeAttachmentDirectory);
        }
        return reply.code(404).send({ error: "agent not found" });
      }
      try {
        workingCopies.assertRunAdmission(agent.id, workingCopy);
      } catch (error) {
        try {
          coordinationV3.failRun({
            runId, fencingToken: v3FencingToken!, workerId: coordinationV3WorkerId,
            sameRunResumable: false, retryDelayMs: 0,
          });
        } catch { /* ownership may already have changed */ }
        if (runtimeAttachmentCleanupAfterRun) {
          await cleanupRuntimeAttachments(runtimeAttachmentDirectory);
        }
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "working folder changed; retry safely",
          retryable: true,
        });
      }
      let durableClaim: { generation: number };
      try {
        coordinationV3.markRunStarted(runId, v3FencingToken!);
        coordinationV3.setRunContextDisposition(
          runId,
          v3FencingToken!,
          providerSessionDisposition,
        );
        coordinationV3.recordProviderInputAndCommitContextRolloverReplacement({
          executionId: runId,
          schedulerRunId: runId,
          fencingToken: v3FencingToken!,
          agentId: agent.id,
          projectId: project.id,
          prompt: exactProviderInput,
          systemPrompt,
          sourceManifest: providerInputManifest,
        });
        publishCoordinationV3Changed(agent.id, {
          conversationIds: routingConversationId ? [routingConversationId] : [],
        });
        durableClaim = { generation: v3FencingToken! };
      } catch {
        try {
          coordinationV3.failRun({
            runId,
            fencingToken: v3FencingToken!,
            workerId: coordinationV3WorkerId,
            sameRunResumable: false,
            retryDelayMs: 0,
          });
        } catch { /* ownership may already have changed */ }
        if (runtimeAttachmentCleanupAfterRun) {
          await cleanupRuntimeAttachments(runtimeAttachmentDirectory);
        }
        return reply.code(409).send({ error: "agent run ownership changed; retry safely", retryable: true });
      }
      const failUnstartedClaim = (cancelled = false): void => {
        if (cancelled) coordinationV3.cancelAgentRun({ agentId: agent.id, idempotencyKey: `unstarted:${runId}` });
        else coordinationV3.failRun({
          runId, fencingToken: v3FencingToken!, workerId: coordinationV3WorkerId,
          sameRunResumable: false, retryDelayMs: 0,
        });
      };
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        failUnstartedClaim(true);
        if (runtimeAttachmentCleanupAfterRun) {
          await cleanupRuntimeAttachments(runtimeAttachmentDirectory);
        }
        return reply.code(404).send({ error: "agent not found" });
      }

      try {
        await assets.associate(agent.projectId, agent.id, attachmentIds);
        promotedDraftAssetsCommitted = true;
      } catch (error) {
        failUnstartedClaim();
        if (runtimeAttachmentCleanupAfterRun) {
          await cleanupRuntimeAttachments(runtimeAttachmentDirectory);
        }
        throw error;
      }
      if (deletingAgentIds.has(agent.id) || !store.getAgent(agent.id)) {
        failUnstartedClaim(true);
        if (runtimeAttachmentCleanupAfterRun) {
          await cleanupRuntimeAttachments(runtimeAttachmentDirectory);
        }
        return reply.code(404).send({ error: "agent not found" });
      }
      const startedAt = new Date().toISOString();
      const trackedV3FencingToken = internalV3Dispatch ? v3FencingToken : undefined;
      const runningLifecycle = store.appendEvent(agent.id, {
        type: "agent_lifecycle", status: "running", reason: "active_run", executionId: runId,
        engine: runtimeEngineId,
        wakeCause: activationWakeCause ?? (sharedTaskTurn
          ? "project_request"
          : directUserTaskTurn
            ? "direct_message"
              : "collaboration"),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      });
      const activeRun: ActiveRun = {
        runId, startedAt, executionId: runId, leaseExpiresAt: leaseExpiry(), controller, messageCapability,
        workingCopy,
        ...(routingConversationId ? { conversationId: routingConversationId } : {}),
        ...(trackedV3FencingToken !== undefined
          ? { v3SchedulerRunId: runId, v3FencingToken: trackedV3FencingToken }
          : {}),
        generation: durableClaim.generation,
        ownershipState: "running",
      };
      claimActiveRun(agent.id, activeRun);
      // Publish only after the in-memory execution authority reflects the
      // durable lifecycle transition. Workspace consumers refetch active Run
      // state when they receive this event, so publishing first can leave the
      // Project Overview falsely idle until another event or manual refresh.
      publish(agent.id, runningLifecycle);
      const durableReply = coordinationV3.requiredReplyObligationForRun(runId)?.replyAuthority;
      const recoveredRequiredReply = recoverRequiredReplyPublications(
        coordinationV3,
        runId,
        agent.id,
      );
      const peerReplyRoutes = coordinationV3.requestIdsAttachedToRun(runId, agent.id).length === 0
        ? coordinationV3.activationPayloads(
            agent.id,
            coordinationV3.activationIdsAttachedToRun(runId, agent.id),
            runId,
          ).flatMap(({ payload }) => {
            if (!payload || typeof payload !== "object") return [];
            const source = (payload as { communication?: unknown }).communication;
            if (!source || typeof source !== "object") return [];
            const candidate = source as Partial<CommunicationEvent>;
            return candidate.intent === "collaboration" && candidate.sender?.kind === "agent"
              ? [{ intent: "collaboration" as const, recipientAgentIds: [candidate.sender.agentId] }]
              : [];
          })
        : [];
      const distinctReplyRoutes = [...new Map(
        [...(durableReply ? [durableReply] : []), ...peerReplyRoutes]
          .map((authority) => [JSON.stringify(authority), authority]),
      ).values()];
      // A convenient reply route and a durable reply obligation are separate
      // authorities. Ordinary/urgent peer input may make a bare message
      // unambiguous without manufacturing acknowledgement or recovery work.
      const defaultReply = distinctReplyRoutes.length === 1 ? distinctReplyRoutes[0] : undefined;
      agentMessageCapabilities.set(messageCapability, {
        agentId: agent.id,
        conversationId: routingConversationId,
        runId,
        v3SchedulerRunId: runId,
        v3FencingToken: trackedV3FencingToken!,
        mentionDepth: mentionDepth ?? 0,
        mentionTrail,
        reachableArtifactIds: manifestArtifactIds,
        availableToolNames: availableRuntimeToolNames,
        historyRetrievalExcludedCommunicationEventIds: [...new Set([
          ...historyRetrievalFrozenExclusions,
          ...providerInputManifest.communicationEventIds,
          ...freshProviderInputManifest.communicationEventIds,
        ])],
        ...(historyRetrievalBoundary ? { historyRetrievalBoundary } : {}),
        ...(sharedTaskTurn ? { plainSharedReply: true } : {}),
        ...(defaultReply ? { defaultReply } : {}),
        ...(Object.keys(recoveredRequiredReply.fingerprints).length
          ? { requiredReplyFingerprints: recoveredRequiredReply.fingerprints }
          : {}),
        ...(recoveredRequiredReply.communicationEventId
          ? { inferredReplyCommunicationEventId: recoveredRequiredReply.communicationEventId }
          : {}),
      });

      // The active Run is now the lifecycle authority. Release delivery
      // deletion guards before provider execution continues in background.
      releaseAgentDelivery();
      startProviderRunExecution(app, runContext, {
        activeRun,
        agent,
        agentMessageUrl,
        broadcastCanonicalTipId,
        broadcastDeltaOmitted,
        broadcastIncremental,
        communicationEventId,
        continuationHandoff,
        controller,
        cursorChannel,
        cursorConversationId,
        cursorModel,
        effectiveEffort,
        effectiveModel,
        effectiveSpeed,
        engine,
        freshExactProviderInput,
        freshPrompt,
        freshProviderInputManifest,
        incremental,
        initialBroadcastContext,
        manifestArtifactIds,
        messageCapability,
        policySnapshotHash,
        pendingCommunicationV4NextRunDeliveryIds,
        previousBroadcastCursor,
        previousCursor,
        project,
        prompt,
        resumeSessionId,
        reusablePersistentRuntime,
        roomCanonicalTipId,
        roomDeltaOmitted,
        roomMessages,
        routingConversationId,
        routingHash,
        runId,
        runtimeEngineId,
        runtimeSessionContractHash: effectiveRuntimeSessionContractHash,
        workingCopy,
        availableRuntimeTools,
        runtimeAttachmentDirectory,
        runtimeAttachmentCleanupAfterRun,
        seedHistory,
        sourceChannel,
        systemPrompt,
        v3FencingToken,
        v3InjectionId,
      });

      return { queued: false, runId, mode, communicationEventId };
      } finally {
        if (!promotedDraftAssetsCommitted) {
          await Promise.all(promotedDraftAssets.map((attachment) =>
            assets.remove(agent.projectId, agent.id, attachment.id)));
        }
      }
      } finally {
        releaseAgentDelivery();
      }
    },
  );
}
