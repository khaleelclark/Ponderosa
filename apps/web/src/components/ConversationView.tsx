import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
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
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { agentBelongsToConversation, type AgentStatus } from "../agents";
import {
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
  agentMentionHandle,
  findMentionedAgents,
} from "../mentions";
import { Composer } from "./chat/Composer";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { ChatSurface } from "./chat/ChatSurface";
import { buildMarkdownTranscript } from "../chatTranscript";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { useMobileComposerAutoHide } from "../mobileChat";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { AttentionSurface } from "./AttentionSurface";
import { queryKeys } from "../queryKeys";
import { AgentsTab } from "./AgentsTab";
import { conversationComposerRuntime } from "./ConversationView.helpers";
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
  const {
    agents,
    collaborationHistory,
    collaborationLayoutKey,
    collaborationMessages,
    collaborationQuery,
    detailQuery,
    expandedOperationalEventGroups,
    loadOlderHistory,
    loadingOlder,
    mainHistory,
    mainTimeline,
    messageLayoutKey,
    messages,
    operationalEventGroups,
    operationalEvents,
    operationalLayoutKey,
    setExpandedOperationalEventGroups,
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
  const [agentWorkFocus, setAgentWorkFocus] = useState<string>();
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
  const conversationAgents = useMemo(
    () =>
      projectAgents.filter(agent =>
        agentBelongsToConversation(agent, conversationId),
      ),
    [conversationId, projectAgents],
  );
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
  const {
    busy,
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
    stoppedNotice,
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
    statusByAgentId,
    healthByAgentId,
    agentTitle,
  });
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
  const lastRespondingAgentIsRunning =
    Boolean(lastRespondingAgent) &&
    Boolean(healthByAgentId.get(lastRespondingAgent!.id)?.runtimeActivity);
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
        {sendError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Message not sent. {String(sendError)}
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
            continueWith={lastRespondingAgent ? {
              agentId: lastRespondingAgent.id,
              handle: agentMentionHandle(lastRespondingAgent.title),
              title: lastRespondingAgent.title,
              responding: lastRespondingAgentIsRunning,
            } : undefined}
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
                ? "Write a message · # targets Agents · #broadcast shares · @ references files"
                : "Choose an available Agent with #, or use #broadcast"
            }
            onSend={(text, files, stagedIds, draftOwnerId, context) =>
              submit(
                text,
                files,
                "steer",
                stagedIds,
                draftOwnerId,
                context?.implicitRecipientId,
              )
            }
            onQueue={(text, files, stagedIds, draftOwnerId, context) =>
              submit(
                text,
                files,
                "queue",
                stagedIds,
                draftOwnerId,
                context?.implicitRecipientId,
              )
            }
            agentResponding={false}
            projectId={conversation.projectId}
            onCancel={stopOperation}
          />
        ) : null}
      </Box>

      <ConversationDialogs
        conversation={conversation}
        engines={engines}
        importOpen={importOpen}
        stopConfirmation={stopConfirmation}
        renameOpen={renameOpen}
        renameValue={renameValue}
        renamePending={rename.isPending}
        renameError={rename.isError ? String(rename.error) : undefined}
        editingMessage={editingMessage}
        correctionText={correctionText}
        correctionPending={correctMessage.isPending}
        correctionError={
          correctMessage.isError ? String(correctMessage.error) : undefined
        }
        deleteOpen={deleteOpen}
        deletePending={deleteConversation.isPending}
        deleteError={
          deleteConversation.isError
            ? String(deleteConversation.error)
            : undefined
        }
        onImportClose={() => setImportOpen(false)}
        onImported={agentId => onOpenAgent(agentId)}
        onStopCancel={() => setStopConfirmation(undefined)}
        onStopConfirm={(targets, names) =>
          void cancelOperationTargets(targets, names)
        }
        onRenameClose={() => setRenameOpen(false)}
        onRenameValueChange={setRenameValue}
        onRename={() => rename.mutate(renameValue.trim())}
        onCorrectionClose={() => setEditingMessage(undefined)}
        onCorrectionTextChange={setCorrectionText}
        onCorrectMessage={message => correctMessage.mutate(message)}
        onDeleteClose={() => setDeleteOpen(false)}
        onDelete={() => deleteConversation.mutate()}
      />

    </Box>
  );
}
