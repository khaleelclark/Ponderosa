import { randomUUID } from "node:crypto";
import type { ProviderRootExitDetail } from "@ponderosa/core";
import { AgentEventPersistenceError, type AgentStore, type CoordinationV3Store, type StoredLogEvent } from "@ponderosa/agents";
import type {
  ActiveRun,
  AgentMessageCapability,
  AgentRuntimeAuthority,
  OneShotRuntimeTeardown,
  OpeningPersistentRuntime,
  PersistentRuntime,
  PersistentRuntimeTeardown,
  RuntimeOwnershipState,
} from "./app-contracts.js";
import type { createOperationalNotifications } from "./operational-notifications.js";
import { readProviderSessionIdentifier } from "./provider-session-success.js";
import { runtimeObservation } from "./runtime-observation.js";

type OperationalNotifications = ReturnType<typeof createOperationalNotifications>;

interface RuntimeAuthorityContext {
  runtimeAuthorities: Map<string, AgentRuntimeAuthority>;
  activeRuns: Map<string, ActiveRun>;
  agentMessageCapabilities: Map<string, AgentMessageCapability>;
  organizationEnvelopeStates: Map<string, { sessionId: string; hash: string }>;
  scheduledSessionRollovers: Map<string, string>;
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  coordinationV3WorkerId: string;
  runtimeAuthorityRetryBaseMs: number;
  runtimeAuthorityRetryMaxMs: number;
  runtimeAuthorityRetryRandom(): number;
  runtimeIdleTtlMs: number;
  runtimeMaxIdleSessions: number;
  runtimeSessionNow(): number;
  setRuntimeIdleTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearRuntimeIdleTimer(timer: NodeJS.Timeout): void;
  setRuntimeAuthorityRetryTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearRuntimeAuthorityRetryTimer(timer: NodeJS.Timeout): void;
  runtimeAuthority(agentId: string, create?: boolean): AgentRuntimeAuthority | undefined;
  pruneRuntimeAuthority(agentId: string, authority: AgentRuntimeAuthority): void;
  reusableRuntime(agentId: string): PersistentRuntime | undefined;
  openingRuntime(agentId: string): OpeningPersistentRuntime | undefined;
  closingRuntime(agentId: string): PersistentRuntimeTeardown | undefined;
  clearAgentResumeSession(agentId: string, reason: string): void;
  closeRunBrowser(agentId: string, run: ActiveRun, reason: string): Promise<void>;
  closeLinkPreviewsForAgent(agentId: string, reason: string): void;
  publish(agentId: string, stored: StoredLogEvent): void;
  publishMessageDeliveryChanged(agentId: string): void;
  createOperationalNotification: OperationalNotifications["createOperationalNotification"];
  resolveOperationalNotification: OperationalNotifications["resolveOperationalNotification"];
  notifyScheduler(): void;
  isClosed(): boolean;
  logError(meta: Record<string, unknown>, message: string): void;
  transitionRun(agentId: string, run: ActiveRun, state: RuntimeOwnershipState): boolean;
  clearRunLeaseTimer(run: ActiveRun): void;
  clearRunLivenessTimer(run: ActiveRun): void;
}

