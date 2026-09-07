import {
  AgentDeletionConflictError,
  type AgentDeletionReceipt,
  type AgentManagementAuthorization,
  type AgentStore,
  type CoordinationV3Store,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type {
  AgentDeletionPreviewDto,
  CommitAgentDeletionResponse,
  WorkspaceEventEnvelope,
} from "@ponderosa/core";
import type {
  ActiveRun,
  CreateServerOptions,
  PersistentRuntime,
  Subscriber,
} from "./app-contracts.js";
import type { ContextCursorStore } from "./context-cursors.js";
import type { createOperationalNotifications } from "./operational-notifications.js";
import { cleanupAgentRuntimeAttachments } from "./runtime-attachments.js";
import type { RuntimeElicitationBroker } from "./runtime-elicitation-broker.js";
import type { ProviderProcessAuthority } from "./provider-process-authority.js";
import type { BrowserProfileAuthority } from "./browser-profile-authority.js";
import type { AgentWorkingCopyService } from "./agent-working-copy-service.js";
import type { DraftService } from "./routes/drafts.js";

type OperationalNotifications = ReturnType<typeof createOperationalNotifications>;

type AgentDeletionAuthorityContext =
  Pick<OperationalNotifications,
    "createOperationalNotification" | "resolveOperationalNotification"> & {
    opts: CreateServerOptions;
    store: AgentStore;
    coordinationV3: CoordinationV3Store;
    workspace: WorkspaceStore;
    runtimeElicitations: RuntimeElicitationBroker;
    activeRuns: Map<string, ActiveRun>;
    subscribers: Map<string, Set<Subscriber>>;
    scheduledSessionRollovers: Map<string, string>;
    contextRolloverPending: Map<string, {
      sessionId: string;
      usedTokens: number;
      at: string;
    }>;
    deletingAgentIds: Set<string>;
    agentDeliveryLeases: ReadonlyMap<string, number>;
    agentAttachmentDeletionInProgress(agentId: string): boolean;
    reconcilingAssetAgentIds: ReadonlySet<string>;
    contextCursors: ContextCursorStore;
    appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): WorkspaceEventEnvelope;
    publishWorkspaceSince(cursor: number): void;
    closeLinkPreviewsForAgent(agentId: string, reason: string): void;
    detachPersistentRuntime(
      agentId: string,
      runtime: PersistentRuntime,
      reason: string,
      projectId?: string,
    ): void;
    teardownPersistentRuntime(
      agentId: string,
      runtime: PersistentRuntime,
      reason: string,
      projectId?: string,
    ): Promise<void>;
    drainProviderRuntimeAuthority(reason: string, agentIds?: ReadonlySet<string>): Promise<void>;
    drainEngineCapabilityDiscoveries(projectId?: string, agentIds?: ReadonlySet<string>): Promise<void>;
    drafts: Pick<DraftService, "deleteSurface" | "fenceMutations">;
    refreshTriggerSources(): Promise<void>;
    notifyScheduler(): void;
    closeAgentBrowsers(agentId: string, reason: string): Promise<void>;
    providerProcessAuthority: ProviderProcessAuthority;
    browserProfiles: BrowserProfileAuthority;
    workingCopies: AgentWorkingCopyService;
  };

