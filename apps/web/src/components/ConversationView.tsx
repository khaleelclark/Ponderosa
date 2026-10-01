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
  resolveConversationEngine,
  resolveRuntimeSelection,
} from "../conversationEngine";
import {
  agentIdForMentionHandle,
} from "../mentions";
import { Composer } from "./chat/Composer";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { ChatSurface } from "./chat/ChatSurface";
import { buildMarkdownTranscript } from "../chatTranscript";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { AttentionSurface } from "./AttentionSurface";
import { TargetedNextRunReceipts } from "./TargetedNextRunReceipts";
import { queryKeys } from "../queryKeys";
import { AgentsTab } from "./AgentsTab";
import { AllTriggersWorkspace } from "./WorkspaceResourceViews";
import type { ConversationDetailView, Route } from "../routing";
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
import { MasterRespondingIndicator } from "./ConversationComposerStatus";
import {
  resolveMessageMentionText,
} from "./chat/ChatMessages";
import { ConversationFilesResults } from "./ConversationFilesResults";
import { ChatComposerDock } from "./chat/ChatComposerDock";
import { CollectionPagination } from "./CollectionPrimitives";
import { ChatContextSettings } from "./ChatContextSettings";

import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { replaceCachedConversationAgent } from "../conversationAgentCache";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { useRuntimeControls } from "../hooks/useRuntimeControls";
import {
  recordRuntimeCanonicalKey,
  runtimeCanonicalKey,
  runtimeMutationOwnsAuthority,
} from "./allChatRouting";

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
  onOpenAgentWork,
  onOpenBrowser,
  onOpenFileActivity,
  onNewAgent,
  preferences,
  onPreferences,
  onNavigateTrigger,
  onCreateTrigger,
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
  onOpenAgentWork(focusId?: string): void;
  onOpenBrowser(agentId: string, runId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onNewAgent(master: ConversationDto, managerAgentId?: string): void;
  preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigateTrigger(route: Route): void;
  onCreateTrigger(agentId?: string): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useConversationActiveViewState(
    conversationId,
    initialView,
  );
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
    notificationsQuery,
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
  const runtimeMutationGenerationByOwner = useRef(new Map<string, number>());
  const runtimeCanonicalKeyByOwner = useRef(new Map<string, string>());
  const optimisticRuntimeByOwner = useRef(new Map<string, {
    engine: string;
    model: string;
    effort: string;
    speed: string;
  }>());
  const runtimeOwnerRef = useRef<string>();
  const currentRuntimeCanonicalKeyRef = useRef<string>();
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
        agent => agent.id === commandTargetAgentId && !agent.archived,
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
  const persistDefaults = useMutation({
    mutationFn: (patch: {
      defaultEngine?: EngineDto["id"];
      defaultModel?: string | null;
      defaultEffort?: string | null;
      defaultSpeed?: string | null;
    }) => api.updateConversation(conversationId, patch),
    onSuccess: updated => {
      queryClient.setQueriesData<unknown>(
        { queryKey: queryKeys.conversations.detailPrefix(conversationId) },
        (current: unknown) => current && typeof current === "object" && "conversation" in current
          ? { ...current, conversation: updated }
          : current,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.detailPrefix(conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all,
      });
    },
  });

  const persistTargetRuntime = useMutation({
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
      queryClient.setQueriesData<unknown>(
        { queryKey: queryKeys.conversations.detailPrefix(conversationId) },
        (current: unknown) => replaceCachedConversationAgent(current, updated),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(updated.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(updated.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.detailPrefix(conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.members(conversationId),
      });
    },
  });

  const runtimeTargetAgentId = commandTargetAgent?.id;
  const runtimeOwner = commandTargetAgent
    ? `agent:${commandTargetAgent.id}`
    : `conversation:${conversationId}`;
  const runtimeProject = conversation
    ? projectsQuery.data?.find(candidate => candidate.id === conversation.projectId)
    : undefined;
  const currentRuntimeCanonicalKey = runtimeCanonicalKey(commandTargetAgent
    ? {
        engine: commandTargetAgent.activeEngine,
        model: commandTargetAgent.model,
        effort: commandTargetAgent.effort,
        speed: commandTargetAgent.speed,
      }
    : {
        engine: conversation?.defaultEngine ?? runtimeProject?.defaultEngine,
        model: conversation?.defaultModel,
        effort: conversation?.defaultEffort,
        speed: conversation?.defaultSpeed,
      });
  runtimeOwnerRef.current = runtimeOwner;
  currentRuntimeCanonicalKeyRef.current = currentRuntimeCanonicalKey;
  useEffect(() => {
    if (!conversation || !preferencesQuery.data || !projectsQuery.data) return;
    const project = projectsQuery.data.find(
      candidate => candidate.id === conversation.projectId,
    );
    const source = commandTargetAgent
      ? {
          engine: commandTargetAgent.activeEngine,
          model: commandTargetAgent.model,
          effort: commandTargetAgent.effort,
          speed: commandTargetAgent.speed,
          legacySpeedKey: `agent.${commandTargetAgent.id}.speed`,
        }
      : {
          engine: conversation.defaultEngine ?? project?.defaultEngine,
          model: conversation.defaultModel,
          effort: conversation.defaultEffort,
          speed: conversation.defaultSpeed,
          legacySpeedKey: `conversation.${conversation.id}.speed`,
        };
    const canonicalKey = runtimeCanonicalKey(source);
    const optimistic = optimisticRuntimeByOwner.current.get(runtimeOwner);
    if (optimistic && runtimeCanonicalKey(optimistic) !== canonicalKey) return;
    if (optimistic) optimisticRuntimeByOwner.current.delete(runtimeOwner);
    recordRuntimeCanonicalKey(
      runtimeMutationGenerationByOwner.current,
      runtimeCanonicalKeyByOwner.current,
      runtimeOwner,
      canonicalKey,
    );
    const resolvedEngine = resolveConversationEngine(source.engine, engines);
    const selectedEngine = engines.find(
      candidate => candidate.id === resolvedEngine,
    );
    if (!resolvedEngine || !selectedEngine) return;
    const resolved = resolveRuntimeSelection(
      selectedEngine,
      preferencesQuery.data,
      project,
      {
        model: source.model,
        effort: source.effort,
        speed: source.speed ?? readChatState(chatStateKey("runtime", source.legacySpeedKey)),
      },
    );
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
  ]);

  const captureRuntimeMutation = () => {
    const generation =
      (runtimeMutationGenerationByOwner.current.get(runtimeOwner) ?? 0) + 1;
    runtimeMutationGenerationByOwner.current.set(runtimeOwner, generation);
    return {
      owner: runtimeOwner,
      generation,
      canonicalKey:
        runtimeCanonicalKeyByOwner.current.get(runtimeOwner) ??
        currentRuntimeCanonicalKey,
      previous: { engine, model, effort, speed },
      speedKey: chatStateKey(
        "runtime",
        commandTargetAgent
          ? `agent.${commandTargetAgent.id}.speed`
          : `conversation.${conversationId}.speed`,
      ),
      persistedSpeed: readChatState(chatStateKey(
        "runtime",
        commandTargetAgent
          ? `agent.${commandTargetAgent.id}.speed`
          : `conversation.${conversationId}.speed`,
      )),
    };
  };

  const rollbackRuntimeMutation = (
    captured: ReturnType<typeof captureRuntimeMutation>,
    optimisticSpeed: string,
  ) => {
    optimisticRuntimeByOwner.current.delete(captured.owner);
    if (!runtimeMutationOwnsAuthority({
      capturedOwner: captured.owner,
      currentOwner: runtimeOwnerRef.current,
      capturedGeneration: captured.generation,
      currentGeneration: runtimeMutationGenerationByOwner.current.get(captured.owner),
      capturedCanonicalKey: captured.canonicalKey,
      currentCanonicalKey: currentRuntimeCanonicalKeyRef.current,
    })) return;
    if (readChatState(captured.speedKey) === (optimisticSpeed || undefined)) {
      writeChatState(captured.speedKey, captured.persistedSpeed ?? "");
    }
    setEngine(captured.previous.engine);
    setModel(captured.previous.model);
    setEffort(captured.previous.effort);
    setSpeed(captured.previous.speed);
  };

  const rememberOptimisticRuntime = (
    nextEngine: string,
    selection: { model?: string; effort?: string; speed?: string },
  ) => {
    optimisticRuntimeByOwner.current.set(runtimeOwner, {
      engine: nextEngine,
      model: selection.model ?? "",
      effort: selection.effort ?? "",
      speed: selection.speed ?? "",
    });
  };

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
      writeChatState(
        chatStateKey(
          "runtime",
          commandTargetAgent
            ? `agent.${commandTargetAgent.id}.speed`
            : `conversation.${conversationId}.speed`,
        ),
        next.speed ?? "",
      );
    },
  });
  const agentTitle = useCallback(
    (agentId: string | undefined): string =>
      routingAgents.find(agent => agent.id === agentId)?.title ?? "Deleted Agent",
    [routingAgents],
  );
  const agentHandle = useCallback(
    (agentId: string | undefined): string =>
      routingAgents.find(agent => agent.id === agentId)?.handle ?? "Deleted-Agent",
    [routingAgents],
  );
  const {
    busy,
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
    sendError,
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
      ? routingAgents.find(candidate => candidate.id === agentId && !candidate.archived)
      : undefined;
    return agent && message
      ? {
          agent,
          selectionKey: `${agent.id}:${message.id}`,
        }
      : undefined;
  }, [routingAgents, messages]);
  const mainTranscriptMarkdown = useMemo(
    () =>
      conversation
        ? buildMarkdownTranscript(
            conversation.title,
            messages.map(message => ({
              author: message.authorAgentId
                ? agentTitle(message.authorAgentId)
                : message.role === "system"
                  ? "System"
                  : "You",
              text: resolveMessageMentionText(
                message.text,
                message.agentMentions,
              ),
              createdAt: message.createdAt,
              attachments: message.attachments,
              document: message.document,
            })),
          )
        : "",
    [agentTitle, conversation?.title, messages],
  );
  const collaborationTranscriptMarkdown = useMemo(
    () =>
      conversation
        ? buildMarkdownTranscript(
            `${conversation.title} — Team chat`,
            collaborationMessages.map(message => ({
              author: message.authorAgentId
                ? agentTitle(message.authorAgentId)
                : message.role === "system"
                  ? "System"
                  : "You",
              text: resolveMessageMentionText(
                message.text,
                message.agentMentions,
              ),
              createdAt: message.createdAt,
              attachments: message.attachments,
              document: message.document,
            })),
          )
        : "",
    [agentTitle, collaborationMessages, conversation?.title],
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
      .filter(agent => !agent.archived)
      .map(agent => agent.handle)
      .filter(
        handle =>
          !["broadcast", "user", "everyone"].includes(
            handle.toLocaleLowerCase(),
          ),
      ),
  ];
  const mentionBindings = routingAgents
    .filter(agent => !agent.archived)
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

  const runtimeControls =
    activeView === "main" ? (
      <ComposerRuntimeSelector
        engine={engine}
        engines={engines.map(option => ({
          id: option.id,
          label: option.displayName,
          disabled: !engineIsAvailable(option),
          detail: engineIsAvailable(option)
            ? undefined
            : option.authentication === "authenticated"
              ? "Access unavailable"
              : "Signed out",
        }))}
        model={model}
        models={models}
        effort={effort}
        efforts={efforts}
        speed={selectedRuntime.speed}
        speeds={speeds}
        scopeLabel={commandTargetAgent ? `${commandTargetAgent.title} next Run` : "Chat default"}
        disabled={persistTargetRuntime.isPending || persistDefaults.isPending}
        onEngineChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const nextEngine = engines.find(candidate => candidate.id === next);
          const captured = captureRuntimeMutation();
          const resolved = resolveRuntimeSelection(
            nextEngine,
            preferencesQuery.data,
            project,
          );
          setEngine(next);
          setModel(resolved.model);
          setEffort(resolved.effort);
          setSpeed(resolved.speed ?? "");
          rememberOptimisticRuntime(next, resolved);
          writeChatState(
            chatStateKey(
              "runtime",
              commandTargetAgent
                ? `agent.${commandTargetAgent.id}.speed`
                : `conversation.${conversationId}.speed`,
            ),
            resolved.speed ?? "",
          );
          if (commandTargetAgent) {
            persistTargetRuntime.mutate(
              {
                agentId: commandTargetAgent.id,
                activeEngine: next as EngineDto["id"],
                model: resolved.model || null,
                effort: resolved.effort || null,
                speed: resolved.speed || null,
              },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          } else {
            persistDefaults.mutate(
              {
                defaultEngine: next as EngineDto["id"],
                defaultModel: resolved.model || null,
                defaultEffort: resolved.effort || null,
                defaultSpeed: resolved.speed || null,
              },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          }
        }}
        onModelChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const captured = captureRuntimeMutation();
          const resolved = selectedRuntime.selectModel(next);
          rememberOptimisticRuntime(engine, resolved);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate(
              {
                agentId: commandTargetAgent.id,
                activeEngine: engine as EngineDto["id"],
                model: resolved.model || null,
                effort: resolved.effort || null,
                speed: resolved.speed || null,
              },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          } else {
            persistDefaults.mutate(
              {
                defaultModel: resolved.model,
                defaultEffort: resolved.effort || null,
                defaultSpeed: resolved.speed || null,
              },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          }
        }}
        onEffortChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const captured = captureRuntimeMutation();
          const resolved = selectedRuntime.selectEffort(next);
          rememberOptimisticRuntime(engine, resolved);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate(
              {
                agentId: commandTargetAgent.id,
                activeEngine: engine as EngineDto["id"],
                model: resolved.model || null,
                effort: resolved.effort || null,
                speed: resolved.speed || null,
              },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          } else {
            persistDefaults.mutate(
              { defaultEffort: resolved.effort, defaultSpeed: resolved.speed || null },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          }
        }}
        onSpeedChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const captured = captureRuntimeMutation();
          const resolved = selectedRuntime.selectSpeed(next);
          rememberOptimisticRuntime(engine, resolved);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate(
              {
                agentId: commandTargetAgent.id,
                activeEngine: engine as EngineDto["id"],
                model: resolved.model || null,
                effort: resolved.effort || null,
                speed: resolved.speed || null,
              },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          } else {
            persistDefaults.mutate(
              { defaultSpeed: resolved.speed || null },
              { onError: () => rollbackRuntimeMutation(captured, resolved.speed ?? "") },
            );
          }
        }}
      />
    ) : null;
  return (
    <Box
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
                <AttentionSurface
                  notifications={(notificationsQuery.data?.items ?? []).filter((item) => item.kind !== "decision")}
                  projectId={conversation.projectId}
                  conversationId={conversationId}
                  onOpen={item => {
                    const focusId = notificationTechnicalFocusId(item);
                    if (item.agentId)
                      onOpenAgent(item.agentId, "technical", focusId);
                    else onOpenAgentWork(focusId);
                  }}
                />
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
          <Box id="chat-workspace-files-panel" role="tabpanel" aria-labelledby="chat-workspace-files-tab" sx={{ height: "100%", minHeight: 0, minWidth: 0 }}><ConversationFilesResults
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
          <Box id="chat-workspace-agents-panel" role="tabpanel" aria-labelledby="chat-workspace-agents-tab" sx={{ minHeight: 0, minWidth: 0 }}><AgentsTab
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
              detail: String(membersQuery.data?.pages[0]?.total ?? detailQuery.data?.members?.total ?? conversationAgents.length) + " Agents",
              totalCount: membersQuery.data?.pages[0]?.total ?? detailQuery.data?.members?.total,
              variant: "embedded",
            }}
            collectionFooter={(
              <CollectionPagination
                resourceLabel="Agents"
                request={{
                  hasResolved: Boolean(membersQuery.data),
                  isInitialLoading: membersQuery.isPending,
                  isRefreshing: membersQuery.isFetching && !membersQuery.isFetchingNextPage,
                  isInitialError: !membersQuery.data && membersQuery.isError,
                  isPaginationError: Boolean(membersQuery.data) && membersQuery.isFetchNextPageError,
                  isFetchingNextPage: membersQuery.isFetchingNextPage,
                  hasNextPage: Boolean(membersQuery.hasNextPage),
                  retry: membersQuery.refetch,
                  fetchNextPage: membersQuery.fetchNextPage,
                }}
              />
            )}
          /></Box>
        ) : activeView === "triggers" ? (
          <Box id="chat-workspace-triggers-panel" role="tabpanel" aria-labelledby="chat-workspace-triggers-tab" sx={{ minHeight: 0, minWidth: 0 }}><AllTriggersWorkspace
            projects={project ? [project] : []}
            filterProjectId={conversation.projectId}
            filterConversationId={conversation.id}
            scopeTitle={`${conversation.title} Automations`}
            embedded
            preferences={preferences}
            onPreferences={onPreferences}
            onNavigate={onNavigateTrigger}
            onCreate={() =>
              onCreateTrigger(
                conversationAgents.length === 1
                  ? conversationAgents[0]!.id
                  : undefined,
              )
            }
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
            <MasterRespondingIndicator
              agents={agents}
              healthByAgentId={healthByAgentId}
            />
          </Box>
        ) : null}
      </Box>

      <ChatComposerDock
        visible={!agentWorkOpen && activeView === "main"}
      >
        {activeView === "main" && engineUnavailableMessage ? (
          <Alert severity="warning" sx={{ mx: 1.5, mt: 1 }}>
            {engineUnavailableMessage} Choose a ready provider below, tag an
            existing Agent, or use #broadcast.
          </Alert>
        ) : null}
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
        {sendError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Message not sent. {String(sendError)}
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
          disabled={
            busy ||
            persistTargetRuntime.isPending ||
            persistDefaults.isPending
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
                  return invocation.then(result =>
                    setQueuedMessageNotice(
                      result.message ??
                        `/${command.name} invoked for ${commandTargetAgent.title}.`,
                    ),
                  );
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
            )
          }
          agentResponding={false}
          projectId={conversation.projectId}
          onCancel={stopOperation}
          cancelPending={cancelOperationPending}
        />
      </ChatComposerDock>

      <ConversationDialogs
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
      />

    </Box>
  );
}
