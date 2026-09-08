import type { CommunicationEvent } from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
  RuntimeArtifactV3,
  SchedulerLease,
} from "@ponderosa/agents";
import type { AssetStore } from "./assets.js";
import {
  type ActiveRun,
  type AgentMessageCapability,
  type AgentRuntimeAuthority,
  type CreateServerOptions,
  type EngineRegistration,
  type PersistentRuntime,
  type PonderosaServer,
} from "./app-contracts.js";
import { collectReachableArtifactIds } from "./artifact-refs.js";
import {
  type AutomaticResultMaterial,
  ActivationPromptCompilationError,
  compileActivationPrompt,
  CoordinationV3Scheduler,
} from "./coordination-v3-scheduler.js";
import type { createCommunicationArtifactAuthority } from "./communication-artifacts.js";
import {
  applyQueuedMessageChangeOutbox,
  type QueuedEditRevisionOutboxPayload,
} from "./routes/queued-messages.js";
import type { ProviderProcessAuthority } from "./provider-process-authority.js";
import {
  invokeProviderSteer,
  readProviderSessionIdentifier,
} from "./provider-session-success.js";

type ArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

/** One scheduler packet gets a bounded share of the provider context. Results
 * above this hard UTF-8 envelope use their already-durable, validated artifact
 * file instead of risking a provider request/context rejection. */
const AUTOMATIC_RESULT_PROVIDER_PACKET_UTF8_LIMIT = 256 * 1024;
const PROVIDER_INTAKE_CHECK_BUDGET_MS = 500;

export interface CorrelatedArtifactReference {
  artifactId: string;
  source: "structured_exact_result" | "managed_text_link" | "unrelated";
  expectedOwnerId?: string;
}

export function correlatedResultArtifactReferences(
  activation: SchedulerLease["activations"][number],
): CorrelatedArtifactReference[] {
  const payload = activation.payload && typeof activation.payload === "object"
    ? activation.payload as Record<string, unknown>
    : {};
  const references = new Map<string, CorrelatedArtifactReference>();
  const addStructured = (value: unknown, ownerId: unknown): void => {
    if (!value || typeof value !== "object") return;
    const expectedOwnerId = typeof ownerId === "string" && ownerId ? ownerId : undefined;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if ((key === "artifactId" || key === "resultRef" || key === "resultArtifactId") &&
            typeof child === "string") {
          for (const artifactId of collectReachableArtifactIds(child)) {
            const current = references.get(artifactId);
            references.set(artifactId, {
              artifactId,
              source: "structured_exact_result",
              ...((!current || current.expectedOwnerId === expectedOwnerId) && expectedOwnerId
                ? { expectedOwnerId }
                : {}),
            });
          }
        } else {
          visit(child);
        }
      }
    };
    visit(value);
  };
  if (activation.kind === "coordination_outcome") {
    addStructured(payload.update, payload.updateId);
  } else if (activation.kind === "coordination_late_result") {
    const late = payload.lateResult && typeof payload.lateResult === "object"
      ? payload.lateResult as Record<string, unknown>
      : {};
    addStructured(late.update, late.updateId);
  } else if (activation.kind.startsWith("coordination_join_")) {
    for (const item of Array.isArray(payload.outcomes) ? payload.outcomes : []) {
      const outcome = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const update = outcome.update && typeof outcome.update === "object"
        ? outcome.update as Record<string, unknown>
        : {};
      addStructured(update.payload, update.id);
    }
  } else if (
    activation.kind === "coordination_question" ||
    activation.kind === "coordination_answer" ||
    activation.kind === "coordination_dependency_resolved"
  ) {
    addStructured(payload.update, payload.updateId ?? payload.inReplyToUpdateId);
  }
  const serializedPayload = JSON.stringify(payload);
  for (const artifactId of collectReachableArtifactIds(payload)) {
    if (references.has(artifactId)) continue;
    references.set(artifactId, {
      artifactId,
      source: serializedPayload.includes(`ponderosa://artifact/${artifactId}`)
        ? "managed_text_link"
        : "unrelated",
    });
  }
  return [...references.values()];
}

