import {useWorkspaceReadOnly} from "./WorkspaceReadOnlyContext";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import type {
  AgentHealthDto,
  EngineDto,
  ConversationDto,
  ProjectDto,
  ProjectEngineCapabilitiesDto,
  ResponseFileActivityDto,
  AgentDto,
  ConversationMessageDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeResetPages } from "../collections";
import { providerAvailabilityMessage } from "../providerAvailability";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type { AgentStatus } from "../agents";
import {
  useAgents,
  useNotifications,
  useProjects,
  useWorkspacePreferences,
} from "../hooks/queries";
import {
  engineIsAvailable,
  engineUnavailableReason,
  resolveConversationEngine,
  resolveRuntimeSelection,
} from "../conversationEngine";
import {
  agentIdForMentionHandle,
} from "../mentions";
import { Composer } from "./chat/Composer";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { ChatSurface } from "./chat/ChatSurface";
import { OutgoingMessageProvider } from "./chat/OutgoingMessage";
import { buildMarkdownTranscript } from "../chatTranscript";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { TargetedNextRunReceipts } from "./TargetedNextRunReceipts";
import { queryKeys } from "../queryKeys";
import { AgentsTab } from "./AgentsTab";
import type { ConversationDetailView } from "../routing";
import {
  conversationComposerRuntime,
  reconcileQueuedProjectMessages,
} from "./ConversationView.helpers";
import {
  CollaborationTimeline,
  ConversationHeader,
  MainConversationTimeline,
} from "./ConversationView.parts";
import { ConversationDialogs } from "./ConversationView.dialogs";
import {
  useConversationActiveViewPersistence,
  useConversationActiveViewState,
  useConversationResetEffect,
} from "./useConversationActiveView";
import {
  useConversationMessageFocusCleanup,
  useConversationMessageFocusEffect,
  useConversationMessageFocusRefs,
} from "./useConversationMessageFocus";
import { useConversationNotificationVisibility } from "./useConversationNotificationVisibility";
import { useConversationHistory } from "./useConversationHistory";
import { useConversationMessagingController } from "./useConversationMessagingController";
import { ProviderFailureBanner } from "./ProviderFailureBanner";
import { useMutationNotification } from "./MutationNotifications";
import { MasterRespondingIndicator } from "./ConversationComposerStatus";
import {
  resolveMessageMentionText,
} from "./chat/ChatMessages";
import { ConversationFilesResults } from "./ConversationFilesResults";
import { ChatComposerDock } from "./chat/ChatComposerDock";
import { CollectionStateFeedback } from "./CollectionPrimitives";
import type { WorkspaceDirectoryRequestState } from "../hooks/useWorkspaceDirectory";
import { ChatContextSettings } from "./ChatContextSettings";

import { chatStateKey } from "../chatState";
import { publishUpdatedAgent, refreshAgentRuntime } from "../conversationAgentCache";
import { pendingRuntimeSelection, runtimeMutationOptions, useRuntimeControls, useRuntimeSaving } from "../hooks/useRuntimeControls";

