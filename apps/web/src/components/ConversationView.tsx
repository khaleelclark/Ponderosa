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

import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { useRuntimeControls } from "../hooks/useRuntimeControls";

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
  onOpenReview?(agentId: string): void;
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
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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
  // Project Chat default used for newly spawned Agents.
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState("");
  const initializedFor = useRef<string | undefined>(undefined);
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
  const projectAgentsQuery = useAgents(conversation?.projectId);
  const routingAgents = projectAgentsQuery.data ?? agents;
  const activeBrowsers = useQuery({
    queryKey: queryKeys.agentBrowsers.conversation(conversation?.projectId, conversationId),
    queryFn: () => api.listActiveBrowserSessions(conversation!.projectId, conversationId),
    enabled: Boolean(conversation?.projectId),
    retry: false,
    refetchInterval: 2_500,
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
  useEffect(() => {
    if (!conversation || initializedFor.current === conversation.id) {
      return;
    }
    if (!preferencesQuery.data || !projectsQuery.data) return;
    const project = projectsQuery.data.find(
      candidate => candidate.id === conversation.projectId,
    );
    const resolvedEngine = resolveConversationEngine(
      conversation.defaultEngine ?? project?.defaultEngine,
      engines,
    );
    if (!resolvedEngine) return;
    const selectedEngine = engines.find(
      candidate => candidate.id === resolvedEngine,
    );
    const resolved = resolveRuntimeSelection(
      selectedEngine,
      preferencesQuery.data,
      project,
      {
        model: conversation.defaultModel,
        effort: conversation.defaultEffort,
        speed: readChatState(
          chatStateKey("runtime", `conversation.${conversation.id}.speed`),
        ),
      },
    );
    initializedFor.current = conversation.id;
    setEngine(resolvedEngine);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed ?? "");
  }, [conversation, engines, preferencesQuery.data, projectsQuery.data]);

  const applyPersistedRuntime = (source: {
    engine?: EngineDto["id"];
    model?: string | null;
    effort?: string | null;
    speedKey: string;
  }): void => {
    if (!conversation || !preferencesQuery.data || !projectsQuery.data) return;
    const currentProject = projectsQuery.data.find(
      candidate => candidate.id === conversation.projectId,
    );
    const restoredEngine = resolveConversationEngine(source.engine, engines);
    const restoredAdapter = engines.find(candidate => candidate.id === restoredEngine);
    if (!restoredEngine || !restoredAdapter) return;
    const restored = resolveRuntimeSelection(
      restoredAdapter,
      preferencesQuery.data,
      currentProject,
      {
        model: source.model ?? undefined,
        effort: source.effort ?? undefined,
        speed: readChatState(chatStateKey("runtime", source.speedKey)),
      },
    );
    setEngine(restoredEngine);
    setModel(restored.model);
    setEffort(restored.effort);
    setSpeed(restored.speed ?? "");
  };

  // Persist the selection so "the model selected for this conversation" survives
  // reloads and prefills the New Agent dialog.
  const persistDefaults = useMutation({
    mutationFn: (patch: {
      defaultEngine?: EngineDto["id"];
      defaultModel?: string | null;
      defaultEffort?: string | null;
    }) => api.updateConversation(conversationId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.detailPrefix(conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all,
      });
    },
    onError: () => {
      if (!conversation) return;
      const currentProject = projectsQuery.data?.find(
        candidate => candidate.id === conversation.projectId,
      );
      applyPersistedRuntime({
        engine: conversation.defaultEngine ?? currentProject?.defaultEngine,
        model: conversation.defaultModel,
        effort: conversation.defaultEffort,
        speedKey: `conversation.${conversation.id}.speed`,
      });
    },
  });

  const persistTargetRuntime = useMutation({
    mutationFn: ({
      agentId,
      activeEngine,
      model,
      effort,
    }: {
      agentId: string;
      activeEngine: EngineDto["id"];
      model: string | null;
      effort: string | null;
    }) => api.updateAgent(agentId, { activeEngine, model, effort }),
    onSuccess: updated => {
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
    onError: (_error, variables) => {
      const persisted = agents.find(agent => agent.id === variables.agentId)
        ?? detailQuery.data?.agents.find(agent => agent.id === variables.agentId);
      if (!persisted) return;
      applyPersistedRuntime({
        engine: persisted.activeEngine,
        model: persisted.model,
        effort: persisted.effort,
        speedKey: `agent.${persisted.id}.speed`,
      });
    },
  });

  const runtimeTargetAgentId = commandTargetAgent?.id;
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
          speedKey: `agent.${commandTargetAgent.id}.speed`,
        }
      : {
          engine: conversation.defaultEngine ?? project?.defaultEngine,
          model: conversation.defaultModel,
          effort: conversation.defaultEffort,
          speedKey: `conversation.${conversation.id}.speed`,
        };
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
        speed: readChatState(chatStateKey("runtime", source.speedKey)),
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
    conversation?.id,
    conversation?.projectId,
    commandTargetAgent?.activeEngine,
    commandTargetAgent?.effort,
    commandTargetAgent?.model,
    engines,
    preferencesQuery.data,
    projectsQuery.data,
    runtimeTargetAgentId,
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
    const hasAgentMessage = messages.some(
      message => message.role === "assistant",
    );
    if (!hasOperatorMessage || !hasAgentMessage) return;
    titleGenerationRequested.current = conversationId;
    generateTitle.mutate();
  }, [conversation?.title, conversationId, generateTitle, messages]);

  const deleteConversation = useMutation({
    mutationFn: () => api.deleteConversation(conversationId),
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
    statusByAgentId,
    healthByAgentId,
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
      ? agents.find(candidate => candidate.id === agentId && !candidate.archived)
      : undefined;
    return agent && message
      ? {
          agent,
          selectionKey: `${agent.id}:${message.id}`,
        }
      : undefined;
  }, [agents, messages]);
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

  if (detailQuery.isError) {
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
          This Project chat could not be loaded. Check the server connection and
          try again.
        </Alert>
      </Box>
    );
  }

  if (!detailQuery.data || !conversation) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Project chat not found.</Alert>
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
    ...agents
      .filter(agent => !agent.archived)
      .map(agent => agent.handle)
      .filter(
        handle =>
          !["broadcast", "user", "everyone"].includes(
            handle.toLocaleLowerCase(),
          ),
      ),
  ];
  const mentionBindings = agents
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
        disabled={persistTargetRuntime.isPending || persistDefaults.isPending}
        onEngineChange={next => {
          const nextEngine = engines.find(candidate => candidate.id === next);
          const resolved = resolveRuntimeSelection(
            nextEngine,
            preferencesQuery.data,
            project,
          );
          setEngine(next);
          setModel(resolved.model);
          setEffort(resolved.effort);
          setSpeed(resolved.speed ?? "");
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
            persistTargetRuntime.mutate({
              agentId: commandTargetAgent.id,
              activeEngine: next as EngineDto["id"],
              model: resolved.model || null,
              effort: resolved.effort || null,
            });
          } else {
            persistDefaults.mutate({
              defaultEngine: next as EngineDto["id"],
              defaultModel: resolved.model || null,
              defaultEffort: resolved.effort || null,
            });
          }
        }}
        onModelChange={next => {
          const resolved = selectedRuntime.selectModel(next);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate({
              agentId: commandTargetAgent.id,
              activeEngine: engine as EngineDto["id"],
              model: resolved.model || null,
              effort: resolved.effort || null,
            });
          } else {
            persistDefaults.mutate({
              defaultModel: resolved.model,
              defaultEffort: resolved.effort || null,
            });
          }
        }}
        onEffortChange={next => {
          const resolved = selectedRuntime.selectEffort(next);
          if (commandTargetAgent) {
            persistTargetRuntime.mutate({
              agentId: commandTargetAgent.id,
              activeEngine: engine as EngineDto["id"],
              model: resolved.model || null,
              effort: resolved.effort || null,
            });
          } else {
            persistDefaults.mutate({ defaultEffort: resolved.effort });
          }
        }}
        onSpeedChange={next => {
          selectedRuntime.selectSpeed(next);
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
        gridTemplateRows: "auto minmax(0, 1fr) auto",
      }}
    >
      <ConversationHeader
        activeView={activeView}
        agentWorkOpen={agentWorkOpen}
        conversation={conversation}
        projectLabel={project?.label}
        transcriptMarkdown={transcriptMarkdown}
        transcriptTitle={transcriptTitle}
        onOpenProject={onOpenProject}
        onOpenProjectBrowser={onOpenProjectBrowser}
        setAgentWorkOpen={setAgentWorkOpen}
        setRenameValue={setRenameValue}
        setRenameOpen={setRenameOpen}
        onNewAgent={onNewAgent}
        setImportOpen={setImportOpen}
        setDeleteOpen={setDeleteOpen}
        setActiveView={next => {
          setActiveView(next);
          onViewChange?.(next);
        }}
      />

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
          role="tabpanel"
          aria-label="Project chat messages"
          tabIndex={!agentWorkOpen && activeView === "main" ? 0 : -1}
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
            label="Project chat messages"
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
            role="tabpanel"
            aria-label="Team chat messages"
            tabIndex={!agentWorkOpen && activeView === "collaboration" ? 0 : -1}
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
          <ConversationFilesResults
            projectId={conversation.projectId}
            projectRoot={
              projectsQuery.data?.find(
                project => project.id === conversation.projectId,
              )?.hostPath ?? ""
            }
            conversationId={conversation.id}
            agents={conversationAgents}
          />
        ) : activeView === "agents" ? (
          <AgentsTab
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
          />
        ) : activeView === "triggers" ? (
          <AllTriggersWorkspace
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
          />
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
          mentionHandles={mentionHandles}
          mentionBindings={mentionBindings}
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
        importOpen={importOpen}
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
        onImportClose={() => setImportOpen(false)}
        onStopCancel={() => {
          if (!cancelOperationPending) setStopConfirmation(undefined);
        }}
        onStopConfirm={targets => void cancelOperationTargets(targets)}
        onRenameClose={() => setRenameOpen(false)}
        onRenameValueChange={setRenameValue}
        onRename={() => rename.mutate(renameValue.trim())}
        onDeleteClose={() => setDeleteOpen(false)}
        onDelete={() => deleteConversation.mutate()}
      />

    </Box>
  );
}
