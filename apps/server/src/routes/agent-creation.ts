import { requestProduct, resourceInProduct } from "../product-scope.js";
import { pineconeGuidance } from "../pinecone-guidance.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentDto,
  AssetDto,
  CommunicationEvent,
  ModelOption,
} from "@ponderosa/core";
import { PINECONE_GUIDANCE_VERSION } from "@ponderosa/core";
import {
  readManagedArtifactContent,
  removeManagedArtifactContent,
  stableJson,
  type AgentCreationArtifactIdentity,
  type AgentStore,
  type CoordinationV3Store,
  type StoredLogEvent,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { MAX_ATTACHMENTS_PER_MESSAGE, type EngineRegistration } from "../app-contracts.js";
import { AssetError, type AssetStore } from "../assets.js";
import { reconcileCommittedAgentCreation } from "../agent-creation-recovery.js";
import type { createCommunicationArtifactAuthority } from "../communication-artifacts.js";
import { leaseAgentDelivery } from "../delivery-leases.js";
import {
  concreteRuntimeSelection,
  runtimeSelectionError,
  runtimeSpeedSelectionError,
} from "../runtime-selection.js";
import type { DraftService } from "./drafts.js";
import { ProviderDisabledError } from "../provider-admission.js";

type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface AgentCreationRoutesContext {
  dataDir: string;
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
    dataDir,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    publishMessageDeliveryChanged,
    notifyScheduler,
    reconcileRuntimeCommunicationProjections,
  } = context;
  const activeCreationOperations = new Set<string>();

  app.post<{
    Params: { id: string };
    Body: { experience?: "pinecone"; title: string; engine: string; conversationId: string; model?: string; effort?: string; speed?: string; initialMessage?: string; draftAttachmentIds?: string[]; draftOwnerId?: string; presetId?: string; managerAgentId?: string; awaitResult?: boolean; idempotencyKey?: string; managementPermissions?: { allowAutomaticDescendantDeletion: boolean; allowAutomaticDescendantReorganization: boolean } };
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
        "idempotencyKey", "managementPermissions", "experience",
      ]);
      const unknownFields = Object.keys(candidate).filter((key) => !allowedFields.has(key));
      if (unknownFields.length) {
        return reply.code(400).send({ error: `unknown Agent field(s): ${unknownFields.join(", ")}` });
      }
      if (candidate.experience !== undefined && candidate.experience !== "pinecone") {
        return reply.code(400).send({ error: "unknown Agent experience" });
      }
      if (candidate.experience === "pinecone" && (
          requestProduct(request) !== "dev" || typeof candidate.conversationId !== "string" ||
          ["initialMessage", "draftAttachmentIds", "draftOwnerId", "presetId", "managerAgentId", "awaitResult", "managementPermissions"].some(key => candidate[key] !== undefined) ||
          typeof candidate.idempotencyKey !== "string" || !candidate.idempotencyKey.trim())) {
        return reply.code(400).send({ error: "Pinecone requires empty operator creation in Dev with an idempotency key" });
      }
      if (candidate.experience === "pinecone" && (
          !resourceInProduct(store, "conversation", String(candidate.conversationId), "dev") ||
          deletingProjectIds.has(request.params.id) || deletingConversationIds.has(String(candidate.conversationId)) ||
          store.getConversation(String(candidate.conversationId))?.projectId !== request.params.id ||
          store.getConversation(String(candidate.conversationId))?.archived)) {
        return reply.code(400).send({ error: "Pinecone owner must be a live Dev Chat in this Project" });
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
      if (!request.body?.title || !request.body?.engine || !request.body?.conversationId) {
        return reply.code(400).send({ error: "title, engine, and Chat are required" });
      }
      const creationIdempotencyKey = request.body.idempotencyKey?.trim();
      if (creationIdempotencyKey && creationIdempotencyKey.length > 200) {
        return reply.code(400).send({ error: "idempotencyKey must be 200 characters or fewer" });
      }
      if (creationIdempotencyKey) {
        request.body.idempotencyKey = creationIdempotencyKey;
      }
      const draftAttachmentIds = request.body.draftAttachmentIds ?? [];
      if (draftAttachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
          new Set(draftAttachmentIds).size !== draftAttachmentIds.length) {
        return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique draft attachments are allowed` });
      }
      const initialMessage = request.body.initialMessage?.trim() ?? "";
      const firstTurnDraftOwnerId = drafts.normalizedOwner(request.body.draftOwnerId);
      if (draftAttachmentIds.length && !firstTurnDraftOwnerId) {
        return reply.code(400).send({ error: "first-turn draft owner is required" });
      }
      const operationIdempotencyKey = creationIdempotencyKey ?? randomUUID();
      const operationPayloadHash = createHash("sha256").update(stableJson({
        projectId: request.params.id,
        ...(request.body.experience ? { experience: request.body.experience, guidanceVersion: PINECONE_GUIDANCE_VERSION } : {}),
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
          ...(request.body.experience ? { conversationId: request.body.conversationId, productScope: "dev" as const } : {}),
          idempotencyKey: operationIdempotencyKey,
          payloadHash: operationPayloadHash,
        }).operation;
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "Agent creation replay conflict" });
      }
      if (creationOperation.status === "completed" && creationOperation.result) {
        return { ...(creationOperation.result as Record<string, unknown>), replayed: true };
      }
      if (creationOperation.status === "completed" && !creationOperation.result) {
        return reply.code(503).send({
          error: "Agent creation committed without a recoverable result",
          operationId: creationOperation.id,
        });
      }
      if (creationOperation.status === "canonical_committed" && creationOperation.communicationEventId) {
        if (!creationOperation.result) {
          return reply.code(503).send({
            error: "Agent creation is committed but its result is still being recovered",
            operationId: creationOperation.id,
          });
        }
        const recovered = await reconcileCommittedAgentCreation({
          store,
          deletingAgentIds,
          operationId: creationOperation.id,
          projectId: request.params.id,
          communicationEventId: creationOperation.communicationEventId,
          agentIds: creationOperation.agentIds,
          reconcile: reconcileRuntimeCommunicationProjections,
        });
        if (recovered) {
          return { ...(creationOperation.result as Record<string, unknown>), replayed: true };
        }
        return reply.code(202).send({
          committed: true,
          recovering: true,
          operationId: creationOperation.id,
          agentId: creationOperation.agentIds[0],
        });
      }
      if (creationOperation.agentIds.length) {
        return reply.code(409).send({
          error: "Agent creation is still being recovered; retry with the same idempotency key",
          operationId: creationOperation.id,
          agentIds: creationOperation.agentIds,
        });
      }
      const abandonMutationFreeOperation = (statusCode: number, error: string) => {
        const current = store.getAgentCreationOperation(creationOperation.id);
        if (!current || current.agentIds.length > 0) {
          return reply.code(409).send({
            error: "Agent creation is still being recovered; retry with the same idempotency key",
            operationId: creationOperation.id,
            agentIds: current?.agentIds ?? [],
          });
        }
        store.updateAgentCreationOperation(current.id, {
          status: "rolled_back",
          lastError: error,
        });
        return reply.code(statusCode).send({ error });
      };
      type PlannedHumanCreation = {
        phase: "planned_human_creation";
        input: typeof request.body;
        presetSnapshot?: AgentDto["presetSnapshot"];
      };
      let savedPlan = creationOperation.status === "preparing" && creationOperation.result &&
        typeof creationOperation.result === "object" &&
        (creationOperation.result as { phase?: unknown }).phase === "planned_human_creation"
        ? creationOperation.result as PlannedHumanCreation
        : undefined;
      const project = store.getProject(request.params.id);
      if (!project) return abandonMutationFreeOperation(404, "project not found");
      if (deletingProjectIds.has(request.params.id)) {
        return abandonMutationFreeOperation(409, "Project deletion is already in progress");
      }
      if (savedPlan) {
        request.body = { ...savedPlan.input };
      } else {
        let presetSnapshot: AgentDto["presetSnapshot"] = request.body.experience === "pinecone"
          ? pineconeGuidance(request.body.engine) : undefined;
        if (request.body.presetId) {
          const preset = store.getAgentPreset(request.body.presetId);
          if (!preset || preset.projectId !== request.params.id || !preset.enabled) {
            return abandonMutationFreeOperation(400, "preset is unavailable for this project");
          }
          request.body.engine = preset.engine;
          request.body.model = preset.model;
          request.body.effort = preset.effort;
          presetSnapshot = {
            id: preset.id,
            name: preset.name,
            description: preset.description,
            guidance: preset.guidance,
            engine: preset.engine,
            model: preset.model,
            effort: preset.effort,
          };
        }
        if (!engines.has(request.body.engine)) {
          return abandonMutationFreeOperation(400, "unknown engine");
        }
        const requestedAdapter = engines.get(request.body.engine)!.adapter;
        const projectModelOptions = cachedModelOptions(requestedAdapter, project.id);
        const selectionError = runtimeSelectionError(
          requestedAdapter,
          request.body.model,
          request.body.effort,
          projectModelOptions,
        );
        if (selectionError) return abandonMutationFreeOperation(400, selectionError);
        const conversationDefaults = store.getConversation(request.body.conversationId);
        const resolvedRuntime = concreteRuntimeSelection(requestedAdapter, [
          { model: request.body.model, effort: request.body.effort },
          conversationDefaults?.defaultEngine === request.body.engine ? { model: conversationDefaults.defaultModel, effort: conversationDefaults.defaultEffort } : undefined,
          workspace.getPreferences().engineDefaults?.[request.body.engine],
        ], projectModelOptions);
        request.body.model = resolvedRuntime.model;
        request.body.effort = resolvedRuntime.effort;
        request.body.speed ??= conversationDefaults?.defaultEngine === request.body.engine
          ? conversationDefaults.defaultSpeed
          : undefined;
        const speedError = runtimeSpeedSelectionError(
          requestedAdapter,
          request.body.model,
          request.body.speed,
          projectModelOptions,
        );
        if (speedError) return abandonMutationFreeOperation(400, speedError);
        savedPlan = {
          phase: "planned_human_creation",
          input: { ...request.body },
          ...(presetSnapshot ? { presetSnapshot } : {}),
        };
        store.updateAgentCreationOperation(creationOperation.id, {
          result: savedPlan,
        });
      }
      if (deletingConversationIds.has(request.body.conversationId)) {
        return abandonMutationFreeOperation(409, "Chat deletion is already in progress");
      }
      if (!engines.has(request.body.engine)) {
        return abandonMutationFreeOperation(400, "unknown engine");
      }
      if (request.body.managerAgentId) {
        const manager = store.getAgent(request.body.managerAgentId);
        if (!manager || manager.projectId !== request.params.id || manager.archived) {
          return abandonMutationFreeOperation(400, "manager must be an active agent in this project");
        }
        if (deletingAgentIds.has(manager.id)) {
          return abandonMutationFreeOperation(409, "manager deletion is already in progress");
        }
        if (manager.conversationId !== request.body.conversationId) {
          return abandonMutationFreeOperation(400, "manager must belong to the selected Chat");
        }
      }
      const conversation = store.getConversation(request.body.conversationId);
      if (!conversation || conversation.projectId !== request.params.id || conversation.archived) {
        return abandonMutationFreeOperation(400, "Chat does not belong to Project or is archived");
      }
      if (creationIdempotencyKey) {
        const legacyExisting = store.findAgentCreation(request.params.id, creationIdempotencyKey);
        if (legacyExisting && !request.body.experience) {
          store.updateAgentCreationOperation(creationOperation.id, {
            status: "completed",
            result: legacyExisting,
            lastError: null,
          });
          return { ...legacyExisting, replayed: true };
        }
      }
      if (activeCreationOperations.has(creationOperation.id)) {
        return reply.code(409).send({
          error: "Agent creation is still in progress; retry with the same idempotency key",
          operationId: creationOperation.id,
        });
      }
      const executableOpening = Boolean(initialMessage || draftAttachmentIds.length);
      const assertOpeningAdmission = () => {
        if (executableOpening && workspace.getPreferences().providerAvailability[request.body.engine] === false) {
          throw new ProviderDisabledError(request.body.engine);
        }
      };
      try { assertOpeningAdmission(); } catch (error) {
        if (!(error instanceof ProviderDisabledError)) throw error;
        store.updateAgentCreationOperation(creationOperation.id, { status: "rolled_back", lastError: error.message });
        return reply.code(409).send({ error: error.message, code: error.code, engineId: error.engineId });
      }
      activeCreationOperations.add(creationOperation.id);
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
        return abandonMutationFreeOperation(400, "draft attachment is missing or belongs to another conversation");
      }
      const hasInitialTurn = Boolean(initialMessage || draftAttachments.length);
      assertOpeningAdmission();
      if (hasInitialTurn && request.body.managerAgentId && !request.body.conversationId) {
        return abandonMutationFreeOperation(400, "a managed agent opening message requires its manager to belong to a Project chat");
      }
      let agent;
      if (deletingProjectIds.has(request.params.id)) {
        return abandonMutationFreeOperation(409, "Project deletion is already in progress");
      }
      const creationConversation = store.getConversation(request.body.conversationId);
      if (deletingConversationIds.has(request.body.conversationId) ||
          !creationConversation || creationConversation.projectId !== request.params.id ||
          creationConversation.archived) {
        return abandonMutationFreeOperation(409, "Chat is unavailable for Agent creation");
      }
      if (request.body.managerAgentId) {
        const manager = store.getAgent(request.body.managerAgentId);
        if (!manager || manager.projectId !== request.params.id ||
            manager.conversationId !== request.body.conversationId ||
            manager.archived) {
          return abandonMutationFreeOperation(409, "Manager is unavailable for Agent creation");
        }
        if (deletingAgentIds.has(manager.id)) {
          return abandonMutationFreeOperation(409, "Manager deletion is already in progress");
        }
      }
      const agentId = randomUUID();
      try {
        store.addAgentCreationOperationMember(creationOperation.id, agentId, 0);
        deletingAgentIds.add(agentId);
        agent = store.createAgent(
          request.params.id,
          request.body,
          undefined,
          agentId,
          savedPlan.presetSnapshot ?? null,
        );
      } catch (error) {
        let absent = !store.getAgent(agentId);
        if (!absent) {
          try {
            store.deleteAgent(agentId, (id) => coordinationV3.handleAgentDeletion(id));
          } catch { /* startup recovery retains the quarantine */ }
          absent = !store.getAgent(agentId);
        }
        store.updateAgentCreationOperation(creationOperation.id, {
          status: absent ? "rolled_back" : "rolling_back",
          lastError: error instanceof Error ? error.message : "Agent creation failed",
        });
        if (absent) deletingAgentIds.delete(agentId);
        return reply.code(absent ? 400 : 500).send({
          error: absent
            ? error instanceof Error ? error.message : "agent could not be created"
            : "Agent creation failed and rollback is still pending",
          operationId: creationOperation.id,
        });
      }
      // Keep the newly visible row unavailable until its opening assets,
      // communication, and activation are durably committed.
      const releaseAgentDelivery = leaseAgentDelivery(
        agentDeliveryLeases,
        [agent.id, ...(agent.managerAgentId ? [agent.managerAgentId] : [])],
      );
      const openingAttachments: AssetDto[] = [];
      let openingArtifactIdentity: AgentCreationArtifactIdentity | undefined;
      let openingCommitted = false;
      let rollbackCompleted = false;
      let creationSettled = false;
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
          beforeArtifactPublish: (identity) => {
            openingArtifactIdentity = identity;
            store.updateAgentCreationOperation(creationOperation.id, {
              artifactIds: [identity.id],
              artifactIdentities: [identity],
            });
          },
        });
      }
      let managedOpening: { requestIds: string[]; joinId?: string } | undefined;
      assertOpeningAdmission();
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
      creationSettled = true;
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
            creationSettled = true;
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
              agentId: agent.id,
            });
          }
        }
        await Promise.allSettled(openingAttachments.map((attachment) =>
          assets.remove(agent.projectId, agent.id, attachment.id)));
        if (openingArtifactIdentity) {
          const runtime = assets.authoritativeRuntimeArtifactMetadataById(
            agent.projectId,
            openingArtifactIdentity.id,
          );
          if (runtime && runtime.byteLength === openingArtifactIdentity.byteLength &&
              runtime.blobHash === openingArtifactIdentity.sha256) {
            assets.removeRuntimeArtifactReservation(agent.projectId, openingArtifactIdentity.id);
          }
          removeManagedArtifactContent(
            dataDir,
            agent.projectId,
            openingArtifactIdentity.id,
            openingArtifactIdentity.byteLength,
            openingArtifactIdentity.sha256,
          );
          if (readManagedArtifactContent(
            dataDir,
            agent.projectId,
            openingArtifactIdentity.id,
            openingArtifactIdentity.byteLength,
            openingArtifactIdentity.sha256,
          )) {
            throw new AggregateError(
              [error],
              "Agent opening failed and its managed message artifact remains quarantined",
            );
          }
        }
        try {
          rollbackCompleted = store.deleteAgent(
            agent.id,
            (agentId) => coordinationV3.handleAgentDeletion(agentId),
          ) && !store.getAgent(agent.id);
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
        creationSettled = true;
        const status = error instanceof AssetError ? error.statusCode : 409;
        return reply.code(status).send({
          error: error instanceof Error ? error.message : "Agent opening could not be committed",
          ...(error instanceof ProviderDisabledError ? { code: error.code, engineId: error.engineId } : {}),
        });
      } finally {
        releaseAgentDelivery();
        if (creationSettled) deletingAgentIds.delete(agent.id);
      }
      } catch (error) {
        const current = store.getAgentCreationOperation(creationOperation.id);
        if (current && current.agentIds.length === 0) {
          if (error instanceof ProviderDisabledError) {
            store.updateAgentCreationOperation(creationOperation.id, { status: "rolled_back", lastError: error.message });
            return reply.code(409).send({ error: error.message, code: error.code, engineId: error.engineId });
          }
          const status = error instanceof AssetError ? error.statusCode : 500;
          return abandonMutationFreeOperation(
            status,
            error instanceof Error ? error.message : "Agent creation preparation failed",
          );
        }
        throw error;
      } finally {
        const remaining = (agentCreationConversationLeases.get(
          leaseConversationId,
        ) ?? 1) - 1;
        if (remaining > 0) {
          agentCreationConversationLeases.set(leaseConversationId, remaining);
        } else {
          agentCreationConversationLeases.delete(leaseConversationId);
        }
        activeCreationOperations.delete(creationOperation.id);
      }
    },
  );
}
