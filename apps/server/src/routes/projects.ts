import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CreateProjectRequest,
  ModelOption,
  UpdateProjectRequest,
} from "@ponderosa/core";
import { stableJson, type AgentStore, type WorkspaceStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, EngineRegistration, PersistentRuntime } from "../app-contracts.js";
import {
  concreteRuntimeSelection,
  runtimeSelectionError,
} from "../runtime-selection.js";
import {
  registerProjectFolderRoutes,
  type ProjectFolderPathBoundary,
} from "./project-folders.js";

interface ProjectRoutesContext {
  store: AgentStore;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  managedWorkspacesRoot: string;
  projectFolderPathBoundary: ProjectFolderPathBoundary;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  scheduledSessionRollovers: Map<string, string>;
  organizationEnvelopeStates: Map<string, { sessionId: string; hash: string }>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[];
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  refreshCommunicationReconciliation(projectId: string): void;
  clearAgentResumeSession(agentId: string, reason: string): void;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  teardownPersistentRuntime(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
    projectId: string,
  ): Promise<void>;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  context: ProjectRoutesContext,
): void {
  const {
    store,
    workspace,
    engines,
    managedWorkspacesRoot,
    projectFolderPathBoundary,
    activeRuns,
    scheduledSessionRollovers,
    organizationEnvelopeStates,
    cachedModelOptions,
    appendWorkspace,
    refreshCommunicationReconciliation,
    clearAgentResumeSession,
    persistentRuntimeForTermination,
    teardownPersistentRuntime,
  } = context;

  registerProjectFolderRoutes(app, {
    managedWorkspacesRoot,
    pathBoundary: projectFolderPathBoundary,
    store,
  });

  app.post<{ Body: CreateProjectRequest; Headers: { "idempotency-key"?: string } }>("/api/projects", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"]?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,128}$/u.test(idempotencyKey)) {
      return reply.code(400).send({ error: "a valid Project creation idempotency key is required" });
    }
    const label = request.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    const defaultEngine = request.body?.defaultEngine;
    if (!defaultEngine) return reply.code(400).send({ error: "a configured default engine is required" });
    if (request.body.hostPath && request.body.createFolderName) return reply.code(400).send({ error: "choose an existing folder or create a new one, not both" });
    const requestedName = request.body.createFolderName?.trim() ||
      `project-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12)}`;
    if (!request.body.hostPath &&
        (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(requestedName) ||
          requestedName === "." || requestedName === "..")) {
      return reply.code(400).send({ error: "folder name must be a single safe name" });
    }
    let hostPath = request.body.hostPath
      ? path.resolve(request.body.hostPath)
      : path.join(managedWorkspacesRoot, requestedName);
    const creationIdentity = {
      idempotencyKey,
      payloadHash: createHash("sha256").update(stableJson({
        label,
        hostPath,
        defaultEngine,
        defaultModel: request.body.defaultModel ?? null,
        defaultEffort: request.body.defaultEffort ?? null,
      })).digest("hex"),
    };
    try {
      const replay = store.getProjectCreation(creationIdentity);
      if (replay) return replay;
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Project creation replay conflict",
      });
    }
    if (!engines.has(defaultEngine)) return reply.code(400).send({ error: "a configured default engine is required" });
    const creationAdapter = engines.get(defaultEngine)!.adapter;
    const creationModelOptions = cachedModelOptions(creationAdapter);
    const selectionError = runtimeSelectionError(
      creationAdapter,
      request.body.defaultModel,
      request.body.defaultEffort,
      creationModelOptions,
    );
    if (selectionError) return reply.code(400).send({ error: selectionError });
    await fs.mkdir(managedWorkspacesRoot, { recursive: true });
    let createdManagedFolder = false;
    if (request.body.hostPath) {
      try {
        const stat = await fs.stat(hostPath);
        if (!stat.isDirectory()) return reply.code(400).send({ error: "hostPath must be a directory" });
        const validated = await projectFolderPathBoundary.validatedBrowsePath(hostPath);
        hostPath = validated.candidate;
      } catch {
        return reply.code(400).send({ error: "hostPath does not exist" });
      }
    }
    if (!request.body.hostPath) {
      try {
        await fs.mkdir(hostPath, { recursive: false });
        createdManagedFolder = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return reply.code(409).send({ error: "folder already exists" });
        throw error;
      }
    }
    let project;
    try {
      project = store.createProject({
        label,
        hostPath,
        defaultEngine,
        ...(request.body.defaultModel ? { defaultModel: request.body.defaultModel } : {}),
        ...(request.body.defaultEffort ? { defaultEffort: request.body.defaultEffort } : {}),
      }, creationIdentity);
      if (project.lastConversationId) {
        const resolved = concreteRuntimeSelection(creationAdapter, [
          { model: project.defaultModel, effort: project.defaultEffort },
          workspace.getPreferences().engineDefaults?.[defaultEngine],
        ], creationModelOptions);
        store.updateConversation(project.lastConversationId, {
          defaultEngine,
          defaultModel: resolved.model ?? null,
          defaultEffort: resolved.effort ?? null,
        });
      }
    } catch (error) {
      const committed = store.getProjectCreation(creationIdentity);
      if (committed) project = committed;
      else {
        if (createdManagedFolder) await fs.rm(hostPath, { recursive: true, force: true });
        throw error;
      }
    }
    appendWorkspace({ type: "project_changed", projectId: project.id, action: "created" });
    refreshCommunicationReconciliation(project.id);
    if (project.lastConversationId) appendWorkspace({ type: "conversation_changed", projectId: project.id, conversationId: project.lastConversationId, action: "created" });
    return project;
  });

  app.post<{ Params: { id: string }; Body: { conversationId?: string } }>("/api/projects/:id/use", async (request, reply) => {
    try {
      const project = store.markProjectUsed(request.params.id, request.body?.conversationId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      appendWorkspace({ type: "project_changed", projectId: project.id, action: "used" });
      if (request.body?.conversationId) appendWorkspace({ type: "conversation_changed", projectId: project.id, conversationId: request.body.conversationId, action: "used" });
      return project;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "project could not be selected" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = store.getProject(request.params.id);
    return project ?? reply.code(404).send({ error: "project not found" });
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>("/api/projects/:id", async (request, reply) => {
    const current = store.getProject(request.params.id);
    if (!current) return reply.code(404).send({ error: "project not found" });
    const label = request.body?.label?.trim() ?? current.label;
    if (!label) return reply.code(400).send({ error: "label is required" });
    if (request.body.instructions !== undefined && typeof request.body.instructions !== "string") return reply.code(400).send({ error: "instructions must be a string" });
    const defaultEngine = request.body.defaultEngine ?? current.defaultEngine;
    const engineChanged = defaultEngine !== current.defaultEngine;
    if (!engines.has(defaultEngine)) return reply.code(400).send({ error: "unknown engine" });
    const defaultModel = request.body.defaultModel === null ? undefined : request.body.defaultModel ?? (engineChanged ? undefined : current.defaultModel);
    const defaultEffort = request.body.defaultEffort === null ? undefined : request.body.defaultEffort ?? (engineChanged ? undefined : current.defaultEffort);
    const projectAdapter = engines.get(defaultEngine)!.adapter;
    const selectionError = runtimeSelectionError(
      projectAdapter,
      defaultModel,
      defaultEffort,
      cachedModelOptions(projectAdapter, current.id),
    );
    if (selectionError) return reply.code(400).send({ error: selectionError });
    const instructionsChanged = request.body.instructions !== undefined && request.body.instructions !== (current.instructions ?? "");
    const project = store.updateProject(request.params.id, {
      label,
      defaultEngine,
      defaultModel: defaultModel ?? null,
      defaultEffort: defaultEffort ?? null,
      ...(request.body.instructions !== undefined ? { instructions: request.body.instructions } : {}),
    });
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (instructionsChanged) for (const agent of store.listAgents(project.id)) {
      organizationEnvelopeStates.delete(agent.id);
      if (activeRuns.has(agent.id)) scheduledSessionRollovers.set(agent.id, new Date().toISOString());
      else {
        clearAgentResumeSession(agent.id, "request_context_rollover");
        const runtime = persistentRuntimeForTermination(agent.id);
        if (runtime) await teardownPersistentRuntime(agent.id, runtime, "Project instruction update", project.id);
      }
    }
    appendWorkspace({ type: "project_changed", projectId: project.id, action: "updated" });
    return project;
  });
}
