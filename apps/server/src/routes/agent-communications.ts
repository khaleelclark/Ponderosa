import { createHash, randomUUID } from "node:crypto";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  TERMINAL_REQUEST_STATES,
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
import {
  renderScopedMessage,
  stripLeadingScopeTag,
} from "../agent-mentions.js";
import type {
  ActiveRun,
  AgentMessageCapability,
  CreateServerOptions,
} from "../app-contracts.js";
import type { createAgentEventService } from "../agent-event-service.js";
import type { createCommunicationArtifactAuthority } from "../communication-artifacts.js";
import { derivedRunActionKey } from "../security.js";
import { normalizeExternalCitations } from "../external-content.js";
import type { PreparedCommunicationArtifact } from "./conversation-deliveries.js";

type AgentEventService = ReturnType<typeof createAgentEventService>;
type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface AgentCommunicationRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
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
  publishCoordinationV3Changed(
    agentId: string,
    options?: { conversationIds?: string[] },
  ): void;
  publishWorkspaceSince(cursor: number): void;
  resolveOperationalNotification(dedupeKey: string): void;
  notifyScheduler(): void;
  messageLifecycleFaults: CreateServerOptions["messageLifecycleFaults"];
  reconcileRuntimeCommunicationProjections(filter?: {
    projectId?: string;
    communicationEventId?: string;
  }): Promise<number>;
  publish(agentId: string, stored: StoredLogEvent): void;
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
    capabilityOwnsAuthoritativeRun,
    runAuthorization,
    recordCommunication,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    resolveExplicitCollaborationIntents,
    appendBlockedMentionWarnings,
    communicationArtifactAccess,
    projectCommunicationArtifact,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
    publishCoordinationV3Changed,
    publishWorkspaceSince,
    resolveOperationalNotification,
    notifyScheduler,
    messageLifecycleFaults,
    reconcileRuntimeCommunicationProjections,
    publish,
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
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const inferredReply = request.body?.intent === undefined;
    const candidateIntent = request.body?.intent ?? capability.defaultReply?.intent;
    const text = request.body?.text === undefined
      ? ""
      : canonicalizeProviderText(request.body.text, steeringInjectionIds).trim();
    const artifactIds = request.body?.artifactIds;
    if (artifactIds !== undefined && (!Array.isArray(artifactIds) || artifactIds.length === 0 ||
        artifactIds.length > 20 || new Set(artifactIds).size !== artifactIds.length ||
        artifactIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)))) {
      return reply.code(400).send({ error: "artifactIds must contain 1 to 20 unique managed artifact IDs" });
    }
    const v3Urgency = (request.body as SendAgentMessageRequest & { urgency?: "ordinary" | "urgent" })?.urgency;
    if (!candidateIntent || !(["broadcast", "direct_to_user", "collaboration"] as const).includes(candidateIntent)) {
      return reply.code(400).send({
        error: 'this Run has no unambiguous reply route; use intent "broadcast", "direct_to_user", or "collaboration" explicitly',
      });
    }
    const intent: "broadcast" | "direct_to_user" | "collaboration" = candidateIntent;
    if (v3Urgency !== undefined && v3Urgency !== "ordinary" && v3Urgency !== "urgent") {
      return reply.code(400).send({ error: "urgency must be ordinary or urgent" });
    }
    const currentAuthor = store.getAgent(capability.agentId);
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
    const inferredReplyFingerprint = inferredReply
      ? createHash("sha256").update(JSON.stringify({
          intent, text, recipientAgentIds: inferredRecipientAgentIds,
          artifactIds: artifactIds ?? [],
          document: documentTitle && documentContent ? { title: documentTitle, content: documentContent, mediaType: "text/markdown" } : null,
          citations,
        })).digest("hex")
      : undefined;
    if (inferredReplyFingerprint && capability.inferredReplyFingerprint && capability.inferredReplyFingerprint !== inferredReplyFingerprint) {
      return reply.code(409).send({ error: "this Run already published its inferred reply; use an explicit advanced communication only if additional material communication is required" });
    }
    const idempotencyKey = request.body?.idempotencyKey?.trim() || (inferredReplyFingerprint
      ? derivedRunActionKey(capability.runId, "reply", { fingerprint: inferredReplyFingerprint })
      : undefined);
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const receiptKey = idempotencyKey ? `${capability.runId}:${intent}:${idempotencyKey}` : undefined;
    const communicationEventId = receiptKey
      ? `runtime-${createHash("sha256").update(`${currentAuthor?.projectId ?? "unknown"}\0${receiptKey}`).digest("hex")}`
      : randomUUID();
    const replay = coordinationV3.runtimeCommunication(communicationEventId);
    const replayPayload = replay?.payload && typeof replay.payload === "object"
      ? replay.payload as { communication?: CommunicationEvent }
      : undefined;
    const replayCommunication = replayPayload?.communication ?? replay?.payload as CommunicationEvent | undefined;

    const requiredSteeringFence = coordinationV3.latestAcknowledgedSteeringInjection(capability.runId);
    const suppliedSteeringFence = request.body?.steeringInjectionId?.trim();
    if (!replay && requiredSteeringFence && suppliedSteeringFence !== requiredSteeringFence) {
      return reply.code(409).send({
        error: "output is fenced behind acknowledged steering; reconsider the newest steering prompt and retry with its exact steeringInjectionId",
        requiredSteeringInjectionId: requiredSteeringFence,
      });
    }

    if (!currentAuthor || currentAuthor.archived) {
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
    const createdAt = replay?.createdAt ?? new Date().toISOString();
    const messageContent = intent === "broadcast" ? scopedText : text;
    const messageNeedsArtifact = shouldBackTextWithArtifact(messageContent);
    const explicitDocumentMatchesMessage = Boolean(documentContent && documentContent === messageContent);
    const preparedArtifacts: PreparedCommunicationArtifact[] = [];
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
      if (documentTitle && documentContent && !explicitDocumentMatchesMessage &&
          (shouldBackTextWithArtifact(documentContent) || messageNeedsArtifact)) {
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
    const primaryArtifact = messageArtifact ?? explicitDocumentArtifact;
    const document = primaryArtifact ? {
      id: replayCommunication?.document?.id ?? primaryArtifact.id,
      artifactId: primaryArtifact.id,
      title: primaryArtifact.title,
      mediaType: "text/markdown" as const,
      byteLength: primaryArtifact.byteLength,
      authorAgentId: capability.agentId,
      executionId: capability.runId,
      createdAt,
    } : documentTitle && documentContent ? {
      id: replayCommunication?.document?.id ?? randomUUID(), title: documentTitle, mediaType: "text/markdown" as const,
      content: documentContent, byteLength: Buffer.byteLength(documentContent, "utf8"),
      authorAgentId: capability.agentId, executionId: capability.runId, createdAt,
    } : undefined;
    // The stable artifact reference remains in structured document metadata and
    // tool results. Do not leak the internal ponderosa:// URI into chat prose.
    const publishedText = messageArtifact ? "" : messageContent;
    if (inferredReplyFingerprint) {
      capability.inferredReplyFingerprint = inferredReplyFingerprint;
    }

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
          payload: proposedCommunication,
          ...(preparedArtifacts.length ? { artifacts: preparedArtifacts.map(runtimeArtifactMetadata) } : {}),
          scopeKey: capability.conversationId ? `conversation:${capability.conversationId}` : `agent:${capability.agentId}`,
          runAuthorization: runAuthorization(capability),
          now: proposedCommunication.createdAt,
        });
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "message authorization failed" });
      }
      if (inferredReplyFingerprint) {
        capability.inferredReplyCommunicationEventId = communicationEventId;
        coordinationV3.markContextRolloverVisibleResponseCommitted(capability.agentId, capability.runId);
      }
      if (preparedArtifacts.length) await messageLifecycleFaults?.afterCommunicationArtifactCommit?.({
        kind: "communication", ownerId: proposedCommunication.eventId,
        artifactIds: preparedArtifacts.map((artifact) => artifact.id),
      });
      if (intake.replayed) {
        await reconcileRuntimeCommunicationProjections({
          projectId: proposedCommunication.projectId,
          communicationEventId: proposedCommunication.eventId,
        });
        const existing = store.readEvents(capability.agentId).find((item) =>
          item.event.type === "communication_projection" && item.event.communicationEventId === proposedCommunication.eventId);
        return {
          intent, eventId: proposedCommunication.eventId,
          messageId: existing ? `agent-event-${existing.seq}` : proposedCommunication.eventId,
          replayed: true,
          ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
        };
      }
      const communication = recordCommunication(proposedCommunication);
      for (const artifact of preparedArtifacts) projectCommunicationArtifact(
        currentAuthor.projectId,
        capability.agentId,
        artifact,
        communicationArtifactAccess(communication),
      );
      store.appendCommunicationProjection(currentAuthor.projectId, {
        eventId: communication.eventId,
        surface: "user_inbox",
        projectionKey: "local-operator",
        projectedAt: communication.createdAt,
      });
      if (capability.conversationId) {
        store.appendConversationMessage(
          capability.conversationId,
          { text: renderScopedMessage("user", publishedText), ...(artifactIds?.length ? { artifactIds } : {}) },
          capability.agentId,
          "main",
          undefined,
          undefined,
          communication.eventId,
        );
      }
      const stored = store.appendEvent(capability.agentId, {
        type: "communication_projection", communicationEventId: communication.eventId, text: publishedText,
      });
      publish(capability.agentId, stored);
      const messageId = `agent-event-${stored.seq}`;
      return {
        intent, eventId: communication.eventId, messageId, replayed: false,
        ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
      };
    }
    if (!capability.conversationId) {
      return reply.code(409).send({ error: "agent is not linked to a conversation" });
    }
    if (!currentAuthor.conversationIds.includes(capability.conversationId)) {
      return reply.code(409).send({ error: "agent is no longer an active member of this conversation" });
    }
    let renderedText = publishedText;
    let routing: { intents: ConversationDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> } = { intents: [], blocked: [] };
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
        payload: proposedCommunication,
        ...(preparedArtifacts.length ? { artifacts: preparedArtifacts.map(runtimeArtifactMetadata) } : {}),
        scopeKey: capability.conversationId ? `conversation:${capability.conversationId}` : `agent:${capability.agentId}`,
        runAuthorization: runAuthorization(capability),
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "message authorization failed";
      return reply.code(message.includes("scope") ? 409 : 403).send({ error: message });
    }
    if (inferredReplyFingerprint) {
      capability.inferredReplyCommunicationEventId = communicationEventId;
      coordinationV3.markContextRolloverVisibleResponseCommitted(capability.agentId, capability.runId);
    }
    if (preparedArtifacts.length) await messageLifecycleFaults?.afterCommunicationArtifactCommit?.({
      kind: "communication", ownerId: proposedCommunication.eventId,
      artifactIds: preparedArtifacts.map((artifact) => artifact.id),
    });
    if (intake.replayed) {
      await reconcileRuntimeCommunicationProjections({
        projectId: proposedCommunication.projectId,
        communicationEventId: proposedCommunication.eventId,
      });
      const existing = store.getConversationMessages(capability.conversationId, channel)
        .find((candidate) => candidate.communicationEventId === proposedCommunication.eventId);
      return {
        intent,
        eventId: proposedCommunication.eventId,
        messageId: existing?.id ?? proposedCommunication.eventId,
        replayed: true,
        ...(passiveRecipientAgentIds.size ? { passiveRecipientAgentIds: [...passiveRecipientAgentIds].sort() } : {}),
      };
    }
    const communication = recordCommunication(proposedCommunication);
    for (const artifact of preparedArtifacts) projectCommunicationArtifact(
      currentAuthor.projectId,
      capability.agentId,
      artifact,
      communicationArtifactAccess(communication),
    );
    const message = store.appendConversationMessage(
      capability.conversationId,
      { role: "assistant", text: renderedText, ...(artifactIds?.length ? { artifactIds } : {}) },
      capability.agentId,
      channel,
      routing.intents,
      receiptKey,
      communication?.eventId,
    );
    if (!message) return reply.code(404).send({ error: "conversation not found" });
    if (communication?.intent === "broadcast") projectBroadcastToAgentAudits(communication);
    if (communication?.intent === "collaboration") {
      const authorAudit = store.appendEvent(capability.agentId, {
        type: "communication_projection",
        communicationEventId: communication.eventId,
        text: renderedText,
        role: "assistant",
      });
      publish(capability.agentId, authorAudit);
    }
    if (intent === "collaboration") {
      for (const delivery of routing.intents) {
        if (communication?.intent === "collaboration") {
          projectCommunicationToAgentAudit(delivery.targetAgentId, communication, renderedText);
        }
        publishCoordinationV3Changed(delivery.targetAgentId, {
          conversationIds: [capability.conversationId],
        });
      }
      notifyScheduler();
      appendBlockedMentionWarnings(capability.conversationId, routing.blocked);
    }
    return {
      intent,
      eventId: communication?.eventId,
      messageId: message.id,
      replayed: false,
      ...(primaryArtifact ? { resultRef: `ponderosa://artifact/${primaryArtifact.id}` } : {}),
      ...(passiveRecipientAgentIds.size ? { passiveRecipientAgentIds: [...passiveRecipientAgentIds].sort() } : {}),
    };
  });

  app.post<{ Params: { id: string }; Body: { idempotencyKey?: string; createJoin?: boolean } }>(
    "/api/requests/:id/retry",
    async (request, reply) => {
      const original = coordinationV3.getRequest(request.params.id);
      if (!original) return reply.code(404).send({ error: "request not found" });
      if (!["blocked", "expired", "outcome_unknown", "failed", "recipient_unavailable"].includes(original.state)) {
        return reply.code(409).send({ error: "only blocked, expired, uncertain, or failed requests can be retried" });
      }
      const retryStatus = coordinationV3.requestRetryStatus(original.id);
      if (retryStatus.completedRequestId) {
        return reply.code(409).send({ error: "this assignment was already recovered by a successful retry" });
      }
      if (retryStatus.activeRequestId) {
        return reply.code(409).send({ error: "a retry of this assignment is already queued or running" });
      }
      const requester = original.requesterAgentId ? store.getAgent(original.requesterAgentId) : undefined;
      const recipient = store.getAgent(original.recipientAgentId);
      if (!requester || requester.archived || !recipient || recipient.archived) {
        return reply.code(409).send({ error: "request participants are no longer available" });
      }
      const idempotencyKey = request.body?.idempotencyKey?.trim() || `retry:${original.id}`;
      if (idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
      try {
        const requestId = `${original.id}:retry:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`;
        const payload = original.payload && typeof original.payload === "object"
          ? { ...original.payload as Record<string, unknown>, retryOfRequestId: original.id, recoveryInstruction: "Audit current state before executing; do not blindly replay prior side effects." }
          : { text: String(original.payload ?? ""), retryOfRequestId: original.id, recoveryInstruction: "Audit current state before executing; do not blindly replay prior side effects." };
        const result = coordinationV3.coordinate({
          projectId: original.projectId,
          ...(original.conversationId ? { conversationId: original.conversationId } : {}),
          requesterAgentId: requester.id,
          actorScope: "user:local-operator",
          idempotencyKey,
          rolloverRecoveryForRequestId: original.id,
          requests: [{ requestId, recipientAgentId: recipient.id, lifetime: { kind: "indefinite" }, payload }],
          ...(request.body?.createJoin === false ? {} : { join: { id: `${requestId}:join`, mode: "all" as const } }),
        });
        const recoveredRollover = coordinationV3.contextRolloverRecoveryForRequest(
          requestId,
        );
        if (recoveredRollover) {
          resolveOperationalNotification(
            `context-rollover:${recoveredRollover.id}:confirmation-missing`,
          );
        }
        const notificationCursor = workspace.cursor();
        for (const notification of workspace.listNotifications()) {
          if ((notification.status ?? "open") === "open" && notification.resolution?.kind === "coordination_request"
              && notification.resolution.requestId === original.id) {
            workspace.setNotificationStatus(notification.id, "resolved");
          }
        }
        publishWorkspaceSince(notificationCursor);
        const conversationIds = original.conversationId
          ? [original.conversationId]
          : [];
        publishCoordinationV3Changed(requester.id, { conversationIds });
        publishCoordinationV3Changed(recipient.id, { conversationIds });
        notifyScheduler();
        return { ...result, retryOfRequestId: original.id };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "request retry failed" });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { idempotencyKey?: string; reason?: string } }>(
    "/api/requests/:id/cancel",
    async (request, reply) => {
      const current = coordinationV3.getRequest(request.params.id);
      if (!current) return reply.code(404).send({ error: "request not found" });
      if (TERMINAL_REQUEST_STATES.has(current.state)) {
        return reply.code(409).send({ error: `request is already terminal (${current.state})` });
      }
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
        if (current.requesterAgentId) {
          publishCoordinationV3Changed(current.requesterAgentId, { conversationIds });
        }
        publishCoordinationV3Changed(current.recipientAgentId, { conversationIds });
        notifyScheduler();
        return result;
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "request cancellation failed" });
      }
    },
  );
}
