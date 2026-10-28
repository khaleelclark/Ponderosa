import {
  type AgentDto,
  type AgentEvent,
  type ChatMessage,
  type ConversationMessageDto,
  type ProjectDto,
  type ProviderErrorCode,
  type ProviderFailureCategory,
  type ProviderInputSourceManifest,
  type RuntimeDynamicToolSpec,
  type RuntimeProcessHandle,
  unicodeCodePointLength,
  publicProviderFailureEvent,
  publicProviderFailureSummary,
  safeProviderConnectionUrl,
} from "@ponderosa/core";
import { randomUUID } from "node:crypto";
import {
  AgentEventPersistenceError,
  MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES,
  type LogEvent,
  type ResolvedAgentWorkingCopy,
} from "@ponderosa/agents";
import {
  classifyProviderFailure,
  shouldRolloverEngineSession,
} from "@ponderosa/engines";
import type { FastifyInstance } from "fastify";
import type {
  ActiveRun,
  EngineRegistration,
  OneShotRuntimeTeardown,
  OpeningPersistentRuntime,
  PersistentRuntime,
} from "../app-contracts.js";
import {
  evaluateContextRolloverPressure,
  shouldRequestAutomaticContextRollover,
} from "../context-rollover-pressure.js";
import type { ContextCursor } from "../context-cursors.js";
import { providerUnavailableNotificationBody } from "../provider-availability-detail.js";
import { readProviderSessionIdentifier } from "../provider-session-success.js";
import {
  isProviderRuntimeBoundaryError,
  providerEventStream,
  providerRuntimeOperation,
  providerRuntimeValue,
  providerProcessHandleFacade,
  providerSessionFacade,
  projectProviderRootExitDetail,
  takeProviderRuntimeCleanupFailure,
} from "../provider-session-facade.js";
import { cleanupRuntimeAttachments } from "../runtime-attachments.js";
import { runtimeObservation } from "../runtime-observation.js";
import type { AgentMessageRunContext } from "./agent-message-run.js";
import { createProviderDynamicToolHandler } from "./provider-dynamic-tool-handler.js";

