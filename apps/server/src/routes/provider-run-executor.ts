import {
  PONDEROSA_CONTEXT_TOOL,
  PONDEROSA_COORDINATE_TOOL,
  PONDEROSA_CREATE_MANAGED_AGENT_TOOL,
  PONDEROSA_DECISION_TOOL,
  PONDEROSA_DOCS_TOOL,
  PONDEROSA_MANAGE_TOOL,
  PONDEROSA_MESSAGE_TOOL,
  PONDEROSA_RESULT_TOOL,
  PONDEROSA_ROLLOVER_TOOL,
  PONDEROSA_TEAM_DIRECTORY_TOOL,
  PONDEROSA_UPDATE_REQUEST_TOOL,
  effectiveProviderPermissionMode,
  type AgentDto,
  type AgentEvent,
  type ChatMessage,
  type ConversationMessageDto,
  type ProjectDto,
  type ProviderInputSourceManifest,
  type RuntimeProcessHandle,
} from "@ponderosa/core";
import { randomUUID } from "node:crypto";
import type { LogEvent } from "@ponderosa/agents";
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
import type { ContextCursor } from "../context-cursors.js";
import { PROVIDER_DYNAMIC_TOOLS } from "../runtime-selection.js";
import { cleanupRuntimeAttachments } from "../runtime-attachments.js";
import { AUTO_ALLOWED_DECISION_OPTION_ID } from "../runtime-elicitation-broker.js";
import type { AgentMessageRunContext } from "./agent-message-run.js";

