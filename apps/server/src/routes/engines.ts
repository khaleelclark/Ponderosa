import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type {
  Adapter,
  EngineAuthStatus,
  EngineAvailabilityStatus,
  EngineCapabilities,
  EngineDto,
  EngineModelValidationDto,
  ProjectEngineCapabilitiesDto,
  ProjectEngineModelCatalogDto,
  ProviderUsageCenterDto,
  ProviderUsageStateDto,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { EngineAuthStatusCache } from "../engine-auth-cache.js";
import type { EngineAvailabilityStore } from "../engine-availability-store.js";
import {
  providerUnavailableNotificationBody,
  publicProviderExceptionResponse,
} from "../provider-availability-detail.js";
import { restrictedProviderExceptionLogDetail } from "../provider-exception-properties.js";
import { projectProviderAvailabilityStatus } from "../provider-success-projection.js";

interface EngineRouteRegistration {
  adapter: Adapter;
  authStatus?: () => Promise<EngineAuthStatus>;
  availabilityProbe?: () => Promise<EngineAvailabilityStatus>;
}

interface OperationalNotificationInput {
  dedupeKey: string;
  category: "communication" | "provider" | "trigger" | "budget" | "coordination" | "decision" | "system";
  severity: "info" | "attention" | "urgent";
  title: string;
  body: string;
  projectId?: string;
  conversationId?: string;
  conversationIds?: string[];
  agentId?: string;
  agentIds?: string[];
  action?: WorkspaceNotificationDto["action"];
  resolution?: WorkspaceNotificationDto["resolution"];
}

interface EngineRoutesContext {
  engines: ReadonlyMap<string, EngineRouteRegistration>;
  store: Pick<AgentStore, "getAgent" | "getProject">;
  workspace: Pick<WorkspaceStore, "cursor" | "getPreferences" | "updatePreferences">;
  engineDto(registration: EngineRouteRegistration): Promise<EngineDto>;
  providerUsageCenter(refresh: "none" | "stale"): Promise<ProviderUsageCenterDto>;
  providerUsageState(
    registration: EngineRouteRegistration,
    refresh: "none" | "stale" | "force",
  ): Promise<ProviderUsageStateDto>;
  publishWorkspaceSince(cursor: number): void;
  notifyScheduler(): void;
  authStatuses: Pick<EngineAuthStatusCache, "invalidate" | "get">;
  availability: Pick<EngineAvailabilityStore, "denial" | "record">;
  createOperationalNotification(input: OperationalNotificationInput): unknown;
  resolveOperationalNotification(dedupeKey: string): void;
  projectDeletionInProgress(projectId: string): boolean;
  discoverModelCatalog(
    project: { id: string; hostPath: string },
    adapter: Adapter,
    forceRefresh: boolean,
  ): Promise<ProjectEngineModelCatalogDto>;
  validateModel(
    project: { id: string; hostPath: string },
    adapter: Adapter,
    modelId: string,
  ): Promise<EngineModelValidationDto>;
  discoverCapabilities(
    projectId: string,
    hostPath: string,
    adapter: Adapter,
    model: string | undefined,
    forceRefresh: boolean,
  ): Promise<EngineCapabilities>;
  readCapabilities(
    projectId: string,
    hostPath: string,
    adapter: Adapter,
    model: string | undefined,
  ): {
    capabilities: EngineCapabilities;
    discovered: boolean;
    refreshing: boolean;
  };
}

export function registerEngineRoutes(
  app: FastifyInstance,
  context: EngineRoutesContext,
): void {
  const {
    engines,
    store,
    workspace,
    engineDto,
    providerUsageCenter,
    providerUsageState,
    publishWorkspaceSince,
    notifyScheduler,
    authStatuses,
    availability,
    createOperationalNotification,
    resolveOperationalNotification,
    projectDeletionInProgress,
    discoverModelCatalog,
    validateModel,
    discoverCapabilities,
    readCapabilities,
  } = context;
  // A timed-out HTTP response does not release this diagnostic slot. The
  // provider process and cleanup must actually settle before another recheck.
  const rechecks = new Map<string, Promise<EngineDto>>();

  app.get("/api/engines", async (): Promise<EngineDto[]> => {
    return Promise.all(Array.from(engines.values()).map(engineDto));
  });

  app.get<{ Querystring: { refresh?: string } }>(
    "/api/provider-usage",
    async (request, reply): Promise<ProviderUsageCenterDto | FastifyReply> => {
      if (request.query.refresh !== undefined && request.query.refresh !== "stale") {
        return reply.code(400).send({ error: "refresh must be stale when provided" });
      }
      return providerUsageCenter(request.query.refresh === "stale" ? "stale" : "none");
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/provider-usage/:id/refresh",
    async (request, reply): Promise<ProviderUsageStateDto | FastifyReply> => {
      const registration = engines.get(request.params.id);
      if (!registration) return reply.code(404).send({ error: "unknown engine" });
      return providerUsageState(registration, "force");
    },
  );

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/agents/:id/provider-usage",
    async (request, reply): Promise<ProviderUsageStateDto | FastifyReply> => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const registration = engines.get(agent.activeEngine);
      if (!registration) return reply.code(404).send({ error: "engine not found" });
      if (request.query.refresh !== undefined && request.query.refresh !== "stale") {
        return reply.code(400).send({ error: "refresh must be stale when provided" });
      }
      return providerUsageState(
        registration,
        request.query.refresh === "stale" ? "stale" : "none",
      );
    },
  );

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    "/api/engines/:id",
    async (request, reply) => {
      const registration = engines.get(request.params.id);
      if (!registration) return reply.code(404).send({ error: "unknown engine" });
      if (typeof request.body?.enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean" });
      }
      const cursor = workspace.cursor();
      workspace.updatePreferences({
        providerAvailability: {
          ...workspace.getPreferences().providerAvailability,
          [request.params.id]: request.body.enabled,
        },
      });
      publishWorkspaceSince(cursor);
      if (request.body.enabled) notifyScheduler();
      return engineDto(registration);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/engines/:id/recheck",
    async (request, reply) => {
      const registration = engines.get(request.params.id);
      if (!registration) return reply.code(404).send({ error: "unknown engine" });
      const current = rechecks.get(request.params.id);
      if (current) return current;
      const operationStartedAt = new Date().toISOString();
      const operation = (async (): Promise<EngineDto> => {
      const readiness = await engineDto(registration);
      if (readiness.resourceAdmission?.state === "held") return readiness;
      authStatuses.invalidate(request.params.id);
      let auth: EngineAuthStatus;
      try {
        auth = registration.authStatus
          ? await authStatuses.get(request.params.id, registration.authStatus)
          : { authenticated: true };
      } catch {
        return engineDto(registration);
      }
      if (!auth.authenticated) return engineDto(registration);
      if (!registration.availabilityProbe) {
        const refreshed = await engineDto(registration);
        if (refreshed.intakeReady) {
          resolveOperationalNotification(`provider:${request.params.id}:unavailable`);
          notifyScheduler();
        }
        return refreshed;
      }
      let result: EngineAvailabilityStatus;
      try {
        result = projectProviderAvailabilityStatus(await registration.availabilityProbe());
      } catch (error) {
        request.log.warn({
          providerError: restrictedProviderExceptionLogDetail(error),
          engineId: request.params.id,
        }, "provider availability probe failed");
        result = {
          available: false,
          failureCategory: "unavailable",
          detail: publicProviderExceptionResponse(error, "unavailable").error,
        };
      }
      const evidence = availability.record({
        engineId: request.params.id,
        available: result.available,
        ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        source: "operator_probe",
        operationStartedAt,
      });
      if (evidence.available) {
        resolveOperationalNotification(`provider:${request.params.id}:unavailable`);
        notifyScheduler();
      } else {
        createOperationalNotification({
          dedupeKey: `provider:${request.params.id}:unavailable`,
          category: "provider",
          severity: "attention",
          title: `${registration.adapter.displayName} is unavailable`,
          body: providerUnavailableNotificationBody(evidence.detail, evidence.failureCategory),
          action: { kind: "open_settings", targetId: request.params.id },
        });
      }
      return engineDto(registration);
      })().finally(() => { if (rechecks.get(request.params.id) === operation) rechecks.delete(request.params.id); });
      rechecks.set(request.params.id, operation);
      return operation;
    },
  );

  app.get<{
    Params: { id: string; engineId: string };
    Querystring: { refresh?: string };
  }>("/api/projects/:id/engine-models/:engineId", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (projectDeletionInProgress(project.id)) {
      return reply.code(409).send({ error: "Project deletion is in progress" });
    }
    const registration = engines.get(request.params.engineId);
    if (!registration) return reply.code(404).send({ error: "unknown engine" });
    if (!registration.adapter.discoverModelCatalog) {
      return reply.code(404).send({ error: "this engine does not provide model discovery" });
    }
    return discoverModelCatalog(
      project,
      registration.adapter,
      request.query.refresh === "true" || request.query.refresh === "1",
    );
  });

  app.post<{
    Params: { id: string; engineId: string };
    Body: { modelId?: string };
  }>(
    "/api/projects/:id/engine-models/:engineId/validate",
    async (request, reply): Promise<EngineModelValidationDto | FastifyReply> => {
      const project = store.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(project.id)) {
        return reply.code(409).send({ error: "Project deletion is in progress" });
      }
      const registration = engines.get(request.params.engineId);
      if (!registration) return reply.code(404).send({ error: "unknown engine" });
      if (!registration.adapter.validateModel) {
        return reply.code(404).send({ error: "this engine does not provide model validation" });
      }
      const modelId = request.body?.modelId?.trim() ?? "";
      if (!modelId || modelId.length > 200) {
        return reply.code(400).send({
          error: "modelId must be a non-empty string of at most 200 characters",
        });
      }
      return validateModel(project, registration.adapter, modelId);
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { engineId?: string; model?: string; agentId?: string; refresh?: string };
  }>(
    "/api/projects/:id/engine-capabilities",
    async (request, reply): Promise<ProjectEngineCapabilitiesDto[] | FastifyReply> => {
      const project = store.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(project.id)) {
        return reply.code(409).send({ error: "Project deletion is in progress" });
      }
      const scopedAgent = request.query.agentId
        ? store.getAgent(request.query.agentId)
        : undefined;
      if (request.query.agentId && (!scopedAgent || scopedAgent.projectId !== project.id)) {
        return reply.code(404).send({ error: "agent not found in project" });
      }
      if (request.query.engineId && !engines.has(request.query.engineId)) {
        return reply.code(400).send({ error: "unknown engine" });
      }
      const forceRefresh = request.query.refresh === "true" || request.query.refresh === "1";
      const scopedEngineId = request.query.engineId
        ?? scopedAgent?.activeEngine;
      const registrations = scopedEngineId
        ? [engines.get(scopedEngineId)!]
        : [...engines.values()];
      return Promise.all(registrations.map(async ({ adapter }) => {
        const selectedModel = adapter.id === scopedEngineId
          ? request.query.model?.trim()
            || (
              scopedAgent?.activeEngine === adapter.id
                ? scopedAgent.model
                : undefined
            )
            || undefined
          : undefined;
        const snapshot = forceRefresh
          ? {
              capabilities: await discoverCapabilities(
                project.id,
                project.hostPath,
                adapter,
                selectedModel,
                true,
              ),
              discovered: true,
              refreshing: false,
            }
          : readCapabilities(
              project.id,
              project.hostPath,
              adapter,
              selectedModel,
            );
        const capabilities = snapshot.capabilities;
        return {
          engineId: adapter.id,
          discovered: snapshot.discovered,
          ...(snapshot.refreshing ? { refreshing: true } : {}),
          steering: capabilities.steering,
          persistentSessions: capabilities.persistentSessions,
          ...(capabilities.sessionId === undefined ? {} : { sessionId: capabilities.sessionId }),
          ...(capabilities.selectedModel === undefined ? {} : { selectedModel: capabilities.selectedModel }),
          ...(capabilities.model === undefined ? {} : { model: capabilities.model }),
          ...(capabilities.catalogVersion === undefined ? {} : { catalogVersion: capabilities.catalogVersion }),
          commands: capabilities.commands,
          mcpServers: capabilities.mcpServers,
          composerCapabilities: capabilities.composerCapabilities,
        };
      }));
    },
  );
}
