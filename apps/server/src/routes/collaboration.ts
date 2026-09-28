import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  canonicalizeProviderText,
  type CollaborationViewDto,
  type CommunicationEvent,
  type CreateCollaborationMessageRequest,
  type AssetDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  ConversationDeliveryIntent,
  CoordinationV3Store,
  ManagedArtifactAccess,
  WorkspaceStore,
} from "@ponderosa/agents";
import { ASSET_LIMITS, AssetError, type AssetStore } from "../assets.js";
import { cleanupUncommittedCommunicationArtifact } from "../communication-artifacts.js";
import { leaseConversationDelivery, reconcileLeasedCommunicationReplay } from "../delivery-leases.js";
import {
  conversationDeliveryRequestFingerprint,
  type PreparedCommunicationArtifact,
} from "./conversation-deliveries.js";

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
  agentDeletionInProgress: (agentId: string) => boolean;
  attachmentDeletionInProgress: (agentId: string, attachmentId: string) => boolean;
  assetReconciliationInProgress: (agentId: string) => boolean;
  conversationDeliveryLeases: Map<string, number>;
  agentDeliveryLeases: Map<string, number>;
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
    attachments?: AssetDto[],
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
    agentDeletionInProgress,
    attachmentDeletionInProgress = () => false,
    assetReconciliationInProgress = () => false,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    collaborationViewDetail,
    assetMetadata,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    reconcileRuntimeCommunicationProjections,
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
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).some((key) => ![
          "text", "recipientAgentIds", "recipientAttachments", "idempotencyKey",
        ].includes(key))) {
      return reply.code(400).send({ error: "collaboration body contains unknown or invalid fields" });
    }
    if (request.body?.text !== undefined && typeof request.body.text !== "string") {
      return reply.code(400).send({ error: "text must be a string" });
    }
    if (!Array.isArray(request.body.recipientAgentIds) ||
        request.body.recipientAgentIds.length === 0 || request.body.recipientAgentIds.length > 100 ||
        request.body.recipientAgentIds.some((id) => typeof id !== "string" || !id.trim())) {
      return reply.code(400).send({ error: "collaboration requires 1 to 100 recipientAgentIds" });
    }
    const normalizedRecipientAgentIds = request.body.recipientAgentIds.map((id) => id.trim());
    if (new Set(normalizedRecipientAgentIds).size !== normalizedRecipientAgentIds.length) {
      return reply.code(400).send({ error: "collaboration recipientAgentIds must be unique" });
    }
    const text = canonicalizeProviderText(request.body?.text ?? "").trim();
    const requestedRecipientAttachments = request.body?.recipientAttachments ?? [];
    if (!Array.isArray(requestedRecipientAttachments) || requestedRecipientAttachments.some((entry) =>
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).some((key) => !["agentId", "attachmentIds"].includes(key)) ||
      typeof entry.agentId !== "string" || !Array.isArray(entry.attachmentIds) ||
      entry.attachmentIds.some((id) => typeof id !== "string" || !id))) {
      return reply.code(400).send({ error: "recipientAttachments must be valid Agent attachment lists" });
    }
    if (!text && (!Array.isArray(requestedRecipientAttachments) || requestedRecipientAttachments.every((item) => !item?.attachmentIds?.length))) {
      return reply.code(400).send({ error: "text or an attachment is required" });
    }
    if (Buffer.byteLength(text, "utf8") > LONG_TEXT_MAX_UTF8_BYTES) return reply.code(413).send({ error: "text exceeds the 8 MiB limit" });
    if (request.body?.idempotencyKey !== undefined && typeof request.body.idempotencyKey !== "string") {
      return reply.code(400).send({ error: "idempotencyKey must be a string" });
    }
    const idempotencyKey = request.body?.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
    const eventId = idempotencyKey
      ? `collaboration-${createHash("sha256").update(`${request.params.id}\0${idempotencyKey}`).digest("hex")}`
      : randomUUID();
    const requestFingerprint = conversationDeliveryRequestFingerprint({
      version: 1,
      kind: "collaboration",
      conversationId: request.params.id,
      text,
      recipientAgentIds: normalizedRecipientAgentIds,
      recipientAttachments: requestedRecipientAttachments,
    });
    const existingRuntime = idempotencyKey
      ? coordinationV3.runtimeCommunication(eventId)
      : undefined;
    const existingPayload = existingRuntime?.payload as {
      requestFingerprint?: string;
      communication?: CommunicationEvent;
      dispatch?: { recipients?: Array<{ agentId?: string; attachments?: Array<{ id?: string }> }> };
    } | undefined;
    if (existingPayload?.requestFingerprint) {
      if (existingPayload.requestFingerprint !== requestFingerprint) {
        return reply.code(409).send({ error: "runtime communication ID collision" });
      }
      const replayAgentIds = [...new Set((existingPayload.dispatch?.recipients ?? []).flatMap((recipient) =>
        typeof recipient.agentId === "string" && recipient.agentId.trim() ? [recipient.agentId.trim()] : []))];
      const replay = await reconcileLeasedCommunicationReplay({
        conversationLeases: conversationDeliveryLeases,
        agentLeases: agentDeliveryLeases,
        conversationId: request.params.id,
        agentIds: replayAgentIds,
        projectId: existingRuntime!.projectId,
        communicationEventId: eventId,
        reconcile: reconcileRuntimeCommunicationProjections,
        read: () => store.getConversationMessages(request.params.id, "collaboration")
          .find((candidate) => candidate.communicationEventId === eventId),
      });
      if (!replay.recovered) return reply.code(202).send({
        communicationEventId: eventId,
        committed: true,
        recovering: true,
        replayed: true,
      });
      const message = replay.value;
      if (!message) return reply.code(202).send({
        communicationEventId: eventId,
        committed: true,
        recovering: true,
        replayed: true,
      });
      return {
        message,
        audience: "mention",
        notifiedAgentIds: (existingPayload.dispatch?.recipients ?? [])
          .flatMap((recipient) => recipient.agentId ? [recipient.agentId] : []),
      };
    }
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
    if (projectDeletionInProgress(conversation.projectId)) {
      return reply.code(409).send({ error: "Project deletion is in progress" });
    }
    const detail = collaborationViewDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "conversation not found" });

    let renderedText = text;
    let routing: { intents: ConversationDeliveryIntent[]; blocked: Array<{ handle: string; reason: string }> };
    if (request.body.recipientAgentIds !== undefined) {
      const uniqueIds = normalizedRecipientAgentIds;
      const members = new Map(detail.agents.map((agent) => [agent.id, agent]));
      const targets = uniqueIds.map((id) => members.get(id));
      if (targets.some((target) => !target || target.archived)) {
        return reply.code(400).send({ error: "every collaboration recipient must be an active agent in this conversation" });
      }
      const recipientPrefix = targets.map((target) => `#${target!.handle}`).join(" ");
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
    const leasedAgentIds = routing.intents.map((intent) => intent.targetAgentId);
    if ([...attachmentIdsByAgent].some(([agentId, attachmentIds]) =>
      attachmentIds.some((attachmentId) => attachmentDeletionInProgress(agentId, attachmentId)))) {
      return reply.code(409).send({ error: "Asset deletion is in progress" });
    }
    if ([...attachmentIdsByAgent].some(([agentId, attachmentIds]) =>
      attachmentIds.length > 0 && assetReconciliationInProgress(agentId))) {
      return reply.code(409).send({ error: "Asset cleanup is in progress" });
    }
    if (leasedAgentIds.some(agentDeletionInProgress)) {
      return reply.code(409).send({ error: "Agent deletion is in progress" });
    }
    const releaseDeliveryLease = leaseConversationDelivery(
      conversationDeliveryLeases,
      agentDeliveryLeases,
      master.id,
      leasedAgentIds,
    );
    let prepared: Awaited<ReturnType<typeof prepareUserCommunicationText>> | undefined;
    let artifactCommitted = false;
    try {
    const attachmentsByAgent = new Map<string, AssetDto[]>();
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
    const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
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
          requestFingerprint,
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
      artifactCommitted = true;
    } catch (error) {
      const status = error instanceof AssetError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "collaboration conflict" });
    }
    try {
      await reconcileRuntimeCommunicationProjections({
        projectId: communication.projectId,
        communicationEventId: communication.eventId,
      });
    } catch {
      try { notifyScheduler(); } catch { /* recovery is durable */ }
      return reply.code(202).send({
        communicationEventId: communication.eventId,
        committed: true,
        recovering: true,
        notifiedAgentIds: routing.intents.map((intent) => intent.targetAgentId),
      });
    }
    let message;
    try {
      message = store.getConversationMessages(master.id, "collaboration")
        .find((candidate) => candidate.communicationEventId === communication.eventId);
    } catch {
      try { notifyScheduler(); } catch { /* recovery is durable */ }
      return reply.code(202).send({
        communicationEventId: communication.eventId,
        committed: true,
        recovering: true,
        notifiedAgentIds: routing.intents.map((intent) => intent.targetAgentId),
      });
    }
    if (!message) return reply.code(202).send({
      communicationEventId: communication.eventId,
      committed: true,
      recovering: true,
      notifiedAgentIds: routing.intents.map((intent) => intent.targetAgentId),
    });
    const notifiedAgentIds: string[] = [];
    try {
      for (const intent of routing.intents) {
        publishCoordinationV3Changed(intent.targetAgentId, {
          conversationIds: [master.id],
        });
      }
      if (!intake.replayed) appendWorkspace({ type: "conversation_changed", projectId: master.projectId, conversationId: master.id, action: "message" });
      notifyScheduler();
    } catch { /* canonical communication remains durable; clients can refresh */ }
    notifiedAgentIds.push(...routing.intents.map((intent) => intent.targetAgentId));
    return {
      message,
      audience: "mention",
      notifiedAgentIds,
    };
    } finally {
      if (!artifactCommitted) {
        cleanupUncommittedCommunicationArtifact({
          projectId: master.projectId,
          artifact: prepared?.artifact,
          runtimeArtifact: (artifactId) => coordinationV3.runtimeArtifact(artifactId),
          removeRuntimeArtifactReservation: (projectId, artifactId) =>
            assets.removeRuntimeArtifactReservation(projectId, artifactId),
        });
      }
      releaseDeliveryLease();
    }
  });

}
