import type {
  AgentDto,
  AgentHealthProjectionDto,
  CommunicationReconciliationReport,
} from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { BrowserSessionManager } from "./browser-session-manager.js";
import type { BrowserProfileAuthority } from "./browser-profile-authority.js";
import type { ContextCursorStore } from "./context-cursors.js";
import type { TriggerSourceService } from "./trigger-service.js";
import type {
  ActiveRun,
  AgentMessageCapability,
  AgentRuntimeAuthority,
  CapabilityDiscoveryAuthority,
  EngineRegistration,
  ModelCatalogDiscoveryAuthority,
  Subscriber,
} from "./app-contracts.js";
import type { createOperationalNotifications } from "./operational-notifications.js";
import type { ProviderProcessAuthority } from "./provider-process-authority.js";

type OperationalNotifications = ReturnType<typeof createOperationalNotifications>;

interface ProjectDeletionCoordinatorContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  engines: ReadonlyMap<string, EngineRegistration>;
  triggerSources: TriggerSourceService;
  activeRuns: Map<string, ActiveRun>;
  runtimeAuthorities: ReadonlyMap<string, AgentRuntimeAuthority>;
  engineCapabilityDiscoveryAuthorities: ReadonlySet<CapabilityDiscoveryAuthority>;
  engineModelCatalogDiscoveryAuthorities: ReadonlySet<ModelCatalogDiscoveryAuthority>;
  deletingProjectIds: Set<string>;
  deletingAgentIds: Set<string>;
  projectDeletionInFlightIds: Set<string>;
  projectBrowserGrants: Map<string, { agentId: string; runId: string }>;
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  browserProfiles: BrowserProfileAuthority;
  agentMessageCapabilities: Map<string, AgentMessageCapability>;
  subscribers: Map<string, Set<Subscriber>>;
  scheduledSessionRollovers: Map<string, string>;
  contextCursors: ContextCursorStore;
  communicationReconciliation: Map<
    string,
    { state: "pending" } | { state: "verified"; report: CommunicationReconciliationReport }
  >;
  dirtyCommunicationProjects: Set<string>;
  clearRunLeaseTimer(run: ActiveRun): void;
  clearRunLivenessTimer(run: ActiveRun): void;
  closeLinkPreviewsForAgent(agentId: string, reason: string): void;
  drainProviderRuntimeAuthority(reason: string, agentIds?: ReadonlySet<string>): Promise<void>;
  drainEngineCapabilityDiscoveries(projectId?: string): Promise<void>;
  drainEngineModelCatalogDiscoveries(projectId?: string): Promise<void>;
  awaitProjectDeletionBarrier(operation: Promise<unknown>, label: string): Promise<void>;
  cancelAgentDecisions(agentIds: Iterable<string>): void;
  invalidateEngineCapabilities(projectId: string, engineId: string): void;
  reconcileCommittedProjectDeletion(projectId: string): unknown;
  createOperationalNotification: OperationalNotifications["createOperationalNotification"];
  resolveOperationalNotification: OperationalNotifications["resolveOperationalNotification"];
  agentHealth(
    scope: AgentHealthProjectionDto["scope"],
    agents: AgentDto[],
  ): AgentHealthProjectionDto;
  logError(meta: Record<string, unknown>, message: string): void;
  providerProcessAuthority: ProviderProcessAuthority;
}