export async function resolveCoordinationResultArtifacts(input: {
  activation: SchedulerLease["activations"][number];
  projectId: string;
  runtimeArtifact(artifactId: string): RuntimeArtifactV3 | undefined;
  authoritative(artifact: RuntimeArtifactV3): Promise<{
    byteLength: number;
    contentHash: string;
    body: Buffer;
    localPath: string;
  } | undefined>;
}): Promise<AutomaticResultMaterial[]> {
  if (!input.activation.kind.startsWith("coordination_")) return [];
  const references = correlatedResultArtifactReferences(input.activation);
  const materials: AutomaticResultMaterial[] = [];
  for (const reference of references) {
    if (reference.source !== "structured_exact_result") continue;
    const artifact = input.runtimeArtifact(reference.artifactId);
    if (!artifact || artifact.ownerKind !== "request_update" || artifact.projectId !== input.projectId ||
        !reference.expectedOwnerId || artifact.ownerId !== reference.expectedOwnerId) {
      throw new ActivationPromptCompilationError({
        code: "exact_artifact_contract_mismatch",
        activation: input.activation,
      });
    }
    const authoritative = await input.authoritative(artifact);
    if (!authoritative) {
      throw new ActivationPromptCompilationError({
        code: "correlated_artifact_unavailable",
        activation: input.activation,
      });
    }
    materials.push({
      artifactId: reference.artifactId,
      title: artifact.title,
      mediaType: artifact.mediaType,
      byteLength: authoritative.byteLength,
      sha256: authoritative.contentHash,
      content: authoritative.body.toString("utf8"),
      localPath: authoritative.localPath,
    });
  }
  return materials;
}

interface CoordinationSchedulerContext {
  opts: CreateServerOptions;
  store: AgentStore;
  assets: AssetStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  activeRuns: Map<string, ActiveRun>;
  runtimeAuthorities: Map<string, AgentRuntimeAuthority>;
  deletingAgentIds: ReadonlySet<string>;
  engines: ReadonlyMap<string, EngineRegistration>;
  runtimeStatus(
    id: string,
    registration: EngineRegistration,
  ): Promise<{ intakeReady: boolean }>;
  agentMessageCapabilities: Map<string, AgentMessageCapability>;
  scheduledSessionRollovers: Map<string, string>;
  coordinationV3WorkerId: string;
  coordinationV3LeaseMs: number;
  v3DispatchKey: string;
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  closeLinkPreviewsForAgent(agentId: string, reason: string): void;
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
  providerProcessAuthority: ProviderProcessAuthority;
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
    deletingAgentIds,
    engines,
    runtimeStatus,
    agentMessageCapabilities,
    scheduledSessionRollovers,
    coordinationV3WorkerId,
    coordinationV3LeaseMs,
    v3DispatchKey,
    appendWorkspace,
    closeLinkPreviewsForAgent,
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
    providerProcessAuthority,
  } = context;

