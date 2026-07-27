import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  CancelMessageDeliveryRequest,
  CancelMessageDeliveryResponse,
  CancelQueuedMessageRequest,
  CancelQueuedMessageResponse,
  CommunicationEvent,
  CommunicationRevisionEvent,
  EditQueuedMessageRequest,
  EditQueuedMessageResponse,
  LetCurrentRunFinishRequest,
  LetCurrentRunFinishResponse,
  QueuedConversationMessageDto,
  RetryMessageDeliveryRequest,
  RetryMessageDeliveryResponse,
  SteerQueuedMessageRequest,
  SteerQueuedMessageResponse,
} from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { AssetError } from "../assets.js";
import type { PreparedCommunicationArtifact } from "./conversation-deliveries.js";

export type QueuedEditRevisionOutboxPayload = {
  activationId: string;
  agentId: string;
  conversationId: string;
  revision: CommunicationRevisionEvent;
  artifact?: PreparedCommunicationArtifact;
};

type PreparedCommunication = {
  canonicalText: string;
  publishedText: string;
  artifact?: PreparedCommunicationArtifact;
  document?: CommunicationEvent["document"];
};

type RuntimeArtifactInput = NonNullable<
  Parameters<CoordinationV3Store["recordRuntimeCommunication"]>[0]["artifacts"]
>[number];

export interface QueuedMessageRouteDependencies {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  prepareUserCommunicationText: (input: {
    projectId: string;
    communicationId: string;
    text: string;
    createdAt: string;
  }) => Promise<PreparedCommunication>;
  runtimeArtifactMetadata: (artifact: PreparedCommunicationArtifact) => RuntimeArtifactInput;
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  publishWorkspaceSince: (cursor: number) => void;
  publishCoordinationV3Changed: (agentId: string) => void;
  publishMessageDeliveryChanged: (agentId: string) => void;
  notifyScheduler: () => void;
  afterQueuedEditSqliteCommit?: (context: {
    activationId: string;
    revisionId: string;
  }) => void | Promise<void>;
}

const MAX_TEXT_LENGTH = 64 * 1024;