function humanizeProviderName(value: string): string {
  return value
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

export interface ProviderRunExecutionInput {
  activeRun: ActiveRun;
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
  previousBroadcastCursor: ContextCursor | undefined;
  previousCursor: ContextCursor | undefined;
  project: ProjectDto;
  prompt: string;
  resumeSessionId: string | undefined;
  reusablePersistentRuntime: PersistentRuntime | undefined;
  rolloverInstructionPrompt: string;
  roomCanonicalTipId: string | undefined;
  roomDeltaOmitted: boolean;
  roomMessages: ConversationMessageDto[];
  routingConversationId: string | undefined;
  routingHash: string;
  runId: string;
  runtimeEngineId: string;
  runtimeSessionContractHash: string;
  runtimeAttachmentDirectory: string | undefined;
  runtimeAttachmentCleanupAfterRun: boolean;
  seedHistory: ChatMessage[];
  sourceChannel: "main" | "individual";
  v3FencingToken: number | undefined;
  v3InjectionId: string | undefined;
}

export function startProviderRunExecution(
  app: FastifyInstance,
  context: AgentMessageRunContext,
  input: ProviderRunExecutionInput,
): void {
  const {
    opts,
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
    waitBeforeRuntimePersist,
    publish,
    publishMessageDeliveryChanged,
    publishWorkspaceSince,
    runtimeElicitations,
    createOperationalNotification,
    resolveOperationalNotification,
  } = context;
  const {
    activeRun,
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
    previousBroadcastCursor,
    previousCursor,
    project,
    prompt,
    resumeSessionId,
    reusablePersistentRuntime,
    rolloverInstructionPrompt,
    roomCanonicalTipId,
    roomDeltaOmitted,
    roomMessages,
    routingConversationId,
    routingHash,
    runId,
    runtimeEngineId,
    runtimeSessionContractHash,
    runtimeAttachmentDirectory,
    runtimeAttachmentCleanupAfterRun,
    seedHistory,
    sourceChannel,
    v3FencingToken,
    v3InjectionId,
  } = input;

  const execution = (async () => {
    // Consolidate ordinary response deltas into one durable, execution-scoped
    // Work log entry. Communication is created only by explicit intent calls.
    let runError: string | undefined;
    let finalText = "";
    let firstTextSeq: number | undefined;
    let lastTextSeq: number | undefined;
    let v3PromptInjected = false;
    let continuationHandoffConsumed = false;
    let providerWorkObserved = false;
    let schedulerCancelled = false;
    let usedFreshFallback = false;
    let projectWorkspaceUnavailable = false;
    let contextRolloverMeasured = false;
    try {
      const environment = {
        PONDEROSA_AGENT_MESSAGE_URL: agentMessageUrl,
        PONDEROSA_DOCUMENT_URL: agentMessageUrl.replace(/\/api\/agent-messages$/, "/api/agent-documents"),
        PONDEROSA_AGENT_DIRECTORY_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-directory`,
        PONDEROSA_AGENT_CONTEXT_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-context`,
        PONDEROSA_AGENT_COORDINATE_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-coordinate`,
        PONDEROSA_AGENT_RESULT_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-results`,
        PONDEROSA_AGENT_DOCS_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-docs`,
        PONDEROSA_AGENT_UPDATE_REQUEST_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-request-updates`,
        PONDEROSA_AGENT_BROWSER_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-browser`,
        PONDEROSA_AGENT_SPAWN_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-spawn`,
        PONDEROSA_AGENT_DECISION_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-decisions`,
        PONDEROSA_AGENT_MANAGE_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-management`,
        PONDEROSA_AGENT_MESSAGE_TOKEN: messageCapability,
        PONDEROSA_AGENT_ROLLOVER_URL: `${agentMessageUrl.replace(/\/api\/agent-messages$/, "")}/api/agent-session/rollover`,
        PONDEROSA_INTERNAL_SUBAGENTS_DISABLED: "1",
      };
      const openPersistentRuntime = async (
        sessionResumeId: string | undefined,
        onRuntimeSpawned: (handle: RuntimeProcessHandle) => void,
        identity: object,
      ): Promise<PersistentRuntime> => {
        const session = await engine.adapter.openSession!({
          agentId: agent.id,
          cwd: project.hostPath,
          resumeSessionId: sessionResumeId,
          history: sessionResumeId ? [] : seedHistory,
          model: effectiveModel,
          effort: effectiveEffort,
          speed: effectiveSpeed,
          environment,
          dynamicTools: PROVIDER_DYNAMIC_TOOLS,
          handleDynamicToolCall: async (call) => {
            const browserOperation = call.name.startsWith("ponderosa_browser_")
              ? call.name.slice("ponderosa_browser_".length)
              : undefined;
            const directoryArguments = call.arguments && typeof call.arguments === "object"
              ? call.arguments as { agentId?: unknown }
              : {};
            const contextArguments = call.arguments && typeof call.arguments === "object"
              ? call.arguments as { cursor?: unknown; limit?: unknown }
              : {};
            const isDirectory = call.name === PONDEROSA_TEAM_DIRECTORY_TOOL.name;
            const isContext = call.name === PONDEROSA_CONTEXT_TOOL.name;
            const isResult = call.name === PONDEROSA_RESULT_TOOL.name;
            const isDocs = call.name === PONDEROSA_DOCS_TOOL.name;
            const isRollover = call.name === PONDEROSA_ROLLOVER_TOOL.name;
            const contextQuery = new URLSearchParams();
            if (typeof contextArguments.cursor === "string" && contextArguments.cursor.trim()) contextQuery.set("cursor", contextArguments.cursor.trim());
            if (typeof contextArguments.limit === "number") contextQuery.set("limit", String(contextArguments.limit));
            const url = call.name === PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name
              ? "/api/agent-spawn"
              : call.name === PONDEROSA_DECISION_TOOL.name
              ? "/api/agent-decisions"
              : call.name === PONDEROSA_MANAGE_TOOL.name
              ? "/api/agent-management"
              : call.name === PONDEROSA_COORDINATE_TOOL.name
              ? "/api/agent-coordinate"
              : isResult
                ? "/api/agent-results"
              : isDocs
                ? "/api/agent-docs"
              : isRollover
                ? "/api/agent-session/rollover"
              : call.name === PONDEROSA_UPDATE_REQUEST_TOOL.name
                ? "/api/agent-request-updates"
                : call.name === PONDEROSA_MESSAGE_TOOL.name
                  ? "/api/agent-messages"
                  : isDirectory
                    ? `/api/agent-directory${typeof directoryArguments.agentId === "string" && directoryArguments.agentId.trim() ? `/${encodeURIComponent(directoryArguments.agentId.trim())}` : ""}`
                  : isContext
                    ? `/api/agent-context${contextQuery.size ? `?${contextQuery.toString()}` : ""}`
                  : browserOperation
                    ? "/api/agent-browser"
                  : undefined;
            if (!url) {
              return { success: false, text: `Unknown Ponderosa tool: ${call.name}` };
            }
            const response = await app.inject({
              method: isDirectory || isContext ? "GET" : "POST",
              url,
              headers: {
                authorization: `Bearer ${messageCapability}`,
                "content-type": "application/json",
              },
              ...(!(isDirectory || isContext) ? { payload: JSON.stringify(browserOperation
                ? { ...(call.arguments && typeof call.arguments === "object" ? call.arguments : {}), operation: browserOperation }
                : call.arguments ?? {}) } : {}),
            });
            return {
              success: response.statusCode >= 200 && response.statusCode < 300,
              text: response.body,
            };
          },
          handleElicitation: async (request) => {
            // Persistent provider sessions outlive the Run that opened them,
            // so resolve authority from the current Run instead of this
            // callback's original closure.
            const currentRun = activeRuns.get(agent.id);
            if (!currentRun || !ownsActiveRun(agent.id, currentRun) || currentRun.controller.signal.aborted) {
              return { action: "cancel" };
            }
            if (request.mode === "url") {
              try {
                const parsed = new URL(request.url);
                if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { action: "cancel" };
              } catch {
                return { action: "cancel" };
              }
            }
            const conversationAutoApproves =
              Boolean(currentRun.conversationId) && (() => {
                const conversation = store.getConversation(currentRun.conversationId!);
                const project = conversation
                  ? store.getProject(conversation.projectId)
                  : undefined;
                return Boolean(conversation && project &&
                  effectiveProviderPermissionMode({
                    conversation: conversation.providerPermissionMode,
                    project: project.providerPermissionMode,
                    workspace: workspace.getPreferences().providerPermissionMode,
                  }) === "auto_confirmations");
              })() &&
              runtimeElicitations.canRememberForRun(request);
            if (conversationAutoApproves ||
                runtimeElicitations.allowsForRun(currentRun.runId, request)) {
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
                ? `${agent.title} needs a secure ${providerName} connection before it can continue.`
                : rememberableConfirmation
                  ? `${agent.title} needs permission for ${providerName} before it can continue.`
                : `${agent.title} needs information for ${providerName} before it can continue.`,
              context: request.mode === "url"
                ? `Open the secure ${providerName} connection page, then return here to confirm.`
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
            // Close the tiny race where the Chat policy changes after the
            // initial check but before this provider request enters the broker.
            if (rememberableConfirmation &&
                currentRun.conversationId &&
                (() => {
                  const conversation = store.getConversation(currentRun.conversationId!);
                  const project = conversation
                    ? store.getProject(conversation.projectId)
                    : undefined;
                  return Boolean(conversation && project &&
                    effectiveProviderPermissionMode({
                      conversation: conversation.providerPermissionMode,
                      project: project.providerPermissionMode,
                      workspace: workspace.getPreferences().providerPermissionMode,
                    }) === "auto_confirmations");
                })()) {
              const resolved = workspace.resolveDecision(decision.id, {
                optionId: AUTO_ALLOWED_DECISION_OPTION_ID,
                text: "Allowed automatically by this Chat’s provider permissions.",
                respondedAt: new Date().toISOString(),
              });
              if (resolved) {
                runtimeElicitations.respond(decision.id, {
                  action: "accept",
                  content: {},
                });
                publishWorkspaceSince(cursor);
                return waiting;
              }
            }
            workspace.createNotification({
              projectId: decision.projectId,
              conversationId: decision.conversationId,
              conversationIds: agent.conversationIds,
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
              const notification = workspace.listNotifications().find((item) =>
                item.dedupeKey === `decision:${decision.id}` && (item.status ?? "open") === "open");
              if (notification) workspace.setNotificationStatus(notification.id, "resolved");
              publishWorkspaceSince(cancelCursor);
            }
            return response;
          },
          onRuntimeSpawned,
          onRuntimeRootExit: (detail) => persistentRootExited(agent.id, identity, detail),
          onCapabilitiesChanged: () => reportRuntimeCapabilitiesChanged(project.id, engine.adapter.id),
          signal: controller.signal,
        });
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
            if (state.handle && state.handle !== handle) {
              void handle.close().catch((error) => {
                app.log.error({ err: error, agentId: agent.id }, "duplicate opening provider handle failed to terminate");
              });
              throw new Error(`provider adapter registered multiple opening handles for ${agent.id}`);
            }
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
        activeRun.persistentRuntimeIdentity = persistentRuntime.identity;
        activeRun.runtimeSession = persistentRuntime.session;
        scheduleRuntimeLivenessHeartbeat(agent.id, activeRun);
      }
      let persistentTurnStarted = false;
      const registerOneShotRuntime = (handle: RuntimeProcessHandle): void => {
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
      const startStream = (sessionId?: string): AsyncIterable<AgentEvent> => sessionId
        ? persistentRuntime
          ? {
              async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
                if (!persistentTurnStarted) {
                  await persistentRuntime!.session.startTurn({
                    prompt,
                    kind: "collaboration",
                    model: effectiveModel,
                    effort: effectiveEffort,
                    speed: effectiveSpeed,
                    clientMessageId: communicationEventId,
                  });
                  persistentTurnStarted = true;
                }
                while (true) {
                  const next = await persistentRuntime!.iterator.next();
                  if (next.done) {
                    teardownPersistentRuntimeInBackground(agent.id, persistentRuntime!, "provider stream ended");
                    yield { type: "error", message: "persistent engine session stopped" };
                    return;
                  }
                  yield next.value;
                  if (next.value.type === "turn_done" || next.value.type === "error") return;
                }
              },
            }
          : engine.adapter.continue({
              agentId: agent.id,
              cwd: project.hostPath,
              prompt,
              resumeSessionId: sessionId,
              model: effectiveModel,
              effort: effectiveEffort,
              speed: effectiveSpeed,
              environment,
              signal: controller.signal,
              onRuntimeRootExit: () => agentMessageCapabilities.delete(messageCapability),
              onRuntimeSpawned: registerOneShotRuntime,
            })
        : persistentRuntime
          ? {
              async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
                if (!persistentTurnStarted) {
                  await persistentRuntime!.session.startTurn({
                    prompt: freshPrompt,
                    kind: "collaboration",
                    model: effectiveModel,
                    effort: effectiveEffort,
                    speed: effectiveSpeed,
                    clientMessageId: communicationEventId,
                  });
                  persistentTurnStarted = true;
                }
                while (true) {
                  const next = await persistentRuntime!.iterator.next();
                  if (next.done) {
                    teardownPersistentRuntimeInBackground(agent.id, persistentRuntime!, "provider stream ended");
                    yield { type: "error", message: "persistent engine session stopped" };
                    return;
                  }
                  yield next.value;
                  if (next.value.type === "turn_done" || next.value.type === "error") return;
                }
              },
            }
          : engine.adapter.seed({
              agentId: agent.id,
              cwd: project.hostPath,
              prompt: freshPrompt,
              history: seedHistory,
              model: effectiveModel,
              effort: effectiveEffort,
              speed: effectiveSpeed,
              environment,
              signal: controller.signal,
              onRuntimeRootExit: () => agentMessageCapabilities.delete(messageCapability),
              onRuntimeSpawned: registerOneShotRuntime,
            });

      const persistAcceptedSessionSnapshot = (acceptedSessionId: string): void => {
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
          toolContractHash: runtimeSessionContractHash,
          artifactIds,
        });
        publish(agent.id, sessionSnapshot);
      };

      let sessionId = resumeSessionId;
      while (true) {
        const bufferedSessionEvents: AgentEvent[] = [];
        let retryFresh = false;
        if (activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined && !v3PromptInjected) {
          coordinationV3!.markPromptSubmitted({
            injectionId: v3InjectionId!,
            runId: activeRun.v3SchedulerRunId,
            fencingToken: activeRun.v3FencingToken,
            providerSessionId: sessionId ?? persistentRuntime?.session.engineAgentId,
          });
        }
        for await (const event of startStream(sessionId)) {
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
          if (event.type !== "error" && event.type !== "session") providerWorkObserved = true;
          if (activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined && !v3PromptInjected && event.type !== "error") {
            coordinationV3!.acknowledgePromptInjection({
              injectionId: v3InjectionId!,
              runId: activeRun.v3SchedulerRunId,
              fencingToken: activeRun.v3FencingToken,
              providerSessionId: sessionId ?? persistentRuntime?.session.engineAgentId,
            });
            if (rolloverInstructionPrompt) contextRolloverPending.delete(agent.id);
            v3PromptInjected = true;
            if (continuationHandoff && !continuationHandoffConsumed) {
              continuationHandoffConsumed = store.consumeContinuationHandoff(
                agent.id,
                continuationHandoff.id,
                runId,
              );
            }
          }
          if (deletingAgentIds.has(agent.id) || isClosed() || controller.signal.aborted || !renewExecutionLease(agent.id, activeRun)) break;
          if (!receiveRuntimeEvent(agent.id, activeRun)) break;
          if (opts.runtimeEventFaults?.beforePersist && !await waitBeforeRuntimePersist(agent.id, activeRun, event)) break;
          if (event.type === "error" && sessionId && !providerWorkObserved && shouldRolloverEngineSession(runtimeEngineId, event.message)) {
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
              sourceManifest: freshProviderInputManifest,
            });
            manifestArtifactIds.splice(0, manifestArtifactIds.length, ...freshProviderInputManifest.artifactIds);
            if (persistentRuntime) {
              const staleRuntime = persistentRuntime;
              await teardownPersistentRuntime(agent.id, staleRuntime, "failed resume replacement", project.id);
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
          const logEvent: LogEvent = event.type === "text" || event.type === "reasoning" || event.type === "work_item_update" || event.type === "turn_done"
            ? { ...event, executionId: runId }
            : event;
          const stored = await persistRuntimeEvent(agent.id, activeRun, logEvent);
          if (!stored) break;
          // Once provider acceptance is fenced and durable, preserve the
          // compatible session's expanded artifact roots even if the
          // operator later cancels the turn. Fresh providers reveal their
          // opaque id through the session event; continuations retain it.
          const acceptedSessionId = event.type === "session"
            ? event.sessionId
            : event.type !== "error"
              ? sessionId
              : undefined;
          if (acceptedSessionId) persistAcceptedSessionSnapshot(acceptedSessionId);
          if (event.type === "text") {
            finalText += event.delta;
            firstTextSeq ??= stored.seq;
            lastTextSeq = stored.seq;
          }
          if (event.type === "turn_done" && !contextRolloverMeasured &&
              ownsActiveRun(agent.id, activeRun) && activeRun.runtimeSession) {
            contextRolloverMeasured = true;
            const preferences = workspace.getPreferences();
            if (preferences.contextRolloverEnabled &&
                !store.continuationHandoffForRun(agent.id, runId)) {
              const usage = activeRun.runtimeSession.contextUsage?.();
              const absoluteThresholdReached = usage !== undefined &&
                usage.usedTokens >= preferences.contextRolloverTokens;
              const windowThreshold = usage?.windowTokens === undefined
                ? undefined
                : Math.max(
                    75_000,
                    usage.windowTokens * preferences.contextRolloverWindowFraction,
                  );
              const windowThresholdReached = usage !== undefined &&
                windowThreshold !== undefined &&
                usage.usedTokens >= windowThreshold;
              const effectiveThreshold = windowThreshold === undefined
                ? preferences.contextRolloverTokens
                : Math.min(preferences.contextRolloverTokens, windowThreshold);
              if (usage && (absoluteThresholdReached || windowThresholdReached)) {
                const providerSessionId = store.resumeSessionId(agent.id);
                if (providerSessionId) {
                  contextRolloverPending.set(agent.id, {
                    sessionId: providerSessionId,
                    usedTokens: usage.usedTokens,
                    at: new Date().toISOString(),
                  });
                  await persistRuntimeEvent(agent.id, activeRun, {
                    type: "context_rollover_triggered",
                    executionId: runId,
                    usedTokens: usage.usedTokens,
                    threshold: effectiveThreshold,
                  });
                  app.log.info({
                    agentId: agent.id,
                    runId,
                    providerSessionId,
                    usedTokens: usage.usedTokens,
                    threshold: effectiveThreshold,
                  }, "provider context rollover marked for the next Run");
                }
              }
            }
          }
          if (event.type === "error") runError = event.message;
        }
        if (!retryFresh) break;
      }
      if (activeRun.v3SchedulerRunId && !v3PromptInjected && !runError) {
        runError = "provider ended before prompt injection could be confirmed";
      }
    } catch (err) {
      if (isClosed() || controller.signal.aborted || !ownsActiveRunForAuditDrain(agent.id, activeRun)) return;
      schedulerCancelled = Boolean(activeRun.v3SchedulerRunId && coordinationV3?.isSchedulerRunCancelled(activeRun.v3SchedulerRunId));
      if (schedulerCancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      const workspaceIssue = await reconcileProjectWorkspace(project, agent);
      projectWorkspaceUnavailable = Boolean(workspaceIssue);
      runError = workspaceIssue ?? message;
      await persistRuntimeEvent(agent.id, activeRun, { type: "error", message: runError });
    } finally {
      runtimeElicitations.clearRun(runId);
      const owned = ownsActiveRunForAuditDrain(agent.id, activeRun);
      schedulerCancelled ||= Boolean(!isClosed() && activeRun.v3SchedulerRunId && coordinationV3?.isSchedulerRunCancelled(activeRun.v3SchedulerRunId));
      const rolloverRequested = owned && scheduledSessionRollovers.delete(agent.id);
      const rolloverSucceeded = Boolean(rolloverRequested && !isClosed() && !controller.signal.aborted && !schedulerCancelled && !runError);
      if (schedulerCancelled && !owned && !isClosed() && store.getRuns(agent.id).some((run) => run.id === runId && run.status === "running")) {
        const cancelled = store.appendEvent(agent.id, {
          type: "agent_lifecycle",
          status: "cancelled",
          reason: "agent_cancelled",
          executionId: runId,
        });
        publish(agent.id, cancelled);
      }
      if (owned && !isClosed() && !controller.signal.aborted) {
        if (!schedulerCancelled && !runError && finalText.trim() && firstTextSeq !== undefined && lastTextSeq !== undefined) {
          const output = store.appendEvent(agent.id, {
            type: "agent_output",
            executionId: runId,
            text: finalText.trimEnd(),
            sourceSeqStart: firstTextSeq,
            sourceSeqEnd: lastTextSeq,
          });
          publish(agent.id, output);
        }
        const terminal = store.appendEvent(agent.id, {
          type: "agent_lifecycle",
          status: schedulerCancelled ? "cancelled" : runError ? "failed" : "completed",
          reason: schedulerCancelled ? "agent_cancelled" : runError ? "runtime_error" : "turn_completed",
          executionId: runId,
        });
        publish(agent.id, terminal);
        refreshProviderUsageAfterRun(runtimeEngineId);
        if (rolloverSucceeded) {
          clearAgentResumeSession(agent.id, "explicit_compaction");
          organizationEnvelopeStates.delete(agent.id);
          const staleRuntime = reusableRuntime(agent.id);
          if (staleRuntime) {
            // This Run is already terminal and is deliberately retiring its
            // provider. Do not let the observed root-exit callback
            // reinterpret that intentional teardown as a runtime failure.
            activeRun.persistentRuntimeIdentity = undefined;
            try {
              await teardownPersistentRuntime(agent.id, staleRuntime, "continuation handoff rollover", project.id);
            } catch (error) {
              // The retained teardown registry keeps replacement fenced and
              // will retry. The completed source Run and pending handoff
              // remain durable even though cleanup is still operationally pending.
              app.log.error({ err: error, agentId: agent.id, runId }, "continuation rollover teardown remains pending");
            }
          }
        } else if (rolloverRequested) {
          const abandonedHandoff = store.continuationHandoffForRun(agent.id, runId);
          if (abandonedHandoff && !abandonedHandoff.consumedAt) {
            store.consumeContinuationHandoff(agent.id, abandonedHandoff.id, runId);
          }
        }
        const acceptedSessionId = !runError && !schedulerCancelled ? store.resumeSessionId(agent.id) : undefined;
        if (acceptedSessionId) {
          organizationEnvelopeStates.set(agent.id, {
            sessionId: acceptedSessionId,
            hash: policySnapshotHash,
          });
        }
        if (runError && !schedulerCancelled) {
          if (classifyProviderFailure(runError) === "authentication") {
            engineAvailability.record({
              engineId: runtimeEngineId,
              available: false,
              detail: runError,
              source: "provider_run",
            });
            if (providerEnabled(runtimeEngineId)) createOperationalNotification({
              dedupeKey: `provider:${runtimeEngineId}:unavailable`,
              category: "provider",
              severity: "attention",
              title: `${engines.get(runtimeEngineId)?.adapter.displayName ?? runtimeEngineId} stopped accepting work`,
              body: `${runError} Queued Runs using this provider are now held.`,
              projectId: agent.projectId,
              conversationId: agent.conversationId,
              action: { kind: "open_settings", targetId: runtimeEngineId },
            });
          }
          notifyManagerOfChildFailure(agent.id, runId, runError);
        } else if (!schedulerCancelled && engineAvailability.denial(runtimeEngineId)) {
          engineAvailability.record({
            engineId: runtimeEngineId,
            available: true,
            detail: "provider Run completed successfully",
            source: "provider_run",
          });
          resolveOperationalNotification(`provider:${runtimeEngineId}:unavailable`);
        }
      }
      const released = releaseActiveRun(agent.id, activeRun, controller.signal.aborted || schedulerCancelled ? "cancelled" : runError ? "failed" : "completed");
      if (released && activeRun.v3SchedulerRunId && activeRun.v3FencingToken !== undefined) {
        try {
          if (schedulerCancelled) {
            // Trigger disable/delete already terminalized and fenced this
            // uninjected Run atomically. Do not reinterpret it as failure.
          } else if (controller.signal.aborted) coordinationV3!.cancelAgentRun({
            agentId: agent.id,
            idempotencyKey: `runtime-abort:${activeRun.v3SchedulerRunId}`,
          });
          else if (runError) {
            const failureKind = classifyProviderFailure(runError);
            coordinationV3!.failRun({
            runId: activeRun.v3SchedulerRunId,
            fencingToken: activeRun.v3FencingToken,
            workerId: coordinationV3WorkerId,
            sameRunResumable: false,
            failureKind,
            confirmedNotExecuted: !providerWorkObserved && (failureKind === "capacity" || failureKind === "rate_limit"),
            retryable: !projectWorkspaceUnavailable && failureKind !== "authentication",
            error: `[${failureKind}] ${runError}`,
            failureDetail: {
              phase: v3PromptInjected ? "provider_execution" : "prompt_submission",
              promptInjectionState: coordinationV3!.agentSnapshot(agent.id).activeRun?.promptInjectionState
                ?? (v3PromptInjected ? "injected" : "not_injected"),
              message: runError,
            },
          });
          }
          else coordinationV3!.completeRun(activeRun.v3SchedulerRunId, activeRun.v3FencingToken);
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
      if (released && retainedRuntime && !isClosed() && !controller.signal.aborted &&
          !deploymentDraining() && !deletingAgentIds.has(agent.id) && store.getAgent(agent.id)?.projectId === project.id) {
        scheduleRuntimeIdleClose(agent.id, retainedRuntime);
      } else if (released && retainedRuntime && (isClosed() || deploymentDraining() || controller.signal.aborted || deletingAgentIds.has(agent.id))) {
        teardownPersistentRuntimeInBackground(agent.id, retainedRuntime, "Run authority ended during teardown");
      }
      if (released) notifyScheduler();
    }
  })();
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
