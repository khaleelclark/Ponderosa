import {
  LONG_TEXT_MAX_UTF8_BYTES,
  canonicalizeProviderText,
  shouldBackTextWithArtifact,
  type CommunicationEvent,
  type CoordinationRequestUpdateKind,
} from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";
import type { createCommunicationArtifactAuthority } from "../communication-artifacts.js";
import type { PreparedCommunicationArtifact } from "./conversation-deliveries.js";
import { derivedRunActionKey } from "../security.js";
import { leaseAgentDelivery, leaseConversationDelivery } from "../delivery-leases.js";
import {
  isRequestCommunicationHandoffKind,
  requestUpdateCommunicationEventId,
} from "../request-update-communication.js";

type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface AgentRequestCommandRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  projectDeletionInProgress(projectId: string): boolean;
  conversationDeletionInProgress(conversationId: string): boolean;
  agentDeletionInProgress(agentId: string): boolean;
  conversationDeliveryLeases: Map<string, number>;
  agentDeliveryLeases: Map<string, number>;
  capabilityMatchesCleanupRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
  runAuthorization(capability: AgentMessageCapability): {
    runId: string;
    agentId: string;
    fencingToken: number;
  };
  projectCommunicationArtifact: CommunicationArtifactAuthority["projectCommunicationArtifact"];
  requestArtifactAccess: CommunicationArtifactAuthority["requestArtifactAccess"];
  runtimeArtifactMetadata: CommunicationArtifactAuthority["runtimeArtifactMetadata"];
  stageCommunicationArtifact: CommunicationArtifactAuthority["stageCommunicationArtifact"];
  removeRuntimeArtifactReservation(projectId: string, artifactId: string): void;
  recordCommunication(event: CommunicationEvent): CommunicationEvent;
  projectCommunicationToAgentAudit(
    agentId: string,
    event: CommunicationEvent,
    renderedText: string,
  ): void;
  publishCoordinationV3Changed(
    agentId: string,
    options?: { conversationIds?: string[] },
  ): void;
  notifyScheduler(): void;
}

