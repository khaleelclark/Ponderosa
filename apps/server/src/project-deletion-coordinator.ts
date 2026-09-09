import type {
  AgentDto,
  AgentHealthProjectionDto,
  CommunicationReconciliationReport,
} from "@ponderosa/core";
import type {
  AgentDeletionReceipt,
  AgentStore,
  ConversationDeletionReceipt,
  CoordinationV3Store,
  ProjectDeletionReceipt,
  WorkspaceStore,
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
import type { AgentWorkingCopyService } from "./agent-working-copy-service.js";
import { drainProjectConversationDeletions } from "./conversation-deletion-authority.js";
import type { DraftService } from "./routes/drafts.js";
import type { AssetStore } from "./assets.js";

type OperationalNotifications = ReturnType<typeof createOperationalNotifications>;

interface ProjectDeletionCoordinatorContext {
  store: AgentStore;
  reconcileManagedProjectFolders?(): Promise<void>;
  coordinationV3: CoordinationV3Store;
  engines: ReadonlyMap<string, EngineRegistration>;
  triggerSources: TriggerSourceService;
  activeRuns: Map<string, ActiveRun>;
  runtimeAuthorities: ReadonlyMap<string, AgentRuntimeAuthority>;
  engineCapabilityDiscoveryAuthorities: ReadonlySet<CapabilityDiscoveryAuthority>;
  engineModelCatalogDiscoveryAuthorities: ReadonlySet<ModelCatalogDiscoveryAuthority>;
  deletingProjectIds: Set<string>;
  deletingAgentIds: Set<string>;
  reconcilingAssetAgentIds: ReadonlySet<string>;
  agentAttachmentDeletionInProgress(agentId: string): boolean;
  agentCreationConversationLeases: ReadonlyMap<string, number>;
  conversationDeliveryLeases: ReadonlyMap<string, number>;
  agentDeliveryLeases: ReadonlyMap<string, number>;
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
  drainEngineCapabilityDiscoveries(projectId?: string, agentIds?: ReadonlySet<string>): Promise<void>;
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
  workingCopies: AgentWorkingCopyService;
  drafts: Pick<DraftService, "deleteSurface" | "fenceMutationGroup" | "releaseMutationGroup">;
  workspace: Pick<WorkspaceStore, "deleteDraft">;
  processConversationDeletionCleanup(
    receipt: ConversationDeletionReceipt,
  ): Promise<boolean>;
  processAgentDeletionCleanup(receipt: AgentDeletionReceipt): Promise<boolean>;
  assets: Pick<AssetStore, "purgeProject">;
}

export function finishProjectAssetAuthorityCleanup(
  store: Pick<AgentStore,
    "getProjectDeletionReceipt" | "markProjectDeletionAssetAuthorityCleanupComplete">,
  assets: Pick<AssetStore, "purgeProject">,
  projectId: string,
): void {
  const receipt = store.getProjectDeletionReceipt(projectId);
  if (!receipt) throw new Error("Project deletion receipt not found");
  if (receipt.assetAuthorityCleanupCompleted ||
      !receipt.storageCleanupCompleted || !receipt.draftCleanupCompleted) return;
  assets.purgeProject(projectId, receipt.draftSurfaceIds);
  store.markProjectDeletionAssetAuthorityCleanupComplete(projectId);
}

export async function drainProjectAgentDeletions(
  store: Pick<AgentStore,
    "listPendingAgentDeletionReceipts" | "finishAgentDeletionStorageCleanup" |
    "getAgentDeletionReceiptByPreviewHash" | "recordAgentDeletionCleanupError">,
  projectId: string,
  processAgentDeletionCleanup: (receipt: AgentDeletionReceipt) => Promise<boolean>,
): Promise<boolean> {
  const pending = () => store.listPendingAgentDeletionReceipts()
    .filter(receipt => receipt.projectId === projectId);
  for (const initial of pending()) {
    let receipt = initial;
    if (!receipt.storageCleanupCompleted) {
      try {
        store.finishAgentDeletionStorageCleanup(receipt);
      } catch (error) {
        store.recordAgentDeletionCleanupError(
          receipt.id,
          error instanceof Error ? error.message : "Agent storage cleanup failed",
        );
        continue;
      }
      receipt = store.getAgentDeletionReceiptByPreviewHash(receipt.previewHash) ?? receipt;
    }
    if (!receipt.serverCleanupCompleted) await processAgentDeletionCleanup(receipt);
  }
  return pending().length === 0;
}

export function registerProjectDeletionRoutes(
  app: FastifyInstance,
  context: ProjectDeletionCoordinatorContext,
): void {
  const {
    store,
    reconcileManagedProjectFolders = async () => {},
    coordinationV3,
    engines,
    triggerSources,
    activeRuns,
    runtimeAuthorities,
    engineCapabilityDiscoveryAuthorities,
    engineModelCatalogDiscoveryAuthorities,
    deletingProjectIds,
    deletingAgentIds,
    reconcilingAssetAgentIds,
    agentAttachmentDeletionInProgress,
    agentCreationConversationLeases,
    conversationDeliveryLeases,
    agentDeliveryLeases,
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
    workingCopies,
    drafts,
    workspace,
    processConversationDeletionCleanup,
    processAgentDeletionCleanup,
    assets,
  } = context;

  const ensureProjectDraftFence = async (projectId: string, draftSurfaceIds: string[]) => {
    await drafts.fenceMutationGroup(`project:${projectId}`, draftSurfaceIds);
  };
  const finishProjectDraftCleanup = async (receipt: ProjectDeletionReceipt): Promise<void> => {
    if (receipt.draftCleanupCompleted) return;
    await ensureProjectDraftFence(receipt.projectId, receipt.draftSurfaceIds);
    for (const draftId of receipt.draftSurfaceIds) {
      workspace.deleteDraft(draftId);
      await drafts.deleteSurface(draftId);
    }
    store.markProjectDeletionDraftCleanupComplete(receipt.projectId);
    drafts.releaseMutationGroup(`project:${receipt.projectId}`);
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/deletion-preview", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const agents = store.listAgents(project.id);
    const agentIds = new Set(agents.map(agent => agent.id));
    const activeAgents = agents
      .filter(agent => activeRuns.has(agent.id))
      .map(agent => ({ id: agent.id, title: agent.title }));
    const chats = store.listConversations(project.id).length;
    const automations = coordinationV3.listTriggerDefinitions()
      .filter(trigger => trigger.projectId === project.id).length;
    const managedFiles = store.getProjectArtifacts(project.id).length;
    return {
      projectId: project.id,
      chats,
      agents: agentIds.size,
      automations,
      managedFiles,
      activeAgents,
      projectBrowserActive: projectBrowserGrants.has(project.id),
      nonempty: chats + agentIds.size + automations + managedFiles > 0,
    };
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const previousReceipt = store.getProjectDeletionReceipt(request.params.id);
    if (previousReceipt) {
      try { reconcileCommittedProjectDeletion(previousReceipt.projectId); }
      catch (error) {
        logError({ err: error, projectId: previousReceipt.projectId }, "Project deletion workspace reconciliation retry failed");
      }
      if (!previousReceipt.draftCleanupCompleted) {
        try { await finishProjectDraftCleanup(previousReceipt); }
        catch (error) {
          try {
            store.recordProjectDeletionReceiptCleanupError(
              previousReceipt.projectId,
              error instanceof Error ? error.message : String(error),
            );
          } catch { /* the durable committed receipt remains authoritative */ }
        }
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
      try {
        finishProjectAssetAuthorityCleanup(store, assets, previousReceipt.projectId);
      } catch (error) {
        try {
          store.recordProjectDeletionReceiptCleanupError(
            previousReceipt.projectId,
            error instanceof Error ? error.message : String(error),
          );
        } catch { /* the durable committed receipt remains authoritative */ }
      }
      const refreshed = store.getProjectDeletionReceipt(previousReceipt.projectId)!;
      try {
        if (refreshed.storageCleanupCompleted && refreshed.draftCleanupCompleted &&
            refreshed.assetAuthorityCleanupCompleted) {
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
        cleanupPending: !refreshed.storageCleanupCompleted || !refreshed.draftCleanupCompleted ||
          !refreshed.assetAuthorityCleanupCompleted,
        replayed: true,
      };
    }
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (!await drainProjectConversationDeletions(
      store,
      project.id,
      processConversationDeletionCleanup,
    )) {
      return reply.code(409).send({
        error: "Wait for Chat deletion cleanup to finish before deleting this Project",
      });
    }
    if (!await drainProjectAgentDeletions(
      store,
      project.id,
      processAgentDeletionCleanup,
    )) {
      return reply.code(409).send({
        error: "Wait for Agent deletion cleanup to finish before deleting this Project",
      });
    }
    if (store.listConversations(project.id).some((conversation) =>
      (agentCreationConversationLeases.get(conversation.id) ?? 0) > 0
    )) {
      return reply.code(409).send({
        error: "Wait for Agent creation to finish before deleting this Project",
      });
    }
    if (store.listConversations(project.id).some((conversation) =>
      (conversationDeliveryLeases.get(conversation.id) ?? 0) > 0
    )) {
      return reply.code(409).send({
        error: "Wait for message delivery to finish before deleting this Project",
      });
    }
    const agents = store.listAgents(project.id, { includePendingCreation: true });
    if (agents.some((agent) => (agentDeliveryLeases.get(agent.id) ?? 0) > 0)) {
      return reply.code(409).send({ error: "Wait for Agent file activity to finish before deleting this Project" });
    }
    if (agents.some((agent) =>
      reconcilingAssetAgentIds.has(agent.id) || agentAttachmentDeletionInProgress(agent.id))) {
      return reply.code(409).send({ error: "Wait for asset maintenance to finish before deleting this Project" });
    }
    const quarantined = deletingProjectIds.has(project.id);
    if (projectDeletionInFlightIds.has(project.id) ||
        (!quarantined && agents.some((agent) => deletingAgentIds.has(agent.id)))) {
      return reply.code(409).send({ error: "Agent deletion is already in progress" });
    }
    const agentIds = new Set(agents.map((agent) => agent.id));
    let draftSurfaceIds: string[];
    try {
      // Persist fail-closed intent before exposing any in-memory quarantine or
      // beginning fallible browser/provider cleanup.
      draftSurfaceIds = store.markProjectDeletionPending(project.id);
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
      await ensureProjectDraftFence(project.id, draftSurfaceIds!);
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

      // Provider and command authorities are actively aborted above before we
      // wait for their working-folder leases. Quarantine prevents any new
      // mutation or use from entering while this final quiescence point forms.
      await workingCopies.awaitModeChanges(agentIds);
      await workingCopies.awaitUses(agentIds);

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

      // Managed Git copies live outside the canonical Project directory. They
      // must be removed while the Project row and Shared Git root still grant
      // cleanup authority. A failure leaves deletion quarantined and retryable.
      await workingCopies.cleanupProject(project);

      cancelAgentDecisions(agentIds);
      for (const agentId of agentIds) {
        subscribers.delete(agentId);
        scheduledSessionRollovers.delete(agentId);
      }
      contextCursors.deleteAgents(agentIds);
      if (store.listPendingConversationDeletionReceipts()
        .some(receipt => receipt.projectId === project.id)) {
        throw new Error("Project deletion cannot commit while Chat deletion cleanup is pending");
      }
      const receipt = store.commitProjectDeletion(project.id, (projectId) => coordinationV3.purgeProject(projectId));
      if (!receipt) throw new Error("Project deletion commit did not produce a receipt");
      communicationReconciliation.delete(project.id);
      dirtyCommunicationProjects.delete(project.id);
      deleted = true;
      try {
        await finishProjectDraftCleanup(receipt);
      } catch (error) {
        try {
          store.recordProjectDeletionReceiptCleanupError(
            receipt.projectId,
            error instanceof Error ? error.message : String(error),
          );
        } catch { /* the durable committed receipt remains authoritative */ }
      }
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
      try {
        finishProjectAssetAuthorityCleanup(store, assets, receipt.projectId);
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
      try { await reconcileManagedProjectFolders(); }
      catch (error) {
        logError({ err: error, projectId: project.id }, "Managed Project folder reconciliation failed");
      }
      for (const { adapter } of engines.values()) {
        try { invalidateEngineCapabilities(project.id, adapter.id); }
        catch { /* the Project no longer owns provider capability state */ }
      }
      const refreshed = store.getProjectDeletionReceipt(project.id)!;
      try {
        if (refreshed.storageCleanupCompleted && refreshed.draftCleanupCompleted &&
            refreshed.assetAuthorityCleanupCompleted) {
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
        cleanupPending: !refreshed.storageCleanupCompleted || !refreshed.draftCleanupCompleted ||
          !refreshed.assetAuthorityCleanupCompleted,
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
