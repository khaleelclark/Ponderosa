import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  Adapter,
  AgentDto,
  AgentHealthProjectionDto,
  ConversationDetailDto,
  CreateConversationRequest,
  ModelOption,
  TeamDirectoryDto,
  UpdateConversationRequest,
} from "@ponderosa/core";
import {
  stableJson,
  type AgentStore,
  type ConversationDeletionReceipt,
  type WorkspaceStore,
} from "@ponderosa/agents";
import { concreteRuntimeSelection, runtimeSelectionError } from "../runtime-selection.js";
import { applyCollectionPageHeaders, collectionGenerationKey, sendCollectionPageError, sqliteCollectionPage, type CollectionQuery } from "../collection-page.js";

interface EngineRegistration {
  adapter: Adapter;
}

const CONVERSATION_CREATE_FIELDS = new Set([
  "title",
  "defaultEngine",
  "defaultModel",
  "defaultEffort",
]);
const CONVERSATION_PATCH_FIELDS = new Set([
  ...CONVERSATION_CREATE_FIELDS,
  "archived",
]);

export function conversationMutationBodyError(
  body: unknown,
  mutation: "create" | "patch",
): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "request body must be an object";
  }
  const entries = Object.entries(body);
  if (entries.length === 0) return "request body must not be empty";
  const allowed = mutation === "create"
    ? CONVERSATION_CREATE_FIELDS
    : CONVERSATION_PATCH_FIELDS;
  for (const [key, value] of entries) {
    if (!allowed.has(key)) return `unknown field: ${key}`;
    if (key === "archived") {
      if (typeof value !== "boolean") return "archived must be a boolean";
      continue;
    }
    const nullableRuntimeField =
      mutation === "patch" && key !== "title" && value === null;
    if (!nullableRuntimeField && typeof value !== "string") {
      return `${key} must be a string${mutation === "patch" && key !== "title" ? " or null" : ""}`;
    }
  }
  return undefined;
}