export function ConversationView({
  conversationId,
  focusMessageId,
  initialView,
  onViewChange,
  engines,
  engineCapabilities,
  onRefreshCapabilities,
  statusByAgentId,
  healthByAgentId,
  projectAgents,
  onOpenProject,
  onOpenProjectBrowser,
  onOpenAgent,
  onAgentsDeleted,
  onOpenReview,
  onOpenBrowser,
  onOpenFileActivity,
  onNewAgent,
  onDeleted,
}: {
  conversationId: string;
  focusMessageId?: string;
  initialView?: ConversationDetailView;
  onViewChange?(view: ConversationDetailView): void;
  engines: EngineDto[];
  engineCapabilities: ProjectEngineCapabilitiesDto[];
  onRefreshCapabilities(context?: {
    engineId?: string;
    model?: string;
    agentId?: string;
  }): Promise<unknown> | unknown;
  statusByAgentId: Map<string, AgentStatus>;
  healthByAgentId: Map<string, AgentHealthDto>;
  projectAgents: AgentDto[];
  onOpenProject(): void;
  onOpenProjectBrowser(): void;
  onOpenAgent(
    agentId: string,
    view?: "technical" | "settings",
    technicalFocusId?: string,
  ): void;
  onAgentsDeleted(agentIds: string[]): void;
  onOpenReview?(agentId: string, executionId?: string): void;
  onOpenBrowser(agentId: string, runId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onNewAgent(master: ConversationDto, managerAgentId?: string): void;
  preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onDeleted(): void;
}): JSX.Element {
  const auditOnly=useWorkspaceReadOnly();
  const queryClient = useQueryClient();
  const notify = useMutationNotification();
  const [storedView, setActiveView] = useConversationActiveViewState(
    conversationId,
    initialView,
  );
  const activeView=auditOnly&&storedView==='agents'?'main':storedView;
  const {
    agents,
    collaborationHistory,
    collaborationLayoutKey,
    collaborationMessages,
    collaborationQuery,
    detailQuery,
    loadOlderHistory,
    loadingOlder,
    mainHistory,
    mainTimeline,
    messages,
    olderError,
    operationalEvents,
    operationalLayoutKey,
    setOlderCollaboration,
    setOlderMain,
  } = useConversationHistory(conversationId, activeView);
  const notificationsQuery = useNotifications();
  const markCommunicationVisible = useConversationNotificationVisibility(
    queryClient,
  );
  const preferencesQuery = useWorkspacePreferences();
  const projectsQuery = useProjects();
  const [renameOpen, setRenameOpen] = useState(false);
  const [contextSettingsOpen, setContextSettingsOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addAgentsOpen, setAddAgentsOpen] = useState(false);
  const [agentWorkOpen, setAgentWorkOpen] = useState(false);
  const collaborationVisited = useRef(activeView === "collaboration");
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{
    id: string;
    text: string;
  }>();
  const [commandTargetHandle, setCommandTargetHandle] = useState<string>();
  const [commandTargetAgentId, setCommandTargetAgentId] = useState<string>();
  const [memberSearch, setMemberSearch] = useState("");
  // The runtime shown by the composer. With one exact Agent destination this
  // mirrors that Agent's durable next-Run selection; otherwise it is the
  // Chat default used for newly spawned Agents.
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState("");
  const [submissionRuntimeIntent, setSubmissionRuntimeIntent] = useState(0);
  const { focusedMessage, focusedMessageHighlightDisposer } =
    useConversationMessageFocusRefs();
  useConversationResetEffect({
    collaborationVisited,
    conversationId,
    focusedMessage,
    setOlderCollaboration,
    setOlderMain,
  });
  useConversationMessageFocusCleanup(focusedMessageHighlightDisposer);

  if (activeView === "collaboration") collaborationVisited.current = true;

  useConversationActiveViewPersistence(activeView, conversationId);

  const conversation = detailQuery.data?.conversation;
  useEffect(() => {
    if (conversation?.title) document.title = `${conversation.title} · Ponderosa`;
  }, [conversation?.title]);
  const projectAgentsQuery = useAgents(conversation?.projectId);
  const routingAgents = projectAgentsQuery.data ?? agents;
  // Identity fallback is presentation only: keep routing eligibility governed
  // by the existing authoritative roster, including deletion/archive changes.
  const identityAgents = useMemo(() => [...new Map([
    ...agents,
    ...(projectAgentsQuery.data ?? []),
  ].map(agent => [agent.id, agent])).values()], [agents, projectAgentsQuery.data]);
  const activeBrowsers = useQuery({
    queryKey: queryKeys.agentBrowsers.conversation(conversation?.projectId, conversationId),
    queryFn: () => api.listActiveBrowserSessions(conversation!.projectId, conversationId),
    enabled: Boolean(conversation?.projectId),
    retry: false,
    refetchInterval: 15_000,
  });
  const targetedNextRunReceipts = useQuery({
    queryKey: queryKeys.conversations.targetedNextRun(conversationId),
    queryFn: () => api.getTargetedNextRunReceipts(conversationId, 20),
    staleTime: 5_000,
    refetchInterval: query => query.state.data?.receipts.some(receipt =>
      receipt.recipients.some(recipient => recipient.state === "pending")
    ) ? 5_000 : false,
  });
  const membersQuery = useInfiniteQuery({
    queryKey: queryKeys.conversations.members(conversationId, memberSearch),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listConversationMembersPage(conversationId, {
        limit: 100,
        cursor: pageParam,
        search: memberSearch || undefined,
      }),
    getNextPageParam: page =>
      page.hasMore ? page.cursor : undefined,
    select: normalizeResetPages,
  });
  const membersRequest: WorkspaceDirectoryRequestState = {
    hasResolved: Boolean(membersQuery.data),
    isInitialLoading: !membersQuery.data && membersQuery.isPending,
    isRefreshing: Boolean(membersQuery.data) && membersQuery.isFetching && !membersQuery.isFetchingNextPage,
    isInitialError: !membersQuery.data && membersQuery.isError,
    isPaginationError: Boolean(membersQuery.data) && membersQuery.isFetchNextPageError,
    isRefreshError: Boolean(membersQuery.data) && membersQuery.isRefetchError && !membersQuery.isFetchNextPageError,
    isFetchingNextPage: membersQuery.isFetchingNextPage,
    hasNextPage: Boolean(membersQuery.hasNextPage),
    retry: () => membersQuery.refetch({ cancelRefetch: false }),
    fetchNextPage: membersQuery.fetchNextPage,
  };
  const conversationAgents = useMemo(() => {
    const byId = new Map<string, AgentDto>();
    if (!memberSearch) {
      for (const agent of detailQuery.data?.agents ?? []) byId.set(agent.id, agent);
    }
    for (const page of membersQuery.data?.pages ?? []) {
      for (const agent of page.items) byId.set(agent.id, agent);
    }
    return [...byId.values()];
  }, [detailQuery.data?.agents, memberSearch, membersQuery.data?.pages]);
  const commandTargetMembersQuery = useQuery({
    queryKey: queryKeys.conversations.members(
      conversationId,
      commandTargetHandle ? "target:" + commandTargetHandle : "",
    ),
    queryFn: () =>
      api.listConversationMembersPage(conversationId, {
        limit: 100,
        search: commandTargetHandle?.replaceAll("-", " "),
      }),
    enabled: Boolean(commandTargetHandle && !commandTargetAgentId),
    staleTime: 30_000,
  });
  const commandTargetAgents = useMemo(() => {
    if (!commandTargetHandle) return [];
    const byId = new Map(conversationAgents.map(agent => [agent.id, agent]));
    for (const agent of commandTargetMembersQuery.data?.items ?? []) {
      byId.set(agent.id, agent);
    }
    return [...byId.values()].filter(
      agent =>
        agent.handle.toLocaleLowerCase() ===
        commandTargetHandle.toLocaleLowerCase(),
    );
  }, [commandTargetHandle, commandTargetMembersQuery.data?.items, conversationAgents]);
  const structurallySelectedCommandTarget = commandTargetAgentId
    ? agents.find(
        agent => agent.id === commandTargetAgentId,
      )
    : undefined;
  const commandTargetAgent =
    structurallySelectedCommandTarget ??
    (commandTargetAgents.length === 1 ? commandTargetAgents[0] : undefined);
  const commandCapabilitiesQuery = useQuery({
    queryKey: queryKeys.engines.capabilitySelection(
      conversation?.projectId,
      commandTargetAgent?.id,
      commandTargetAgent?.activeEngine,
      commandTargetAgent?.model,
    ),
    queryFn: () =>
      api.getEngineCapabilities(conversation!.projectId, {
        agentId: commandTargetAgent!.id,
        engineId: commandTargetAgent!.activeEngine,
        model: commandTargetAgent!.model,
      }),
    enabled: Boolean(conversation?.projectId && commandTargetAgent),
    staleTime: 10_000,
  });
  useConversationMessageFocusEffect({
    activeView,
    collaborationMessages,
    collaborationQuery,
    conversationId,
    detailQuery,
    focusedMessage,
    focusedMessageHighlightDisposer,
    focusMessageId,
    initialView,
    messages,
    setActiveView,
    setOlderCollaboration,
    setOlderMain,
  });
  // Persist the selection so "the model selected for this conversation" survives
  // reloads and prefills the New Agent dialog.
  const runtimeTargetAgentId = commandTargetAgent?.id;
  const runtimeOwner = commandTargetAgent ? `agent:${commandTargetAgent.id}` : `conversation:${conversationId}`;
  const runtimeSaving = useRuntimeSaving(runtimeOwner);
  const persistDefaults = useMutation({
    ...runtimeMutationOptions(`conversation:${conversationId}`),
    mutationFn: ({ conversationId, ...patch }: {
      conversationId: string;
      defaultEngine?: EngineDto["id"];
      defaultModel?: string | null;
      defaultEffort?: string | null;
      defaultSpeed?: string | null;
    }) => api.updateConversation(conversationId, patch),
    onSuccess: updated => {
      queryClient.setQueriesData<unknown>(
        { queryKey: queryKeys.conversations.detailPrefix(updated.id) },
        (current: unknown) => current && typeof current === "object" && "conversation" in current
          ? { ...current, conversation: updated }
          : current,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all,
      });
    },
    onSettled: (_updated, _error, variables) => queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.detailPrefix(variables.conversationId),
    }),
  });
  const saveRuntimeDefaults = (patch: Omit<Parameters<typeof persistDefaults.mutate>[0], "conversationId">) => {
    // Carry only still-pending explicit overrides forward. If a prior model or
    // engine save fails, a later effort save still represents the user's intent
    // without pinning fields they left inherited.
    const queued = queryClient.getMutationCache().findAll({
      mutationKey: queryKeys.runtimeSelection(`conversation:${conversationId}`), exact: true, status: "pending",
    });
    persistDefaults.mutate(Object.assign({}, ...queued.map(item => item.state.variables), { conversationId, ...patch }));
  };

  const persistTargetRuntime = useMutation({
    ...runtimeMutationOptions(`agent:${runtimeTargetAgentId ?? ""}`),
    mutationFn: ({
      agentId,
      activeEngine,
      model,
      effort,
      speed,
    }: {
      agentId: string;
      activeEngine: EngineDto["id"];
      model: string | null;
      effort: string | null;
      speed: string | null;
    }) => api.updateAgent(agentId, { activeEngine, model, effort, speed }),
    onSuccess: updated => {
      publishUpdatedAgent(queryClient, updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(updated.projectId),
      });
    },
    onSettled: (_updated, _error, variables) => refreshAgentRuntime(queryClient, variables.agentId),
  });

  const hydratedRuntimeOwner = useRef<string>();
  useEffect(() => {
    if ((runtimeSaving && hydratedRuntimeOwner.current === runtimeOwner) || !conversation || !preferencesQuery.data || !projectsQuery.data) return;
    const project = projectsQuery.data.find(
      candidate => candidate.id === conversation.projectId,
    );
    const source = commandTargetAgent
      ? {
          engine: commandTargetAgent.activeEngine,
          model: commandTargetAgent.model,
          effort: commandTargetAgent.effort,
          speed: commandTargetAgent.speed,
        }
      : {
          engine: conversation.defaultEngine ?? project?.defaultEngine,
          model: conversation.defaultModel,
          effort: conversation.defaultEffort,
          speed: conversation.defaultSpeed,
        };
    const selection = { ...source, ...pendingRuntimeSelection(queryClient, runtimeOwner) };
    const resolvedEngine = resolveConversationEngine(selection.engine, engines);
    const selectedEngine = engines.find(
      candidate => candidate.id === resolvedEngine,
    );
    if (!resolvedEngine || !selectedEngine) return;
    const resolved = resolveRuntimeSelection(
      selectedEngine,
      preferencesQuery.data,
      project,
      {
        model: selection.model ?? undefined,
        effort: selection.effort ?? undefined,
        speed: selection.speed ?? undefined,
      },
    );
    hydratedRuntimeOwner.current = runtimeOwner;
    setEngine(resolvedEngine);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed ?? "");
  }, [
    conversation?.defaultEffort,
    conversation?.defaultEngine,
    conversation?.defaultModel,
    conversation?.defaultSpeed,
    conversation?.id,
    conversation?.projectId,
    commandTargetAgent?.activeEngine,
    commandTargetAgent?.effort,
    commandTargetAgent?.model,
    commandTargetAgent?.speed,
    engines,
    preferencesQuery.data,
    projectsQuery.data,
    runtimeOwner,
    runtimeTargetAgentId,
    runtimeSaving,
  ]);

  const rename = useMutation({
    mutationFn: (title: string) =>
      api.updateConversation(conversationId, { title }),
    onSuccess: () => {
      invalidate();
      setRenameOpen(false);
    },
  });
  const titleGenerationRequested = useRef<string>();
  const generateTitle = useMutation({
    mutationFn: () => api.generateConversationTitle(conversationId),
    onSuccess: result => {
      if (result.generated) invalidate();
    },
  });
  useEffect(() => {
    if (
      !/^New Chat$/i.test(conversation?.title ?? "") ||
      titleGenerationRequested.current === conversationId
    )
      return;
    const hasOperatorMessage = messages.some(
      message => message.role === "user",
    );
    if (!hasOperatorMessage) return;
    titleGenerationRequested.current = conversationId;
    generateTitle.mutate();
  }, [conversation?.title, conversationId, generateTitle, messages]);

  const deleteConversation = useMutation({
    mutationFn: (expectedAgentIds: string[]) => api.deleteConversation(conversationId, expectedAgentIds),
    onSuccess: () => {
      queryClient.removeQueries({
        queryKey: queryKeys.conversations.detailPrefix(conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(conversation?.projectId),
      });
      setDeleteOpen(false);
      onDeleted();
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["chat-deletion-agents", conversationId] });
    },
  });

  const activeEngine = engines.find(candidate => candidate.id === engine);
  const project = conversation
    ? projectsQuery.data?.find(
        (candidate: ProjectDto) => candidate.id === conversation.projectId,
      )
    : undefined;
  const selectedRuntime = useRuntimeControls({
    engine: activeEngine,
    preferences: preferencesQuery.data,
    project,
    selection: { model, effort, speed },
    onChange: next => {
      setModel(next.model);
      setEffort(next.effort);
      setSpeed(next.speed ?? "");
    },
  });
  const agentTitle = useCallback(
    (agentId: string | undefined): string =>
      identityAgents.find(agent => agent.id === agentId)?.title ?? "Agent",
    [identityAgents],
  );
  const agentHandle = useCallback(
    (agentId: string | undefined): string =>
      identityAgents.find(agent => agent.id === agentId)?.handle ?? "Agent",
    [identityAgents],
  );
  const {
    cancelOperationError,
    cancelOperationPending,
    cancelOperationTargets,
    cancelQueued,
    editQueued,
    invalidate,
    operationRunning,
    queuedMessageFailure,
    queuedMessageNotice,
    queuedMessagesQuery,
    setQueuedMessageNotice,
    setStopConfirmation,
    steerQueued,
    stopConfirmation,
    stopOperation,
    submit,
  } = useConversationMessagingController({
    conversationId,
    conversation,
    agents,
    detailAgents: detailQuery.data?.agents ?? [],
    engines,
    engine,
    model,
    effort,
    speed,
    healthByAgentId,
    messages,
    agentTitle,
  });
  const reconciledQueuedMessages = useMemo(
    () => reconcileQueuedProjectMessages(
      mainTimeline,
      queuedMessagesQuery.data ?? [],
    ),
    [mainTimeline, queuedMessagesQuery.data],
  );
  const visibleMainTimeline = reconciledQueuedMessages.timeline;
  const visibleMessageLayoutKey = visibleMainTimeline
    .map(entry => entry.id)
    .join(":");
  const agentIdForHandle = useCallback(
    (handle: string): string | undefined =>
      agentIdForMentionHandle(agents, handle),
    [agents],
  );
  const mentionAgent = useCallback(
    (agentId: string) => {
      setMentionInsertRequest({
        id: String(Date.now()),
        text: `#${agentHandle(agentId)} `,
      });
    },
    [agentHandle],
  );
  const lastContinuationDestination = useMemo(() => {
    const message = [...messages]
      .reverse()
      .find(candidate => candidate.authorAgentId !== undefined);
    const agentId = message?.authorAgentId ?? (
      message?.directMessageAgents?.length === 1
        ? message.directMessageAgents[0]!.id
        : undefined
    );
    const agent = agentId
      ? routingAgents.find(candidate => candidate.id === agentId)
      : undefined;
    return agent && message
      ? {
          agent,
          selectionKey: `${agent.id}:${message.id}`,
        }
      : undefined;
  }, [routingAgents, messages]);
  const transcriptMessage = useCallback((message: ConversationMessageDto) => ({
    author: message.authorAgentId
      ? agentTitle(message.authorAgentId)
      : message.role === "system" ? "System" : "You",
    text: resolveMessageMentionText(message.text, message.agentMentions),
    createdAt: message.createdAt,
    attachments: message.attachments,
    document: message.document,
  }), [agentTitle]);
  const mainTranscriptMarkdown = useMemo(
    () =>
      conversation
        ? buildMarkdownTranscript(
            conversation.title,
            messages.map(transcriptMessage),
            { hasEarlier: mainHistory.hasMore },
          )
        : "",
    [transcriptMessage, conversation?.title, messages, mainHistory.hasMore],
  );
  const collaborationTranscriptMarkdown = useMemo(
    () =>
      conversation
        ? buildMarkdownTranscript(
            `${conversation.title} — Team chat`,
            collaborationMessages.map(transcriptMessage),
            { hasEarlier: collaborationHistory.hasMore },
          )
        : "",
    [transcriptMessage, collaborationMessages, conversation?.title, collaborationHistory.hasMore],
  );

  if (detailQuery.isLoading) {
    return (
      <Box sx={{ p: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (detailQuery.isError && !detailQuery.data) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => void detailQuery.refetch()}
            >
              Retry
            </Button>
          }
        >
          This Chat could not be loaded. Check the server connection and
          try again.
        </Alert>
      </Box>
    );
  }

  if (!detailQuery.data || !conversation) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Chat not found.</Alert>
      </Box>
    );
  }

  const composerRuntime = conversationComposerRuntime(
    activeEngine,
    engineCapabilities,
  );
  const composerCommands = commandTargetAgent
    ? (commandCapabilitiesQuery.data?.find(
        item => item.engineId === commandTargetAgent.activeEngine,
      )?.commands ?? [])
    : undefined;
  const models = selectedRuntime.models;
  const efforts = selectedRuntime.efforts;
  const speeds = selectedRuntime.speeds;
  const engineReady = selectedRuntime.ready;
  const engineUnavailableMessage = !engineReady
    ? activeEngine
      ? providerAvailabilityMessage(activeEngine)
      : "The selected provider is unavailable."
    : undefined;
  const collaborationInitiallyLoading =
    collaborationQuery.isPending &&
    collaborationMessages.length === 0 &&
    operationalEvents.length === 0;
  const detailRefreshFailed = detailQuery.isError && detailQuery.data !== undefined;

  const transcriptTitle =
    activeView === "collaboration"
      ? `${conversation.title} — Team chat`
      : conversation.title;
  const transcriptMarkdown =
    activeView === "collaboration"
      ? collaborationTranscriptMarkdown
      : mainTranscriptMarkdown;
  const mentionHandles = [
    "broadcast",
    "everyone",
    ...routingAgents
      .map(agent => agent.handle)
      .filter(
        handle =>
          !["broadcast", "user", "everyone"].includes(
            handle.toLocaleLowerCase(),
          ),
      ),
  ];
  const mentionBindings = routingAgents
    .map(agent => ({
      projectId: conversation?.projectId ?? "",
      handle: agent.handle,
      agentId: agent.id,
      currentHandle: agent.handle,
      currentTitle: agent.title,
    }))
    .filter(binding => binding.handle &&
      !["broadcast", "user", "everyone"].includes(binding.handle.toLocaleLowerCase()));
  const busyMentionHandles = agents
    .filter(agent => statusByAgentId.get(agent.id) === "running")
    .map(agent => agent.handle);

  const resetOrChangeEngine = (next: string) => {
    setSubmissionRuntimeIntent(value => value + 1);
    const nextEngine = engines.find(candidate => candidate.id === next);
    if (!nextEngine) return;
    const resolved = resolveRuntimeSelection(
      nextEngine,
      preferencesQuery.data,
      project,
    );
    if (next === engine && resolved.model === model && resolved.effort === effort && (resolved.speed ?? "") === (speed ?? "")) return;
    setEngine(next);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed ?? "");
    if (commandTargetAgent) {
      persistTargetRuntime.mutate(
        {
          agentId: commandTargetAgent.id,
          activeEngine: next as EngineDto["id"],
          model: resolved.model || null,
          effort: resolved.effort || null,
          speed: resolved.speed || null,
        },
      );
    } else {
      saveRuntimeDefaults(
        {
          defaultEngine: next as EngineDto["id"],
          defaultModel: resolved.model || null,
          defaultEffort: resolved.effort || null,
          defaultSpeed: resolved.speed || null,
        },
      );
    }
  };
  const runtimeControls =
    activeView === "main" ? (
      <ComposerRuntimeSelector
        engine={engine}
        engines={engines.map(option => ({
          id: option.id,
          label: option.displayName,
          disabled: !engineIsAvailable(option),
          detail: engineUnavailableReason(option),
        }))}
        model={model}
        models={models}
        effort={effort}
        efforts={efforts}
        speed={selectedRuntime.speed}
        speeds={speeds}
        selectionKey={commandTargetAgent?.id ?? conversationId}
        scopeLabel={commandTargetAgent ? `${commandTargetAgent.title} Next Run` : undefined}
        onEngineChange={resetOrChangeEngine}
        onReset={() => { if (engine) resetOrChangeEngine(engine); }}
        onModelChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const resolved = selectedRuntime.selectModel(next);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate(
              {
                agentId: commandTargetAgent.id,
                activeEngine: engine as EngineDto["id"],
                model: resolved.model || null,
                effort: resolved.effort || null,
                speed: resolved.speed || null,
              },
            );
          } else {
            saveRuntimeDefaults(
              {
                defaultModel: resolved.model,
                defaultEffort: resolved.effort || null,
                defaultSpeed: resolved.speed || null,
              },
            );
          }
        }}
        onEffortChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const resolved = selectedRuntime.selectEffort(next);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate(
              {
                agentId: commandTargetAgent.id,
                activeEngine: engine as EngineDto["id"],
                model: resolved.model || null,
                effort: resolved.effort || null,
                speed: resolved.speed || null,
              },
            );
          } else {
            saveRuntimeDefaults(
              { defaultEffort: resolved.effort, defaultSpeed: resolved.speed || null },
            );
          }
        }}
        onSpeedChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const resolved = selectedRuntime.selectSpeed(next);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate(
              {
                agentId: commandTargetAgent.id,
                activeEngine: engine as EngineDto["id"],
                model: resolved.model || null,
                effort: resolved.effort || null,
                speed: resolved.speed || null,
              },
            );
          } else {
            saveRuntimeDefaults(
              { defaultSpeed: resolved.speed || null },
            );
          }
        }}
      />
    ) : null;
  return (
    <OutgoingMessageProvider scope={conversationId} profile={preferencesQuery.data?.profile} onOpenAgent={id => onOpenAgent(id)}><Box
      sx={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: detailRefreshFailed
          ? "auto auto minmax(0, 1fr) auto"
          : "auto minmax(0, 1fr) auto",
      }}
    >
      <ConversationHeader
        activeView={activeView}
        agentWorkOpen={agentWorkOpen}
        conversation={conversation}
        onChatSettings={() => setContextSettingsOpen(true)}
        projectLabel={project?.label}
        transcriptMarkdown={transcriptMarkdown}
        transcriptTitle={transcriptTitle}
        onOpenProject={onOpenProject}
        onOpenProjectBrowser={onOpenProjectBrowser}
        setAgentWorkOpen={setAgentWorkOpen}
        setRenameValue={setRenameValue}
        setRenameOpen={setRenameOpen}
        setAddAgentsOpen={setAddAgentsOpen}
        setDeleteOpen={setDeleteOpen}
        setActiveView={next => {
          setActiveView(next);
          onViewChange?.(next);
        }}
      />

      {contextSettingsOpen ? <ChatContextSettings key={conversation.id} chat={conversation} open onClose={()=>setContextSettingsOpen(false)} /> : null}
      {detailRefreshFailed ? (
        <Alert
          severity="warning"
          action={<Button color="inherit" size="small" onClick={() => void detailQuery.refetch()}>Retry</Button>}
          sx={{ m: 1 }}
        >
          This Chat could not be refreshed. The last loaded messages remain available.
        </Alert>
      ) : null}

      <Box
        sx={{
          position: "relative",
          height: "100%",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <Box
          id="chat-workspace-main-panel"
          role="tabpanel"
          aria-labelledby="chat-workspace-main-tab"
          tabIndex={-1}
          hidden={agentWorkOpen || activeView !== "main"}
          sx={{
            height: "100%",
            minHeight: 0,
            minWidth: 0,
            display: !agentWorkOpen && activeView === "main" ? "block" : "none",
          }}
        >
          <ChatSurface
            showOutgoingMessage
            canonicalCommunicationIds={messages.map(message => message.communicationEventId)}
            layout="project"
            layoutKey={`main:${visibleMessageLayoutKey}`}
            label="Chat messages"
            follow={{
              kind: "latest",
              storageKey: chatStateKey(
                "scroll",
                `conversation.${conversationId}.main`,
              ),
            }}
            history={{
              kind: "cursor",
              hasEarlier: mainHistory.hasMore,
              loading: loadingOlder,
              onLoadEarlier: () => void loadOlderHistory(),
            }}
            beforeMessages={
              <>
                {olderError ? (
                  <Alert
                    severity="error"
                    action={<Button color="inherit" size="small" onClick={() => void loadOlderHistory()}>Retry</Button>}
                    sx={{ m: 1.5 }}
                  >
                    {olderError}
                  </Alert>
                ) : null}
                {(activeBrowsers.data ?? [])
                  .filter(session => conversationAgents.some(agent => agent.id === session.agentId))
                  .map(session => {
                    const agentTitle = conversationAgents.find(agent => agent.id === session.agentId)?.title ?? "Agent";
                    return (
                      <Alert
                        key={session.id}
                        severity="info"
                        role="region"
                        aria-label={`${agentTitle} browser status`}
                        action={
                          <Button
                            color="inherit"
                            size="small"
                            onClick={() => onOpenBrowser(session.agentId, session.runId)}
                          >
                            View Browser
                          </Button>
                        }
                        sx={{ mb: 1.5 }}
                      >
                        {session.status === "opening"
                          ? `${agentTitle}'s browser is ${session.queuePosition ? `queued at position ${session.queuePosition}` : "opening"}`
                          : `${agentTitle} is using the browser${session.title ? ` · ${session.title}` : ""}`}
                        {session.profileMode === "trusted" && session.profileName
                          ? ` · Trusted profile: ${session.profileName}`
                          : " · Disposable profile"}
                        {session.controlOwner === "operator" ? " · Operator has control" : ""}.
                      </Alert>
                    );
                  })}
              </>
            }
          >
            <MainConversationTimeline
              mainTimeline={visibleMainTimeline}
              operatorProfile={preferencesQuery.data?.profile}
              projectId={conversation.projectId}
              projectRoot={project?.hostPath}
              healthByAgentId={healthByAgentId}
              agentTitle={agentTitle}
              agentIdForHandle={agentIdForHandle}
              onOpenAgent={onOpenAgent}
              onOpenReview={onOpenReview}
              onOpenFileActivity={onOpenFileActivity}
              mentionAgent={mentionAgent}
              markCommunicationVisible={markCommunicationVisible}
              notifications={notificationsQuery.data?.items ?? []}
            />
          </ChatSurface>
        </Box>

        {collaborationVisited.current ? (
          <Box
            id="chat-workspace-collaboration-panel"
            role="tabpanel"
            aria-labelledby="chat-workspace-collaboration-tab"
            tabIndex={-1}
            hidden={agentWorkOpen || activeView !== "collaboration"}
            sx={{
              height: "100%",
              minHeight: 0,
              minWidth: 0,
              display:
                !agentWorkOpen && activeView === "collaboration"
                  ? "block"
                  : "none",
            }}
          >
            <ChatSurface
              layout="project"
              layoutKey={`collaboration:${collaborationLayoutKey}:${operationalLayoutKey}`}
              label="Team chat messages"
              follow={{
                kind: "latest",
                storageKey: chatStateKey(
                  "scroll",
                  `conversation.${conversationId}.collaboration`,
                ),
              }}
              history={{
                kind: "cursor",
                hasEarlier:
                  collaborationHistory.hasMore ||
                  collaborationHistory.operationHasMore,
                loading: loadingOlder,
                onLoadEarlier: () => void loadOlderHistory(),
              }}
              beforeMessages={<>
                <Alert severity="info" icon={false} sx={{ mx: 1.5, mt: 1.5, mb: olderError ? 0 : 1.5 }}>
                  Team Chat shows how Agents coordinate. It is read-only; to talk to an Agent, use Chat and mention them.
                </Alert>
                {olderError ? <Alert
                  severity="error"
                  action={<Button color="inherit" size="small" onClick={() => void loadOlderHistory()}>Retry</Button>}
                  sx={{ m: 1.5 }}
                >{olderError}</Alert> : null}
              </>}
            >
              {collaborationQuery.isError && !collaborationQuery.data ? (
                <Alert
                  severity="error"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      disabled={collaborationQuery.isFetching}
                      onClick={() => void collaborationQuery.refetch()}
                    >
                      Retry
                    </Button>
                  }
                  sx={{ m: 1.5 }}
                >
                  Team Chat could not be loaded. Check the server connection and
                  try again.
                </Alert>
              ) : collaborationInitiallyLoading ? (
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="center"
                  spacing={1}
                  sx={{ minHeight: 120, color: "text.secondary" }}
                >
                  <CircularProgress size={16} color="inherit" />
                  <Typography variant="body2">Loading Team Chat…</Typography>
                </Stack>
              ) : (
                <CollaborationTimeline
                  operationalEvents={operationalEvents}
                  collaborationMessages={collaborationMessages}
                  projectId={conversation.projectId}
                  projectRoot={project?.hostPath}
                  healthByAgentId={healthByAgentId}
                  operatorProfile={preferencesQuery.data?.profile}
                  agentTitle={agentTitle}
                  agentIdForHandle={agentIdForHandle}
                  onOpenAgent={onOpenAgent}
                  onOpenReview={onOpenReview}
                  onOpenFileActivity={onOpenFileActivity}
                />
              )}
            </ChatSurface>
          </Box>
        ) : null}

        {agentWorkOpen ? (
          <AgentWorkInspector
            open
            projectId={conversation.projectId}
            conversationId={conversationId}
            onClose={() => setAgentWorkOpen(false)}
          />
        ) : activeView === "files" ? (
          <Box
            id="chat-workspace-files-panel"
            role="tabpanel"
            aria-labelledby="chat-workspace-files-tab"
            // Bound the nested list to the workspace; an auto-height wrapper
            // lets it grow behind this view's overflow-hidden ancestor.
            sx={{ height: "100%", minHeight: 0, minWidth: 0 }}
          ><ConversationFilesResults
            projectId={conversation.projectId}
            projectRoot={
              projectsQuery.data?.find(
                project => project.id === conversation.projectId,
              )?.hostPath ?? ""
            }
            conversationId={conversation.id}
            agents={conversationAgents}
          /></Box>
        ) : activeView === "agents" ? (
          <Box id="chat-workspace-agents-panel" role="tabpanel" aria-labelledby="chat-workspace-agents-tab" sx={{ height: "100%", minHeight: 0, minWidth: 0 }}><AgentsTab
            searchValue={memberSearch}
            onSearchValueChange={setMemberSearch}
            agents={conversationAgents}
            relationshipAgents={projectAgents}
            projectId={conversation.projectId}
            engines={engines}
            conversations={[conversation]}
            scopeConversationId={conversation.id}
            statusByAgentId={statusByAgentId}
            healthByAgentId={healthByAgentId}
            onOpenAgent={agentId => onOpenAgent(agentId)}
            onOpenAgentSettings={agentId =>
              onOpenAgent(agentId, "settings")}
            onAgentsDeleted={(_projectId, agentIds) =>
              onAgentsDeleted(agentIds)}
            onNewAgent={managerAgentId =>
              onNewAgent(conversation, managerAgentId)
            }
            collection={{
              title: `${conversation.title} Agents`,
              detail: membersQuery.data ? String(membersQuery.data.pages[0]?.total ?? conversationAgents.length) + " Agents" : undefined,
              totalCount: membersQuery.data?.pages[0]?.total,
              variant: "embedded",
            }}
            collectionRequest={membersRequest}
            organizationDataComplete={!memberSearch&&membersRequest.hasResolved&&!membersRequest.hasNextPage&&!membersRequest.isPaginationError&&!membersRequest.isRefreshError}
            collectionFooter={filteredCount=><CollectionStateFeedback resourceLabel="Agents" request={membersRequest} itemCount={filteredCount} filtersActive={Boolean(memberSearch.trim())} emptyTitle="No Agents Yet" suppressEmpty/>}
          /></Box>
        ) : null}
        {activeView === "main" && !agentWorkOpen ? (
          <Box
            sx={{
              position: "absolute",
              insetInline: 0,
              bottom: 2,
              zIndex: 2,
              pointerEvents: "none",
            }}
          >
            <ProviderFailureBanner messages={detailQuery.data.providerFailureMessages ?? messages} hasMore={detailQuery.data.providerFailuresHasMore} onOpenAgent={id => onOpenAgent(id)} agents={identityAgents} projectId={conversation.projectId}>
            <MasterRespondingIndicator
              messages={messages}
              agents={agents}
              healthByAgentId={healthByAgentId}
            />
            </ProviderFailureBanner>
          </Box>
        ) : null}
      </Box>

      {auditOnly?<Alert severity="info" sx={{m:1}}>This temporary Chat belongs to a workflow execution. Inspect its messages and results here.</Alert>:<ChatComposerDock
        visible={!agentWorkOpen && activeView === "main"}
      >
        {activeView === "main" && queuedMessageNotice ? (
          <Alert
            severity="info"
            sx={{
              mx: 1.5,
              mt: 1,
              minWidth: 0,
              "& .MuiAlert-message": {
                minWidth: 0,
                overflowWrap: "anywhere",
              },
            }}
          >
            {queuedMessageNotice}
          </Alert>
        ) : null}
        {persistTargetRuntime.error || persistDefaults.error ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Runtime selection was not saved. The last saved selection was restored.
          </Alert>
        ) : null}
        {cancelOperationError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Cancellation failed. {cancelOperationError.message}
          </Alert>
        ) : null}
        {queuedMessageFailure ? (
          <Alert
            severity="error"
            sx={{ mx: 1.5, mt: 1 }}
            action={<Button color="inherit" size="small" onClick={queuedMessageFailure.retry}>
              Retry
            </Button>}
          >
            Queued messages could not be updated. {queuedMessageFailure.error.message}
          </Alert>
        ) : null}
        {activeView === "main" ? (
          <QueuedMessageTray
            messages={reconciledQueuedMessages.queuedMessages}
            scope={conversationId}
            attachmentNamesForMessage={queued => messages.find(message => message.id === queued.messageId || message.communicationEventId === queued.messageId)?.attachments?.map(attachment => attachment.name)}
            agentNameForId={agentTitle}
            busy={
              cancelQueued.isPending ||
              editQueued.isPending ||
              steerQueued.isPending
            }
            onSteer={message =>
              steerQueued.mutateAsync({
                deliveryId: message.deliveryId,
                targetAgentId: message.targetAgentId,
              })
            }
            onEdit={(message, text) =>
              editQueued.mutateAsync({
                deliveryId: message.deliveryId,
                targetAgentId: message.targetAgentId,
                text,
              })
            }
            onDelete={message => cancelQueued.mutateAsync(message.deliveryId)}
          />
        ) : null}
        {activeView === "main" && targetedNextRunReceipts.data ? (
          <TargetedNextRunReceipts receipts={targetedNextRunReceipts.data.receipts} />
        ) : null}
        <Composer
          enableVoiceDictation
          voiceContext={activeView === "main" && !agentWorkOpen ? {
            projectId: conversation.projectId,
            conversationId,
            agents: routingAgents,
            selectedAgentId: commandTargetAgent?.conversationId === conversationId ? commandTargetAgent.id : undefined,
          } : undefined}
          draftStorageKey={chatStateKey(
            "draft",
            `conversation.${conversationId}.main`,
          )}
          conversationDraftId={conversationId}
          destinationMode="project-chat"
          defaultDestination={lastContinuationDestination ? {
            handle: lastContinuationDestination.agent.handle,
            binding: {
              projectId: conversation.projectId,
              handle: lastContinuationDestination.agent.handle,
              agentId: lastContinuationDestination.agent.id,
              currentHandle: lastContinuationDestination.agent.handle,
              currentTitle: lastContinuationDestination.agent.title,
            },
            selectionKey: lastContinuationDestination.selectionKey,
          } : undefined}
          insertTextRequest={mentionInsertRequest}
          controls={runtimeControls}
          disabled={false}
          submissionDisabled={
            runtimeSaving
          }
          running={operationRunning}
          allowSendWhileRunning
          submissionRuntimeKey={JSON.stringify([engine, model, effort, speed])}
          submissionRuntimeIntentKey={String(submissionRuntimeIntent)}
          mentionHandles={mentionHandles}
          mentionBindings={mentionBindings}
          mentionBindingsReady={projectAgentsQuery.data !== undefined}
          commands={composerCommands}
          onCommandTargetHandleChange={setCommandTargetHandle}
          onCommandTargetAgentIdChange={setCommandTargetAgentId}
          capabilities={composerRuntime.capabilities}
          onCapabilitiesOpen={() =>
            onRefreshCapabilities({ engineId: activeEngine?.id, model })
          }
          onCommand={
            commandTargetAgent
              ? (command, argumentsText) => {
                  const invocation = api.invokeProviderCommand(
                    commandTargetAgent.id,
                    {
                      name: command.name,
                      ...(argumentsText ? { argumentsText } : {}),
                    },
                  );
                  return invocation.then(result => {
                    if (result.message) setQueuedMessageNotice(result.message);
                    else notify({ key: "provider-command", message: `/${command.name} Invoked` });
                  });
                }
              : undefined
          }
          busyMentionHandles={busyMentionHandles}
          allowUnmentionedSend={engineReady}
          sendUnavailableReason={engineUnavailableMessage}
          placeholder={
            engineReady
              ? "Write a message…"
              : "Choose an available Agent with # or use #broadcast"
          }
          onSend={(text, files, stagedIds, draftOwnerId, context) =>
            submit(
              text,
              files,
              "steer",
              stagedIds,
              draftOwnerId,
              context?.mentionedAgents,
              context?.newAgentRequested,
              context?.retryPreparedAttempt,
              context?.pendingSubmission,
              context?.persistPendingSubmission,
              context?.onAgentCreated,
              context?.capturedSubmission,
            )
          }
          onQueue={(text, files, stagedIds, draftOwnerId, context) =>
            submit(
              text,
              files,
              "queue",
              stagedIds,
              draftOwnerId,
              context?.mentionedAgents,
              context?.newAgentRequested,
              context?.retryPreparedAttempt,
              context?.pendingSubmission,
              context?.persistPendingSubmission,
              context?.onAgentCreated,
              context?.capturedSubmission,
            )
          }
          agentResponding={false}
          projectId={conversation.projectId}
          onCancel={stopOperation}
          cancelPending={cancelOperationPending}
        />
      </ChatComposerDock>}

      {!auditOnly&&<ConversationDialogs
        conversation={conversation}
        engines={engines}
        addAgentsOpen={addAgentsOpen}
        onCreateAgent={() => onNewAgent(conversation)}
        stopError={cancelOperationError?.message}
        stopPending={cancelOperationPending}
        stopConfirmation={stopConfirmation}
        renameOpen={renameOpen}
        renameValue={renameValue}
        renamePending={rename.isPending}
        renameError={rename.isError ? String(rename.error) : undefined}
        deleteOpen={deleteOpen}
        deletePending={deleteConversation.isPending}
        deleteError={
          deleteConversation.isError
            ? String(deleteConversation.error)
            : undefined
        }
        onAddAgentsClose={() => setAddAgentsOpen(false)}
        onStopCancel={() => {
          if (!cancelOperationPending) setStopConfirmation(undefined);
        }}
        onStopConfirm={targets => void cancelOperationTargets(targets)}
        onRenameClose={() => setRenameOpen(false)}
        onRenameValueChange={setRenameValue}
        onRename={() => rename.mutate(renameValue.trim())}
        onDeleteClose={() => setDeleteOpen(false)}
        onDelete={(expectedAgentIds) => deleteConversation.mutate(expectedAgentIds)}
      />}

    </Box></OutgoingMessageProvider>
  );
}
