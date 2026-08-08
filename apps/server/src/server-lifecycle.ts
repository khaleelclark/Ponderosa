import WebSocket from "ws";
import type {
  AgentDeletionReceipt,
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import { repairManagedArtifactContent } from "@ponderosa/agents";
import type { ReadinessCheckDto } from "@ponderosa/core";
import type { AssetStore } from "./assets.js";
import {
  type ActiveRun,
  type AgentMessageCapability,
  type AgentRuntimeAuthority,
  type CreateServerOptions,
  type PonderosaServer,
} from "./app-contracts.js";
import type { BrowserSessionManager } from "./browser-session-manager.js";
import type { CoordinationV3Scheduler } from "./coordination-v3-scheduler.js";
import type { createCommunicationArtifactAuthority } from "./communication-artifacts.js";
import type { createCommunicationJournal } from "./communication-journal.js";
import type { createEngineControlPlane } from "./engine-control-plane.js";
import type { createLinkPreviewService } from "./link-preview-service.js";
import type { createOperationalNotifications } from "./operational-notifications.js";
import type { ProviderUsageCache } from "./provider-usage-cache.js";
import type { createRuntimeAuthority } from "./runtime-authority.js";
import type { createServerReadModels } from "./server-read-models.js";
import type { TriggerSourceService } from "./trigger-service.js";
import type { WebPushDeliveryManager } from "./web-push-delivery.js";
import type { createBrowserAuthority } from "./browser-authority.js";
import type { ProviderProcessAuthority } from "./provider-process-authority.js";

type ArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;
type CommunicationJournal = ReturnType<typeof createCommunicationJournal>;
type EngineControlPlane = ReturnType<typeof createEngineControlPlane>;
type LinkPreviewService = ReturnType<typeof createLinkPreviewService>;
type OperationalNotifications = ReturnType<typeof createOperationalNotifications>;
type RuntimeAuthority = ReturnType<typeof createRuntimeAuthority>;
type ReadModels = ReturnType<typeof createServerReadModels>;
type BrowserAuthority = ReturnType<typeof createBrowserAuthority>;

type ServerLifecycleContext =
  Pick<ArtifactAuthority, "projectCommunicationArtifact" | "requestArtifactAccess"> &
  Pick<EngineControlPlane,
    "drainEngineCapabilityDiscoveries" | "drainEngineModelCatalogDiscoveries" |
    "engineCapabilityDiscoveries" | "engineCapabilityDiscoveryAuthorities" |
    "engineModelCatalogDiscoveries" | "engineModelCatalogDiscoveryAuthorities"> &
  Pick<LinkPreviewService,
    "closeLinkPreviewPair" | "closeLinkPreviewRegistration" |
    "linkPreviewCloseGraceMs" | "linkPreviewHeartbeatMs" |
    "linkPreviewMaxConnectionLifetimeMs" | "linkPreviewMaxIdleMs" |
    "linkPreviewOwned" | "linkPreviews" | "linkPreviewUpgrade" |
    "linkPreviewWss"> &
  Pick<OperationalNotifications,
    "createOperationalNotification" | "reconcileProjectDeletionOperationalNotifications" |
    "reconcileTriggerOperationalNotifications" | "resolveOperationalNotification"> &
  Pick<RuntimeAuthority, "drainProviderRuntimeAuthority"> &
  Pick<ReadModels, "ensureDecisionResponseActivation"> &
  Pick<CommunicationJournal,
    "refreshCommunicationReconciliation" | "stopCommunicationReconciliation"> &
  Pick<BrowserAuthority, "closeRunBrowser"> & {
    opts: CreateServerOptions;
    store: AgentStore;
    assets: AssetStore;
    coordinationV3: CoordinationV3Store;
    workspace: WorkspaceStore;
    artifactFilesystem: ReadinessCheckDto;
    processContainment: ReadinessCheckDto;
    coordinationV3WorkerId: string;
    activeRuns: Map<string, ActiveRun>;
    runtimeAuthorities: Map<string, AgentRuntimeAuthority>;
    agentMessageCapabilities: Map<string, AgentMessageCapability>;
    projectBrowserGrants: Map<string, unknown>;
    browserSessions: BrowserSessionManager;
    projectBrowserSessions: BrowserSessionManager;
    providerUsage: ProviderUsageCache;
    webPushDelivery: WebPushDeliveryManager | undefined;
    coordinationV3Scheduler: CoordinationV3Scheduler;
    triggerSources: TriggerSourceService;
    processAgentDeletionCleanup(receipt: AgentDeletionReceipt): Promise<boolean>;
    reconcileRuntimeCommunicationProjections(filter?: {
      projectId?: string;
      communicationEventId?: string;
    }, options?: {
      yieldEvery?: number;
      shouldContinue?(): boolean;
    }): Promise<number>;
    clearRunLeaseTimer(run: ActiveRun): void;
    clearRunLivenessTimer(run: ActiveRun): void;
    isClosed(): boolean;
    setClosed(): void;
    providerProcessAuthority: ProviderProcessAuthority;
  };

export function registerServerLifecycle(
  app: PonderosaServer,
  context: ServerLifecycleContext,
): void {
  const {
    opts,
    store,
    assets,
    coordinationV3,
    workspace,
    artifactFilesystem,
    processContainment,
    coordinationV3WorkerId,
    activeRuns,
    runtimeAuthorities,
    agentMessageCapabilities,
    projectBrowserGrants,
    browserSessions,
    projectBrowserSessions,
    providerUsage,
    webPushDelivery,
    coordinationV3Scheduler,
    triggerSources,
    processAgentDeletionCleanup,
    reconcileRuntimeCommunicationProjections,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    isClosed,
    setClosed,
    projectCommunicationArtifact,
    requestArtifactAccess,
    drainEngineCapabilityDiscoveries,
    drainEngineModelCatalogDiscoveries,
    engineCapabilityDiscoveries,
    engineCapabilityDiscoveryAuthorities,
    engineModelCatalogDiscoveries,
    engineModelCatalogDiscoveryAuthorities,
    closeLinkPreviewPair,
    closeLinkPreviewRegistration,
    linkPreviewCloseGraceMs,
    linkPreviewHeartbeatMs,
    linkPreviewMaxConnectionLifetimeMs,
    linkPreviewMaxIdleMs,
    linkPreviewOwned,
    linkPreviews,
    linkPreviewUpgrade,
    linkPreviewWss,
    createOperationalNotification,
    reconcileProjectDeletionOperationalNotifications,
    reconcileTriggerOperationalNotifications,
    resolveOperationalNotification,
    drainProviderRuntimeAuthority,
    ensureDecisionResponseActivation,
    refreshCommunicationReconciliation,
    stopCommunicationReconciliation,
    closeRunBrowser,
    providerProcessAuthority,
  } = context;
  let assetSweep: NodeJS.Timeout | undefined;
  let agentDeletionCleanupSweep: NodeJS.Timeout | undefined;
  let agentDeletionCleanupDraining = false;
  let linkPreviewSweep: NodeJS.Timeout | undefined;
  let startupProjectionRecoveryImmediate: NodeJS.Immediate | undefined;
  let startupProjectionRecovery: Promise<void> | undefined;

  const scheduleStartupProjectionRecovery = (): void => {
    startupProjectionRecoveryImmediate = setImmediate(() => {
      startupProjectionRecoveryImmediate = undefined;
      if (isClosed()) return;
      startupProjectionRecovery = reconcileRuntimeCommunicationProjections(undefined, {
        yieldEvery: 1,
        shouldContinue: () => !isClosed(),
      }).then((repaired) => {
        if (!isClosed()) {
          app.log.info({ repaired }, "runtime communication projection startup recovery completed");
        }
      }).catch((error) => {
        if (!isClosed()) {
          app.log.error({ err: error }, "runtime communication projection startup recovery failed");
        }
      }).finally(() => {
        startupProjectionRecovery = undefined;
      });
    });
    startupProjectionRecoveryImmediate.unref();
  };

  const drainAgentDeletionCleanup = async (): Promise<void> => {
    if (agentDeletionCleanupDraining || isClosed()) return;
    agentDeletionCleanupDraining = true;
    try {
      for (const initial of store.listPendingAgentDeletionReceipts()) {
        if (isClosed()) break;
        let receipt = initial;
        if (!receipt.storageCleanupCompleted) {
          try { store.finishAgentDeletionStorageCleanup(receipt); }
          catch (error) {
            store.recordAgentDeletionCleanupError(receipt.id, error instanceof Error ? error.message : "storage cleanup failed");
          }
          receipt = store.getAgentDeletionReceiptByPreviewHash(receipt.previewHash)!;
        }
        if (!receipt.serverCleanupCompleted) await processAgentDeletionCleanup(receipt);
      }
    } catch (error) {
      if (!isClosed()) app.log.error({ err: error }, "Agent deletion cleanup retry failed");
    } finally {
      agentDeletionCleanupDraining = false;
    }
  };
  app.addHook("onReady", async () => {
    const lifecycleStartedAt = performance.now();
    let lifecyclePhaseStartedAt = lifecycleStartedAt;
    const lifecyclePhases: Record<string, number> = {};
    const completeLifecyclePhase = (name: string): void => {
      const now = performance.now();
      lifecyclePhases[name] = Math.round((now - lifecyclePhaseStartedAt) * 10) / 10;
      lifecyclePhaseStartedAt = now;
    };
    const orphanGraceBoundary = Date.now() - 60 * 60 * 1_000;
    const recoveredProviderProcesses = await providerProcessAuthority.recoverPreviousWorkers();
    if (recoveredProviderProcesses > 0) {
      app.log.warn({ recoveredProviderProcesses }, "terminated provider process groups recovered from a previous daemon boot");
    }
    completeLifecyclePhase("provider_process_recovery");
    const runtimeArtifacts = coordinationV3.runtimeArtifacts();
    if (artifactFilesystem.ok) {
      resolveOperationalNotification("startup:artifact-filesystem-capability");
      const recoveredAssociations = await assets.recoverRuntimeCommunicationAssociations((communicationId, projectId) =>
        coordinationV3.runtimeCommunication(communicationId)?.projectId === projectId);
      if (recoveredAssociations.unavailable) {
        app.log.error({ recovery: recoveredAssociations }, "runtime Communication attachment recovery found unavailable immutable content");
      }
      for (const project of store.listProjects()) {
        const referenced = new Set([
          ...store.getProjectArtifacts(project.id).map((artifact) => artifact.id),
          ...runtimeArtifacts.filter((artifact) => artifact.projectId === project.id).map((artifact) => artifact.id),
        ]);
        for (const removed of repairManagedArtifactContent(
          opts.dataDir,
          project.id,
          referenced,
          orphanGraceBoundary,
        )) {
          assets.removeRuntimeArtifactReservation(project.id, removed);
        }
      }
      // Historical projection repair is idempotent and exact live retries
      // reconcile their own Communication before reporting success. Run the
      // full backlog after readiness so a large ledger cannot hold the listener
      // closed, and yield between bounded batches to preserve the event loop.
      scheduleStartupProjectionRecovery();
      for (const artifact of runtimeArtifacts.filter((candidate) => candidate.ownerKind === "request_update")) {
        const request = coordinationV3.requestForUpdate(artifact.ownerId);
        if (!request || !assets.authoritativeRuntimeArtifact(artifact.projectId, artifact)) continue;
        projectCommunicationArtifact(
          artifact.projectId,
          artifact.originAgentId ?? "local-operator",
          { ...artifact, createdAt: artifact.createdAt, mediaType: "text/markdown" },
          requestArtifactAccess(artifact.ownerId, request),
        );
      }
    } else {
      createOperationalNotification({
        dedupeKey: "startup:artifact-filesystem-capability",
        category: "system",
        severity: "urgent",
        title: "Artifact filesystem is incompatible",
        body: artifactFilesystem.detail,
      });
    }
    completeLifecyclePhase("artifact_authority");
    if (processContainment.ok) {
      resolveOperationalNotification("startup:process-containment-capability");
    } else {
      createOperationalNotification({
        dedupeKey: "startup:process-containment-capability",
        category: "system",
        severity: "urgent",
        title: "Process containment is incompatible",
        body: processContainment.detail,
      });
    }
    for (const decision of workspace.listDecisions({ status: "pending" })) {
      if (!decision.blocking || !(decision.continuationRequestIds?.length)) continue;
      coordinationV3.suspendQuestionsForDecision({
        runId: decision.coordinationRunId ?? decision.runId,
        agentId: decision.agentId,
        decisionId: decision.id,
        requestIds: decision.continuationRequestIds,
        strict: false,
      });
    }
    for (const decision of workspace.listDecisions({ status: "resolved" })) {
      if (decision.continuationRequestIds?.length) ensureDecisionResponseActivation(decision);
    }
    coordinationV3.recoverOrphanedRuns(coordinationV3WorkerId);
    for (const rollover of coordinationV3.cancelledContextRolloverReplacements()) {
      if (
        rollover.replacementSessionId &&
        store.resumeSessionId(rollover.agentId) === rollover.replacementSessionId
      ) {
        store.clearResumeSession(rollover.agentId, "explicit_compaction");
      }
      createOperationalNotification({
        dedupeKey: `context-rollover:${rollover.id}:confirmation-missing`,
        category: "coordination",
        severity: "attention",
        title: "Context refresh was cancelled",
        body: "The replacement Run was cancelled before refreshed context could be confirmed. Its bounded handoff is reserved for one authorized Retry Assignment and will not be used by unrelated work.",
        projectId: rollover.projectId,
        conversationId: rollover.conversationId,
        agentId: rollover.agentId,
        action: { kind: "open_agent", targetId: rollover.agentId },
      });
    }
    for (const initial of coordinationV3.activeContextRollovers()) {
      try {
        let rollover = initial;
        if (rollover.state === "requested") {
          const handoff = store.continuationHandoffForContextRollover(
            rollover.agentId,
            rollover.id,
          );
          if (!handoff) {
            coordinationV3.failContextRollover(
              rollover.id,
              "outcome_unknown",
              "server restarted before the provider committed a bounded rollover handoff",
            );
            createOperationalNotification({
              dedupeKey: `context-rollover:${rollover.id}:outcome-unknown`,
              category: "coordination",
              severity: "attention",
              title: "Context refresh needs review",
              body: "The server restarted before the Agent committed its continuation handoff. Existing scheduler recovery remains authoritative.",
              projectId: rollover.projectId,
              conversationId: rollover.conversationId,
            });
            continue;
          }
          rollover = coordinationV3.commitContextRolloverHandoff(rollover.id, handoff.id);
        }
        if (rollover.state === "handoff_committed") {
          rollover = coordinationV3.beginContextRolloverRetirement(rollover.id);
        }
        if (rollover.state === "session_retiring") {
          store.clearResumeSession(rollover.agentId, "explicit_compaction");
          rollover = coordinationV3.prepareContextRolloverContinuation({
            id: rollover.id,
          });
        }
        if (rollover.state === "continuation_ready" && rollover.replacementSessionId) {
          store.clearResumeSession(rollover.agentId, "explicit_compaction");
          coordinationV3.failContextRollover(
            rollover.id,
            "outcome_unknown",
            "server restarted after the replacement session was recorded but before low-water context confirmation",
          );
          createOperationalNotification({
            dedupeKey: `context-rollover:${rollover.id}:confirmation-missing`,
            category: "coordination",
            severity: "attention",
            title: "Context refresh needs review",
            body: "The replacement provider session ended with the server before safe context headroom was confirmed. Its exact bounded handoff remains recorded; review the Agent's work before retrying the original assignment.",
            projectId: rollover.projectId,
            conversationId: rollover.conversationId,
            agentId: rollover.agentId,
            action: { kind: "open_agent", targetId: rollover.agentId },
          });
        }
      } catch (error) {
        coordinationV3.failContextRollover(
          initial.id,
          "outcome_unknown",
          error instanceof Error ? error.message : String(error),
        );
        createOperationalNotification({
          dedupeKey: `context-rollover:${initial.id}:recovery-failed`,
          category: "coordination",
          severity: "attention",
          title: "Context refresh recovery failed",
          body: error instanceof Error ? error.message : String(error),
          projectId: initial.projectId,
          conversationId: initial.conversationId,
        });
      }
    }
    completeLifecyclePhase("runtime_recovery");
    coordinationV3.reconcileUnavailableActivationRecipients();
    coordinationV3.expireDue();
    if (!artifactFilesystem.ok || !processContainment.ok) await coordinationV3Scheduler.pauseLeasing();
    coordinationV3Scheduler.start();
    await triggerSources.start();
    completeLifecyclePhase("scheduler_and_triggers");
    reconcileTriggerOperationalNotifications();
    reconcileProjectDeletionOperationalNotifications();
    await drainAgentDeletionCleanup();
    completeLifecyclePhase("operational_recovery");
    agentDeletionCleanupSweep = setInterval(() => { void drainAgentDeletionCleanup(); }, 30_000);
    agentDeletionCleanupSweep.unref();
    webPushDelivery?.start();
    const reconcileAssets = async () => {
      let processedAgents = 0;
      for (const project of store.listProjects()) {
        for (const agent of store.listAgents(project.id)) {
          const associated = new Set(store.getMessages(agent.id).flatMap((message) => message.attachments?.map((item) => item.id) ?? []));
          await assets.reconcile(project.id, agent.id, associated);
          processedAgents += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (isClosed()) return;
        }
      }
    };
    // Projection recovery above is authoritative. Orphan asset cleanup remains
    // periodic maintenance so it cannot delay startup or monopolize ordinary
    // requests immediately after the server begins accepting traffic.
    assetSweep = setInterval(() => { if (!isClosed()) void reconcileAssets(); }, 60 * 60 * 1000);
    assetSweep.unref();
    linkPreviewSweep = setInterval(() => {
      const now = Date.now();
      for (const [id, registration] of linkPreviews) {
        if (registration.expiresAt <= now || !linkPreviewOwned(registration)) {
          closeLinkPreviewRegistration(id, 1008, "preview ownership expired");
          continue;
        }
        for (const pair of registration.connections) {
          if (now - pair.openedAt >= linkPreviewMaxConnectionLifetimeMs || now - pair.lastActivityAt >= linkPreviewMaxIdleMs) {
            registration.connections.delete(pair);
            closeLinkPreviewPair(pair, 1001, "preview connection expired");
            continue;
          }
          const clientDead = pair.client.readyState === WebSocket.OPEN && !pair.clientAlive;
          const upstreamDead = pair.upstream.readyState === WebSocket.OPEN && !pair.upstreamAlive;
          if (clientDead || upstreamDead) {
            registration.connections.delete(pair);
            pair.client.terminate();
            pair.upstream.terminate();
            continue;
          }
          if (pair.client.readyState === WebSocket.OPEN) {
            pair.clientAlive = false;
            pair.client.ping();
          }
          if (pair.upstream.readyState === WebSocket.OPEN) {
            pair.upstreamAlive = false;
            pair.upstream.ping();
          }
        }
      }
    }, linkPreviewHeartbeatMs);
    linkPreviewSweep.unref();
    completeLifecyclePhase("maintenance_scheduling");
    app.log.info({
      phases: lifecyclePhases,
      totalMs: Math.round((performance.now() - lifecycleStartedAt) * 10) / 10,
    }, "server lifecycle readiness completed");
  });

  app.addHook("preClose", async () => {
    app.prepareForShutdown();
    app.server.off("upgrade", linkPreviewUpgrade);
    if (linkPreviewSweep) clearInterval(linkPreviewSweep);
    const shutdownPairs = [...linkPreviews.values()].flatMap((registration) => [...registration.connections]);
    for (const id of [...linkPreviews.keys()]) closeLinkPreviewRegistration(id, 1001, "Ponderosa server shutting down");
    if (shutdownPairs.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, linkPreviewCloseGraceMs));
      for (const pair of shutdownPairs) {
        if (pair.client.readyState !== WebSocket.CLOSED) pair.client.terminate();
        if (pair.upstream.readyState !== WebSocket.CLOSED) pair.upstream.terminate();
      }
    }
    linkPreviewWss.close();
    app.server.closeAllConnections();
  });

  let providerRuntimeShutdownFinalized = false;
  let shutdownBackgroundCleanupSucceeded = false;
  let shutdownStorageClosed = false;
  const closeShutdownStorageIfReady = (): void => {
    if (!providerRuntimeShutdownFinalized || !shutdownBackgroundCleanupSucceeded || shutdownStorageClosed) return;
    assets.close();
    store.close();
    shutdownStorageClosed = true;
  };
  const finalizeProviderRuntimeShutdown = async (): Promise<void> => {
    if (!providerRuntimeShutdownFinalized) {
      const results = await Promise.allSettled([
        drainProviderRuntimeAuthority("server_shutdown"),
        drainEngineCapabilityDiscoveries(),
        drainEngineModelCatalogDiscoveries(),
        providerUsage.shutdown(),
      ]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Provider runtime authority shutdown did not complete");
      runtimeAuthorities.clear();
      engineCapabilityDiscoveryAuthorities.clear();
      engineCapabilityDiscoveries.clear();
      engineModelCatalogDiscoveryAuthorities.clear();
      engineModelCatalogDiscoveries.clear();
      activeRuns.clear();
      providerRuntimeShutdownFinalized = true;
    }
    closeShutdownStorageIfReady();
  };
  app.retryProviderRuntimeShutdown = finalizeProviderRuntimeShutdown;

  const boundedBackgroundShutdown = async (label: string, operation: () => void | Promise<void>): Promise<void> => {
    const timeoutMs = opts.shutdownFaults?.backgroundCleanupTimeoutMs ?? 5_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation).then(() => "completed" as const),
        timeout,
      ]);
      if (result === "timeout") {
        app.log.warn({ cleanup: label, timeoutMs }, "Non-authority shutdown cleanup exceeded its deadline; process exit will release it");
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  app.addHook("onClose", async () => {
    setClosed();
    if (startupProjectionRecoveryImmediate) clearImmediate(startupProjectionRecoveryImmediate);
    if (assetSweep) clearInterval(assetSweep);
    if (agentDeletionCleanupSweep) clearInterval(agentDeletionCleanupSweep);
    stopCommunicationReconciliation();
    const runBrowserClosures: Promise<void>[] = [];
    for (const [agentId, run] of activeRuns) {
      runBrowserClosures.push(closeRunBrowser(agentId, run, "server_shutdown"));
      clearRunLeaseTimer(run);
      clearRunLivenessTimer(run);
      agentMessageCapabilities.delete(run.messageCapability);
      if (run.v3SchedulerRunId && run.v3FencingToken !== undefined) {
        try {
          coordinationV3.failRun({
            runId: run.v3SchedulerRunId,
            fencingToken: run.v3FencingToken,
            workerId: coordinationV3WorkerId,
            sameRunResumable: false,
          });
        } catch { /* an already advanced fence is terminal */ }
      }
      run.controller.abort();
    }
    projectBrowserGrants.clear();
    const backgroundOperation = Promise.allSettled([
      boundedBackgroundShutdown("web-push delivery", () => webPushDelivery?.stop()),
      boundedBackgroundShutdown("trigger sources", () => triggerSources.stop()),
      boundedBackgroundShutdown("coordination scheduler", () => coordinationV3Scheduler.stop()),
      boundedBackgroundShutdown(
        "runtime communication projection recovery",
        () => startupProjectionRecovery,
      ),
      ...runBrowserClosures,
      Promise.resolve().then(() => browserSessions.closeAll("server_shutdown")),
      Promise.resolve().then(() => projectBrowserSessions.closeAll("server_shutdown")),
      boundedBackgroundShutdown("injected background cleanup", () => opts.shutdownFaults?.backgroundCleanup?.()),
    ]);
    // Provider authority revocation is an independent barrier. No earlier
    // watcher, scheduler, push, or browser failure can skip it.
    const [backgroundResults, providerResult] = await Promise.all([
      backgroundOperation,
      finalizeProviderRuntimeShutdown().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    ]);
    const backgroundFailures = backgroundResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    shutdownBackgroundCleanupSucceeded = backgroundFailures.length === 0;
    const failures = [
      ...backgroundFailures,
      ...(providerResult.status === "rejected" ? [providerResult.reason] : []),
    ];
    if (!failures.length) {
      try { closeShutdownStorageIfReady(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const error = new AggregateError(failures, "Ponderosa server shutdown did not complete") as AggregateError & {
        providerRuntimeOnly?: boolean;
      };
      error.providerRuntimeOnly = backgroundFailures.length === 0 &&
        providerResult.status === "rejected";
      throw error;
    }
  });
}
