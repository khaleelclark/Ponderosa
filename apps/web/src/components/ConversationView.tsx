import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type {
  AgentHealthDto,
  EngineDto,
  ConversationChannel,
  ConversationDto,
  ConversationMessageDto,
  ProjectDto,
  ProjectEngineCapabilitiesDto,
  ResponseFileActivityDto,
  AgentDto,
  TeamOperationalEventDto,
  ConversationDecisionEventDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { compactDefined } from "../collections";
import { agentBelongsToConversation, type AgentStatus } from "../agents";
import { pickAgentName } from "../parkNames";
import {
  useCollaborationView,
  useConversation,
  useNotifications,
  useProjects,
  useWorkspacePreferences,
} from "../hooks/queries";
import {
  effortSelectionIsCompatible,
  engineIsAvailable,
  modelSelectionIsCompatible,
  resolveConversationEngine,
  resolveRuntimeSelection,
  selectedRunConfig,
} from "../conversationEngine";
import {
  agentIdForMentionHandle,
  agentMentionHandle,
  findMentionedAgents,
  hasBroadcastMention,
  hasEveryoneMention,
} from "../mentions";
import {
  managerBroadcastText,
  uploadFilesForRecipients,
} from "../conversationRouting";
import { chatMessageLayoutKey } from "./chat/ChatMessages";
import { Composer } from "./chat/Composer";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { ChatSurface } from "./chat/ChatSurface";
import { formatExecutionElapsed } from "../time";
import { buildMarkdownTranscript } from "../chatTranscript";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { useMobileComposerAutoHide } from "../mobileChat";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { AttentionSurface } from "./AttentionSurface";
import { queryKeys } from "../queryKeys";
import { ChatLiveBanner } from "./chat/ChatLiveBanner";
import { ConfirmDialog } from "./ConfirmationDialogs";
import { AgentsTab } from "./AgentsTab";
import {
  conversationComposerRuntime,
  decisionChoice,
  groupAdjacentOperationalEvents,
  mergeConversationMessages,
  mergeDecisionEvents,
  mergeOperationalEvents,
  type MainTimelineEntry,
} from "./ConversationView.helpers";
import {
  CollaborationTimeline,
  ConversationHeader,
  MainConversationTimeline,
} from "./ConversationView.parts";
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

function MasterRespondingIndicator({
  agents,
  healthByAgentId,
}: {
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
}): JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const responding = agents.flatMap(agent => {
    const activity = healthByAgentId.get(agent.id)?.runtimeActivity;
    return activity ? [{ agent, activity }] : [];
  });
  if (responding.length === 0) return null;
  const names = responding.map(({ agent }) => agent.title).join(", ");
  const earliest = responding
    .map(({ activity }) => activity.startedAt)
    .sort()[0]!;
  return (
    <ChatLiveBanner>
      {names} {responding.length === 1 ? "is" : "are"} responding ·{" "}
      {formatExecutionElapsed(earliest, now)}
    </ChatLiveBanner>
  );
}
import { chatStateKey } from "../chatState";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { useRuntimeControls } from "../hooks/useRuntimeControls";

