import WebSocket from "ws";
import type {
  AgentDeletionReceipt,
  AgentStore,
  ConversationDeletionReceipt,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import {
  readManagedArtifactContent,
  removeManagedArtifactContent,
  repairManagedArtifactContent,
} from "@ponderosa/agents";
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

export async function recoverCanonicalAgentCreations(input: {
  store: AgentStore;
  deletingAgentIds: Set<string>;
  reconcileRuntimeCommunicationProjections(filter: {
    projectId: string;
    communicationEventId: string;
    allowQuarantinedAgentIds: ReadonlySet<string>;
  }): Promise<number>;
  limit?: number;
}): Promise<{ recovered: number; failures: Array<{ operationId: string; error: unknown }> }> {
  const failures: Array<{ operationId: string; error: unknown }> = [];
  let recovered = 0;
  const operations = input.store.listRecoverableAgentCreationOperations()
    .filter((operation) => operation.status === "canonical_committed" && operation.communicationEventId)
    .slice(0, input.limit ?? 32);
  for (const operation of operations) {
    try {
      await input.reconcileRuntimeCommunicationProjections({
        projectId: operation.projectId,
        communicationEventId: operation.communicationEventId!,
        allowQuarantinedAgentIds: new Set(operation.agentIds),
      });
      input.store.updateAgentCreationOperation(operation.id, {
        status: "completed",
        lastError: null,
      });
      for (const agentId of operation.agentIds) input.deletingAgentIds.delete(agentId);
      recovered += 1;
    } catch (error) {
      input.store.updateAgentCreationOperation(operation.id, {
        lastError: error instanceof Error ? error.message : "Agent creation projection recovery failed",
      });
      failures.push({ operationId: operation.id, error });
    }
  }
  return { recovered, failures };
}

export function recoverFailedAgentCreations(input: {
  store: AgentStore;
  assets: AssetStore;
  dataDir: string;
  deletingAgentIds: Set<string>;
  handleAgentDeletion(agentId: string): void;
}): { recovered: number; failures: Array<{ operationId: string; error: unknown }> } {
  let recovered = 0;
  const failures: Array<{ operationId: string; error: unknown }> = [];
  for (const operation of input.store.listRecoverableAgentCreationOperations()) {
    if (operation.status === "canonical_committed") continue;
    input.store.updateAgentCreationOperation(operation.id, { status: "rolling_back" });
    let rolledBack = true;
    const authorityBlockedArtifactIds = new Set<string>();
    for (const agentId of [...operation.agentIds].reverse()) {
      try {
        if (input.store.getAgent(agentId) &&
            !input.store.deleteAgent(agentId, input.handleAgentDeletion)) {
          rolledBack = false;
        }
      } catch (error) {
        rolledBack = false;
        failures.push({ operationId: operation.id, error });
      }
    }
    const operationAgentsRemain = operation.agentIds.some((agentId) =>
      input.store.getAgent(agentId));
    for (const identity of operation.artifactIdentities) {
      try {
        if (operationAgentsRemain ||
            !input.assets.removeCreationGeneratedArtifact(operation.projectId, identity)) {
          authorityBlockedArtifactIds.add(identity.id);
          rolledBack = false;
        }
      } catch (error) {
        authorityBlockedArtifactIds.add(identity.id);
        rolledBack = false;
        failures.push({ operationId: operation.id, error });
      }
    }
    for (const artifactId of operation.artifactIds) {
      if (authorityBlockedArtifactIds.has(artifactId)) continue;
      try {
        const artifact = input.store.getProjectArtifact(operation.projectId, artifactId);
        if (artifact?.originAgentId && operation.agentIds.includes(artifact.originAgentId)) {
          input.store.deleteProjectArtifact(
            operation.projectId,
            artifactId,
            "Agent creation recovery rolled back",
          );
          if (input.store.getProjectArtifact(operation.projectId, artifactId)) rolledBack = false;
        }
      } catch (error) {
        rolledBack = false;
        failures.push({ operationId: operation.id, error });
      }
    }
    for (const identity of operation.artifactIdentities) {
      if (authorityBlockedArtifactIds.has(identity.id)) continue;
      try {
        const catalogued = input.store.getProjectArtifact(operation.projectId, identity.id);
        if (catalogued && (!catalogued.originAgentId ||
            !operation.agentIds.includes(catalogued.originAgentId))) continue;
        if (catalogued) {
          rolledBack = false;
          continue;
        }
        const runtime = input.assets.authoritativeRuntimeArtifactMetadataById(
          operation.projectId,
          identity.id,
        );
        if (runtime && (runtime.byteLength !== identity.byteLength ||
            runtime.blobHash !== identity.sha256)) continue;
        if (runtime) input.assets.removeRuntimeArtifactReservation(operation.projectId, identity.id);
        removeManagedArtifactContent(
          input.dataDir,
          operation.projectId,
          identity.id,
          identity.byteLength,
          identity.sha256,
        );
        if (readManagedArtifactContent(
          input.dataDir,
          operation.projectId,
          identity.id,
          identity.byteLength,
          identity.sha256,
        )) rolledBack = false;
      } catch (error) {
        rolledBack = false;
        failures.push({ operationId: operation.id, error });
      }
    }
    if (operationAgentsRemain) rolledBack = false;
    if (rolledBack) {
      input.store.updateAgentCreationOperation(operation.id, {
        status: "rolled_back",
        lastError: null,
      });
      for (const agentId of operation.agentIds) input.deletingAgentIds.delete(agentId);
      recovered += 1;
    }
  }
  return { recovered, failures };
}

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
  Pick<RuntimeAuthority,
    "drainProviderRuntimeAuthority" | "retireCompletedContextRolloverSession"> &
  Pick<ReadModels, "ensureDecisionResponseActivation"> &
  Pick<CommunicationJournal,
    "refreshCommunicationReconciliation" | "stopCommunicationReconciliation"> &
  Pick<BrowserAuthority, "closeRunBrowser"> & {
    opts: CreateServerOptions;
    store: AgentStore;
    assets: AssetStore;
    coordinationV3: CoordinationV3Store;
    workspace: WorkspaceStore;
    reconcileCommittedProjectDeletions(): void;
    artifactFilesystem: ReadinessCheckDto;
    processContainment: ReadinessCheckDto;
    coordinationV3WorkerId: string;
    activeRuns: Map<string, ActiveRun>;
    runtimeAuthorities: Map<string, AgentRuntimeAuthority>;
    agentMessageCapabilities: Map<string, AgentMessageCapability>;
    agentDeliveryLeases: ReadonlyMap<string, number>;
    deletingAgentIds: Set<string>;
    attachmentDeletionInProgress(agentId: string): boolean;
    reconcilingAssetAgentIds: Set<string>;
    projectBrowserGrants: Map<string, unknown>;
    browserSessions: BrowserSessionManager;
    projectBrowserSessions: BrowserSessionManager;
    providerUsage: ProviderUsageCache;
    webPushDelivery: WebPushDeliveryManager | undefined;
    coordinationV3Scheduler: CoordinationV3Scheduler;
    triggerSources: TriggerSourceService;
    processAgentDeletionCleanup(receipt: AgentDeletionReceipt): Promise<boolean>;
    processConversationDeletionCleanup(
      receipt: ConversationDeletionReceipt,
    ): Promise<boolean>;
    reconcileRuntimeCommunicationProjections(filter?: {
      projectId?: string;
      communicationEventId?: string;
      allowQuarantinedAgentIds?: ReadonlySet<string>;
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

export function leaseAgentAssetReconciliation(
  agentDeliveryLeases: ReadonlyMap<string, number>,
  deletingAgentIds: ReadonlySet<string>,
  attachmentDeletionInProgress: (agentId: string) => boolean,
  reconcilingAssetAgentIds: Set<string>,
  agentId: string,
): (() => void) | undefined {
  if (deletingAgentIds.has(agentId) || attachmentDeletionInProgress(agentId) ||
      (agentDeliveryLeases.get(agentId) ?? 0) > 0 ||
      reconcilingAssetAgentIds.has(agentId)) return undefined;
  reconcilingAssetAgentIds.add(agentId);
  return () => reconcilingAssetAgentIds.delete(agentId);
}

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
    reconcileCommittedProjectDeletions,
    artifactFilesystem,
    processContainment,
    coordinationV3WorkerId,
    activeRuns,
    runtimeAuthorities,
    agentMessageCapabilities,
    agentDeliveryLeases,
    deletingAgentIds,
    attachmentDeletionInProgress,
    reconcilingAssetAgentIds,
    projectBrowserGrants,
    browserSessions,
    projectBrowserSessions,
    providerUsage,
    webPushDelivery,
    coordinationV3Scheduler,
    triggerSources,
    processAgentDeletionCleanup,
    processConversationDeletionCleanup,
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
    retireCompletedContextRolloverSession,
    ensureDecisionResponseActivation,
    refreshCommunicationReconciliation,
    stopCommunicationReconciliation,
    closeRunBrowser,
    providerProcessAuthority,
  } = context;
  let assetSweep: NodeJS.Timeout | undefined;
  let agentDeletionCleanupSweep: NodeJS.Timeout | undefined;
  let conversationDeletionCleanupSweep: NodeJS.Timeout | undefined;
  let agentCreationRecoverySweep: NodeJS.Timeout | undefined;
  let agentDeletionCleanupDraining = false;
  let agentDeletionCleanupOperation: Promise<void> | undefined;
  let conversationDeletionCleanupOperation: Promise<void> | undefined;
  let agentCreationRecoveryOperation: Promise<void> | undefined;
  let assetReconciliationOperation: Promise<void> | undefined;
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
      }).then(async (repaired) => {
        let verifiedProjects = 0;
        for (const project of store.listProjects()) {
          if (isClosed()) break;
          refreshCommunicationReconciliation(project.id);
          verifiedProjects += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!isClosed()) {
          app.log.info(
            { repaired, verifiedProjects },
            "runtime communication projection startup recovery completed",
          );
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
  const runAgentDeletionCleanup = (): Promise<void> => {
    if (agentDeletionCleanupOperation) return agentDeletionCleanupOperation;
    const operation = drainAgentDeletionCleanup().finally(() => {
      if (agentDeletionCleanupOperation === operation) agentDeletionCleanupOperation = undefined;
    });
    agentDeletionCleanupOperation = operation;
    return operation;
  };
  const runConversationDeletionCleanup = (): Promise<void> => {
    if (conversationDeletionCleanupOperation) {
      return conversationDeletionCleanupOperation;
    }
    const operation = (async () => {
      for (const receipt of store.listPendingConversationDeletionReceipts()) {
        if (isClosed()) break;
        await processConversationDeletionCleanup(receipt);
      }
    })().catch((error) => {
      if (!isClosed()) app.log.error({ err: error }, "Chat deletion cleanup retry failed");
    }).finally(() => {
      if (conversationDeletionCleanupOperation === operation) {
        conversationDeletionCleanupOperation = undefined;
      }
    });
    conversationDeletionCleanupOperation = operation;
    return operation;
  };
  const runAgentCreationRecovery = (limit = 32): Promise<void> => {
    if (agentCreationRecoveryOperation) return agentCreationRecoveryOperation;
    const operation = recoverCanonicalAgentCreations({
      store,
      deletingAgentIds,
      reconcileRuntimeCommunicationProjections,
      limit,
    }).then(({ recovered, failures }) => {
      if (recovered > 0 && !isClosed()) {
        app.log.info({ recovered }, "Agent creation projection recovery completed");
      }
      for (const failure of failures) {
        if (!isClosed()) {
          app.log.error(
            { err: failure.error, operationId: failure.operationId },
            "Agent creation projection recovery remains pending",
          );
        }
      }
    }).finally(() => {
      if (agentCreationRecoveryOperation === operation) agentCreationRecoveryOperation = undefined;
    });
    agentCreationRecoveryOperation = operation;
    return operation;
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
    // Completed deletion receipts are irreversible canonical authority. Repair
    // any crash gap in the workspace log before the listener becomes ready.
    reconcileCommittedProjectDeletions();
    completeLifecyclePhase("project_deletion_workspace_recovery");
    await runAgentCreationRecovery(Number.POSITIVE_INFINITY);
    const failedCreationRecovery = recoverFailedAgentCreations({
      store,
      assets,
      dataDir: opts.dataDir,
      deletingAgentIds,
      handleAgentDeletion: (id) => coordinationV3.handleAgentDeletion(id),
    });
    for (const failure of failedCreationRecovery.failures) {
      store.updateAgentCreationOperation(failure.operationId, {
        lastError: failure.error instanceof Error
          ? failure.error.message
          : "Agent creation rollback remains quarantined",
      });
      app.log.error(
        { err: failure.error, operationId: failure.operationId },
        "Agent creation rollback remains quarantined",
      );
    }
    completeLifecyclePhase("agent_creation_recovery");
    const orphanGraceBoundary = Date.now() - 60 * 60 * 1_000;
    const recoveredProviderProcesses = await providerProcessAuthority.recoverPreviousWorkers();
    if (recoveredProviderProcesses > 0) {
      app.log.warn({ recoveredProviderProcesses }, "terminated provider process groups recovered from a previous daemon boot");
    }
    completeLifecyclePhase("provider_process_recovery");
    if (opts.startupMode === "shutdown_recovery") {
      setClosed();
      app.log.info({ recoveredProviderProcesses }, "shutdown recovery verifier completed durable process cleanup");
      return;
    }
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
    for (const rollover of coordinationV3.contextRolloverCanonicalAcceptanceCandidates()) {
      const accepted = [...store.readEvents(rollover.agentId)].reverse().find((stored) =>
        stored.event.type === "context_rollover_session_accepted" &&
        stored.event.rolloverId === rollover.id &&
        stored.event.sessionId === rollover.replacementSessionId &&
        stored.event.executionId === rollover.replacementRunId &&
        stored.event.handoffId === rollover.handoffEventId);
      if (!accepted || accepted.event.type !== "context_rollover_session_accepted") continue;
      try {
        coordinationV3.reconcileContextRolloverCanonicalAcceptance({
          id: rollover.id,
          replacementSessionId: accepted.event.sessionId,
          replacementRunId: accepted.event.executionId,
          handoffEventId: accepted.event.handoffId,
        });
      } catch (error) {
        createOperationalNotification({
          dedupeKey: `context-rollover:${rollover.id}:acceptance-reconciliation-failed`,
          category: "coordination",
          severity: "attention",
          title: "Context refresh acceptance needs review",
          body: error instanceof Error ? error.message : String(error),
          projectId: rollover.projectId,
          conversationId: rollover.conversationId,
          agentId: rollover.agentId,
          action: { kind: "open_agent", targetId: rollover.agentId },
        });
      }
    }
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
            if (coordinationV3.hasViableContextRolloverHandoffActivation(rollover.id)) {
              resolveOperationalNotification(`context-rollover:${rollover.id}:outcome-unknown`);
              app.log.info({
                agentId: rollover.agentId,
                rolloverId: rollover.id,
              }, "context rollover retained its durable pending handoff after restart");
              continue;
            }
            coordinationV3.failContextRollover(
              rollover.id,
              "outcome_unknown",
              "server restarted without a committed or pending rollover handoff",
              "internal",
            );
            resolveOperationalNotification(`context-rollover:${rollover.id}:outcome-unknown`);
            app.log.warn({
              agentId: rollover.agentId,
              rolloverId: rollover.id,
            }, "context rollover had no viable handoff after restart; retained the old context");
            continue;
          }
          rollover = coordinationV3.commitContextRolloverHandoff(rollover.id, handoff.id);
        }
        if (rollover.state === "handoff_committed") {
          rollover = coordinationV3.beginContextRolloverRetirement(rollover.id);
        }
        if (rollover.state === "session_retiring") {
          rollover = coordinationV3.prepareContextRolloverContinuation({
            id: rollover.id,
          });
          if (rollover.completionReason === "no_continuation_required") {
            await retireCompletedContextRolloverSession({
              agentId: rollover.agentId,
              projectId: rollover.projectId,
              rolloverId: rollover.id,
              providerSessionGeneration: rollover.providerSessionGeneration,
            });
            continue;
          }
        }
        if (rollover.state === "continuation_ready" && rollover.replacementRunId && !rollover.replacementSessionId) {
          coordinationV3.failUnidentifiedContextRolloverReplacementAfterRestart(rollover.id);
          createOperationalNotification({
            dedupeKey: `context-rollover:${rollover.id}:candidate-start-unknown`,
            category: "coordination",
            severity: "attention",
            title: "Context refresh candidate was discarded after restart",
            body: "The exact replacement input was durable, but no candidate session identity was observed before restart. The old accepted provider session remains authoritative; an explicit authorized Retry may reuse this rollover generation.",
            projectId: rollover.projectId,
            conversationId: rollover.conversationId,
            agentId: rollover.agentId,
            action: { kind: "open_agent", targetId: rollover.agentId },
          });
          continue;
        }
        if (rollover.state === "continuation_ready" && rollover.replacementSessionId) {
          if (rollover.replacementVerifiedAt &&
              store.resumeSessionId(rollover.agentId) === rollover.replacementSessionId) {
            coordinationV3.completeVerifiedContextRolloverReplacement(
              rollover.id,
              rollover.replacementSessionId,
            );
            continue;
          }
          coordinationV3.failContextRollover(
            rollover.id,
            "outcome_unknown",
            "server restarted after the replacement session was recorded but before low-water context confirmation",
            "internal",
          );
          createOperationalNotification({
            dedupeKey: `context-rollover:${rollover.id}:confirmation-missing`,
            category: "coordination",
            severity: "attention",
            title: "Context refresh needs review",
            body: "The replacement provider session ended with the server before safe context headroom was confirmed. The last accepted old provider session remains available; its exact bounded handoff is recorded for review.",
            projectId: rollover.projectId,
            conversationId: rollover.conversationId,
            agentId: rollover.agentId,
            action: { kind: "open_agent", targetId: rollover.agentId },
          });
        }
      } catch (error) {
        if (error instanceof Error && (
          error.message === "context_rollover_session_retirement_failed"
          || error.message === "context_rollover_generation_conflict"
        )) {
          // A completed no-continuation rollover must keep its durable state
          // while startup remains blocked. Marking it failed here would make
          // the stale accepted provider session eligible for reuse.
          throw error;
        }
        coordinationV3.failContextRollover(
          initial.id,
          "outcome_unknown",
          error instanceof Error ? error.message : String(error),
          "internal",
        );
        createOperationalNotification({
          dedupeKey: `context-rollover:${initial.id}:recovery-failed`,
          category: "coordination",
          severity: "attention",
          title: "Context refresh recovery failed",
          body: error instanceof Error ? error.message : String(error),
          projectId: initial.projectId,
          conversationId: initial.conversationId,
          agentId: initial.agentId,
          action: { kind: "open_agent", targetId: initial.agentId },
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
    await runConversationDeletionCleanup();
    await runAgentDeletionCleanup();
    completeLifecyclePhase("operational_recovery");
    agentDeletionCleanupSweep = setInterval(() => {
      void runAgentDeletionCleanup().catch((error) => {
        if (!isClosed()) app.log.error({ err: error }, "Agent deletion cleanup retry failed");
      });
    }, 30_000);
    agentDeletionCleanupSweep.unref();
    conversationDeletionCleanupSweep = setInterval(() => {
      void runConversationDeletionCleanup();
    }, 30_000);
    conversationDeletionCleanupSweep.unref();
    agentCreationRecoverySweep = setInterval(() => {
      if (isClosed()) return;
      void runAgentCreationRecovery().catch((error) => {
        if (!isClosed()) app.log.error({ err: error }, "Agent creation recovery sweep failed");
      });
    }, 5_000);
    agentCreationRecoverySweep.unref();
    webPushDelivery?.start();
    const reconcileAssets = async () => {
      let processedAgents = 0;
      for (const project of store.listProjects()) {
        for (const agent of store.listAgents(project.id)) {
          const releaseAssetReconciliation = leaseAgentAssetReconciliation(
            agentDeliveryLeases,
            deletingAgentIds,
            attachmentDeletionInProgress,
            reconcilingAssetAgentIds,
            agent.id,
          );
          if (!releaseAssetReconciliation) continue;
          try {
            const associated = new Set(store.getMessages(agent.id).flatMap((message) => message.attachments?.map((item) => item.id) ?? []));
            await assets.reconcile(project.id, agent.id, associated);
          } finally {
            releaseAssetReconciliation();
          }
          processedAgents += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (isClosed()) return;
        }
      }
    };
    const runAssetReconciliation = (): Promise<void> => {
      if (assetReconciliationOperation) return assetReconciliationOperation;
      const operation = reconcileAssets().finally(() => {
        if (assetReconciliationOperation === operation) assetReconciliationOperation = undefined;
      });
      assetReconciliationOperation = operation;
      return operation;
    };
    // Projection recovery above is authoritative. Orphan asset cleanup remains
    // periodic maintenance so it cannot delay startup or monopolize ordinary
    // requests immediately after the server begins accepting traffic.
    assetSweep = setInterval(() => {
      if (isClosed()) return;
      void runAssetReconciliation().catch((error) => {
        if (!isClosed()) app.log.error({ err: error }, "Agent asset reconciliation failed");
      });
    }, 60 * 60 * 1000);
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
  const boundedBackgroundShutdown = async (label: string, operation: () => void | Promise<void>): Promise<void> => {
    const timeoutMs = 5_000;
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
        throw new Error(`${label} cleanup exceeded its ${timeoutMs}ms shutdown deadline`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let shutdownRunBrowserClosures: Array<() => Promise<void>> = [];
  let shutdownPrepared = false;
  const prepareStrictShutdown = (): void => {
    if (shutdownPrepared) return;
    shutdownPrepared = true;
    setClosed();
    if (startupProjectionRecoveryImmediate) clearImmediate(startupProjectionRecoveryImmediate);
    if (assetSweep) clearInterval(assetSweep);
    if (agentDeletionCleanupSweep) clearInterval(agentDeletionCleanupSweep);
    if (conversationDeletionCleanupSweep) clearInterval(conversationDeletionCleanupSweep);
    if (agentCreationRecoverySweep) clearInterval(agentCreationRecoverySweep);
    stopCommunicationReconciliation();
    shutdownRunBrowserClosures = [];
    for (const [agentId, run] of activeRuns) {
      shutdownRunBrowserClosures.push(() => closeRunBrowser(agentId, run, "server_shutdown"));
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
  };
  const finalizeBackgroundShutdown = async (): Promise<void> => {
    if (shutdownBackgroundCleanupSucceeded) return;
    projectBrowserGrants.clear();
    const backgroundOperation = Promise.allSettled([
      boundedBackgroundShutdown("web-push delivery", () => webPushDelivery?.stop()),
      boundedBackgroundShutdown("trigger sources", () => triggerSources.stop()),
      boundedBackgroundShutdown("coordination scheduler", () => coordinationV3Scheduler.stop()),
      boundedBackgroundShutdown(
        "runtime communication projection recovery",
        () => startupProjectionRecovery,
      ),
      boundedBackgroundShutdown(
        "Agent deletion maintenance",
        () => agentDeletionCleanupOperation,
      ),
      boundedBackgroundShutdown(
        "Chat deletion maintenance",
        () => conversationDeletionCleanupOperation,
      ),
      boundedBackgroundShutdown(
        "Agent creation recovery",
        () => agentCreationRecoveryOperation,
      ),
      boundedBackgroundShutdown(
        "Agent asset maintenance",
        () => assetReconciliationOperation,
      ),
      ...shutdownRunBrowserClosures.map((close) => Promise.resolve().then(close)),
      Promise.resolve().then(() => browserSessions.closeAll("server_shutdown")),
      Promise.resolve().then(() => projectBrowserSessions.closeAll("server_shutdown")),
    ]);
    const results = await backgroundOperation;
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Background shutdown cleanup did not complete");
    shutdownBackgroundCleanupSucceeded = true;
    closeShutdownStorageIfReady();
  };
  const finalizeShutdownCleanup = async (): Promise<void> => {
    prepareStrictShutdown();
    // Provider authority revocation is an independent barrier. No earlier
    // watcher, scheduler, push, or browser failure can skip it.
    const [backgroundResults, providerResult] = await Promise.all([
      finalizeBackgroundShutdown().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
      finalizeProviderRuntimeShutdown().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    ]);
    const backgroundFailures = backgroundResults.status === "rejected" ? [backgroundResults.reason] : [];
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
  };
  app.retryShutdownCleanup = finalizeShutdownCleanup;

  app.addHook("onClose", async () => {
    await finalizeShutdownCleanup();
  });
}
