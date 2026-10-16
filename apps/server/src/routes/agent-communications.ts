import { createHash, randomUUID } from "node:crypto";
import {
  PONDEROSA_MESSAGE_TOOL,
  LONG_TEXT_MAX_UTF8_BYTES,
  canonicalizeProviderText,
  shouldBackTextWithArtifact,
  unicodeCodePointLength,
  type CommunicationEvent,
  type SendAgentMessageRequest,
  type VerifiedCitationDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  ConversationDeliveryIntent,
  CoordinationV3Store,
  StoredLogEvent,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { AssetError } from "../assets.js";
import { stripLeadingScopeTag } from "../agent-mentions.js";
import type {
  ActiveRun,
  AgentMessageCapability,
} from "../app-contracts.js";
import type { createAgentEventService } from "../agent-event-service.js";
import {
  cleanupUncommittedCommunicationArtifact,
  type createCommunicationArtifactAuthority,
} from "../communication-artifacts.js";
import { derivedRunActionKey } from "../security.js";
import { normalizeExternalCitations } from "../external-content.js";
import { requiredReplyAuthorityKey, requiredReplyRequest, selectsRequiredReply } from "../required-reply-route.js";
import { leaseAgentDelivery, leaseConversationDelivery } from "../delivery-leases.js";
import {
  conversationDeliveryRequestFingerprint,
  type PreparedCommunicationArtifact,
} from "./conversation-deliveries.js";

type AgentEventService = ReturnType<typeof createAgentEventService>;
type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface AgentCommunicationRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  projectDeletionInProgress(projectId: string): boolean;
  conversationDeletionInProgress(conversationId: string): boolean;
  agentDeletionInProgress(agentId: string): boolean;
  conversationDeliveryLeases: Map<string, number>;
  agentDeliveryLeases: Map<string, number>;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
  runAuthorization(capability: AgentMessageCapability): {
    runId: string;
    agentId: string;
    fencingToken: number;
  };
  recordCommunication(event: CommunicationEvent): CommunicationEvent;
  projectBroadcastToAgentAudits: AgentEventService["projectBroadcastToAgentAudits"];
  projectCommunicationToAgentAudit: AgentEventService["projectCommunicationToAgentAudit"];
  resolveExplicitCollaborationIntents: AgentEventService["resolveExplicitCollaborationIntents"];
  appendBlockedMentionWarnings: AgentEventService["appendBlockedMentionWarnings"];
  communicationArtifactAccess: CommunicationArtifactAuthority["communicationArtifactAccess"];
  projectCommunicationArtifact: CommunicationArtifactAuthority["projectCommunicationArtifact"];
  runtimeArtifactMetadata: CommunicationArtifactAuthority["runtimeArtifactMetadata"];
  stageCommunicationArtifact: CommunicationArtifactAuthority["stageCommunicationArtifact"];
  removeRuntimeArtifactReservation(projectId: string, artifactId: string): void;
  publishCoordinationV3Changed(
    agentId: string,
    options?: { conversationIds?: string[] },
  ): void;
  publishWorkspaceSince(cursor: number): void;
  resolveOperationalNotification(dedupeKey: string): void;
  notifyScheduler(): void;
  reconcileRuntimeCommunicationProjections(filter?: {
    projectId?: string;
    communicationEventId?: string;
  }): Promise<number>;
  publish(agentId: string, stored: StoredLogEvent): void;
}

const AGENT_MESSAGE_FIELDS = new Set([
  "intent", "text", "artifactIds", "steeringInjectionId", "recipientAgentIds",
  "urgency", "idempotencyKey", "document", "citations", "delivery", "expiresAt",
  "taskDelivery",
]);