export function ConversationView({
  conversationId,
  focusMessageId,
  initialView,
  engines,
  engineCapabilities,
  onRefreshCapabilities,
  statusByAgentId,
  healthByAgentId,
  projectAgents,
  onOpenProject,
  onOpenAgent,
  onOpenAgentInNewTab,
  onOpenReview,
  onOpenAgentWork,
  onOpenBrowser,
  onOpenFileActivity,
  onNewAgent,
  onDeleted,
}: {
  conversationId: string;
  focusMessageId?: string;
  initialView?: ConversationChannel;
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
  onOpenAgent(
    agentId: string,
    view?: "technical",
    technicalFocusId?: string,
  ): void;
  onOpenAgentInNewTab?(agentId: string): void;
  onOpenReview?(agentId: string): void;
  onOpenAgentWork(focusId?: string): void;
  onOpenBrowser(): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onNewAgent(master: ConversationDto, managerAgentId?: string): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useConversationActiveViewState(
    conversationId,
    initialView,
  );
  const detailQuery = useConversation(conversationId);
  // Team Chat is a comparatively expensive operational projection. Keep it
  // dormant while ordinary Chat is visible; React Query fetches the latest page
  // when the user actually switches views.
  const collaborationQuery = useCollaborationView(
    conversationId,
    100,
    activeView === "collaboration",
  );
  const [olderMain, setOlderMain] = useState<{
    messages: ConversationMessageDto[];
    decisionEvents: ConversationDecisionEventDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [olderCollaboration, setOlderCollaboration] = useState<{
    messages: ConversationMessageDto[];
    operations: TeamOperationalEventDto[];
    cursor?: string;
    operationCursor?: string;
    hasMore: boolean;
    operationHasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const queuedMessagesQuery = useQuery({
    queryKey: queryKeys.queuedMessages.conversation(conversationId),
    queryFn: () => api.listQueuedConversationMessages(conversationId),
  });
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
  const [agentWorkFocus, setAgentWorkFocus] = useState<string>();
  const [queuedMessageNotice, setQueuedMessageNotice] = useState<
    string | undefined
  >();
  const [activeOperation, setActiveOperation] = useState<{
    agentIds: string[];
    state: "starting" | "running";
  }>();
  const [stoppedNotice, setStoppedNotice] = useState<string>();
  const [stopConfirmation, setStopConfirmation] = useState<{
    targets: { agentId: string; runId: string }[];
    names: string;
  }>();
  const stopOperationRequestId = useRef<string>();
  const [editingMessage, setEditingMessage] =
    useState<ConversationMessageDto>();
  const [correctionText, setCorrectionText] = useState("");
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{
    id: string;
    text: string;
  }>();
  // The engine/model/effort currently selected for this conversation. Model-agnostic:
  // it can change any time and only affects agents spawned *after* the change —
  // already-running agents keep the model they were spawned with.
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const initializedFor = useRef<string | undefined>(undefined);
  const { focusedMessage, focusedMessageHighlightDisposer } =
    useConversationMessageFocusRefs();
  const theme = useTheme();
  const mobileRoster = useMediaQuery(theme.breakpoints.down("sm"));
  const mobileComposer = useMobileComposerAutoHide(mobileRoster);

  useConversationResetEffect({
    collaborationVisited,
    conversationId,
    focusedMessage,
    initialView,
    mobileComposer,
    setActiveView,
    setOlderCollaboration,
    setOlderMain,
  });
  useConversationMessageFocusCleanup(focusedMessageHighlightDisposer);

  if (activeView === "collaboration") collaborationVisited.current = true;

  useConversationActiveViewPersistence(activeView, conversationId);

  const conversation = detailQuery.data?.conversation;
  const projectBrowser = useQuery({
    queryKey: queryKeys.projectBrowser.project(conversation?.projectId),
    queryFn: () => api.getProjectBrowser(conversation!.projectId),
    enabled: Boolean(conversation?.projectId),
    retry: false,
    staleTime: 5_000,
  });
  // Live query updates can briefly leave sparse entries in cached collections.
  // Compact at the page boundary so historical chats remain renderable.
  const messages = useMemo(
    () =>
      mergeConversationMessages(
        olderMain?.messages ?? [],
        compactDefined(detailQuery.data?.messages ?? []),
      ),
    [detailQuery.data?.messages, olderMain?.messages],
  );
  const agents = useMemo(
    () => compactDefined(detailQuery.data?.agents ?? []),
    [detailQuery.data?.agents],
  );
  const decisionEvents = useMemo(
    () =>
      mergeDecisionEvents(
        olderMain?.decisionEvents ?? [],
        detailQuery.data?.decisionEvents ?? [],
      ),
    [detailQuery.data?.decisionEvents, olderMain?.decisionEvents],
  );
  const mainTimeline = useMemo<MainTimelineEntry[]>(() => {
    const entries: MainTimelineEntry[] = [
      ...messages.map((message) => ({
        kind: "message" as const,
        id: `message:${message.id}`,
        at: message.createdAt,
        message,
      })),
      ...decisionEvents.flatMap((event): MainTimelineEntry[] => {
        if (event.kind === "decision") return [{ kind: "decision", id: event.id, at: event.createdAt, event }];
        const choice = decisionChoice(event.decision);
        return choice ? [{ kind: "decision-response", id: event.id, at: event.createdAt, event, choice }] : [];
      }),
    ];
    return entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  }, [decisionEvents, messages]);
  const conversationAgents = useMemo(
    () =>
      projectAgents.filter(agent =>
        agentBelongsToConversation(agent, conversationId),
      ),
    [conversationId, projectAgents],
  );
  const collaborationMessages = useMemo(
    () =>
      mergeConversationMessages(
        olderCollaboration?.messages ?? [],
        compactDefined(collaborationQuery.data?.messages ?? []),
      ),
    [collaborationQuery.data?.messages, olderCollaboration?.messages],
  );
  const operationalEvents = useMemo(
    () =>
      mergeOperationalEvents(
        olderCollaboration?.operations ?? [],
        compactDefined(collaborationQuery.data?.operations ?? []),
      ),
    [collaborationQuery.data?.operations, olderCollaboration?.operations],
  );
  const operationalEventGroups = useMemo(
    () => groupAdjacentOperationalEvents(operationalEvents),
    [operationalEvents],
  );
  const [expandedOperationalEventGroups, setExpandedOperationalEventGroups] = useState<Set<string>>(() => new Set());
  const messageLayoutKey = mainTimeline.map((entry) => entry.id).join(":");
  const collaborationLayoutKey = chatMessageLayoutKey(collaborationMessages);
  const operationalLayoutKey = operationalEvents.length
    ? `${operationalEvents.length}:${operationalEvents.at(-1)?.id ?? ""}`
    : "0";
  const mainHistory = olderMain ?? {
    messages: [],
    decisionEvents: [],
    cursor: detailQuery.data?.history?.cursor,
    hasMore: detailQuery.data?.history?.hasMore ?? false,
  };
  const collaborationHistory = olderCollaboration ?? {
    messages: [],
    operations: [],
    cursor: collaborationQuery.data?.history?.cursor,
    operationCursor: collaborationQuery.data?.operationHistory?.cursor,
    hasMore: collaborationQuery.data?.history?.hasMore ?? false,
    operationHasMore:
      collaborationQuery.data?.operationHistory?.hasMore ?? false,
  };
  const loadOlderHistory = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      if (activeView === "main") {
        if (!mainHistory.hasMore || !mainHistory.cursor) return;
        const page = await api.getConversation(
          conversationId,
          100,
          mainHistory.cursor,
        );
        setOlderMain(current => ({
          messages: mergeConversationMessages(
            page.messages,
            current?.messages ?? [],
            detailQuery.data?.messages ?? [],
          ),
          decisionEvents: mergeDecisionEvents(
            page.decisionEvents ?? [],
            current?.decisionEvents ?? [],
            detailQuery.data?.decisionEvents ?? [],
          ),
          cursor: page.history?.cursor,
          hasMore: page.history?.hasMore ?? false,
        }));
      } else {
        const loadMessages =
          collaborationHistory.hasMore && Boolean(collaborationHistory.cursor);
        const loadOperations =
          collaborationHistory.operationHasMore &&
          Boolean(collaborationHistory.operationCursor);
        if (!loadMessages && !loadOperations) return;
        const page = await api.getCollaborationView(
          conversationId,
          100,
          loadMessages ? collaborationHistory.cursor : undefined,
          undefined,
          loadOperations ? collaborationHistory.operationCursor : undefined,
        );
        setOlderCollaboration(current => ({
          messages: loadMessages
            ? mergeConversationMessages(
                page.messages,
                current?.messages ?? [],
                collaborationQuery.data?.messages ?? [],
              )
            : (current?.messages ?? []),
          operations: loadOperations
            ? mergeOperationalEvents(
                page.operations ?? [],
                current?.operations ?? [],
                collaborationQuery.data?.operations ?? [],
              )
            : (current?.operations ?? []),
          cursor: loadMessages ? page.history?.cursor : current?.cursor,
          operationCursor: loadOperations
            ? page.operationHistory?.cursor
            : current?.operationCursor,
          hasMore: loadMessages ? (page.history?.hasMore ?? false) : false,
          operationHasMore: loadOperations
            ? (page.operationHistory?.hasMore ?? false)
            : false,
        }));
      }
    } finally {
      setLoadingOlder(false);
    }
  };
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
      },
    );
    initializedFor.current = conversation.id;
    setEngine(resolvedEngine);
    setModel(resolved.model);
    setEffort(resolved.effort);
  }, [conversation, engines, preferencesQuery.data, projectsQuery.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.detailPrefix(conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.all,
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.collaborationPrefix(conversationId),
    });
    if (conversation) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(conversation.projectId),
      });
    }
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
  });

  const spawn = useMutation({
    mutationFn: async ({
      text,
      draftAttachmentIds,
      draftOwnerId,
    }: {
      text: string;
      draftAttachmentIds: string[];
      draftOwnerId?: string;
    }) => {
      if (!conversation) {
        throw new Error("Project chat not loaded");
      }
      // Record the message in the shared pool, spawn a park-named agent on the
      // selected engine, and hand it the message as its first turn.
      const selectedEngine = engines.find(candidate => candidate.id === engine);
      const compatibleModel = modelSelectionIsCompatible(selectedEngine, model)
        ? model
        : "";
      const compatibleEffort = effortSelectionIsCompatible(
        selectedEngine,
        compatibleModel,
        effort,
      )
        ? effort
        : "";
      const runConfig = selectedRunConfig(compatibleModel, compatibleEffort);
      setActiveOperation({ agentIds: [], state: "starting" });
      const agent = await api.createAgent(
        conversation.projectId,
        conversationId,
        {
          title: pickAgentName(
            (detailQuery.data?.agents ?? []).map(agent => agent.title),
          ),
          engine,
          ...runConfig,
          initialMessage: text,
          draftAttachmentIds,
          draftOwnerId,
        },
      );
      setActiveOperation({ agentIds: [agent.id], state: "starting" });
      return agent;
    },
    onSuccess: () => {
      invalidate();
    },
  });

  // Persist one canonical user message, then let the server fan it out to the
  // explicitly tagged agents as stable-ID direct deliveries.
  const sendToAgents = useMutation({
    mutationFn: async ({
      agentIds,
      text,
      files,
      requestId,
      activeRunDelivery,
    }: {
      agentIds: string[];
      text: string;
      files: File[];
      requestId: string;
      activeRunDelivery: "steer" | "queue";
    }) => {
      const recipients = await uploadFilesForRecipients(
        agentIds,
        files,
        (agentId, file) => api.uploadAttachment(agentId, file),
        (agentId, item) => api.deleteAttachment(agentId, item.id),
      );
      return api.sendMultiAgentDirectMessage(conversationId, {
        text,
        recipients: recipients.map(({ agentId, attachments }) => ({
          agentId,
          attachmentIds: attachments.map(item => item.id),
        })),
        idempotencyKey: requestId,
        activeRunDelivery,
      });
    },
    onSuccess: (response, variables) => {
      invalidate();
      const queuedTitles = response.recipients
        .filter(recipient => recipient.queued)
        .map(
          recipient =>
            detailQuery.data?.agents.find(
              agent => agent.id === recipient.agentId,
            )?.title ?? "Agent",
        );
      setQueuedMessageNotice(
        queuedTitles.length > 0
          ? variables.activeRunDelivery === "queue"
            ? `Queued for ${queuedTitles.join(", ")}; it will start when the current response finishes.`
            : undefined
          : undefined,
      );
      const activeIds = response.recipients
        .filter(recipient => !recipient.queued)
        .map(recipient => recipient.agentId);
      if (activeIds.length === 0) setActiveOperation(undefined);
      else setActiveOperation({ agentIds: activeIds, state: "starting" });
      for (const agentId of variables.agentIds) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detailPrefix(agentId),
        });
      }
    },
  });

  const broadcast = useMutation({
    mutationFn: async ({
      text,
      files,
      requestId,
      agentIds,
      activeRunDelivery,
    }: {
      text: string;
      files: File[];
      requestId: string;
      agentIds: string[];
      activeRunDelivery: "steer" | "queue";
    }) => {
      const owner = agents.find(agent => !agent.archived);
      if (files.length && !owner)
        throw new Error(
          "Create an agent before attaching files to shared project context.",
        );
      const uploadAgentIds = [
        ...new Set([
          ...(owner ? [owner.id] : []),
          ...agentIds,
        ]),
      ];
      const uploadedRecipients = await uploadFilesForRecipients(
        uploadAgentIds,
        files,
        (agentId, file) => api.uploadAttachment(agentId, file),
        (agentId, item) => api.deleteAttachment(agentId, item.id),
      );
      const attachmentsByAgent = new Map(
        uploadedRecipients.map(recipient => [
          recipient.agentId,
          recipient.attachments,
        ]),
      );
      const attachments = owner
        ? (attachmentsByAgent.get(owner.id) ?? [])
        : [];
      try {
        return await api.sendConversationMessage(conversationId, {
          text,
          attachments,
          recipientAgentIds: agentIds,
          recipientAttachments: agentIds.map(agentId => ({
            agentId,
            attachmentIds: (attachmentsByAgent.get(agentId) ?? []).map(
              item => item.id,
            ),
          })),
          activeRunDelivery,
          idempotencyKey: requestId,
        });
      } catch (error) {
        await Promise.allSettled(
          uploadedRecipients.flatMap(recipient =>
            recipient.attachments.map(item =>
              api.deleteAttachment(recipient.agentId, item.id),
            ),
          ),
        );
        throw error;
      }
    },
    onSuccess: () => {
      invalidate();
    },
  });

  const cancelQueued = useMutation({
    mutationFn: (deliveryId: string) =>
      api.cancelQueuedConversationMessage(conversationId, deliveryId, {
        idempotencyKey: `cancel:${deliveryId}`,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.conversation(conversationId),
      });
    },
  });
  const editQueued = useMutation({
    mutationFn: ({
      deliveryId,
      targetAgentId,
      text,
    }: {
      deliveryId: string;
      targetAgentId: string;
      text: string;
    }) =>
      api.editQueuedAgentMessage(targetAgentId, deliveryId, {
        text,
        idempotencyKey: createClientId(),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.conversation(conversationId),
      }),
  });
  const steerQueued = useMutation({
    mutationFn: ({
      deliveryId,
      targetAgentId,
    }: {
      deliveryId: string;
      targetAgentId: string;
    }) =>
      api.steerQueuedAgentMessage(targetAgentId, deliveryId, {
        idempotencyKey: createClientId(),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.conversation(conversationId),
      }),
  });
  const correctMessage = useMutation({
    mutationFn: (message: ConversationMessageDto) =>
      api.correctConversationMessage(conversationId, message.id, {
        text: correctionText.trim(),
        idempotencyKey: createClientId(),
        activeRunDelivery: "queue",
      }),
    onSuccess: () => {
      setEditingMessage(undefined);
      setCorrectionText("");
      invalidate();
    },
  });

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

  const busy = spawn.isPending || sendToAgents.isPending || broadcast.isPending;

  useEffect(() => {
    if (!activeOperation || activeOperation.agentIds.length === 0) return;
    const anyRunning = activeOperation.agentIds.some(
      agentId => statusByAgentId.get(agentId) === "running",
    );
    if (anyRunning && activeOperation.state !== "running") {
      setActiveOperation({ ...activeOperation, state: "running" });
    } else if (!busy && activeOperation.state === "running" && !anyRunning) {
      setActiveOperation(undefined);
    }
  }, [activeOperation, busy, statusByAgentId]);

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
    selection: { model, effort },
    onChange: next => {
      setModel(next.model);
      setEffort(next.effort);
    },
  });
  const agentTitle = useCallback(
    (agentId: string | undefined): string =>
      agents.find(agent => agent.id === agentId)?.title ?? "Agent",
    [agents],
  );
  const agentIdForHandle = useCallback(
    (handle: string): string | undefined =>
      agentIdForMentionHandle(agents, handle),
    [agents],
  );
  const mentionAgent = useCallback(
    (agentId: string) => {
      setMentionInsertRequest({
        id: String(Date.now()),
        text: `#${agentMentionHandle(agentTitle(agentId))} `,
      });
    },
    [agentTitle],
  );
  const lastRespondingAgent = useMemo(() => {
    const message = [...messages].reverse().find(candidate => Boolean(candidate.authorAgentId));
    return message?.authorAgentId ? agents.find(agent => agent.id === message.authorAgentId) : undefined;
  }, [agents, messages]);
  const editConversationMessage = useCallback(
    (selected: ConversationMessageDto) => {
      setEditingMessage(selected);
      setCorrectionText(selected.text);
    },
    [],
  );
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
              text: message.text,
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
              text: message.text,
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
  const commands = composerRuntime.commands;
  const composerCommands = commands;
  const models = selectedRuntime.models;
  const efforts = selectedRuntime.efforts;
  const engineReady = selectedRuntime.ready;

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
      .map(agent => agentMentionHandle(agent.title))
      .filter(
        handle =>
          !["broadcast", "user", "everyone"].includes(
            handle.toLocaleLowerCase(),
          ),
      ),
  ];
  const findMentioned = (text: string): AgentDto[] =>
    findMentionedAgents(text, agents);

  const busyMentionHandles = agents
    .filter(agent => statusByAgentId.get(agent.id) === "running")
    .map(agent => agentMentionHandle(agent.title));

  const operationRunning = Boolean(
    activeOperation && (busy || activeOperation.state === "running"),
  );
  const cancelOperationTargets = async (
    targets: { agentId: string; runId: string }[],
    names: string,
  ) => {
    setStoppedNotice(`Stopping ${names}. Partial output will remain visible.`);
    const requestId = stopOperationRequestId.current ?? createClientId();
    stopOperationRequestId.current = requestId;
    await Promise.allSettled(
      targets.map(({ agentId, runId }) =>
        api.cancelRun(agentId, {
          targetRunId: runId,
          idempotencyKey: `${requestId}:${runId}`,
        }),
      ),
    );
    stopOperationRequestId.current = undefined;
    setStopConfirmation(undefined);
    setStoppedNotice(`Stopped ${names}. Partial output remains visible.`);
    invalidate();
  };
  const stopOperation = async () => {
    const targets = (activeOperation?.agentIds ?? []).flatMap(agentId => {
      const runId = healthByAgentId.get(agentId)?.runtimeActivity?.executionId;
      return runId ? [{ agentId, runId }] : [];
    });
    if (targets.length === 0) return;
    const names = targets.map(({ agentId }) => agentTitle(agentId)).join(", ");
    if (targets.length > 1) {
      setStopConfirmation({ targets, names });
      return;
    }
    await cancelOperationTargets(targets, names);
  };

  const submit = async (
    text: string,
    files: File[],
    activeRunDelivery: "steer" | "queue" = "steer",
    draftAttachmentIds: string[] = [],
    draftOwnerId?: string,
  ) => {
    const broadcastMentioned = hasBroadcastMention(text);
    const broadcastText = managerBroadcastText(text);
    const everyoneMentioned = hasEveryoneMention(text);
    const explicitlyMentionedAgents = findMentioned(text);
    const targets = everyoneMentioned
      ? agents.filter(agent => !agent.archived)
      : explicitlyMentionedAgents;
    if (broadcastText !== undefined) {
      if (!broadcastText && files.length === 0)
        throw new Error(
          "Add informational context or an attachment after #broadcast.",
        );
      await broadcast.mutateAsync({
        text: broadcastText,
        files,
        requestId: createClientId(),
        agentIds: targets.map(target => target.id),
        activeRunDelivery,
      });
      return;
    }
    if (broadcastMentioned)
      throw new Error("Broadcast scope could not be resolved.");
    if (everyoneMentioned && targets.length === 0)
      throw new Error("There are no active agents to notify.");
    if (targets.length > 0) {
      setActiveOperation({
        agentIds: targets.map(target => target.id),
        state: "starting",
      });
      await sendToAgents.mutateAsync({
        agentIds: targets.map(target => target.id),
        text,
        files,
        requestId: createClientId(),
        activeRunDelivery,
      });
    } else {
      setActiveOperation({ agentIds: [], state: "starting" });
      await spawn.mutateAsync({ text, draftAttachmentIds, draftOwnerId });
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
          detail: engineIsAvailable(option)
            ? undefined
            : option.authenticated
              ? "Access unavailable"
              : "Signed out",
        }))}
        model={model}
        models={models}
        effort={effort}
        efforts={efforts}
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
          persistDefaults.mutate({
            defaultEngine: next as EngineDto["id"],
            defaultModel: resolved.model || null,
            defaultEffort: resolved.effort || null,
          });
        }}
        onModelChange={next => {
          const resolved = selectedRuntime.selectModel(next);
          persistDefaults.mutate({
            defaultModel: resolved.model,
            defaultEffort: resolved.effort || null,
          });
        }}
        onEffortChange={next => {
          const resolved = selectedRuntime.selectEffort(next);
          persistDefaults.mutate({ defaultEffort: resolved.effort });
        }}
      />
    ) : null;

  return (
    <Box
      data-testid="conversation"
      data-conversation-id={conversationId}
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
        setAgentWorkOpen={setAgentWorkOpen}
        setRenameValue={setRenameValue}
        setRenameOpen={setRenameOpen}
        onNewAgent={onNewAgent}
        setImportOpen={setImportOpen}
        setDeleteOpen={setDeleteOpen}
        setActiveView={setActiveView}
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
            layoutKey={`main:${messageLayoutKey}`}
            label="Project chat messages"
            follow={{
              kind: "latest",
              storageKey: chatStateKey(
                "scroll",
                `conversation.${conversationId}.main`,
              ),
              onPositionChange: mobileComposer.observeScroll,
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
                  notifications={(notificationsQuery.data ?? []).filter((item) => item.kind !== "decision")}
                  projectId={conversation.projectId}
                  conversationId={conversationId}
                  conversationAgentIds={agents.map(agent => agent.id)}
                  onOpen={item => {
                    const focusId = notificationTechnicalFocusId(item);
                    if (item.agentId)
                      onOpenAgent(item.agentId, "technical", focusId);
                    else onOpenAgentWork(focusId);
                  }}
                />
                {!engineReady ? (
                  <Alert severity="warning" sx={{ mb: 1.5 }}>
                    {activeEngine?.displayName ?? "The selected engine"} is not
                    signed in. Sign in on the host, or pick a signed-in engine,
                    before spawning agents.
                  </Alert>
                ) : null}
                {projectBrowser.data?.status === "ready" ? (
                  <Alert
                    severity="info"
                    action={
                      <Button
                        color="inherit"
                        size="small"
                        onClick={onOpenBrowser}
                      >
                        Open Tab
                      </Button>
                    }
                    sx={{ mb: 1.5 }}
                  >
                    Interactive Browser is active
                    {projectBrowser.data.title
                      ? ` · ${projectBrowser.data.title}`
                      : ""}
                    .
                  </Alert>
                ) : null}
              </>
            }
          >
            <MainConversationTimeline
              mainTimeline={mainTimeline}
              operatorProfile={preferencesQuery.data?.profile}
              projectId={conversation.projectId}
              healthByAgentId={healthByAgentId}
              agentTitle={agentTitle}
              agentIdForHandle={agentIdForHandle}
              onOpenAgent={onOpenAgent}
              onOpenReview={onOpenReview}
              onOpenFileActivity={onOpenFileActivity}
              mentionAgent={mentionAgent}
              markCommunicationVisible={markCommunicationVisible}
              editConversationMessage={editConversationMessage}
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
                onPositionChange: mobileComposer.observeScroll,
              }}
              history={{
                kind: "cursor",
                hasEarlier:
                  collaborationHistory.hasMore ||
                  collaborationHistory.operationHasMore,
                loading: loadingOlder,
                onLoadEarlier: () => void loadOlderHistory(),
              }}
              beforeMessages={
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  Team chat is a read-only audit trail of agent-to-agent
                  coordination. Message an agent from its Agent chat;
                  collaboration will appear here automatically.
                </Alert>
              }
            >
              <CollaborationTimeline
                operationalEventGroups={operationalEventGroups}
                expandedOperationalEventGroups={expandedOperationalEventGroups}
                setExpandedOperationalEventGroups={setExpandedOperationalEventGroups}
                operationalEvents={operationalEvents}
                collaborationMessages={collaborationMessages}
                onOpenAgentWork={onOpenAgentWork}
                projectId={conversation.projectId}
                healthByAgentId={healthByAgentId}
                operatorProfile={preferencesQuery.data?.profile}
                agentTitle={agentTitle}
                agentIdForHandle={agentIdForHandle}
                onOpenAgent={onOpenAgent}
                onOpenReview={onOpenReview}
                onOpenFileActivity={onOpenFileActivity}
              />
            </ChatSurface>
          </Box>
        ) : null}

        {agentWorkOpen ? (
          <AgentWorkInspector
            open
            projectId={conversation.projectId}
            conversationId={conversationId}
            focus={agentWorkFocus ? { id: agentWorkFocus } : undefined}
            onClose={() => setAgentWorkOpen(false)}
          />
        ) : activeView === "agents" ? (
          <AgentsTab
            agents={conversationAgents}
            projectId={conversation.projectId}
            engines={engines}
            conversations={[conversation]}
            statusByAgentId={statusByAgentId}
            healthByAgentId={healthByAgentId}
            onOpenAgent={agentId => onOpenAgent(agentId)}
            onOpenAgentInNewTab={onOpenAgentInNewTab}
            onNewAgent={managerAgentId =>
              onNewAgent(conversation, managerAgentId)
            }
            collection={{
              title: `${conversation.title} Agents`,
              detail: `${conversationAgents.length} ${conversationAgents.length === 1 ? "Agent" : "Agents"}`,
              variant: "embedded",
            }}
          />
        ) : null}
      </Box>

      <Box
        className="mobile-chat-chrome mobile-chat-composer"
        data-mobile-composer-hidden={
          agentWorkOpen || mobileComposer.hidden ? "true" : "false"
        }
        onTransitionEnd={event => {
          if (
            event.currentTarget !== event.target ||
            event.propertyName !== "max-height"
          )
            return;
          mobileComposer.finishTransition();
        }}
        sx={{ bgcolor: "transparent" }}
      >
        {activeView === "main" && queuedMessageNotice ? (
          <Alert severity="info" sx={{ mx: 1.5, mt: 1 }}>
            {queuedMessageNotice}
          </Alert>
        ) : null}
        {activeView === "main" && stoppedNotice ? (
          <Alert severity="warning" role="status" sx={{ mx: 1.5, mt: 1 }}>
            {stoppedNotice}
          </Alert>
        ) : null}
        {spawn.isError || sendToAgents.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Message not sent.{" "}
            {String((spawn.error ?? sendToAgents.error) as Error)}
          </Alert>
        ) : null}
        {activeView === "main" ? (
          <Box sx={{ mx: 1.5, mt: 1 }}>
            <MasterRespondingIndicator
              agents={agents}
              healthByAgentId={healthByAgentId}
            />
          </Box>
        ) : null}
        {activeView === "main" ? (
          <QueuedMessageTray
            messages={queuedMessagesQuery.data ?? []}
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
        {activeView === "main" ? (
          <Composer
            draftStorageKey={chatStateKey(
              "draft",
              `conversation.${conversationId}.${activeView}`,
            )}
            conversationDraftId={conversationId}
            destinationMode="project-chat"
            continueWith={lastRespondingAgent ? { handle: agentMentionHandle(lastRespondingAgent.title), title: lastRespondingAgent.title } : undefined}
            destinationTitleForHandle={handle => agents.find(agent =>
              agentMentionHandle(agent.title).toLocaleLowerCase() === handle.toLocaleLowerCase())?.title}
            insertTextRequest={mentionInsertRequest}
            controls={runtimeControls}
            disabled={busy}
            running={operationRunning}
            allowSendWhileRunning
            mentionHandles={mentionHandles}
            commands={composerCommands}
            capabilities={composerRuntime.capabilities}
            onCapabilitiesOpen={() =>
              onRefreshCapabilities({ engineId: activeEngine?.id, model })
            }
            onCommand={
              activeEngine
                ? (command, argumentsText) => {
                    const invocation = api.invokeProjectProviderCommand(
                      conversation.projectId,
                      {
                        engineId: activeEngine.id,
                        ...(model ? { model } : {}),
                        ...(effort ? { effort } : {}),
                        name: command.name,
                        ...(argumentsText ? { argumentsText } : {}),
                      },
                    );
                    return invocation.then(result =>
                      setQueuedMessageNotice(
                        result.message ??
                          `/${command.name} invoked for ${activeEngine.displayName}.`,
                      ),
                    );
                  }
                : undefined
            }
            busyMentionHandles={busyMentionHandles}
            allowUnmentionedSend={engineReady}
            placeholder={
              engineReady
                ? "Send a message"
                : "#tag an agent or use #broadcast for shared context"
            }
            onSend={(text, files, stagedIds, draftOwnerId) =>
              submit(text, files, "steer", stagedIds, draftOwnerId)
            }
            onQueue={(text, files, stagedIds, draftOwnerId) =>
              submit(text, files, "queue", stagedIds, draftOwnerId)
            }
            preferQueue={false}
            queuedMentionHandles={(queuedMessagesQuery.data ?? []).flatMap(
              message => {
                const agent = agents.find(
                  candidate => candidate.id === message.targetAgentId,
                );
                return agent ? [agentMentionHandle(agent.title)] : [];
              },
            )}
            agentResponding={false}
            projectId={conversation.projectId}
            onCancel={stopOperation}
          />
        ) : null}
      </Box>

      <ImportAgentDialog
        open={importOpen}
        projectId={conversation.projectId}
        engines={engines}
        conversations={[conversation]}
        initialConversationId={conversation.id}
        onClose={() => setImportOpen(false)}
        onImported={onOpenAgent}
      />

      <ConfirmDialog
        open={Boolean(stopConfirmation)}
        title="Stop Operation Tree?"
        confirmLabel="Stop Operation"
        onCancel={() => setStopConfirmation(undefined)}
        onConfirm={() => {
          if (stopConfirmation)
            void cancelOperationTargets(
              stopConfirmation.targets,
              stopConfirmation.names,
            );
        }}
      >
        <Typography sx={{ pt: 1 }}>
          Stop work for {stopConfirmation?.names}? Partial output from every
          affected Agent will remain visible.
        </Typography>
      </ConfirmDialog>

      <Dialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Rename Project chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Project chat name"
            value={renameValue}
            onChange={event => setRenameValue(event.target.value)}
            sx={{ mt: 1 }}
          />
          {rename.isError ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {String(rename.error)}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!renameValue.trim() || rename.isPending}
            onClick={() => rename.mutate(renameValue.trim())}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(editingMessage)}
        onClose={() =>
          !correctMessage.isPending && setEditingMessage(undefined)
        }
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Edit Message</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            The original remains in append-only history. Broadcast edits update
            the shared note; edits to a delivered request queue a correction to
            its original recipient.
          </Alert>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Message"
            value={correctionText}
            onChange={event => setCorrectionText(event.target.value)}
          />
          {correctMessage.isError ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {String(correctMessage.error)}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setEditingMessage(undefined)}
            disabled={correctMessage.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!correctionText.trim() || correctMessage.isPending}
            onClick={() =>
              editingMessage && correctMessage.mutate(editingMessage)
            }
          >
            Save Edit
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          if (!deleteConversation.isPending) setDeleteOpen(false);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete Project chat?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently deletes{" "}
            <Box component="strong">{conversation.title}</Box> and its chat
            history. Its agents are preserved in the Agents tab as unassigned
            agents. This cannot be undone.
          </Typography>
          {deleteConversation.isError ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {String(deleteConversation.error)}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeleteOpen(false)}
            disabled={deleteConversation.isPending}
          >
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteConversation.isPending}
            onClick={() => deleteConversation.mutate()}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