export function createRuntimeAuthority(context: RuntimeAuthorityContext) {
  const {
    runtimeAuthorities,
    activeRuns,
    agentMessageCapabilities,
    organizationEnvelopeStates,
    scheduledSessionRollovers,
    store,
    coordinationV3,
    coordinationV3WorkerId,
    runtimeAuthorityRetryBaseMs,
    runtimeAuthorityRetryMaxMs,
    runtimeAuthorityRetryRandom,
    runtimeIdleTtlMs,
    runtimeMaxIdleSessions,
    runtimeSessionNow,
    setRuntimeIdleTimer,
    clearRuntimeIdleTimer,
    setRuntimeAuthorityRetryTimer,
    clearRuntimeAuthorityRetryTimer,
    runtimeAuthority,
    pruneRuntimeAuthority,
    reusableRuntime,
    openingRuntime,
    closingRuntime,
    clearAgentResumeSession,
    closeRunBrowser,
    closeLinkPreviewsForAgent,
    publish,
    publishMessageDeliveryChanged,
    createOperationalNotification,
    resolveOperationalNotification,
    notifyScheduler,
    isClosed,
    logError,
    transitionRun,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
  } = context;

  function clearRuntimeAuthorityRetry(authority: AgentRuntimeAuthority): void {
    if (!authority.retryTimer) return;
    clearRuntimeAuthorityRetryTimer(authority.retryTimer);
    authority.retryTimer = undefined;
  }

  function clearRuntimeAuthorityRetryIfUnblocked(authority: AgentRuntimeAuthority, agentId: string): void {
    if (authority.opening || authority.closing || authority.oneShots.size > 0
      || pendingRetirements.get(agentId)?.size) return;
    clearRuntimeAuthorityRetry(authority);
    authority.retryAttempt = 0;
  }

  const pendingRuntimeAuthorityCount = (authority: AgentRuntimeAuthority): number =>
    Number(Boolean(authority.opening)) + Number(Boolean(authority.reusable)) +
    Number(Boolean(authority.closing)) + authority.oneShots.size;

  function scheduleRuntimeAuthorityRetry(agentId: string): void {
    const authority = runtimeAuthority(agentId, true)!;
    if (isClosed() || authority.retryTimer || authority.retryInProgress) return;
    const exponent = Math.min(authority.retryAttempt, 16);
    const withoutJitter = Math.min(runtimeAuthorityRetryMaxMs, runtimeAuthorityRetryBaseMs * (2 ** exponent));
    const random = Math.min(1, Math.max(0, runtimeAuthorityRetryRandom()));
    const delayMs = Math.min(
      runtimeAuthorityRetryMaxMs,
      Math.max(1, Math.round(withoutJitter * (0.75 + random * 0.5))),
    );
    authority.retryAttempt = exponent + 1;
    authority.retryTimer = setRuntimeAuthorityRetryTimer(() => {
      authority.retryTimer = undefined;
      authority.retryInProgress = true;
      const pendingBefore = pendingRuntimeAuthorityCount(authority);
      void (async () => {
        let retryError: unknown;
        try {
          await reconcileAgentRuntimeAuthority(agentId);
          // A retry timer must finish the exact failed retirement even if no
          // subsequent user message invokes the admission path.
          for (const rolloverId of [...(pendingRetirements.get(agentId) ?? [])]) {
            await retireCompletedContextRolloverSession({ agentId, rolloverId });
          }
          authority.retryAttempt = 0;
          pruneRuntimeAuthority(agentId, authority);
          notifyScheduler();
        } catch (error) {
          retryError = error;
          if (pendingRuntimeAuthorityCount(authority) < pendingBefore) authority.retryAttempt = 0;
          logError({ err: error, agentId }, "provider runtime authority cleanup retry remains pending");
        } finally {
          authority.retryInProgress = false;
        }
        if (retryError) scheduleRuntimeAuthorityRetry(agentId);
        else pruneRuntimeAuthority(agentId, authority);
      })();
    }, delayMs);
    authority.retryTimer.unref?.();
  }

  function cancelRuntimeIdleClose(runtime: PersistentRuntime | undefined): void {
    if (!runtime) return;
    runtime.idleSince = undefined;
    if (runtime.idleTimer) {
      clearRuntimeIdleTimer(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
  }

  const runtimeTeardownNotificationKey = (agentId: string): string => `runtime-teardown:${agentId}`;

  // This is presentation of retained cleanup authority, never a replacement
  // for the handles/fences below. One episode covers continuous Agent blockage.
  const cleanupEpisodes = new Map<string, {
    key: string;
    pending: Set<object | string>;
    timer: NodeJS.Timeout;
  }>();
  const pendingRetirements = new Map<string, Set<string>>();

  function noteCleanupFailure(agentId: string, identity: object | string, projectId?: string): void {
    const existing = cleanupEpisodes.get(agentId);
    if (existing) { existing.pending.add(identity); return; }
    const key = `runtime-cleanup-status:${agentId}:${randomUUID()}`;
    const pending = new Set([identity]);
    const timer = setRuntimeAuthorityRetryTimer(() => {
      if (isClosed() || cleanupEpisodes.get(agentId)?.key !== key || !pending.size) return;
      try {
        createOperationalNotification({
          dedupeKey: key,
          informational: true,
          category: "system",
          severity: "info",
          title: "Automatic cleanup is still blocked",
          body: "New provider work for this Agent is waiting for its previous process to exit. Ponderosa is retrying automatically. No user action is required; Agent activity has recovery details.",
          projectId,
          agentId,
          action: { kind: "open_agent", targetId: agentId },
        });
      } catch { /* retained process authority remains the admission barrier */ }
    }, 60_000);
    timer.unref?.();
    cleanupEpisodes.set(agentId, { key, pending, timer });
  }

  function resolveCleanupFailure(agentId: string, identity: object | string): void {
    const episode = cleanupEpisodes.get(agentId);
    if (!episode) return;
    episode.pending.delete(identity);
    if (episode.pending.size) return;
    clearRuntimeAuthorityRetryTimer(episode.timer);
    cleanupEpisodes.delete(agentId);
    try { resolveOperationalNotification(episode.key); }
    catch { /* observed process exit remains authoritative */ }
  }

  function resolveRetiredSessionNotice(agentId: string, runtime: PersistentRuntime): void {
    try {
      const sessionId = readProviderSessionIdentifier(runtime.session);
      const rollover = coordinationV3.contextRolloverOwnerForOldSession(agentId, sessionId);
      if (rollover?.agentId !== agentId || rollover.state !== "completed"
        || rollover.completionReason !== "no_continuation_required") return;
      resolveOperationalNotification(`context-rollover:${rollover.id}:session-retirement`);
    } catch { /* notification projection cannot undo observed old-session exit */ }
  }

  function detachPersistentRuntime(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
    projectId?: string,
  ): PersistentRuntimeTeardown {
    cancelRuntimeIdleClose(runtime);
    const authority = runtimeAuthority(agentId, true)!;
    if (authority.reusable === runtime) authority.reusable = undefined;
    const existing = authority.closing;
    if (existing && existing.runtime !== runtime) {
      throw new Error(`cannot replace ${agentId} runtime while its previous process group is not confirmed terminated`);
    }
    if (existing) {
      existing.reason = reason;
      existing.projectId ??= projectId;
      return existing;
    }
    const state: PersistentRuntimeTeardown = { runtime, reason, projectId };
    authority.closing = state;
    return state;
  }

  function teardownPersistentRuntime(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
    projectId = store.getAgent(agentId)?.projectId,
  ): Promise<void> {
    const state = detachPersistentRuntime(agentId, runtime, reason, projectId);
    if (state.operation) return state.operation;
    state.lastError = undefined;
    const operation = Promise.resolve()
      .then(() => runtime.session.close())
      .then(() => {
        const authority = runtimeAuthority(agentId);
        if (authority?.closing === state) {
          authority.closing = undefined;
          clearRuntimeAuthorityRetryIfUnblocked(authority, agentId);
          pruneRuntimeAuthority(agentId, authority);
        }
        resolveCleanupFailure(agentId, state);
        resolveRetiredSessionNotice(agentId, runtime);
        try { if (!cleanupEpisodes.has(agentId)) resolveOperationalNotification(runtimeTeardownNotificationKey(agentId)); }
        catch { /* successful authority revocation remains authoritative */ }
        notifyScheduler();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        state.lastError = message;
        noteCleanupFailure(agentId, state, state.projectId);
        scheduleRuntimeAuthorityRetry(agentId);
        throw error;
      })
      .finally(() => {
        if (state.operation === operation) state.operation = undefined;
      });
    state.operation = operation;
    return operation;
  }

  async function reconcileAgentRuntimeAuthority(agentId: string): Promise<void> {
    const pending = closingRuntime(agentId);
    if (pending) await teardownPersistentRuntime(agentId, pending.runtime, pending.reason, pending.projectId);
    const opening = openingRuntime(agentId);
    if (opening) {
      await opening.operation.catch(() => undefined);
      if (openingRuntime(agentId) === opening && opening.handle && !opening.terminationConfirmed) {
        await teardownOpeningRuntime(agentId, opening, "provider readiness cleanup retry");
      }
      if (openingRuntime(agentId) === opening) {
        throw new Error(`provider runtime readiness cleanup remains pending for ${agentId}`);
      }
    }

    const oneShots = [...(runtimeAuthority(agentId)?.oneShots.values() ?? [])];
    const results = await Promise.allSettled(oneShots.map((state) =>
      teardownOneShotRuntime(state, "successor Run admission")
    ));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) {
      throw new AggregateError(failures, `provider runtime cleanup remains pending for ${agentId}`);
    }

    const reusable = reusableRuntime(agentId);
    if (reusable) {
      let alive = false;
      try { alive = reusable.session.isAlive(); } catch { /* a failed liveness check fails isClosed() */ }
      if (!alive) {
        await teardownPersistentRuntime(agentId, reusable, "dead reusable session rejected before Run admission");
      }
    }
  }

  async function retireCompletedContextRolloverSession(input: {
    agentId: string;
    projectId?: string;
    rolloverId?: string;
    providerSessionGeneration?: string;
  }): Promise<boolean> {
    const candidateSessionIds = new Set<string>();
    const acceptedSession = store.resumeSessionState(input.agentId);
    if (acceptedSession?.sessionId) candidateSessionIds.add(acceptedSession.sessionId);
    for (const runtime of [reusableRuntime(input.agentId), closingRuntime(input.agentId)?.runtime]) {
      if (!runtime) continue;
      try { candidateSessionIds.add(readProviderSessionIdentifier(runtime.session)); }
      catch { /* an unreadable retained runtime remains fenced by runtime authority */ }
    }

    const explicitRollover = input.rolloverId
      ? coordinationV3.contextRollover(input.rolloverId)
      : input.providerSessionGeneration
      ? coordinationV3.contextRolloverOwnerForGeneration(
          input.agentId,
          input.providerSessionGeneration,
        )
      : undefined;
    const rollover = explicitRollover ?? [...candidateSessionIds]
      .map((sessionId) => coordinationV3.contextRolloverOwnerForOldSession(input.agentId, sessionId))
      .find((candidate) => candidate?.state === "completed"
        && candidate.completionReason === "no_continuation_required");
    if (!rollover
      || rollover.agentId !== input.agentId
      || rollover.state !== "completed"
      || rollover.completionReason !== "no_continuation_required") return false;

    if (input.providerSessionGeneration
      && rollover.providerSessionGeneration !== input.providerSessionGeneration) {
      logError({
        classification: "context_rollover_generation_conflict",
        agentId: input.agentId,
        rolloverId: rollover.id,
      }, "completed context rollover does not own the provider session generation");
      throw new Error("context_rollover_generation_conflict");
    }

    const notificationKey = `context-rollover:${rollover.id}:session-retirement`;
    try {
      if (rollover.handoffEventId && !rollover.continuityWaiting) {
        const consumed = store.consumeContinuationHandoff(
          input.agentId,
          rollover.handoffEventId,
          rollover.sourceRunId,
        );
        if (!consumed) throw new Error("continuation handoff could not be consumed");
      }
      const currentAcceptedSession = store.resumeSessionState(input.agentId);
      if (currentAcceptedSession?.sessionId === rollover.oldProviderSessionId) {
        clearAgentResumeSession(input.agentId, "request_context_rollover");
      }
      scheduledSessionRollovers.delete(input.agentId);
      organizationEnvelopeStates.delete(input.agentId);

      const matchingRuntimes = new Map<object, PersistentRuntime>();
      for (const runtime of [reusableRuntime(input.agentId), closingRuntime(input.agentId)?.runtime]) {
        if (!runtime) continue;
        let sessionId: string | undefined;
        try { sessionId = readProviderSessionIdentifier(runtime.session); }
        catch { /* teardown authority below remains the fail-closed boundary */ }
        if (sessionId === rollover.oldProviderSessionId) matchingRuntimes.set(runtime.identity, runtime);
      }
      for (const runtime of matchingRuntimes.values()) {
        const run = activeRuns.get(input.agentId);
        if (run?.persistentRuntimeIdentity === runtime.identity) {
          run.persistentRuntimeIdentity = undefined;
        }
        await teardownPersistentRuntime(
          input.agentId,
          runtime,
          "completed context rollover retirement",
          input.projectId,
        );
      }
      pendingRetirements.get(input.agentId)?.delete(rollover.id);
      if (!pendingRetirements.get(input.agentId)?.size) pendingRetirements.delete(input.agentId);
      const authority = runtimeAuthority(input.agentId);
      if (authority) {
        clearRuntimeAuthorityRetryIfUnblocked(authority, input.agentId);
        pruneRuntimeAuthority(input.agentId, authority);
      }
      resolveCleanupFailure(input.agentId, notificationKey);
      try { if (!cleanupEpisodes.has(input.agentId)) resolveOperationalNotification(runtimeTeardownNotificationKey(input.agentId)); }
      catch { /* durable session fencing remains authoritative */ }
      try { resolveOperationalNotification(notificationKey); }
      catch { /* durable session fencing remains authoritative */ }
      return true;
    } catch (error) {
      logError({
        err: error,
        classification: "context_rollover_session_retirement_failed",
        agentId: input.agentId,
        rolloverId: rollover.id,
      }, "completed context rollover session retirement remains pending");
      const retirements = pendingRetirements.get(input.agentId) ?? new Set<string>();
      retirements.add(rollover.id);
      pendingRetirements.set(input.agentId, retirements);
      noteCleanupFailure(input.agentId, notificationKey, input.projectId ?? store.getAgent(input.agentId)?.projectId);
      scheduleRuntimeAuthorityRetry(input.agentId);
      throw new Error("context_rollover_session_retirement_failed");
    }
  }

  function persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined {
    return reusableRuntime(agentId) ?? closingRuntime(agentId)?.runtime;
  }

  function teardownPersistentRuntimeInBackground(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
  ): void {
    void teardownPersistentRuntime(agentId, runtime, reason).catch((error) => {
      logError({ err: error, agentId, reason }, "persistent runtime termination remains pending");
    });
  }

  function teardownOpeningRuntime(
    agentId: string,
    state: OpeningPersistentRuntime,
    reason: string,
  ): Promise<void> {
    if (!state.handle || state.terminationConfirmed) return Promise.resolve();
    if (state.terminationOperation) return state.terminationOperation;
    state.lastError = undefined;
    const operation = Promise.resolve()
      .then(() => state.handle!.close())
      .then(() => {
        state.terminationConfirmed = true;
        const authority = runtimeAuthority(agentId);
        if (state.settled && authority?.opening === state) {
          authority.opening = undefined;
          clearRuntimeAuthorityRetryIfUnblocked(authority, agentId);
          pruneRuntimeAuthority(agentId, authority);
        }
        resolveCleanupFailure(agentId, state);
        try { if (!cleanupEpisodes.has(agentId)) resolveOperationalNotification(runtimeTeardownNotificationKey(agentId)); }
        catch { /* observed process-group exit remains authoritative */ }
        notifyScheduler();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        state.lastError = message;
        logError({ err: error, agentId, reason }, "opening provider cleanup remains pending");
        noteCleanupFailure(agentId, state, state.projectId);
        scheduleRuntimeAuthorityRetry(agentId);
        throw error;
      })
      .finally(() => {
        if (state.terminationOperation === operation) state.terminationOperation = undefined;
      });
    state.terminationOperation = operation;
    return operation;
  }

  function teardownOneShotRuntime(state: OneShotRuntimeTeardown, reason: string): Promise<void> {
    if (state.terminationConfirmed) return Promise.resolve();
    if (state.operation) return state.operation;
    state.lastError = undefined;
    const operation = Promise.resolve()
      .then(() => state.handle.close())
      .then(() => {
        state.terminationConfirmed = true;
        const authority = runtimeAuthority(state.agentId);
        if (authority?.oneShots.get(state.runId) === state) {
          authority.oneShots.delete(state.runId);
          clearRuntimeAuthorityRetryIfUnblocked(authority, state.agentId);
          pruneRuntimeAuthority(state.agentId, authority);
        }
        resolveCleanupFailure(state.agentId, state);
        try { if (!cleanupEpisodes.has(state.agentId)) resolveOperationalNotification(runtimeTeardownNotificationKey(state.agentId)); }
        catch { /* observed process-group exit remains authoritative */ }
        try { resolveOperationalNotification(`provider-run-cleanup:${state.runId}`); }
        catch { /* observed process-group exit remains authoritative */ }
        notifyScheduler();
      })
      .catch((error: unknown) => {
        state.lastError = error instanceof Error ? error.message : String(error);
        logError({ err: error, agentId: state.agentId, runId: state.runId, reason }, "provider Run cleanup remains pending");
        noteCleanupFailure(state.agentId, state, state.projectId);
        scheduleRuntimeAuthorityRetry(state.agentId);
        throw error;
      })
      .finally(() => {
        if (state.operation === operation) state.operation = undefined;
      });
    state.operation = operation;
    return operation;
  }

  function persistentRootExited(agentId: string, identity: object, detail?: ProviderRootExitDetail): void {
    const authority = runtimeAuthority(agentId);
    const runtime = authority?.reusable;
    const matchedReusable = runtime?.identity === identity;
    const opening = authority?.opening;
    const matchedOpening = opening?.identity === identity;
    const run = activeRuns.get(agentId);
    const matchedRun = Boolean(
      run
      && run.persistentRuntimeIdentity === identity
      && ownsActiveRunForAuditDrain(agentId, run),
    );
    // Capture the exact identity and already-recorded host teardown reason
    // before root-exit cleanup mutates runtime authority. An exit alone does
    // not establish who initiated it (including the historical Richmond case).
    const closing = authority?.closing;
    let auditPersistenceFailed = false;
    const observedHostOperation = closing?.runtime.identity === identity ? closing.reason : undefined;
    const observedProcess = matchedReusable ? runtime?.session.processIdentity
      : matchedOpening ? opening?.handle?.processIdentity
      : matchedRun ? run?.runtimeSession?.processIdentity : undefined;

    // The provider process is the authority behind its opaque resumable
    // session. Once that process exits, the persisted session id must not be
    // offered to a replacement process. This applies to active, opening, and
    // warm-idle runtimes; stale callbacks from superseded identities do not
    // affect the current session generation.
    if (matchedReusable || matchedOpening || matchedRun) {
      scheduledSessionRollovers.delete(agentId);
      try { clearAgentResumeSession(agentId, "provider_root_exit"); }
      catch (error) {
        if (!(error instanceof AgentEventPersistenceError)) throw error;
        auditPersistenceFailed = true;
        logError({ agentId, persistenceFailure: error.diagnostic }, "provider root exit could not clear failed Agent audit projection");
      }
      organizationEnvelopeStates.delete(agentId);
    }

    if (runtime && matchedReusable) {
      // Detach before checking Run ownership. An idle or second-turn crash must
      // never leave this dead process eligible for later reuse.
      teardownPersistentRuntimeInBackground(agentId, runtime, "provider root exited");
    }
    if (opening && matchedOpening && opening.handle && !opening.terminationConfirmed) {
      void teardownOpeningRuntime(agentId, opening, "provider root exited during readiness").catch((error) => {
        logError({ err: error, agentId }, "opening provider root-exit cleanup remains pending");
      });
    }

    if (!run || !matchedRun) return;
    // A pre-sampling retry deliberately retires this exact runtime and awaits
    // its exit before replacement. That host-owned close must retain the Run;
    // unexpected exits still revoke its authority below.
    if (observedHostOperation === "failed resume replacement") return;
    transitionRun(agentId, run, "cancelling");
    void closeRunBrowser(agentId, run, "persistent_provider_root_exited");
    closeLinkPreviewsForAgent(agentId, "persistent provider root exited");
    agentMessageCapabilities.delete(run.messageCapability);
    clearRunLeaseTimer(run);
    clearRunLivenessTimer(run);
    run.controller.abort();
    try {
      const lifecycle = store.appendEvent(agentId, {
        type: "agent_lifecycle", status: "failed", reason: "runtime_error", executionId: run.executionId,
        runtimeObservation: runtimeObservation(run, observedProcess, detail, observedHostOperation),
      });
      publish(agentId, lifecycle);
    } catch (error) {
      if (!(error instanceof AgentEventPersistenceError)) throw error;
      auditPersistenceFailed = true;
      logError({ agentId, runId: run.executionId, persistenceFailure: error.diagnostic },
        "provider root exit audit failed; retaining scheduler settlement authority");
    }
    try {
      const promptInjectionState = coordinationV3.agentSnapshot(agentId).activeRun?.promptInjectionState ?? "not_injected";
      coordinationV3.failRun({
        runId: run.v3SchedulerRunId!,
        fencingToken: run.v3FencingToken!,
        workerId: coordinationV3WorkerId,
        sameRunResumable: false,
        retryable: !auditPersistenceFailed,
        error: "persistent provider root exited",
        failureDetail: {
          phase: promptInjectionState === "not_injected" ? "before_prompt_submission" : "provider_execution",
          promptInjectionState,
          ...detail,
          message: "persistent provider root exited",
        },
      });
    } catch { /* cancellation/deletion may already have advanced the fence */ }
    publishMessageDeliveryChanged(agentId);
    notifyScheduler();
  }

  async function drainProviderRuntimeAuthority(
    reason: string,
    agentIds?: ReadonlySet<string>,
  ): Promise<void> {
    const relevant = (agentId: string): boolean => !agentIds || agentIds.has(agentId);
    for (const [agentId, authority] of runtimeAuthorities) {
      if (relevant(agentId)) clearRuntimeAuthorityRetry(authority);
    }
    for (let pass = 0; pass < 100; pass += 1) {
      // Revoke capabilities and cancellation authority before awaiting any
      // opening operation. An adapter that returns late is then routed through
      // retained teardown instead of becoming reusable.
      const activeSnapshot = [...activeRuns].filter(([agentId]) => relevant(agentId));
      for (const [agentId, run] of activeSnapshot) {
        agentMessageCapabilities.delete(run.messageCapability);
        clearRunLeaseTimer(run);
        clearRunLivenessTimer(run);
        run.controller.abort();
        void closeRunBrowser(agentId, run, reason).catch((error) => {
          logError({ err: error, agentId, reason }, "Run browser cleanup failed during provider drain");
        });
      }

      const openingSnapshot = [...runtimeAuthorities].flatMap(([agentId, authority]) =>
        authority.opening && (relevant(agentId) || (!agentIds && Boolean(authority.opening.projectId)))
          ? [[agentId, authority.opening] as const]
          : []
      );
      // A registered spawn-time handle is actionable before readiness settles.
      // Close it first so a stalled initialize/thread-open request cannot hold
      // deletion or shutdown hostage through its own unresolved Promise.
      const spawnedOpeningEntries = openingSnapshot.filter(([, opening]) =>
        opening.handle && !opening.terminationConfirmed
      );
      const spawnedTerminationResults = await Promise.allSettled(spawnedOpeningEntries.map(([agentId, opening]) =>
        teardownOpeningRuntime(agentId, opening, reason)
      ));
      const spawnedTerminationFailures = spawnedTerminationResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [new Error(`${spawnedOpeningEntries[index]![0]} opening provider runtime did not terminate: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`)]
          : []
      );
      if (spawnedTerminationFailures.length) {
        throw new AggregateError(spawnedTerminationFailures, "Provider runtime authority drain did not complete");
      }
      // Rejections here are expected for opens fenced by cancellation. If a
      // ready runtime failed to close, its handle remains in the Agent's
      // closing authority slot. A
      // readiness failure retains its spawn-time handle directly on the opening
      // state so this pass can retry it without relying on Adapter success.
      await Promise.allSettled(openingSnapshot.map(([, opening]) => opening.operation));
      const openingTerminationEntries = openingSnapshot.filter(([, opening]) =>
        opening.settled && opening.handle && !opening.terminationConfirmed
      );
      const openingTerminationResults = await Promise.allSettled(openingTerminationEntries.map(([agentId, opening]) =>
        teardownOpeningRuntime(agentId, opening, reason)
      ));
      const openingTerminationFailures = openingTerminationResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [new Error(`${openingTerminationEntries[index]![0]} opening provider runtime did not terminate: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`)]
          : []
      );
      if (openingTerminationFailures.length) {
        throw new AggregateError(openingTerminationFailures, "Provider runtime authority drain did not complete");
      }

      const completionSnapshot = [...activeRuns].filter(([agentId]) => relevant(agentId));
      const oneShotEntries = [...runtimeAuthorities].flatMap(([agentId, authority]) =>
        relevant(agentId) ? [...authority.oneShots.values()] : []
      );
      const runtimes = new Map<string, PersistentRuntime>();
      for (const [agentId, authority] of runtimeAuthorities) {
        if (!relevant(agentId)) continue;
        if (authority.closing) runtimes.set(agentId, authority.closing.runtime);
        if (authority.reusable) runtimes.set(agentId, authority.reusable);
      }
      const runtimeEntries = [...runtimes];
      // Persistent event loops often settle only after session.close(). Start
      // their teardown and the active Run completion barriers together.
      const completionOperation = Promise.allSettled(completionSnapshot.map(([, run]) =>
        run.completion ?? Promise.reject(new Error("active provider Run has no completion barrier"))
      ));
      const terminationResults = await Promise.allSettled([
        ...runtimeEntries.map(([agentId, runtime]) => teardownPersistentRuntime(agentId, runtime, reason)),
        ...oneShotEntries.map((state) => teardownOneShotRuntime(state, reason)),
      ]);
      const terminationFailures = terminationResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [new Error(`${index < runtimeEntries.length ? runtimeEntries[index]![0] : oneShotEntries[index - runtimeEntries.length]!.agentId} provider runtime did not terminate: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`)]
          : []
      );
      // A failed persistent close may intentionally leave its event loop live.
      // Preserve that completion handle and report the retained teardown now;
      // a later retry will close the process and then await completion.
      if (terminationFailures.length) {
        void completionOperation;
        throw new AggregateError(terminationFailures, "Provider runtime authority drain did not complete");
      }
      const completionResults = await completionOperation;
      const completionFailures = completionResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [new Error(`${completionSnapshot[index]![0]} provider Run did not terminate: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`)]
          : []
      );
      completionResults.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const [agentId, run] = completionSnapshot[index]!;
        if (activeRuns.get(agentId) === run) activeRuns.delete(agentId);
      });

      if (completionFailures.length) {
        throw new AggregateError(
          completionFailures,
          "Provider runtime authority drain did not complete",
        );
      }

      const pending = [...activeRuns.keys()].some(relevant) || [...runtimeAuthorities].some(([agentId, authority]) =>
        relevant(agentId) && Boolean(authority.opening || authority.reusable || authority.closing || authority.oneShots.size)
      );
      if (!pending) return;
    }
    throw new Error("Provider runtime authority drain did not reach a fixed point");
  }

  function trimIdleRuntimeSessions(): void {
    const idle = [...runtimeAuthorities].flatMap(([agentId, authority]) => authority.reusable
      ? [[agentId, authority.reusable] as const]
      : [])
      .filter(([agentId, runtime]) => !activeRuns.has(agentId) && runtime.idleSince !== undefined)
      .sort((left, right) => left[1].idleSince! - right[1].idleSince!);
    for (const [agentId, runtime] of idle.slice(0, Math.max(0, idle.length - runtimeMaxIdleSessions))) {
      teardownPersistentRuntimeInBackground(agentId, runtime, "warm-pool eviction");
    }
  }

  function scheduleRuntimeIdleClose(agentId: string, runtime: PersistentRuntime): void {
    cancelRuntimeIdleClose(runtime);
    runtime.idleSince = runtimeSessionNow();
    runtime.idleTimer = setRuntimeIdleTimer(() => {
      if (isClosed() || activeRuns.has(agentId) || reusableRuntime(agentId) !== runtime) return;
      teardownPersistentRuntimeInBackground(agentId, runtime, "idle timeout");
    }, runtimeIdleTtlMs);
    runtime.idleTimer.unref?.();
    trimIdleRuntimeSessions();
  }

  const ownsV3Run = (run: ActiveRun): boolean => {
    if (!run.v3SchedulerRunId || run.v3FencingToken === undefined) return false;
    try {
      return coordinationV3.ownsRun(run.v3SchedulerRunId, run.v3FencingToken, coordinationV3WorkerId);
    } catch {
      return false;
    }
  };

  const runAuthorization = (capability: AgentMessageCapability) => ({
    runId: capability.v3SchedulerRunId,
    agentId: capability.agentId,
    fencingToken: capability.v3FencingToken,
  });

  const capabilityOwnsAuthoritativeRun = (capability: AgentMessageCapability, run: ActiveRun | undefined): boolean => Boolean(
    run && run.runId === capability.runId && run.messageCapability &&
    run.v3SchedulerRunId === capability.v3SchedulerRunId &&
    run.v3FencingToken === capability.v3FencingToken &&
    coordinationV3.ownsRun(capability.v3SchedulerRunId, capability.v3FencingToken, coordinationV3WorkerId),
  );

  const capabilityMatchesCleanupRun = (capability: AgentMessageCapability, run: ActiveRun | undefined): boolean => Boolean(
    run && run.runId === capability.runId && run.messageCapability &&
    run.v3SchedulerRunId === capability.v3SchedulerRunId &&
    run.v3FencingToken === capability.v3FencingToken &&
    (coordinationV3.ownsRunForCleanup(capability.v3SchedulerRunId, capability.v3FencingToken, coordinationV3WorkerId) ||
      coordinationV3.ownsOutcomeUnknownRun(capability.v3SchedulerRunId, capability.v3FencingToken, coordinationV3WorkerId)),
  );

  function ownsActiveRun(agentId: string, run: ActiveRun): boolean {
    return activeRuns.get(agentId) === run && ownsV3Run(run);
  }

  /** Provider-facing mutations stop as soon as the scheduler fences side
   * effects, while the host keeps this exact local Run long enough to persist
   * provider events that were already emitted and its terminal audit record. */
  function ownsActiveRunForAuditDrain(agentId: string, run: ActiveRun): boolean {
    return activeRuns.get(agentId) === run && Boolean(
      run.v3SchedulerRunId && run.v3FencingToken !== undefined &&
      coordinationV3.ownsRunForCleanup(
        run.v3SchedulerRunId,
        run.v3FencingToken,
        coordinationV3WorkerId,
      ),
    );
  }

  return {
    cancelRuntimeIdleClose,
    capabilityMatchesCleanupRun,
    capabilityOwnsAuthoritativeRun,
    clearRuntimeAuthorityRetry,
    clearRuntimeAuthorityRetryIfUnblocked,
    detachPersistentRuntime,
    drainProviderRuntimeAuthority,
    ownsActiveRun,
    ownsActiveRunForAuditDrain,
    ownsV3Run,
    pendingRuntimeAuthorityCount,
    persistentRootExited,
    persistentRuntimeForTermination,
    reconcileAgentRuntimeAuthority,
    retireCompletedContextRolloverSession,
    runAuthorization,
    scheduleRuntimeAuthorityRetry,
    scheduleRuntimeIdleClose,
    teardownOneShotRuntime,
    teardownOpeningRuntime,
    teardownPersistentRuntime,
    teardownPersistentRuntimeInBackground,
    trimIdleRuntimeSessions,
  };
}
