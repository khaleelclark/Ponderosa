import type {
  AssetDto,
  CommunicationEvent,
  ModelOption,
} from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  StoredLogEvent,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { agentMentionHandle } from "../agent-mentions.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, type EngineRegistration } from "../app-contracts.js";
import { AssetError, type AssetStore } from "../assets.js";
import type { createCommunicationArtifactAuthority } from "../communication-artifacts.js";
import {
  concreteRuntimeSelection,
  runtimeSelectionError,
  runtimeSpeedSelectionError,
} from "../runtime-selection.js";
import type { DraftService } from "./drafts.js";

type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface AgentCreationRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  assets: AssetStore;
  drafts: DraftService;
  engines: ReadonlyMap<string, EngineRegistration>;
  deletingAgentIds: ReadonlySet<string>;
  deletingProjectIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
  agentCreationConversationLeases: Map<string, number>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[];
  recordCommunication(event: CommunicationEvent): CommunicationEvent;
  prepareUserCommunicationText: CommunicationArtifactAuthority["prepareUserCommunicationText"];
  runtimeArtifactMetadata: CommunicationArtifactAuthority["runtimeArtifactMetadata"];
  projectCommunicationArtifact: CommunicationArtifactAuthority["projectCommunicationArtifact"];
  communicationArtifactAccess: CommunicationArtifactAuthority["communicationArtifactAccess"];
  publish(agentId: string, stored: StoredLogEvent): void;
  publishMessageDeliveryChanged(agentId: string): void;
  notifyScheduler(): void;
}