export function registerAgentRequestCommandRoutes(
  app: FastifyInstance,
  context: AgentRequestCommandRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    agentMessageCapabilities,
    activeRuns,
    projectDeletionInProgress,
    conversationDeletionInProgress,
    agentDeletionInProgress,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    capabilityMatchesCleanupRun,
    runAuthorization,
    projectCommunicationArtifact,
    requestArtifactAccess,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
    removeRuntimeArtifactReservation,
    recordCommunication,
    projectCommunicationToAgentAudit,
    publishCoordinationV3Changed,
    notifyScheduler,
  } = context;

  app.post<{
    Body: { requestId?: string; updateId?: string; kind?: CoordinationRequestUpdateKind; text?: string; question?: string; inReplyToUpdateId?: string };
  }>("/api/agent-request-updates", async (request, reply) => {
    if (!coordinationV3) return reply.code(404).send({ error: "Communication V3 is not enabled" });
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    if (!capability || !capabilityMatchesCleanupRun(capability, active) || active!.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const body = request.body as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "request update body must be an object" });
    }
    const candidate = body as Record<string, unknown>;
    const unknownFields = Object.keys(candidate).filter((key) =>
      !["requestId", "updateId", "kind", "text", "question", "inReplyToUpdateId"].includes(key));
    if (unknownFields.length) {
      return reply.code(400).send({ error: `unknown request update field(s): ${unknownFields.join(", ")}` });
    }
    for (const key of ["requestId", "updateId", "text", "question", "inReplyToUpdateId"] as const) {
      if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
        return reply.code(400).send({ error: `${key} must be a string` });
      }
    }
    const allowedKinds: readonly CoordinationRequestUpdateKind[] = [
      "progress", "waiting_dependency", "dependency_resolved", "question", "answer",
      "completed", "blocked", "failed", "cancelled", "superseded",
      "recipient_unavailable", "outcome_unknown", "expired",
    ];
    if (candidate.kind !== undefined &&
        (typeof candidate.kind !== "string" || !allowedKinds.includes(candidate.kind as CoordinationRequestUpdateKind))) {
      return reply.code(400).send({ error: "kind is not a recognized request update kind" });
    }
    const steeringInjectionIds = coordinationV3.steeringInjectionIds(capability.runId);
    const suppliedRequestId = request.body?.requestId?.trim();
    const attachedRequestIds = coordinationV3.requestIdsAttachedToRun(
      capability.v3SchedulerRunId,
      capability.agentId,
    );
    const requestId = suppliedRequestId ?? (attachedRequestIds.length === 1 ? attachedRequestIds[0] : undefined);
    const question = request.body?.question === undefined
      ? undefined
      : canonicalizeProviderText(request.body.question, steeringInjectionIds).trim();
    if (question && (request.body?.text !== undefined || request.body?.kind !== undefined)) {
      return reply.code(400).send({ error: "question shorthand cannot be combined with text or kind" });
    }
    const canonicalText = request.body?.text === undefined
      ? undefined
      : canonicalizeProviderText(request.body.text, steeringInjectionIds).trim();
    const kind = question ? "question" : request.body?.kind ?? (canonicalText ? "completed" : undefined);
    if (!kind) return reply.code(400).send({ error: "request update requires text, question, or an explicit kind" });
    if (kind === "answer" && !request.body?.inReplyToUpdateId?.trim()) {
      return reply.code(400).send({
        error: "answer requires inReplyToUpdateId=\"<question ID>\" from the current coordination_question Activation",
      });
    }
    if (!requestId) return reply.code(400).send({
      error: attachedRequestIds.length === 0
        ? "requestId is required because the current run has no attached correlated request"
        : "requestId is required because the current run has multiple attached correlated requests",
      currentRequestIds: attachedRequestIds,
    });
    const handoffText = question ?? canonicalText ?? "";
    if (Buffer.byteLength(handoffText, "utf8") > LONG_TEXT_MAX_UTF8_BYTES) {
      return reply.code(413).send({ error: "request update text exceeds the 8 MiB limit" });
    }
    if (kind && (["completed", "blocked", "failed"] as CoordinationRequestUpdateKind[]).includes(kind) && !handoffText) {
      return reply.code(400).send({ error: "terminal request updates require a canonical final handoff in text" });
    }
    if (suppliedRequestId && !coordinationV3.getRequest(suppliedRequestId)) return reply.code(409).send({
      error: "request not found",
      currentRequestIds: attachedRequestIds,
      hint: attachedRequestIds.length === 1
        ? "Retry without requestId to target the current run's attached request"
        : "Retry with one exact currentRequestId",
    });
    const currentRequest = coordinationV3.getRequest(requestId);
    if (!currentRequest) return reply.code(409).send({ error: "request not found" });
    const updateId = request.body?.updateId?.trim() || derivedRunActionKey(capability.runId, "report", {
      requestId,
      kind,
      text: handoffText,
      inReplyToUpdateId: request.body.inReplyToUpdateId?.trim() || null,
    });
    let artifact: PreparedCommunicationArtifact | undefined;
    const cleanupArtifact = () => {
      if (!artifact?.reservationCreated) return;
      try {
        if (!coordinationV3.runtimeArtifact(artifact.id)) {
          removeRuntimeArtifactReservation(currentRequest.projectId, artifact.id);
        }
      } catch { /* preserve uncertain authority for startup reconciliation */ }
    };
    try {
      if (shouldBackTextWithArtifact(handoffText)) {
        artifact = await stageCommunicationArtifact({
          projectId: currentRequest.projectId,
          communicationId: updateId,
          role: "long_text",
          title: kind === "question" ? "Blocking question" : "Request result",
          content: handoffText,
          originAgentId: capability.agentId,
          executionId: capability.runId,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "request artifact staging failed" });
    }
    const persistedText = artifact
      ? `Full ${kind === "question" ? "question" : "result"}: ponderosa://artifact/${artifact.id}`
      : handoffText;
    const updateInput = {
      requestId,
      updateId,
      kind,
      actor: { kind: "agent" as const, id: capability.agentId },
      runAuthorization: runAuthorization(capability),
      ...(request.body.inReplyToUpdateId?.trim() ? { inReplyToUpdateId: request.body.inReplyToUpdateId.trim() } : {}),
      payload: {
        text: persistedText,
        ...(artifact ? { artifactId: artifact.id, resultRef: `ponderosa://artifact/${artifact.id}` } : {}),
        executionId: capability.runId,
        canonicalHandoff: (["completed", "blocked", "failed"] as CoordinationRequestUpdateKind[]).includes(kind),
      },
      ...(artifact ? { artifacts: [runtimeArtifactMetadata(artifact)] } : {}),
    };
    let durableResult: ReturnType<CoordinationV3Store["updateRequest"]> | undefined;
    try {
      durableResult = coordinationV3.replayRequestUpdate(updateInput);
    } catch (error) {
      cleanupArtifact();
      return reply.code(409).send({ error: error instanceof Error ? error.message : "request update replay failed" });
    }
    let releaseDeliveryLease = () => {};
    if (!durableResult) {
      const currentAuthor = store.getAgent(capability.agentId);
      if (!currentAuthor || currentAuthor.archived || currentRequest.projectId !== currentAuthor.projectId) {
        cleanupArtifact();
        return reply.code(409).send({ error: "request participants are no longer available" });
      }
      const conversation = currentRequest.conversationId
        ? store.getConversation(currentRequest.conversationId)
        : undefined;
      if (projectDeletionInProgress(currentAuthor.projectId) ||
          (currentRequest.conversationId &&
            (!conversation || conversation.projectId !== currentAuthor.projectId || conversation.archived ||
              conversationDeletionInProgress(currentRequest.conversationId)))) {
        cleanupArtifact();
        return reply.code(409).send({ error: "request Chat is no longer available" });
      }
      const leasedAgentIds = [...new Set([
        capability.agentId,
        currentRequest.recipientAgentId,
        ...(currentRequest.requesterAgentId ? [currentRequest.requesterAgentId] : []),
      ])];
      const participants = leasedAgentIds.map((agentId) => store.getAgent(agentId));
      if (participants.some((agent) => !agent || agent.archived ||
          agent.projectId !== currentAuthor.projectId ||
          (currentRequest.conversationId && agent.conversationId !== currentRequest.conversationId))) {
        cleanupArtifact();
        return reply.code(409).send({ error: "request participants are no longer available" });
      }
      if (leasedAgentIds.some(agentDeletionInProgress)) {
        cleanupArtifact();
        return reply.code(409).send({ error: "Agent deletion is in progress" });
      }
      releaseDeliveryLease = conversation
        ? leaseConversationDelivery(
            conversationDeliveryLeases,
            agentDeliveryLeases,
            conversation.id,
            leasedAgentIds,
          )
        : leaseAgentDelivery(agentDeliveryLeases, leasedAgentIds);
    }
    try {
      const result = durableResult ?? coordinationV3.updateRequest(updateInput);
      durableResult = result;
      const changedRequest = coordinationV3.getRequest(requestId);
      if (artifact && changedRequest) projectCommunicationArtifact(
        currentRequest.projectId,
        capability.agentId,
        artifact,
        requestArtifactAccess(updateId, changedRequest),
      );
      const projectId = currentRequest.projectId;
      const requestLifecycle = changedRequest?.conversationId
        ? coordinationV3.requestLifecycleDetails({
            projectId,
            conversationId: changedRequest.conversationId,
            recordId: requestId,
          })
        : undefined;
      const canonicalUpdate = requestLifecycle?.updates.find(
        (candidate) => candidate.id === updateId,
      );
      const passiveText = canonicalUpdate?.text?.trim();
      const peerAgentId = changedRequest?.recipientAgentId === capability.agentId
        ? changedRequest.requesterAgentId
        : changedRequest?.requesterAgentId === capability.agentId
          ? changedRequest.recipientAgentId
          : undefined;
      if (
        changedRequest?.conversationId
        && canonicalUpdate?.actorKind === "agent"
        && canonicalUpdate.actorId === capability.agentId
        && passiveText
        && peerAgentId
        && peerAgentId !== capability.agentId
        && isRequestCommunicationHandoffKind(canonicalUpdate.kind)
      ) {
        // The Request update remains the canonical handoff and owns the
        // requester wake-up. This deterministic Communication is its passive,
        // non-delivering audit copy for Team Chat and both Agent timelines.
        const eventId = requestUpdateCommunicationEventId(
          projectId,
          requestId,
          updateId,
        );
        const communication = recordCommunication({
          eventId,
          schemaVersion: 2,
          projectId,
          conversationId: changedRequest.conversationId,
          sender: {
            kind: "agent",
            agentId: capability.agentId,
          },
          intent: "collaboration",
          audience: { kind: "agents", agentIds: [peerAgentId] },
          text: passiveText,
          createdAt: canonicalUpdate.createdAt,
          correlationId: requestId,
          ...(requestLifecycle?.request.communicationEventId
            ? { causationId: requestLifecycle.request.communicationEventId }
            : {}),
          idempotencyKey: `request-update:${requestId}:${updateId}`,
        });
        if (!store.getProjectedConversationMessageById(
          changedRequest.conversationId,
          "collaboration",
          communication.eventId,
        )) {
          store.appendConversationMessage(
            changedRequest.conversationId,
            { role: "assistant", text: passiveText },
            capability.agentId,
            "collaboration",
            undefined,
            undefined,
            communication.eventId,
          );
        }
        projectCommunicationToAgentAudit(
          capability.agentId,
          communication,
          passiveText,
        );
        projectCommunicationToAgentAudit(
          peerAgentId,
          communication,
          passiveText,
        );
      }
      const conversationIds = changedRequest?.conversationId
        ? [changedRequest.conversationId]
        : [];
      if (changedRequest?.requesterAgentId) {
        publishCoordinationV3Changed(changedRequest.requesterAgentId, { conversationIds });
      }
      if (changedRequest) {
        publishCoordinationV3Changed(changedRequest.recipientAgentId, { conversationIds });
      }
      notifyScheduler();
      return { ...result, ...(artifact ? { resultRef: `ponderosa://artifact/${artifact.id}` } : {}) };
    } catch (error) {
      if (durableResult) {
        return reply.code(202).send({
          ...durableResult,
          committed: true,
          recovering: true,
          ...(artifact ? { resultRef: `ponderosa://artifact/${artifact.id}` } : {}),
        });
      }
      return reply.code(409).send({ error: error instanceof Error ? error.message : "request update failed" });
    } finally {
      if (artifact && !durableResult) {
        cleanupArtifact();
      }
      releaseDeliveryLease();
    }
  });
}
