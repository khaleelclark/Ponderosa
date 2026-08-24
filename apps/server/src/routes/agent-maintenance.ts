import type {
  AgentDeletionPreviewRequest,
  CommitAgentDeletionRequest,
  CommitAgentDeletionResponse,
  ModelOption,
  UpdateAgentOrganizationRequest,
  UpdateAgentRequest,
} from "@ponderosa/core";
import {
  AgentDeletionConflictError,
  normalizeAgentTitle,
  type AgentManagementAuthorization,
  type AgentStore,
  type CoordinationV3Store,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { EngineRegistration } from "../app-contracts.js";
import { runtimeSelectionError } from "../runtime-selection.js";
import type { TriggerSourceService } from "../trigger-service.js";

interface AgentMaintenanceRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  triggerSources: TriggerSourceService;
  deletingAgentIds: Set<string>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[];
  commitAgentDeletion(
    rootAgentIds: string[],
    previewHash: string,
    authorization?: AgentManagementAuthorization,
  ): Promise<CommitAgentDeletionResponse>;
  notifyScheduler(): void;
  appendWorkspace(event: {
    type: "project_changed";
    projectId: string;
    action: "updated";
  }): unknown;
}

export function registerAgentMaintenanceRoutes(
  app: FastifyInstance,
  context: AgentMaintenanceRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    workspace,
    engines,
    triggerSources,
    deletingAgentIds,
    cachedModelOptions,
    commitAgentDeletion,
    notifyScheduler,
    appendWorkspace,
  } = context;

  app.patch<{ Params: { id: string }; Body: UpdateAgentRequest }>(
    "/api/agents/:id",
    async (request, reply) => {
      if (deletingAgentIds.has(request.params.id)) {
        return reply.code(409).send({ error: "Agent deletion is already in progress" });
      }
      const current = store.getAgent(request.params.id);
      if (!current) return reply.code(404).send({ error: "agent not found" });
      const body = request.body ?? {};
      const allowedFields = new Set(["title", "archived", "activeEngine", "model", "effort", "managementPermissions"]);
      if (Object.keys(body).some((key) => !allowedFields.has(key))) {
        return reply.code(400).send({ error: "unknown agent field" });
      }
      let normalizedTitle: string | undefined;
      if (body.title !== undefined) {
        if (typeof body.title !== "string") {
          return reply.code(400).send({ error: "title must be a string" });
        }
        try {
          normalizedTitle = normalizeAgentTitle(body.title);
        } catch (error) {
          return reply.code(400).send({
            error: error instanceof Error ? error.message : "invalid Agent title",
          });
        }
      }
      const permissions = request.body?.managementPermissions;
      if (permissions && (
        typeof permissions.allowAutomaticDescendantDeletion !== "boolean"
        || typeof permissions.allowAutomaticDescendantReorganization !== "boolean"
      )) return reply.code(400).send({ error: "managementPermissions requires two boolean settings" });
      if (body.activeEngine !== undefined && (typeof body.activeEngine !== "string" || !body.activeEngine.trim())) {
        return reply.code(400).send({ error: "activeEngine must be a configured engine" });
      }
      if (body.model !== undefined && body.model !== null && typeof body.model !== "string") {
        return reply.code(400).send({ error: "model must be a string or null" });
      }
      if (body.effort !== undefined && body.effort !== null && typeof body.effort !== "string") {
        return reply.code(400).send({ error: "effort must be a string or null" });
      }
      const runtimeSettingsChanged = body.activeEngine !== undefined || body.model !== undefined || body.effort !== undefined;
      let runtimePatch: Pick<UpdateAgentRequest, "activeEngine" | "model" | "effort"> = {};
      if (runtimeSettingsChanged) {
        const activeEngine = body.activeEngine?.trim() || current.activeEngine;
        const engineChanged = activeEngine !== current.activeEngine;
        const configured = engines.get(activeEngine);
        if (!configured) return reply.code(400).send({ error: "unknown engine" });
        const model = body.model === undefined ? (engineChanged ? undefined : current.model) : body.model?.trim() || undefined;
        const effort = body.effort === undefined ? (engineChanged ? undefined : current.effort) : body.effort?.trim() || undefined;
        const selectionError = runtimeSelectionError(
          configured.adapter,
          model,
          effort,
          cachedModelOptions(configured.adapter, current.projectId),
        );
        if (selectionError) return reply.code(400).send({ error: selectionError });
        runtimePatch = { activeEngine, model: model ?? null, effort: effort ?? null };
      }
      const agent = store.updateAgent(request.params.id, {
        ...body,
        ...runtimePatch,
        ...(normalizedTitle !== undefined ? { title: normalizedTitle } : {}),
      });
      if (agent && runtimeSettingsChanged) {
        const recovery = coordinationV3.resumeProviderBlockedAgent(agent.id, {
          activeEngine: agent.activeEngine,
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.effort ? { effort: agent.effort } : {}),
        });
        if (recovery.activationIds.length > 0) notifyScheduler();
      }
      if (agent && request.body?.archived !== undefined) await triggerSources.refresh();
      return agent!;
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateAgentOrganizationRequest }>(
    "/api/agents/:id/manager",
    async (request, reply) => {
      if (!request.body || !("managerAgentId" in request.body) ||
        (request.body.managerAgentId !== null && (typeof request.body.managerAgentId !== "string" || !request.body.managerAgentId.trim()))) {
        return reply.code(400).send({ error: "managerAgentId must be a stable agent ID or null" });
      }
      if (deletingAgentIds.has(request.params.id) ||
          (request.body.managerAgentId !== null && deletingAgentIds.has(request.body.managerAgentId))) {
        return reply.code(409).send({ error: "Agent deletion is already in progress" });
      }
      try {
        const previous = store.getAgent(request.params.id);
        const agent = store.updateAgentOrganization(request.params.id, request.body);
        if (!agent) return reply.code(404).send({ error: "agent not found" });
        if ((previous?.managerAgentId ?? null) !== (agent.managerAgentId ?? null)) {
          appendWorkspace({
            type: "project_changed",
            projectId: agent.projectId,
            action: "updated",
          });
        }
        return agent;
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid agent organization" });
      }
    },
  );

  app.put<{
    Params: { id: string };
    Body: { conversationIds: string[]; primaryConversationId?: string };
  }>("/api/agents/:id/conversation-memberships", async (request, reply) => {
    if (deletingAgentIds.has(request.params.id)) {
      return reply.code(409).send({ error: "Agent deletion is already in progress" });
    }
    if (!Array.isArray(request.body?.conversationIds)) {
      return reply.code(400).send({ error: "conversationIds is required" });
    }
    try {
      const agent = store.updateAgentConversationMemberships(request.params.id, request.body, (agentId, removedConversationIds) => {
        for (const conversationId of removedConversationIds) {
          coordinationV3.handleAgentConversationRemoval(agentId, conversationId);
        }
      });
      if (agent) {
        await triggerSources.refresh();
        notifyScheduler();
      }
      return agent ?? reply.code(404).send({ error: "agent not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid membership" });
    }
  });

  app.post<{ Params: { id: string }; Body: AgentDeletionPreviewRequest }>(
    "/api/projects/:id/agent-deletions/preview",
    async (request, reply) => {
      if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
      if (!Array.isArray(request.body?.rootAgentIds) || request.body.rootAgentIds.some((id) => typeof id !== "string" || !id.trim())) {
        return reply.code(400).send({ error: "rootAgentIds must contain stable Agent IDs" });
      }
      try {
        const preview = store.previewAgentDeletion(request.body.rootAgentIds);
        if (preview.projectId !== request.params.id) return reply.code(404).send({ error: "agent not found in Project" });
        return preview;
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid Agent deletion preview";
        return reply.code(message === "agent not found" ? 404 : 400).send({ error: message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: CommitAgentDeletionRequest }>(
    "/api/projects/:id/agent-deletions/commit",
    async (request, reply) => {
      if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
      if (!Array.isArray(request.body?.rootAgentIds) || request.body.rootAgentIds.some((id) => typeof id !== "string" || !id.trim()) ||
          typeof request.body?.previewHash !== "string" || !/^[a-f0-9]{64}$/.test(request.body.previewHash)) {
        return reply.code(400).send({ error: "rootAgentIds and a valid previewHash are required" });
      }
      try {
        const receipt = store.getAgentDeletionReceiptByPreviewHash(request.body.previewHash);
        if (receipt) {
          if (receipt.projectId !== request.params.id) return reply.code(404).send({ error: "deletion receipt not found in Project" });
          return await commitAgentDeletion(request.body.rootAgentIds, request.body.previewHash);
        }
        const current = store.previewAgentDeletion(request.body.rootAgentIds);
        if (current.projectId !== request.params.id) return reply.code(404).send({ error: "agent not found in Project" });
        return await commitAgentDeletion(current.rootAgentIds, request.body.previewHash);
      } catch (error) {
        if (error instanceof AgentDeletionConflictError) {
          return reply.code(409).send({ error: error.message, currentPreview: error.currentPreview });
        }
        const message = error instanceof Error ? error.message : "Agent deletion failed";
        return reply.code(message === "agent not found" ? 404 : 400).send({ error: message });
      }
    },
  );

  app.post("/api/agents/:id/switch-engine", async (_request, reply) =>
    reply.code(501).send({ error: "switch-engine is a v2 endpoint" }),
  );
}
