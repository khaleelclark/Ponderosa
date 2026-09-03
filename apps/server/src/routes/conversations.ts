import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import type {
  Adapter,
  AgentDto,
  AgentHealthProjectionDto,
  ConversationDetailDto,
  ModelOption,
  TeamDirectoryDto,
  UpdateConversationRequest,
} from "@ponderosa/core";
import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { concreteRuntimeSelection, runtimeSelectionError } from "../runtime-selection.js";
import { applyCollectionPageHeaders, collectionGenerationKey, sendCollectionPageError, sqliteCollectionPage, type CollectionQuery } from "../collection-page.js";

interface EngineRegistration {
  adapter: Adapter;
}
export interface ConversationRouteDependencies {
  store: AgentStore;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  cachedModelOptions: (adapter: Adapter, projectId?: string) => ModelOption[];
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  publishWorkspaceSince: (cursor: number) => void;
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
  commitAgentDeletion(rootAgentIds: string[], previewHash: string): Promise<{ deletedAgentIds: string[] }>;
  deletingConversationIds: Set<string>;
  agentCreationConversationLeases: ReadonlyMap<string, number>;
  conversationDeliveryLeases: ReadonlyMap<string, number>;
  purgeCommunicationV4Conversation: (conversationId: string) => void;
  refreshTriggers: () => Promise<unknown>;
  draftAttachmentSurfaceDir: (draftId: string) => string;
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
    publishWorkspaceSince,
    generateConversationTitle,
    conversationDetail,
    agentHealth,
    teamDirectory,
    hasActiveRun,
    commitAgentDeletion,
    deletingConversationIds,
    agentCreationConversationLeases,
    conversationDeliveryLeases,
    purgeCommunicationV4Conversation,
    refreshTriggers,
    draftAttachmentSurfaceDir,
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
    Body: { title?: string; defaultEngine?: string; defaultModel?: string; defaultEffort?: string };
  }>("/api/projects/:id/conversations", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const title = request.body?.title?.trim() || "New Chat";
    if (request.body.defaultEngine && !engines.has(request.body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    if (!request.body.defaultEngine && (request.body.defaultModel || request.body.defaultEffort)) {
      return reply.code(400).send({ error: "default engine is required when selecting a model or effort" });
    }
    const defaultEngine = request.body.defaultEngine ?? project.defaultEngine;
    const registration = engines.get(defaultEngine);
    if (!registration) return reply.code(400).send({ error: "unknown engine" });
    const projectModelOptions = cachedModelOptions(registration.adapter, project.id);
    const selectionError = runtimeSelectionError(
      registration.adapter,
      request.body.defaultModel,
      request.body.defaultEffort,
      projectModelOptions,
    );
    if (selectionError) return reply.code(400).send({ error: selectionError });
    const resolved = concreteRuntimeSelection(registration.adapter, [
      { model: request.body.defaultModel, effort: request.body.defaultEffort },
      project.defaultEngine === defaultEngine ? { model: project.defaultModel, effort: project.defaultEffort } : undefined,
      workspace.getPreferences().engineDefaults?.[defaultEngine],
    ], projectModelOptions);
    const conversation = store.createConversation(request.params.id, {
      title,
      defaultEngine,
      ...resolved,
    });
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
    Body: UpdateConversationRequest;
  }>("/api/conversations/:id", async (request, reply) => {
    const current = store.getConversation(request.params.id);
    if (!current) return reply.code(404).send({ error: "conversation not found" });
    if (request.body?.archived !== undefined && typeof request.body.archived !== "boolean") {
      return reply.code(400).send({ error: "archived must be a boolean" });
    }
    if (deletingConversationIds.has(current.id)) {
      return reply.code(409).send({ error: "Chat deletion is already in progress" });
    }
    if ((agentCreationConversationLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for Agent creation to finish before changing this Chat",
      });
    }
    if (request.body?.archived === true && (conversationDeliveryLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for message delivery to finish before archiving this Chat",
      });
    }
    if (request.body?.defaultEngine && !engines.has(request.body.defaultEngine)) {
      return reply.code(400).send({ error: "unknown engine" });
    }
    const defaultEngine = request.body.defaultEngine === null ? undefined : request.body.defaultEngine ?? current.defaultEngine;
    const defaultModel = request.body.defaultModel === null ? undefined : request.body.defaultModel ?? current.defaultModel;
    const defaultEffort = request.body.defaultEffort === null ? undefined : request.body.defaultEffort ?? current.defaultEffort;
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
    const conversation = store.updateConversation(request.params.id, request.body ?? {});
    if (conversation) {
      if (request.body?.archived !== undefined) await refreshTriggers();
      appendWorkspace({ type: "conversation_changed", projectId: conversation.projectId, conversationId: conversation.id, action: "updated" });
    }
    return conversation;
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const current = store.getConversation(request.params.id);
    if (!current) return reply.code(404).send({ error: "conversation not found" });
    if (deletingConversationIds.has(current.id)) {
      return reply.code(409).send({ error: "Chat deletion is already in progress" });
    }
    if ((agentCreationConversationLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for Agent creation to finish before deleting this Chat",
      });
    }
    if ((conversationDeliveryLeases.get(current.id) ?? 0) > 0) {
      return reply.code(409).send({
        error: "Wait for message delivery to finish before deleting this Chat",
      });
    }
    const enabledAutomation = store.sqlite.prepare(`
      SELECT name FROM trigger_definitions
      WHERE conversation_id = ? AND enabled = 1
      ORDER BY name LIMIT 1
    `).get(current.id) as { name: string } | undefined;
    if (enabledAutomation) {
      return reply.code(409).send({
        error: `Disable or reassign the Automation “${enabledAutomation.name}” before deleting this Chat.`,
      });
    }
    const linkedAgents = store.listAgents(current.projectId).filter((agent) => agent.conversationId === current.id);
    const active = linkedAgents.some((agent) => hasActiveRun(agent.id));
    if (active) return reply.code(409).send({ error: "stop active agents before deleting this Project chat" });

    // Reserve synchronously before the first await. Archiving is the durable
    // restart fence: a crash leaves the Chat unable to accept new Agents, and
    // retrying deletion can safely finish the same cascade.
    deletingConversationIds.add(current.id);
    store.updateConversation(current.id, { archived: true });
    try {
      if (linkedAgents.length > 0) {
        const preview = store.previewAgentDeletion(linkedAgents.map((agent) => agent.id));
        await commitAgentDeletion(preview.rootAgentIds, preview.previewHash);
      }
      const remainingAgents = store.listAgents(current.projectId)
        .filter((agent) => agent.conversationId === current.id);
      if (remainingAgents.length > 0) {
        throw new Error("Chat deletion could not reach an Agent-free commit boundary");
      }
      const deleted = store.deleteConversation(current.id, purgeCommunicationV4Conversation);
      if (!deleted) return reply.code(404).send({ error: "conversation not found" });
      await refreshTriggers();
      const cursor = workspace.cursor();
      workspace.deleteDraft(current.id);
      workspace.deleteDraft(`collaboration:${current.id}`);
      await Promise.allSettled([
        fs.rm(draftAttachmentSurfaceDir(current.id), { recursive: true, force: true }),
        fs.rm(draftAttachmentSurfaceDir(`collaboration:${current.id}`), { recursive: true, force: true }),
      ]);
      workspace.append({ type: "conversation_changed", projectId: current.projectId, conversationId: current.id, action: "deleted" });
      publishWorkspaceSince(cursor);
      return { deleted: true };
    } catch (error) {
      if (store.getConversation(current.id)) {
        store.updateConversation(current.id, { archived: current.archived });
      }
      throw error;
    } finally {
      deletingConversationIds.delete(current.id);
    }
  });

}