export function registerQueuedMessageRoutes(
  app: FastifyInstance,
  dependencies: QueuedMessageRouteDependencies,
): void {
  const {
    store,
    coordinationV3,
    workspace,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    appendWorkspace,
    publishWorkspaceSince,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    notifyScheduler,
    afterQueuedEditSqliteCommit,
  } = dependencies;
  app.post<{
    Params: { id: string; deliveryId: string };
    Body: CancelQueuedMessageRequest;
  }>("/api/conversations/:id/queued-messages/:deliveryId/cancel", async (request, reply) => {
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
    const activation = coordinationV3.pendingActivations(conversation.projectId)
      .find((candidate) => candidate.id === request.params.deliveryId);
    if (!activation) {
      const result = coordinationV3.cancelPendingActivation({
        activationId: request.params.deliveryId,
        projectId: conversation.projectId,
        idempotencyKey,
      });
      return result.cancelled
        ? result satisfies CancelQueuedMessageResponse
        : reply.code(409).send(result satisfies CancelQueuedMessageResponse);
    }
    const payload = activation.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent; dispatch?: { conversationId?: string } }
      : undefined;
    if (payload?.dispatch?.conversationId !== conversation.id) return reply.code(404).send({ error: "queued message not found" });
    if (payload.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(403).send({ error: "only your own queued messages can be cancelled" });
    }
    const result = coordinationV3.cancelPendingActivation({
      activationId: activation.id,
      projectId: conversation.projectId,
      idempotencyKey,
    });
    if (!result.cancelled) return reply.code(409).send(result satisfies CancelQueuedMessageResponse);
    appendWorkspace({ type: "queued_message_changed", conversationId: conversation.id, deliveryId: activation.id, action: "cancelled" });
    publishCoordinationV3Changed(activation.agentId);
    return result satisfies CancelQueuedMessageResponse;
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/queued-messages", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    let position = 0;
    return coordinationV3.pendingActivations(agent.projectId).flatMap((activation) => {
      if (activation.agentId !== agent.id) return [];
      const payload = activation.payload && typeof activation.payload === "object"
        ? activation.payload as { communication?: CommunicationEvent; dispatch?: { text?: string; sourceConversationId?: string | null; conversationId?: string } }
        : undefined;
      const communication = payload?.communication;
      if (communication?.sender.kind !== "user" || communication.sender.userId !== "local-operator") return [];
      position += 1;
      return [{
        deliveryId: activation.id,
        messageId: communication.eventId,
        conversationId: payload?.dispatch?.sourceConversationId ?? payload?.dispatch?.conversationId ?? communication.conversationId ?? agent.conversationId ?? "",
        targetAgentId: agent.id,
        text: payload?.dispatch?.text ?? communication.text,
        position,
        createdAt: activation.createdAt,
        status: "queued",
      } satisfies QueuedConversationMessageDto];
    });
  });

  app.post<{
    Params: { id: string; deliveryId: string };
    Body: CancelQueuedMessageRequest;
  }>("/api/agents/:id/queued-messages/:deliveryId/cancel", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const activation = coordinationV3.pendingActivations(agent.projectId)
      .find((candidate) => candidate.id === request.params.deliveryId && candidate.agentId === agent.id);
    const payload = activation?.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent }
      : undefined;
    if (!activation || payload?.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(404).send({ error: "queued message not found" });
    }
    const result = coordinationV3.cancelPendingActivation({
      activationId: activation.id, projectId: agent.projectId, idempotencyKey,
    });
    if (!result.cancelled) return reply.code(409).send(result satisfies CancelQueuedMessageResponse);
    const conversationId = payload.communication.conversationId ?? agent.conversationId;
    if (conversationId) appendWorkspace({ type: "queued_message_changed", conversationId, deliveryId: activation.id, action: "cancelled" });
    publishCoordinationV3Changed(agent.id);
    return result satisfies CancelQueuedMessageResponse;
  });

  app.patch<{
    Params: { id: string; deliveryId: string };
    Body: EditQueuedMessageRequest;
  }>("/api/agents/:id/queued-messages/:deliveryId", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    const rawText = request.body?.text ?? "";
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!rawText.trim() || rawText.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "queued message text is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const activation = coordinationV3.pendingActivations(agent.projectId)
      .find((candidate) => candidate.id === request.params.deliveryId && candidate.agentId === agent.id);
    const payload = activation?.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent }
      : undefined;
    if (!activation || payload?.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(404).send({ error: "queued message not found" });
    }
    const createdAt = new Date().toISOString();
    const revisionId = `queued-edit-${createHash("sha256")
      .update(`${agent.projectId}\0${activation.id}\0${idempotencyKey}`)
      .digest("hex")}`;
    let prepared: Awaited<ReturnType<typeof prepareUserCommunicationText>>;
    try {
      prepared = await prepareUserCommunicationText({
        projectId: agent.projectId,
        communicationId: revisionId,
        text: rawText,
        createdAt,
      });
    } catch (error) {
      const status = error instanceof AssetError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "queued-message edit staging failed" });
    }
    const conversationId = payload.communication.conversationId ?? agent.conversationId;
    if (!conversationId) return reply.code(409).send({ error: "queued message has no conversation" });
    const revision: CommunicationRevisionEvent = {
      eventId: revisionId,
      schemaVersion: 1,
      projectId: agent.projectId,
      conversationId,
      targetEventId: payload.communication.eventId,
      kind: "edit",
      sender: { kind: "user", userId: "local-operator" },
      text: prepared.publishedText,
      createdAt,
      idempotencyKey: `queued-edit:${activation.id}:${idempotencyKey}`,
    };
    const result = coordinationV3.editPendingActivationText({
      activationId: activation.id,
      projectId: agent.projectId,
      requestText: prepared.canonicalText,
      text: prepared.publishedText,
      ...(prepared.document ? { document: prepared.document as unknown as Record<string, unknown> } : {}),
      ...(prepared.artifact ? {
        artifactId: prepared.artifact.id,
        resultRef: `ponderosa://artifact/${prepared.artifact.id}`,
      } : {}),
      revisionOwnerId: revisionId,
      ...(prepared.artifact ? { artifact: runtimeArtifactMetadata(prepared.artifact) } : {}),
      revisionOutboxPayload: {
        activationId: activation.id,
        agentId: agent.id,
        conversationId,
        revision,
        ...(prepared.artifact ? { artifact: prepared.artifact } : {}),
      } satisfies QueuedEditRevisionOutboxPayload,
      idempotencyKey,
      now: createdAt,
    });
    if (!result.edited) return reply.code(409).send(result satisfies EditQueuedMessageResponse);
    if (!result.replayed) await afterQueuedEditSqliteCommit?.({
      activationId: activation.id,
      revisionId,
    });
    publishCoordinationV3Changed(agent.id);
    notifyScheduler();
    return result satisfies EditQueuedMessageResponse;
  });

  app.post<{
    Params: { id: string; deliveryId: string };
    Body: SteerQueuedMessageRequest;
  }>("/api/agents/:id/queued-messages/:deliveryId/steer", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const activation = coordinationV3.pendingActivations(agent.projectId)
      .find((candidate) => candidate.id === request.params.deliveryId && candidate.agentId === agent.id);
    const payload = activation?.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent }
      : undefined;
    if (!activation || payload?.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(404).send({ error: "queued message not found" });
    }
    const result = coordinationV3.steerPendingActivation({
      activationId: activation.id, projectId: agent.projectId, idempotencyKey,
    });
    if (!result.steered) return reply.code(409).send(result satisfies SteerQueuedMessageResponse);
    const conversationId = payload.communication.conversationId ?? agent.conversationId;
    if (conversationId) appendWorkspace({ type: "queued_message_changed", conversationId, deliveryId: activation.id, action: "steered" });
    publishCoordinationV3Changed(agent.id);
    notifyScheduler();
    return result satisfies SteerQueuedMessageResponse;
  });

  app.post<{
    Params: { injectionId: string };
    Body: LetCurrentRunFinishRequest;
  }>("/api/message-deliveries/:injectionId/let-current-run-finish", async (request, reply) => {
    const injectionId = request.params.injectionId?.trim() ?? "";
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!injectionId) return reply.code(400).send({ error: "injectionId is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    }
    const result = coordinationV3.letCurrentRunFinish({ injectionId, idempotencyKey });
    if (!result.accepted || !result.agentId) {
      return reply.code(409).send({
        accepted: false, replayed: result.replayed, state: "not_recoverable",
      } satisfies LetCurrentRunFinishResponse);
    }
    notifyScheduler();
    publishMessageDeliveryChanged(result.agentId);
    return reply.code(202).send({
      accepted: true,
      replayed: result.replayed,
      state: result.state,
    } satisfies LetCurrentRunFinishResponse);
  });

  app.post<{
    Params: { projectId: string; activationId: string };
    Body: RetryMessageDeliveryRequest;
  }>("/api/projects/:projectId/message-deliveries/:activationId/retry", async (request, reply) => {
    const projectId = request.params.projectId?.trim() ?? "";
    const activationId = request.params.activationId?.trim() ?? "";
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!projectId) return reply.code(400).send({ error: "projectId is required" });
    if (!activationId) return reply.code(400).send({ error: "activationId is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    }
    const result = coordinationV3.retryMessageDelivery({ projectId, activationId, idempotencyKey });
    if (!result.accepted || !result.targetAgentId) {
      const status = result.rejectionReason === "not_found" ? 404 : 409;
      return reply.code(status).send(result satisfies RetryMessageDeliveryResponse);
    }
    notifyScheduler();
    publishMessageDeliveryChanged(result.targetAgentId);
    return reply.code(202).send(result satisfies RetryMessageDeliveryResponse);
  });

  app.post<{
    Params: { projectId: string; activationId: string };
    Body: CancelMessageDeliveryRequest;
  }>("/api/projects/:projectId/message-deliveries/:activationId/cancel", async (request, reply) => {
    const projectId = request.params.projectId?.trim() ?? "";
    const activationId = request.params.activationId?.trim() ?? "";
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!projectId) return reply.code(400).send({ error: "projectId is required" });
    if (!activationId) return reply.code(400).send({ error: "activationId is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    }
    const result = coordinationV3.cancelTerminalMessageDelivery({ projectId, activationId, idempotencyKey });
    if (!result.cancelled) return reply.code(409).send(result satisfies CancelMessageDeliveryResponse);
    const cursor = workspace.cursor();
    for (const notification of workspace.listNotifications()) {
      if (notification.dedupeKey?.startsWith(`communication-delivery:${activationId}:`)) {
        workspace.setNotificationStatus(notification.id, "dismissed");
      }
    }
    publishWorkspaceSince(cursor);
    if (result.targetAgentId) publishMessageDeliveryChanged(result.targetAgentId);
    return result satisfies CancelMessageDeliveryResponse;
  });
}
