import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type {
  AgentHealthDto,
  EngineCommand,
  EngineDto,
  ConversationDetailDto,
  ConversationDto,
  MessageDto,
  ProjectEngineCapabilitiesDto,
  ResponseFileActivityDto,
  AgentDetailDto,
  AgentDto,
  AgentTelemetryStream,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import {
  agentStatusColor,
  agentStatusLabel,
  deriveAgentStatus,
  type AgentStatus,
} from "../agents";
import { uniqueBy } from "../collections";
import {
  useAgent,
  useNotifications,
  useProjects,
  useWorkspacePreferences,
} from "../hooks/queries";
import { useAgentStream } from "../hooks/useAgentStream";
import { agentIdForMentionHandle, agentMentionHandle } from "../mentions";
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
import { useMobileComposerAutoHide } from "../mobileChat";
import { queryKeys } from "../queryKeys";
import { useRuntimeControls } from "../hooks/useRuntimeControls";
import {
  agentRelationshipPresentation,
  agentTranscriptMarkdown,
  compareAgentChatMessages,
  finalizedRunDurationLabels,
  mcpPresentation,
  mergeAgentDetailProjection,
  mergeTelemetryPage,
  telemetryStreamsForTab,
  telemetryTab,
  type AgentTab,
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
import { useAgentDetailAdministration } from "./useAgentDetailAdministration";
import type { AgentDetailProps } from "./AgentDetail.types";
import { AgentDetailDialogs } from "./AgentDetail.dialogs";
import { useAgentMessageController } from "./useAgentMessageController";
import { useAgentPackageActions } from "./useAgentPackageActions";
import { useAgentRunCancellation } from "./useAgentRunCancellation";
import { useAgentProviderCommands } from "./useAgentProviderCommands";
import { AgentDetailSettingsController } from "./AgentDetailSettingsController";

export function AgentDetail({
  agentId,
  focusMessageId,
  focusTelemetry,
  technicalFocusId,
  initialView,
  createTrigger,
  onViewChange,
  onOpenTechnicalDetails,
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
  onOpenBroadcast,
  onOpenMaster,
  onOpenArtifact,
  onOpenArtifactInNewTab,
  onOpenReview,
  onOpenReviewInNewTab,
  onOpenBrowser,
  onNewSubagent,
  onDeleted,
}: AgentDetailProps): JSX.Element {
  const queryClient = useQueryClient();
  const agentQuery = useAgent(agentId, 100);
  const notificationsQuery = useNotifications();
  const [olderMessages, setOlderMessages] = useState<{
    messages: MessageDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [olderTelemetry, setOlderTelemetry] = useState<TelemetryPageState>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const focusedTelemetryRef = useRef<string>();
  const stream = useAgentStream(agentId);
  const [tab, setTab] = useState<AgentTab>(() => {
    if (initialView) return initialView;
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    return AGENT_DETAIL_TABS.some(item => item.value === saved) ||
      saved === "technical"
      ? (saved as AgentTab)
      : "chat";
  });
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [settingsEngine, setSettingsEngine] = useState("");
  const [settingsModel, setSettingsModel] = useState("");
  const [settingsEffort, setSettingsEffort] = useState("");
  const [runtimeSettingsNotice, setRuntimeSettingsNotice] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [organizationParentId, setOrganizationParentId] = useState("");
  const [membershipIds, setMembershipIds] = useState<string[]>([]);
  const [primaryConversationId, setPrimaryConversationId] = useState("");
  const [queuedMessageNotice, setQueuedMessageNotice] = useState<
    string | undefined
  >();
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{
    id: string;
    text: string;
  }>();
  const [agentWorkFocus, setAgentWorkFocus] = useState<string>();
  const [recheckEngineOpen, setRecheckEngineOpen] = useState(false);
  const focusedMessage = useRef<string>();
  const theme = useTheme();
  const mobileViewport = useMediaQuery(theme.breakpoints.down("sm"));
  const mobileComposer = useMobileComposerAutoHide(mobileViewport);
  useEffect(() => {
    mobileComposer.reset();
    if (initialView) {
      setTab(initialView);
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

  const detail = useMemo(() => {
    return mergeAgentDetailProjection(
      agentQuery.data,
      olderMessages,
      olderTelemetry,
    );
  }, [agentQuery.data, olderMessages, olderTelemetry]);
  const {
    copyAgentPackage,
    downloadAgentPackage,
    elevatedCopyPackage,
    importQuickCopy,
    quickCopyIntoProjectChat,
    setElevatedCopyPackage,
  } = useAgentPackageActions({
    agentId,
    projectId: detail?.agent.projectId,
    conversationId: detail?.agent.conversationId,
    title: detail?.agent.title,
    onNotice: setQueuedMessageNotice,
    onOpenAgent,
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
          .getAgent(agentId, 100, undefined, focusMessageId)
          .then(page => {
            setOlderMessages(current => ({
              messages: uniqueBy(
                [
                  ...page.messages,
                  ...(current?.messages ?? []),
                  ...(agentQuery.data?.messages ?? []),
                ],
                message => message.id,
                compareAgentChatMessages,
              ),
              cursor: page.history?.cursor,
              hasMore: page.history?.hasMore ?? false,
            }));
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
            100,
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
    engines.find(candidate => candidate.id === detail?.agent.activeEngine) ??
    engines[0];
  const project = projectsQuery.data?.find(
    candidate => candidate.id === detail?.agent.projectId,
  );
  const selectedRuntime = useRuntimeControls({
    engine,
    preferences: preferencesQuery.data,
    project,
    selection: { model, effort },
    onChange: next => {
      setModel(next.model);
      setEffort(next.effort);
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
  const {
    cancelQueuedMessage,
    editQueuedMessage,
    queuedMessagesQuery,
    sendMessage,
    steerQueuedMessage,
    submitAgentMessage,
  } = useAgentMessageController({
    agentId,
    projectId: detail?.agent.projectId,
    engine,
    model,
    effort,
    onNotice: setQueuedMessageNotice,
    onChatSelected: () => setTab("chat"),
  });

  const persistedModel = detail
    ? (detail.agent.model ?? inheritedRuntime.model)
    : "";
  const persistedEffort = detail
    ? (detail.agent.effort ?? inheritedRuntime.effort)
    : "";

  useEffect(() => {
    setModel(persistedModel);
    setEffort(persistedEffort);
  }, [agentId, persistedModel, persistedEffort]);

  useEffect(() => {
    if (!detail) return;
    setSettingsEngine(detail.agent.activeEngine);
    setSettingsModel(detail.agent.model ?? "");
    setSettingsEffort(detail.agent.effort ?? "");
    setRuntimeSettingsNotice(undefined);
  }, [
    agentId,
    detail?.agent.activeEngine,
    detail?.agent.effort,
    detail?.agent.model,
  ]);

  useEffect(() => {
    if (!engine) {
      setModel("");
      setEffort("");
      return;
    }
    if (engine.modelCatalogKnown === false) return;
    setModel(current =>
      modelSelectionIsCompatible(engine, current) ? current : "",
    );
    setEffort(current =>
      effortSelectionIsCompatible(engine, model, current) ? current : "",
    );
  }, [engine, model]);

  const runtimeActivity = projectedHealth?.runtimeActivity;
  const running = Boolean(runtimeActivity) || sendMessage.isPending;

  const errorHint = useMemo(
    () => stream.timeline.at(-1)?.event.type === "error",
    [stream.timeline],
  );
  const status = runtimeActivity
    ? "running"
    : errorHint
      ? "failed"
      : (projectedStatus ?? deriveAgentStatus(detail));
  const mcp = mcpPresentation(engineCapability?.mcpServers);

  const { cancelRun, stopActiveRun } = useAgentRunCancellation(
    agentId,
    runtimeActivity?.executionId,
  );
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
    updateMemberships,
    updateOrganization,
    updateRuntimeSettings,
  } = useAgentDetailAdministration({
    agentId,
    membershipIds,
    primaryConversationId,
    organizationParentId,
    settingsEngine,
    settingsModel,
    settingsEffort,
    onRenameClosed: () => setRenameOpen(false),
    onMembershipClosed: () => setMembershipOpen(false),
    onOrganizationClosed: () => setOrganizationOpen(false),
    onRuntimeSettingsNotice: setRuntimeSettingsNotice,
  });

  const loadOlderMessages = useCallback(async () => {
    const cursor = detail?.history?.cursor;
    if (!detail?.history?.hasMore || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.getAgent(agentId, 100, cursor);
      setOlderMessages(current => ({
        messages: uniqueBy(
          [
            ...page.messages,
            ...(current?.messages ?? []),
            ...(agentQuery.data?.messages ?? []),
          ],
          message => message.id,
          compareAgentChatMessages,
        ),
        cursor: page.history?.cursor,
        hasMore: page.history?.hasMore ?? false,
      }));
    } finally {
      setLoadingOlder(false);
    }
  }, [
    agentId,
    agentQuery.data?.messages,
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
  const finalizedDurationLabels = useMemo(
    () => finalizedRunDurationLabels(detail?.runs ?? []),
    [detail?.runs],
  );
  const completedWorkDurationLabel = useCallback(
    (message: MessageDto): string | undefined =>
      message.executionId
        ? finalizedDurationLabels.get(message.executionId)
        : undefined,
    [finalizedDurationLabels],
  );
  const openBroadcastFromMessage = useCallback(
    (message: MessageDto) =>
      onOpenBroadcast(message.conversationId!, message.communicationEventId!),
    [onOpenBroadcast],
  );
  const mentionCurrentAgent = useCallback(() => {
    if (!detail) return;
    setMentionInsertRequest({
      id: createClientId(),
      text: `#${agentMentionHandle(detail.agent.title)}`,
    });
  }, [detail?.agent.title]);
  const loadOlderChatMessages = useCallback(() => {
    void loadOlderMessages();
  }, [loadOlderMessages]);
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
      const pages = await Promise.all(
        streams.map(stream =>
          api.getAgentHistory(
            agentId,
            stream,
            100,
            detail.telemetryHistory?.[stream]?.cursor,
          ),
        ),
      );
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

  if (agentQuery.isError) {
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

  const models = selectedRuntime.models;
  const efforts = selectedRuntime.efforts;
  const settingsEngineRegistration = engines.find(
    candidate => candidate.id === settingsEngine,
  );
  const settingsRuntime = runtimeControlState(settingsEngineRegistration, {
    model: settingsModel,
    effort: settingsEffort,
  });
  const settingsModels = settingsRuntime.models;
  const settingsEfforts = settingsRuntime.efforts;
  const runtimeSettingsDirty =
    settingsEngine !== detail.agent.activeEngine ||
    settingsModel !== (detail.agent.model ?? "") ||
    settingsEffort !== (detail.agent.effort ?? "");
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
  const agentRuntimeControls = <AgentRuntimeControls
    engine={engine}
    engineCapability={engineCapability}
    model={model}
    models={models}
    effort={effort}
    efforts={efforts}
    selectedRuntime={selectedRuntime}
  />;

  const openTechnicalDetails = (focusId?: string) => {
    setAgentWorkFocus(focusId);
    setTab("technical");
    onOpenTechnicalDetails(focusId);
  };

  const openActivityFile = (file: ResponseFileActivityDto) => {
    if (file.artifactId) onOpenArtifact(file.artifactId);
    else onOpenReview(file.path);
  };
  const openActivityFileInNewTab = (file: ResponseFileActivityDto) => {
    if (file.artifactId) onOpenArtifactInNewTab(file.artifactId);
    else onOpenReviewInNewTab(file.path);
  };
  const settingsPane = (
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
      runtimeSettingsNotice={runtimeSettingsNotice}
      runtimeSettingsPending={updateRuntimeSettings.isPending}
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
      onNotice={setRuntimeSettingsNotice}
      onFreshSessionNotice={setQueuedMessageNotice}
      onSaveRuntimeSettings={() => updateRuntimeSettings.mutate()}
      onRecheckEngine={() => setRecheckEngineOpen(true)}
      onOpenMaster={onOpenMaster}
      onManageMemberships={() => {
        setMembershipIds(detail.agent.conversationIds);
        setPrimaryConversationId(detail.agent.conversationId ?? "");
        setMembershipOpen(true);
      }}
      onOpenAgent={onOpenAgent}
      onUpdateManagementPermissions={value =>
        updateManagementPermissions.mutate(value)
      }
      onChangeReportingLine={() => {
        setOrganizationParentId(detail.agent.managerAgentId ?? "");
        setOrganizationOpen(true);
      }}
    />
  );

  return (
    <Box
      data-testid="agent-detail"
      data-agent-id={agentId}
      sx={{
        width: "100%",
        maxWidth: "100%",
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
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
        connected={stream.connected}
        startedAt={runtimeActivity?.startedAt}
        running={running}
        stopping={cancelRun.isPending}
        tab={tab}
        transcriptMarkdown={transcriptMarkdown}
        transcriptTitle={transcriptTitle}
        onOpenProject={onOpenProject}
        onOpenChat={onOpenMaster}
        onOpenAgent={onOpenAgent}
        onStop={stopActiveRun}
        onCopyPackage={(mode, organization) =>
          void copyAgentPackage(mode, organization)
        }
        onDownloadPackage={(mode, organization) =>
          void downloadAgentPackage(mode, organization)
        }
        onOpenTechnical={() => openTechnicalDetails()}
        onRename={() => {
          setRenameValue(detail.agent.title);
          setRenameOpen(true);
        }}
        onCreateAgent={() => onNewSubagent(agentId)}
        onAssignChats={() => {
          setMembershipIds(detail.agent.conversationIds);
          setPrimaryConversationId(detail.agent.conversationId ?? "");
          setMembershipOpen(true);
        }}
        onImport={() => setImportOpen(true)}
        onQuickCopy={
          detail.agent.conversationId
            ? () => void quickCopyIntoProjectChat()
            : undefined
        }
        onChangeReportingLine={() => {
          setOrganizationParentId(detail.agent.managerAgentId ?? "");
          setOrganizationOpen(true);
        }}
        onDelete={() => setDeleteOpen(true)}
        onTabChange={value => {
          setTab(value);
          onViewChange?.(value);
        }}
      />

      <AgentDetailPanels
        tab={tab}
        detail={detail}
        agentId={agentId}
        agents={agents}
        conversations={conversations}
        engines={engines}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        notifications={notificationsQuery.data ?? []}
        operatorProfile={preferencesQuery.data?.profile}
        agentNameForId={agentNameForId}
        agentIdForHandle={agentIdForHandle}
        completedWorkDurationLabel={completedWorkDurationLabel}
        chatPreviewScope={chatPreviewScope}
        mobileScrollObserver={mobileComposer.observeScroll}
        loadingOlder={loadingOlder}
        hasOlderTelemetry={hasOlderTelemetry}
        connected={stream.connected}
        running={stream.running}
        activeExecutionId={runtimeActivity?.executionId}
        focusTelemetry={focusTelemetry}
        projectRoot={project?.hostPath}
        timeline={stream.timeline}
        delegatedAgentCount={relationships.delegatedAgentCount}
        createTrigger={createTrigger}
        agentWorkFocus={agentWorkFocus}
        settingsPane={settingsPane}
        onOpenAgent={onOpenAgent}
        onOpenBroadcast={openBroadcastFromMessage}
        onMentionAgent={() => mentionCurrentAgent()}
        onLoadOlderChat={() => void loadOlderChatMessages()}
        onLoadOlderTelemetry={() => void loadOlderTelemetry()}
        onOpenFile={openActivityFile}
        onOpenFileInNewTab={openActivityFileInNewTab}
        onOpenReview={() => onOpenReview()}
        onNewSubagent={onNewSubagent}
        onOpenTechnical={openTechnicalDetails}
        onOpenArtifact={onOpenArtifact}
        onOpenArtifactInNewTab={onOpenArtifactInNewTab}
      />

      <AgentDetailComposer
        visible={tab === "chat"}
        mobileComposer={mobileComposer}
        queuedMessageNotice={queuedMessageNotice}
        sendError={
          sendMessage.isError || cancelRun.isError
            ? `${sendMessage.isError ? "Message not sent." : "The agent could not be stopped."} ${String(
                sendMessage.error ?? cancelRun.error,
              )}`
            : undefined
        }
        providerUsageState={providerUsageState}
        agentId={agentId}
        onCloseProviderUsage={() => setProviderUsageState(undefined)}
        queuedMessages={queuedMessagesQuery.data ?? []}
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
          fixedRecipientTitle: detail.agent.title,
          commands,
          capabilities: engineIsAvailable(engine)
            ? engineCapability?.composerCapabilities
            : [],
          onCapabilitiesOpen: () =>
            onRefreshCapabilities({ engineId: engine?.id, model, agentId }),
          projectId: detail.agent.projectId,
          draftStorageKey: chatStateKey("draft", `agent.${agentId}`),
          conversationDraftId: `agent:${agentId}`,
          insertTextRequest: mentionInsertRequest,
          controls: agentRuntimeControls,
          disabled: sendMessage.isPending,
          running: false,
          guidance: runtimeActivity
            ? "Send steers the active response. Choose Queue to deliver the draft after it finishes. Use @ to reference a project file."
            : undefined,
          placeholder: runtimeActivity
            ? "Steer this agent's active response"
            : "Message this agent directly",
          agentResponding: Boolean(runtimeActivity),
          onSend: submitAgentMessage("steer"),
          onCommand: invokeAgentCommand,
          onQueue: runtimeActivity ? submitAgentMessage("queue") : undefined,
          onCancel: stopActiveRun,
        }}
      />

      <AgentDetailDialogs
        elevatedCopy={{
          open: Boolean(elevatedCopyPackage),
          onCancel: () => setElevatedCopyPackage(undefined),
          onConfirm: () => {
            if (elevatedCopyPackage)
              void importQuickCopy(elevatedCopyPackage, true);
          },
        }}
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
          onDeleted: () => {
            setDeleteOpen(false);
            onDeleted();
          },
        }}
        importAgent={{
          open: importOpen,
          projectId: detail.agent.projectId,
          engines,
          conversations,
          initialConversationId: detail.agent.conversationId,
          onClose: () => setImportOpen(false),
          onImported: onOpenAgent,
        }}
        rename={{
          renameOpen,
          setRenameOpen,
          renameValue,
          setRenameValue,
          rename,
        }}
        membership={{
          membershipOpen,
          setMembershipOpen,
          membershipIds,
          setMembershipIds,
          conversations,
          primaryConversationId,
          setPrimaryConversationId,
          updateMemberships,
        }}
        organization={{
          organizationOpen,
          setOrganizationOpen,
          organizationParentId,
          setOrganizationParentId,
          detail,
          agents,
          updateOrganization,
        }}
      />
    </Box>
  );
}
