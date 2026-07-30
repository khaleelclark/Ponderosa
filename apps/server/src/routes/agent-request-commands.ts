import {
  LONG_TEXT_MAX_UTF8_BYTES,
  canonicalizeProviderText,
  shouldBackTextWithArtifact,
  type CommunicationEvent,
  type CoordinationRequestUpdateKind,
  type SendAgentMessageRequest,
} from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";
import type { createCommunicationArtifactAuthority } from "../communication-artifacts.js";
import type { PreparedCommunicationArtifact } from "./conversation-deliveries.js";
import { derivedRunActionKey } from "../security.js";
import {
  isRequestCommunicationHandoffKind,
  requestUpdateCommunicationEventId,
} from "../request-update-communication.js";
import type { CreateServerOptions } from "../app-contracts.js";

type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface AgentRequestCommandRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
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
  messageLifecycleFaults: CreateServerOptions["messageLifecycleFaults"];
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
    capabilityOwnsAuthoritativeRun,
    capabilityMatchesCleanupRun,
    runAuthorization,
    projectCommunicationArtifact,
    requestArtifactAccess,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
    recordCommunication,
    projectCommunicationToAgentAudit,
    publishCoordinationV3Changed,
    notifyScheduler,
    messageLifecycleFaults,
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
    const updateId = request.body?.updateId?.trim() || derivedRunActionKey(capability.runId, "report", {
      requestId,
      kind,
      text: handoffText,
      inReplyToUpdateId: request.body.inReplyToUpdateId?.trim() || null,
    });
    let artifact: PreparedCommunicationArtifact | undefined;
    try {
      if (shouldBackTextWithArtifact(handoffText)) {
        artifact = await stageCommunicationArtifact({
          projectId: store.getAgent(capability.agentId)!.projectId,
          communicationId: updateId,
          role: "long_text",
          title: kind === "question" ? "Blocking question" : "Request result",
          content: handoffText,
          originAgentId: capability.agentId,
          executionId: capability.runId,
          createdAt: new Date().toISOString(),
        });
      }
      const persistedText = artifact
        ? `Full ${kind === "question" ? "question" : "result"}: ponderosa://artifact/${artifact.id}`
        : handoffText;
      const result = coordinationV3.updateRequest({
        requestId,
        updateId,
        kind,
        actor: { kind: "agent", id: capability.agentId },
        runAuthorization: runAuthorization(capability),
        ...(request.body.inReplyToUpdateId?.trim() ? { inReplyToUpdateId: request.body.inReplyToUpdateId.trim() } : {}),
        payload: {
          text: persistedText,
          ...(artifact ? { artifactId: artifact.id, resultRef: `ponderosa://artifact/${artifact.id}` } : {}),
          executionId: capability.runId,
          canonicalHandoff: (["completed", "blocked", "failed"] as CoordinationRequestUpdateKind[]).includes(kind),
        },
        ...(artifact ? { artifacts: [runtimeArtifactMetadata(artifact)] } : {}),
      });
      if (artifact) await messageLifecycleFaults?.afterCommunicationArtifactCommit?.({
        kind: "request_update", ownerId: updateId, artifactIds: [artifact.id],
      });
      const changedRequest = coordinationV3.getRequest(requestId);
      if (artifact && changedRequest) projectCommunicationArtifact(
        store.getAgent(capability.agentId)!.projectId,
        capability.agentId,
        artifact,
        requestArtifactAccess(updateId, changedRequest),
      );
      const projectId = store.getAgent(capability.agentId)!.projectId;
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
      return reply.code(409).send({ error: error instanceof Error ? error.message : "request update failed" });
    }
  });
}