export function registerProjectDeletionRoutes(
  app: FastifyInstance,
  context: ProjectDeletionCoordinatorContext,
): void {
  const {
    store,
    coordinationV3,
    engines,
    triggerSources,
    activeRuns,
    runtimeAuthorities,
    engineCapabilityDiscoveryAuthorities,
    engineModelCatalogDiscoveryAuthorities,
    deletingProjectIds,
    deletingAgentIds,
    projectDeletionInFlightIds,
    projectBrowserGrants,
    browserSessions,
    projectBrowserSessions,
    browserProfiles,
    agentMessageCapabilities,
    subscribers,
    scheduledSessionRollovers,
    contextCursors,
    communicationReconciliation,
    dirtyCommunicationProjects,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    closeLinkPreviewsForAgent,
    drainProviderRuntimeAuthority,
    drainEngineCapabilityDiscoveries,
    drainEngineModelCatalogDiscoveries,
    awaitProjectDeletionBarrier,
    cancelAgentDecisions,
    invalidateEngineCapabilities,
    reconcileCommittedProjectDeletion,
    createOperationalNotification,
    resolveOperationalNotification,
    agentHealth,
    logError,
    providerProcessAuthority,
  } = context;

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const previousReceipt = store.getProjectDeletionReceipt(request.params.id);
    if (previousReceipt) {
      try { reconcileCommittedProjectDeletion(previousReceipt.projectId); }
      catch (error) {
        logError({ err: error, projectId: previousReceipt.projectId }, "Project deletion workspace reconciliation retry failed");
      }
      if (!previousReceipt.storageCleanupCompleted) {
        try {
          store.finishProjectDeletionStorageCleanup(previousReceipt);
        } catch (error) {
          try {
            store.recordProjectDeletionReceiptCleanupError(
              previousReceipt.projectId,
              error instanceof Error ? error.message : String(error),
            );
          } catch { /* the durable committed receipt remains authoritative */ }
        }
      }
      const refreshed = store.getProjectDeletionReceipt(previousReceipt.projectId)!;
      try {
        if (refreshed.storageCleanupCompleted) {
          resolveOperationalNotification(`project-deletion:${refreshed.projectId}`);
        } else {
          createOperationalNotification({
            dedupeKey: `project-deletion:${refreshed.projectId}`,
            category: "system",
            severity: "attention",
            title: "Project deletion cleanup needs attention",
            body: `The Project was deleted, but filesystem cleanup is still retrying. ${refreshed.lastError ?? "Retry deletion to continue cleanup."}`.slice(0, 1_000),
          });
        }
      } catch { /* the committed receipt remains the cleanup authority */ }
      return {
        deleted: true,
        deletionReceiptId: refreshed.projectId,
        cleanupPending: !refreshed.storageCleanupCompleted,
        replayed: true,
      };
    }
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const agents = store.listAgents(project.id);
    const quarantined = deletingProjectIds.has(project.id);
    if (projectDeletionInFlightIds.has(project.id) ||
        (!quarantined && agents.some((agent) => deletingAgentIds.has(agent.id)))) {
      return reply.code(409).send({ error: "Agent deletion is already in progress" });
    }
    const agentIds = new Set(agents.map((agent) => agent.id));
    try {
      // Persist fail-closed intent before exposing any in-memory quarantine or
      // beginning fallible browser/provider cleanup.
      store.markProjectDeletionPending(project.id);
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Project deletion quarantine could not be persisted",
        cleanupPending: false,
        quarantined: false,
        retryable: true,
      });
    }
    projectDeletionInFlightIds.add(project.id);
    deletingProjectIds.add(project.id);
    for (const agentId of agentIds) deletingAgentIds.add(agentId);
    let deleted = false;
    try {
      // Quarantine synchronously before any browser/provider await. From this
      // point no Agent in the Project can retain or reacquire scheduler/tool
      // authority, even when a browser close hangs or rejects.
      projectBrowserGrants.delete(project.id);
      coordinationV3.prepareProjectDeletion(project.id);
      void triggerSources.refresh().catch((error) => {
        logError({ err: error, projectId: project.id }, "Project Automation source quarantine cleanup failed");
      });
      for (const agentId of agentIds) {
        closeLinkPreviewsForAgent(agentId, "project deleted");
        const active = activeRuns.get(agentId);
        if (active) {
          clearRunLeaseTimer(active);
          clearRunLivenessTimer(active);
          agentMessageCapabilities.delete(active.messageCapability);
          active.controller.abort();
        }
      }
      // Drain by immutable Project identity rather than the current active-Run
      // map. This includes ready, opening, and failed/closing browser handles.
      const browserClosures = [
        awaitProjectDeletionBarrier(browserSessions.closeProject(project.id, "project_deleted"), "Run browser cleanup"),
        awaitProjectDeletionBarrier(projectBrowserSessions.closeProject(project.id, "project_deleted"), "Project browser cleanup"),
      ];
      const barriers = await Promise.allSettled([
        ...browserClosures,
        drainProviderRuntimeAuthority("Project deletion", agentIds),
        providerProcessAuthority.terminateProject(project.id, "Project deletion"),
        drainEngineCapabilityDiscoveries(project.id),
        drainEngineModelCatalogDiscoveries(project.id),
      ]);
      const failures = barriers.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Project deletion is waiting for provider runtime cleanup");

      // Re-scan browser authority after provider drain. Admission is now
      // quarantined, so reaching this fixed point proves an opening admitted
      // immediately before deletion cannot survive the irreversible commit.
      await Promise.all([
        awaitProjectDeletionBarrier(
          browserSessions.closeProject(project.id, "project_deleted_final_barrier"),
          "Run browser final cleanup",
        ),
        awaitProjectDeletionBarrier(
          projectBrowserSessions.closeProject(project.id, "project_deleted_final_barrier"),
          "Project browser final cleanup",
        ),
      ]);

      // The drain rescans after every late open/completion. Keep this explicit
      // final assertion beside the irreversible storage boundary.
      if ([...activeRuns.keys()].some((agentId) => agentIds.has(agentId)) ||
        [...runtimeAuthorities].some(([agentId, authority]) => agentIds.has(agentId) &&
          Boolean(authority.opening || authority.reusable || authority.closing || authority.oneShots.size)) ||
        [...engineCapabilityDiscoveryAuthorities].some((authority) => authority.projectId === project.id)) {
        throw new Error("Project deletion provider authority changed after draining");
      }
      if ([...engineModelCatalogDiscoveryAuthorities].some((authority) => authority.projectId === project.id)) {
        throw new Error("Project deletion provider authority changed after draining");
      }
      browserProfiles.deleteProject(project.id);

      cancelAgentDecisions(agentIds);
      for (const agentId of agentIds) {
        subscribers.delete(agentId);
        scheduledSessionRollovers.delete(agentId);
      }
      contextCursors.deleteAgents(agentIds);
      const receipt = store.commitProjectDeletion(project.id, (projectId) => coordinationV3.purgeProject(projectId));
      if (!receipt) throw new Error("Project deletion commit did not produce a receipt");
      communicationReconciliation.delete(project.id);
      dirtyCommunicationProjects.delete(project.id);
      deleted = true;
      try {
        store.finishProjectDeletionStorageCleanup(receipt);
      } catch (error) {
        try {
          store.recordProjectDeletionReceiptCleanupError(
            receipt.projectId,
            error instanceof Error ? error.message : String(error),
          );
        } catch { /* the durable committed receipt remains authoritative */ }
      }
      // Publication is retryable from the durable receipt. A failed append is
      // also repaired before readiness on the next boot.
      try { reconcileCommittedProjectDeletion(project.id); }
      catch (error) {
        logError({ err: error, projectId: project.id }, "Project deletion workspace reconciliation failed");
      }
      for (const { adapter } of engines.values()) {
        try { invalidateEngineCapabilities(project.id, adapter.id); }
        catch { /* the Project no longer owns provider capability state */ }
      }
      const refreshed = store.getProjectDeletionReceipt(project.id)!;
      try {
        if (refreshed.storageCleanupCompleted) {
          resolveOperationalNotification(`project-deletion:${project.id}`);
        } else {
          createOperationalNotification({
            dedupeKey: `project-deletion:${project.id}`,
            category: "system",
            severity: "attention",
            title: "Project deletion cleanup needs attention",
            body: `The Project was deleted, but filesystem cleanup is still retrying. ${refreshed.lastError ?? "Retry deletion to continue cleanup."}`.slice(0, 1_000),
          });
        }
      } catch { /* the committed receipt remains the cleanup authority */ }
      return {
        deleted: true,
        deletionReceiptId: refreshed.projectId,
        cleanupPending: !refreshed.storageCleanupCompleted,
      };
    } catch (error) {
      try { store.recordProjectDeletionCleanupError(project.id, error instanceof Error ? error.message : String(error)); }
      catch { /* the existing durable quarantine remains fail closed */ }
      try {
        createOperationalNotification({
          dedupeKey: `project-deletion:${project.id}`,
          category: "system",
          severity: "urgent",
          title: "Project deletion needs attention",
          body: `Ponderosa quarantined ${project.label} and revoked Agent authority, but cleanup has not completed. Retry deletion after the cleanup problem is resolved. ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
          projectId: project.id,
        });
      } catch { /* in-memory quarantine remains fail closed */ }
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Project deletion is waiting for provider runtime cleanup",
        cleanupPending: true,
        quarantined: true,
        retryable: true,
      });
    } finally {
      projectDeletionInFlightIds.delete(project.id);
      if (deleted) {
        deletingProjectIds.delete(project.id);
        for (const agentId of agentIds) deletingAgentIds.delete(agentId);
      }
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/communication-reconciliation", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    const report = store.reconcileCommunicationEvents(request.params.id);
    communicationReconciliation.set(request.params.id, { state: "verified", report });
    dirtyCommunicationProjects.delete(request.params.id);
    if (!report.ok) reply.code(409);
    return report;
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/agent-health", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    return agentHealth(
      { type: "project", id: request.params.id },
      store.listAgents(request.params.id),
    );
  });
}