export function registerAgentCreationRoutes(
  app: FastifyInstance,
  context: AgentCreationRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    workspace,
    assets,
    drafts,
    engines,
    deletingAgentIds,
    deletingProjectIds,
    deletingConversationIds,
    agentCreationConversationLeases,
    cachedModelOptions,
    recordCommunication,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    projectCommunicationArtifact,
    communicationArtifactAccess,
    publish,
    publishMessageDeliveryChanged,
    notifyScheduler,
  } = context;

  app.post<{
    Params: { id: string };
    Body: { title: string; engine: string; conversationId: string; model?: string; effort?: string; speed?: string; initialMessage?: string; draftAttachmentIds?: string[]; draftOwnerId?: string; presetId?: string; managerAgentId?: string; awaitResult?: boolean; idempotencyKey?: string };
  }>(
    "/api/projects/:id/agents",
    async (request, reply) => {
      const project = store.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (deletingProjectIds.has(request.params.id)) return reply.code(409).send({ error: "Project deletion is already in progress" });
      if (!request.body?.title || !request.body?.engine || !request.body?.conversationId) {
        return reply.code(400).send({ error: "title, engine, and Chat are required" });
      }
      if (deletingConversationIds.has(request.body.conversationId)) {
        return reply.code(409).send({ error: "Chat deletion is already in progress" });
      }
      const creationIdempotencyKey = request.body.idempotencyKey?.trim();
      if (creationIdempotencyKey && creationIdempotencyKey.length > 200) {
        return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
      }
      if (creationIdempotencyKey) {
        const existing = store.findAgentCreation(request.params.id, creationIdempotencyKey);
        if (existing) return { ...existing, replayed: true };
        request.body.idempotencyKey = creationIdempotencyKey;
      }
      if (request.body.presetId) {
        const preset = store.getAgentPreset(request.body.presetId);
        if (!preset || preset.projectId !== request.params.id || !preset.enabled) return reply.code(400).send({ error: "preset is unavailable for this project" });
        request.body.engine = preset.engine; request.body.model = preset.model; request.body.effort = preset.effort;
      }
      if (!engines.has(request.body.engine)) return reply.code(400).send({ error: "unknown engine" });
      const requestedAdapter = engines.get(request.body.engine)!.adapter;
      const projectModelOptions = cachedModelOptions(requestedAdapter, project.id);
      const selectionError = runtimeSelectionError(
        requestedAdapter,
        request.body.model,
        request.body.effort,
        projectModelOptions,
      );
      if (selectionError) return reply.code(400).send({ error: selectionError });
      if (request.body.managerAgentId) {
        const manager = store.getAgent(request.body.managerAgentId);
        if (!manager || manager.projectId !== request.params.id || manager.archived) {
          return reply.code(400).send({ error: "manager must be an active agent in this project" });
        }
        if (deletingAgentIds.has(manager.id)) {
          return reply.code(409).send({ error: "manager deletion is already in progress" });
        }
        if (manager.conversationId !== request.body.conversationId) {
          return reply.code(400).send({ error: "manager must belong to the selected Chat" });
        }
      }
      const conversation = store.getConversation(request.body.conversationId);
      if (!conversation || conversation.projectId !== request.params.id || conversation.archived) {
        return reply.code(400).send({ error: "Chat does not belong to Project or is archived" });
      }
      const conversationDefaults = conversation;
      const resolvedRuntime = concreteRuntimeSelection(requestedAdapter, [
        { model: request.body.model, effort: request.body.effort },
        conversationDefaults?.defaultEngine === request.body.engine ? { model: conversationDefaults.defaultModel, effort: conversationDefaults.defaultEffort } : undefined,
        project.defaultEngine === request.body.engine ? { model: project.defaultModel, effort: project.defaultEffort } : undefined,
        workspace.getPreferences().engineDefaults?.[request.body.engine],
      ], projectModelOptions);
      request.body.model = resolvedRuntime.model;
      request.body.effort = resolvedRuntime.effort;
      const speedError = runtimeSpeedSelectionError(
        requestedAdapter,
        request.body.model,
        request.body.speed,
        projectModelOptions,
      );
      if (speedError) return reply.code(400).send({ error: speedError });
      const initialMessage = request.body.initialMessage?.trim() ?? "";
      const draftAttachmentIds = request.body.draftAttachmentIds ?? [];
      const firstTurnDraftOwnerId = drafts.normalizedOwner(request.body.draftOwnerId);
      if (!Array.isArray(draftAttachmentIds) || draftAttachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(draftAttachmentIds).size !== draftAttachmentIds.length) {
        return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique draft attachments are allowed` });
      }
      if (draftAttachmentIds.length && !request.body.conversationId) {
        return reply.code(400).send({ error: "first-turn draft attachments require a Project chat" });
      }
      if (draftAttachmentIds.length && !firstTurnDraftOwnerId) {
        return reply.code(400).send({ error: "first-turn draft owner is required" });
      }
      const leaseConversationId = request.body.conversationId;
      agentCreationConversationLeases.set(
        leaseConversationId,
        (agentCreationConversationLeases.get(leaseConversationId) ?? 0) + 1,
      );
      try {
      const draftAttachments = request.body.conversationId && firstTurnDraftOwnerId
        ? await Promise.all(draftAttachmentIds.map((id) =>
            drafts.prepared(
              request.body.conversationId!,
              firstTurnDraftOwnerId,
              id,
            ),
          ))
        : [];
      if (draftAttachments.some((attachment) => !attachment)) {
        return reply.code(400).send({ error: "draft attachment is missing or belongs to another conversation" });
      }
      const hasInitialTurn = Boolean(initialMessage || draftAttachments.length);
      if (hasInitialTurn && request.body.managerAgentId && !request.body.conversationId) {
        return reply.code(400).send({ error: "a managed agent opening message requires its manager to belong to a Project chat" });
      }
      let agent;
      if (deletingProjectIds.has(request.params.id)) return reply.code(409).send({ error: "Project deletion is already in progress" });
      const creationConversation = store.getConversation(request.body.conversationId);
      if (deletingConversationIds.has(request.body.conversationId) ||
          !creationConversation || creationConversation.projectId !== request.params.id ||
          creationConversation.archived) {
        return reply.code(409).send({ error: "Chat is unavailable for Agent creation" });
      }
      if (request.body.managerAgentId) {
        const manager = store.getAgent(request.body.managerAgentId);
        if (!manager || manager.projectId !== request.params.id ||
            manager.conversationId !== request.body.conversationId ||
            manager.archived) {
          return reply.code(409).send({
            error: "Manager is unavailable for Agent creation",
          });
        }
        if (deletingAgentIds.has(manager.id)) {
          return reply.code(409).send({
            error: "Manager deletion is already in progress",
          });
        }
      }
      try {
        agent = store.createAgent(request.params.id, request.body);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "agent could not be created" });
      }
      let openingAttachments: AssetDto[] = [];
      try {
        for (const attachment of draftAttachments as NonNullable<(typeof draftAttachments)[number]>[]) {
          const staged = await assets.stage({
            projectId: agent.projectId, agentId: agent.id,
            body: attachment.body,
            prepared: attachment.prepared,
          });
          openingAttachments.push({ ...staged, state: "associated" as const });
        }
      } catch (error) {
        await Promise.allSettled(openingAttachments.map((attachment) => assets.remove(agent.projectId, agent.id, attachment.id)));
        store.deleteAgent(agent.id, (agentId) => coordinationV3.handleAgentDeletion(agentId));
        if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
        return reply.code(409).send({ error: error instanceof Error ? error.message : "first-turn attachments could not be committed" });
      }
      const openingEventId = `agent-opening:${agent.id}`;
      const openingCreatedAt = new Date().toISOString();
      let openingPrepared: Awaited<ReturnType<typeof prepareUserCommunicationText>> | undefined;
      if (hasInitialTurn) {
        try {
          openingPrepared = await prepareUserCommunicationText({
            projectId: agent.projectId,
            communicationId: openingEventId,
            text: initialMessage,
            createdAt: openingCreatedAt,
          });
        } catch (error) {
          await Promise.allSettled(openingAttachments.map((attachment) => assets.remove(agent.projectId, agent.id, attachment.id)));
          store.deleteAgent(agent.id, (agentId) => coordinationV3.handleAgentDeletion(agentId));
          const status = error instanceof AssetError ? error.statusCode : 409;
          return reply.code(status).send({ error: error instanceof Error ? error.message : "first-turn text could not be committed" });
        }
      }
      let managedOpening: { requestIds: string[]; joinId?: string } | undefined;
      if (hasInitialTurn && agent.managerAgentId) {
        try {
          managedOpening = coordinationV3.coordinate({
            projectId: agent.projectId, conversationId: agent.conversationId,
            requesterAgentId: agent.managerAgentId, actorScope: "user:local-operator",
            idempotencyKey: `managed-opening:${agent.id}`,
            requests: [{ requestId: `managed:${agent.id}:opening`, recipientAgentId: agent.id, lifetime: { kind: "indefinite" }, payload: {
              text: openingPrepared!.publishedText,
              ...(openingPrepared!.artifact ? {
                artifactId: openingPrepared!.artifact.id,
                resultRef: `ponderosa://artifact/${openingPrepared!.artifact.id}`,
              } : {}),
              managedAgentOpening: true,
              ...(request.body.speed ? {
                runtimeSelection: { speed: request.body.speed },
              } : {}),
              ...(openingAttachments.length ? { attachments: openingAttachments } : {}),
            } }],
            ...(request.body.awaitResult === false ? {} : { join: { id: `managed:${agent.id}:join`, mode: "all" as const } }),
          });
        } catch (error) {
          await Promise.allSettled(openingAttachments.map((attachment) => assets.remove(agent.projectId, agent.id, attachment.id)));
          store.deleteAgent(agent.id, (agentId) => coordinationV3.handleAgentDeletion(agentId));
          return reply.code(409).send({ error: error instanceof Error ? error.message : "managed Agent opening could not be tracked" });
        }
      }
      if (hasInitialTurn) {
        const createdAt = openingCreatedAt;
        const eventId = openingEventId;
        const managed = Boolean(agent.managerAgentId);
        const sharedOpening = !managed && Boolean(agent.conversationId);
        const communication: CommunicationEvent = managed ? {
          eventId, schemaVersion: 2, projectId: agent.projectId,
          ...(agent.conversationId ? { conversationId: agent.conversationId } : {}),
          sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
          audience: { kind: "agents", agentIds: [agent.id] },
          text: openingPrepared!.publishedText,
          ...(openingPrepared!.document ? { document: openingPrepared!.document } : {}),
          createdAt,
          ...(openingAttachments.length ? { attachments: openingAttachments } : {}),
        } : sharedOpening ? {
          eventId, schemaVersion: 2, projectId: agent.projectId, conversationId: agent.conversationId!,
          sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
          audience: { kind: "organization", organizationId: agent.projectId },
          text: openingPrepared!.publishedText,
          ...(openingPrepared!.document ? { document: openingPrepared!.document } : {}),
          createdAt,
          ...(openingAttachments.length ? { attachments: openingAttachments } : {}),
        } : {
          eventId, schemaVersion: 2, projectId: agent.projectId,
          ...(agent.conversationId ? { conversationId: agent.conversationId } : {}),
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
          text: openingPrepared!.publishedText,
          ...(openingPrepared!.document ? { document: openingPrepared!.document } : {}),
          createdAt,
          ...(openingAttachments.length ? { attachments: openingAttachments } : {}),
        };
        coordinationV3.recordRuntimeCommunication({
          id: eventId,
          projectId: agent.projectId,
          sender: communication.sender,
          intent: communication.intent,
          audience: communication.audience,
          payload: {
            communication,
            dispatch: {
              conversationId: agent.conversationId ?? null,
              ...(sharedOpening ? {
                sourceConversationId: agent.conversationId,
                sourceChannel: "main" as const,
                shareWithOrganization: true,
              } : {}),
              text: openingPrepared!.publishedText,
              ...(openingPrepared!.artifact ? {
                artifactId: openingPrepared!.artifact.id,
                resultRef: `ponderosa://artifact/${openingPrepared!.artifact.id}`,
              } : {}),
              attachments: openingAttachments.map((item) => ({
                id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
              })),
              model: request.body.model ?? null,
              effort: request.body.effort ?? null,
              speed: request.body.speed ?? null,
            },
          },
          ...(openingPrepared!.artifact ? { artifacts: [runtimeArtifactMetadata(openingPrepared!.artifact)] } : {}),
          ...(!managedOpening ? { activation: {
            agentId: agent.id,
            kind: "managed_agent_opening",
            priority: 100,
            dispatchPolicy: "steer_or_run",
            promptClass: "human",
          } } : {}),
          now: createdAt,
        });
        const canonicalCommunication = recordCommunication(communication);
        if (openingPrepared!.artifact) projectCommunicationArtifact(
          agent.projectId,
          "local-operator",
          openingPrepared!.artifact,
          communicationArtifactAccess(canonicalCommunication),
        );
        if (managedOpening) coordinationV3.attachRequestCommunication(managedOpening.requestIds[0]!, eventId, agent.projectId);
        if (communication.intent === "user_dm") {
          store.appendCommunicationProjection(agent.projectId, {
            eventId, surface: "user_inbox", projectionKey: "local-operator", projectedAt: createdAt,
          });
        }
        if (agent.conversationId) {
          store.appendConversationMessage(
            agent.conversationId,
            {
              role: "user",
              // A normal Project-chat send is shared conversation text, not a
              // user-authored DM. Keep the spawned Agent association in the
              // canonical communication/activation instead of mutating the
              // user's visible prose with a stale display-name tag.
              text: managed
                ? `#${agent.handle} ${openingPrepared!.publishedText}`
                : openingPrepared!.publishedText,
              attachments: openingAttachments,
            },
            undefined,
            managed ? "collaboration" : "main",
            managed ? [{ targetAgentId: agent.id, relayDepth: 0, mentionTrail: [], kind: "tag", audience: "mention" }] : undefined,
            undefined,
            eventId,
          );
        }
        // The opening Broadcast remains organizational context, while this
        // exact Activation recipient owns an audit copy in its Agent chat.
        const audit = store.appendEvent(agent.id, {
          type: "user_message", text: openingPrepared!.publishedText, communicationEventId: eventId,
          ...(openingAttachments.length ? { attachments: openingAttachments } : {}),
        });
        if (openingAttachments.length) await assets.associate(agent.projectId, agent.id, openingAttachments.map((item) => item.id));
        publish(agent.id, audit);
        publishMessageDeliveryChanged(agent.id);
        notifyScheduler();
      }

      return { ...agent, ...(managedOpening ? { openingRequestId: managedOpening.requestIds[0], openingJoinId: managedOpening.joinId } : {}) };
      } finally {
        const remaining = (agentCreationConversationLeases.get(
          leaseConversationId,
        ) ?? 1) - 1;
        if (remaining > 0) {
          agentCreationConversationLeases.set(leaseConversationId, remaining);
        } else {
          agentCreationConversationLeases.delete(leaseConversationId);
        }
      }
    },
  );
}