export function createAgentDeletionAuthority(
  context: AgentDeletionAuthorityContext,
) {
  const {
    opts,
    store,
    coordinationV3,
    workspace,
    runtimeElicitations,
    activeRuns,
    subscribers,
    scheduledSessionRollovers,
    contextRolloverPending,
    deletingAgentIds,
    agentDeliveryLeases,
    agentAttachmentDeletionInProgress,
    reconcilingAssetAgentIds,
    contextCursors,
    appendWorkspace,
    publishWorkspaceSince,
    closeLinkPreviewsForAgent,
    detachPersistentRuntime,
    teardownPersistentRuntime,
    drainProviderRuntimeAuthority,
    drainEngineCapabilityDiscoveries,
    drafts,
    refreshTriggerSources,
    notifyScheduler,
    closeAgentBrowsers,
    createOperationalNotification,
    resolveOperationalNotification,
    providerProcessAuthority,
    browserProfiles,
    workingCopies,
  } = context;

  const cancelAgentDecisions = (agentIds: Iterable<string>): void => {
    const cursor = workspace.cursor();
    for (const agentId of agentIds) for (const decision of workspace.cancelDecisionsForAgent(agentId)) {
      runtimeElicitations.cancel(decision.id);
      coordinationV3.releaseDecisionQuestionSuspensions(decision.id);
    }
    publishWorkspaceSince(cursor);
  };
  const deletionRuntimeTerminationTimeoutMs = 5_000;
  const awaitRuntimeTerminationOperation = async (operation: Promise<void>, label: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), deletionRuntimeTerminationTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const projectDeletionCleanupTimeoutMs = 5_000;
  const awaitProjectDeletionBarrier = async (operation: Promise<unknown>, label: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation.then(() => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), projectDeletionCleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const runtimeTerminationAttempts = new Map<object, Promise<string | undefined>>();
  const terminateRuntimeHandle = async (
    agentId: string,
    run: ActiveRun | undefined,
    runtime: PersistentRuntime | undefined,
    reason = "provider cancellation",
    projectId?: string,
  ): Promise<string | undefined> => {
    const session = runtime?.session ?? run?.runtimeSession;
    const handle = session ?? run?.completion;
    if (!handle) return undefined;
    const existing = runtimeTerminationAttempts.get(handle);
    if (existing) return existing;
    const attempt = (async (): Promise<string | undefined> => {
      if (!session) {
        try {
          await awaitRuntimeTerminationOperation(run!.completion!, `${agentId} runtime cancellation`);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : "runtime cancellation was not acknowledged";
        }
      }
      if (runtime) detachPersistentRuntime(agentId, runtime, reason, projectId);
      let interruptError: string | undefined;
      try {
        await awaitRuntimeTerminationOperation(session.interrupt(), `${agentId} runtime interrupt`);
      } catch (error) {
        // close() is the authoritative termination acknowledgement. Retain
        // interrupt detail only when close also fails.
        interruptError = error instanceof Error ? error.message : "runtime interrupt failed";
      }
      try {
        await awaitRuntimeTerminationOperation(
          runtime
            ? teardownPersistentRuntime(agentId, runtime, reason, projectId)
            : session.close(),
          `${agentId} runtime close`,
        );
        return undefined;
      } catch (error) {
        const closeError = error instanceof Error ? error.message : "runtime close failed";
        return interruptError ? `${interruptError}; ${closeError}` : closeError;
      }
    })();
    runtimeTerminationAttempts.set(handle, attempt);
    try { return await attempt; }
    finally {
      if (runtimeTerminationAttempts.get(handle) === attempt) runtimeTerminationAttempts.delete(handle);
    }
  };
  const processAgentDeletionCleanup = async (receipt: AgentDeletionReceipt): Promise<boolean> => {
    if (receipt.serverCleanupCompleted) return true;
    const errors: string[] = [];
    try { cancelAgentDecisions(receipt.deletedAgentIds); }
    catch (error) { errors.push(error instanceof Error ? error.message : "Decision cleanup failed"); }
    const deletedAgentIds = new Set(receipt.deletedAgentIds);
    await Promise.allSettled(receipt.deletedAgentIds.flatMap((agentId) => {
      const session = activeRuns.get(agentId)?.runtimeSession;
      return session ? [Promise.resolve().then(() => awaitRuntimeTerminationOperation(
        session.interrupt(),
        `${agentId} runtime interrupt`,
      ))] : [];
    }));
    try {
      await awaitRuntimeTerminationOperation(
        drainProviderRuntimeAuthority("Agent deletion", deletedAgentIds),
        "Agent deletion runtime close",
      );
      await awaitRuntimeTerminationOperation(
        providerProcessAuthority.terminateAgents(deletedAgentIds, "Agent deletion").then(() => undefined),
        "Agent deletion recovered runtime close",
      );
    } catch (error) {
      const details = error instanceof AggregateError
        ? error.errors.map((item) => item instanceof Error ? item.message : String(item)).join("; ")
        : undefined;
      errors.push(error instanceof Error
        ? `${error.message}${details ? `: ${details}` : ""}`
        : "Agent deletion provider authority drain failed");
    }
    for (const agentId of receipt.deletedAgentIds) {
      try {
        subscribers.delete(agentId);
        scheduledSessionRollovers.delete(agentId);
        contextRolloverPending.delete(agentId);
      } catch (error) {
        errors.push(`${agentId}: ${error instanceof Error ? error.message : "runtime cleanup failed"}`);
      }
      try {
        workspace.deleteDraft(`agent:${agentId}`);
        await drafts.deleteSurface(`agent:${agentId}`);
      } catch (error) {
        errors.push(`${agentId}: ${error instanceof Error ? error.message : "draft cleanup failed"}`);
      }
      try {
        cleanupAgentRuntimeAttachments(opts.dataDir, agentId);
      } catch (error) {
        errors.push(`${agentId}: ${error instanceof Error ? error.message : "runtime attachment cleanup failed"}`);
      }
    }
    try { contextCursors.deleteAgents(new Set(receipt.deletedAgentIds)); }
    catch (error) { errors.push(error instanceof Error ? error.message : "context cleanup failed"); }
    try { await refreshTriggerSources(); }
    catch (error) { errors.push(error instanceof Error ? error.message : "Automation refresh failed"); }
    if (errors.length > 0) {
      try { store.recordAgentDeletionCleanupError(receipt.id, errors.join("; ")); }
      catch { /* the durable receipt remains pending for startup reconciliation */ }
      try {
        createOperationalNotification({
          dedupeKey: `agent-deletion:${receipt.id}:cleanup-pending`,
          category: "system",
          severity: "attention",
          title: "Agent deletion cleanup needs attention",
          body: `The Agents were deleted, but runtime or background cleanup is still retrying. ${errors.join("; ").slice(0, 1_000)}`,
          projectId: receipt.projectId,
        });
      } catch { /* the durable receipt remains the authoritative retry signal */ }
      return false;
    }
    try { store.markAgentDeletionServerCleanupComplete(receipt.id); }
    catch (error) {
      try { store.recordAgentDeletionCleanupError(receipt.id, error instanceof Error ? error.message : "could not complete deletion receipt"); }
      catch { /* startup reconciliation will retry */ }
      return false;
    }
    try { resolveOperationalNotification(`agent-deletion:${receipt.id}:cleanup-pending`); }
    catch { /* notification repair cannot reopen completed provider cleanup */ }
    try { notifyScheduler(); }
    catch { /* scheduler polling and restart reconciliation remain authoritative */ }
    // Live invalidation is best effort after the durable cleanup receipt is
    // complete. A WebSocket publication failure cannot reopen cleanup.
    try { appendWorkspace({ type: "project_changed", projectId: receipt.projectId, action: "updated" }); }
    catch { /* clients reconcile from durable state on reconnect */ }
    return true;
  };
  const commitAgentDeletion = async (
    rootAgentIds: string[],
    previewHash: string,
    authorization?: AgentManagementAuthorization,
  ): Promise<CommitAgentDeletionResponse> => {
    const previous = store.getAgentDeletionReceiptByPreviewHash(previewHash);
    if (previous) {
      const normalized = [...new Set(rootAgentIds)].sort();
      if (JSON.stringify(normalized) !== JSON.stringify(previous.rootAgentIds)) {
        throw new Error("deletion receipt does not match the requested roots");
      }
      if (!previous.storageCleanupCompleted) {
        try { store.finishAgentDeletionStorageCleanup(previous); }
        catch (error) { store.recordAgentDeletionCleanupError(previous.id, error instanceof Error ? error.message : "storage cleanup failed"); }
      }
      await processAgentDeletionCleanup(store.getAgentDeletionReceiptByPreviewHash(previewHash)!);
      const refreshed = store.getAgentDeletionReceiptByPreviewHash(previewHash)!;
      return {
        deleted: true,
        deletedAgentIds: refreshed.deletedAgentIds,
        deletionReceiptId: refreshed.id,
        cleanupPending: !(refreshed.storageCleanupCompleted && refreshed.serverCleanupCompleted),
        replayed: true,
      };
    }
    const current = store.previewAgentDeletion(rootAgentIds);
    if (current.previewHash !== previewHash) throw new AgentDeletionConflictError(current);
    if (authorization) store.sqlite.transaction(() => store.authorizeAgentManagementPlan(
      authorization,
      current.affectedAgents.map((agent) => agent.id),
      false,
    ))();
    const expectedAgentIds = current.affectedAgents.map((agent) => agent.id);
    if (expectedAgentIds.some((agentId) =>
      (agentDeliveryLeases.get(agentId) ?? 0) > 0 ||
      agentAttachmentDeletionInProgress(agentId) ||
      reconcilingAssetAgentIds.has(agentId))) {
      throw new AgentDeletionConflictError(current);
    }
    const enabledAutomation = expectedAgentIds.length
      ? store.sqlite.prepare(`
          SELECT name FROM trigger_definitions
          WHERE enabled = 1
            AND agent_id IN (${expectedAgentIds.map(() => "?").join(", ")})
          ORDER BY name LIMIT 1
        `).get(...expectedAgentIds) as { name: string } | undefined
      : undefined;
    if (enabledAutomation) {
      throw new Error(
        `Disable or reassign the Automation “${enabledAutomation.name}” before deleting its execution Agent.`,
      );
    }
    if (expectedAgentIds.some((agentId) => deletingAgentIds.has(agentId))) {
      throw new AgentDeletionConflictError(store.previewAgentDeletion(current.rootAgentIds));
    }
    // Reserve the exact confirmed topology before the first await. All server
    // mutation paths reject a reserved Agent, so cleanup cannot open a gap in
    // which the previewed cascade changes before the atomic store commit.
    expectedAgentIds.forEach((agentId) => deletingAgentIds.add(agentId));
    let releaseDraftFence: (() => void) | undefined;
    let committed: AgentDeletionPreviewDto;
    try {
      releaseDraftFence = await drafts.fenceMutations(
        expectedAgentIds.map(agentId => `agent:${agentId}`),
      );
      const deletingSet = new Set(expectedAgentIds);
      // Quarantine prevents new folder users from entering. Actively stop every
      // provider-command and reusable-runtime authority that can already own a
      // folder lease before waiting for that lease; waiting first would
      // deadlock deletion against the teardown needed to release it.
      await drainEngineCapabilityDiscoveries(undefined, deletingSet);
      await drainProviderRuntimeAuthority("Agent deletion working-folder drain", deletingSet);
      await providerProcessAuthority.terminateAgents(
        deletingSet,
        "Agent deletion working-folder drain",
      );
      await workingCopies.awaitModeChanges(deletingSet);
      await workingCopies.awaitUses(deletingSet);
      for (const agentId of expectedAgentIds) {
        closeLinkPreviewsForAgent(agentId, "agent deleted");
        await closeAgentBrowsers(agentId, "agent_deleted");
      }
      // Provider teardown is a pre-commit deletion barrier. The durable receipt
      // remains useful for post-commit file/projection cleanup, but an Agent's
      // canonical row must not disappear while any current- or prior-boot
      // provider process group can still act with its authority.
      await drainProviderRuntimeAuthority("Agent deletion", deletingSet);
      await providerProcessAuthority.terminateAgents(deletingSet, "Agent deletion");
      // Provider drain can retire the active Run needed by run-scoped cleanup.
      // Re-scan by immutable Agent identity before deleting canonical rows so a
      // browser admitted immediately before quarantine cannot survive commit.
      for (const agentId of expectedAgentIds) {
        await closeAgentBrowsers(agentId, "agent_deleted_final_barrier");
      }
      expectedAgentIds.forEach((agentId) => browserProfiles.removeAgent(agentId));
      committed = store.deleteAgentSubtrees(
        current.rootAgentIds,
        previewHash,
        (agentId) => coordinationV3.handleAgentDeletion(agentId),
        authorization,
      );
    } catch (error) {
      releaseDraftFence?.();
      expectedAgentIds.forEach((agentId) => deletingAgentIds.delete(agentId));
      throw error;
    }
    const deletedAgentIds = new Set(committed.affectedAgents.map((agent) => agent.id));
    try {
      const receipt = store.getAgentDeletionReceiptByPreviewHash(previewHash)!;
      await processAgentDeletionCleanup(receipt);
    } finally {
      releaseDraftFence?.();
      deletedAgentIds.forEach((agentId) => deletingAgentIds.delete(agentId));
    }
    const receipt = store.getAgentDeletionReceiptByPreviewHash(previewHash)!;
    return {
      deleted: true,
      deletedAgentIds: [...deletedAgentIds],
      deletionReceiptId: receipt.id,
      cleanupPending: !(receipt.storageCleanupCompleted && receipt.serverCleanupCompleted),
    };
  };
  return {
    cancelAgentDecisions,
    awaitProjectDeletionBarrier,
    terminateRuntimeHandle,
    processAgentDeletionCleanup,
    commitAgentDeletion,
  };
}
