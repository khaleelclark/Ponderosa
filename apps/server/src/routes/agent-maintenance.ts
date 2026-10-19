import type {
  AgentWorkingCopyDto,
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
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, EngineRegistration, PersistentRuntime } from "../app-contracts.js";
import { runtimeSelectionError, runtimeSpeedSelectionError } from "../runtime-selection.js";
import type { AgentWorkingCopyService } from "../agent-working-copy-service.js";

interface AgentMaintenanceRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  engines: ReadonlyMap<string, EngineRegistration>;
  deletingAgentIds: Set<string>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  workingCopies: AgentWorkingCopyService;
  clearAgentResumeSession(agentId: string, reason: string): void;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  teardownPersistentRuntime(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
    projectId?: string,
  ): Promise<void>;
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
    engines,
    deletingAgentIds,
    activeRuns,
    workingCopies,
    clearAgentResumeSession,
    persistentRuntimeForTermination,
    teardownPersistentRuntime,
    cachedModelOptions,
    commitAgentDeletion,
    notifyScheduler,
    appendWorkspace,
  } = context;

  app.delete<{ Params: { projectId: string; id: string } }>(
    "/api/projects/:projectId/deleted-agents/:id/working-copy",
    async (request, reply) => {
      const project = store.getProject(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (store.agentCreationPending(request.params.id)) {
        return reply.code(404).send({ error: "deleted Agent not found" });
      }
      const row = store.sqlite.prepare(`
        SELECT working_copy_json FROM agents
        WHERE id = ? AND project_id = ? AND deleted_at IS NOT NULL
      `).get(request.params.id, project.id) as { working_copy_json: string } | undefined;
      if (!row) return reply.code(404).send({ error: "deleted Agent not found" });
      let workingCopy: AgentWorkingCopyDto;
      try {
        workingCopy = JSON.parse(row.working_copy_json) as AgentWorkingCopyDto;
      } catch {
        return reply.code(409).send({ error: "The retained working-copy record is invalid" });
      }
      try {
        const removed = await workingCopies.cleanupRetained(request.params.id, workingCopy, project, {
          allowSourceUnavailable: true,
          deleted: true,
        });
        appendWorkspace({ type: "project_changed", projectId: project.id, action: "updated" });
        return removed;
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "Retained Git copy cleanup failed",
        });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateAgentRequest }>(
    "/api/agents/:id",
    async (request, reply) => {
      if (deletingAgentIds.has(request.params.id)) {
        return reply.code(409).send({ error: "Agent deletion is already in progress" });
      }
      const current = store.getAgent(request.params.id);
      if (!current) return reply.code(404).send({ error: "agent not found" });
      const body = request.body ?? {};
      const allowedFields = new Set(["title", "activeEngine", "model", "effort", "speed", "workingCopyMode", "managementPermissions"]);
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
      if (body.speed !== undefined && body.speed !== null && typeof body.speed !== "string") {
        return reply.code(400).send({ error: "speed must be a string or null" });
      }
      if (body.workingCopyMode !== undefined &&
          body.workingCopyMode !== "shared" && body.workingCopyMode !== "separate_git") {
        return reply.code(400).send({ error: "workingCopyMode must be shared or separate_git" });
      }
      if (body.workingCopyMode !== undefined && Object.keys(body).some((key) => key !== "workingCopyMode")) {
        return reply.code(400).send({
          error: "Change the working folder separately from other Agent settings.",
        });
      }
      if (body.workingCopyMode !== undefined) {
        let releaseModeChange: (() => void) | undefined;
        try {
          releaseModeChange = workingCopies.beginModeChange(current.id);
          if (activeRuns.has(current.id) || coordinationV3.agentSnapshot(current.id).activeRun) {
            return reply.code(409).send({
              error: "Stop this Agent's active Run before changing its working folder.",
            });
          }
          await workingCopies.awaitUses(new Set([current.id]));
          const project = store.getProject(current.projectId);
          if (!project) return reply.code(409).send({ error: "Agent Project is unavailable" });
          const runtime = persistentRuntimeForTermination(current.id);
          if (runtime) {
            await teardownPersistentRuntime(
              current.id,
              runtime,
              "working-copy mode changed",
              project.id,
            );
          }
          clearAgentResumeSession(current.id, "working_copy_changed");
          const changed = await workingCopies.setMode(current, project, body.workingCopyMode);
          return changed;
        } catch (error) {
          return reply.code(409).send({
            error: error instanceof Error
              ? error.message
              : "The working folder could not be changed safely.",
          });
        } finally {
          releaseModeChange?.();
        }
      }
      const runtimeSettingsChanged = body.activeEngine !== undefined || body.model !== undefined || body.effort !== undefined || body.speed !== undefined;
      let runtimePatch: Pick<UpdateAgentRequest, "activeEngine" | "model" | "effort" | "speed"> = {};
      if (runtimeSettingsChanged) {
        const activeEngine = body.activeEngine?.trim() || current.activeEngine;
        const engineChanged = activeEngine !== current.activeEngine;
        const configured = engines.get(activeEngine);
        if (!configured) return reply.code(400).send({ error: "unknown engine" });
        const model = body.model === undefined ? (engineChanged ? undefined : current.model) : body.model?.trim() || undefined;
        const effort = body.effort === undefined ? (engineChanged ? undefined : current.effort) : body.effort?.trim() || undefined;
        const speed = body.speed === undefined ? (engineChanged ? undefined : current.speed) : body.speed?.trim() || undefined;
        const modelOptions = cachedModelOptions(configured.adapter, current.projectId);
        const selectionError = runtimeSelectionError(
          configured.adapter,
          model,
          effort,
          modelOptions,
        );
        if (selectionError) return reply.code(400).send({ error: selectionError });
        const speedError = runtimeSpeedSelectionError(configured.adapter, model, speed, modelOptions);
        if (speedError) return reply.code(400).send({ error: speedError });
        runtimePatch = { activeEngine, model: model ?? null, effort: effort ?? null, speed: speed ?? null };
      }
      const agent = store.updateAgent(request.params.id, {
        ...body,
        workingCopyMode: undefined,
        ...runtimePatch,
        ...(normalizedTitle !== undefined ? { title: normalizedTitle } : {}),
      });
      if (agent && runtimeSettingsChanged) {
        const recovery = coordinationV3.resumeProviderBlockedAgent(agent.id, {
          activeEngine: agent.activeEngine,
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.effort ? { effort: agent.effort } : {}),
          ...(agent.speed ? { speed: agent.speed } : {}),
        });
        if (recovery.activationIds.length > 0) notifyScheduler();
      }
      try { appendWorkspace({ type: "project_changed", projectId: current.projectId, action: "updated" }); }
      catch { /* Committed metadata remains visible on refresh. */ }
      return agent!;
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateAgentOrganizationRequest }>(
    "/api/agents/:id/manager",
    async (request, reply) => {
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).some((key) => key !== "managerAgentId") ||
        !("managerAgentId" in request.body) ||
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
