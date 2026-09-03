import { createHash, randomUUID } from "node:crypto";
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
import { MAX_ATTACHMENTS_PER_MESSAGE, type EngineRegistration } from "../app-contracts.js";
import { AssetError, type AssetStore } from "../assets.js";
import type { createCommunicationArtifactAuthority } from "../communication-artifacts.js";
import { leaseAgentDelivery } from "../delivery-leases.js";
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
  deletingAgentIds: Set<string>;
  deletingProjectIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
  agentCreationConversationLeases: Map<string, number>;
  agentDeliveryLeases: Map<string, number>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[];
  recordCommunication(event: CommunicationEvent): CommunicationEvent;
  prepareUserCommunicationText: CommunicationArtifactAuthority["prepareUserCommunicationText"];
  runtimeArtifactMetadata: CommunicationArtifactAuthority["runtimeArtifactMetadata"];
  projectCommunicationArtifact: CommunicationArtifactAuthority["projectCommunicationArtifact"];
  communicationArtifactAccess: CommunicationArtifactAuthority["communicationArtifactAccess"];
  publish(agentId: string, stored: StoredLogEvent): void;
  publishMessageDeliveryChanged(agentId: string): void;
  notifyScheduler(): void;
  reconcileRuntimeCommunicationProjections(filter?: {
    projectId?: string;
    communicationEventId?: string;
    allowQuarantinedAgentIds?: ReadonlySet<string>;
  }): Promise<number>;
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
    agentDeliveryLeases,
    cachedModelOptions,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    publishMessageDeliveryChanged,
    notifyScheduler,
    reconcileRuntimeCommunicationProjections,
  } = context;

  app.post<{
    Params: { id: string };
    Body: { title: string; engine: string; conversationId: string; model?: string; effort?: string; speed?: string; initialMessage?: string; draftAttachmentIds?: string[]; draftOwnerId?: string; presetId?: string; managerAgentId?: string; awaitResult?: boolean; idempotencyKey?: string; managementPermissions?: { allowAutomaticDescendantDeletion: boolean; allowAutomaticDescendantReorganization: boolean } };
  }>(
    "/api/projects/:id/agents",
    async (request, reply) => {
      const body = request.body as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "Agent body must be an object" });
      }
      const candidate = body as Record<string, unknown>;
      const allowedFields = new Set([
        "title", "engine", "conversationId", "model", "effort", "speed", "initialMessage",
        "draftAttachmentIds", "draftOwnerId", "presetId", "managerAgentId", "awaitResult",
        "idempotencyKey", "managementPermissions",
      ]);
      const unknownFields = Object.keys(candidate).filter((key) => !allowedFields.has(key));
      if (unknownFields.length) {
        return reply.code(400).send({ error: `unknown Agent field(s): ${unknownFields.join(", ")}` });
      }
      for (const key of ["title", "engine", "conversationId", "model", "effort", "speed", "initialMessage", "draftOwnerId", "presetId", "managerAgentId", "idempotencyKey"] as const) {
        if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
          return reply.code(400).send({ error: `${key} must be a string` });
        }
      }
      if (candidate.awaitResult !== undefined && typeof candidate.awaitResult !== "boolean") {
        return reply.code(400).send({ error: "awaitResult must be a boolean" });
      }
      if (candidate.managementPermissions !== undefined) {
        if (!candidate.managementPermissions || typeof candidate.managementPermissions !== "object" ||
            Array.isArray(candidate.managementPermissions)) {
          return reply.code(400).send({ error: "managementPermissions requires two boolean settings" });
        }
        const permissions = candidate.managementPermissions as Record<string, unknown>;
        if (Object.keys(permissions).some((key) => ![
          "allowAutomaticDescendantDeletion",
          "allowAutomaticDescendantReorganization",
        ].includes(key)) ||
            typeof permissions.allowAutomaticDescendantDeletion !== "boolean" ||
            typeof permissions.allowAutomaticDescendantReorganization !== "boolean") {
          return reply.code(400).send({ error: "managementPermissions requires two boolean settings" });
        }
      }
      if (candidate.draftAttachmentIds !== undefined &&
          (!Array.isArray(candidate.draftAttachmentIds) ||
            candidate.draftAttachmentIds.some((id) => typeof id !== "string"))) {
        return reply.code(400).send({ error: "draftAttachmentIds must be an array of strings" });
      }
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
      const operationIdempotencyKey = creationIdempotencyKey ?? randomUUID();
      const operationPayloadHash = createHash("sha256").update(JSON.stringify({
        projectId: request.params.id,
        title: request.body.title,
        engine: request.body.engine,
        conversationId: request.body.conversationId,
        model: request.body.model ?? null,
        effort: request.body.effort ?? null,
        speed: request.body.speed ?? null,
        initialMessage: request.body.initialMessage ?? null,
        draftAttachmentIds: request.body.draftAttachmentIds ?? [],
        draftOwnerId: request.body.draftOwnerId ?? null,
        presetId: request.body.presetId ?? null,
        managerAgentId: request.body.managerAgentId ?? null,
        awaitResult: request.body.awaitResult ?? null,
        managementPermissions: request.body.managementPermissions ?? null,
      })).digest("hex");
      let creationOperation;
      try {
        creationOperation = store.beginAgentCreationOperation({
          projectId: request.params.id,
          actorScope: "user:local-operator",
          kind: "human",
          idempotencyKey: operationIdempotencyKey,
          payloadHash: operationPayloadHash,
        }).operation;
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "Agent creation replay conflict" });
      }
      if (creationOperation.status === "completed" && creationOperation.result) {
        return { ...(creationOperation.result as Record<string, unknown>), replayed: true };
      }
      if (creationOperation.status === "canonical_committed" && creationOperation.communicationEventId) {
        try {
          await reconcileRuntimeCommunicationProjections({
            projectId: request.params.id,
            communicationEventId: creationOperation.communicationEventId,
            allowQuarantinedAgentIds: new Set(creationOperation.agentIds),
          });
          store.updateAgentCreationOperation(creationOperation.id, { status: "completed", lastError: null });
          for (const agentId of creationOperation.agentIds) deletingAgentIds.delete(agentId);
          return { ...(creationOperation.result as Record<string, unknown>), replayed: true };
        } catch (error) {
          return reply.code(202).send({
            committed: true,
            recovering: true,
            operationId: creationOperation.id,
            ...(creationOperation.result as Record<string, unknown>),
          });
        }
      }
      if (creationOperation.agentIds.length) {
        return reply.code(202).send({
          committed: false,
          recovering: true,
          operationId: creationOperation.id,
          agentIds: creationOperation.agentIds,
        });
      }
      if (creationIdempotencyKey) {
        const legacyExisting = store.findAgentCreation(request.params.id, creationIdempotencyKey);
        if (legacyExisting) return { ...legacyExisting, replayed: true };
      }
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
      const agentId = randomUUID();
      try {
        store.addAgentCreationOperationMember(creationOperation.id, agentId, 0);
        deletingAgentIds.add(agentId);
        agent = store.createAgent(request.params.id, request.body, undefined, agentId);
      } catch (error) {
        deletingAgentIds.delete(agentId);
        store.updateAgentCreationOperation(creationOperation.id, {
          status: "rolled_back",
          lastError: error instanceof Error ? error.message : "Agent creation failed",
        });
        return reply.code(400).send({ error: error instanceof Error ? error.message : "agent could not be created" });
      }
      // Keep the newly visible row unavailable until its opening assets,
      // communication, and activation are durably committed.
      const releaseAgentDelivery = leaseAgentDelivery(
        agentDeliveryLeases,
        [agent.id, ...(agent.managerAgentId ? [agent.managerAgentId] : [])],
      );
      const openingAttachments: AssetDto[] = [];
      let openingCommitted = false;
      let rollbackCompleted = false;
      try {
        for (const attachment of draftAttachments as NonNullable<(typeof draftAttachments)[number]>[]) {
          const staged = await assets.stage({
            projectId: agent.projectId, agentId: agent.id,
            body: attachment.body,
            prepared: attachment.prepared,
          });
          openingAttachments.push({ ...staged, state: "associated" as const });
        }
      const openingEventId = `agent-opening:${agent.id}`;
      const openingCreatedAt = new Date().toISOString();
      let openingPrepared: Awaited<ReturnType<typeof prepareUserCommunicationText>> | undefined;
      if (hasInitialTurn) {
        openingPrepared = await prepareUserCommunicationText({
          projectId: agent.projectId,
          communicationId: openingEventId,
          text: initialMessage,
          createdAt: openingCreatedAt,
        });
      }
      let managedOpening: { requestIds: string[]; joinId?: string } | undefined;
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
        store.sqlite.transaction(() => {
        if (agent.managerAgentId) {
          managedOpening = coordinationV3.coordinate({
            projectId: agent.projectId, conversationId: agent.conversationId,
            requesterAgentId: agent.managerAgentId, actorScope: "user:local-operator",
            idempotencyKey: `managed-opening:${agent.id}`,
            requests: [{ requestId: `managed:${agent.id}:opening`, recipientAgentId: agent.id, lifetime: { kind: "indefinite" }, communicationEventId: openingEventId, payload: {
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
        }
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
        store.updateAgentCreationOperation(creationOperation.id, {
          status: "canonical_committed",
          communicationEventId: eventId,
          result: {
            ...agent,
            ...(managedOpening ? {
              openingRequestId: managedOpening.requestIds[0],
              openingJoinId: managedOpening.joinId,
            } : {}),
          },
          lastError: null,
        });
        })();
        openingCommitted = true;
        await reconcileRuntimeCommunicationProjections({
          projectId: agent.projectId,
          communicationEventId: eventId,
          allowQuarantinedAgentIds: new Set([agent.id]),
        });
        publishMessageDeliveryChanged(agent.id);
        notifyScheduler();
      }

      const creationResult = { ...agent, ...(managedOpening ? { openingRequestId: managedOpening.requestIds[0], openingJoinId: managedOpening.joinId } : {}) };
      store.updateAgentCreationOperation(creationOperation.id, {
        status: "completed",
        result: creationResult,
        lastError: null,
      });
      openingCommitted = true;
      return creationResult;
      } catch (error) {
        if (openingCommitted) {
          try {
            await reconcileRuntimeCommunicationProjections({
              projectId: agent.projectId,
              communicationEventId: `agent-opening:${agent.id}`,
              allowQuarantinedAgentIds: new Set([agent.id]),
            });
            store.updateAgentCreationOperation(creationOperation.id, { status: "completed", lastError: null });
            const recovered = store.getAgentCreationOperation(creationOperation.id)?.result;
            return { ...(recovered as Record<string, unknown>), replayed: true };
          } catch (recoveryError) {
            store.updateAgentCreationOperation(creationOperation.id, {
              lastError: recoveryError instanceof Error ? recoveryError.message : "Agent opening projection recovery failed",
            });
            return reply.code(202).send({
              committed: true,
              recovering: true,
              operationId: creationOperation.id,
              ...(store.getAgentCreationOperation(creationOperation.id)?.result as Record<string, unknown>),
            });
          }
        }
        await Promise.allSettled(openingAttachments.map((attachment) =>
          assets.remove(agent.projectId, agent.id, attachment.id)));
        try {
          rollbackCompleted = store.deleteAgent(
            agent.id,
            (agentId) => coordinationV3.handleAgentDeletion(agentId),
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Agent opening failed and its partial Agent could not be rolled back",
          );
        }
        if (!rollbackCompleted) {
          throw new AggregateError(
            [error],
            "Agent opening failed and its partial Agent could not be rolled back",
          );
        }
        store.updateAgentCreationOperation(creationOperation.id, {
          status: "rolled_back",
          lastError: error instanceof Error ? error.message : "Agent opening could not be committed",
        });
        const status = error instanceof AssetError ? error.statusCode : 409;
        return reply.code(status).send({
          error: error instanceof Error ? error.message : "Agent opening could not be committed",
        });
      } finally {
        releaseAgentDelivery();
        if (openingCommitted || rollbackCompleted) deletingAgentIds.delete(agent.id);
      }
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
