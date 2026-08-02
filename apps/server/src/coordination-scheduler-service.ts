import type { CommunicationEvent } from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { AssetStore } from "./assets.js";
import {
  type ActiveRun,
  type AgentMessageCapability,
  type AgentRuntimeAuthority,
  type CreateServerOptions,
  type PersistentRuntime,
  type PonderosaServer,
} from "./app-contracts.js";
import { CoordinationV3Scheduler } from "./coordination-v3-scheduler.js";
import type { createCommunicationArtifactAuthority } from "./communication-artifacts.js";
import type { EngineAvailabilityStore } from "./engine-availability-store.js";
import type { QueuedEditRevisionOutboxPayload } from "./routes/queued-messages.js";

type ArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface CoordinationSchedulerContext {
  opts: CreateServerOptions;
  store: AgentStore;
  assets: AssetStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  activeRuns: Map<string, ActiveRun>;
  runtimeAuthorities: Map<string, AgentRuntimeAuthority>;
  engineAvailability: EngineAvailabilityStore;
  agentMessageCapabilities: Map<string, AgentMessageCapability>;
  scheduledSessionRollovers: Map<string, string>;
  coordinationV3WorkerId: string;
  coordinationV3LeaseMs: number;
  v3DispatchKey: string;
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  closeLinkPreviewsForAgent(agentId: string, reason: string): void;
  providerEnabled(engineId: string): boolean;
  reconcileTriggerOperationalNotifications(): void;
  terminateRuntimeHandle(
    agentId: string,
    run: ActiveRun | undefined,
    runtime: PersistentRuntime | undefined,
    reason?: string,
    projectId?: string,
  ): Promise<string | undefined>;
  closeRunBrowser(agentId: string, run: ActiveRun, reason: string): Promise<void>;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  clearRunLeaseTimer(run: ActiveRun): void;
  clearRunLivenessTimer(run: ActiveRun): void;
  renewExecutionLease(agentId: string, run: ActiveRun): boolean;
  publishCoordinationV3Changed(
    agentId: string,
    options?: { publishWorkspaceEvent?: boolean; conversationIds?: string[] },
  ): void;
  publishMessageDeliveryChanged(agentId: string): void;
  drainDeploymentIdleAuthorities(): void;
  communicationArtifactAccess: ArtifactAuthority["communicationArtifactAccess"];
  projectCommunicationArtifact: ArtifactAuthority["projectCommunicationArtifact"];
}

