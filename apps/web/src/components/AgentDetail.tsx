import { createClientId } from "../clientId";
import {ResourceSettingsContext} from "./ResourceSettingsContext";
import {useWorkspaceReadOnly} from "./WorkspaceReadOnlyContext";
import { chatBrowserOwnerId } from "@ponderosa/core";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
} from "@mui/material";
import type {
  EngineCommand,
  EngineDto,
  MessageDto,
  ResponseFileActivityDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  AGENT_HISTORY_PAGE_SIZE,
} from "../agentHistoryPagination";
import {
  deriveAgentStatus,
} from "../agents";
import {
  useAgent,
  useProjects,
  useWorkspacePreferences,
} from "../hooks/queries";
import { useAgentStream } from "../hooks/useAgentStream";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";
import { agentIdForMentionHandle } from "../mentions";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import {
  highlightFocusedMessage,
  projectedMessageIdForFocus,
  scrollFocusedMessageIntoView,
} from "../messageFocus";
import {
  effortSelectionIsCompatible,
  engineIsAvailable,
  modelSelectionIsCompatible,
  resolveRuntimeSelection,
  runtimeControlState,
} from "../conversationEngine";
import { telemetryElementId } from "../telemetryFocus";
import { queryKeys } from "../queryKeys";
import { loadRetainedData } from "../retainedData";
import { pendingRuntimeSelection, useRuntimeControls, useRuntimeSaving } from "../hooks/useRuntimeControls";
import {
  agentRelationshipPresentation,
  agentTranscriptMarkdown,
  mcpPresentation,
  mergeAgentDetailProjection,
  mergeMessagePage,
  mergeTelemetryPage,
  telemetryStreamsForTab,
  telemetryTab,
  type AgentTab,
  type MessagePageState,
  type TelemetryPageState,
} from "./AgentDetail.helpers";
import {
  AgentRuntimeControls,
} from "./AgentDetail.parts";
import {
  AgentDetailHeader,
  AGENT_DETAIL_TABS,
} from "./AgentDetail.header";
import { AgentDetailComposer } from "./AgentDetail.composer";
import { AgentDetailPanels } from "./AgentDetail.panels";
import { OutgoingMessageProvider } from "./chat/OutgoingMessage";
import { reconcileQueuedMessages } from "./ConversationView.helpers";
import { useAgentDetailAdministration } from "./useAgentDetailAdministration";
import type { AgentDetailProps } from "./AgentDetail.types";
import { AgentDetailDialogs } from "./AgentDetail.dialogs";
import { useAgentMessageController } from "./useAgentMessageController";
import { useAgentPackageActions } from "./useAgentPackageActions";
import { AgentDuplicateDialog, AgentPackageExportDialog } from "./AgentPackageDialogs";
import { useAgentRunCancellation } from "./useAgentRunCancellation";
import { useAgentProviderCommands } from "./useAgentProviderCommands";
import { AgentDetailSettingsController } from "./AgentDetailSettingsController";
import { useMessageDeliveryReceipts } from "./useMessageDeliveryReceipts";
import { useActiveOperationController } from "./useActiveOperationController";
import { trackAcceptedAgentMessage } from "./activeOperationTracker";
import { useReloadBlocker } from "../reloadSafety";

