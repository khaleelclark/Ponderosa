import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  canonicalizeProviderText,
  type CollaborationViewDto,
  type CommunicationEvent,
  type CreateCollaborationMessageRequest,
  type ImageAttachmentDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  ConversationDeliveryIntent,
  CoordinationV3Store,
  ManagedArtifactAccess,
  WorkspaceStore,
} from "@ponderosa/agents";
import { ASSET_LIMITS, AssetError, type AssetStore } from "../assets.js";
import { agentMentionHandle, hasEveryoneMention } from "../agent-mentions.js";
import type { PreparedCommunicationArtifact } from "./conversation-deliveries.js";

type RuntimeArtifactInput = NonNullable<
  Parameters<CoordinationV3Store["recordRuntimeCommunication"]>[0]["artifacts"]
>[number];

type PreparedCommunication = {
  canonicalText: string;
  publishedText: string;
  artifact?: PreparedCommunicationArtifact;
  document?: CommunicationEvent["document"];
};

export interface CollaborationRouteDependencies {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  assets: AssetStore;
  projectDeletionInProgress: (projectId: string) => boolean;
  collaborationViewDetail: (
    conversationId: string,
    input?: { limit?: number; cursor?: string; focusId?: string; operationCursor?: string },
  ) => CollaborationViewDto | undefined;
  assetMetadata: (agentId: string, id: string) => ReturnType<AssetStore["read"]>;
  prepareUserCommunicationText: (input: {
    projectId: string;
    communicationId: string;
    text: string;
    createdAt: string;
  }) => Promise<PreparedCommunication>;
  runtimeArtifactMetadata: (artifact: PreparedCommunicationArtifact) => RuntimeArtifactInput;
  recordCommunication: (event: CommunicationEvent) => CommunicationEvent;
  reconcileRuntimeCommunicationProjections: (filter?: {
    projectId?: string;
    communicationEventId?: string;
  }) => Promise<number>;
  projectCommunicationArtifact: (
    projectId: string,
    fallbackAgentId: string,
    artifact: PreparedCommunicationArtifact,
    access: ManagedArtifactAccess,
  ) => void;
  communicationArtifactAccess: (communication: CommunicationEvent) => ManagedArtifactAccess;
  projectCommunicationToAgentAudit: (
    agentId: string,
    event: CommunicationEvent,
    renderedText: string,
    attachments?: ImageAttachmentDto[],
  ) => void;
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  publishCoordinationV3Changed: (
    agentId: string,
    options?: { conversationIds?: string[] },
  ) => void;
  notifyScheduler: () => void;
}
const MAX_ATTACHMENTS_PER_MESSAGE = ASSET_LIMITS.maxAssetsPerMessage;