function humanizeProviderName(value: string): string {
  return value
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

export function contextRolloverHandoffValidationError(
  text: string,
): string | undefined {
  const handoff = text.trim();
  if (!handoff || !/[\p{L}\p{N}]/u.test(handoff)) {
    return "handoff must contain meaningful continuation content";
  }
  if (unicodeCodePointLength(handoff) > 20_000) {
    return "handoff must contain 20,000 Unicode characters or fewer";
  }
  return undefined;
}

export interface ProviderRunExecutionInput {
  activeRun: ActiveRun;
  availableRuntimeTools: RuntimeDynamicToolSpec[];
  agent: AgentDto;
  agentMessageUrl: string;
  broadcastCanonicalTipId: string | undefined;
  broadcastDeltaOmitted: boolean;
  broadcastIncremental: boolean;
  communicationEventId: string | undefined;
  continuationHandoff: {
    id: string;
    executionId: string;
    text: string;
    createdAt: string;
  } | undefined;
  controller: AbortController;
  cursorChannel: "main" | undefined;
  cursorConversationId: string | undefined;
  cursorModel: string;
  effectiveEffort: string | undefined;
  effectiveModel: string | undefined;
  effectiveSpeed: string;
  engine: EngineRegistration;
  freshExactProviderInput: string;
  freshPrompt: string;
  freshProviderInputManifest: ProviderInputSourceManifest;
  incremental: boolean;
  initialBroadcastContext: ConversationMessageDto[];
  manifestArtifactIds: string[];
  messageCapability: string;
  policySnapshotHash: string;
  pendingCommunicationV4NextRunDeliveryIds: string[];
  previousBroadcastCursor: ContextCursor | undefined;
  previousCursor: ContextCursor | undefined;
  project: ProjectDto;
  prompt: string;
  resumeSessionId: string | undefined;
  reusablePersistentRuntime: PersistentRuntime | undefined;
  roomCanonicalTipId: string | undefined;
  roomDeltaOmitted: boolean;
  roomMessages: ConversationMessageDto[];
  routingConversationId: string | undefined;
  routingHash: string;
  runId: string;
  runtimeEngineId: string;
  runtimeSessionContractHash: string;
  workingCopy: ResolvedAgentWorkingCopy;
  runtimeAttachmentDirectory: string | undefined;
  runtimeAttachmentCleanupAfterRun: boolean;
  seedHistory: ChatMessage[];
  sourceChannel: "main" | "individual";
  systemPrompt: string;
  v3FencingToken: number | undefined;
  v3InjectionId: string | undefined;
}

export function startProviderRunExecution(
  app: FastifyInstance,
  context: AgentMessageRunContext,
  input: ProviderRunExecutionInput,
): void {
  const {
    store,
    workspace,
    coordinationV3,
    engines,
    engineAvailability,
    contextCursors,
    activeRuns,
    agentMessageCapabilities,
    organizationEnvelopeStates,
    scheduledSessionRollovers,
    contextRolloverPending,
    engineModelCatalogCache,
    deletingProjectIds,
    deletingAgentIds,
    coordinationV3WorkerId,
    deploymentDraining,
    isClosed,
    providerEnabled,
    reusableRuntime,
    closingRuntime,
    oneShotRuntime,
    runtimeAuthority,
    pruneRuntimeAuthority,
    clearAgentResumeSession,
    notifyManagerOfChildFailure,
    notifyScheduler,
    reconcileProjectWorkspace,
    drainDeploymentIdleAuthorities,
    discoverEngineModelCatalog,
    markEngineModelUnavailable,
    reportRuntimeCapabilitiesChanged,
    refreshProviderUsageAfterRun,
    ownsActiveRunForAuditDrain,
    ownsActiveRun,
    persistentRootExited,
    reconcileAgentRuntimeAuthority,
    retireCompletedContextRolloverSession,
    scheduleRuntimeIdleClose,
    teardownOneShotRuntime,
    teardownOpeningRuntime,
    teardownPersistentRuntime,
    teardownPersistentRuntimeInBackground,
    persistRuntimeEvent,
    receiveRuntimeEvent,
    releaseActiveRun,
    renewExecutionLease,
    scheduleRuntimeLivenessHeartbeat,
    publish,
    publishMessageDeliveryChanged,
    publishWorkspaceSince,
    runtimeElicitations,
    createOperationalNotification,
    resolveOperationalNotification,
    providerProcessAuthority,
  } = context;
  const {
    activeRun,
    availableRuntimeTools,
    agent,
    agentMessageUrl,
    broadcastCanonicalTipId,
    broadcastDeltaOmitted,
    broadcastIncremental,
    communicationEventId,
    continuationHandoff,
    controller,
    cursorChannel,
    cursorConversationId,
    cursorModel,
    effectiveEffort,
    effectiveModel,
    effectiveSpeed,
    engine,
    freshExactProviderInput,
    freshPrompt,
    freshProviderInputManifest,
    incremental,
    initialBroadcastContext,
    manifestArtifactIds,
    messageCapability,
    policySnapshotHash,
    pendingCommunicationV4NextRunDeliveryIds,
    previousBroadcastCursor,
    previousCursor,
    project,
    prompt,
    resumeSessionId,
    reusablePersistentRuntime,
    roomCanonicalTipId,
    roomDeltaOmitted,
    roomMessages,
    routingConversationId,
    routingHash,
    runId,
    runtimeEngineId,
    runtimeSessionContractHash,
    workingCopy,
    runtimeAttachmentDirectory,
    runtimeAttachmentCleanupAfterRun,
    seedHistory,
    sourceChannel,
    systemPrompt,
    v3FencingToken,
    v3InjectionId,
  } = input;

  let terminalLifecycle: ReturnType<typeof store.appendEvent> | undefined;
  let terminalLifecyclePublished = false;
  const publishTerminalLifecycle = (): void => {
    if (!terminalLifecycle || terminalLifecyclePublished) return;
    terminalLifecyclePublished = true;
    publish(agent.id, terminalLifecycle);
  };

  const execution = (async () => {
    // Consolidate ordinary response deltas into one durable, execution-scoped
    // Work log entry. Communication is created only by explicit intent calls.
    let runError: string | undefined;
    let providerHttpStatusCode: number | undefined;
    let providerRetryAfterMs: number | undefined;
    let providerQuotaResetAt: string | undefined;
    let providerQuotaLimit: import("@ponderosa/core").ProviderQuotaLimit | undefined;
    let runFailureClassification:
      | ProviderErrorCode
      | ProviderFailureCategory
      | undefined;
    let internalFailureCode: "run_orchestration" | "context_rollover_conflict"
      | "context_rollover_boundary" | undefined;
    let finalText = "";
    let firstTextSeq: number | undefined;
    let lastTextSeq: number | undefined;
    let v3PromptInjected = false;
    let continuationHandoffConsumed = false;
    let providerWorkObserved = false;
    let projectedProviderNonExecutionEvidence = false;
    let providerStreamBoundaryFailure: {
      kind: "turn_submission_rejection" | "iterator_rejection" | "event_projection";
      providerAccepted: boolean;
    } | undefined;
    let schedulerCancelled = false;
    let usedFreshFallback = false;
    let projectWorkspaceUnavailable = false;
    try {
      const runCapability = agentMessageCapabilities.get(messageCapability);
      if (!runCapability || runCapability.agentId !== agent.id || runCapability.runId !== runId) {
        throw new Error("provider Run lost its exact message capability before session creation");
      }
      const replacementCandidate = coordinationV3.contextRolloverCandidateForRun(runId, agent.id);
      const pendingHandoff = coordinationV3.activeContextRollover(agent.id);
      const frozenHandoffSessionId = pendingHandoff?.state === "requested" &&
        pendingHandoff.oldProviderSessionId === resumeSessionId &&
        coordinationV3.activationPayloads(agent.id, coordinationV3.activationIdsAttachedToRun(runId, agent.id), runId)
          .some((activation) => activation.kind === "context_rollover_handoff" &&
            activation.payload && typeof activation.payload === "object" &&
            (activation.payload as { rolloverId?: unknown }).rolloverId === pendingHandoff.id)
        ? resumeSessionId : undefined;
      const environment = {
        PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
        PONDEROSA_AGENT_HISTORY_URL: agentMessageUrl.replace(/\/api\/agent-messages$/, "/api/agent-history"),
        PONDEROSA_DOCUMENT_URL: agentMessageUrl.replace(/\/api\/agent-messages$/, "/api/agent-documents"),
        PONDEROSA_AGENT_DIRECTORY_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-directory`,
        PONDEROSA_AGENT_COORDINATE_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-coordinate`,
        PONDEROSA_AGENT_UPDATE_REQUEST_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-request-updates`,
        PONDEROSA_AGENT_BROWSER_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-browser`,
        PONDEROSA_AGENT_IMPORT_FILE_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-import-file`,
        PONDEROSA_AGENT_SPAWN_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-spawn`,
        PONDEROSA_AGENT_DECISION_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-decisions`,
        PONDEROSA_AGENT_MANAGE_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-management`,
        PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapability,
        PONDEROSA_AGENT_TOOL_NAMES: JSON.stringify(availableRuntimeTools.map((tool) => tool.name)),
        PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
      };
      const openPersistentRuntime = async (
        sessionResumeId: string | undefined,
        onRuntimeSpawned: (handle: RuntimeProcessHandle) => void,
        identity: object,
      ): Promise<PersistentRuntime> => {
        const rawSession = await providerRuntimeOperation("open provider session", () => engine.adapter.openSession!({
          agentId: agent.id,
          cwd: workingCopy.rootPath,
          resumeSessionId: sessionResumeId,
          history: sessionResumeId ? [] : seedHistory,
          systemPrompt,
          model: effectiveModel,
          effort: effectiveEffort,
          speed: effectiveSpeed,
          environment,
          dynamicTools: availableRuntimeTools,
          handleDynamicToolCall: createProviderDynamicToolHandler(
            app,
            availableRuntimeTools,
            messageCapability,
          ),
          handleElicitation: async (request) => {
            // Persistent provider sessions outlive the Run that opened them,
            // so resolve authority from the current Run instead of this
            // callback's original closure.
            const currentRun = activeRuns.get(agent.id);
            if (!currentRun || !ownsActiveRun(agent.id, currentRun) || currentRun.controller.signal.aborted) {
              return { action: "cancel" };
            }
            const connectionUrl = request.mode === "url"
              ? safeProviderConnectionUrl(request.url)
              : undefined;
            if (request.mode === "url" && !connectionUrl) {
              return { action: "cancel" };
            }
            const connectionKind = connectionUrl && new URL(connectionUrl).protocol === "https:"
              ? "secure"
              : "local";
            if (runtimeElicitations.allowsForRun(currentRun.runId, request)) {
              return { action: "accept", content: {} };
            }
            const rememberableConfirmation = runtimeElicitations.canRememberForRun(request);
            const cursor = workspace.cursor();
            const providerName = humanizeProviderName(request.serverName);
            const decision = workspace.createDecision({
              idempotencyKey: `runtime-elicitation:${currentRun.runId}:${request.mode === "url" ? request.elicitationId ?? randomUUID() : randomUUID()}`,
              projectId: agent.projectId,
              ...(currentRun.conversationId ? { conversationId: currentRun.conversationId } : {}),
              agentId: agent.id,
              runId: currentRun.runId,
              ...(currentRun.v3SchedulerRunId ? { coordinationRunId: currentRun.v3SchedulerRunId } : {}),
              mode: "choice",
              question: request.mode === "url"
                ? `${agent.title} needs a ${connectionKind} ${providerName} connection before it can continue.`
                : rememberableConfirmation
                  ? `${agent.title} needs permission for ${providerName} before it can continue.`
                : `${agent.title} needs information for ${providerName} before it can continue.`,
              context: request.mode === "url"
                ? `Open the ${connectionKind} ${providerName} connection page, then return here to confirm.`
                : rememberableConfirmation
                  ? `${providerName} requested confirmation. You can allow it once or for the rest of this Agent run.`
                : `${providerName} needs this information to continue. Submitted values are sent directly to the provider and are not saved in Ponderosa.`,
              options: request.mode === "url"
                ? [
                    { id: "accept", label: "I've Connected" },
                    { id: "decline", label: "Not Now" },
                  ]
                : rememberableConfirmation
                  ? [
                      { id: "submit", label: "Allow once" },
                      { id: "allow_run", label: "Allow for this run" },
                      { id: "decline", label: "Not Now" },
                    ]
                : [
                    { id: "submit", label: "Submit" },
                    { id: "decline", label: "Not Now" },
                  ],
              allowOther: true,
              blocking: true,
              runtimeAction: {
                kind: "mcp_elicitation",
                mode: request.mode,
                serverName: request.serverName,
              },
            });
            // A provider may reuse an elicitation ID after its durable Decision
            // has already resolved. Never attach a fresh live request to that
            // unreachable historical prompt.
            if (decision.status !== "pending") {
              runtimeElicitations.cancel(decision.id);
              return { action: "cancel" };
            }
            const waiting = runtimeElicitations.wait(decision.id, request, currentRun.controller.signal);
            workspace.createNotification({
              projectId: decision.projectId,
              conversationId: decision.conversationId,
              conversationIds: [agent.conversationId],
              agentId: decision.agentId,
              agentIds: [decision.agentId],
              kind: "decision",
              category: "decision",
              severity: "urgent",
              status: "open",
              dedupeKey: `decision:${decision.id}`,
              action: { kind: "open_decision", targetId: decision.id },
              title: request.mode === "url"
                ? `${agent.title} needs you to connect ${providerName}`
                : rememberableConfirmation
                  ? `${agent.title} needs permission for ${providerName}`
                : `${agent.title} needs information for ${providerName}`,
              body: decision.question,
              decision: {
                id: decision.id,
                mode: decision.mode,
                options: decision.options,
                allowOther: decision.allowOther,
                status: decision.status,
                runtimeAction: decision.runtimeAction,
              },
            }, true);
            publishWorkspaceSince(cursor);
            const response = await waiting;
            if (currentRun.controller.signal.aborted && !isClosed()) {
              const cancelCursor = workspace.cursor();
              runtimeElicitations.cancel(decision.id);
              workspace.cancelDecision(decision.id);
              publishWorkspaceSince(cancelCursor);
            }
            return response;
          },
          onRuntimeSpawned,
          onRuntimeRootExit: (detail) => {
            let observation;
            try { observation = projectProviderRootExitDetail(detail); }
            catch { app.log.warn({ agentId: agent.id }, "invalid provider root-exit detail; using generic failure"); }
            persistentRootExited(agent.id, identity, observation);
          },
          onCapabilitiesChanged: () => reportRuntimeCapabilitiesChanged(project.id, engine.adapter.id),
          signal: controller.signal,
        }));
        const session = providerSessionFacade(rawSession);
        return {
          identity,
          session,
          iterator: session.events[Symbol.asyncIterator](),
          messageCapability,
        };
      };
      const openRegisteredPersistentRuntime = (sessionResumeId?: string): Promise<PersistentRuntime> => {
        const authority = runtimeAuthority(agent.id, true)!;
        if (authority.opening) {
          throw new Error(`provider runtime is already opening for ${agent.id}`);
        }
        const identity = {};
        const state = { identity, projectId: project.id } as OpeningPersistentRuntime;
        activeRun.persistentRuntimeIdentity = identity;
        // Defer the adapter call by one microtask so the opening operation
        // is visible to Project deletion and shutdown before openSession()
        // can spawn or await anything.
        const operation = Promise.resolve()
          .then(() => openPersistentRuntime(sessionResumeId, (handle) => {
            handle = providerProcessHandleFacade(handle);
            if (state.handle && state.handle !== handle) {
              // Retain a distinct duplicate root under its own handle; it must
              // never replace the lifetime that already owns this opening.
              providerProcessAuthority.register(handle, { purpose: "duplicate provider readiness", projectId: project.id, agentId: agent.id, runId });
              void handle.close().catch((error) => {
                app.log.error({ err: error, agentId: agent.id }, "duplicate opening provider handle failed to terminate");
              });
              throw new Error(`provider adapter registered multiple opening handles for ${agent.id}`);
            }
            providerProcessAuthority.register(handle, {
              purpose: "persistent provider runtime", projectId: project.id, agentId: agent.id, runId,
            }, identity);
            state.handle = handle;
          }, identity))
          .then(async (runtime) => {
            const currentAgent = store.getAgent(agent.id);
            const currentAuthority = runtimeAuthority(agent.id);
            const stillAuthoritative = !isClosed() && !deletingProjectIds.has(project.id) && !deletingAgentIds.has(agent.id) &&
              !controller.signal.aborted && currentAgent?.projectId === project.id &&
              activeRuns.get(agent.id) === activeRun && ownsActiveRun(agent.id, activeRun) &&
              currentAuthority?.opening === state && !currentAuthority.closing;
            if (!stillAuthoritative) {
              await teardownPersistentRuntime(agent.id, runtime, "provider open lost Run authority", project.id);
              throw new Error(`provider runtime open lost authority for ${agent.id}`);
            }
            currentAuthority.reusable = runtime;
            return runtime;
          })
          .catch(async (error: unknown) => {
            // Adapter readiness can reject after the provider has spawned.
            // Retain and close that spawn-time handle before propagating the
            // open failure; a failed close leaves the state retryable.
            if (state.handle && !state.terminationConfirmed && !closingRuntime(agent.id)) {
              try {
                await teardownOpeningRuntime(agent.id, state, "provider readiness failed");
              } catch (closeError) {
                if (isProviderRuntimeBoundaryError(error)) {
                  app.log.error(
                    { agentId: agent.id, runId },
                    "provider readiness cleanup remains pending after provider rejection",
                  );
                  throw error;
                }
                throw new AggregateError(
                  [error, closeError],
                  `provider runtime readiness and cleanup failed for ${agent.id}`,
                );
              }
            }
            throw error;
          })
          .finally(() => {
            state.settled = true;
            const currentAuthority = runtimeAuthority(agent.id);
            if (currentAuthority?.opening === state &&
                (!state.handle || state.terminationConfirmed || currentAuthority.reusable || currentAuthority.closing)) {
              currentAuthority.opening = undefined;
              pruneRuntimeAuthority(agent.id, currentAuthority);
            }
          });
        state.operation = operation;
        authority.opening = state;
        return operation;
      };
      let persistentRuntime = reusablePersistentRuntime;
      if (persistentRuntime) {
        let alive = false;
        try { alive = persistentRuntime.session.isAlive(); } catch { /* fail closed */ }
        if (reusableRuntime(agent.id) !== persistentRuntime || !alive) {
          await reconcileAgentRuntimeAuthority(agent.id);
          persistentRuntime = undefined;
        }
      }
      if (engine.adapter.openSession && !persistentRuntime) {
        persistentRuntime = await openRegisteredPersistentRuntime(resumeSessionId);
      }
      if (persistentRuntime) {
        providerProcessAuthority.register(persistentRuntime.session, {
          purpose: "persistent provider runtime",
          projectId: project.id,
          agentId: agent.id,
          runId,
        }, persistentRuntime.identity);
        activeRun.persistentRuntimeIdentity = persistentRuntime.identity;
        activeRun.runtimeSession = persistentRuntime.session;
        scheduleRuntimeLivenessHeartbeat(agent.id, activeRun);
      }
      let persistentTurnStarted = false;
      const registerOneShotRuntime = (handle: RuntimeProcessHandle): void => {
        handle = providerProcessHandleFacade(handle);
        providerProcessAuthority.register(handle, {
          purpose: "provider Run",
          projectId: project.id,
          agentId: agent.id,
          runId,
        });
        const authority = runtimeAuthority(agent.id, true)!;
        const existing = authority.oneShots.get(runId);
        if (existing && existing.handle !== handle) {
          void handle.close().catch((error) => app.log.error({ err: error, runId }, "duplicate one-shot runtime failed to terminate"));
          throw new Error(`provider adapter registered multiple one-shot handles for ${runId}`);
        }
        if (existing) return;
        const state: OneShotRuntimeTeardown = { agentId: agent.id, projectId: project.id, runId, handle };
        authority.oneShots.set(runId, state);
        if (isClosed() || deletingProjectIds.has(project.id) || deletingAgentIds.has(agent.id) ||
            controller.signal.aborted || !ownsActiveRun(agent.id, activeRun)) {
          void teardownOneShotRuntime(state, "spawn lost Run authority").catch((error) => {
            app.log.error({ err: error, agentId: agent.id, runId }, "late one-shot runtime termination remains pending");
          });
        }
      };
      const projectProviderStream = async function* (
        source: AsyncIterable<AgentEvent>,
      ): AsyncIterable<AgentEvent> {
        try {
          for await (const event of source) {
            providerStreamBoundaryFailure = undefined;
            yield event;
          }
        } catch (error) {
          providerStreamBoundaryFailure ??= {
            kind: isProviderRuntimeBoundaryError(error) &&
              error.operation === "project provider event"
              ? "event_projection"
              : "iterator_rejection",
            providerAccepted: v3PromptInjected,
          };
          throw error;
        }
      };
      const startStream = (sessionId?: string): AsyncIterable<AgentEvent> => sessionId
        ? persistentRuntime
          ? {
              async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
                if (!persistentTurnStarted) {
                  try {
                    await persistentRuntime!.session.startTurn({
                      prompt,
                      kind: "collaboration",
                      model: effectiveModel,
                      effort: effectiveEffort,
                      speed: effectiveSpeed,
                      clientMessageId: communicationEventId,
                    });
                  } catch (error) {
                    providerStreamBoundaryFailure = {
                      kind: "turn_submission_rejection",
                      providerAccepted: v3PromptInjected,
                    };
                    throw error;
                  }
                  persistentTurnStarted = true;
                }
                while (true) {
                  let next: IteratorResult<AgentEvent>;
                  try {
                    next = await persistentRuntime!.iterator.next();
                  } catch (error) {
                    providerStreamBoundaryFailure = {
                      kind: isProviderRuntimeBoundaryError(error) &&
                        error.operation === "project provider event"
                        ? "event_projection"
                        : "iterator_rejection",
                      providerAccepted: v3PromptInjected,
                    };
                    throw error;
                  }
                  if (next.done) {
                    teardownPersistentRuntimeInBackground(agent.id, persistentRuntime!, "provider stream ended");
                    yield activeRun.observedProviderFailure ?? { type: "error", message: "persistent engine session stopped" };
                    return;
                  }
                  const event = next.value;
                  providerStreamBoundaryFailure = undefined;
                  yield event;
                  if (event.type === "turn_done" || event.type === "error") return;
                }
              },
            }
          : projectProviderStream(providerEventStream(providerRuntimeValue(
              "continue provider session",
              () => engine.adapter.continue({
              agentId: agent.id,
              cwd: workingCopy.rootPath,
              prompt,
              systemPrompt,
              resumeSessionId: sessionId,
              model: effectiveModel,
              effort: effectiveEffort,
              speed: effectiveSpeed,
              environment,
              signal: controller.signal,
              onRuntimeRootExit: () => agentMessageCapabilities.delete(messageCapability),
              onRuntimeSpawned: registerOneShotRuntime,
              }),
            ), "read continued provider event stream"))
        : persistentRuntime
          ? {
              async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
                if (!persistentTurnStarted) {
                  try {
                    await persistentRuntime!.session.startTurn({
                      prompt: freshPrompt,
                      kind: "collaboration",
                      model: effectiveModel,
                      effort: effectiveEffort,
                      speed: effectiveSpeed,
                      clientMessageId: communicationEventId,
                    });
                  } catch (error) {
                    providerStreamBoundaryFailure = {
                      kind: "turn_submission_rejection",
                      providerAccepted: v3PromptInjected,
                    };
                    throw error;
                  }
                  persistentTurnStarted = true;
                }
                while (true) {
                  let next: IteratorResult<AgentEvent>;
                  try {
                    next = await persistentRuntime!.iterator.next();
                  } catch (error) {
                    providerStreamBoundaryFailure = {
                      kind: isProviderRuntimeBoundaryError(error) &&
                        error.operation === "project provider event"
                        ? "event_projection"
                        : "iterator_rejection",
                      providerAccepted: v3PromptInjected,
                    };
                    throw error;
                  }
                  if (next.done) {
                    teardownPersistentRuntimeInBackground(agent.id, persistentRuntime!, "provider stream ended");
                    yield activeRun.observedProviderFailure ?? { type: "error", message: "persistent engine session stopped" };
                    return;
                  }
                  const event = next.value;
                  providerStreamBoundaryFailure = undefined;
                  yield event;
                  if (event.type === "turn_done" || event.type === "error") return;
                }
              },
            }
          : projectProviderStream(providerEventStream(providerRuntimeValue(
              "seed provider session",
              () => engine.adapter.seed({
              agentId: agent.id,
              cwd: workingCopy.rootPath,
              prompt: freshPrompt,
              history: seedHistory,
              systemPrompt,
              model: effectiveModel,
              effort: effectiveEffort,
              speed: effectiveSpeed,
              environment,
              signal: controller.signal,
              onRuntimeRootExit: () => agentMessageCapabilities.delete(messageCapability),
              onRuntimeSpawned: registerOneShotRuntime,
              }),
            ), "read seeded provider event stream"));

      const persistAcceptedSessionSnapshot = (acceptedSessionId: string): void => {
        // A handoff may read only the frozen original generation. It cannot
        // replace or expand accepted fallback state before verification.
        if (frozenHandoffSessionId) {
          if (acceptedSessionId !== frozenHandoffSessionId) throw new Error("context rollover handoff changed provider session identity");
          return;
        }
        const artifactIds = [...manifestArtifactIds].sort();
        const current = store.resumeSessionState(agent.id);
        const pendingRollover = contextRolloverPending.get(agent.id);
        if (pendingRollover && pendingRollover.sessionId !== acceptedSessionId) {
          contextRolloverPending.delete(agent.id);
        }
        if (
          current?.sessionId === acceptedSessionId
          && current.toolContractHash === runtimeSessionContractHash
          && current.artifactIds.length === artifactIds.length
          && current.artifactIds.every((id, index) => id === artifactIds[index])
        ) return;
        const sessionSnapshot = store.appendEvent(agent.id, {
          type: "session_snapshot",
          sessionId: acceptedSessionId,
          executionId: runId,
          toolContractHash: runtimeSessionContractHash,
          artifactIds,
        });
        publish(agent.id, sessionSnapshot);
      };
      const acceptVerifiedRolloverSession = (input: {
        rolloverId: string;
        acceptedSessionId: string;
        handoffId: string;
      }): void => {
        const accepted = store.appendEvent(agent.id, {
          type: "context_rollover_session_accepted",
          rolloverId: input.rolloverId,
          sessionId: input.acceptedSessionId,
          toolContractHash: runtimeSessionContractHash,
          artifactIds: [...manifestArtifactIds].sort(),
          handoffId: input.handoffId,
          executionId: runId,
        });
        publish(agent.id, accepted);
        continuationHandoffConsumed = true;
      };

      let sessionId = resumeSessionId;
      while (true) {
        const bufferedSessionEvents: Extract<AgentEvent, { type: "session" }>[] = [];
        let retryFresh = false;
        if (activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined && !v3PromptInjected) {
          coordinationV3!.markPromptSubmitted({
            injectionId: v3InjectionId!,
            runId: activeRun.v3SchedulerRunId,
            fencingToken: activeRun.v3FencingToken,
            providerSessionId: sessionId ?? (persistentRuntime
              ? readProviderSessionIdentifier(persistentRuntime.session)
              : undefined),
          });
          // Submission is the first durable provider boundary. Refresh message
          // receipts now; acknowledgement will advance the same receipt to
          // delivered when the first non-error event arrives.
          publishMessageDeliveryChanged(agent.id);
        }
        for await (const event of startStream(sessionId)) {
          if (event.type === "session" && frozenHandoffSessionId && event.sessionId !== frozenHandoffSessionId) {
            throw new Error("context rollover handoff changed provider session identity");
          }
          if (event.type === "error" &&
              (event.code === "invalid_model" || event.code === "model_not_found") &&
              effectiveModel &&
              !providerWorkObserved) {
            const isPinned = workspace.getPreferences().claudeModelOptions.some((model) => model.id === effectiveModel) ||
              [...engineModelCatalogCache.values()].some((entry) =>
                entry.projectId === project.id &&
                entry.engineId === runtimeEngineId &&
                entry.value.models.some((model) => model.id === effectiveModel && model.kind === "exact"));
            if (isPinned) {
              const reason = `pinned model ${effectiveModel} is no longer available — update it in Workspace Settings.`;
              event.message = reason;
              markEngineModelUnavailable(project, engine.adapter, effectiveModel, reason);
            }
            void discoverEngineModelCatalog(project, engine.adapter, true).catch((error) => {
              app.log.warn({ err: error, projectId: project.id, engineId: runtimeEngineId }, "model-start rejection refresh failed");
            });
          }
          if (event.type !== "error" && event.type !== "session" && event.type !== "context_usage") {
            providerWorkObserved = true;
          }
          if (activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined && !v3PromptInjected && event.type !== "error") {
            coordinationV3!.acknowledgePromptInjection({
              injectionId: v3InjectionId!,
              runId: activeRun.v3SchedulerRunId,
              fencingToken: activeRun.v3FencingToken,
              providerSessionId: sessionId ?? (event.type === "session" ? event.sessionId : persistentRuntime
                ? readProviderSessionIdentifier(persistentRuntime.session)
                : undefined),
            });
            v3PromptInjected = true;
            publishMessageDeliveryChanged(agent.id);
            if (continuationHandoff && !continuationHandoffConsumed && !replacementCandidate) {
              continuationHandoffConsumed = store.consumeContinuationHandoff(
                agent.id,
                continuationHandoff.id,
                runId,
              );
            }
          }
          if (deletingAgentIds.has(agent.id) || isClosed() || controller.signal.aborted || !renewExecutionLease(agent.id, activeRun)) break;
          if (!receiveRuntimeEvent(agent.id, activeRun)) break;
          if (event.type === "context_usage" && event.providerSessionGeneration !== undefined) {
            activeRun.observedProviderSessionGeneration = event.providerSessionGeneration;
          }
          if (event.type === "turn_done") activeRun.observedProviderTerminalStatus = "completed";
          if (event.type === "error" && event.terminalStatus !== undefined) activeRun.observedProviderTerminalStatus = event.terminalStatus;
          if(event.type==='error')activeRun.observedProviderFailure=event;
          if (event.type === "error" && sessionId && !frozenHandoffSessionId &&
              !providerWorkObserved && shouldRolloverEngineSession(runtimeEngineId, event)) {
            // The provider confirmed the resumed session failed before
            // sampling. Discard its buffered session event and retry once
            // with the separately persisted canonical fresh-seed packet.
            clearAgentResumeSession(agent.id, "resume_compaction_failed");
            coordinationV3.setRunContextDisposition(runId, v3FencingToken!, "reseeded");
            coordinationV3.recordProviderInput({
              executionId: runId,
              schedulerRunId: runId,
              fencingToken: v3FencingToken!,
              agentId: agent.id,
              projectId: project.id,
              prompt: freshExactProviderInput,
              systemPrompt,
              sourceManifest: freshProviderInputManifest,
            });
            manifestArtifactIds.splice(0, manifestArtifactIds.length, ...freshProviderInputManifest.artifactIds);
            if (freshProviderInputManifest.schemaVersion === 3) {
              runCapability.historyRetrievalBoundary = freshProviderInputManifest.historyContext?.boundary;
              runCapability.importedHistoryArchiveVersion = freshProviderInputManifest.historyContext?.importedArchiveVersion;
              runCapability.historyRetrievalExcludedCommunicationEventIds = freshProviderInputManifest.historyContext?.fullyIncludedCommunicationEventIds ?? [];
            }
            if (persistentRuntime) {
              const staleRuntime = persistentRuntime;
              await teardownPersistentRuntime(agent.id, staleRuntime, "failed resume replacement", project.id);
              activeRun.observedProviderFailure = undefined;
              activeRun.observedProviderTerminalStatus = undefined;
              activeRun.observedRootExit = undefined;
              persistentRuntime = await openRegisteredPersistentRuntime();
              activeRun.runtimeSession = persistentRuntime.session;
              persistentTurnStarted = false;
            }
            sessionId = undefined;
            usedFreshFallback = true;
            retryFresh = true;
            break;
          }
          // Codex can emit its session id immediately before a resume-time
          // compaction failure. Hold only those initial session events so a
          // failed resume does not restore the stale id after we clear it.
          if (sessionId && event.type === "session") {
            bufferedSessionEvents.push(event);
            continue;
          }
          for (const buffered of bufferedSessionEvents.splice(0)) {
            await persistRuntimeEvent(agent.id, activeRun, buffered);
          }
          // Retain payload-free native-work evidence for context accounting in
          // the internal audit only; it is not Chat or ordinary activity output.
          if (event.type === "work_start") {
            if (!await persistRuntimeEvent(agent.id, activeRun, { ...event, executionId: runId })) break;
            continue;
          }
          const logEvent: LogEvent = event.type === "text" || event.type === "reasoning" || event.type === "work_item_update" || event.type === "turn_done"
            ? { ...event, executionId: runId,
                ...(event.type === "text" && event.presentation === "progress" && activeRun.v3SchedulerRunId
                  ? { progressInjectionId: coordinationV3.latestAcknowledgedPromptInjection(activeRun.v3SchedulerRunId)?.id ?? v3InjectionId }
                  : {}) }
            : event;
          const stored = await persistRuntimeEvent(agent.id, activeRun, logEvent);
          if (!stored) break;
          // Once provider acceptance is fenced and durable, preserve the
          // compatible session's expanded artifact roots even if the
          // operator later cancels the turn. Fresh providers reveal their
          // opaque id through the session event; continuations retain it.
          if (event.type === "session") {
            coordinationV3.recordContextRolloverReplacementSessionForRun(
              runId,
              agent.id,
              event.sessionId,
            );
          }
          const acceptedSessionId = event.type === "session"
            ? event.sessionId
            : event.type !== "error"
              ? sessionId
              : undefined;
          const pendingReplacement = acceptedSessionId
            ? coordinationV3.contextRolloverForReplacementSession(agent.id, acceptedSessionId)
            : undefined;
          if (acceptedSessionId && !replacementCandidate &&
              pendingReplacement?.state !== "continuation_ready") {
            persistAcceptedSessionSnapshot(acceptedSessionId);
          }
          if (event.type === "text") {
            finalText += event.delta;
            firstTextSeq ??= stored.seq;
            lastTextSeq = stored.seq;
          }
          if (event.type === "context_usage" && ownsActiveRun(agent.id, activeRun)) {
            const recoveredHeadroom = coordinationV3.retireContextRolloverAfterHeadroomRecovery({
              agentId: agent.id,
              providerSessionGeneration: event.providerSessionGeneration,
              providerSessionId: event.providerSessionId,
              usedTokens: event.usedTokens,
            });
            if (recoveredHeadroom) {
              app.log.info({
                agentId: agent.id,
                rolloverId: recoveredHeadroom.id,
                providerSessionId: event.providerSessionId,
                usedTokens: event.usedTokens,
              }, "new provider request restored headroom; automatic rollover is redundant");
              notifyScheduler();
            }
            const replacementRollover = coordinationV3.contextRolloverForReplacementSession(
              agent.id,
              event.providerSessionId,
            );
            let suppressPressureForSeedOverflow = false;
            if (replacementRollover?.state === "continuation_ready") {
              const observed = coordinationV3.observeContextRolloverReplacementOccupancy(
                replacementRollover.id,
                event.providerSessionId,
                event.usedTokens,
              );
              if (observed.state === "failed") {
                suppressPressureForSeedOverflow = true;
                const sourceCounts = new Map<string, number>();
                for (const source of freshProviderInputManifest.sources) {
                  sourceCounts.set(source.kind, (sourceCounts.get(source.kind) ?? 0) + 1);
                }
                await persistRuntimeEvent(agent.id, activeRun, {
                  type: "context_rollover_seed_overflow",
                  executionId: runId,
                  rolloverId: observed.id,
                  usedTokens: event.usedTokens,
                  lowWaterMark: observed.lowWaterMark,
                  seedPromptUtf8Bytes: Buffer.byteLength(freshExactProviderInput, "utf8"),
                  contextSections: [...sourceCounts]
                    .map(([kind, count]) => ({ kind, count }))
                    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
                });
                createOperationalNotification({
                  dedupeKey: `context-rollover:${observed.id}:seed-overflow`,
                  category: "coordination",
                  severity: "attention",
                  title: `${agent.title} could not refresh context safely`,
                  body: observed.lastError ?? "Fresh context did not restore enough headroom.",
                  projectId: agent.projectId,
                  conversationId: routingConversationId,
                  agentId: agent.id,
                  action: { kind: "open_agent", targetId: agent.id },
                });
                runError = observed.lastError ?? "replacement context remained above the rollover low-water mark";
                break;
              } else if (observed.replacementVerifiedAt) {
                if (!observed.handoffEventId) {
                  throw new Error("verified context rollover has no durable handoff");
                }
                // This single canonical event atomically switches the accepted
                // provider snapshot and consumes the exact handoff. Every
                // candidate fault before this point leaves both untouched.
                acceptVerifiedRolloverSession({
                  rolloverId: observed.id,
                  acceptedSessionId: event.providerSessionId,
                  handoffId: observed.handoffEventId,
                });
                const completed = coordinationV3.completeVerifiedContextRolloverReplacement(
                  observed.id,
                  event.providerSessionId,
                );
                await persistRuntimeEvent(agent.id, activeRun, {
                  type: "context_rollover_completed",
                  executionId: runId,
                  rolloverId: completed.id,
                  previousProviderSessionId: completed.oldProviderSessionId,
                  replacementProviderSessionId: event.providerSessionId,
                  startingOccupancy: event.usedTokens,
                });
              }
            } else if (replacementRollover?.state === "failed" &&
                replacementRollover.failureSignal === "seed_overflow") {
              // A seed already above the low-water mark needs operator action.
              // Do not manufacture an infinite succession of fresh sessions.
              suppressPressureForSeedOverflow = true;
            }
            if (!suppressPressureForSeedOverflow &&
                replacementRollover?.state !== "continuation_ready") {
              const preferences = workspace.getPreferences();
              if (preferences.contextRolloverEnabled &&
                  !store.continuationHandoffForRun(agent.id, runId)) {
                const pressure = evaluateContextRolloverPressure(event, preferences);
                if (shouldRequestAutomaticContextRollover(
                  pressure,
                  coordinationV3.activeContextRollover(agent.id),
                )) {
                  let rolloverBoundary: ReturnType<typeof store.bindContextRolloverBoundary>;
                  try {
                    const acceptedSessionTail =
                      store.acceptedProviderSessionCommunicationEventIds(agent.id);
                    if (!acceptedSessionTail) {
                      throw new Error(
                        "the accepted provider session has no exact input boundary; native compaction remains authoritative",
                      );
                    }
                    rolloverBoundary = store.bindContextRolloverBoundary({
                      agentId: agent.id,
                      ...(routingConversationId ? { currentConversationId: routingConversationId } : {}),
                      submittedCommunicationEventIds: [...new Set([
                        ...acceptedSessionTail,
                        ...runCapability.historyRetrievalExcludedCommunicationEventIds,
                      ])],
                      maxUtf8Bytes: Math.min(pressure.lowWaterMark, MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES),
                    });
                  } catch (error) {
                    createOperationalNotification({
                      dedupeKey: `context-rollover:${agent.id}:boundary-invalid`,
                      category: "coordination",
                      severity: "attention",
                      title: `${agent.title} could not freeze a safe context boundary`,
                      body: error instanceof Error ? error.message : "The canonical rollover boundary was unavailable.",
                      projectId: agent.projectId,
                      conversationId: routingConversationId,
                      agentId: agent.id,
                      action: { kind: "open_agent", targetId: agent.id },
                    });
                    continue;
                  }
                  const requested = coordinationV3.requestContextRollover({
                    projectId: project.id,
                    agentId: agent.id,
                    oldProviderSessionId: event.providerSessionId,
                    providerSessionGeneration: event.providerSessionGeneration,
                    detectedOccupancy: event.usedTokens,
                    ...(event.aggregateTokens !== undefined ? { aggregateTokens: event.aggregateTokens } : {}),
                    threshold: pressure.threshold,
                    ...(event.windowTokens !== undefined ? { contextWindow: event.windowTokens } : {}),
                    lowWaterMark: pressure.lowWaterMark,
                    compactionCutoffOrdinal: rolloverBoundary.canonicalOrdinal,
                    compactionCutoffEventId: rolloverBoundary.communicationEventId,
                    recentTail: rolloverBoundary.recentTail,
                    sourceRunId: runId,
                    sourceActivationIds: coordinationV3.activationIdsAttachedToRun(runId, agent.id),
                    scopeKey: coordinationV3.runScopeKey(runId, agent.id),
                    ...(routingConversationId ? { conversationId: routingConversationId } : {}),
                    ...(runCapability.defaultReply ? { replyAuthority: runCapability.defaultReply } : {}),
                    visibleResponseCommitted: Boolean(runCapability.inferredReplyCommunicationEventId),
                  });
                  if (requested.created) {
                    await persistRuntimeEvent(agent.id, activeRun, {
                      type: "context_rollover_triggered",
                      executionId: runId,
                      usedTokens: event.usedTokens,
                      threshold: pressure.threshold,
                    });
                    app.log.info({
                      agentId: agent.id,
                      runId,
                      providerSessionId: event.providerSessionId,
                      aggregateTokens: event.aggregateTokens,
                      usedTokens: event.usedTokens,
                      threshold: pressure.threshold,
                    }, "provider context rollover requested during active work");
                    notifyScheduler();
                  }
                }
              }
            }
          }
          if (event.type === "error") {
            runError = event.message;
            providerHttpStatusCode = event.httpStatusCode;
            providerRetryAfterMs = event.retryAfterMs;
            providerQuotaResetAt = event.quotaResetAt;
            providerQuotaLimit = event.quotaLimit;
            runFailureClassification = event.category ?? event.code;
            projectedProviderNonExecutionEvidence = !providerWorkObserved &&
              !v3PromptInjected &&
              (runFailureClassification === "capacity" ||
                runFailureClassification === "rate_limit" || runFailureClassification === "quota_exhausted" || runFailureClassification === "throttled");
          }
        }
        if (!retryFresh) break;
      }
      if (runError && persistentRuntime && activeRun.observedProviderFailure) {
        try { await teardownPersistentRuntime(agent.id, persistentRuntime, "provider terminal failure", project.id); }
        catch (error) {
          // Typed failure remains primary; retained cleanup blocks replacement.
          app.log.error({ err: error, agentId: agent.id, runId }, "provider failure cleanup remains pending");
        }
      }
      if (activeRun.v3SchedulerRunId && !v3PromptInjected && !runError) {
        runError = "provider ended before prompt injection could be confirmed";
      }
    } catch (err) {
      const cleanupFailure = takeProviderRuntimeCleanupFailure(err);
      if (cleanupFailure) {
        app.log.error({
          runId,
          agentId: agent.id,
          operation: cleanupFailure.operation,
          category: cleanupFailure.category,
          ...(cleanupFailure.code ? { code: cleanupFailure.code } : {}),
          restrictedDetail: cleanupFailure.restrictedDetail,
        }, "provider event stream cleanup failed after primary provider failure");
      }
      if (isClosed() || controller.signal.aborted || !ownsActiveRunForAuditDrain(agent.id, activeRun)) return;
      schedulerCancelled = Boolean(activeRun.v3SchedulerRunId && coordinationV3?.isSchedulerRunCancelled(activeRun.v3SchedulerRunId));
      if (schedulerCancelled) return;
      // Only exceptions crossing an explicit provider operation/session/event
      // boundary may become canonical provider failures. Scheduler, lease,
      // persistence, workspace, and rollover exceptions remain internal.
      const providerFailure = isProviderRuntimeBoundaryError(err)
        ? err
        : undefined;
      const message = providerFailure?.restrictedDetail
        ?? "Agent execution failed due to an internal runtime error.";
      const failureEvent = providerFailure
        ? publicProviderFailureEvent({
            type: "error",
            message,
            ...(providerFailure.code ? { code: providerFailure.code } : {}),
            category: providerFailure.category,
          })
        : { type: "error" as const, message };
      runFailureClassification ??= providerFailure?.category;
      const workspaceIssue = await reconcileProjectWorkspace(project, agent);
      projectWorkspaceUnavailable = Boolean(workspaceIssue);
      if (workspaceIssue) runFailureClassification = undefined;
      runError = workspaceIssue ?? runError ?? message;
      if (!providerFailure && !workspaceIssue) {
        const conflict = err instanceof Error &&
          err.message === "context rollover provider generation replay conflicts with its durable owner";
        const exactBoundary = err instanceof Error &&
          err.message.startsWith("context rollover requires an exact positive canonical boundary");
        internalFailureCode = conflict ? "context_rollover_conflict"
          : exactBoundary ? "context_rollover_boundary" : "run_orchestration";
        app.log.error({
          runId, agentId: agent.id,
          category: conflict ? "context_rollover_conflict" : exactBoundary ? "context_rollover_boundary" : "run_orchestration",
          ...(err instanceof AgentEventPersistenceError ? { persistenceFailure: err.diagnostic } : {}),
          diagnostic: conflict ? "generation cycle rejected a changed canonical boundary"
            : exactBoundary ? "exact canonical boundary unavailable"
              : "unclassified internal exception",
        }, "internal provider Run orchestration failed");
      }
      await persistRuntimeEvent(
        agent.id,
        activeRun,
        workspaceIssue
          ? { type: "error", message: workspaceIssue }
          : failureEvent,
      );
    } finally {
      runtimeElicitations.clearRun(runId);
      const owned = ownsActiveRunForAuditDrain(agent.id, activeRun);
      schedulerCancelled ||= Boolean(!isClosed() && activeRun.v3SchedulerRunId && coordinationV3?.isSchedulerRunCancelled(activeRun.v3SchedulerRunId));
      const localRolloverRequested = scheduledSessionRollovers.delete(agent.id);
      const durableRollover = coordinationV3.activeContextRollover(agent.id);
      const attachedActivationPayloads = coordinationV3.activationPayloads(
        agent.id,
        coordinationV3.activationIdsAttachedToRun(runId, agent.id),
        runId,
      );
      const attachedHandoffActivation = attachedActivationPayloads.find((activation) =>
        activation.kind === "context_rollover_handoff" &&
        Boolean(activation.payload && typeof activation.payload === "object" &&
          typeof (activation.payload as { rolloverId?: unknown }).rolloverId === "string"));
      const attachedRolloverId = attachedHandoffActivation &&
        typeof attachedHandoffActivation.payload === "object" && attachedHandoffActivation.payload
        ? (attachedHandoffActivation.payload as { rolloverId: string }).rolloverId
        : undefined;
      const attachedRollover = attachedRolloverId
        ? coordinationV3.contextRollover(attachedRolloverId)
        : undefined;
      let runRollover = attachedRollover?.agentId === agent.id && attachedRollover.state === "requested"
        ? attachedRollover
        : durableRollover?.sourceRunId === runId ? durableRollover : undefined;
      let handoffActivationAcknowledged = false;
      let handoffValidationError: string | undefined;
      let suppressRolloverHandoffOutput = false;
      if (owned && runRollover?.state === "requested" && !runError &&
          !isClosed() && !controller.signal.aborted && !schedulerCancelled) {
        const handoffActivation = attachedActivationPayloads.find((activation) => {
          if (activation.kind !== "context_rollover_handoff" ||
              !activation.payload || typeof activation.payload !== "object") return false;
          return (activation.payload as { rolloverId?: unknown }).rolloverId === runRollover?.id;
        });
        const handoffInjection = handoffActivation
          ? coordinationV3.promptInjectionForActivation(runId, handoffActivation.id)
          : undefined;
        handoffActivationAcknowledged = handoffInjection?.state === "acknowledged";
        if (handoffActivationAcknowledged) {
          suppressRolloverHandoffOutput = true;
          const handoff = finalText.trim();
          handoffValidationError = contextRolloverHandoffValidationError(handoff);
          if (!handoffValidationError) {
            const existing = store.continuationHandoffForRun(agent.id, runId);
            const handoffId = existing?.id ?? randomUUID();
            if (!existing) {
              const event = store.appendEvent(agent.id, {
                type: "continuation_handoff",
                handoffId,
                executionId: runId,
                text: handoff,
              });
              publish(agent.id, event);
            }
            coordinationV3.commitContextRolloverHandoff(runRollover.id, handoffId);
            scheduledSessionRollovers.set(agent.id, new Date().toISOString());
            runRollover = coordinationV3.activeContextRollover(agent.id);
          } else {
            const retry = coordinationV3.retryContextRolloverHandoff(
              runRollover.id,
              handoffValidationError,
            );
            if (retry.scheduled) {
              app.log.warn({
                agentId: agent.id,
                runId,
                rolloverId: runRollover.id,
                validationError: handoffValidationError,
              }, "context rollover handoff was unusable; scheduled one corrective retry");
              notifyScheduler();
            } else {
              coordinationV3.failContextRollover(
                runRollover.id,
                "failed",
                `continuation handoff remained unusable after one corrective retry: ${handoffValidationError}`,
                "internal",
              );
              app.log.error({
                agentId: agent.id,
                runId,
                rolloverId: runRollover.id,
                validationError: handoffValidationError,
              }, "context rollover handoff remained unusable after its corrective retry; retained the old context");
            }
            resolveOperationalNotification(`context-rollover:${runRollover.id}:handoff-missing`);
            runRollover = coordinationV3.activeContextRollover(agent.id);
          }
        } else if (handoffInjection &&
            ["pending", "submitted"].includes(handoffInjection.state)) {
          // The provider did not acknowledge this exact handoff instruction.
          // Preserve the ordinary answer and retry the durable handoff at the
          // next safe scheduler boundary instead of reclassifying finalText.
          coordinationV3.deferSteering({
            injectionId: handoffInjection.id,
            runId,
            fencingToken: v3FencingToken!,
            preserveSteering: false,
          });
        }
      }
      const replacementRunRollover = coordinationV3.contextRolloverCandidateForRun(runId, agent.id);
      const rolloverRequested = owned && Boolean(localRolloverRequested || runRollover);
      const rolloverSucceeded = Boolean(
        rolloverRequested && runRollover?.state === "handoff_committed" &&
        !isClosed() && !controller.signal.aborted && !schedulerCancelled && !runError,
      );
      const policyRefreshSucceeded = Boolean(
        owned && localRolloverRequested && !runRollover &&
        !isClosed() && !controller.signal.aborted && !schedulerCancelled && !runError,
      );
      if (owned && handoffActivationAcknowledged && runRollover?.state === "requested" &&
          !handoffValidationError && !isClosed() && !controller.signal.aborted &&
          !schedulerCancelled && !runError) {
        runError = "context rollover failed: provider ended before committing the required bounded handoff";
        await persistRuntimeEvent(agent.id, activeRun, {
          type: "error",
          message: runError,
        });
      }
      const replacementCancelled = Boolean(
        replacementRunRollover && schedulerCancelled && !isClosed(),
      );
      const replacementFailed = Boolean(
        replacementRunRollover?.state === "failed" && !isClosed(),
      );
      const replacementMissingConfirmation = Boolean(
        owned && replacementRunRollover?.state === "continuation_ready" &&
        !isClosed() && !controller.signal.aborted && !schedulerCancelled,
      );
      if (replacementRunRollover &&
          (replacementCancelled || replacementMissingConfirmation || replacementFailed)) {
        const currentReplacement = coordinationV3.contextRollover(replacementRunRollover.id);
        if (replacementCancelled && currentReplacement?.state === "continuation_ready") {
          coordinationV3.failContextRollover(
            replacementRunRollover.id,
            "outcome_unknown",
            "replacement Run was cancelled before low-water context confirmation",
            "internal",
            undefined,
            "replacement_cancelled",
          );
        } else if (replacementMissingConfirmation) {
          const missingObservation = replacementRunRollover.replacementSessionId
            ? "replacement provider session ended before reporting the required low-water context observation"
            : "replacement Run ended before identifying and confirming a low-water provider session";
          coordinationV3.failContextRollover(
            replacementRunRollover.id,
            runError ? "outcome_unknown" : "failed",
            missingObservation,
            "internal",
          );
        }
        // The last accepted snapshot still identifies the old provider
        // generation. Discard only this unverified replacement runtime.
        organizationEnvelopeStates.delete(agent.id);
        const unconfirmedRuntime = reusableRuntime(agent.id);
        if (unconfirmedRuntime) {
          activeRun.persistentRuntimeIdentity = undefined;
          try {
            await teardownPersistentRuntime(
              agent.id,
              unconfirmedRuntime,
              "context rollover replacement lacked low-water confirmation",
              project.id,
            );
          } catch (error) {
            app.log.error(
              { err: error, agentId: agent.id, runId },
              "unconfirmed rollover replacement teardown remains pending",
            );
          }
        }
        createOperationalNotification({
          dedupeKey: `context-rollover:${replacementRunRollover.id}:confirmation-missing`,
          category: "coordination",
          severity: "attention",
          title: `${agent.title} could not confirm refreshed context`,
          body: replacementFailed
            ? "The replacement context remained above the safe threshold. Ponderosa retained the old provider session and stopped automatic rollover instead of looping."
            : replacementCancelled
            ? "The replacement Run was cancelled before refreshed context could be confirmed. Its bounded handoff is reserved for one authorized Retry Assignment and will not leak into unrelated work."
            : runError
              ? "The replacement Run ended before confirming safe context headroom. Its exact bounded handoff is reserved for one authorized Retry Assignment."
              : "The replacement Run completed its task but did not report the required context headroom. Ponderosa discarded that provider session; the next task will start from canonical context.",
          projectId: agent.projectId,
          conversationId: routingConversationId,
          agentId: agent.id,
          action: { kind: "open_agent", targetId: agent.id },
        });
      }
      if (schedulerCancelled && !owned && !isClosed() && store.getRunStatus(agent.id, runId) === "running") {
        const cancelled = store.appendEvent(agent.id, {
          type: "agent_lifecycle",
          status: "cancelled",
          reason: "agent_cancelled",
          executionId: runId,
          runtimeObservation: runtimeObservation(activeRun,
            activeRun.runtimeSession?.processIdentity ?? oneShotRuntime(agent.id, runId)?.handle.processIdentity,
            activeRun.observedRootExit, schedulerCancelled ? "scheduler cancellation" : controller.signal.aborted ? "Run abort observed" : undefined),
        });
        publish(agent.id, cancelled);
      }
      if (owned && !isClosed() && !controller.signal.aborted) {
        if (!rolloverSucceeded && !suppressRolloverHandoffOutput && !schedulerCancelled &&
            !runError && finalText.trim() &&
            firstTextSeq !== undefined && lastTextSeq !== undefined) {
          const output = store.appendEvent(agent.id, {
            type: "agent_output",
            executionId: runId,
            text: finalText.trimEnd(),
            sourceSeqStart: firstTextSeq,
            sourceSeqEnd: lastTextSeq,
          });
          publish(agent.id, output);
        }
        terminalLifecycle = store.appendEvent(agent.id, {
          type: "agent_lifecycle",
          status: schedulerCancelled ? "cancelled" : runError ? "failed" : "completed",
          reason: schedulerCancelled ? "agent_cancelled" : runError ? "runtime_error" : "turn_completed",
          executionId: runId,
          runtimeObservation: runtimeObservation(activeRun,
            activeRun.runtimeSession?.processIdentity ?? oneShotRuntime(agent.id, runId)?.handle.processIdentity,
            activeRun.observedRootExit, schedulerCancelled ? "scheduler cancellation" : undefined),
        });
        refreshProviderUsageAfterRun(runtimeEngineId);
        if (rolloverSucceeded) {
          try {
            coordinationV3.beginContextRolloverRetirement(runRollover!.id);
            const retiringRollover = coordinationV3.contextRollover(runRollover!.id);
            if (retiringRollover?.state === "session_retiring") {
              const continued = coordinationV3.prepareContextRolloverContinuation({
                id: retiringRollover.id,
              });
              if (continued.state === "continuation_ready") {
                notifyScheduler();
              } else if (continued.completionReason === "no_continuation_required") {
                await retireCompletedContextRolloverSession({
                  agentId: agent.id,
                  projectId: project.id,
                  rolloverId: continued.id,
                  providerSessionGeneration: continued.providerSessionGeneration,
                });
                app.log.info({
                  agentId: agent.id,
                  rolloverId: continued.id,
                  retiredSessionId: continued.oldProviderSessionId,
                }, "retired completed context rollover provider session");
              }
            }
          } catch (error) {
            // Rollover retirement is durable and retried by the centralized
            // admission guard. It must never prevent mandatory Run release
            // and scheduler settlement after terminal lifecycle is recorded.
            app.log.error({
              err: error,
              classification: "context_rollover_session_retirement_failed",
              agentId: agent.id,
              runId,
              rolloverId: runRollover!.id,
            }, "context rollover retirement remains pending after Run finalization");
          }
        } else if (policyRefreshSucceeded) {
          // Workspace/Project policy changes still invalidate the retained
          // provider cache after the current clean Run. They do not represent
          // unfinished work and therefore need no continuation Activation.
          clearAgentResumeSession(agent.id, "request_context_rollover");
          organizationEnvelopeStates.delete(agent.id);
          const staleRuntime = reusableRuntime(agent.id);
          if (staleRuntime) {
            activeRun.persistentRuntimeIdentity = undefined;
            try {
              await teardownPersistentRuntime(agent.id, staleRuntime, "policy context refresh", project.id);
            } catch (error) {
              app.log.error({ err: error, agentId: agent.id, runId }, "policy context refresh teardown remains pending");
            }
          }
        } else if (rolloverRequested &&
            (runError || controller.signal.aborted || schedulerCancelled || handoffActivationAcknowledged)) {
          const abandonedHandoff = store.continuationHandoffForRun(agent.id, runId);
          if (abandonedHandoff && !abandonedHandoff.consumedAt) {
            store.consumeContinuationHandoff(agent.id, abandonedHandoff.id, runId);
          }
          // Scheduler Run failure/cancellation owns the rollover transition in
          // the same fenced SQLite transaction. This executor only cleans up a
          // handoff that never became canonical; it must not race or overwrite
          // that terminal outcome.
        }
        // Teardown above may yield while cancellation advances the scheduler
        // fence. Re-read canonical status and exact Run ownership before any
        // successful provider side effect can escape this terminalization.
        schedulerCancelled ||= Boolean(
          activeRun.v3SchedulerRunId && coordinationV3?.isSchedulerRunCancelled(activeRun.v3SchedulerRunId),
        );
        const successfulRunStillAuthoritative = !isClosed() && !controller.signal.aborted &&
          !schedulerCancelled && ownsActiveRun(agent.id, activeRun);
        const acceptedSessionId = !runError && !schedulerCancelled ? store.resumeSessionId(agent.id) : undefined;
        if (acceptedSessionId) {
          organizationEnvelopeStates.set(agent.id, {
            sessionId: acceptedSessionId,
            hash: policySnapshotHash,
          });
        }
        const runFailureKind = runError && runFailureClassification
          ? classifyProviderFailure(runError, runFailureClassification)
          : undefined;
        const publicRunError = runError
          ? runFailureKind
            ? publicProviderFailureSummary(runError, runFailureKind) ?? "Provider execution failed."
            : "Agent execution failed due to an internal runtime error."
          : undefined;
        if (runError && publicRunError && !schedulerCancelled) {
          if (runFailureKind === "authentication") {
            engineAvailability.record({
              engineId: runtimeEngineId,
              available: false,
              failureCategory: runFailureKind,
              detail: runError,
              source: "provider_run",
            });
            if (providerEnabled(runtimeEngineId)) createOperationalNotification({
              dedupeKey: `provider:${runtimeEngineId}:unavailable`,
              category: "provider",
              severity: "attention",
              title: `${engines.get(runtimeEngineId)?.adapter.displayName ?? runtimeEngineId} stopped accepting work`,
              body: providerUnavailableNotificationBody(runError, runFailureKind),
              projectId: agent.projectId,
              conversationId: agent.conversationId,
              action: { kind: "open_settings", targetId: runtimeEngineId },
            });
          }
          notifyManagerOfChildFailure(agent.id, runId, publicRunError);
        } else if (successfulRunStillAuthoritative) {
          const recoveryEvidence = engineAvailability.record({
            engineId: runtimeEngineId,
            available: true,
            operationStartedAt: activeRun.startedAt,
            detail: "provider Run completed successfully",
            source: "provider_run",
          });
          if (recoveryEvidence.available) resolveOperationalNotification(`provider:${runtimeEngineId}:unavailable`);
        }
      }
      const released = releaseActiveRun(agent.id, activeRun, controller.signal.aborted || schedulerCancelled ? "cancelled" : runError ? "failed" : "completed");
      if (released || activeRuns.get(agent.id) !== activeRun) {
        // The lifecycle event drives workspace refetches. Delay it until this
        // Run is no longer the authoritative active Run so a fast refetch
        // cannot preserve a phantom active state after completion.
        publishTerminalLifecycle();
      }
      if (released && activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined) {
        try {
          if (schedulerCancelled) {
            // Cancellation already terminalized and fenced this
            // uninjected Run atomically. Do not reinterpret it as failure.
          } else if (controller.signal.aborted) coordinationV3!.cancelAgentRun({
            agentId: agent.id,
            idempotencyKey: `runtime-abort:${activeRun.v3SchedulerRunId}`,
          });
          else if (runError) {
            const failureKind = runFailureClassification
              ? classifyProviderFailure(runError, runFailureClassification)
              : undefined;
            const confirmedNotExecuted = projectedProviderNonExecutionEvidence &&
              failureKind !== undefined && !providerWorkObserved &&
              !v3PromptInjected &&
              (failureKind === "capacity" || failureKind === "rate_limit" || failureKind === "quota_exhausted" || failureKind === "throttled");
            coordinationV3!.failRun({
            runId: activeRun.v3SchedulerRunId,
            fencingToken: activeRun.v3FencingToken,
            workerId: coordinationV3WorkerId,
            sameRunResumable: false,
            ...(failureKind ? { failureKind } : {}),
            ...(!failureKind && internalFailureCode ? { internalFailureCode } : {}),
            ...(confirmedNotExecuted ? { confirmedNotExecuted: true } : {}),
            retryable: !projectWorkspaceUnavailable && failureKind !== "authentication",
            error: failureKind
              ? publicProviderFailureSummary(runError, failureKind) ?? "Provider execution failed."
              : runError,
            ...(failureKind ? {
              failureDetail: {
                phase: providerStreamBoundaryFailure
                  ? `${providerStreamBoundaryFailure.kind}_${providerStreamBoundaryFailure.providerAccepted ? "after" : "before"}_acceptance`
                  : v3PromptInjected ? "provider_execution" : "prompt_submission",
                promptInjectionState: coordinationV3!.agentSnapshot(agent.id).activeRun?.promptInjectionState
                  ?? (v3PromptInjected ? "injected" : "not_injected"),
                message: runError,
                ...(providerQuotaResetAt ? { quotaResetAt: providerQuotaResetAt } : {}),
                ...(providerQuotaLimit ? { quotaLimit: providerQuotaLimit } : {}),
                ...(providerHttpStatusCode !== undefined ? { httpStatusCode: providerHttpStatusCode } : {}),
                ...(providerRetryAfterMs !== undefined ? { retryAfterMs: providerRetryAfterMs } : {}),
              },
            } : {}),
          });
          }
          else {
            // Canonical Decision wait repair is shared by all terminal paths
            // in CoordinationV3Store, including provider failure and lease recovery.
            coordinationV3!.completeRun(activeRun.v3SchedulerRunId, activeRun.v3FencingToken);
            if (routingConversationId && pendingCommunicationV4NextRunDeliveryIds.length > 0) {
              // runId identifies the exact provider-input manifest used as
              // proof. Delivery authority persists provider.scheduler_run_id as
              // delivered_run_id, so operator links always target scheduler
              // Run authority rather than a provider execution identifier.
              coordinationV3!.markCommunicationV4NextRunDeliveriesDelivered({
                projectId: project.id,
                conversationId: routingConversationId,
                agentId: agent.id,
                runId,
                deliveryIds: pendingCommunicationV4NextRunDeliveryIds,
              });
            }
          }
        } catch (error) {
          app.log.error({ err: error, runId }, "Communication V3 terminal transition failed");
        }
        notifyScheduler();
        publishMessageDeliveryChanged(agent.id);
      }
      if (released) {
        agentMessageCapabilities.delete(messageCapability);
      }
      if (released && !isClosed() && !controller.signal.aborted && !schedulerCancelled && !runError) {
        const acceptedSessionId = store.resumeSessionId(agent.id);
        if (acceptedSessionId && cursorConversationId && cursorChannel) {
          contextCursors.commit({
            agentId: agent.id,
            engine: runtimeEngineId,
            model: cursorModel,
            sessionId: acceptedSessionId,
            conversationId: cursorConversationId,
            channel: cursorChannel,
            // A continued session advances only through the FIFO page that
            // was actually submitted. A fresh/reseeded session deliberately
            // accepts the newest bounded tail and records the canonical tip.
            lastMessageId: !usedFreshFallback && incremental && roomDeltaOmitted
              ? roomMessages.at(-1)?.id ?? previousCursor?.lastMessageId
              : roomCanonicalTipId,
            routingHash,
          });
        }
        if (acceptedSessionId && routingConversationId && sourceChannel !== "main") {
          contextCursors.commit({
            agentId: agent.id,
            engine: runtimeEngineId,
            model: cursorModel,
            sessionId: acceptedSessionId,
            conversationId: routingConversationId,
            channel: "broadcast",
            lastMessageId: !usedFreshFallback && broadcastIncremental && broadcastDeltaOmitted
              ? initialBroadcastContext.at(-1)?.id ?? previousBroadcastCursor?.lastMessageId
              : broadcastCanonicalTipId,
            routingHash,
          });
        }
      }
      const retainedRuntime = reusableRuntime(agent.id);
      const pendingRolloverRetainsRuntime = coordinationV3.activeContextRollover(agent.id)?.state === "requested";
      if (released && retainedRuntime && !isClosed() && !controller.signal.aborted &&
          !pendingRolloverRetainsRuntime && !deploymentDraining() && !deletingAgentIds.has(agent.id) &&
          store.getAgent(agent.id)?.projectId === project.id) {
        scheduleRuntimeIdleClose(agent.id, retainedRuntime);
      } else if (released && retainedRuntime && (isClosed() || deploymentDraining() || controller.signal.aborted || deletingAgentIds.has(agent.id))) {
        teardownPersistentRuntimeInBackground(agent.id, retainedRuntime, "Run authority ended during teardown");
      }
      if (released) notifyScheduler();
    }
  })().catch(async (error: unknown) => {
    if (!(error instanceof AgentEventPersistenceError)) throw error;
    app.log.error({ runId, agentId: agent.id, persistenceFailure: error.diagnostic },
      "Agent persistence failed; settling exact scheduler Run without another audit append");
    if (!activeRun.v3SchedulerRunId || activeRun.v3FencingToken === undefined ||
        !coordinationV3.ownsRunForCleanup(activeRun.v3SchedulerRunId, activeRun.v3FencingToken, coordinationV3WorkerId)) return;
    // Close provider-facing authority synchronously before any asynchronous
    // cleanup. Host settlement keeps the original fence; accepted inputs remain
    // uncertain, never reclassified as undelivered or automatically resubmitted.
    coordinationV3.fenceRunSideEffects(activeRun.v3SchedulerRunId, activeRun.v3FencingToken, coordinationV3WorkerId);
    activeRun.ownershipState = "interrupted";
    agentMessageCapabilities.delete(messageCapability);
    organizationEnvelopeStates.delete(agent.id);
    scheduledSessionRollovers.delete(agent.id);
    const runtime = reusableRuntime(agent.id);
    const shot = oneShotRuntime(agent.id, runId);
    const cleanupOperations = [
      ...(runtime ? [teardownPersistentRuntime(agent.id, runtime, "Agent persistence failure", project.id)] : []),
      ...(shot ? [teardownOneShotRuntime(shot, "Agent persistence failure")] : []),
    ];
    // Observe rejection immediately; the existing teardown owner retains its
    // handle, durable process identity, retry timer and admission blocker.
    const cleanup = Promise.allSettled(cleanupOperations);
    const released = releaseActiveRun(agent.id, activeRun, "failed");
    coordinationV3.failRun({
      runId: activeRun.v3SchedulerRunId, fencingToken: activeRun.v3FencingToken,
      workerId: coordinationV3WorkerId, sameRunResumable: false, retryable: false,
      internalFailureCode: "internal_runtime_error",
      error: `Agent event persistence failed (${error.diagnostic.code}, sequence ${error.diagnostic.seq}).`,
    });
    publishMessageDeliveryChanged(agent.id);
    notifyScheduler();
    for (const result of await cleanup) if (result.status === "rejected") {
      app.log.error({ agentId: agent.id, runId, category: "provider_cleanup_pending" },
        "provider teardown after Agent persistence failure remains pending");
    }
    if (released) notifyScheduler();
  });
  activeRun.completion = execution;
  // A provider root-exit fence removes scheduler ownership immediately but
  // retains this exact local Run as a completion barrier. Release it only
  // after the event loop unwinds; identity equality prevents a stale
  // generation from deleting a successor.
  void execution.finally(() => {
    if (activeRuns.get(agent.id) === activeRun && !ownsActiveRun(agent.id, activeRun)) {
      activeRuns.delete(agent.id);
      drainDeploymentIdleAuthorities();
      notifyScheduler();
    }
    if (activeRuns.get(agent.id) !== activeRun) publishTerminalLifecycle();
  }).catch(() => undefined);
  const cleanup = execution.finally(async () => {
    const oneShot = oneShotRuntime(agent.id, runId);
    try {
      if (oneShot) await teardownOneShotRuntime(oneShot, "Run completion");
    } finally {
      if (runtimeAttachmentCleanupAfterRun) {
        await cleanupRuntimeAttachments(runtimeAttachmentDirectory);
      }
    }
  });
  void cleanup.catch((error) => app.log.error({ err: error, agentId: agent.id, runId }, "provider Run cleanup remains pending"));

}
