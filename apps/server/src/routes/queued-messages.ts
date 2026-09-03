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
import { CoordinationIdempotencyConflictError } from "@ponderosa/agents";
import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { AssetError } from "../assets.js";
import { leaseConversationDelivery } from "../delivery-leases.js";
import type { PreparedCommunicationArtifact } from "./conversation-deliveries.js";

export type QueuedEditRevisionOutboxPayload = {
  activationId: string;
  agentId: string;
  conversationId: string;
  revision: CommunicationRevisionEvent;
  artifact?: PreparedCommunicationArtifact;
};

export type QueuedMessageChangeOutboxPayload = {
  activationId: string;
  projectId: string;
  agentId: string;
  conversationId: string;
  action: "cancelled";
};

export function applyQueuedMessageChangeOutbox(
  input: { activationId: string },
  dependencies: Pick<
    QueuedMessageRouteDependencies,
    "coordinationV3" | "workspace" | "appendWorkspace" |
    "publishCoordinationV3Changed"
  >,
): void {
  const change = dependencies.coordinationV3.queuedMessageCancellationChange(
    input.activationId,
  );
  if (!change) throw new Error("queued-message cancellation authority is unavailable");
  if (!dependencies.workspace.hasQueuedMessageChange({
    conversationId: change.conversationId,
    deliveryId: change.activationId,
    action: change.action,
  })) {
    dependencies.appendWorkspace({
      type: "queued_message_changed",
      conversationId: change.conversationId,
      deliveryId: change.activationId,
      action: change.action,
    });
  }
  dependencies.publishCoordinationV3Changed(change.agentId, {
    conversationIds: [change.conversationId],
  });
}

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
  projectDeletionInProgress: (projectId: string) => boolean;
  conversationDeletionInProgress: (conversationId: string) => boolean;
  agentDeletionInProgress: (agentId: string) => boolean;
  conversationDeliveryLeases: Map<string, number>;
  agentDeliveryLeases: Map<string, number>;
  prepareUserCommunicationText: (input: {
    projectId: string;
    communicationId: string;
    text: string;
    createdAt: string;
  }) => Promise<PreparedCommunication>;
  runtimeArtifactMetadata: (artifact: PreparedCommunicationArtifact) => RuntimeArtifactInput;
  removeRuntimeArtifactReservation: (projectId: string, artifactId: string) => void;
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  publishWorkspaceSince: (cursor: number) => void;
  publishCoordinationV3Changed: (
    agentId: string,
    options?: { conversationIds?: string[] },
  ) => void;
  publishMessageDeliveryChanged: (agentId: string) => void;
  notifyScheduler: () => void;
}

const MAX_TEXT_LENGTH = 64 * 1024;

function exactStringBody(
  body: unknown,
  allowedFields: readonly string[],
): { value: Record<string, string | undefined> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "request body must be an object" };
  }
  const candidate = body as Record<string, unknown>;
  const unknownFields = Object.keys(candidate).filter((key) => !allowedFields.includes(key));
  if (unknownFields.length) return { error: `unknown field(s): ${unknownFields.join(", ")}` };
  for (const field of allowedFields) {
    if (candidate[field] !== undefined && typeof candidate[field] !== "string") {
      return { error: `${field} must be a string` };
    }
  }
  return { value: candidate as Record<string, string | undefined> };
}

function bestEffort(effect: () => void): void {
  try {
    effect();
  } catch {
    // Canonical delivery state remains authoritative.
  }
}

