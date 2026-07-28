import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  CommunicationEvent,
  CommunicationRevisionEvent,
  CorrectConversationMessageRequest,
  CorrectConversationMessageResponse,
} from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { stripLeadingScopeTag } from "../agent-mentions.js";

export interface ConversationCorrectionRouteDependencies {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  recordCommunication: (event: CommunicationEvent) => CommunicationEvent;
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  publishCoordinationV3Changed: (
    agentId: string,
    options?: { conversationIds?: string[] },
  ) => void;
  notifyScheduler: () => void;
}

const MAX_TEXT_LENGTH = 64 * 1024;

export function registerConversationCorrectionRoutes(
  app: FastifyInstance,
  dependencies: ConversationCorrectionRouteDependencies,
): void {
  const {
    store,
    coordinationV3,
    recordCommunication,
    appendWorkspace,
    publishCoordinationV3Changed,
    notifyScheduler,
  } = dependencies;
  app.post<{
    Params: { id: string; messageId: string };
    Body: CorrectConversationMessageRequest;
  }>("/api/conversations/:id/messages/:messageId/corrections", async (request, reply) => {
    const text = request.body?.text?.trim() ?? "";
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!text || text.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "correction text is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    if (request.body?.activeRunDelivery && request.body.activeRunDelivery !== "queue") return reply.code(400).send({ error: "corrections always queue a new turn" });
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
    const receiptKey = `correction:${conversation.id}:${idempotencyKey}`;
    const messages = store.getConversationMessages(conversation.id, "main");
    const requestedOperatorMessage = messages.find((message) => message.id === request.params.messageId && message.role === "user" && !message.authorAgentId);
    const existingMessage = store.getConversationMessageByReceiptKey(conversation.id, receiptKey);
    if (!existingMessage && !requestedOperatorMessage) {
      return reply.code(409).send({ error: "only your own sent messages can be corrected" });
    }
    if (!existingMessage && requestedOperatorMessage?.correctedByMessageId) return reply.code(409).send({ error: "this message already has an immutable correction" });
    const original = existingMessage
      ? messages.find((message) => message.id === existingMessage.correctionOfMessageId)
      : requestedOperatorMessage;
    const originalEventId = original?.communicationEventId;
    const originalCommunication = originalEventId
      ? store.getCommunicationEvent(conversation.projectId, originalEventId)
      : undefined;
    if (originalCommunication?.intent === "broadcast") {
      const revisionText = stripLeadingScopeTag(text, "broadcast");
      const eventId = `communication-edit-${createHash("sha256").update(receiptKey).digest("hex")}`;
      const revision: CommunicationRevisionEvent = {
        eventId,
        schemaVersion: 1,
        kind: "edit",
        projectId: conversation.projectId,
        conversationId: conversation.id,
        targetEventId: originalCommunication.eventId,
        sender: { kind: "user", userId: "local-operator" },
        text: revisionText,
        createdAt: new Date().toISOString(),
        idempotencyKey: receiptKey,
      };
      try {
        const stored = store.appendCommunicationRevision(revision);
        if (!stored.replayed) appendWorkspace({ type: "conversation_changed", projectId: conversation.projectId, conversationId: conversation.id, action: "updated" });
        return {
          originalMessageId: request.params.messageId,
          correctionMessageId: stored.revision.eventId,
          replayed: stored.replayed,
          queued: false,
        } satisfies CorrectConversationMessageResponse;
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "broadcast edit conflict" });
      }
    }
    const targets = originalEventId
      ? coordinationV3.communicationRecipientAgentIds(conversation.projectId, originalEventId)
      : [];
    if (targets.length !== 1) {
      return reply.code(409).send({ error: targets.length === 0 ? "message delivery has not been scheduled" : "messages sent to multiple agents cannot be corrected as one turn" });
    }
    const target = store.getAgent(targets[0]!);
    if (!target || target.archived || !target.conversationIds.includes(conversation.id)) return reply.code(409).send({ error: "the original recipient is no longer available" });
    const eventId = `correction-${createHash("sha256").update(receiptKey).digest("hex")}`;
    const existingRuntime = coordinationV3.runtimeCommunication(eventId);
    const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
    const communication: CommunicationEvent = {
      eventId, schemaVersion: 2, projectId: conversation.projectId, conversationId: conversation.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: target.id }, text,
      createdAt, idempotencyKey: receiptKey, correctionOfEventId: originalEventId,
    };
    let intake;
    try {
      intake = coordinationV3.recordRuntimeCommunication({
        id: eventId,
        projectId: conversation.projectId,
        sender: { kind: "user", userId: "local-operator" },
        intent: "correction",
        audience: communication.audience,
        payload: {
          communication,
          dispatch: {
            conversationId: conversation.id,
            text,
            activeRunDelivery: "queue",
            correctionOfMessageId: request.params.messageId,
            correctionOfEventId: originalEventId,
          },
        },
        activation: {
          agentId: target.id,
          kind: "message_correction",
          priority: 100,
          dispatchPolicy: "next_run",
          promptClass: "human",
        },
        now: createdAt,
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "correction conflict" });
    }
    recordCommunication(communication);
    store.appendCommunicationProjection(conversation.projectId, {
      eventId, surface: "user_inbox", projectionKey: "local-operator", projectedAt: createdAt,
    });
    let message = existingMessage;
    if (!message) {
      message = store.appendConversationMessage(
        conversation.id,
        { text },
        undefined,
        "main",
        [{ targetAgentId: target.id, relayDepth: 0, mentionTrail: [], kind: "direct" }],
        receiptKey,
        eventId,
      );
    }
    if (!message) return reply.code(503).send({ error: "correction projection could not be recorded; retry is safe" });
    publishCoordinationV3Changed(target.id, {
      conversationIds: [conversation.id],
    });
    notifyScheduler();
    return {
      originalMessageId: request.params.messageId,
      correctionMessageId: message.id,
      replayed: intake.replayed,
      queued: true,
    } satisfies CorrectConversationMessageResponse;
  });
}
