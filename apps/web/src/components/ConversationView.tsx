import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import TagIcon from "@mui/icons-material/Tag";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type {
  AgentHealthDto,
  EngineCommand,
  EngineDto,
  ConversationChannel,
  ConversationDto,
  ConversationMessageDto,
  OperatorProfileDto,
  ProjectDto,
  ProjectEngineCapabilitiesDto,
  ResponseFileActivityDto,
  AgentDto,
  TeamOperationalEventDto,
  WorkspaceNotificationDto,
  ConversationDecisionEventDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { CopyMessageButton } from "./CopyMessageButton";
import { compactDefined, uniqueBy } from "../collections";
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
import { ResponseFileActivity } from "./activity/ActivityPane";
import {
  ChatMessageBody,
  CommunicationDocumentCard,
  chatMessageLayoutKey,
  stripDocumentPrefixText,
} from "./chat/ChatMessages";
import { Composer } from "./chat/Composer";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { ChatSurface } from "./chat/ChatSurface";
import { formatExecutionElapsed } from "../time";
import { ProjectRelationshipLink } from "./HeaderRelationshipLinks";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { buildMarkdownTranscript, transcriptFileName } from "../chatTranscript";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { useMobileComposerAutoHide } from "../mobileChat";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { AttentionSurface } from "./AttentionSurface";
import { DecisionCard } from "./decisions/DecisionCard";
import { queryKeys } from "../queryKeys";
import { ChatLiveBanner } from "./chat/ChatLiveBanner";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { ConfirmDialog } from "./ConfirmationDialogs";
import { AgentsTab } from "./AgentsTab";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import { isOrdinaryMessageNotification } from "../workspaceNavigation";

function mergeConversationMessages(
  ...groups: ConversationMessageDto[][]
): ConversationMessageDto[] {
  return uniqueBy(
    groups.flat(),
    message => message.id,
    (a, b) =>
      (a.canonicalOrderKey ?? a.createdAt).localeCompare(
        b.canonicalOrderKey ?? b.createdAt,
      ) || a.id.localeCompare(b.id),
  );
}

type MainTimelineEntry =
  | { kind: "message"; id: string; at: string; message: ConversationMessageDto }
  | { kind: "decision"; id: string; at: string; event: ConversationDecisionEventDto }
  | { kind: "decision-response"; id: string; at: string; event: ConversationDecisionEventDto; choice: string };

function decisionChoice(decision: ConversationDecisionEventDto["decision"]): string | undefined {
  return decision.response?.optionId
    ? decision.options.find((option) => option.id === decision.response?.optionId)?.label
    : decision.response?.text;
}

function mergeDecisionEvents(
  ...groups: ConversationDecisionEventDto[][]
): ConversationDecisionEventDto[] {
  return uniqueBy(
    groups.flat(),
    event => event.id,
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function mergeOperationalEvents(
  ...groups: TeamOperationalEventDto[][]
): TeamOperationalEventDto[] {
  return uniqueBy(
    groups.flat(),
    event => event.id,
    (a, b) =>
      a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
  );
}

interface OperationalEventGroup {
  id: string;
  representative: TeamOperationalEventDto;
  events: TeamOperationalEventDto[];
}

/**
 * Team Chat is an audit projection, so only collapse consecutive rows that
 * are indistinguishable to the reader. The source events stay available in a
 * disclosure and are never removed from the canonical response.
 */
function groupAdjacentOperationalEvents(
  events: TeamOperationalEventDto[],
): OperationalEventGroup[] {
  const groups: OperationalEventGroup[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    const sameAsPrevious = previous &&
      previous.representative.kind === event.kind &&
      previous.representative.state === event.state &&
      previous.representative.text === event.text &&
      previous.representative.agentIds.join("\u0000") === event.agentIds.join("\u0000");
    if (sameAsPrevious) {
      previous.events.push(event);
      continue;
    }
    groups.push({ id: event.id, representative: event, events: [event] });
  }
  return groups;
}

function conversationComposerRuntime(
  engine:
    | (Pick<EngineDto, "id" | "authenticated" | "available"> & {
        enabled?: boolean;
      })
    | undefined,
  engineCapabilities: ProjectEngineCapabilitiesDto[],
): {
  commands: EngineCommand[];
  capabilities: ProjectEngineCapabilitiesDto["composerCapabilities"];
} {
  const discovered = engineCapabilities.find(
    item => item.engineId === engine?.id,
  );
  return {
    commands: discovered?.commands ?? [],
    capabilities: engineIsAvailable(engine)
      ? (discovered?.composerCapabilities ?? [])
      : [],
  };
}

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
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import {
  highlightFocusedMessage,
  projectedMessageIdForFocus,
} from "../messageFocus";
import { mobileOperationalStatus } from "../mobileChat";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { useRuntimeControls } from "../hooks/useRuntimeControls";

function ConversationMessageComponent({
  message,
  conversation,
  agentTitle,
  agentIdForHandle,
  onOpenAgent,
  onOpenReview,
  onOpenFileActivity,
  onEdit,
  onMentionAgent,
  onVisible,
  projectId,
  activeRunId,
  operatorProfile,
}: {
  message: ConversationMessageDto;
  conversation: "main" | "collaboration";
  agentTitle(agentId: string | undefined): string;
  agentIdForHandle(handle: string): string | undefined;
  onOpenAgent(
    agentId: string,
    view?: "technical",
    technicalFocusId?: string,
  ): void;
  onOpenReview?(agentId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onEdit?: (message: ConversationMessageDto) => void;
  onMentionAgent?(agentId: string): void;
  onVisible?(): void;
  projectId: string;
  activeRunId?: string;
  operatorProfile?: OperatorProfileDto;
}): JSX.Element {
  const fromManager = !message.authorAgentId;
  // Routing prefixes are presentation chips, but remain in canonical/copyable
  // text. Do not hide a prefix merely because the scope is also structured.
  const routedText = message.text;
  const visibleText = stripDocumentPrefixText(
    routedText,
    Boolean(message.document),
  );
  const senderName = fromManager
    ? (operatorProfile?.displayName ?? "You")
    : agentTitle(message.authorAgentId);

  return (
    <ChatMessageFrame
      message={{
        id: `master-message-${message.id}`,
        author: fromManager
          ? message.role === "user"
            ? { kind: "operator", profile: operatorProfile }
            : { kind: "notice" }
          : {
              kind: "agent",
              name: senderName,
              onOpen: () => onOpenAgent(message.authorAgentId!),
            },
        createdAt: message.createdAt,
        onVisible,
        body: (
          <ChatMessageBody
            text={visibleText}
            compactMarkdown
            citations={message.citations}
            agentIdForHandle={agentIdForHandle}
            agentMentionForHandle={handle => {
              const binding = message.agentMentions?.find(
                item =>
                  item.handle.toLocaleLowerCase() ===
                  handle.toLocaleLowerCase(),
              );
              return binding
                ? {
                    agentId: binding.agentId,
                    label: agentMentionHandle(agentTitle(binding.agentId)),
                  }
                : undefined;
            }}
            operatorHandle={operatorProfile?.handle}
            onOpenAgent={onOpenAgent}
            projectId={projectId}
            previewScope={
              message.authorAgentId &&
              message.executionId &&
              activeRunId === message.executionId
                ? {
                    projectId,
                    agentId: message.authorAgentId,
                    runId: message.executionId,
                    conversationId: message.conversationId,
                  }
                : undefined
            }
          />
        ),
        afterBody: (
          <>
            {message.editedAt ? (
              <Chip
                size="small"
                variant="outlined"
                label="Edited"
                sx={{ mt: 0.75 }}
              />
            ) : null}
            {message.correctionOfMessageId ? (
              <Chip size="small" label="Correction" sx={{ mt: 0.75 }} />
            ) : null}
            {message.correctedByMessageId ? (
              <Chip
                size="small"
                variant="outlined"
                label="Corrected below"
                sx={{ mt: 0.75 }}
              />
            ) : null}
            {message.document ? (
              <CommunicationDocumentCard document={message.document} />
            ) : null}
            {message.fileActivity?.length ? (
              <ResponseFileActivity
                files={message.fileActivity}
                projectId={projectId}
                onOpenFile={
                  message.authorAgentId && onOpenFileActivity
                    ? file => onOpenFileActivity(message.authorAgentId!, file)
                    : undefined
                }
                onViewAll={
                  message.authorAgentId && onOpenReview
                    ? () => onOpenReview(message.authorAgentId!)
                    : undefined
                }
              />
            ) : null}
          </>
        ),
        attachments: message.attachments,
        status:
          message.role === "user" && message.deliveryReceipts?.length ? (
            <MessageDeliveryStatus
              projectId={projectId}
              receipts={message.deliveryReceipts}
              recipientName={agentId => agentTitle(agentId)}
              onOpenAgent={onOpenAgent}
            />
          ) : undefined,
        actions:
          conversation === "main" ? (
            <>
              <CopyMessageButton text={visibleText} />
              {message.authorAgentId && onMentionAgent ? (
                <Tooltip title={`Mention ${senderName}`}>
                  <IconButton
                    size="small"
                    aria-label={`Mention ${senderName}`}
                    onClick={() => onMentionAgent(message.authorAgentId!)}
                  >
                    <TagIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              ) : null}
              {onEdit ? (
                <Tooltip title="Edit Message">
                  <IconButton
                    size="small"
                    aria-label="Edit message"
                    onClick={() => onEdit(message)}
                  >
                    <EditOutlinedIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              ) : null}
            </>
          ) : undefined,
      }}
    />
  );
}

/**
 * Local Chat tabs preserve their message panels. Stable screen-level callbacks
 * let unchanged messages skip Markdown parsing when only panel visibility
 * changes.
 */
const ConversationMessage = memo(ConversationMessageComponent);

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
  const [activeView, setActiveView] = useState<
    "main" | "collaboration" | "agents"
  >(() => {
    if (initialView) return initialView;
    const saved = readChatState(
      chatStateKey("view", `conversation.${conversationId}`),
    );
    return saved === "collaboration" || saved === "agents" ? saved : "main";
  });
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
  const markedVisibleNotificationIds = useRef(new Set<string>());
  const markCommunicationVisible = useCallback((communicationEventId: string | undefined) => {
    if (!communicationEventId || document.visibilityState === "hidden") return;
    const notifications = (notificationsQuery.data ?? []).filter((item) =>
      item.communicationEventId === communicationEventId &&
      !item.readAt &&
      (item.status ?? "open") === "open" &&
      isOrdinaryMessageNotification(item) &&
      !markedVisibleNotificationIds.current.has(item.id));
    if (!notifications.length) return;
    const ids = new Set(notifications.map((item) => item.id));
    ids.forEach((id) => markedVisibleNotificationIds.current.add(id));
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all, (current = []) =>
      current.map((item) => ids.has(item.id) ? { ...item, readAt } : item));
    void Promise.all(notifications.map((item) => api.markNotificationRead(item.id)))
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }))
      .catch(() => {
        ids.forEach((id) => markedVisibleNotificationIds.current.delete(id));
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      });
  }, [notificationsQuery.data, queryClient]);
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
  const focusedMessage = useRef<string>();
  const focusedMessageHighlightDisposer = useRef<() => void>();
  const theme = useTheme();
  const mobileRoster = useMediaQuery(theme.breakpoints.down("sm"));
  const mobileComposer = useMobileComposerAutoHide(mobileRoster);

  useEffect(() => {
    mobileComposer.reset();
    collaborationVisited.current = false;
    setOlderMain(undefined);
    setOlderCollaboration(undefined);
    focusedMessage.current = undefined;
    const saved = readChatState(
      chatStateKey("view", `conversation.${conversationId}`),
    );
    setActiveView(
      initialView ??
        (saved === "collaboration" || saved === "agents" ? saved : "main"),
    );
  }, [conversationId, initialView]);
  useEffect(() => () => {
    focusedMessageHighlightDisposer.current?.();
    focusedMessageHighlightDisposer.current = undefined;
  }, []);

  if (activeView === "collaboration") collaborationVisited.current = true;

  useEffect(() => {
    writeChatState(
      chatStateKey("view", `conversation.${conversationId}`),
      activeView,
    );
  }, [activeView, conversationId]);

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
  useEffect(() => {
    if (
      !focusMessageId ||
      focusedMessage.current === focusMessageId ||
      focusedMessage.current === `missing:${focusMessageId}`
    )
      return;
    const focusView = initialView ?? "main";
    if (activeView !== focusView) {
      setActiveView(focusView);
      return;
    }
    const focusedMessages =
      focusView === "collaboration" ? collaborationMessages : messages;
    const projectedId = projectedMessageIdForFocus(
      focusedMessages,
      focusMessageId,
    );
    if (!projectedId) {
      if (focusedMessage.current !== `loading:${focusMessageId}`) {
        focusedMessage.current = `loading:${focusMessageId}`;
        if (focusView === "collaboration") {
          void api
            .getCollaborationView(
              conversationId,
              100,
              undefined,
              focusMessageId,
            )
            .then(page => {
              setOlderCollaboration(current => ({
                messages: mergeConversationMessages(
                  page.messages,
                  current?.messages ?? [],
                  collaborationQuery.data?.messages ?? [],
                ),
                operations: current?.operations ?? [],
                cursor: page.history?.cursor,
                operationCursor: current?.operationCursor,
                hasMore: page.history?.hasMore ?? false,
                operationHasMore: current?.operationHasMore ?? false,
              }));
              focusedMessage.current = page.messages.length
                ? undefined
                : `missing:${focusMessageId}`;
            })
            .catch(() => {
              focusedMessage.current = undefined;
            });
        } else {
          void api
            .getConversation(conversationId, 100, undefined, focusMessageId)
            .then(page => {
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
              focusedMessage.current = page.messages.length
                ? undefined
                : `missing:${focusMessageId}`;
            })
            .catch(() => {
              focusedMessage.current = undefined;
            });
        }
      }
      return;
    }
    const target = document.getElementById(`master-message-${projectedId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    focusedMessageHighlightDisposer.current?.();
    focusedMessageHighlightDisposer.current = highlightFocusedMessage(target);
    focusedMessage.current = focusMessageId;
  }, [
    activeView,
    collaborationMessages,
    collaborationQuery.data?.messages,
    conversationId,
    detailQuery.data?.messages,
    focusMessageId,
    initialView,
    messages,
  ]);
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
    }: {
      text: string;
      files: File[];
      requestId: string;
    }) => {
      const owner = agents.find(agent => !agent.archived);
      if (files.length && !owner)
        throw new Error(
          "Create an agent before attaching files to shared project context.",
        );
      const attachments = owner
        ? await Promise.all(
            files.map(file => api.uploadAttachment(owner.id, file)),
          )
        : [];
      try {
        return await api.sendConversationMessage(conversationId, {
          text,
          attachments,
          idempotencyKey: requestId,
        });
      } catch (error) {
        if (owner)
          await Promise.allSettled(
            attachments.map(item => api.deleteAttachment(owner.id, item.id)),
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
  const composerCommands = commands.filter(
    command => command.invocation === "prompt",
  );
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
    if (broadcastMentioned && (everyoneMentioned || explicitlyMentionedAgents.length > 0))
      throw new Error("Broadcast cannot be combined with Agent recipients.");
    if (broadcastMentioned && broadcastText === undefined)
      throw new Error("Put #broadcast first so its shared scope is explicit.");
    if (broadcastText !== undefined) {
      if (!broadcastText && files.length === 0)
        throw new Error(
          "Add informational context or an attachment after #broadcast.",
        );
      await broadcast.mutateAsync({
        text: broadcastText,
        files,
        requestId: createClientId(),
      });
      return;
    }
    const targets = everyoneMentioned
      ? agents.filter(agent => !agent.archived)
      : explicitlyMentionedAgents;
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
      <TabbedWorkspaceFrame
        icon={<ChatBubbleOutlineIcon />}
        title={conversation.title}
        context={
          <ProjectRelationshipLink
            projectLabel={project?.label}
            onOpenProject={onOpenProject}
          />
        }
        actions={
          <>
            <ChatOverflowMenu
              label={`${activeView === "collaboration" ? "Team Chat" : "Chat"} settings and actions`}
              transcriptMarkdown={transcriptMarkdown}
              transcriptFileName={transcriptFileName(transcriptTitle)}
              actions={[
                {
                  label: "Work",
                  icon: <AccountTreeOutlinedIcon fontSize="small" />,
                  onSelect: () => setAgentWorkOpen(true),
                },
                {
                  label: "Rename",
                  icon: <DriveFileRenameOutlineIcon fontSize="small" />,
                  onSelect: () => {
                    setRenameValue(conversation.title);
                    setRenameOpen(true);
                  },
                },
                {
                  label: "Create Agent",
                  icon: <AddIcon fontSize="small" />,
                  onSelect: () => onNewAgent(conversation),
                },
                {
                  label: "Import Agent or Organization",
                  icon: <FileUploadOutlinedIcon fontSize="small" />,
                  onSelect: () => setImportOpen(true),
                },
                {
                  label: "Delete",
                  icon: <DeleteOutlineIcon fontSize="small" />,
                  destructive: true,
                  onSelect: () => setDeleteOpen(true),
                },
              ]}
            />
          </>
        }
        tabs={{
          label: "Chat views",
          value: agentWorkOpen ? false : activeView,
          onChange: next => {
            setAgentWorkOpen(false);
            setActiveView(next);
          },
          items: [
            { value: "main", label: "Chat" },
            { value: "collaboration", label: "Team Chat" },
            {
              value: "agents",
              label: "Agents",
              icon: <SmartToyOutlinedIcon fontSize="small" />,
            },
          ],
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
            <Stack spacing={0} sx={{ mb: 2 }}>
              {mainTimeline.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No messages yet. Send a request to start your first agent —
                  its completed answer returns here.
                </Typography>
              ) : null}
              {mainTimeline.map(entry => {
                if (entry.kind === "decision") return <Box key={entry.id} sx={{ py: 1 }}>
                  <DecisionCard decision={entry.event.decision} title={entry.event.decision.question} context={entry.event.decision.context} />
                </Box>;
                if (entry.kind === "decision-response") return <ChatMessageFrame
                  key={entry.id}
                  message={{
                    id: entry.id,
                    author: { kind: "operator", profile: preferencesQuery.data?.profile },
                    createdAt: entry.at,
                    ariaLabel: `You chose ${entry.choice}`,
                    body: <Typography variant="body2">You chose {entry.choice}.</Typography>,
                  }}
                />;
                const message = entry.message;
                return <ConversationMessage
                  key={entry.id}
                  message={message}
                  conversation="main"
                  projectId={conversation.projectId}
                  activeRunId={
                    message.authorAgentId
                      ? healthByAgentId.get(message.authorAgentId)
                          ?.runtimeActivity?.executionId
                      : undefined
                  }
                  operatorProfile={preferencesQuery.data?.profile}
                  agentTitle={agentTitle}
                  agentIdForHandle={agentIdForHandle}
                  onOpenAgent={onOpenAgent}
                  onOpenReview={onOpenReview}
                  onOpenFileActivity={onOpenFileActivity}
                  onMentionAgent={mentionAgent}
                  onVisible={() => markCommunicationVisible(message.communicationEventId)}
                  onEdit={
                    message.role === "user" &&
                    !message.authorAgentId &&
                    !message.correctedByMessageId &&
                    !message.correctionOfMessageId
                      ? editConversationMessage
                      : undefined
                  }
                />;
              })}
            </Stack>
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
              <Stack spacing={0} sx={{ mb: 2 }}>
                {operationalEventGroups.length ? (
                  <Stack spacing={0.5} aria-label="Team operational activity">
                    {operationalEventGroups.map(group => {
                      const event = group.representative;
                      const content = (
                        <>
                          <Chip
                            size="small"
                            variant="outlined"
                            label={
                              event.kind === "run"
                                ? "Agent"
                                : event.kind === "join"
                                  ? "Waiting"
                                  : event.kind === "request"
                                    ? "Work"
                                    : event.kind === "trigger"
                                      ? "Trigger"
                                      : event.kind === "decision"
                                        ? "Decision"
                                        : event.kind === "organization"
                                          ? "Team"
                                          : "Ready"
                            }
                          />
                          <Typography
                            variant="body2"
                            sx={{
                              display: { xs: "none", sm: "block" },
                              flex: 1,
                            }}
                          >
                            {event.text}
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{
                              display: { xs: "block", sm: "none" },
                              flex: 1,
                            }}
                          >
                            {mobileOperationalStatus(event.state)}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: { xs: "none", sm: "block" } }}
                          >
                            {new Date(event.updatedAt).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </Typography>
                        </>
                      );
                      const sx = {
                        display: "flex",
                        width: "100%",
                        gap: 1,
                        alignItems: "center",
                        px: 1.25,
                        py: 0.75,
                        borderRadius: 1.5,
                        bgcolor: "action.hover",
                        textAlign: "left",
                      } as const;
                      const row = event.kind === "organization" ? (
                        <Box key={event.id} sx={sx}>
                          {content}
                        </Box>
                      ) : (
                        <ButtonBase
                          key={event.id}
                          onClick={() => onOpenAgentWork(event.id)}
                          aria-label={`${event.text}. Open Work details`}
                          sx={sx}
                        >
                          {content}
                        </ButtonBase>
                      );
                      if (group.events.length === 1) return row;
                      const expanded = expandedOperationalEventGroups.has(group.id);
                      return <Stack key={group.id} spacing={0.5}>
                        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>{row}</Box>
                          <Button
                            size="small"
                            aria-expanded={expanded}
                            onClick={() => setExpandedOperationalEventGroups(current => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                              return next;
                            })}
                          >{expanded ? "Hide duplicates" : `×${group.events.length}`}</Button>
                        </Box>
                        {expanded ? <Stack spacing={0.5} sx={{ pl: 1.5 }} aria-label={`${group.events.length} duplicate operational events`}>
                          {group.events.map(raw => <ButtonBase
                            key={raw.id}
                            onClick={() => onOpenAgentWork(raw.id)}
                            aria-label={`${raw.text}. Open Work details`}
                            sx={sx}
                          >
                            <Typography variant="body2" sx={{ flex: 1, textAlign: "left" }}>{raw.text}</Typography>
                            <Typography variant="caption" color="text.secondary">{new Date(raw.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Typography>
                          </ButtonBase>)}
                        </Stack> : null}
                      </Stack>;
                    })}
                  </Stack>
                ) : null}
                {collaborationMessages.length + operationalEvents.length ===
                0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No agent-to-agent messages yet.
                  </Typography>
                ) : null}
                {collaborationMessages.map(message => (
                  <ConversationMessage
                    key={message.id}
                    message={message}
                    conversation="collaboration"
                    projectId={conversation.projectId}
                    activeRunId={
                      message.authorAgentId
                        ? healthByAgentId.get(message.authorAgentId)
                            ?.runtimeActivity?.executionId
                        : undefined
                    }
                    operatorProfile={preferencesQuery.data?.profile}
                    agentTitle={agentTitle}
                    agentIdForHandle={agentIdForHandle}
                    onOpenAgent={onOpenAgent}
                    onOpenReview={onOpenReview}
                    onOpenFileActivity={onOpenFileActivity}
                  />
                ))}
              </Stack>
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