export function registerQueuedMessageRoutes(
  app: FastifyInstance,
  dependencies: QueuedMessageRouteDependencies,
): void {
  const {
    store,
    coordinationV3,
    workspace,
    projectDeletionInProgress,
    conversationDeletionInProgress,
    agentDeletionInProgress,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    removeRuntimeArtifactReservation,
    appendWorkspace,
    publishWorkspaceSince,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    notifyScheduler,
  } = dependencies;
  app.post<{
    Params: { id: string; deliveryId: string };
    Body: CancelQueuedMessageRequest;
  }>("/api/conversations/:id/queued-messages/:deliveryId/cancel", async (request, reply) => {
    const parsed = exactStringBody(request.body, ["idempotencyKey"]);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const idempotencyKey = parsed.value.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
    const activation = coordinationV3.activation(request.params.deliveryId, conversation.projectId);
    const payload = activation?.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent; dispatch?: { conversationId?: string } }
      : undefined;
    if (!activation || activation.dispatchPolicy !== "next_run" ||
        payload?.dispatch?.conversationId !== conversation.id) {
      return reply.code(404).send({ error: "queued message not found" });
    }
    if (payload.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(403).send({ error: "only your own queued messages can be cancelled" });
    }
    let result: ReturnType<CoordinationV3Store["cancelPendingActivation"]>;
    try {
      result = coordinationV3.cancelPendingActivation({
        activationId: activation.id,
        projectId: conversation.projectId,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof CoordinationIdempotencyConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
    if (!result.cancelled) return reply.code(409).send(result satisfies CancelQueuedMessageResponse);
    bestEffort(notifyScheduler);
    return result satisfies CancelQueuedMessageResponse;
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/queued-messages", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    let position = 0;
    return coordinationV3.pendingActivations(agent.projectId).flatMap((activation) => {
      if (activation.agentId !== agent.id ||
          activation.dispatchPolicy !== "next_run") return [];
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
    const parsed = exactStringBody(request.body, ["idempotencyKey"]);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const idempotencyKey = parsed.value.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const activation = coordinationV3.activation(request.params.deliveryId, agent.projectId);
    const payload = activation?.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent }
      : undefined;
    if (!activation || activation.agentId !== agent.id || activation.dispatchPolicy !== "next_run" ||
        payload?.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(404).send({ error: "queued message not found" });
    }
    let result: ReturnType<CoordinationV3Store["cancelPendingActivation"]>;
    try {
      result = coordinationV3.cancelPendingActivation({
        activationId: activation.id, projectId: agent.projectId, idempotencyKey,
      });
    } catch (error) {
      if (error instanceof CoordinationIdempotencyConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
    if (!result.cancelled) return reply.code(409).send(result satisfies CancelQueuedMessageResponse);
    bestEffort(notifyScheduler);
    return result satisfies CancelQueuedMessageResponse;
  });

  app.patch<{
    Params: { id: string; deliveryId: string };
    Body: EditQueuedMessageRequest;
  }>("/api/agents/:id/queued-messages/:deliveryId", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    const parsed = exactStringBody(request.body, ["text", "idempotencyKey"]);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const rawText = parsed.value.text ?? "";
    const idempotencyKey = parsed.value.idempotencyKey?.trim() ?? "";
    if (!rawText.trim() || rawText.length > MAX_TEXT_LENGTH) return reply.code(400).send({ error: "queued message text is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const activation = coordinationV3.pendingActivations(agent.projectId)
      .find((candidate) =>
        candidate.id === request.params.deliveryId &&
        candidate.agentId === agent.id &&
        candidate.dispatchPolicy === "next_run");
    const payload = activation?.payload && typeof activation.payload === "object"
      ? activation.payload as { communication?: CommunicationEvent }
      : undefined;
    if (!activation || payload?.communication?.sender.kind !== "user" || payload.communication.sender.userId !== "local-operator") {
      return reply.code(404).send({ error: "queued message not found" });
    }
    const conversationId = payload.communication.conversationId ?? agent.conversationId;
    if (!conversationId) return reply.code(409).send({ error: "queued message has no conversation" });
    const conversation = store.getConversation(conversationId);
    if (projectDeletionInProgress(agent.projectId) || conversationDeletionInProgress(conversationId) ||
        agentDeletionInProgress(agent.id) || !conversation || conversation.archived ||
        conversation.projectId !== agent.projectId) {
      return reply.code(409).send({ error: "queued message participants are no longer available" });
    }
    const releaseDeliveryLease = leaseConversationDelivery(
      conversationDeliveryLeases,
      agentDeliveryLeases,
      conversationId,
      [agent.id],
    );
    let prepared: Awaited<ReturnType<typeof prepareUserCommunicationText>> | undefined;
    let artifactCommitted = false;
    try {
      const currentAgent = store.getAgent(agent.id);
      const currentConversation = store.getConversation(conversationId);
      if (projectDeletionInProgress(agent.projectId) || conversationDeletionInProgress(conversationId) ||
          agentDeletionInProgress(agent.id) || !currentAgent || currentAgent.archived ||
          !currentConversation || currentConversation.archived ||
          currentConversation.projectId !== agent.projectId || currentAgent.conversationId !== conversationId) {
        return reply.code(409).send({ error: "queued message participants are no longer available" });
      }
      const createdAt = new Date().toISOString();
      const revisionId = `queued-edit-${createHash("sha256")
        .update(`${agent.projectId}\0${activation.id}\0${idempotencyKey}`)
        .digest("hex")}`;
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
      artifactCommitted = true;
      bestEffort(() => publishCoordinationV3Changed(agent.id, { conversationIds: [conversationId] }));
      bestEffort(notifyScheduler);
      return result satisfies EditQueuedMessageResponse;
    } finally {
      if (prepared?.artifact && !artifactCommitted) {
        bestEffort(() => removeRuntimeArtifactReservation(agent.projectId, prepared!.artifact!.id));
      }
      releaseDeliveryLease();
    }
  });

  app.post<{
    Params: { id: string; deliveryId: string };
    Body: SteerQueuedMessageRequest;
  }>("/api/agents/:id/queued-messages/:deliveryId/steer", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    const parsed = exactStringBody(request.body, ["idempotencyKey"]);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const idempotencyKey = parsed.value.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    const activation = coordinationV3.pendingActivations(agent.projectId)
      .find((candidate) =>
        candidate.id === request.params.deliveryId &&
        candidate.agentId === agent.id &&
        candidate.dispatchPolicy === "next_run");
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
    if (conversationId) {
      bestEffort(() => appendWorkspace({ type: "queued_message_changed", conversationId, deliveryId: activation.id, action: "steered" }));
    }
    bestEffort(() => publishCoordinationV3Changed(agent.id, { conversationIds: conversationId ? [conversationId] : [] }));
    bestEffort(notifyScheduler);
    return result satisfies SteerQueuedMessageResponse;
  });

  app.post<{
    Params: { injectionId: string };
    Body: LetCurrentRunFinishRequest;
  }>("/api/message-deliveries/:injectionId/let-current-run-finish", async (request, reply) => {
    const injectionId = request.params.injectionId?.trim() ?? "";
    const parsed = exactStringBody(request.body, ["idempotencyKey"]);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const idempotencyKey = parsed.value.idempotencyKey?.trim() ?? "";
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
    bestEffort(notifyScheduler);
    bestEffort(() => publishMessageDeliveryChanged(result.agentId!));
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
    const parsed = exactStringBody(request.body, ["idempotencyKey"]);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const idempotencyKey = parsed.value.idempotencyKey?.trim() ?? "";
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
    bestEffort(notifyScheduler);
    bestEffort(() => publishMessageDeliveryChanged(result.targetAgentId!));
    return reply.code(202).send(result satisfies RetryMessageDeliveryResponse);
  });

  app.post<{
    Params: { projectId: string; activationId: string };
    Body: CancelMessageDeliveryRequest;
  }>("/api/projects/:projectId/message-deliveries/:activationId/cancel", async (request, reply) => {
    const projectId = request.params.projectId?.trim() ?? "";
    const activationId = request.params.activationId?.trim() ?? "";
    const parsed = exactStringBody(request.body, ["idempotencyKey"]);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const idempotencyKey = parsed.value.idempotencyKey?.trim() ?? "";
    if (!projectId) return reply.code(400).send({ error: "projectId is required" });
    if (!activationId) return reply.code(400).send({ error: "activationId is required" });
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
    }
    const result = coordinationV3.cancelTerminalMessageDelivery({ projectId, activationId, idempotencyKey });
    if (!result.cancelled) return reply.code(409).send(result satisfies CancelMessageDeliveryResponse);
    bestEffort(() => {
      const cursor = workspace.cursor();
      workspace.forEachNotification((notification) => {
        if (notification.dedupeKey?.startsWith(`communication-delivery:${activationId}:`)) {
          workspace.setNotificationStatus(notification.id, "dismissed");
        }
      });
      publishWorkspaceSince(cursor);
    });
    if (result.targetAgentId) bestEffort(() => publishMessageDeliveryChanged(result.targetAgentId!));
    return result satisfies CancelMessageDeliveryResponse;
  });
}