export interface ConversationRouteDependencies {
  store: AgentStore;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  cachedModelOptions: (adapter: Adapter, projectId?: string) => ModelOption[];
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  generateConversationTitle: (conversationId: string) => Promise<{ title: string; generated: boolean }>;
  conversationDetail: (
    conversationId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ) => ConversationDetailDto | undefined;
  agentHealth: (
    scope: AgentHealthProjectionDto["scope"],
    agents: AgentDto[],
  ) => AgentHealthProjectionDto;
  teamDirectory: (projectId: string, conversationId?: string, fallbackAgentId?: string, selectedAgentIds?: readonly string[]) => TeamDirectoryDto;
  hasActiveRun: (agentId: string) => boolean;
  projectDeletionInProgress: (projectId: string) => boolean;
  deletingConversationIds: Set<string>;
  agentCreationConversationLeases: ReadonlyMap<string, number>;
  conversationDeliveryLeases: ReadonlyMap<string, number>;
  reconcileConversationRuntimeCommunicationProjections: (
    projectId: string,
    conversationId: string,
  ) => Promise<number>;
  refreshTriggers: () => Promise<unknown>;
  processConversationDeletionCleanup(
    receipt: ConversationDeletionReceipt,
  ): Promise<boolean>;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  dependencies: ConversationRouteDependencies,
): void {
  const {
    store,
    workspace,
    engines,
    cachedModelOptions,
    appendWorkspace,
    generateConversationTitle,
    conversationDetail,
    agentHealth,
    teamDirectory,
    hasActiveRun,
    projectDeletionInProgress = () => false,
    deletingConversationIds,
    agentCreationConversationLeases,
    conversationDeliveryLeases,
    reconcileConversationRuntimeCommunicationProjections,
    refreshTriggers,
    processConversationDeletionCleanup,
  } = dependencies;
  app.get<{ Params: { id: string }; Querystring: CollectionQuery }>("/api/projects/:id/team-directory", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    try {
      const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
      const page = sqliteCollectionPage(store.sqlite, request.query, {
        baseSql: `
          SELECT id, title, updated_at
          FROM agents
          WHERE project_id = ? AND deleted_at IS NULL AND archived = 0
            AND NOT EXISTS (
              SELECT 1
              FROM agent_creation_operation_members members
              JOIN agent_creation_operations operations ON operations.id = members.operation_id
              WHERE members.agent_id = agents.id
                AND operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
            )
            ${normalizedSearch ? "AND lower(title || ' ' || active_engine || ' ' || COALESCE(model, '')) LIKE ? ESCAPE '\\\\'" : ""}
        `,
        params: normalizedSearch
          ? [request.params.id, `%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`]
          : [request.params.id],
        order: "title",
        scope: `team-directory:${request.params.id}`,
        generationKeys: [collectionGenerationKey("agents", `project:${request.params.id}`)],
        hydrate: id => store.getAgent(id),
      });
      const directory = teamDirectory(request.params.id, undefined, undefined, page.items.map(agent => agent.id));
      applyCollectionPageHeaders(reply, page);
      return { ...directory, totalAgents: page.total, hasMoreAgents: page.hasMore, ...(page.cursor ? { agentCursor: page.cursor } : {}) };
    } catch (error) {
      return sendCollectionPageError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: CollectionQuery }>("/api/projects/:id/conversations", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    try {
      const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
      const page = sqliteCollectionPage(store.sqlite, request.query, {
        baseSql: `
          SELECT id, title, updated_at
          FROM conversations
          WHERE project_id = ?
            ${normalizedSearch ? "AND lower(title) LIKE ? ESCAPE '\\\\'" : ""}
        `,
        params: normalizedSearch
          ? [request.params.id, `%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`]
          : [request.params.id],
        order: "updated",
        scope: `project-conversations:${request.params.id}`,
        generationKeys: [collectionGenerationKey("conversations", `project:${request.params.id}`)],
        hydrate: id => store.getConversation(id),
      });
      applyCollectionPageHeaders(reply, page);
      return page.items;
    } catch (error) {
      return sendCollectionPageError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: CollectionQuery }>(
    "/api/conversations/:id/members",
    async (request, reply) => {
      const conversation = store.getConversation(request.params.id);
      if (!conversation) return reply.code(404).send({ error: "conversation not found" });
      try {
        const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
        const page = sqliteCollectionPage(store.sqlite, request.query, {
          baseSql: `
            SELECT agent.id, agent.title, agent.updated_at
            FROM agents agent
            WHERE agent.conversation_id = ? AND agent.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM agent_creation_operation_members creation_members
                JOIN agent_creation_operations creation_operations ON creation_operations.id = creation_members.operation_id
                WHERE creation_members.agent_id = agent.id
                  AND creation_operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
              )
              ${normalizedSearch ? "AND lower(agent.title || ' ' || agent.active_engine || ' ' || COALESCE(agent.model, '')) LIKE ? ESCAPE '\\\\'" : ""}
          `,
          params: normalizedSearch
            ? [conversation.id, `%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`]
            : [conversation.id],
          order: "title",
          scope: `conversation-members:${conversation.id}`,
          generationKeys: [
            collectionGenerationKey("agents", `project:${conversation.projectId}`),
            collectionGenerationKey("memberships", `conversation:${conversation.id}`),
          ],
          hydrate: id => store.getAgent(id),
        });
        applyCollectionPageHeaders(reply, page);
        return page.items;
      } catch (error) {
        return sendCollectionPageError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: unknown;
  }>("/api/projects/:id/conversations", async (request, reply) => {
    if (projectDeletionInProgress(request.params.id)) {
      return reply.code(409).send({ error: "Project deletion is in progress" });
    }
    const idempotencyKey = request.headers["idempotency-key"]?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,128}$/u.test(idempotencyKey)) {
      return reply.code(400).send({ error: "a valid Chat creation idempotency key is required" });
    }
    const bodyError = conversationMutationBodyError(request.body, "create");
    if (bodyError) return reply.code(400).send({ error: bodyError });
    const body = request.body as CreateConversationRequest;
    const title = body.title?.trim() || "New Chat";
    const creationIdentity = {
      idempotencyKey,
      payloadHash: createHash("sha256").update(stableJson({
        title,
        defaultEngine: body.defaultEngine ?? null,
        defaultModel: body.defaultModel ?? null,
        defaultEffort: body.defaultEffort ?? null,
      })).digest("hex"),
    };
    try {
      const replay = store.getConversationCreation(request.params.id, creationIdentity);
      if (replay) return replay;
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Chat creation replay conflict",
      });
    }
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (body.defaultEngine && !engines.has(body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    if (!body.defaultEngine && (body.defaultModel || body.defaultEffort)) {
      return reply.code(400).send({ error: "default engine is required when selecting a model or effort" });
    }
    const defaultEngine = body.defaultEngine ?? project.defaultEngine;
    const registration = engines.get(defaultEngine);
    if (!registration) return reply.code(400).send({ error: "unknown engine" });
    const projectModelOptions = cachedModelOptions(registration.adapter, project.id);
    const selectionError = runtimeSelectionError(
      registration.adapter,
      body.defaultModel,
      body.defaultEffort,
      projectModelOptions,
    );
    if (selectionError) return reply.code(400).send({ error: selectionError });
    const resolved = concreteRuntimeSelection(registration.adapter, [
      { model: body.defaultModel, effort: body.defaultEffort },
      project.defaultEngine === defaultEngine ? { model: project.defaultModel, effort: project.defaultEffort } : undefined,
      workspace.getPreferences().engineDefaults?.[defaultEngine],
    ], projectModelOptions);
    const conversation = store.createConversation(request.params.id, {
      title,
      defaultEngine,
      ...resolved,
    }, creationIdentity);
    appendWorkspace({ type: "conversation_changed", projectId: request.params.id, conversationId: conversation.id, action: "created" });
    appendWorkspace({ type: "project_changed", projectId: request.params.id, action: "used" });
    return conversation;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string; focusId?: string } }>("/api/conversations/:id", async (request, reply) => {
    const limit = Math.min(1_000, Math.max(1, Number(request.query.limit ?? 100) || 100));
    try {
      const detail = conversationDetail(request.params.id, { limit, cursor: request.query.cursor, focusId: request.query.focusId });
      return detail ?? reply.code(404).send({ error: "conversation not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid history cursor" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/generate-title", async (request, reply) => {
    if (!store.getConversation(request.params.id)) return reply.code(404).send({ error: "conversation not found" });
    return generateConversationTitle(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/agent-health", async (request, reply) => {
    const master = store.getConversation(request.params.id);
    if (!master) return reply.code(404).send({ error: "conversation not found" });
    const agents = store.listAgents(master.projectId).filter((agent) => agent.conversationId === master.id);
    return agentHealth({ type: "conversation", id: master.id }, agents);
  });

  app.patch<{
    Params: { id: string };
    Body: unknown;
  }>("/api/conversations/:id", async (request, reply) => {
    const bodyError = conversationMutationBodyError(request.body, "patch");
    if (bodyError) return reply.code(400).send({ error: bodyError });
    const body = request.body as UpdateConversationRequest;
    const current = store.getConversation(request.params.id);
    if (!current) return reply.code(404).send({ error: "conversation not found" });
    if (deletingConversationIds.has(current.id)) {
      return reply.code(409).send({ error: "Chat deletion is already in progress" });
    }
    if ((agentCreationConversationLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for Agent creation to finish before changing this Chat",
      });
    }
    if (body.archived === true && (conversationDeliveryLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for message delivery to finish before archiving this Chat",
      });
    }
    if (body.defaultEngine && !engines.has(body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    const defaultEngine = body.defaultEngine === null ? undefined : body.defaultEngine ?? current.defaultEngine;
    const defaultModel = body.defaultModel === null ? undefined : body.defaultModel ?? current.defaultModel;
    const defaultEffort = body.defaultEffort === null ? undefined : body.defaultEffort ?? current.defaultEffort;
    if (!defaultEngine && (defaultModel || defaultEffort)) {
      return reply.code(400).send({ error: "default engine is required when selecting a model or effort" });
    }
    if (defaultEngine) {
      const configuredDefaultEngine = engines.get(defaultEngine);
      if (!configuredDefaultEngine) return reply.code(400).send({ error: "unknown engine" });
      const selectionError = runtimeSelectionError(
        configuredDefaultEngine.adapter,
        defaultModel,
        defaultEffort,
        cachedModelOptions(configuredDefaultEngine.adapter, current.projectId),
      );
      if (selectionError) return reply.code(400).send({ error: selectionError });
    }
    if (body.archived !== undefined) {
      deletingConversationIds.add(current.id);
      let mutationCommitted = false;
      const provisionallyUnarchived = current.archived;
      try {
        // Archived Chats cannot accept a room projection. Temporarily expose
        // the room only behind the deletion/lifecycle fence, which keeps all
        // new delivery and Agent creation out until recovery and mutation form
        // one serialized operation.
        if (provisionallyUnarchived) {
          store.updateConversation(current.id, { archived: false });
        }
        try {
          await reconcileConversationRuntimeCommunicationProjections(current.projectId, current.id);
        } catch {
          return reply.code(409).send({
            error: "Wait for committed message recovery to finish before changing this Chat",
          });
        }
        if (!store.getConversation(current.id)) {
          return reply.code(404).send({ error: "conversation not found" });
        }
        if ((agentCreationConversationLeases.get(current.id) ?? 0) > 0) {
          return reply.code(409).send({
            error: "Wait for Agent creation to finish before changing this Chat",
          });
        }
        if (body.archived === true && (conversationDeliveryLeases.get(current.id) ?? 0) > 0) {
          return reply.code(409).send({
            error: "Wait for message delivery to finish before archiving this Chat",
          });
        }
        const conversation = store.updateConversation(request.params.id, body);
        mutationCommitted = Boolean(conversation);
        if (conversation) {
          await refreshTriggers();
          appendWorkspace({ type: "conversation_changed", projectId: conversation.projectId, conversationId: conversation.id, action: "updated" });
        }
        return conversation;
      } finally {
        if (provisionallyUnarchived && !mutationCommitted && store.getConversation(current.id)) {
          store.updateConversation(current.id, { archived: true });
        }
        deletingConversationIds.delete(current.id);
      }
    }
    const conversation = store.updateConversation(request.params.id, body);
    if (conversation) {
      appendWorkspace({ type: "conversation_changed", projectId: conversation.projectId, conversationId: conversation.id, action: "updated" });
    }
    return conversation;
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const current = store.getConversation(request.params.id);
    const pending = store.getConversationDeletionReceipt(request.params.id);
    if (projectDeletionInProgress(current?.projectId ?? pending?.projectId ?? "")) {
      return reply.code(409).send({ error: "Project deletion is already in progress" });
    }
    if (!current) {
      if (!pending) return reply.code(404).send({ error: "conversation not found" });
      await processConversationDeletionCleanup(pending);
      const refreshed = store.getConversationDeletionReceipt(pending.conversationId)!;
      const deleted = refreshed.canonicalDeletionCompleted;
      return reply.code(deleted ? 200 : 202).send({
        deleted,
        deletionReceiptId: refreshed.conversationId,
        cleanupPending: !deleted ||
          !(refreshed.storageCleanupCompleted && refreshed.serverCleanupCompleted),
        ...(!deleted ? { deletionPending: true, retryable: true } : {}),
        replayed: true,
      });
    }
    if (deletingConversationIds.has(current.id) && !pending) {
      return reply.code(409).send({ error: "Chat deletion is already in progress" });
    }
    if (!pending && (agentCreationConversationLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for Agent creation to finish before deleting this Chat",
      });
    }
    if (!pending && (conversationDeliveryLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for message delivery to finish before deleting this Chat",
      });
    }
    const enabledAutomation = !pending ? store.sqlite.prepare(`
      SELECT name FROM trigger_definitions
      WHERE conversation_id = ? AND enabled = 1
      ORDER BY name LIMIT 1
    `).get(current.id) as { name: string } | undefined : undefined;
    if (enabledAutomation) {
      return reply.code(409).send({
        error: `Disable or reassign the Automation “${enabledAutomation.name}” before deleting this Chat.`,
      });
    }
    const linkedAgents = pending ? [] : store.listAgents(current.projectId)
      .filter((agent) => agent.conversationId === current.id);
    const active = !pending && linkedAgents.some((agent) => hasActiveRun(agent.id));
    if (active) return reply.code(409).send({ error: "stop active agents before deleting this Project chat" });

    let receipt = pending;
    if (!receipt) {
      try {
        receipt = store.markConversationDeletionPending(current.id);
      } catch (error) {
        return reply.code(503).send({
          error: error instanceof Error ? error.message : "Chat deletion intent could not be persisted",
          cleanupPending: false,
          retryable: true,
        });
      }
    }
    if (!receipt) throw new Error("Chat deletion intent was not persisted");
    deletingConversationIds.add(current.id);
    await processConversationDeletionCleanup(receipt);
    const refreshed = store.getConversationDeletionReceipt(receipt.conversationId)!;
    const deleted = refreshed.canonicalDeletionCompleted;
    return reply.code(deleted ? 200 : 202).send({
      deleted,
      deletionReceiptId: refreshed.conversationId,
      cleanupPending: !deleted ||
        !(refreshed.storageCleanupCompleted && refreshed.serverCleanupCompleted),
      ...(!deleted ? { deletionPending: true, retryable: true } : {}),
      ...(pending ? { replayed: true } : {}),
    });
  });

}