return new CoordinationV3Scheduler(
  coordinationV3,
  async (lease, prompt) => {
    const activationPayloads = lease.activations
      .map((activation) => activation.payload)
      .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === "object");
    // A leased delivery is preparing and no longer editable queue state.
    // Started is reserved for the durable provider-submission boundary.
    for (const activation of lease.activations) {
      const payload = activation.payload && typeof activation.payload === "object"
        ? activation.payload as { communication?: CommunicationEvent; dispatch?: { conversationId?: string; sourceConversationId?: string } }
        : undefined;
      const communication = payload?.communication;
      if (communication?.sender.kind !== "user" || communication.sender.userId !== "local-operator") continue;
      const conversationId = payload?.dispatch?.sourceConversationId ?? payload?.dispatch?.conversationId ?? communication.conversationId;
      if (conversationId) appendWorkspace({
        type: "queued_message_changed", conversationId, deliveryId: activation.id, action: "preparing",
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
        ...(typeof dispatch?.engine === "string" ? { engine: dispatch.engine } : {}),
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
      try {
        const providerSessionId = readProviderSessionIdentifier(run.runtimeSession);
        coordinationV3.markPromptSubmitted({
          injectionId: lease.injectionId,
          runId: lease.runId,
          fencingToken: lease.fencingToken,
          providerSessionId,
        });
        const result = await invokeProviderSteer(run.runtimeSession, {
          prompt,
          kind: "user_message",
          clientMessageId: lease.injectionId,
        });
        if (result.status !== "accepted") {
          return {
            accepted: false,
            retryable: true,
            retrySteering: true,
            error: result.status,
          };
        }
        coordinationV3.acknowledgePromptInjection({
          injectionId: lease.injectionId,
          runId: lease.runId,
          fencingToken: lease.fencingToken,
          providerTurnId: result.turnId,
          providerSessionId,
        });
        renewExecutionLease(lease.agentId, run);
        return { accepted: true };
      } catch (error) {
        return {
          accepted: false,
          outcomeUnknown: true,
          error: "provider steering failed",
        };
      }
    },
    compilePrompt: async (lease, { signal, deadlineAt, setPreparingActivation }) => {
      const materials = new Map<string, AutomaticResultMaterial[]>();
      for (const activation of lease.activations) {
        signal.throwIfAborted();
        setPreparingActivation(activation);
        try {
          materials.set(activation.id, await resolveCoordinationResultArtifacts({
            activation,
            projectId: lease.projectId,
            runtimeArtifact: artifactId => coordinationV3.runtimeArtifact(artifactId),
            authoritative: artifact => assets.authoritativeRuntimeArtifactAsync(
              lease.projectId,
              artifact,
              signal,
            ),
          }));
        } catch (error) {
          if (signal.aborted || Date.now() >= deadlineAt) {
            throw new ActivationPromptCompilationError({
              code: "activation_prompt_invalid",
              activation,
              detail: "preparation_watchdog_exceeded",
            });
          }
          throw error;
        } finally {
          setPreparingActivation();
        }
      }
      signal.throwIfAborted();
      return compileActivationPrompt(lease, {
        maxUtf8Bytes: AUTOMATIC_RESULT_PROVIDER_PACKET_UTF8_LIMIT,
        signal,
        deadlineAt,
        resolveResultArtifacts: activation => materials.get(activation.id) ?? [],
      });
    },
    dispatchProviderOperation: async (operation) => {
      const entry = [...activeRuns.entries()].find(([, run]) => run.runId === operation.runId);
      if (!entry) {
        try {
          await providerProcessAuthority.terminateRun(operation.runId);
          return { accepted: true };
        } catch (error) {
          return { accepted: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
        }
      }
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
      try { await providerProcessAuthority.terminateRun(operation.runId); }
      catch (error) {
        return { accepted: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
      }
      if (activeRuns.get(agentId) === run) {
        activeRuns.delete(agentId);
        drainDeploymentIdleAuthorities();
      }
      return { accepted: true };
    },
    processOutbox: async (item) => {
      if (item.eventKind === "queued_message_change") {
        applyQueuedMessageChangeOutbox(item, {
          coordinationV3,
          workspace,
          appendWorkspace,
          publishCoordinationV3Changed,
        });
        return;
      }
      if (item.eventKind !== "communication_revision") return;
      const payload = item.payload as Partial<QueuedEditRevisionOutboxPayload> | null;
      if (!payload || typeof payload.activationId !== "string" || typeof payload.agentId !== "string"
        || typeof payload.conversationId !== "string" || !payload.revision
        || typeof payload.revision !== "object" || payload.revision.kind !== "edit") {
        throw new Error("invalid queued-edit revision outbox payload");
      }
      store.appendCommunicationRevision(payload.revision);
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
    blockedAgentIds: async () => {
      const intake = new Map(await Promise.all([...engines.entries()].map(async ([id, registration]) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("runtime intake check exceeded scheduler admission budget")),
              PROVIDER_INTAKE_CHECK_BUDGET_MS,
            );
            timer.unref?.();
          });
          const status = await Promise.race([runtimeStatus(id, registration), timeout]);
          return [id, status.intakeReady] as const;
        } catch {
          return [id, false] as const;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })));
      return [...new Set([
        ...store.listAgentEngineAssignments()
          .filter((candidate) => intake.get(candidate.activeEngine) !== true)
          .map((candidate) => candidate.id),
        ...[...runtimeAuthorities].flatMap(([agentId, authority]) =>
          authority.opening || authority.closing || authority.oneShots.size > 0 ? [agentId] : []),
        ...activeRuns.keys(),
        ...deletingAgentIds,
      ])];
    },
    onRunLeased: () => { reconcileTriggerOperationalNotifications(); },
    onMessageDeliveryChanged: publishMessageDeliveryChanged,
  },
);
}