export function AgentDetail({
  agentId,
  projectId,
  focusMessageId,
  focusTelemetry,
  technicalFocusId,
  initialView,
  onViewChange,
  onOpenTechnicalDetails,
  decisionReviewAction,
  engines,
  modelCatalogLoading,
  engineCapabilities,
  onRefreshCapabilities,
  projectedStatus,
  projectedHealth,
  statusByAgentId,
  healthByAgentId,
  agents,
  conversations,
  onOpenProject,
  onOpenAgent,
  onOpenAgentSettings,
  onOpenCommunicationSource,
  onOpenMaster,
  onOpenArtifact,
  onOpenReview,
  onOpenBrowser,
  onNewSubagent,
  onDeleted,
  onAgentsDeleted,
}: AgentDetailProps): JSX.Element {
  const auditOnly=useWorkspaceReadOnly();
  const settingsExtension=useContext(ResourceSettingsContext);
  const queryClient = useQueryClient();
  const agentQuery = useAgent(agentId);
  const browserChatId = agentQuery.data?.agent.conversationId;
  const activeBrowsersQuery = useQuery({
    queryKey: queryKeys.agentBrowsers.agent(browserChatId ? chatBrowserOwnerId(browserChatId) : projectId, agentId),
    queryFn: () => api.listActiveBrowserSessions(projectId, browserChatId),
    enabled: Boolean(browserChatId),
    retry: false,
    refetchInterval: 15_000,
  });
  const [olderMessages, setOlderMessages] = useState<MessagePageState>();
  const [olderTelemetry, setOlderTelemetry] = useState<TelemetryPageState>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderChatError, setOlderChatError] = useState<string>();
  const [olderTelemetryError, setOlderTelemetryError] = useState<string>();
  const focusedTelemetryRef = useRef<string>();
  const stream = useAgentStream(agentId, projectId);
  const workspaceConnection = useWorkspaceConnection();
  const agentConnectionStatus = workspaceConnection.status === "live"
    ? stream.connectionStatus
    : workspaceConnection.status;
  const [tab, setTab] = useState<AgentTab>(() => {
    if (initialView) return initialView === "activity" ? "chat" : initialView;
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    return AGENT_DETAIL_TABS.some(item => item.value === saved) ||
      saved === "technical"
      ? (saved as AgentTab)
      : "chat";
  });
  const changeTab=(value:typeof tab)=>{if(onViewChange?.(value)!==false)setTab(value);};
  useEffect(() => setOlderTelemetryError(undefined), [tab]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState("");
  const [runtimeEngine, setRuntimeEngine] = useState("");
  const [submissionRuntimeIntent, setSubmissionRuntimeIntent] = useState(0);
  const runtimeSaving = useRuntimeSaving(`agent:${agentId}`);
  const hydratedRuntimeAgent = useRef<string>();
  const hydratedSettingsAgent = useRef<string>();
  const [settingsEngine, setSettingsEngine] = useState("");
  const [settingsModel, setSettingsModel] = useState("");
  const [settingsEffort, setSettingsEffort] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [organizationParentId, setOrganizationParentId] = useState("");
  const [queuedMessageNotice, setQueuedMessageNotice] = useState<
    string | undefined
  >();
  const [agentWorkFocus, setAgentWorkFocus] = useState<string>();
  const [recheckEngineOpen, setRecheckEngineOpen] = useState(false);
  const focusedMessage = useRef<string>();
  useEffect(() => {
    if (initialView) {
      setTab(initialView === "activity" ? "chat" : initialView);
      return;
    }
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    setTab(
      AGENT_DETAIL_TABS.some(item => item.value === saved) ||
        saved === "technical"
        ? (saved as AgentTab)
        : "chat",
    );
    setOlderMessages(undefined);
    setOlderTelemetry({});
    setOlderChatError(undefined);
    setOlderTelemetryError(undefined);
    setProviderUsageState(undefined);
    focusedMessage.current = undefined;
    focusedTelemetryRef.current = undefined;
  }, [agentId, initialView]);

  useEffect(() => {
    setAgentWorkFocus(technicalFocusId);
  }, [agentId, technicalFocusId]);

  useEffect(() => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), tab);
  }, [agentId, tab]);

  const retainedDetail = useMemo(() => {
    return mergeAgentDetailProjection(
      agentQuery.data,
      olderMessages,
      olderTelemetry,
    );
  }, [agentQuery.data, olderMessages, olderTelemetry]);
  const liveMessages = useMessageDeliveryReceipts(retainedDetail?.messages ?? [], retainedDetail?.agent.conversationId, tab === "chat");
  const detail = useMemo(() => retainedDetail ? { ...retainedDetail, messages: liveMessages } : undefined,
    [retainedDetail, liveMessages]);
  const runtimeSettingsDirty = Boolean(detail) && (
    settingsEngine !== detail!.agent.activeEngine ||
    settingsModel !== (detail!.agent.model ?? "") ||
    settingsEffort !== (detail!.agent.effort ?? "")
  );
  useReloadBlocker(`agent-runtime-settings:${agentId}`, runtimeSettingsDirty);
  useEffect(() => {
    if (detail?.agent.title) document.title = `${detail.agent.title} · Ponderosa`;
  }, [detail?.agent.title]);
  const showSubagents = detail?.hasSubagentHistory === true;
  useEffect(() => {
    if (tab !== "subagents" || !detail || showSubagents) return;
    setTab("chat");
    onViewChange?.("chat");
  }, [detail, onViewChange, showSubagents, tab]);
  const {
    copyAgentPackage,
    downloadAgentPackage,
  } = useAgentPackageActions({
    agentId,
    title: detail?.agent.title,
  });

  useEffect(() => {
    if (
      !focusMessageId ||
      focusedMessage.current === focusMessageId ||
      focusedMessage.current === `missing:${focusMessageId}`
    )
      return;
    if (tab !== "chat") {
      setTab("chat");
      return;
    }
    const projectedId = projectedMessageIdForFocus(
      detail?.messages ?? [],
      focusMessageId,
    );
    if (!projectedId) {
      if (focusedMessage.current !== `loading:${focusMessageId}`) {
        focusedMessage.current = `loading:${focusMessageId}`;
        void api
          .getAgent(
            agentId,
            AGENT_HISTORY_PAGE_SIZE,
            undefined,
            focusMessageId,
          )
          .then(page => {
            // A focused lookup fills a durable deep link. It must not advance the
            // ordinary history cursor past the records between recent and focused data.
            setOlderMessages(current =>
              mergeMessagePage(
                current,
                page,
                agentQuery.data?.messages ?? [],
                true,
                agentQuery.data?.history,
              ),
            );
            focusedMessage.current = page.messages.length
              ? undefined
              : `missing:${focusMessageId}`;
          })
          .catch(() => {
            focusedMessage.current = undefined;
          });
      }
      return;
    }
    const target = document.getElementById(`message-${projectedId}`);
    if (!target) return;
    scrollFocusedMessageIntoView(target);
    target.focus({ preventScroll: true });
    highlightFocusedMessage(target);
    focusedMessage.current = focusMessageId;
  }, [agentId, detail?.messages, focusMessageId, tab]);

  useEffect(() => {
    if (!focusTelemetry) return;
    const focusedId = focusTelemetry.id;
    const focusKey = `${focusTelemetry.stream}:${focusedId}`;
    if (
      focusedTelemetryRef.current === focusKey ||
      focusedTelemetryRef.current === `missing:${focusKey}`
    )
      return;
    const desiredTab = telemetryTab(focusTelemetry.stream);
    if (desiredTab === "technical") {
      setAgentWorkFocus(focusedId);
      if (tab !== "technical") setTab("technical");
      focusedTelemetryRef.current = focusKey;
      return;
    }
    if (tab !== desiredTab) {
      setTab(desiredTab);
      return;
    }
    const items =
      focusTelemetry.stream === "runOutput"
        ? detail?.runOutput
        : focusTelemetry.stream === "activity"
          ? detail?.activity
          : focusTelemetry.stream === "changedFiles"
            ? detail?.changedFiles
            : focusTelemetry.stream === "runs"
              ? detail?.runs
              : focusTelemetry.stream === "workItems"
                ? detail?.workItems
                : detail?.artifacts;
    if (
      !items?.some(item => ("id" in item ? item.id : item.path) === focusedId)
    ) {
      if (focusedTelemetryRef.current !== `loading:${focusKey}`) {
        focusedTelemetryRef.current = `loading:${focusKey}`;
        void api
          .getAgentHistory(
            agentId,
            focusTelemetry.stream,
            AGENT_HISTORY_PAGE_SIZE,
            undefined,
            focusTelemetry.id,
          )
          .then(page => {
            // A focused lookup fills a durable deep link. It must not advance the
            // ordinary history cursor past the records between recent and focused data.
            setOlderTelemetry(current =>
              mergeTelemetryPage(current, page, true),
            );
            focusedTelemetryRef.current = page.items.length
              ? undefined
              : `missing:${focusKey}`;
          })
          .catch(() => {
            focusedTelemetryRef.current = undefined;
          });
      }
      return;
    }
    const target = document.getElementById(
      telemetryElementId(focusTelemetry.stream, focusedId),
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "auto", block: "center" });
    target.focus({ preventScroll: true });
    focusedTelemetryRef.current = focusKey;
  }, [
    agentId,
    detail?.activity,
    detail?.artifacts,
    detail?.changedFiles,
    detail?.runOutput,
    detail?.runs,
    detail?.workItems,
    focusTelemetry,
    tab,
  ]);
  const preferencesQuery = useWorkspacePreferences();
  const projectsQuery = useProjects();
  const engine =
    engines.find(candidate =>
      candidate.id === (runtimeEngine || detail?.agent.activeEngine)
    ) ??
    engines[0];
  const project = projectsQuery.data?.find(
    candidate => candidate.id === detail?.agent.projectId,
  );
  const selectedRuntime = useRuntimeControls({
    engine,
    preferences: preferencesQuery.data,
    project,
    selection: { model, effort, speed },
    onChange: next => {
      setModel(next.model);
      setEffort(next.effort);
      setSpeed(next.speed ?? "");
    },
  });
  const inheritedRuntime = resolveRuntimeSelection(
    engine,
    preferencesQuery.data,
    project,
  );
  const engineCapability = engineCapabilities.find(
    item => item.engineId === engine?.id,
  );
  const commands: EngineCommand[] = engineCapability?.commands ?? [];
  const {
    invokeAgentCommand,
    providerUsageState,
    setProviderUsageState,
  } = useAgentProviderCommands({
    agentId,
    engine,
    onNotice: setQueuedMessageNotice,
  });
  const { setActiveOperation } = useActiveOperationController({
    activeScopeId: detail?.agent.conversationId,
    healthProjectId: detail?.agent.projectId,
    healthByAgentId,
    receiptSources: detail?.messages ?? [],
    agentTitle: candidateAgentId =>
      agents.find(candidate => candidate.id === candidateAgentId)?.title ??
      detail?.agent.title ?? "Agent",
    invalidate: () => {
      if (!detail?.agent.projectId) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.health(detail.agent.projectId),
      });
    },
  });
  const {
    cancelQueuedMessage,
    editQueuedMessage,
    queuedMessageFailure,
    queuedMessagesQuery,
    steerQueuedMessage,
    submitAgentMessage,
  } = useAgentMessageController({
    agentId,
    projectId: detail?.agent.projectId,
    engine,
    model,
    effort,
    speed,
    onNotice: setQueuedMessageNotice,
    onChatSelected: () => setTab("chat"),
    onAccepted: response => setActiveOperation(trackAcceptedAgentMessage(
      agentId, response, healthByAgentId, Date.now(), detail?.agent.conversationId,
    )),
  });
  const visibleQueuedMessages = useMemo(() => reconcileQueuedMessages(
    detail?.messages ?? [], queuedMessagesQuery.data ?? [],
  ), [detail?.messages, queuedMessagesQuery.data]);
  const visibleChatMessages = useMemo(() => {
    const queuedCommunicationIds = new Set(
      visibleQueuedMessages.map(message => message.messageId),
    );
    return (detail?.messages ?? []).filter(
      message =>
        !queuedCommunicationIds.has(message.id) &&
        !(
          message.communicationEventId &&
          queuedCommunicationIds.has(message.communicationEventId)
        ),
    );
  }, [detail?.messages, visibleQueuedMessages]);

  const persistedModel = detail
    ? (detail.agent.model ?? inheritedRuntime.model)
    : "";
  useEffect(() => {
    if (!detail || !preferencesQuery.data || !projectsQuery.data) return;
    if (runtimeSaving && hydratedRuntimeAgent.current === agentId) return;
    const selection = { engine: detail.agent.activeEngine, model: detail.agent.model, effort: detail.agent.effort, speed: detail.agent.speed, ...pendingRuntimeSelection(queryClient, `agent:${agentId}`) };
    const canonicalEngine = engines.find(item => item.id === selection.engine);
    if (!canonicalEngine) return;
    const resolved = resolveRuntimeSelection(canonicalEngine, preferencesQuery.data, project, {
      model: selection.model ?? undefined,
      effort: selection.effort ?? undefined,
      speed: selection.speed ?? undefined,
    });
    hydratedRuntimeAgent.current = agentId;
    setRuntimeEngine(selection.engine);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed ?? "");
  }, [agentId, detail?.agent.activeEngine, detail?.agent.model, detail?.agent.effort, detail?.agent.speed, engines, preferencesQuery.data, project, projectsQuery.data, runtimeSaving]);

  useEffect(() => {
    if (!detail || (runtimeSaving && hydratedSettingsAgent.current === agentId)) return;
    hydratedSettingsAgent.current = agentId;
    const selection = { engine: detail.agent.activeEngine, model: detail.agent.model, effort: detail.agent.effort, ...pendingRuntimeSelection(queryClient, `agent:${agentId}`) };
    setSettingsEngine(selection.engine);
    setSettingsModel(selection.model ?? "");
    setSettingsEffort(selection.effort ?? "");
  }, [
    agentId,
    detail?.agent.activeEngine,
    detail?.agent.effort,
    detail?.agent.model,
    detail?.agent.speed,
    runtimeSaving,
  ]);

  useEffect(() => {
    if (!engine) {
      setModel("");
      setEffort("");
      return;
    }
    // Validate the hydrated pair, not the preceding render's model.
    if (!model || model !== persistedModel || engine.modelCatalogKnown === false) return;
    setModel(current =>
      modelSelectionIsCompatible(engine, current) ? current : "",
    );
    setEffort(current =>
      effortSelectionIsCompatible(engine, model, current) ? current : "",
    );
    setSpeed(current =>
      runtimeControlState(engine, { model, effort, speed: current }).speed,
    );
  }, [engine, effort, model, persistedModel]);

  const runtimeActivity = projectedHealth?.runtimeActivity;
  const running = Boolean(runtimeActivity);

  const status = projectedHealth?.status ?? projectedStatus ?? deriveAgentStatus(detail);
  const mcp = mcpPresentation(engineCapability?.mcpServers);

  const { cancelRun, stopActiveRun } = useAgentRunCancellation(
    agentId,
    runtimeActivity?.executionId ?? detail?.coordinationV3?.pause?.runId,
  );
  const pause=detail?.coordinationV3?.pause;
  const pauseResume=useMutation({
    mutationFn:()=>api.controlRun(agentId,pause?'resume':'pause',pause?{pauseId:pause.id,idempotencyKey:createClientId()}:{targetRunId:runtimeActivity?.executionId,idempotencyKey:createClientId()}),
    onSettled:()=>{void queryClient.invalidateQueries({queryKey:queryKeys.agents.detailPrefix(agentId)});void queryClient.invalidateQueries({queryKey:queryKeys.agents.healthAll});},
  });
  const recheckEngine = useMutation({
    mutationFn: (engineId: string) => api.recheckEngine(engineId),
    onSuccess: updated => {
      queryClient.setQueryData<EngineDto[]>(queryKeys.engines.all, current =>
        current?.map(candidate =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.engines.all });
    },
  });
  const {
    rename,
    updateManagementPermissions,
    updateOrganization,
    updateRuntimeSettings,
  } = useAgentDetailAdministration({
    agentId,
    organizationParentId,
    settingsEngine,
    settingsModel,
    settingsEffort,
    onRenameClosed: () => setRenameOpen(false),
    onOrganizationClosed: () => setOrganizationOpen(false),
  });

  const loadOlderCombinedTimeline = useCallback(async () => {
    const messageCursor = detail?.history?.cursor;
    const loadMessages = Boolean(
      detail?.history?.hasMore && messageCursor,
    );
    const telemetryStreams = (
      ["runOutput", "activity", "runs"] as const
    ).filter(stream => detail?.telemetryHistory?.[stream]?.hasMore);
    if ((!loadMessages && telemetryStreams.length === 0) || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    try {
      const loaded = await loadRetainedData(
        () => Promise.all([
          loadMessages
            ? api.getAgent(agentId, AGENT_HISTORY_PAGE_SIZE, messageCursor)
            : Promise.resolve(undefined),
          Promise.all(
            telemetryStreams.map(stream =>
              api.getAgentHistory(
                agentId,
                stream,
                AGENT_HISTORY_PAGE_SIZE,
                detail?.telemetryHistory?.[stream]?.cursor,
              ),
            ),
          ),
        ]),
        setOlderChatError,
        "Older Agent history could not be loaded.",
      );
      if (!loaded) return;
      const [messagePage, telemetryPages] = loaded;
      if (messagePage) {
        setOlderMessages(current =>
          mergeMessagePage(
            current,
            messagePage,
            agentQuery.data?.messages ?? [],
          ),
        );
      }
      if (telemetryPages.length) {
        setOlderTelemetry(current =>
          telemetryPages.reduce(
            (state, page) => mergeTelemetryPage(state, page),
            current,
          ),
        );
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [
    agentId,
    agentQuery.data?.messages,
    detail?.telemetryHistory,
    detail?.history?.cursor,
    detail?.history?.hasMore,
    loadingOlder,
  ]);

  const agentIdForHandle = useCallback(
    (handle: string): string | undefined =>
      agentIdForMentionHandle(agents, handle),
    [agents],
  );
  const agentNameForId = useCallback(
    (candidateId: string): string | undefined =>
      agents.find(candidate => candidate.id === candidateId)?.title,
    [agents],
  );
  const openCommunicationSourceFromMessage = useCallback(
    (message: MessageDto) =>
      onOpenCommunicationSource(
        message.conversationId!,
        message.communicationEventId!,
        message.communicationIntent === "collaboration"
          ? "collaboration"
          : "main",
      ),
    [onOpenCommunicationSource],
  );
  const chatPreviewScope = useMemo(
    () =>
      detail && projectedHealth?.runtimeActivity?.executionId
        ? {
            projectId: detail.agent.projectId,
            agentId: detail.agent.id,
            runId: projectedHealth.runtimeActivity.executionId,
          }
        : undefined,
    [
      detail?.agent.id,
      detail?.agent.projectId,
      projectedHealth?.runtimeActivity?.executionId,
    ],
  );
  const transcript = useMemo(
    () => agentTranscriptMarkdown(detail, agentNameForId),
    [agentNameForId, detail?.agent.title, detail?.messages],
  );

  const loadOlderTelemetry = async () => {
    const streams = telemetryStreamsForTab(tab).filter(
      stream => detail?.telemetryHistory?.[stream]?.hasMore,
    );
    if (!detail || streams.length === 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const pages = await loadRetainedData(
        () => Promise.all(streams.map(stream =>
          api.getAgentHistory(
            agentId,
            stream,
            AGENT_HISTORY_PAGE_SIZE,
            detail.telemetryHistory?.[stream]?.cursor,
          ),
        )),
        setOlderTelemetryError,
        "Earlier Agent records could not be loaded.",
      );
      if (!pages) return;
      setOlderTelemetry(current =>
        pages.reduce((state, page) => mergeTelemetryPage(state, page), current),
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  if (agentQuery.isLoading) {
    return (
      <Box sx={{ p: 3 }} role="status" aria-live="polite">
        <CircularProgress size={24} aria-label="Loading agent" />
      </Box>
    );
  }

  if (agentQuery.isError && !agentQuery.data) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => void agentQuery.refetch()}
            >
              Retry
            </Button>
          }
        >
          This agent could not be loaded. Check the server connection and try
          again.
        </Alert>
      </Box>
    );
  }

  if (!detail) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Agent not found.</Alert>
      </Box>
    );
  }

  const activeTelemetryStreams = telemetryStreamsForTab(tab);
  const hasOlderTelemetry = activeTelemetryStreams.some(
    stream => detail.telemetryHistory?.[stream]?.hasMore,
  );
  const detailRefreshFailed = agentQuery.isError && agentQuery.data !== undefined;

  const models = selectedRuntime.models;
  const efforts = selectedRuntime.efforts;
  const speeds = selectedRuntime.speeds;
  const settingsEngineRegistration = engines.find(
    candidate => candidate.id === settingsEngine,
  );
  const settingsRuntime = runtimeControlState(settingsEngineRegistration, {
    model: settingsModel,
    effort: settingsEffort,
  });
  const settingsModels = settingsRuntime.models;
  const settingsEfforts = settingsRuntime.efforts;
  const relationships = agentRelationshipPresentation(
    detail.agent,
    agents,
    conversations,
  );
  const master = relationships.master;
  const headerChats = relationships.headerChats;
  const transcriptTitle = `${detail.agent.title} — Agent chat`;
  const transcriptMarkdown = transcript;
  const organizationalParent = relationships.organizationalParent;
  const lineageAgent = relationships.lineageAgent;
  const lineageAgentId = relationships.lineageAgentId;
  const lineageLabel = relationships.lineageLabel;
  const resetOrChangeEngine = (next: string) => {
    const nextEngine = engines.find(candidate => candidate.id === next);
    if (!nextEngine || !detail) return;
    setSubmissionRuntimeIntent(value => value + 1);
    const resolved = resolveRuntimeSelection(
      nextEngine,
      preferencesQuery.data,
      project,
    );
    if (next === engine?.id && resolved.model === model && resolved.effort === effort && (resolved.speed ?? "") === (speed ?? "")) return;
    setRuntimeEngine(next);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed ?? "");
    setSettingsEngine(next);
    setSettingsModel(resolved.model);
    setSettingsEffort(resolved.effort);
    updateRuntimeSettings.mutate(
      {
        activeEngine: next,
        model: resolved.model || null,
        effort: resolved.effort || null,
        speed: resolved.speed || null,
      },
    );
  };
  const agentRuntimeControls = <AgentRuntimeControls
    engine={engine}
    engines={engines}
    model={model}
    models={models}
    effort={effort}
    efforts={efforts}
    speed={selectedRuntime.speed}
    speeds={speeds}
    selectedRuntime={selectedRuntime}
    scopeLabel={`${detail.agent.title} Next Run`}
    selectionKey={agentId}
    loading={modelCatalogLoading}
    onEngineChange={resetOrChangeEngine}
    onReset={() => { if (engine?.id) resetOrChangeEngine(engine?.id); }}
    onModelChange={next => {
      if (!engine || !detail) return;
      setSubmissionRuntimeIntent(value => value + 1);
      const resolved = selectedRuntime.selectModel(next);
      setSettingsEngine(engine.id);
      setSettingsModel(resolved.model);
      setSettingsEffort(resolved.effort);
      updateRuntimeSettings.mutate(
        {
          activeEngine: engine.id,
          model: resolved.model || null,
          effort: resolved.effort || null,
          speed: resolved.speed || null,
        },
      );
    }}
    onEffortChange={next => {
      if (!engine || !detail) return;
      setSubmissionRuntimeIntent(value => value + 1);
      const resolved = selectedRuntime.selectEffort(next);
      setSettingsEngine(engine.id);
      setSettingsModel(resolved.model);
      setSettingsEffort(resolved.effort);
      updateRuntimeSettings.mutate(
        {
          activeEngine: engine.id,
          model: resolved.model || null,
          effort: resolved.effort || null,
          speed: resolved.speed || null,
        },
      );
    }}
    onSpeedChange={next => {
      if (!engine || !detail) return;
      setSubmissionRuntimeIntent(value => value + 1);
      const resolved = selectedRuntime.selectSpeed(next);
      updateRuntimeSettings.mutate({
        activeEngine: engine.id,
        model: resolved.model || null,
        effort: resolved.effort || null,
        speed: resolved.speed || null,
      });
    }}
  />;

  const openTechnicalDetails = (focusId?: string) => {
    if(onOpenTechnicalDetails(focusId)===false)return;
    setAgentWorkFocus(focusId);
    setTab("technical");
  };

  const openActivityFile = (file: ResponseFileActivityDto) => {
    if (file.executionId) onOpenReview(file.path, file.executionId);
    else if (file.artifactId) onOpenArtifact(file.artifactId);
    else onOpenReview(file.path, file.executionId);
  };
  const activeBrowser = activeBrowsersQuery.data?.find(session => session.agentId === agentId);
  const settingsPane = (<>
    <AgentDetailSettingsController
      agent={detail.agent}
      engines={engines}
      modelCatalogLoading={modelCatalogLoading}
      settingsEngine={settingsEngine}
      settingsModel={settingsModel}
      settingsEffort={settingsEffort}
      settingsEngineRegistration={settingsEngineRegistration}
      settingsModels={settingsModels}
      settingsEfforts={settingsEfforts}
      runtimeSettingsDirty={runtimeSettingsDirty}
      runtimeSettingsPending={runtimeSaving}
      runtimeSettingsError={updateRuntimeSettings.error}
      recheckPending={recheckEngine.isPending}
      master={master}
      organizationalParent={organizationalParent}
      managementPermissionsPending={updateManagementPermissions.isPending}
      managementPermissionsError={updateManagementPermissions.error}
      mcpSummary={mcp.summary}
      configuredMcpCount={mcp.configuredCount}
      usableMcpCount={mcp.usableCount}
      mcpToolCountLabel={mcp.toolCountLabel}
      steering={engineCapability?.steering}
      onSettingsEngine={setSettingsEngine}
      onSettingsModel={setSettingsModel}
      onSettingsEffort={setSettingsEffort}
      onSaveRuntimeSettings={() => updateRuntimeSettings.mutate(undefined)}
      onRecheckEngine={() => setRecheckEngineOpen(true)}
      onOpenMaster={onOpenMaster}
      onOpenAgent={onOpenAgent}
      onUpdateManagementPermissions={value =>
        updateManagementPermissions.mutate(value)
      }
      onChangeReportingLine={() => {
        setOrganizationParentId(detail.agent.managerAgentId ?? "");
        setOrganizationOpen(true);
      }}
    />
    {!auditOnly&&settingsExtension.render?.("agent",detail.agent.id)}
  </>);

  return (
    <OutgoingMessageProvider scope={agentId} profile={preferencesQuery.data?.profile}><Box
      sx={{
        width: "100%",
        maxWidth: "100%",
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateRows: activeBrowser || detailRefreshFailed
          ? "auto auto minmax(0, 1fr) auto"
          : "auto minmax(0, 1fr) auto",
      }}
    >
      <AgentDetailHeader
        agent={detail.agent}
        projectLabel={project?.label}
        chats={headerChats}
        lineageAgent={lineageAgent}
        lineageAgentId={lineageAgentId}
        lineageLabel={lineageLabel}
        status={status}
        health={projectedHealth}
        connectionStatus={agentConnectionStatus}
        phaseEvidenceFresh={workspaceConnection.phaseEvidenceFresh}
        startedAt={status === "running" ? runtimeActivity?.startedAt : undefined}
        agentNameForId={agentNameForId}
        running={running||Boolean(pause)}
        stopping={cancelRun.isPending}
        tab={auditOnly&&['subagents','settings'].includes(tab)?'chat':tab}
        showSubagents={showSubagents}
        transcriptMarkdown={transcriptMarkdown}
        transcriptTitle={transcriptTitle}
        onOpenProject={onOpenProject}
        onOpenChat={onOpenMaster}
        onOpenAgent={onOpenAgent}
        onStop={stopActiveRun}
        paused={Boolean(pause)}
        pausePending={pauseResume.isPending||pause?.state==='resume_requested'}
        onPauseResume={()=>pauseResume.mutate()}

        onExportPackage={() => setExportOpen(true)}
        onDuplicate={conversations.length ? () => setDuplicateOpen(true) : undefined}
        onOpenTechnical={() => openTechnicalDetails()}
        onRename={() => {
          setRenameValue(detail.agent.title);
          setRenameOpen(true);
        }}
        onCreateAgent={() => onNewSubagent(agentId)}
        onChangeReportingLine={() => {
          setOrganizationParentId(detail.agent.managerAgentId ?? "");
          setOrganizationOpen(true);
        }}
        onDelete={() => setDeleteOpen(true)}
        onTabChange={changeTab}
      />

      {activeBrowser || detailRefreshFailed ? (
        <Stack spacing={1} sx={{ mx: { xs: 1, sm: 2 }, mt: 1 }}>
          {detailRefreshFailed ? (
            <Alert
              severity="warning"
              action={<Button color="inherit" size="small" onClick={() => void agentQuery.refetch()}>Retry</Button>}
            >
              This Agent could not be refreshed. The last loaded details remain available.
            </Alert>
          ) : null}
          {activeBrowser ? (
            <Alert
              severity="info"
              role="region"
              aria-label="Agent browser status"
              action={
                <Button color="inherit" size="small" onClick={() => onOpenBrowser(activeBrowser.runId)}>
                  View Browser
                </Button>
              }
            >
              {activeBrowser.status === "opening"
                ? activeBrowser.queuePosition
                  ? `Browser queued · position ${activeBrowser.queuePosition}`
                  : "Browser is opening"
                : `Browser active${activeBrowser.title ? ` · ${activeBrowser.title}` : ""}`}
              {activeBrowser.profileMode === "trusted" && activeBrowser.profileName
                ? ` · Trusted profile: ${activeBrowser.profileName}`
                : " · Disposable profile"}
              {activeBrowser.controlOwner === "operator" ? " · Operator has control" : ""}
            </Alert>
          ) : null}
        </Stack>
      ) : null}

      <AgentDetailPanels
        tab={auditOnly&&['subagents','settings'].includes(tab)?'chat':tab}
        detail={detail}
        chatMessages={visibleChatMessages}
        agentId={agentId}
        agents={agents}
        conversations={conversations}
        engines={engines}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        decisionReviewAction={decisionReviewAction}
        operatorProfile={preferencesQuery.data?.profile}
        agentNameForId={agentNameForId}
        agentIdForHandle={agentIdForHandle}
        chatPreviewScope={chatPreviewScope}
        loadingOlder={loadingOlder}
        olderChatError={olderChatError}
        olderTelemetryError={olderTelemetryError}
        hasOlderTelemetry={hasOlderTelemetry}
        activeExecutionId={runtimeActivity?.executionId}
        focusTelemetry={focusTelemetry}
        projectRoot={project?.hostPath}
        delegatedAgentCount={relationships.delegatedAgentCount}
        onCloseTechnical={() => changeTab("chat")}
        agentWorkFocus={agentWorkFocus}
        settingsPane={settingsPane}
        onOpenAgent={onOpenAgent}
        onOpenAgentSettings={onOpenAgentSettings}
        onOpenMessageSource={openCommunicationSourceFromMessage}
        onLoadOlderChat={() => void loadOlderCombinedTimeline()}
        onLoadOlderTelemetry={() => void loadOlderTelemetry()}
        onOpenFile={openActivityFile}
        onNewSubagent={onNewSubagent}
        onAgentsDeleted={onAgentsDeleted}
        onOpenArtifact={onOpenArtifact}
      />

      {auditOnly?<Alert severity="info" sx={{m:1}}>This Agent belongs to a workflow execution. Control its work from the execution view.</Alert>:<AgentDetailComposer
        visible={tab === "chat"}
        queuedMessageNotice={queuedMessageNotice}
        queuedMessageFailure={queuedMessageFailure}
        cancellationError={[
          pause?.error,
          pauseResume.isError
            ? `Pause or Resume failed. ${pauseResume.error instanceof Error ? pauseResume.error.message : String(pauseResume.error)}`
            : undefined,
          cancelRun.isError
            ? `Stop failed. ${cancelRun.error instanceof Error ? cancelRun.error.message : String(cancelRun.error)}`
            : undefined,
        ].filter(Boolean).join("\n") || undefined}
        providerUsageState={providerUsageState}
        agentId={agentId}
        onCloseProviderUsage={() => setProviderUsageState(undefined)}
        queuedMessages={visibleQueuedMessages}
        attachmentNamesForQueuedMessage={queued => detail.messages.find(message => message.id === queued.messageId || message.communicationEventId === queued.messageId)?.attachments?.map(attachment => attachment.name)}
        queuedBusy={
          cancelQueuedMessage.isPending ||
          editQueuedMessage.isPending ||
          steerQueuedMessage.isPending
        }
        onSteerQueued={message =>
          steerQueuedMessage.mutateAsync(message.deliveryId)
        }
        onEditQueued={(message, text) =>
          editQueuedMessage.mutateAsync({
            deliveryId: message.deliveryId,
            text,
          })
        }
        onDeleteQueued={message =>
          cancelQueuedMessage.mutateAsync(message.deliveryId)
        }
        composer={{
          destinationMode: "fixed",
          defaultDestination: {
            handle: detail.agent.handle,
            binding: {
              projectId: detail.agent.projectId,
              handle: detail.agent.handle,
              agentId: detail.agent.id,
              currentHandle: detail.agent.handle,
              currentTitle: detail.agent.title,
            },
            selectionKey: `agent:${detail.agent.id}:${detail.agent.title}`,
          },
          commands,
          capabilities: engineIsAvailable(engine)
            ? engineCapability?.composerCapabilities
            : [],
          enableVoiceDictation: true,
          voiceContext: tab === "chat" && detail.agent.conversationId ? {
            projectId: detail.agent.projectId,
            conversationId: detail.agent.conversationId,
            agents: [detail.agent],
            selectedAgentId: detail.agent.id,
            lockAgent: true,
          } : undefined,
          onCapabilitiesOpen: () =>
            onRefreshCapabilities({ engineId: engine?.id, model, agentId }),
          projectId: detail.agent.projectId,
          draftStorageKey: chatStateKey("draft", `agent.${agentId}`),
          conversationDraftId: `agent:${agentId}`,
          submissionRuntimeKey: JSON.stringify([
            engine?.id ?? "",
            model,
            effort,
            speed,
          ]),
          submissionRuntimeIntentKey: String(submissionRuntimeIntent),
          controls: agentRuntimeControls,
          disabled: false,
          submissionDisabled: runtimeSaving,
          running: false,
          placeholder: runtimeActivity
            ? `Steer ${detail.agent.title}'s active response · Queue sends next`
            : `Message ${detail.agent.title} directly`,
          agentResponding: Boolean(runtimeActivity),
          onSend: submitAgentMessage("steer"),
          onCommand: invokeAgentCommand,
          onQueue: submitAgentMessage("queue"),
          onCancel: stopActiveRun,
        }}
      />}

      {!auditOnly&&<AgentDetailDialogs
        recheckEngine={{
          open: recheckEngineOpen,
          pending: recheckEngine.isPending,
          error: recheckEngine.isError
            ? String(recheckEngine.error)
            : undefined,
          onCancel: () => {
            recheckEngine.reset();
            setRecheckEngineOpen(false);
          },
          onConfirm: () => {
            if (!settingsEngineRegistration) return;
            recheckEngine.mutate(settingsEngineRegistration.id, {
              onSuccess: () => setRecheckEngineOpen(false),
            });
          },
        }}
        deletion={{
          open: deleteOpen,
          projectId: detail.agent.projectId,
          rootAgentIds: [detail.agent.id],
          onClose: () => setDeleteOpen(false),
          onDeleted: (deletedAgentIds) => {
            setDeleteOpen(false);
            onDeleted(deletedAgentIds);
          },
        }}
        rename={{
          renameOpen,
          setRenameOpen,
          renameValue,
          setRenameValue,
          rename,
        }}
        organization={{
          open: organizationOpen,
          onClose: () => setOrganizationOpen(false),
          organizationParentId,
          setOrganizationParentId,
          agent: detail.agent,
          agents,
          updateOrganization,
        }}
      />}
      {!auditOnly&&<AgentPackageExportDialog
        open={exportOpen}
        source={detail.agent}
        agents={agents}
        onClose={() => setExportOpen(false)}
        onCopy={copyAgentPackage}
        onDownload={downloadAgentPackage}
      />}
      {!auditOnly&&<AgentDuplicateDialog
        open={duplicateOpen}
        source={detail.agent}
        agents={agents}
        conversations={conversations}
        onClose={() => setDuplicateOpen(false)}
        onCreated={onOpenAgent}
      />}
    </Box></OutgoingMessageProvider>
  );
}
