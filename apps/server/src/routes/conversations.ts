import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import type {
  Adapter,
  AgentDto,
  AgentHealthProjectionDto,
  ConversationDto,
  ConversationDetailDto,
  ModelOption,
  ProviderPermissionMode,
  TeamDirectoryDto,
  UpdateConversationRequest,
} from "@ponderosa/core";
import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { concreteRuntimeSelection, runtimeSelectionError } from "../runtime-selection.js";

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
  teamDirectory: (projectId: string) => TeamDirectoryDto;
  hasActiveRun: (agentId: string) => boolean;
  handleAgentConversationRemoval: (agentId: string, conversationId: string) => void;
  applyProviderPermissionMode: (conversation: ConversationDto) => void;
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
    handleAgentConversationRemoval,
    applyProviderPermissionMode,
    refreshTriggers,
    draftAttachmentSurfaceDir,
  } = dependencies;
  app.get<{ Params: { id: string } }>("/api/projects/:id/team-directory", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return teamDirectory(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/conversations", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return store.listConversations(request.params.id);
  });

  app.post<{
    Params: { id: string };
    Body: { title: string; defaultEngine?: string; defaultModel?: string; defaultEffort?: string };
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
    const agents = store.listAgents(master.projectId).filter((agent) => agent.conversationIds.includes(master.id));
    return agentHealth({ type: "conversation", id: master.id }, agents);
  });

  app.patch<{
    Params: { id: string };
    Body: UpdateConversationRequest;
  }>("/api/conversations/:id", async (request, reply) => {
    const current = store.getConversation(request.params.id);
    if (!current) return reply.code(404).send({ error: "conversation not found" });
    const permissionMode = request.body?.providerPermissionMode;
    if (permissionMode && !([
      "ask",
      "auto_confirmations",
    ] satisfies ProviderPermissionMode[]).includes(permissionMode)) {
      return reply.code(400).send({ error: "invalid provider permission mode" });
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
      if (permissionMode && permissionMode !== current.providerPermissionMode) {
        applyProviderPermissionMode(conversation);
      }
    }
    return conversation;
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const current = store.getConversation(request.params.id);
    if (current) {
      const linkedAgents = store.listAgents(current.projectId).filter((agent) => agent.conversationIds.includes(current.id));
      const active = linkedAgents.some((agent) => hasActiveRun(agent.id));
      if (active) return reply.code(409).send({ error: "stop active agents before deleting this Project chat" });
    }
    const deleted = store.deleteConversation(request.params.id, (agentId, conversationId) => {
      handleAgentConversationRemoval(agentId, conversationId);
    });
    if (deleted && current) {
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
    }
    return deleted ? { deleted: true } : reply.code(404).send({ error: "conversation not found" });
  });

}