export function createCoordinationScheduler(
  app: PonderosaServer,
  context: CoordinationSchedulerContext,
): CoordinationV3Scheduler {
  const {
    opts,
    store,
    assets,
    coordinationV3,
    workspace,
    activeRuns,
    runtimeAuthorities,
    engineAvailability,
    agentMessageCapabilities,
    scheduledSessionRollovers,
    coordinationV3WorkerId,
    coordinationV3LeaseMs,
    v3DispatchKey,
    appendWorkspace,
    closeLinkPreviewsForAgent,
    providerEnabled,
    reconcileTriggerOperationalNotifications,
    terminateRuntimeHandle,
    closeRunBrowser,
    persistentRuntimeForTermination,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    renewExecutionLease,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    drainDeploymentIdleAuthorities,
    communicationArtifactAccess,
    projectCommunicationArtifact,
  } = context;

return new CoordinationV3Scheduler(
  coordinationV3,
  async (lease, prompt) => {
    const activationPayloads = lease.activations
      .map((activation) => activation.payload)
      .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === "object");
    // A leased delivery is no longer editable queue state. Publish that
    // transition immediately so the composer removes it before provider
    // startup completes (or fails).
    for (const activation of lease.activations) {
      const payload = activation.payload && typeof activation.payload === "object"
        ? activation.payload as { communication?: CommunicationEvent; dispatch?: { conversationId?: string; sourceConversationId?: string } }
        : undefined;
      const communication = payload?.communication;
      if (communication?.sender.kind !== "user" || communication.sender.userId !== "local-operator") continue;
      const conversationId = payload?.dispatch?.sourceConversationId ?? payload?.dispatch?.conversationId ?? communication.conversationId;
      if (conversationId) appendWorkspace({
        type: "queued_message_changed", conversationId, deliveryId: activation.id, action: "started",
      });
    }
    const communication = activationPayloads
      .map((payload) => payload.communication)
      .find((value): value is CommunicationEvent => value !== null && typeof value === "object" && "eventId" in value);
    const dispatch = activationPayloads
      .map((payload) => payload.dispatch)
      .find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
    const managedOpeningRequest = activationPayloads
      .map((payload) => payload.request)
      .find((value): value is Record<string, unknown> =>
        Boolean(value) &&
        typeof value === "object" &&
        (value as Record<string, unknown>).managedAgentOpening === true);
    const managedOpeningRuntimeSelection =
      managedOpeningRequest?.runtimeSelection &&
      typeof managedOpeningRequest.runtimeSelection === "object"
        ? managedOpeningRequest.runtimeSelection as Record<string, unknown>
        : undefined;
    const steeringRecovery = activationPayloads
      .map((payload) => payload.steeringRecovery)
      .find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
    const recipientDispatch = Array.isArray(dispatch?.recipients)
      ? dispatch.recipients.find((value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object" && value.agentId === lease.agentId)
      : undefined;
    const dispatchAttachments = Array.isArray(recipientDispatch?.attachments)
      ? recipientDispatch.attachments
      : Array.isArray(dispatch?.attachments) ? dispatch.attachments : [];
    const reboundAttachmentIds = new Set<string>();
    for (const value of dispatchAttachments) {
      if (!value || typeof value !== "object") throw new Error("runtime attachment delivery identity is malformed");
      const expected = value as Record<string, unknown>;
      if (typeof expected.id !== "string" || reboundAttachmentIds.has(expected.id)) {
        throw new Error("runtime attachment delivery identity is duplicated or malformed");
      }
      reboundAttachmentIds.add(expected.id);
      const resolved = assets.authoritativeRuntimeAttachment(lease.projectId, lease.agentId, expected.id);
      if (!resolved || expected.name !== resolved.attachment.name ||
          expected.mediaType !== resolved.attachment.mediaType || expected.size !== resolved.byteLength ||
          expected.sha256 !== resolved.contentHash || expected.localPath !== resolved.localPath) {
        throw new Error("runtime attachment changed after scheduler admission");
      }
    }
    const attachmentIds = dispatchAttachments
      .map((value) => value && typeof value === "object" && "id" in value ? value.id : undefined)
      .filter((value): value is string => typeof value === "string");
    const originalDispatchText = typeof dispatch?.text === "string" ? dispatch.text : prompt;
    const dispatchText = typeof steeringRecovery?.instruction === "string"
      ? `${steeringRecovery.instruction}\n\nOriginal user message:\n${originalDispatchText}`
      : originalDispatchText;
    const leaseConversationId = lease.scopeKey.startsWith("conversation:")
      ? lease.scopeKey.slice("conversation:".length)
      : undefined;
    const sourceConversationId = typeof dispatch?.sourceConversationId === "string"
      ? dispatch.sourceConversationId
      : typeof dispatch?.conversationId === "string" ? dispatch.conversationId : leaseConversationId;
    const sourceChannel = dispatch?.sourceChannel === "main" ? "main" : undefined;
    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${encodeURIComponent(lease.agentId)}/messages`,
      headers: {
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
        "x-ponderosa-v3-dispatch": v3DispatchKey,
      },
      payload: {
        text: dispatchText,
        ...(typeof dispatch?.model === "string" ? { model: dispatch.model } : {}),
        ...(typeof dispatch?.effort === "string" ? { effort: dispatch.effort } : {}),
        ...(typeof dispatch?.speed === "string"
          ? { speed: dispatch.speed }
          : typeof managedOpeningRuntimeSelection?.speed === "string"
            ? { speed: managedOpeningRuntimeSelection.speed }
            : {}),
        ...(sourceConversationId ? { sourceConversationId } : {}),
        ...(sourceChannel ? { sourceChannel } : {}),
        ...(dispatch?.shareWithOrganization === true ? { shareWithOrganization: true } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        v3SchedulerRunId: lease.runId,
        v3FencingToken: lease.fencingToken,
        v3InjectionId: lease.injectionId,
        v3FreshProviderSession: coordinationV3.runStartsNewRecipientRequest(lease.runId, lease.agentId) ||
          coordinationV3.runChangesScope(lease.runId, lease.agentId),
        v3ActivationPrompt: prompt,
        ...(communication?.eventId ? { v3CommunicationEventId: communication.eventId } : {}),
      },
    });
    const accepted = response.statusCode >= 200 && response.statusCode < 300;
    const retryable = response.statusCode === 409 || response.statusCode === 429 || response.statusCode >= 500;
    return {
      accepted,
      retryable,
      ...(!accepted && !retryable ? {
        terminalOutcome: response.statusCode === 404
          ? "recipient_unavailable" as const
          : "permanent_failure" as const,
      } : {}),
      ...(accepted ? {} : { error: response.body }),
    };
  },
  {
    workerId: coordinationV3WorkerId,
    maxConcurrentRuns: opts.communicationV3?.maxConcurrentRuns ?? workspace.getPreferences().maxConcurrentAgentRuns,
    pollMs: opts.communicationV3?.pollMs,
    leaseMs: coordinationV3LeaseMs,
    maxDeliveryFailures: opts.communicationV3?.maxDeliveryFailures,
    steeringRecoveryGraceMs: opts.communicationV3?.steeringRecoveryGraceMs,
    dispatchSteering: async (lease, prompt) => {
      const run = activeRuns.get(lease.agentId);
      if (!run || run.v3SchedulerRunId !== lease.runId || run.v3FencingToken !== lease.fencingToken || !run.runtimeSession) {
        return {
          accepted: false,
          retryable: true,
          retrySteering: true,
          error: "authoritative run is not currently steerable",
        };
      }
      coordinationV3.markPromptSubmitted({
        injectionId: lease.injectionId,
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        providerSessionId: run.runtimeSession.engineAgentId,
      });
      try {
        const result = await run.runtimeSession.steer({
          prompt,
          kind: "user_message",
          clientMessageId: lease.injectionId,
        });
        if (result.status !== "accepted") {
          return {
            accepted: false,
            retryable: true,
            retrySteering: true,
            error: result.reason ?? result.status,
          };
        }
        coordinationV3.acknowledgePromptInjection({
          injectionId: lease.injectionId,
          runId: lease.runId,
          fencingToken: lease.fencingToken,
          providerTurnId: result.turnId,
          providerSessionId: run.runtimeSession.engineAgentId,
        });
        renewExecutionLease(lease.agentId, run);
        return { accepted: true };
      } catch (error) {
        return {
          accepted: false,
          outcomeUnknown: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    dispatchProviderOperation: async (operation) => {
      const entry = [...activeRuns.entries()].find(([, run]) => run.runId === operation.runId);
      if (!entry) return { accepted: true };
      const [agentId, run] = entry;
      void closeRunBrowser(agentId, run, "run_cancelled");
      closeLinkPreviewsForAgent(agentId, "run cancelled");
      clearRunLeaseTimer(run);
      clearRunLivenessTimer(run);
      agentMessageCapabilities.delete(run.messageCapability);
      if (scheduledSessionRollovers.delete(agentId)) {
        const abandonedHandoff = store.continuationHandoffForRun(agentId, run.runId);
        if (abandonedHandoff && !abandonedHandoff.consumedAt) {
          store.consumeContinuationHandoff(agentId, abandonedHandoff.id, run.runId);
        }
      }
      run.controller.abort();
      const runtime = persistentRuntimeForTermination(agentId);
      const terminationError = await terminateRuntimeHandle(agentId, run, runtime);
      if (terminationError) return { accepted: false, retryable: true, error: terminationError };
      if (activeRuns.get(agentId) === run) {
        activeRuns.delete(agentId);
        drainDeploymentIdleAuthorities();
      }
      return { accepted: true };
    },
    processOutbox: async (item) => {
      if (item.eventKind !== "communication_revision") return;
      const payload = item.payload as Partial<QueuedEditRevisionOutboxPayload> | null;
      if (!payload || typeof payload.activationId !== "string" || typeof payload.agentId !== "string"
        || typeof payload.conversationId !== "string" || !payload.revision
        || typeof payload.revision !== "object" || payload.revision.kind !== "edit") {
        throw new Error("invalid queued-edit revision outbox payload");
      }
      store.appendCommunicationRevision(payload.revision);
      await opts.messageLifecycleFaults?.afterQueuedEditRevisionAppend?.({
        activationId: payload.activationId,
        revisionId: payload.revision.eventId,
      });
      if (payload.artifact) {
        const target = store.getCommunicationEvent(payload.revision.projectId, payload.revision.targetEventId);
        if (!target) throw new Error("queued-edit artifact target Communication is unavailable");
        projectCommunicationArtifact(
          payload.revision.projectId,
          "local-operator",
          payload.artifact,
          communicationArtifactAccess(target),
        );
      }
      appendWorkspace({
        type: "queued_message_changed",
        conversationId: payload.conversationId,
        deliveryId: payload.activationId,
        action: "edited",
      });
      publishCoordinationV3Changed(payload.agentId, {
        conversationIds: [payload.conversationId],
      });
    },
    blockedAgentIds: () => [...new Set([
      ...store.listProjects().flatMap((project) =>
        store.listAgents(project.id)
          .filter((candidate) => !providerEnabled(candidate.activeEngine) || Boolean(engineAvailability.denial(candidate.activeEngine)))
          .map((candidate) => candidate.id)),
      ...[...runtimeAuthorities].flatMap(([agentId, authority]) =>
        authority.opening || authority.closing || authority.oneShots.size > 0 ? [agentId] : []),
      ...activeRuns.keys(),
    ])],
    onRunLeased: () => { reconcileTriggerOperationalNotifications(); },
    onMessageDeliveryChanged: publishMessageDeliveryChanged,
  },
);
}