export function validateAgentMessageBodyShape(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "message body must be an object";
  const candidate = body as Record<string, unknown>;
  const unknownKeys = Object.keys(candidate).filter((key) => !AGENT_MESSAGE_FIELDS.has(key));
  if (unknownKeys.length > 0) {
    return `unknown message field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}; collaboration recipients must use recipientAgentIds as an array`;
  }
  for (const key of ["intent", "text", "steeringInjectionId", "idempotencyKey", "expiresAt"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  if (candidate.intent !== undefined &&
      !["broadcast", "direct_to_user", "collaboration"].includes(candidate.intent as string)) {
    return "intent must be broadcast, direct_to_user, or collaboration";
  }
  if (candidate.taskDelivery !== undefined && candidate.taskDelivery !== 'final' && candidate.taskDelivery !== 'blocked') {
    return 'taskDelivery must be final or blocked';
  }
  if (candidate.taskDelivery !== undefined && (candidate.delivery !== undefined || candidate.intent === 'collaboration')) {
    return 'taskDelivery is only an immediate operator-facing outcome';
  }
  if (candidate.urgency !== undefined &&
      candidate.urgency !== "ordinary" && candidate.urgency !== "urgent") {
    return "urgency must be ordinary or urgent";
  }
  if (candidate.recipientAgentIds !== undefined &&
      (!Array.isArray(candidate.recipientAgentIds) ||
        candidate.recipientAgentIds.some((id) => typeof id !== "string"))) {
    return "recipientAgentIds must be an array of strings";
  }
  if (candidate.artifactIds !== undefined &&
      (!Array.isArray(candidate.artifactIds) || candidate.artifactIds.some((id) => typeof id !== "string"))) {
    return "artifactIds must be an array of strings";
  }
  if (candidate.document !== undefined) {
    if (!candidate.document || typeof candidate.document !== "object" || Array.isArray(candidate.document)) {
      return "document must be an object";
    }
    const document = candidate.document as Record<string, unknown>;
    const unknownDocumentKeys = Object.keys(document).filter((key) => !["title", "content", "mediaType"].includes(key));
    if (unknownDocumentKeys.length || typeof document.title !== "string" ||
        typeof document.content !== "string" ||
        (document.mediaType !== undefined && typeof document.mediaType !== "string")) {
      return "document must contain only string title, content, and optional mediaType fields";
    }
  }
  if (candidate.citations !== undefined && !Array.isArray(candidate.citations)) {
    return "citations must be an array";
  }
  if (candidate.delivery !== undefined && candidate.delivery !== "next_run") {
    return "delivery must be next_run when supplied";
  }
    if (candidate.delivery === "next_run") {
      if (candidate.intent !== undefined || candidate.urgency !== undefined ||
        candidate.artifactIds !== undefined || candidate.document !== undefined ||
        candidate.citations !== undefined) {
      return "next_run accepts only text, recipientAgentIds, optional expiresAt, idempotencyKey, and steeringInjectionId";
    }
    if (candidate.expiresAt !== undefined && typeof candidate.expiresAt !== "string") {
      return "expiresAt must be a string";
    }
    return undefined;
  }
  if (candidate.expiresAt !== undefined) return "expiresAt is valid only for next_run";
  if (candidate.recipientAgentIds !== undefined && candidate.intent !== "collaboration") {
    return "recipientAgentIds is valid only when intent is collaboration";
  }
  if (candidate.urgency !== undefined && candidate.intent !== "collaboration") {
    return "urgency is valid only when intent is collaboration";
  }
  return undefined;
}

export function registerAgentCommunicationRoutes(
  app: FastifyInstance,
  context: AgentCommunicationRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    workspace,
    agentMessageCapabilities,
    activeRuns,
    projectDeletionInProgress,
    conversationDeletionInProgress,
    agentDeletionInProgress,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    capabilityOwnsAuthoritativeRun,
    runAuthorization,
    resolveExplicitCollaborationIntents,
    appendBlockedMentionWarnings,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
    removeRuntimeArtifactReservation,
    publishCoordinationV3Changed,
    resolveOperationalNotification,
    notifyScheduler,
    reconcileRuntimeCommunicationProjections,
  } = context;

  app.post<{
    Body: SendAgentMessageRequest;
  }>("/api/agent-messages", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    if (!capability) return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    const active = activeRuns.get(capability.agentId);
    if (!capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    if (!capability.availableToolNames?.includes(PONDEROSA_MESSAGE_TOOL.name)) {
      return reply.code(403).send({ error: "Message tool is not authorized for this Run" });
    }
    const bodyShapeError = validateAgentMessageBodyShape(request.body);
    if (bodyShapeError) return reply.code(400).send({ error: bodyShapeError });
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const latestPrompt = coordinationV3.latestAcknowledgedPromptInjection(capability.runId);
    const requiredSteeringFence = latestPrompt?.kind === "steer" ? latestPrompt.id : undefined;
    const inferredReply = request.body?.intent === undefined;
    const candidateIntent = request.body?.intent ?? capability.defaultReply?.intent;
    const text = request.body?.text === undefined
      ? ""
      : canonicalizeProviderText(request.body.text, steeringInjectionIds).trim();
    const artifactIds = request.body && "artifactIds" in request.body
      ? request.body.artifactIds
      : undefined;
    if (artifactIds !== undefined && (!Array.isArray(artifactIds) || artifactIds.length === 0 ||
        artifactIds.length > 20 || new Set(artifactIds).size !== artifactIds.length ||
        artifactIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)))) {
      return reply.code(400).send({ error: "artifactIds must contain 1 to 20 unique managed artifact IDs" });
    }
    const v3Urgency = (request.body as SendAgentMessageRequest & { urgency?: "ordinary" | "urgent" })?.urgency;
    const currentAuthor = store.getAgent(capability.agentId);
    if (request.body?.delivery === "next_run") {
      const suppliedSteeringFence = request.body.steeringInjectionId?.trim();
      const recipientAgentIds = request.body.recipientAgentIds;
      if (!Array.isArray(recipientAgentIds) || recipientAgentIds.length < 1 ||
          recipientAgentIds.length > 100) {
        return reply.code(400).send({ error: "next_run requires 1 to 100 recipientAgentIds" });
      }
      const normalizedRecipients: string[] = [];
      for (let index = 0; index < recipientAgentIds.length; index += 1) {
        const recipient = recipientAgentIds[index];
        if (typeof recipient !== "string" || !recipient.trim() ||
            unicodeCodePointLength(recipient.trim()) > 200) {
          return reply.code(400).send({
            error: `recipientAgentIds[${index}] must contain 1 to 200 Unicode code points`,
          });
        }
        normalizedRecipients.push(recipient.trim());
      }
      if (new Set(normalizedRecipients).size !== normalizedRecipients.length) {
        return reply.code(400).send({ error: "next_run recipientAgentIds must be unique" });
      }
      if (!text || unicodeCodePointLength(text) > 20_000) {
        return reply.code(400).send({
          error: "next_run text must contain 1 to 20000 Unicode code points",
        });
      }
      const expiresAt = request.body.expiresAt?.trim();
      if (expiresAt && (
        unicodeCodePointLength(expiresAt) > 100 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt))
      )) {
        return reply.code(400).send({ error: "expiresAt must be a valid ISO timestamp" });
      }
      const requestedIdempotencyKey = request.body.idempotencyKey?.trim();
      if (requestedIdempotencyKey && unicodeCodePointLength(requestedIdempotencyKey) > 200) {
        return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
      }
      const idempotencyKey = requestedIdempotencyKey ?? derivedRunActionKey(
        capability.runId,
        "message-next-run",
        { text, recipientAgentIds: [...normalizedRecipients].sort(), expiresAt: expiresAt ?? null },
      );
      if (currentAuthor && capability.conversationId) {
        try {
          const replay = coordinationV3.replayAgentNextRunDelivery({
            projectId: currentAuthor.projectId,
            conversationId: capability.conversationId,
            publisherAgentId: currentAuthor.id,
            sourceRunId: capability.runId,
            idempotencyKey,
            text,
            recipientAgentIds: normalizedRecipients,
            ...(expiresAt ? { expiresAt } : {}),
          });
          if (replay) return {
            delivery: "next_run",
            deliveryId: replay.delivery.id,
            recipientAgentIds: replay.delivery.recipientAgentIds,
            replayed: true,
            executionDirective: "Information will enter each recipient's next otherwise-authorized Run; no Run or reply was created.",
          };
        } catch (error) {
          return reply.code(409).send({
            error: error instanceof Error ? error.message : "next-run delivery replay failed",
          });
        }
      }
      try {
        coordinationV3.requireCurrentPromptInjection(runAuthorization(capability), suppliedSteeringFence ?? null);
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "output prompt authority is invalid",
          ...(requiredSteeringFence ? { requiredSteeringInjectionId: requiredSteeringFence } : {}),
        });
      }
      if (!currentAuthor) {
        return reply.code(409).send({ error: "agent is no longer available" });
      }
      if (!capability.conversationId ||
          currentAuthor.conversationId !== capability.conversationId) {
        return reply.code(409).send({ error: "next_run requires an active Team Chat scope" });
      }
      const conversation = store.getConversation(capability.conversationId);
      const leasedAgentIds = [currentAuthor.id, ...normalizedRecipients];
      if (projectDeletionInProgress(currentAuthor.projectId) ||
          conversationDeletionInProgress(capability.conversationId) ||
          leasedAgentIds.some(agentDeletionInProgress) ||
          !conversation || conversation.projectId !== currentAuthor.projectId) {
        return reply.code(409).send({ error: "next-run delivery participants are no longer available" });
      }
      const releaseDeliveryLease = leaseConversationDelivery(
        conversationDeliveryLeases,
        agentDeliveryLeases,
        capability.conversationId,
        leasedAgentIds,
      );
      try {
        const currentParticipants = leasedAgentIds.map((agentId) => store.getAgent(agentId));
        if (projectDeletionInProgress(currentAuthor.projectId) ||
            conversationDeletionInProgress(capability.conversationId) ||
            leasedAgentIds.some(agentDeletionInProgress) ||
            currentParticipants.some((agent) => !agent ||
              agent.projectId !== currentAuthor.projectId ||
              agent.conversationId !== capability.conversationId)) {
          return reply.code(409).send({ error: "next-run delivery participants are no longer available" });
        }
        const result = coordinationV3.publishAgentNextRunDelivery({
          projectId: currentAuthor.projectId,
          conversationId: capability.conversationId,
          publisherAgentId: currentAuthor.id,
          sourceRunId: capability.runId,
          runAuthorization: runAuthorization(capability),
          steeringInjectionId: suppliedSteeringFence ?? null,
          idempotencyKey,
          text,
          recipientAgentIds: normalizedRecipients,
          ...(expiresAt ? { expiresAt } : {}),
        });
        try {
          for (const recipientAgentId of normalizedRecipients) {
            publishCoordinationV3Changed(recipientAgentId, {
              conversationIds: [capability.conversationId],
            });
          }
        } catch { /* durable next-run delivery remains authoritative */ }
        return {
          delivery: "next_run",
          deliveryId: result.delivery.id,
          recipientAgentIds: result.delivery.recipientAgentIds,
          replayed: result.replayed,
          executionDirective: "Information will enter each recipient's next otherwise-authorized Run; no Run or reply was created.",
        };
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "next-run delivery failed",
        });
      } finally {
        releaseDeliveryLease();
      }
    }
    if (!candidateIntent || !(["broadcast", "direct_to_user", "collaboration"] as const).includes(candidateIntent)) {
      return reply.code(400).send({
        error: 'this Run has no unambiguous reply route; use intent "broadcast", "direct_to_user", or "collaboration" explicitly',
      });
    }
    const intent: "broadcast" | "direct_to_user" | "collaboration" = candidateIntent;
    if (v3Urgency !== undefined && v3Urgency !== "ordinary" && v3Urgency !== "urgent") {
      return reply.code(400).send({ error: "urgency must be ordinary or urgent" });
    }
    if (intent === "broadcast" && currentAuthor?.managerAgentId) {
      return reply.code(409).send({
        error: "managed agents cannot broadcast; use collaboration with the agents who need the information",
        managerAgentId: currentAuthor.managerAgentId,
      });
    }
    if (!text && !artifactIds?.length) return reply.code(400).send({ error: "text or at least one artifactId is required" });
    const scopedText = intent === "broadcast" ? stripLeadingScopeTag(text, "broadcast") : text;
    if (text && !scopedText) return reply.code(400).send({ error: "text is required after the broadcast scope" });
    if (Buffer.byteLength(text, "utf8") > LONG_TEXT_MAX_UTF8_BYTES) {
      return reply.code(413).send({ error: "text exceeds the 8 MiB limit" });
    }
    const requestedDocument = request.body?.document;
    if (requestedDocument && (requestedDocument.mediaType && requestedDocument.mediaType !== "text/markdown")) {
      return reply.code(400).send({ error: "document mediaType must be text/markdown" });
    }
    const documentTitle = requestedDocument?.title === undefined
      ? undefined
      : canonicalizeProviderText(requestedDocument.title, steeringInjectionIds).trim();
    const documentContent = requestedDocument?.content === undefined
      ? undefined
      : canonicalizeProviderText(requestedDocument.content, steeringInjectionIds);
    if (requestedDocument && (!documentTitle || !documentContent?.trim())) return reply.code(400).send({ error: "document title and content are required" });
    if (documentTitle && unicodeCodePointLength(documentTitle) > 160) return reply.code(400).send({ error: "document title must be 160 characters or fewer" });
    if (documentContent && Buffer.byteLength(documentContent, "utf8") > LONG_TEXT_MAX_UTF8_BYTES) {
      return reply.code(413).send({ error: "document exceeds the 8 MiB limit" });
    }
    let citations: VerifiedCitationDto[];
    try {
      const citationInput = Array.isArray(request.body?.citations)
        ? request.body.citations.map((citation) => {
            if (!citation || typeof citation !== "object") return citation;
            const source = citation as { url?: unknown; title?: unknown };
            const citationUrl = typeof source.url === "string" ? source.url : undefined;
            if (citationUrl && steeringInjectionIds.some((identifier) => citationUrl.includes(identifier))) {
              throw new Error("citation URL contains an internal steering reference");
            }
            return {
              ...source,
              ...(typeof source.title === "string"
                ? { title: canonicalizeProviderText(source.title, steeringInjectionIds) }
                : {}),
            };
          })
        : request.body?.citations;
      citations = normalizeExternalCitations(citationInput);
    }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid citations" }); }
    const inferredRecipientAgentIds = intent === "collaboration"
      ? [...new Set(request.body?.recipientAgentIds ?? capability.defaultReply?.recipientAgentIds ?? [])]
      : [];
    const selectedReplyAuthority = {
      intent,
      ...(inferredRecipientAgentIds.length
        ? { recipientAgentIds: [...inferredRecipientAgentIds].sort() }
        : {}),
    };
    const taskDelivery = request.body?.taskDelivery;
    if (taskDelivery && !coordinationV3.requiredReplyObligationsForRun(capability.v3SchedulerRunId)
      .some(o => o.deliveryPhase === 'final' && ['pending','satisfied'].includes(o.state) &&
        requiredReplyAuthorityKey(o.replyAuthority) === requiredReplyAuthorityKey(selectedReplyAuthority))) {
      return reply.code(400).send({ error: 'taskDelivery requires this exact task origin and operator reply route' });
    }
    if (taskDelivery) {
      // Also check canonical Decisions after a possible association failure;
      // a missing/superseded SQLite wait must never imply permission answered.
      const origins = new Set(coordinationV3.taskOriginRunIds(capability.v3SchedulerRunId));
      const blockers = workspace.decisionsForRuns(origins).filter(d => d.blocking && d.status === 'pending' &&
          d.agentId === capability.agentId && d.projectId === currentAuthor?.projectId &&
          d.conversationId === capability.conversationId);
      for (const decision of blockers) if (decision.coordinationRunId) coordinationV3.reconcileTaskDecision({
        decisionId: decision.id, runId: decision.coordinationRunId, projectId: decision.projectId,
        agentId: decision.agentId, scopeKey: decision.conversationId ? `conversation:${decision.conversationId}` : `agent:${decision.agentId}`,
      });
      if (taskDelivery === 'final' && blockers.length) {
        return reply.code(409).send({ error: 'task_delivery_dependencies_pending: answer the exact blocking Decision first' });
      }
    }
    const suppliedSteeringFence = request.body?.steeringInjectionId?.trim();
    const replyRequest = requiredReplyRequest(coordinationV3, capability.runId, selectedReplyAuthority);
    const candidateRequiredReplyFingerprint = createHash("sha256").update(JSON.stringify({
      intent, text, recipientAgentIds: inferredRecipientAgentIds,
      artifactIds: artifactIds ?? [],
      document: documentTitle && documentContent ? { title: documentTitle, content: documentContent, mediaType: "text/markdown" } : null,
      citations,
      steeringInjectionId: suppliedSteeringFence ?? null,
      ...(taskDelivery ? { taskDelivery } : {}),
    })).digest("hex");
    const baseRequestFingerprint = conversationDeliveryRequestFingerprint({
      version: 1,
      intent,
      text,
      recipientAgentIds: [...inferredRecipientAgentIds].sort(),
      artifactIds: artifactIds ?? [],
      document: documentTitle && documentContent
        ? { title: documentTitle, content: documentContent, mediaType: "text/markdown" }
        : null,
      citations,
      urgency: v3Urgency ?? "ordinary",
    });
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      baseRequestFingerprint, steeringInjectionId: suppliedSteeringFence ?? null, taskDelivery: taskDelivery ?? null,
    })).digest('hex');
    const requestedIdempotencyKey = request.body?.idempotencyKey?.trim();
    if (requestedIdempotencyKey && requestedIdempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    }
    // Probe the original inferred-reply receipt even when a retry now names
    // its route explicitly (the Run may have acquired another reply route).
    const replayIdempotencyKey = requestedIdempotencyKey ?? derivedRunActionKey(capability.runId, "reply", {
      authority: selectedReplyAuthority,
      fingerprint: candidateRequiredReplyFingerprint,
    });
    const requestedReceiptKey = replayIdempotencyKey
      ? `${capability.runId}:${intent}:${replayIdempotencyKey}`
      : undefined;
    const requestedCommunicationEventId = requestedReceiptKey
      ? `runtime-${createHash("sha256").update(`${currentAuthor?.projectId ?? "unknown"}\0${requestedReceiptKey}`).digest("hex")}`
      : undefined;
    const requestedReplay = requestedCommunicationEventId
      ? coordinationV3.runtimeCommunication(requestedCommunicationEventId)
      : undefined;
    const requestedReplayPayload = requestedReplay?.payload &&
      typeof requestedReplay.payload === "object" &&
      !Array.isArray(requestedReplay.payload)
      ? requestedReplay.payload as {
          requestFingerprint?: unknown;
          requiredReplyFingerprint?: unknown;
          communication?: CommunicationEvent;
        }
      : undefined;
    if (requestedReplay && requestedReplayPayload?.requestFingerprint) {
      if (requestedReplayPayload.requestFingerprint !== requestFingerprint) {
        return reply.code(409).send({ error: "runtime communication ID collision" });
      }
      const communication = requestedReplayPayload.communication;
      const replayAgentIds = [...new Set([
        ...(communication?.sender.kind === "agent" ? [communication.sender.agentId] : []),
        ...(requestedReplay.activations ?? []).map((activation) => activation.agentId),
      ])];
      const releaseReplayLease = communication?.conversationId
        ? leaseConversationDelivery(
            conversationDeliveryLeases,
            agentDeliveryLeases,
            communication.conversationId,
            replayAgentIds,
          )
        : leaseAgentDelivery(agentDeliveryLeases, replayAgentIds);
      try {
        await reconcileRuntimeCommunicationProjections({
          projectId: requestedReplay.projectId,
          communicationEventId: requestedReplay.id,
        });
      } catch {
        return reply.code(202).send({
          intent,
          eventId: requestedReplay.id,
          committed: true,
          recovering: true,
          replayed: true,
          ...(communication?.document?.artifactId
            ? { resultRef: `ponderosa://artifact/${communication.document.artifactId}` }
            : {}),
        });
      } finally {
        releaseReplayLease();
      }
      return {
        intent,
        eventId: requestedReplay.id,
        messageId: requestedReplay.id,
        replayed: true,
        ...(communication?.document?.artifactId
          ? { resultRef: `ponderosa://artifact/${communication.document.artifactId}` }
          : {}),
      };
    }
    const keyedReplayRequiredReplyFingerprint =
      typeof requestedReplayPayload?.requiredReplyFingerprint === "string"
        ? requestedReplayPayload.requiredReplyFingerprint
        : undefined;
    try {
      coordinationV3.requireCurrentPromptInjection(runAuthorization(capability), suppliedSteeringFence ?? null);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "output prompt authority is invalid",
        ...(requiredSteeringFence ? { requiredSteeringInjectionId: requiredSteeringFence } : {}),
      });
    }
    const pendingRequiredReplyAuthorities = coordinationV3.requiredReplyAuthoritiesForRun(capability.runId);
    const interimRoutes = new Set(coordinationV3.requiredReplyObligationsForRun(capability.runId)
      .filter(o => o.state === 'pending' && o.deliveryPhase === 'final' && o.interimCommunicationId)
      .map(o => requiredReplyAuthorityKey(o.replyAuthority)));
    // An initial/interim receipt must not fence out the exact task's later
    // final reply on this same Run. Already-final fingerprints stay fenced.
    const routeKey = requiredReplyAuthorityKey(selectedReplyAuthority);
    const previousRequestFingerprint = replyRequest.publishedReplyFingerprint ?? capability.requiredReplyFingerprints?.[replyRequest.key];
    const publishedReplyFingerprints = previousRequestFingerprint && !interimRoutes.has(routeKey)
      ? { [routeKey]: previousRequestFingerprint }
      : {};
    const {
      selectedReplyAuthorityKey,
      requiredReplyAction,
    } = selectsRequiredReply({
      inferredReply,
      selectedReplyAuthority,
      pendingReplyAuthorities: pendingRequiredReplyAuthorities,
      publishedReplyFingerprints,
      requestedIdempotencyKey,
      candidateReplyFingerprint: candidateRequiredReplyFingerprint,
      keyedReplayRequiredReplyFingerprint,
      steeringFenceMatches: !requiredSteeringFence || suppliedSteeringFence === requiredSteeringFence,
    });
    const inferredReplyFingerprint = requiredReplyAction
      ? candidateRequiredReplyFingerprint
      : undefined;
    const previousRequiredReplyFingerprint = requiredReplyAction
      ? publishedReplyFingerprints[selectedReplyAuthorityKey]
      : undefined;
    if (inferredReplyFingerprint && previousRequiredReplyFingerprint && previousRequiredReplyFingerprint !== inferredReplyFingerprint) {
      return reply.code(409).send({ error: "this request already has its required reply; supply an idempotencyKey for an additional advanced communication" });
    }
    const idempotencyKey = requestedIdempotencyKey || (inferredReplyFingerprint
      ? derivedRunActionKey(capability.runId, "reply", {
          authority: selectedReplyAuthority,
          fingerprint: inferredReplyFingerprint,
        })
      : undefined);
    const receiptKey = idempotencyKey ? `${capability.runId}:${intent}:${idempotencyKey}` : undefined;
    const communicationEventId = receiptKey
      ? `runtime-${createHash("sha256").update(`${currentAuthor?.projectId ?? "unknown"}\0${receiptKey}`).digest("hex")}`
      : randomUUID();
    const replay = requestedCommunicationEventId === communicationEventId
      ? requestedReplay
      : coordinationV3.runtimeCommunication(communicationEventId);
    const replayPayload = replay?.payload && typeof replay.payload === "object"
      ? replay.payload as { communication?: CommunicationEvent }
      : undefined;
    const replayCommunication = replayPayload?.communication ?? replay?.payload as CommunicationEvent | undefined;

    if (!replay) {
      try {
        coordinationV3.requireCurrentPromptInjection(runAuthorization(capability), suppliedSteeringFence ?? null);
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "output prompt authority is invalid",
          ...(requiredSteeringFence ? { requiredSteeringInjectionId: requiredSteeringFence } : {}),
        });
      }
    }

    if (!currentAuthor) {
      return reply.code(409).send({ error: "agent is no longer available" });
    }
    const ordinaryCollaborationRecipients = intent === "collaboration"
      ? inferredRecipientAgentIds
      : [];
    if (intent === "collaboration" && v3Urgency !== "urgent") {
      if (scopedText && /^(thanks|thank you|got it|acknowledged|noted|sounds good|already complete)[.!\s]*$/i.test(scopedText)) {
        return { suppressed: true, reason: "acknowledgement_only", recipientAgentIds: ordinaryCollaborationRecipients };
      }
    }
    const conversation = capability.conversationId
      ? store.getConversation(capability.conversationId)
      : undefined;
    if (projectDeletionInProgress(currentAuthor.projectId)) {
      return reply.code(409).send({ error: "Project deletion is in progress" });
    }
    if (capability.conversationId &&
        (!conversation || conversation.projectId !== currentAuthor.projectId ||
          conversationDeletionInProgress(capability.conversationId) ||
          currentAuthor.conversationId !== capability.conversationId)) {
      return reply.code(409).send({ error: "agent Chat is no longer available" });
    }
    if (intent !== "direct_to_user" && !conversation) {
      return reply.code(409).send({ error: "agent is not linked to a conversation" });
    }
    const recipientAgents = intent === "collaboration"
      ? inferredRecipientAgentIds.map((agentId) => store.getAgent(agentId))
      : [];
    if (!replay && intent === "collaboration" && recipientAgents.some((agent) =>
      !agent || agent.projectId !== currentAuthor.projectId ||
      agent.conversationId !== capability.conversationId)) {
      return reply.code(409).send({ error: "collaboration recipient is no longer available in this Chat" });
    }
    const leasedAgentIds = [capability.agentId, ...inferredRecipientAgentIds];
    if (leasedAgentIds.some(agentDeletionInProgress)) {
      return reply.code(409).send({ error: "Agent deletion is in progress" });
    }
    const releaseDeliveryLease = conversation
      ? leaseConversationDelivery(
          conversationDeliveryLeases,
          agentDeliveryLeases,
          conversation.id,
          leasedAgentIds,
        )
      : leaseAgentDelivery(agentDeliveryLeases, leasedAgentIds);
    const preparedArtifacts: PreparedCommunicationArtifact[] = [];
    let artifactsCommitted = false;
    try {
    const createdAt = replay?.createdAt ?? new Date().toISOString();
    const messageContent = intent === "broadcast" ? scopedText : text;
    const messageNeedsArtifact = shouldBackTextWithArtifact(messageContent);
    const explicitDocumentMatchesMessage = Boolean(documentContent && documentContent === messageContent);
    let messageArtifact: PreparedCommunicationArtifact | undefined;
    let explicitDocumentArtifact: PreparedCommunicationArtifact | undefined;
    try {
      if (messageNeedsArtifact) {
        messageArtifact = await stageCommunicationArtifact({
          projectId: currentAuthor.projectId,
          communicationId: communicationEventId,
          role: "long_text",
          title: explicitDocumentMatchesMessage && documentTitle ? documentTitle : `${currentAuthor.title} response`,
          content: messageContent,
          originAgentId: capability.agentId,
          executionId: capability.runId,
          createdAt,
        });
        preparedArtifacts.push(messageArtifact);
      }
      if (documentTitle && documentContent && (!explicitDocumentMatchesMessage || !messageArtifact)) {
        explicitDocumentArtifact = await stageCommunicationArtifact({
          projectId: currentAuthor.projectId,
          communicationId: communicationEventId,
          role: "document",
          title: documentTitle,
          content: documentContent,
          originAgentId: capability.agentId,
          executionId: capability.runId,
          createdAt,
        });
        preparedArtifacts.push(explicitDocumentArtifact);
      }
    } catch (error) {
      const status = error instanceof AssetError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "long-text artifact staging failed" });
    }
    const primaryArtifact = documentTitle
      ? (explicitDocumentMatchesMessage ? messageArtifact ?? explicitDocumentArtifact : explicitDocumentArtifact)
      : messageArtifact;
    const document = primaryArtifact ? {
      id: replayCommunication?.document?.id ?? primaryArtifact.id,
      artifactId: primaryArtifact.id,
      title: primaryArtifact.title,
      mediaType: "text/markdown" as const,
      byteLength: primaryArtifact.byteLength,
      authorAgentId: capability.agentId,
      executionId: capability.runId,
      createdAt,
    } : undefined;
    // The stable artifact reference remains in structured document metadata and
    // tool results. Do not leak the internal ponderosa:// URI into chat prose.
    const publishedText = messageArtifact ? "" : messageContent;
    if (intent === "direct_to_user") {
      const proposedCommunication: CommunicationEvent = {
        eventId: communicationEventId,
        schemaVersion: 2,
        projectId: currentAuthor.projectId,
        ...(capability.conversationId ? { conversationId: capability.conversationId } : {}),
        sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: capability.agentId },
        text: publishedText,
        ...(artifactIds?.length ? { artifactIds } : {}),
        ...(document ? { document } : {}),
        ...(citations.length ? { citations } : {}),
        createdAt,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      let intake;
      try {
        intake = coordinationV3.recordRuntimeCommunication({
          id: proposedCommunication.eventId,
          projectId: currentAuthor.projectId,
          sender: proposedCommunication.sender,
          intent: proposedCommunication.intent,
          audience: proposedCommunication.audience,
          payload: {
            communication: proposedCommunication,
            ...(taskDelivery ? { taskDelivery } : {}),
            ...(!replay ? { requestFingerprint } : {}),
            ...(inferredReplyFingerprint
              ? { requiredReplyFingerprint: inferredReplyFingerprint, requiredReplyRequestKey: replyRequest.key, requiredReplySourceActivationIds: replyRequest.sourceActivationIds }
              : {}),
          },
          ...(preparedArtifacts.length ? { artifacts: preparedArtifacts.map(runtimeArtifactMetadata) } : {}),
          scopeKey: capability.conversationId ? `conversation:${capability.conversationId}` : `agent:${capability.agentId}`,
          runAuthorization: runAuthorization(capability),
          ...(inferredReplyFingerprint ? { satisfiesRequiredReply: true, requiredReplySourceActivationIds: replyRequest.sourceActivationIds } : {}),
        steeringInjectionId: suppliedSteeringFence ?? null,
          ...(taskDelivery ? { taskDelivery } : {}),
          now: proposedCommunication.createdAt,
        });
        artifactsCommitted = true;
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "message authorization failed" });
      }
      try {
        if (inferredReplyFingerprint) {
          capability.requiredReplyFingerprints ??= {};
          capability.requiredReplyFingerprints[replyRequest.key] = inferredReplyFingerprint;
          capability.inferredReplyCommunicationEventId = communicationEventId;
          coordinationV3.markContextRolloverVisibleResponseCommitted(capability.agentId, capability.runId);
        }
        await reconcileRuntimeCommunicationProjections({
          projectId: proposedCommunication.projectId,
          communicationEventId: proposedCommunication.eventId,
        });
      } catch {
        return reply.code(202).send({
          intent,
          eventId: proposedCommunication.eventId,
          committed: true,
          recovering: true,
          replayed: intake.replayed,
          ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
        });
      }
      let existing;
      try {
        existing = store.readEvents(capability.agentId).find((item) =>
          item.event.type === "communication_projection" && item.event.communicationEventId === proposedCommunication.eventId);
      } catch {
        return reply.code(202).send({
          intent,
          eventId: proposedCommunication.eventId,
          committed: true,
          recovering: true,
          replayed: intake.replayed,
          ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
        });
      }
      return {
        intent,
        eventId: proposedCommunication.eventId,
        messageId: existing ? `agent-event-${existing.seq}` : proposedCommunication.eventId,
        replayed: intake.replayed,
        ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
      };
    }
    if (!capability.conversationId) {
      return reply.code(409).send({ error: "agent is not linked to a conversation" });
    }
    if (currentAuthor.conversationId !== capability.conversationId) {
      return reply.code(409).send({ error: "agent is no longer an active member of this conversation" });
    }
    let renderedText = publishedText;
    let routing: { intents: ConversationDeliveryIntent[]; blocked: Array<{ handle: string; reason: string }> } = { intents: [], blocked: [] };
    if (intent === "collaboration") {
      const recipientAgentIds = inferredRecipientAgentIds;
      if (!Array.isArray(recipientAgentIds) || recipientAgentIds.length === 0) {
        return reply.code(400).send({ error: "collaboration requires at least one recipientAgentId" });
      }
      if (recipientAgentIds.length > 100) return reply.code(400).send({ error: "collaboration supports at most 100 recipients" });
      const resolved = resolveExplicitCollaborationIntents(
        capability.conversationId,
        capability.agentId,
        recipientAgentIds,
        publishedText,
        capability.mentionDepth,
        capability.mentionTrail,
      );
      if (resolved.error) return reply.code(400).send({ error: resolved.error });
      renderedText = resolved.text;
      routing = { intents: resolved.intents, blocked: [] };
    }
    const correlatedRequesterIds = intent === "collaboration" && v3Urgency !== "urgent"
      ? new Set(coordinationV3.requesterIdsForRun(
        capability.v3SchedulerRunId,
        capability.agentId,
      ))
      : new Set<string>();
    const passiveRecipientAgentIds = new Set(routing.intents.flatMap((delivery) =>
      correlatedRequesterIds.has(delivery.targetAgentId) ? [delivery.targetAgentId] : []));
    const actionableRoutingIntents = routing.intents.filter(
      (delivery) => !passiveRecipientAgentIds.has(delivery.targetAgentId),
    );
    const channel = intent === "broadcast" ? "main" : "collaboration";
    const proposedCommunication: CommunicationEvent = intent === "broadcast" ? {
      eventId: communicationEventId,
      schemaVersion: 2,
      projectId: currentAuthor.projectId,
      conversationId: capability.conversationId,
      sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
      intent,
      audience: { kind: "organization", organizationId: currentAuthor.projectId },
      text: publishedText,
      ...(artifactIds?.length ? { artifactIds } : {}),
      ...(document ? { document } : {}),
      ...(citations.length ? { citations } : {}),
      createdAt,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    } : {
      eventId: communicationEventId,
      schemaVersion: 2,
      projectId: currentAuthor.projectId,
      conversationId: capability.conversationId,
      sender: { kind: "agent", agentId: capability.agentId, executionId: capability.runId },
      intent,
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetAgentId) as [string, ...string[]] },
      audienceSelector: routing.intents.some((item) => item.audience === "everyone") ? "everyone" : "mention",
      text: publishedText,
      ...(artifactIds?.length ? { artifactIds } : {}),
      ...(document ? { document } : {}),
      ...(citations.length ? { citations } : {}),
      createdAt,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    let intake;
    try {
      intake = coordinationV3.recordRuntimeCommunication({
        id: proposedCommunication.eventId,
        projectId: currentAuthor.projectId,
        sender: proposedCommunication.sender,
        intent: proposedCommunication.intent,
        audience: proposedCommunication.audience,
        payload: {
          communication: proposedCommunication,
          ...(taskDelivery ? { taskDelivery } : {}),
          ...(!replay ? { requestFingerprint } : {}),
          ...(inferredReplyFingerprint
            ? { requiredReplyFingerprint: inferredReplyFingerprint, requiredReplyRequestKey: replyRequest.key, requiredReplySourceActivationIds: replyRequest.sourceActivationIds }
            : {}),
          ...(intent === "collaboration" ? { dispatch: { text: renderedText } } : {}),
        },
        ...(preparedArtifacts.length ? { artifacts: preparedArtifacts.map(runtimeArtifactMetadata) } : {}),
        scopeKey: capability.conversationId ? `conversation:${capability.conversationId}` : `agent:${capability.agentId}`,
        runAuthorization: runAuthorization(capability),
        ...(inferredReplyFingerprint ? { satisfiesRequiredReply: true, requiredReplySourceActivationIds: replyRequest.sourceActivationIds } : {}),
        steeringInjectionId: suppliedSteeringFence ?? null,
        ...(taskDelivery ? { taskDelivery } : {}),
        ...(intent === "collaboration" ? {
          activations: actionableRoutingIntents.map((delivery, index) => ({
            agentId: delivery.targetAgentId,
            kind: v3Urgency === "urgent" ? "urgent_message" : "ordinary_message",
            priority: v3Urgency === "urgent" ? 90 : 50,
            dispatchPolicy: v3Urgency === "urgent" ? "steer_or_run" as const : "next_run" as const,
            promptClass: v3Urgency === "urgent" ? "blocker" as const : "ordinary" as const,
            dedupeKey: `communication:${proposedCommunication.eventId}:${delivery.targetAgentId}:${index}`,
          })),
        } : {}),
        now: proposedCommunication.createdAt,
      });
      artifactsCommitted = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "message authorization failed";
      return reply.code(message.includes("scope") ? 409 : 403).send({ error: message });
    }
    try {
      if (inferredReplyFingerprint) {
        capability.requiredReplyFingerprints ??= {};
        capability.requiredReplyFingerprints[replyRequest.key] = inferredReplyFingerprint;
        capability.inferredReplyCommunicationEventId = communicationEventId;
        coordinationV3.markContextRolloverVisibleResponseCommitted(capability.agentId, capability.runId);
      }
      await reconcileRuntimeCommunicationProjections({
        projectId: proposedCommunication.projectId,
        communicationEventId: proposedCommunication.eventId,
      });
    } catch {
      try { notifyScheduler(); } catch { /* the committed response remains recoverable */ }
      return reply.code(202).send({
        intent,
        eventId: proposedCommunication.eventId,
        committed: true,
        recovering: true,
        replayed: intake.replayed,
        ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
        ...(passiveRecipientAgentIds.size ? { passiveRecipientAgentIds: [...passiveRecipientAgentIds].sort() } : {}),
      });
    }
    let message;
    try {
      message = store.getConversationMessages(capability.conversationId, channel)
        .find((candidate) => candidate.communicationEventId === proposedCommunication.eventId);
    } catch {
      try { notifyScheduler(); } catch { /* the committed response remains recoverable */ }
      return reply.code(202).send({
        intent,
        eventId: proposedCommunication.eventId,
        committed: true,
        recovering: true,
        replayed: intake.replayed,
        ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
        ...(passiveRecipientAgentIds.size ? { passiveRecipientAgentIds: [...passiveRecipientAgentIds].sort() } : {}),
      });
    }
    if (intent === "collaboration") {
      try {
        for (const delivery of routing.intents) {
          publishCoordinationV3Changed(delivery.targetAgentId, {
            conversationIds: [capability.conversationId],
          });
        }
        notifyScheduler();
        appendBlockedMentionWarnings(capability.conversationId, routing.blocked);
      } catch { /* durable communication remains authoritative */ }
    }
    return {
      intent,
      eventId: proposedCommunication.eventId,
      messageId: message?.id ?? proposedCommunication.eventId,
      replayed: intake.replayed,
      ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
      ...(passiveRecipientAgentIds.size ? { passiveRecipientAgentIds: [...passiveRecipientAgentIds].sort() } : {}),
    };
    } finally {
      if (!artifactsCommitted) {
        for (const artifact of preparedArtifacts) {
          cleanupUncommittedCommunicationArtifact({
            projectId: currentAuthor.projectId,
            artifact,
            runtimeArtifact: (artifactId) => coordinationV3.runtimeArtifact(artifactId),
            removeRuntimeArtifactReservation,
          });
        }
      }
      releaseDeliveryLease();
    }
  });

  app.post<{ Params: { id: string }; Body: { idempotencyKey?: string; createJoin?: boolean } }>(
    "/api/requests/:id/retry",
    async (request, reply) => {
      if (request.body !== undefined && (!request.body || typeof request.body !== "object" || Array.isArray(request.body))) {
        return reply.code(400).send({ error: "retry body must be an object" });
      }
      if (request.body && Object.keys(request.body).some((key) => !["idempotencyKey", "createJoin"].includes(key))) {
        return reply.code(400).send({ error: "unknown retry field" });
      }
      if (request.body?.idempotencyKey !== undefined && typeof request.body.idempotencyKey !== "string") {
        return reply.code(400).send({ error: "idempotencyKey must be a string" });
      }
      if (request.body?.createJoin !== undefined && typeof request.body.createJoin !== "boolean") {
        return reply.code(400).send({ error: "createJoin must be a boolean" });
      }
      const original = coordinationV3.getRequest(request.params.id);
      if (!original) return reply.code(404).send({ error: "request not found" });
      if (!["blocked", "expired", "outcome_unknown", "failed", "recipient_unavailable"].includes(original.state)) {
        return reply.code(409).send({ error: "only blocked, expired, uncertain, or failed requests can be retried" });
      }
      const idempotencyKey = request.body?.idempotencyKey?.trim() || `retry:${original.id}`;
      if (idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
      const requestId = `${original.id}:retry:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`;
      const originalPayload = original.payload && typeof original.payload === "object"
        ? original.payload as Record<string, unknown>
        : undefined;
      const payload = originalPayload
        ? { ...originalPayload, recoveryInstruction: "Audit current state before executing; do not blindly replay prior side effects." }
        : { text: String(original.payload ?? ""), recoveryInstruction: "Audit current state before executing; do not blindly replay prior side effects." };
      const retryInput = {
        projectId: original.projectId,
        ...(original.conversationId ? { conversationId: original.conversationId } : {}),
        requesterAgentId: original.requesterAgentId,
        actorScope: "user:local-operator",
        idempotencyKey,
        rolloverRecoveryForRequestId: original.id,
        requests: [{
          requestId,
          recoveryOfRequestId: original.id,
          recipientAgentId: original.recipientAgentId,
          lifetime: { kind: "indefinite" as const },
          payload,
        }],
        ...(request.body?.createJoin === false
          ? {}
          : { join: { id: `${requestId}:join`, mode: "all" as const } }),
      };
      const retryStatus = coordinationV3.requestRetryStatus(original.id);
      if (retryStatus.successorRequestId) {
        if (retryStatus.successorRequestId === requestId) {
          try {
            return {
              ...coordinationV3.coordinate(retryInput),
              retryOfRequestId: original.id,
            };
          } catch (error) {
            return reply.code(409).send({ error: error instanceof Error ? error.message : "request retry replay failed" });
          }
        }
        return reply.code(409).send({ error: "this assignment already has a different recovery attempt" });
      }
      const requester = original.requesterAgentId ? store.getAgent(original.requesterAgentId) : undefined;
      const recipient = store.getAgent(original.recipientAgentId);
      if (!requester || !recipient) {
        return reply.code(409).send({ error: "request participants are no longer available" });
      }
      const conversation = original.conversationId ? store.getConversation(original.conversationId) : undefined;
      const leasedAgentIds = [requester.id, recipient.id];
      if (projectDeletionInProgress(original.projectId) ||
          (original.conversationId && (conversationDeletionInProgress(original.conversationId) ||
            !conversation || conversation.projectId !== original.projectId)) ||
          leasedAgentIds.some(agentDeletionInProgress)) {
        return reply.code(409).send({ error: "request participants are no longer available" });
      }
      const releaseDeliveryLease = conversation
        ? leaseConversationDelivery(conversationDeliveryLeases, agentDeliveryLeases, conversation.id, leasedAgentIds)
        : leaseAgentDelivery(agentDeliveryLeases, leasedAgentIds);
      try {
        const currentParticipants = leasedAgentIds.map((agentId) => store.getAgent(agentId));
        if (projectDeletionInProgress(original.projectId) || leasedAgentIds.some(agentDeletionInProgress) ||
            currentParticipants.some((agent) => !agent || agent.projectId !== original.projectId) ||
            (original.conversationId && (conversationDeletionInProgress(original.conversationId) ||
              !store.getConversation(original.conversationId)))) {
          return reply.code(409).send({ error: "request participants are no longer available" });
        }
        const result = coordinationV3.coordinate(retryInput);
        let recoveredRollover;
        try {
          recoveredRollover = coordinationV3.contextRolloverRecoveryForRequest(requestId);
        } catch {
          return reply.code(202).send({
            ...result,
            retryOfRequestId: original.id,
            committed: true,
            recovering: true,
          });
        }
        if (recoveredRollover) {
          try {
            resolveOperationalNotification(
              `context-rollover:${recoveredRollover.id}:confirmation-missing`,
            );
          } catch { /* the retry is already canonical */ }
        }
        const conversationIds = original.conversationId
          ? [original.conversationId]
          : [];
        try {
          publishCoordinationV3Changed(requester.id, { conversationIds });
          publishCoordinationV3Changed(recipient.id, { conversationIds });
          notifyScheduler();
        } catch { /* durable retry remains authoritative */ }
        return { ...result, retryOfRequestId: original.id };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "request retry failed" });
      } finally {
        releaseDeliveryLease();
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { idempotencyKey?: string; reason?: string } }>(
    "/api/requests/:id/cancel",
    async (request, reply) => {
      if (request.body !== undefined && (!request.body || typeof request.body !== "object" || Array.isArray(request.body))) {
        return reply.code(400).send({ error: "cancel body must be an object" });
      }
      if (request.body && Object.keys(request.body).some((key) => !["idempotencyKey", "reason"].includes(key))) {
        return reply.code(400).send({ error: "unknown cancel field" });
      }
      if (request.body?.idempotencyKey !== undefined && typeof request.body.idempotencyKey !== "string") {
        return reply.code(400).send({ error: "idempotencyKey must be a string" });
      }
      if (request.body?.reason !== undefined && typeof request.body.reason !== "string") {
        return reply.code(400).send({ error: "reason must be a string" });
      }
      const current = coordinationV3.getRequest(request.params.id);
      if (!current) return reply.code(404).send({ error: "request not found" });
      const key = request.body?.idempotencyKey?.trim() || `operator-cancel:${current.id}`;
      if (key.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
      const reason = request.body?.reason?.trim();
      try {
        const result = coordinationV3.updateRequest({
          requestId: current.id,
          updateId: `user:cancel:${createHash("sha256").update(`${current.projectId}\0${key}`).digest("hex")}`,
          kind: "cancelled",
          actor: { kind: "user", id: "local-operator" },
          payload: { reason: reason || "cancelled by operator" },
        });
        const conversationIds = current.conversationId
          ? [current.conversationId]
          : [];
        try {
          if (current.requesterAgentId) {
            publishCoordinationV3Changed(current.requesterAgentId, { conversationIds });
          }
          publishCoordinationV3Changed(current.recipientAgentId, { conversationIds });
          notifyScheduler();
        } catch { /* the cancellation is already canonical */ }
        return result;
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "request cancellation failed" });
      }
    },
  );
}