export function registerCollaborationRoutes(
  app: FastifyInstance,
  dependencies: CollaborationRouteDependencies,
): void {
  const {
    store,
    coordinationV3,
    assets,
    projectDeletionInProgress,
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
    notifyScheduler,
  } = dependencies;
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string; focusId?: string; operationCursor?: string } }>("/api/conversations/:id/collaboration", async (request, reply) => {
    const limit = Math.min(1_000, Math.max(1, Number(request.query.limit ?? 100) || 100));
    try {
      const detail = collaborationViewDetail(request.params.id, {
        limit, cursor: request.query.cursor, focusId: request.query.focusId,
        operationCursor: request.query.operationCursor,
      });
      return detail ?? reply.code(404).send({ error: "conversation not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid history cursor" });
    }
  });

  app.post<{
    Params: { id: string };
    Body: CreateCollaborationMessageRequest;
  }>("/api/conversations/:id/collaboration/messages", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (conversation && projectDeletionInProgress(conversation.projectId)) {
      return reply.code(409).send({ error: "Project deletion is in progress" });
    }
    const text = canonicalizeProviderText(request.body?.text ?? "").trim();
    const requestedRecipientAttachments = request.body?.recipientAttachments ?? [];
    if (!text && (!Array.isArray(requestedRecipientAttachments) || requestedRecipientAttachments.every((item) => !item?.attachmentIds?.length))) {
      return reply.code(400).send({ error: "text or an attachment is required" });
    }
    if (Buffer.byteLength(text, "utf8") > LONG_TEXT_MAX_UTF8_BYTES) return reply.code(413).send({ error: "text exceeds the 8 MiB limit" });
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const detail = collaborationViewDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "conversation not found" });

    let renderedText = text;
    let routing: { intents: ConversationDeliveryIntent[]; blocked: Array<{ title: string; reason: string }> };
    if (request.body.recipientAgentIds !== undefined) {
      const ids = request.body.recipientAgentIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
        return reply.code(400).send({ error: "collaboration requires 1 to 100 recipientAgentIds" });
      }
      const uniqueIds = [...new Set(ids)];
      const members = new Map(detail.agents.map((agent) => [agent.id, agent]));
      const targets = uniqueIds.map((id) => members.get(id));
      if (targets.some((target) => !target || target.archived)) {
        return reply.code(400).send({ error: "every collaboration recipient must be an active agent in this conversation" });
      }
      const recipientPrefix = targets.map((target) => `#${agentMentionHandle(target!.title)}`).join(" ");
      renderedText = text ? `${recipientPrefix} ${text}` : recipientPrefix;
      routing = {
        intents: targets.map((target) => ({
          targetAgentId: target!.id, relayDepth: 0, mentionTrail: [], kind: "tag", audience: "mention",
        })),
        blocked: [],
      };
    } else {
      return reply.code(400).send({ error: "collaboration requires explicit recipientAgentIds" });
    }
    if (routing.intents.length === 0) {
      return reply.code(400).send({ error: "collaboration requires at least one explicit recipient" });
    }
    const master = store.getConversation(request.params.id)!;
    if (!Array.isArray(requestedRecipientAttachments) || requestedRecipientAttachments.length > routing.intents.length) {
      return reply.code(400).send({ error: "recipientAttachments must match collaboration recipients" });
    }
    const attachmentIdsByAgent = new Map<string, string[]>();
    for (const recipient of requestedRecipientAttachments) {
      if (!recipient || typeof recipient.agentId !== "string" || attachmentIdsByAgent.has(recipient.agentId) ||
          !routing.intents.some((intent) => intent.targetAgentId === recipient.agentId) || !Array.isArray(recipient.attachmentIds) ||
          recipient.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(recipient.attachmentIds).size !== recipient.attachmentIds.length) {
        return reply.code(400).send({ error: `each collaboration recipient supports at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique owned attachments` });
      }
      attachmentIdsByAgent.set(recipient.agentId, recipient.attachmentIds);
    }
    const attachmentsByAgent = new Map<string, ImageAttachmentDto[]>();
    for (const intent of routing.intents) {
      const ids = attachmentIdsByAgent.get(intent.targetAgentId) ?? [];
      const attached = await Promise.all(ids.map((id) => assetMetadata(intent.targetAgentId, id)));
      if (attached.some((item) => !item || item.agentId !== intent.targetAgentId)) return reply.code(404).send({ error: "collaboration attachment not found" });
      if (attached.reduce((sum, item) => sum + (item?.size ?? 0), 0) > ASSET_LIMITS.maxMessageBytes) return reply.code(413).send({ error: "message asset quota exceeded" });
      attachmentsByAgent.set(intent.targetAgentId, (attached as NonNullable<(typeof attached)[number]>[]).map((item) => {
        const { projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile, associatedAt: _associatedAt, ...publicAsset } = item;
        return { ...publicAsset, state: "associated" as const };
      }));
    }
    const canonicalAttachments = routing.intents
      .map((intent) => attachmentsByAgent.get(intent.targetAgentId) ?? [])
      .find((items) => items.length > 0) ?? [];
    const eventId = idempotencyKey
        ? `collaboration-${createHash("sha256").update(`${master.id}\0${idempotencyKey}`).digest("hex")}`
        : randomUUID();
    const existingRuntime = coordinationV3.runtimeCommunication(eventId);
    const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
    let prepared: Awaited<ReturnType<typeof prepareUserCommunicationText>>;
    try {
      prepared = await prepareUserCommunicationText({
        projectId: master.projectId, communicationId: eventId, text, createdAt,
      });
    } catch (error) {
      const status = error instanceof AssetError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "long-text artifact staging failed" });
    }
    const publishedRenderedText = text
      ? `${renderedText.slice(0, renderedText.length - text.length)}${prepared.publishedText}`
      : renderedText;
    const communication: CommunicationEvent = {
      eventId,
      schemaVersion: 2, projectId: master.projectId, conversationId: master.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: routing.intents.map((item) => item.targetAgentId) as [string, ...string[]] },
      audienceSelector: routing.intents.some((item) => item.audience === "everyone") ? "everyone" : "mention",
      text: prepared.publishedText,
      ...(prepared.document ? { document: prepared.document } : {}),
      createdAt,
      ...(canonicalAttachments.length ? { attachments: canonicalAttachments } : {}),
      ...(idempotencyKey ? { idempotencyKey: `collaboration:${master.id}:${idempotencyKey}` } : {}),
    };
    let intake;
    try {
      intake = coordinationV3.recordRuntimeCommunication({
        id: eventId,
        projectId: master.projectId,
        sender: communication.sender,
        intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication,
          dispatch: {
            conversationId: master.id,
            text: publishedRenderedText,
            ...(prepared.artifact ? {
              artifactId: prepared.artifact.id,
              resultRef: `ponderosa://artifact/${prepared.artifact.id}`,
            } : {}),
            recipients: routing.intents.map((intent) => ({
              agentId: intent.targetAgentId,
              attachments: (attachmentsByAgent.get(intent.targetAgentId) ?? []).map((item) => ({
                id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
              })),
            })),
          },
        },
        ...(prepared.artifact ? { artifacts: [runtimeArtifactMetadata(prepared.artifact)] } : {}),
        activations: routing.intents.map((intent, index) => ({
          agentId: intent.targetAgentId,
          kind: "human_message",
          priority: 100,
          dispatchPolicy: "steer_or_run",
          promptClass: "human",
          dedupeKey: `communication:${eventId}:${intent.targetAgentId}:${index}`,
        })),
        now: communication.createdAt,
      });
    } catch (error) {
      const status = error instanceof AssetError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "collaboration conflict" });
    }
    const canonicalCommunication = recordCommunication(communication);
    if (intake.replayed) await reconcileRuntimeCommunicationProjections({
      projectId: communication.projectId,
      communicationEventId: communication.eventId,
    });
    if (prepared.artifact) projectCommunicationArtifact(
      master.projectId,
      "local-operator",
      prepared.artifact,
      communicationArtifactAccess(canonicalCommunication),
    );
    const replayedMessage = detail.messages.find((candidate) => candidate.communicationEventId === communication.eventId);
    if (replayedMessage && intake.replayed) {
      return {
        message: replayedMessage,
        audience: hasEveryoneMention(text) ? "everyone" : "mention",
        notifiedAgentIds: routing.intents.map((intent) => intent.targetAgentId),
      };
    }
    let message;
    message = store.appendConversationMessage(
      request.params.id,
      { role: "user", text: publishedRenderedText, attachments: canonicalAttachments },
      // The canonical chat snapshot uses one copy; per-recipient copies stay in
      // dispatch/audit data and are never rendered as duplicates.
      undefined,
      "collaboration",
      routing.intents,
      undefined,
      communication?.eventId,
    );
    const notifiedAgentIds: string[] = [];
    for (const intent of routing.intents) {
      store.appendCommunicationProjection(master.projectId, {
        eventId, surface: "agent_inbox", projectionKey: intent.targetAgentId, projectedAt: communication.createdAt,
      });
      const recipientAttachments = attachmentsByAgent.get(intent.targetAgentId) ?? [];
      if (!intake.replayed && recipientAttachments.length) {
        await assets.associate(master.projectId, intent.targetAgentId, recipientAttachments.map((item) => item.id));
      }
      projectCommunicationToAgentAudit(intent.targetAgentId, communication, publishedRenderedText, recipientAttachments);
      publishCoordinationV3Changed(intent.targetAgentId, {
        conversationIds: [master.id],
      });
    }
    if (!intake.replayed) appendWorkspace({ type: "conversation_changed", projectId: master.projectId, conversationId: master.id, action: "message" });
    notifyScheduler();
    notifiedAgentIds.push(...routing.intents.map((intent) => intent.targetAgentId));
    return {
      message,
      audience: hasEveryoneMention(text) ? "everyone" : "mention",
      notifiedAgentIds,
    };
  });

}
