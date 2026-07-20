import AddIcon from "@mui/icons-material/Add";
import ReplyIcon from "@mui/icons-material/Reply";
import QuickreplyIcon from "@mui/icons-material/Quickreply";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import TimelineIcon from "@mui/icons-material/Timeline";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Avatar,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { AgentHealthDto, EngineCommand, EngineDto, ImageAttachmentDto, ConversationChannel, ConversationDto, ConversationMessageDto, OperatorProfileDto, ProjectDto, ProjectEngineCapabilitiesDto, ResponseFileActivityDto, AgentDto, TeamOperationalEventDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { CopyMessageButton } from "./CopyMessageButton";
import { compactDefined } from "../collections";
import { agentRosterIndent, agentStatusColor, agentStatusLabel, orderedAgentOrganization, relativeTime, type AgentStatus } from "../agents";
import { pickAgentName } from "../parkNames";
import { useCollaborationView, useConversation } from "../hooks/queries";
import { effortOptionsForModel, effortSelectionIsCompatible, engineIsAvailable, modelSelectionIsCompatible, resolveConversationEngine, resolveRuntimeSelection, selectedRunConfig } from "../conversationEngine";
import { agentIdForMentionHandle, agentMentionHandle, findMentionedAgents, hasEveryoneMention } from "../mentions";
import { compactViewportQuery } from "../responsive";
import { managerBroadcastText, resolveConversationSendRoute, uploadDirectReplyFiles } from "../conversationReply";
import { chatMessageLayoutKey, ChatMessageBody, CommunicationDocumentCard, Composer, isChatNearBottom, QueuedMessageTray, ResponseFileActivity, revealChatScrollbar, ScrollToLatestButton, scrollChatToBottom, UserMessageLabel } from "./panes";
import { MessageSenderLabel } from "./MessageSenderLabel";
import { MessageActionsAndTimestamp, MessageTimestamp } from "./MessageTimestamp";
import { formatExecutionElapsed } from "./AgentDetail";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { buildMarkdownTranscript, transcriptFileName } from "../chatTranscript";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";

function mergeConversationMessages(...groups: ConversationMessageDto[][]): ConversationMessageDto[] {
  const byId = new Map<string, ConversationMessageDto>();
  for (const message of groups.flat()) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) =>
    (a.canonicalOrderKey ?? a.createdAt).localeCompare(b.canonicalOrderKey ?? b.createdAt) || a.id.localeCompare(b.id));
}

function mergeOperationalEvents(...groups: TeamOperationalEventDto[][]): TeamOperationalEventDto[] {
  const byId = new Map<string, TeamOperationalEventDto>();
  for (const event of groups.flat()) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
}

export function conversationComposerRuntime(
  engine: Pick<EngineDto, "id" | "authenticated" | "available"> | undefined,
  engineCapabilities: ProjectEngineCapabilitiesDto[],
): { commands: EngineCommand[]; capabilities: ProjectEngineCapabilitiesDto["composerCapabilities"] } {
  const discovered = engineCapabilities.find((item) => item.engineId === engine?.id);
  return {
    commands: discovered?.commands ?? [],
    capabilities: engineIsAvailable(engine) ? discovered?.composerCapabilities ?? [] : [],
  };
}

function MasterRespondingIndicator({ agents, healthByAgentId }: {
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
}): JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const responding = agents.flatMap((agent) => {
    const activity = healthByAgentId.get(agent.id)?.runtimeActivity;
    return activity ? [{ agent, activity }] : [];
  });
  if (responding.length === 0) return null;
  const names = responding.map(({ agent }) => agent.title).join(", ");
  const earliest = responding.map(({ activity }) => activity.startedAt).sort()[0]!;
  return <Alert severity="info" role="status" aria-live="polite" sx={{ mb: 1.5 }}>
    {names} {responding.length === 1 ? "is" : "are"} responding · {formatExecutionElapsed(earliest, now)}
  </Alert>;
}
import { EmojiReactionPicker, MessageReactions } from "./EmojiReactionPicker";
import { chatStateKey, readChatState, readScrollPosition, writeChatState } from "../chatState";
import { projectedMessageIdForFocus } from "../messageFocus";

export function ConversationMessage({
  message,
  conversation,
  agentTitle,
  agentIdForHandle,
  compactViewport = false,
  onOpenAgent,
  onOpenWorkLog,
  onOpenReview,
  onOpenFileActivity,
  onReply,
  onDirectReply,
  onReact,
  onEdit,
  projectId,
  activeRunId,
  operatorProfile,
}: {
  message: ConversationMessageDto;
  conversation: "main" | "collaboration";
  agentTitle(agentId: string | undefined): string;
  agentIdForHandle(handle: string): string | undefined;
  compactViewport?: boolean;
  onOpenAgent(agentId: string): void;
  onOpenWorkLog?(agentId: string): void;
  onOpenReview?(agentId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onReply(message: ConversationMessageDto): void;
  onDirectReply(message: ConversationMessageDto): void;
  onReact(message: ConversationMessageDto, emoji: string): Promise<void>;
  onEdit?: (message: ConversationMessageDto) => void;
  projectId: string;
  activeRunId?: string;
  operatorProfile?: OperatorProfileDto;
}): JSX.Element {
  const fromManager = !message.authorAgentId;
  // Older projections stored the structured broadcast scope as visible prose.
  // Agent-authored Project-chat messages already carry that scope structurally.
  const visibleText = conversation === "main" && message.authorAgentId
    ? message.text.replace(/^#broadcast(?:\s+|$)/i, "")
    : message.text;
  const senderName = fromManager ? operatorProfile?.displayName ?? "You" : agentTitle(message.authorAgentId);

  return (
    <Box
      id={`master-message-${message.id}`}
      component="article"
      className="chat-message"
      aria-label={`${fromManager ? operatorProfile?.displayName ?? "You" : agentTitle(message.authorAgentId)} message`}
      tabIndex={-1}
      sx={{ alignSelf: "center", width: "min(1120px, 100%)", maxWidth: "100%", minWidth: 0, py: { xs: 0.75, sm: 1 } }}
    >
      <Stack direction="row" spacing={{ xs: 1, sm: 1.5 }} sx={{ alignItems: "flex-start", justifyContent: fromManager ? "flex-end" : "flex-start", minWidth: 0 }}>
        {!fromManager ? <Avatar aria-label={`${senderName} avatar`} sx={{ width: 36, height: 36, flex: "0 0 auto", bgcolor: (theme) => theme.palette.mode === "dark" ? "#25302F" : "#F0F1EC", color: "text.primary", fontSize: 15, fontWeight: 750 }}>{senderName.slice(0, 1).toLocaleUpperCase()}</Avatar> : null}
        <Box sx={{ minWidth: 0, width: fromManager ? "fit-content" : "min(100%, 960px)", maxWidth: fromManager ? { xs: "94%", sm: "88%", md: "min(78%, 780px)" } : "100%" }}>
          {!fromManager ? <Stack direction="row" spacing={0.75} sx={{ minHeight: 28, alignItems: "center", mb: 0.25 }}>
            <Box sx={{ "& [data-message-sender]": { mb: 0, fontSize: 14 } }}><MessageSenderLabel name={senderName} /></Box>
            <Box sx={{ color: "text.secondary" }}><MessageTimestamp value={message.createdAt} compact align="start" /></Box>
          </Stack> : null}
          {fromManager && message.role === "user" ? <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 0.25 }}><UserMessageLabel profile={operatorProfile} /></Box> : null}
          <Box
            data-message-bubble="true"
            sx={{
              px: fromManager ? { xs: 1.25, sm: 1.5 } : 0,
              py: fromManager ? { xs: 1, sm: 1.15 } : 0,
              borderRadius: 2,
              bgcolor: fromManager ? (theme) => theme.palette.mode === "dark" ? "#27332F" : "#EFF0EB" : "transparent",
              color: "text.primary",
              border: 0,
            }}
          >
        {fromManager && message.role === "user" ? <Box sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}><MessageSenderLabel name={operatorProfile?.displayName ?? "You"} /></Box> : null}
        {message.replyTo ? (
          <Box component="button" aria-label="Go to replied-to message" onClick={() => {
            const target = document.getElementById(`master-message-${message.replyTo!.messageId}`);
            target?.scrollIntoView({ behavior: "smooth", block: "center" });
            target?.focus({ preventScroll: true });
          }} sx={{ display: "block", width: "100%", mb: .75, p: .75, border: 0, borderLeft: 3, borderColor: "currentColor", bgcolor: "rgba(127,127,127,.14)", color: "inherit", textAlign: "left", cursor: "pointer", borderRadius: 1 }}>
            <Typography variant="caption" component="div" noWrap>{message.replyTo.text || "Original message unavailable"}</Typography>
          </Box>
        ) : null}
        <ChatMessageBody
          text={visibleText}
          citations={message.citations}
          agentIdForHandle={agentIdForHandle}
          agentMentionForHandle={(handle) => {
            const binding = message.agentMentions?.find((item) => item.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());
            return binding ? { agentId: binding.agentId, label: agentMentionHandle(agentTitle(binding.agentId)) } : undefined;
          }}
          onOpenAgent={onOpenAgent}
          projectId={projectId}
          previewScope={message.authorAgentId && message.executionId && activeRunId === message.executionId ? { projectId, agentId: message.authorAgentId, runId: message.executionId, conversationId: message.conversationId } : undefined}
        />
        {message.editedAt ? <Chip size="small" variant="outlined" label="Edited" sx={{ mt: 0.75 }} /> : null}
        {message.correctionOfMessageId ? <Chip size="small" label="Correction" sx={{ mt: 0.75 }} /> : null}
        {message.correctedByMessageId ? <Chip size="small" variant="outlined" label="Corrected below" sx={{ mt: 0.75 }} /> : null}
        {message.document ? <CommunicationDocumentCard document={message.document} /> : null}
        {message.fileActivity?.length ? <ResponseFileActivity
          files={message.fileActivity}
          projectId={projectId}
          onOpenFile={message.authorAgentId && onOpenFileActivity
            ? (file) => onOpenFileActivity(message.authorAgentId!, file)
            : undefined}
          onViewAll={message.authorAgentId && onOpenReview
            ? () => onOpenReview(message.authorAgentId!)
            : undefined}
        /> : null}
        {message.attachments?.length ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: message.text ? 1 : 0 }}>
          {message.attachments.map((attachment) => <Box key={attachment.id} sx={{ maxWidth: "100%" }}>
            {attachment.mediaType.startsWith("image/")
              ? <Box component="img" src={attachment.previewUrl ?? attachment.url} alt={attachment.name} sx={{ display: "block", maxWidth: 320, maxHeight: 240, objectFit: "contain", borderRadius: 1 }} />
              : <Stack spacing={.25} sx={{ p: .75, border: 1, borderColor: "divider", borderRadius: 1 }}><Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name}</Typography><Typography variant="caption" color="text.secondary">{attachment.mediaType} · {attachment.size} bytes</Typography></Stack>}
            <Stack direction="row" spacing={.5} sx={{ mt: .25 }}>
              {attachment.previewUrl ? <Button size="small" component="a" href={attachment.previewUrl} target="_blank" rel="noreferrer" sx={{ minWidth: 0, px: .5 }}>Open</Button> : null}
              <Button size="small" component="a" href={attachment.downloadUrl ?? attachment.url} target="_blank" rel="noreferrer" download aria-label={`Download ${attachment.name}`} sx={{ minWidth: 0, px: .5 }}>Download</Button>
            </Stack>
          </Box>)}
        </Stack> : null}
        <MessageReactions reactions={message.reactions} />
          </Box>
          <MessageActionsAndTimestamp
            showTimestamp={fromManager}
            value={message.createdAt}
            status={message.role === "user" && message.deliveryReceipts?.length ? <MessageDeliveryStatus
              projectId={projectId}
              receipts={message.deliveryReceipts}
              recipientName={(agentId) => agentTitle(agentId)}
              onOpenAgent={onOpenAgent}
              onOpenWorkLog={onOpenWorkLog}
            /> : undefined}
            actions={conversation === "main" ? <>
        {message.authorAgentId ? <Tooltip title={`Open ${senderName}`}><IconButton
          size="small"
          aria-label={`Open agent ${senderName}`}
          onClick={() => onOpenAgent(message.authorAgentId!)}
        ><OpenInNewIcon fontSize="inherit" /></IconButton></Tooltip> : null}
        {message.authorAgentId && message.communicationEventId ? <EmojiReactionPicker recipientName={agentTitle(message.authorAgentId)} onReact={(emoji) => onReact(message, emoji)} /> : null}
        <CopyMessageButton text={visibleText} />
        {conversation === "main" ? <Tooltip title="Reply"><IconButton size="small" aria-label="Reply to message" onClick={() => onReply(message)}><ReplyIcon fontSize="inherit" /></IconButton></Tooltip> : null}
        {conversation === "main" && onEdit ? <Tooltip title="Edit Latest Message"><IconButton size="small" aria-label="Edit latest message" onClick={() => onEdit(message)}><EditOutlinedIcon fontSize="inherit" /></IconButton></Tooltip> : null}
        {conversation === "main" && message.authorAgentId ? (
          <Tooltip title={`Reply directly to ${agentTitle(message.authorAgentId)}`}><IconButton
            size="small"
            aria-label={`Reply directly to ${agentTitle(message.authorAgentId)}`}
            onClick={() => onDirectReply(message)}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
          >
            <QuickreplyIcon fontSize="inherit" />
          </IconButton></Tooltip>
        ) : null}
          </> : undefined}
          />
        </Box>
      </Stack>
    </Box>
  );
}

export function ConversationView({
  conversationId,
  focusMessageId,
  initialView,
  engines,
  engineCapabilities,
  onRefreshCapabilities,
  statusByAgentId,
  healthByAgentId,
  onOpenAgent,
  onOpenWorkLog,
  onOpenRosterAgent,
  initialAgentsOpen = false,
  onInitialAgentsOpenConsumed,
  onOpenReview,
  onOpenFileActivity,
  onNewAgent,
  onDeleted,
}: {
  conversationId: string;
  focusMessageId?: string;
  initialView?: ConversationChannel;
  engines: EngineDto[];
  engineCapabilities: ProjectEngineCapabilitiesDto[];
  onRefreshCapabilities(context?: { engineId?: string; model?: string; agentId?: string }): Promise<unknown> | unknown;
  statusByAgentId: Map<string, AgentStatus>;
  healthByAgentId: Map<string, AgentHealthDto>;
  onOpenAgent(agentId: string): void;
  onOpenWorkLog?(agentId: string): void;
  onOpenRosterAgent?(agentId: string): void;
  initialAgentsOpen?: boolean;
  onInitialAgentsOpenConsumed?(): void;
  onOpenReview?(agentId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onNewAgent(master: ConversationDto): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const detailQuery = useConversation(conversationId);
  const collaborationQuery = useCollaborationView(conversationId);
  const [olderMain, setOlderMain] = useState<{ messages: ConversationMessageDto[]; cursor?: string; hasMore: boolean }>();
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
    queryKey: ["queued-messages", conversationId],
    queryFn: () => api.listQueuedConversationMessages(conversationId),
  });
  const decisionsQuery = useQuery({ queryKey: ["decisions", "conversation", conversationId], queryFn: () => api.listDecisions({ conversationId, status: "pending" }) });
  const preferencesQuery = useQuery({ queryKey: ["workspace-preferences"], queryFn: () => api.getWorkspacePreferences() });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const respondDecision = useMutation({
    mutationFn: ({ id, optionId, text }: { id: string; optionId?: string; text?: string }) => api.respondDecision(id, { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["decisions", "conversation", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      void queryClient.invalidateQueries({ queryKey: ["collaboration-chat", conversationId] });
    },
  });
  const [activeView, setActiveView] = useState<"main" | "collaboration">(() => initialView ??
    (readChatState(chatStateKey("view", `conversation.${conversationId}`)) === "collaboration" ? "collaboration" : "main"));
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(initialAgentsOpen);
  const consumedInitialAgentsOpen = useRef(false);
  const [agentWorkFocus, setAgentWorkFocus] = useState<string>();
  const [agentWorkOpen, setAgentWorkOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentDto | undefined>();
  const [queuedReplyNotice, setQueuedReplyNotice] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<ConversationMessageDto | undefined>();
  const [directReplyTargetId, setDirectReplyTargetId] = useState<string | undefined>();
  const [directReplyRequestId, setDirectReplyRequestId] = useState<string | undefined>();
  const [activeOperation, setActiveOperation] = useState<{ agentIds: string[]; state: "starting" | "running" }>();
  const [stoppedNotice, setStoppedNotice] = useState<string>();
  const directReplyUploads = useRef(new Map<string, ImageAttachmentDto[]>());
  const stopOperationRequestId = useRef<string>();
  const [editingMessage, setEditingMessage] = useState<ConversationMessageDto>();
  const [correctionText, setCorrectionText] = useState("");
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  useEffect(() => {
    if (!initialAgentsOpen || consumedInitialAgentsOpen.current) return;
    consumedInitialAgentsOpen.current = true;
    setAgentsOpen(true);
    onInitialAgentsOpenConsumed?.();
  }, [initialAgentsOpen, onInitialAgentsOpenConsumed]);
  const clearReply = () => {
    if (directReplyRequestId && directReplyTargetId) {
      const uploaded = directReplyUploads.current.get(directReplyRequestId) ?? [];
      directReplyUploads.current.delete(directReplyRequestId);
      void Promise.allSettled(uploaded.map((item) => api.deleteAttachment(directReplyTargetId, item.id)));
    }
    setReplyTo(undefined);
    setDirectReplyTargetId(undefined);
    setDirectReplyRequestId(undefined);
  };

  // The engine/model/effort currently selected for this conversation. Model-agnostic:
  // it can change any time and only affects agents spawned *after* the change —
  // already-running agents keep the model they were spawned with.
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const initializedFor = useRef<string | undefined>(undefined);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowNewMessages = useRef(true);
  const displayedConversationId = useRef<string>();
  const displayedView = useRef<"main" | "collaboration">();
  const focusedMessage = useRef<string>();
  const theme = useTheme();
  const mobileRoster = useMediaQuery(theme.breakpoints.down("sm"));
  const compactViewport = useMediaQuery(compactViewportQuery(theme.breakpoints.down("sm")));

  useEffect(() => {
    setOlderMain(undefined);
    setOlderCollaboration(undefined);
    focusedMessage.current = undefined;
    setActiveView(initialView ??
      (readChatState(chatStateKey("view", `conversation.${conversationId}`)) === "collaboration" ? "collaboration" : "main"));
  }, [conversationId, initialView]);

  useEffect(() => {
    writeChatState(chatStateKey("view", `conversation.${conversationId}`), activeView);
  }, [activeView, conversationId]);

  const conversation = detailQuery.data?.conversation;
  // Live query updates can briefly leave sparse entries in cached collections.
  // Compact at the page boundary so historical chats remain renderable.
  const messages = mergeConversationMessages(olderMain?.messages ?? [], compactDefined(detailQuery.data?.messages ?? []));
  const agents = compactDefined(detailQuery.data?.agents ?? []);
  const collaborationMessages = mergeConversationMessages(olderCollaboration?.messages ?? [], compactDefined(collaborationQuery.data?.messages ?? []));
  const operationalEvents = mergeOperationalEvents(
    olderCollaboration?.operations ?? [],
    compactDefined(collaborationQuery.data?.operations ?? []),
  );
  const messageLayoutKey = chatMessageLayoutKey(messages);
  const collaborationLayoutKey = chatMessageLayoutKey(collaborationMessages);
  const operationalLayoutKey = operationalEvents.length
    ? `${operationalEvents.length}:${operationalEvents.at(-1)?.id ?? ""}`
    : "0";
  const mainHistory = olderMain ?? {
    messages: [],
    cursor: detailQuery.data?.history?.cursor,
    hasMore: detailQuery.data?.history?.hasMore ?? false,
  };
  const collaborationHistory = olderCollaboration ?? {
    messages: [],
    operations: [],
    cursor: collaborationQuery.data?.history?.cursor,
    operationCursor: collaborationQuery.data?.operationHistory?.cursor,
    hasMore: collaborationQuery.data?.history?.hasMore ?? false,
    operationHasMore: collaborationQuery.data?.operationHistory?.hasMore ?? false,
  };
  const loadOlderHistory = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      if (activeView === "main") {
        if (!mainHistory.hasMore || !mainHistory.cursor) return;
        const page = await api.getConversation(conversationId, 100, mainHistory.cursor);
        setOlderMain((current) => ({
          messages: mergeConversationMessages(page.messages, current?.messages ?? [], detailQuery.data?.messages ?? []),
          cursor: page.history?.cursor,
          hasMore: page.history?.hasMore ?? false,
        }));
      } else {
        const loadMessages = collaborationHistory.hasMore && Boolean(collaborationHistory.cursor);
        const loadOperations = collaborationHistory.operationHasMore && Boolean(collaborationHistory.operationCursor);
        if (!loadMessages && !loadOperations) return;
        const page = await api.getCollaborationView(
          conversationId,
          100,
          loadMessages ? collaborationHistory.cursor : undefined,
          undefined,
          loadOperations ? collaborationHistory.operationCursor : undefined,
        );
        setOlderCollaboration((current) => ({
          messages: loadMessages
            ? mergeConversationMessages(page.messages, current?.messages ?? [], collaborationQuery.data?.messages ?? [])
            : current?.messages ?? [],
          operations: loadOperations
            ? mergeOperationalEvents(page.operations ?? [], current?.operations ?? [], collaborationQuery.data?.operations ?? [])
            : current?.operations ?? [],
          cursor: loadMessages ? page.history?.cursor : current?.cursor,
          operationCursor: loadOperations ? page.operationHistory?.cursor : current?.operationCursor,
          hasMore: loadMessages ? page.history?.hasMore ?? false : false,
          operationHasMore: loadOperations ? page.operationHistory?.hasMore ?? false : false,
        }));
      }
    } finally {
      setLoadingOlder(false);
    }
  };
  useEffect(() => {
    if (!focusMessageId || focusedMessage.current === focusMessageId || focusedMessage.current === `missing:${focusMessageId}`) return;
    const focusView = initialView ?? "main";
    if (activeView !== focusView) {
      setActiveView(focusView);
      return;
    }
    const focusedMessages = focusView === "collaboration" ? collaborationMessages : messages;
    const projectedId = projectedMessageIdForFocus(focusedMessages, focusMessageId);
    if (!projectedId) {
      if (focusedMessage.current !== `loading:${focusMessageId}`) {
        focusedMessage.current = `loading:${focusMessageId}`;
        if (focusView === "collaboration") {
          void api.getCollaborationView(conversationId, 100, undefined, focusMessageId).then((page) => {
            setOlderCollaboration((current) => ({
              messages: mergeConversationMessages(page.messages, current?.messages ?? [], collaborationQuery.data?.messages ?? []),
              operations: current?.operations ?? [],
              cursor: page.history?.cursor,
              operationCursor: current?.operationCursor,
              hasMore: page.history?.hasMore ?? false,
              operationHasMore: current?.operationHasMore ?? false,
            }));
            focusedMessage.current = page.messages.length ? undefined : `missing:${focusMessageId}`;
          }).catch(() => { focusedMessage.current = undefined; });
        } else {
          void api.getConversation(conversationId, 100, undefined, focusMessageId).then((page) => {
            setOlderMain((current) => ({
              messages: mergeConversationMessages(page.messages, current?.messages ?? [], detailQuery.data?.messages ?? []),
              cursor: page.history?.cursor,
              hasMore: page.history?.hasMore ?? false,
            }));
            focusedMessage.current = page.messages.length ? undefined : `missing:${focusMessageId}`;
          }).catch(() => { focusedMessage.current = undefined; });
        }
      }
      return;
    }
    const target = document.getElementById(`master-message-${projectedId}`);
    if (!target) return;
    shouldFollowNewMessages.current = false;
    setShowScrollToLatest(true);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    focusedMessage.current = focusMessageId;
  }, [activeView, collaborationMessages, collaborationQuery.data?.messages, conversationId, detailQuery.data?.messages, focusMessageId, initialView, messages]);
  useLayoutEffect(() => {
    if (
      displayedConversationId.current !== conversationId ||
      displayedView.current !== activeView
    ) {
      displayedConversationId.current = conversationId;
      displayedView.current = activeView;
      const key = chatStateKey("scroll", `conversation.${conversationId}.${activeView}`);
      const saved = readScrollPosition(key);
      if (chatScrollRef.current && saved !== undefined) {
        chatScrollRef.current.scrollTop = saved;
        shouldFollowNewMessages.current = isChatNearBottom(chatScrollRef.current);
        setShowScrollToLatest(!shouldFollowNewMessages.current);
        return;
      }
      shouldFollowNewMessages.current = true;
      setShowScrollToLatest(false);
    }
    if (chatScrollRef.current && shouldFollowNewMessages.current) {
      scrollChatToBottom(chatScrollRef.current);
      setShowScrollToLatest(false);
    }
  }, [conversationId, activeView, messageLayoutKey, collaborationLayoutKey, operationalLayoutKey]);

  useEffect(() => {
    if (!conversation || initializedFor.current === conversation.id) {
      return;
    }
    if (!preferencesQuery.data || !projectsQuery.data) return;
    const project = projectsQuery.data.find((candidate) => candidate.id === conversation.projectId);
    const resolvedEngine = resolveConversationEngine(conversation.defaultEngine ?? project?.defaultEngine, engines);
    if (!resolvedEngine) return;
    const selectedEngine = engines.find((candidate) => candidate.id === resolvedEngine);
    const resolved = resolveRuntimeSelection(selectedEngine, preferencesQuery.data, project, {
      model: conversation.defaultModel,
      effort: conversation.defaultEffort,
    });
    initializedFor.current = conversation.id;
    setEngine(resolvedEngine);
    setModel(resolved.model);
    setEffort(resolved.effort);
  }, [conversation, engines, preferencesQuery.data, projectsQuery.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    void queryClient.invalidateQueries({ queryKey: ["collaboration-chat", conversationId] });
    if (conversation) {
      void queryClient.invalidateQueries({ queryKey: ["agents", conversation.projectId] });
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
      void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const spawn = useMutation({
    mutationFn: async ({ text, draftAttachmentIds }: { text: string; draftAttachmentIds: string[] }) => {
      if (!conversation) {
        throw new Error("Project chat not loaded");
      }
      // Record the message in the shared pool, spawn a park-named agent on the
      // selected engine, and hand it the message as its first turn.
      const selectedEngine = engines.find((candidate) => candidate.id === engine);
      const compatibleModel = modelSelectionIsCompatible(selectedEngine, model) ? model : "";
      const compatibleEffort = effortSelectionIsCompatible(selectedEngine, compatibleModel, effort) ? effort : "";
      const runConfig = selectedRunConfig(compatibleModel, compatibleEffort);
      setActiveOperation({ agentIds: [], state: "starting" });
      const agent = await api.createAgent(conversation.projectId, conversationId, {
        title: pickAgentName((detailQuery.data?.agents ?? []).map((agent) => agent.title)),
        engine,
        ...runConfig,
        initialMessage: text,
        draftAttachmentIds,
        replyToMessageId: replyTo?.id,
      });
      setActiveOperation({ agentIds: [agent.id], state: "starting" });
      return agent;
    },
    onSuccess: () => {
      clearReply();
      invalidate();
    },
  });

  // Persist one canonical user message, then let the server fan it out to the
  // explicitly tagged agents as stable-ID direct deliveries.
  const reply = useMutation({
    mutationFn: async ({ agentIds, text, files, replyToMessageId, requestId, activeRunDelivery }: { agentIds: string[]; text: string; files: File[]; replyToMessageId?: string; requestId: string; activeRunDelivery: "steer" | "queue" }) => {
      const recipients = await Promise.all(agentIds.map(async (agentId) => {
        const attachments = await Promise.all(files.map((file) => api.uploadAttachment(agentId, file)));
        return { agentId, attachmentIds: attachments.map((item) => item.id) };
      }));
      return api.sendMultiAgentDirectMessage(conversationId, {
        text,
        recipients,
        replyToMessageId,
        idempotencyKey: requestId,
        activeRunDelivery,
      });
    },
    onSuccess: (response, variables) => {
      clearReply();
      invalidate();
      const queuedTitles = response.recipients
        .filter((recipient) => recipient.queued)
        .map((recipient) => detailQuery.data?.agents.find((agent) => agent.id === recipient.agentId)?.title ?? "Agent");
      setQueuedReplyNotice(
        queuedTitles.length > 0
          ? variables.activeRunDelivery === "queue"
            ? `Queued for ${queuedTitles.join(", ")}; it will start when the current response finishes.`
            : undefined
          : undefined,
      );
      const activeIds = response.recipients.filter((recipient) => !recipient.queued).map((recipient) => recipient.agentId);
      if (activeIds.length === 0) setActiveOperation(undefined);
      else setActiveOperation({ agentIds: activeIds, state: "starting" });
      for (const agentId of variables.agentIds) {
        void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      }
    },
  });

  const broadcast = useMutation({
    mutationFn: async ({ text, files, replyToMessageId, requestId }: { text: string; files: File[]; replyToMessageId?: string; requestId: string }) => {
      const owner = agents.find((agent) => !agent.archived);
      if (files.length && !owner) throw new Error("Create an agent before attaching files to shared project context.");
      const attachments = owner
        ? await uploadDirectReplyFiles(files, (file) => api.uploadAttachment(owner.id, file), (item) => api.deleteAttachment(owner.id, item.id))
        : [];
      try {
        return await api.sendConversationMessage(conversationId, { text, replyToMessageId, attachments, idempotencyKey: requestId });
      } catch (error) {
        if (owner) await Promise.allSettled(attachments.map((item) => api.deleteAttachment(owner.id, item.id)));
        throw error;
      }
    },
    onSuccess: () => {
      clearReply();
      invalidate();
    },
  });

  const directReply = useMutation({
    mutationFn: async ({ targetId, text, files, replyToMessageId, requestId, activeRunDelivery }: { targetId: string; text: string; files: File[]; replyToMessageId: string; requestId: string; activeRunDelivery: "steer" | "queue" }) => {
      let attachments = directReplyUploads.current.get(requestId);
      if (!attachments) {
        attachments = await uploadDirectReplyFiles(
          files,
          (file) => api.uploadAttachment(targetId, file),
          (item) => api.deleteAttachment(targetId, item.id),
        );
        directReplyUploads.current.set(requestId, attachments);
      }
      return api.sendDirectReply(conversationId, {
        text,
        replyToMessageId,
        targetAuthorAgentId: targetId,
        attachmentIds: attachments.map((item) => item.id),
        idempotencyKey: requestId,
        activeRunDelivery,
      });
    },
    onSuccess: (response, variables) => {
      directReplyUploads.current.delete(variables.requestId);
      clearReply();
      invalidate();
      setQueuedReplyNotice(response.queued
        ? variables.activeRunDelivery === "queue"
          ? `Queued for ${agentTitle(response.targetAuthorAgentId)}; it will start when the current response finishes.`
          : undefined
        : undefined);
      if (response.queued) setActiveOperation(undefined);
      void queryClient.invalidateQueries({ queryKey: ["agent", response.targetAuthorAgentId] });
    },
  });

  const sendReaction = useMutation({
    mutationFn: ({ communicationEventId, emoji, requestId }: { communicationEventId: string; emoji: string; requestId: string }) =>
      api.sendUserReaction({ projectId: conversation!.projectId, communicationEventId, emoji, idempotencyKey: requestId }),
    onSuccess: (response) => {
      invalidate();
      setQueuedReplyNotice(undefined);
      void queryClient.invalidateQueries({ queryKey: ["agent", response.targetAuthorAgentId] });
    },
  });

  const cancelQueued = useMutation({
    mutationFn: (deliveryId: string) => api.cancelQueuedConversationMessage(conversationId, deliveryId, {
      idempotencyKey: `cancel:${deliveryId}`,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["queued-messages", conversationId] });
    },
  });
  const editQueued = useMutation({
    mutationFn: ({ deliveryId, targetAgentId, text }: { deliveryId: string; targetAgentId: string; text: string }) => api.editQueuedAgentMessage(targetAgentId, deliveryId, {
      text,
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["queued-messages", conversationId] }),
  });
  const steerQueued = useMutation({
    mutationFn: ({ deliveryId, targetAgentId }: { deliveryId: string; targetAgentId: string }) => api.steerQueuedAgentMessage(targetAgentId, deliveryId, {
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["queued-messages", conversationId] }),
  });
  const correctMessage = useMutation({
    mutationFn: (message: ConversationMessageDto) => api.correctConversationMessage(conversationId, message.id, {
      text: correctionText.trim(),
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      activeRunDelivery: "queue",
    }),
    onSuccess: () => {
      setEditingMessage(undefined);
      setCorrectionText("");
      invalidate();
    },
  });


  const rename = useMutation({
    mutationFn: (title: string) => api.updateConversation(conversationId, { title }),
    onSuccess: () => {
      invalidate();
      setRenameOpen(false);
    },
  });
  const titleGenerationRequested = useRef<string>();
  const generateTitle = useMutation({
    mutationFn: () => api.generateConversationTitle(conversationId),
    onSuccess: (result) => {
      if (result.generated) invalidate();
    },
  });
  useEffect(() => {
    if (!/^New Chat$/i.test(conversation?.title ?? "") || titleGenerationRequested.current === conversationId) return;
    const hasOperatorMessage = messages.some((message) => message.role === "user");
    const hasAgentMessage = messages.some((message) => message.role === "assistant");
    if (!hasOperatorMessage || !hasAgentMessage) return;
    titleGenerationRequested.current = conversationId;
    generateTitle.mutate();
  }, [conversation?.title, conversationId, generateTitle, messages]);

  const deleteConversation = useMutation({
    mutationFn: () => api.deleteConversation(conversationId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["conversation", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["agents", conversation?.projectId] });
      setDeleteOpen(false);
      onDeleted();
    },
  });

  const busy = spawn.isPending || reply.isPending || directReply.isPending || broadcast.isPending;

  useEffect(() => {
    if (!activeOperation || activeOperation.agentIds.length === 0) return;
    const anyRunning = activeOperation.agentIds.some((agentId) => statusByAgentId.get(agentId) === "running");
    if (anyRunning && activeOperation.state !== "running") {
      setActiveOperation({ ...activeOperation, state: "running" });
    } else if (!busy && activeOperation.state === "running" && !anyRunning) {
      setActiveOperation(undefined);
    }
  }, [activeOperation, busy, statusByAgentId]);

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
            <Button color="inherit" size="small" onClick={() => void detailQuery.refetch()}>
              Retry
            </Button>
          }
        >
          This Project chat could not be loaded. Check the server connection and try again.
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

  const activeEngine = engines.find((candidate) => candidate.id === engine);
  const project = projectsQuery.data?.find((candidate: ProjectDto) => candidate.id === conversation.projectId);
  const composerRuntime = conversationComposerRuntime(activeEngine, engineCapabilities);
  const commands = composerRuntime.commands;
  const advertisedModels = activeEngine?.models.filter((option) => option.id) ?? [];
  const models = activeEngine?.modelCatalogKnown === false && model && !advertisedModels.some((option) => option.id === model)
    ? [...advertisedModels, { id: model, label: `${model} (saved selection)` }]
    : advertisedModels;
  const advertisedEfforts = effortOptionsForModel(activeEngine, model);
  const efforts = effort && effortSelectionIsCompatible(activeEngine, model, effort) && !advertisedEfforts.some((option) => option.id === effort)
    ? [...advertisedEfforts, { id: effort, label: `${effort} (saved selection)` }]
    : advertisedEfforts;
  const engineReady = engineIsAvailable(activeEngine);

  const agentTitle = (agentId: string | undefined): string =>
    agents.find((agent) => agent.id === agentId)?.title ?? "Agent";
  const transcriptTitle = activeView === "collaboration"
    ? `${conversation.title} — Team chat`
    : conversation.title;
  const transcriptMarkdown = buildMarkdownTranscript(
    transcriptTitle,
    (activeView === "collaboration" ? collaborationMessages : messages).map((message) => ({
      author: message.authorAgentId ? agentTitle(message.authorAgentId) : message.role === "system" ? "System" : "You",
      text: activeView === "main" && message.authorAgentId
        ? message.text.replace(/^#broadcast(?:\s+|$)/i, "")
        : message.text,
      createdAt: message.createdAt,
      attachments: message.attachments,
      document: message.document,
    })),
  );
  const agentIdForHandle = (handle: string): string | undefined => agentIdForMentionHandle(agents, handle);
  const mentionHandles = [
    "broadcast",
    "everyone",
    ...agents
      .filter((agent) => !agent.archived)
      .map((agent) => agentMentionHandle(agent.title))
      .filter((handle) => !["broadcast", "user", "everyone"].includes(handle.toLocaleLowerCase())),
  ];
  const findMentioned = (text: string): AgentDto[] => findMentionedAgents(text, agents);

  const busyMentionHandles = agents
    .filter((agent) => statusByAgentId.get(agent.id) === "running")
    .map((agent) => agentMentionHandle(agent.title));

  const operationRunning = Boolean(activeOperation && (busy || activeOperation.state === "running"));
  const stopOperation = async () => {
    const targets = (activeOperation?.agentIds ?? []).flatMap((agentId) => {
      const runId = healthByAgentId.get(agentId)?.runtimeActivity?.executionId;
      return runId ? [{ agentId, runId }] : [];
    });
    if (targets.length === 0) return;
    const names = targets.map(({ agentId }) => agentTitle(agentId)).join(", ");
    if (targets.length > 1 && !window.confirm(`Stop this operation tree (${names})? Partial output will remain visible.`)) return;
    setStoppedNotice(`Stopping ${names}. Partial output will remain visible.`);
    const requestId = stopOperationRequestId.current ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    stopOperationRequestId.current = requestId;
    await Promise.allSettled(targets.map(({ agentId, runId }) => api.cancelRun(agentId, {
      targetRunId: runId,
      idempotencyKey: `${requestId}:${runId}`,
    })));
    stopOperationRequestId.current = undefined;
    setStoppedNotice(`Stopped ${names}. Partial output remains visible.`);
    invalidate();
  };

  const submit = async (text: string, files: File[], activeRunDelivery: "steer" | "queue" = "steer", draftAttachmentIds: string[] = []) => {
    const broadcastText = managerBroadcastText(text);
    if (broadcastText !== undefined) {
      if (!broadcastText && files.length === 0) throw new Error("Add informational context or an attachment after #broadcast.");
      await broadcast.mutateAsync({ text: broadcastText, files, replyToMessageId: replyTo?.id, requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` });
      return;
    }
    const targets = hasEveryoneMention(text)
      ? agents.filter((agent) => !agent.archived)
      : findMentioned(text);
    if (hasEveryoneMention(text) && targets.length === 0) throw new Error("There are no active agents to notify.");
    const route = resolveConversationSendRoute(directReplyTargetId, targets.map((target) => target.id));
    if (route.kind === "direct-reply") {
      if (!replyTo) throw new Error("The direct reply target is no longer available. Cancel the reply and try again.");
      if (!directReplyRequestId) throw new Error("The direct reply receipt is no longer available. Cancel the reply and try again.");
      setActiveOperation({ agentIds: route.agentIds, state: "starting" });
      await directReply.mutateAsync({
        targetId: route.agentIds[0],
        text,
        files,
        replyToMessageId: replyTo.id,
        requestId: directReplyRequestId,
        activeRunDelivery,
      });
      return;
    }
    if (route.kind === "mentioned-reply") {
      setActiveOperation({ agentIds: route.agentIds, state: "starting" });
      await reply.mutateAsync({
        agentIds: route.agentIds,
        text,
        files,
        replyToMessageId: replyTo?.id,
        requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        activeRunDelivery,
      });
    } else {
      setActiveOperation({ agentIds: [], state: "starting" });
      await spawn.mutateAsync({ text, draftAttachmentIds });
    }
  };

  const runtimeControls = activeView === "main" ? <ComposerRuntimeSelector
    engine={engine}
    engines={engines.map((option) => ({
      id: option.id,
      label: option.displayName,
      disabled: !engineIsAvailable(option),
      detail: engineIsAvailable(option) ? undefined : option.authenticated ? "Access unavailable" : "Signed out",
    }))}
    model={model}
    models={models}
    effort={effort}
    efforts={efforts}
    onEngineChange={(next) => {
      const nextEngine = engines.find((candidate) => candidate.id === next);
      const resolved = resolveRuntimeSelection(nextEngine, preferencesQuery.data, project);
      setEngine(next); setModel(resolved.model); setEffort(resolved.effort);
      persistDefaults.mutate({ defaultEngine: next as EngineDto["id"], defaultModel: resolved.model || null, defaultEffort: resolved.effort || null });
    }}
    onModelChange={(next) => {
      const resolved = resolveRuntimeSelection(activeEngine, preferencesQuery.data, project, { model: next });
      setModel(next); setEffort(resolved.effort);
      persistDefaults.mutate({ defaultModel: next, defaultEffort: resolved.effort || null });
    }}
    onEffortChange={(next) => { setEffort(next); persistDefaults.mutate({ defaultEffort: next }); }}
  /> : null;

  return (
    <Box data-testid="conversation" data-conversation-id={conversationId} sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
      <Box sx={{ px: { xs: 1, sm: 1.5, md: 2 }, pt: { xs: 0.75, sm: 1.25 }, borderBottom: 1, borderColor: "divider" }}>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ alignItems: "center", minWidth: 0 }}
        >
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="caption" color="text.secondary" noWrap>{project?.label ?? "Project"}</Typography>
            <Typography variant="h5" fontWeight={800} noWrap>
              {conversation.title}
            </Typography>
          </Box>
          <Tooltip title="Agent Work"><IconButton
            onClick={() => { setAgentWorkFocus(undefined); setAgentWorkOpen(true); }}
            aria-haspopup="dialog"
            aria-expanded={agentWorkOpen}
            aria-label="Open Agent work"
          ><TimelineIcon /></IconButton></Tooltip>
          <ChatOverflowMenu
            label={`${activeView === "collaboration" ? "Team" : "Project"} Chat Actions`}
            transcriptMarkdown={transcriptMarkdown}
            transcriptFileName={transcriptFileName(transcriptTitle)}
            actions={[
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
                label: "Import Agent or Organization…",
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
        </Stack>
        <Stack component="nav" aria-label="Project Chat views" direction="row" spacing={.5} sx={{ minHeight: 46, mt: .5, alignItems: "stretch" }}>
          <Button color="inherit" aria-pressed={activeView === "main"} aria-label="Switch to project chat" onClick={() => { clearReply(); setActiveView("main"); }} sx={{ position: "relative", px: 1.5, color: activeView === "main" ? "text.primary" : "text.secondary", "&::after": activeView === "main" ? { content: '""', position: "absolute", left: 8, right: 8, bottom: 0, height: 2, bgcolor: "primary.light" } : undefined }}>Project Chat</Button>
          <Button color="inherit" aria-pressed={activeView === "collaboration"} aria-label="Switch to team chat" onClick={() => { clearReply(); setActiveView("collaboration"); }} sx={{ position: "relative", px: 1.5, color: activeView === "collaboration" ? "text.primary" : "text.secondary", "&::after": activeView === "collaboration" ? { content: '""', position: "absolute", left: 8, right: 8, bottom: 0, height: 2, bgcolor: "primary.light" } : undefined }}>Team Chat</Button>
          <Button color="inherit" startIcon={<GroupsOutlinedIcon fontSize="small" />} onClick={() => setAgentsOpen(true)} aria-haspopup="dialog" aria-expanded={agentsOpen} aria-label={`View ${agents.length} agents`} sx={{ px: 1.5, color: "text.secondary" }}>Agents</Button>
        </Stack>
      </Box>

      <Box sx={{ position: "relative", minHeight: 0, minWidth: 0 }}>
        <Box
          ref={chatScrollRef}
          className="chat-scroll-region"
          role="region"
          aria-label={activeView === "collaboration" ? "Team chat messages" : "Project chat messages"}
          tabIndex={0}
          onScroll={(event) => {
            revealChatScrollbar(event.currentTarget);
            if (chatScrollRef.current) {
              shouldFollowNewMessages.current = isChatNearBottom(chatScrollRef.current);
              setShowScrollToLatest(!shouldFollowNewMessages.current);
              writeChatState(
                chatStateKey("scroll", `conversation.${conversationId}.${activeView}`),
                String(chatScrollRef.current.scrollTop),
              );
            }
          }}
          sx={{ height: "100%", minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" }}
        >
        <Box data-chat-column sx={{ width: "min(1180px, 100%)", mx: "auto", px: { xs: 1, sm: 2, md: 3, lg: 4 }, py: { xs: 1, sm: 1.5 }, pb: 3 }}>
          {activeView === "collaboration" ? <Alert severity="info" sx={{ mb: 1.5 }}>
            Team chat is a read-only audit trail of agent-to-agent coordination. Message an agent from its Agent chat; collaboration will appear here automatically.
          </Alert> : null}
          {activeView === "main" && !engineReady ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              {activeEngine?.displayName ?? "The selected engine"} is not signed in. Sign in on the
              host, or pick a signed-in engine, before spawning agents.
            </Alert>
          ) : null}
          {activeView === "main" ? <MasterRespondingIndicator agents={agents} healthByAgentId={healthByAgentId} /> : null}
          {(decisionsQuery.data ?? []).map((decision) => <Alert key={decision.id} severity={decision.blocking ? "warning" : "info"} sx={{ mb: 1.5 }}>
            <Typography variant="subtitle2">{agentTitle(decision.agentId)} needs your decision</Typography>
            <Typography variant="body2" sx={{ mb: 1 }}>{decision.question}</Typography>
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
              {decision.options.map((option) => <Button key={option.id} size="small" variant="outlined" disabled={respondDecision.isPending} onClick={() => respondDecision.mutate({ id: decision.id, optionId: option.id })}>{option.label}</Button>)}
              {(decision.allowOther || decision.mode === "text") ? <Button size="small" variant="outlined" disabled={respondDecision.isPending} onClick={() => { const text = window.prompt(decision.mode === "text" ? "Your answer" : "What should the Agent do instead?"); if (text?.trim()) respondDecision.mutate({ id: decision.id, text: text.trim() }); }}>{decision.mode === "text" ? "Answer" : "Something Else"}</Button> : null}
            </Stack>
          </Alert>)}

          <Stack spacing={0} sx={{ mb: 2 }}>
            {(activeView === "collaboration" ? collaborationHistory.hasMore || collaborationHistory.operationHasMore : mainHistory.hasMore) ? (
              <Button
                size="small"
                color="inherit"
                disabled={loadingOlder}
                onClick={() => void loadOlderHistory()}
                sx={{ alignSelf: "center", mb: 1 }}
              >
                {loadingOlder ? "Loading…" : "Load Older History"}
              </Button>
            ) : null}
            {activeView === "collaboration" && operationalEvents.length ? <Stack spacing={0.5} aria-label="Team operational activity">
              {operationalEvents.map((event) => {
                const content = <>
                  <Chip size="small" variant="outlined" label={event.kind === "run" ? "Agent" : event.kind === "join" ? "Waiting" : event.kind === "request" ? "Work" : event.kind === "trigger" ? "Trigger" : event.kind === "decision" ? "Decision" : event.kind === "organization" ? "Team" : "Ready"} />
                  <Typography variant="body2" sx={{ flex: 1 }}>{event.text}</Typography>
                  <Typography variant="caption" color="text.secondary">{new Date(event.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Typography>
                </>;
                const sx = { display: "flex", width: "100%", gap: 1, alignItems: "center", px: 1.25, py: 0.75, borderRadius: 1.5, bgcolor: "action.hover", textAlign: "left" } as const;
                return event.kind === "organization"
                  ? <Box key={event.id} sx={sx}>{content}</Box>
                  : <ButtonBase key={event.id} onClick={() => { setAgentWorkFocus(event.id); setAgentWorkOpen(true); }} aria-label={`${event.text}. Open Agent work details`} sx={sx}>{content}</ButtonBase>;
              })}
            </Stack> : null}
            {(activeView === "collaboration" ? collaborationMessages.length + operationalEvents.length : messages.length) === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {activeView === "collaboration"
                  ? "No agent-to-agent messages yet."
                  : "No messages yet. Send a request to start your first agent — its completed answer returns here."}
              </Typography>
            ) : null}
            {(activeView === "collaboration" ? collaborationMessages : messages).map((message) => (
              <ConversationMessage
                key={message.id}
                message={message}
                conversation={activeView}
                projectId={conversation.projectId}
                activeRunId={message.authorAgentId ? healthByAgentId.get(message.authorAgentId)?.runtimeActivity?.executionId : undefined}
                operatorProfile={preferencesQuery.data?.profile}
                agentTitle={agentTitle}
                agentIdForHandle={agentIdForHandle}
                compactViewport={compactViewport}
                onOpenAgent={onOpenAgent}
                onOpenWorkLog={onOpenWorkLog}
                onOpenReview={onOpenReview}
                onOpenFileActivity={onOpenFileActivity}
                onReply={(selected) => {
                  clearReply();
                  setReplyTo(selected);
                }}
                onDirectReply={(selected) => {
                  clearReply();
                  setReplyTo(selected);
                  setDirectReplyTargetId(selected.authorAgentId);
                  setDirectReplyRequestId(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
                  setStoppedNotice(undefined);
                }}
                onReact={(selected, emoji) => sendReaction.mutateAsync({
                  communicationEventId: selected.communicationEventId!,
                  emoji,
                  requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
                }).then(() => undefined)}
                onEdit={activeView === "main" && message.id === messages.filter((candidate) => candidate.role === "user" && !candidate.authorAgentId).at(-1)?.id && !message.correctedByMessageId
                  ? (selected) => { setEditingMessage(selected); setCorrectionText(selected.text); }
                  : undefined}
              />
            ))}
          </Stack>

        </Box>
        </Box>
        <ScrollToLatestButton
          visible={showScrollToLatest}
          onClick={() => {
            if (!chatScrollRef.current) return;
            shouldFollowNewMessages.current = true;
            scrollChatToBottom(chatScrollRef.current);
            setShowScrollToLatest(false);
          }}
        />
      </Box>

      <Drawer
        anchor={mobileRoster ? "bottom" : "right"}
        open={agentsOpen}
        onClose={() => setAgentsOpen(false)}
        ModalProps={{ keepMounted: true }}
        PaperProps={{
          sx: mobileRoster
            ? { maxHeight: "min(75dvh, 640px)", borderRadius: "16px 16px 0 0" }
            : { width: "min(420px, 92vw)" },
        }}
      >
        <Box sx={{ p: 2, minHeight: 0, overflow: "auto" }} role="dialog" aria-label="Agents in this Project chat">
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
            <Typography variant="h6" sx={{ flex: 1 }}>Agents in this Project chat</Typography>
            <Chip size="small" label={agents.length} />
            <Tooltip title="Close Agent Roster">
              <IconButton aria-label="Close agent roster" onClick={() => setAgentsOpen(false)} sx={{ minWidth: 44, minHeight: 44 }}>
                <CloseIcon />
              </IconButton>
            </Tooltip>
          </Stack>
          {agents.length === 0 ? (
            <Alert severity="info">No agents yet. Send a message to spawn one.</Alert>
          ) : (
            <List dense disablePadding>
              {orderedAgentOrganization(agents).map(({ agent, depth }) => {
                const status = statusByAgentId.get(agent.id) ?? "idle";
                const manager = agent.managerAgentId
                  ? agents.find((candidate) => candidate.id === agent.managerAgentId)
                  : undefined;
                return (
                  <ListItem
                    key={agent.id}
                    disablePadding
                    sx={{
                      mb: 0.5,
                      width: "100%",
                      minWidth: 0,
                      boxSizing: "border-box",
                      pl: agentRosterIndent(depth),
                    }}
                    secondaryAction={
                      <Tooltip title="Delete Agent">
                        <IconButton
                          edge="end"
                          size="small"
                          aria-label={`Delete agent ${agent.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(agent);
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    }
                  >
                    <ListItemButton
                      onClick={() => {
                        setAgentsOpen(false);
                        (onOpenRosterAgent ?? onOpenAgent)(agent.id);
                      }}
                      sx={{ minWidth: 0, borderRadius: 1, border: 1, borderLeftWidth: depth ? 3 : 1, borderColor: "divider", pr: 7 }}
                    >
                      <ListItemText
                        primary={agent.title}
                        secondary={`${manager ? `Reports to ${manager.title} · ` : ""}${agent.activeEngine} · updated ${relativeTime(agent.updatedAt)}`}
                        sx={{ minWidth: 0 }}
                        primaryTypographyProps={{ fontWeight: 700, noWrap: true }}
                        secondaryTypographyProps={{ noWrap: true }}
                      />
                      <Chip
                        size="small"
                        label={agentStatusLabel(status)}
                        color={agentStatusColor(status)}
                        sx={{ mr: 0.5, flexShrink: 0 }}
                      />
                    </ListItemButton>
                  </ListItem>
                );
              })}
            </List>
          )}
        </Box>
      </Drawer>
      <AgentWorkInspector
        open={agentWorkOpen}
        projectId={conversation.projectId}
        conversationId={conversation.id}
        focus={agentWorkFocus ? { id: agentWorkFocus } : undefined}
        onClose={() => setAgentWorkOpen(false)}
      />

      <Box>
        {activeView === "main" && queuedReplyNotice ? <Alert severity="info" sx={{ mx: 1.5, mt: 1 }}>{queuedReplyNotice}</Alert> : null}
        {activeView === "main" && stoppedNotice ? <Alert severity="warning" role="status" sx={{ mx: 1.5, mt: 1 }}>{stoppedNotice}</Alert> : null}
        {spawn.isError || reply.isError || directReply.isError || sendReaction.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Message not sent. {String((spawn.error ?? reply.error ?? directReply.error ?? sendReaction.error) as Error)}
          </Alert>
        ) : null}
        {activeView === "main" ? <QueuedMessageTray
          messages={queuedMessagesQuery.data ?? []}
          agentNameForId={agentTitle}
          busy={cancelQueued.isPending || editQueued.isPending || steerQueued.isPending}
          onSteer={(message) => steerQueued.mutateAsync({ deliveryId: message.deliveryId, targetAgentId: message.targetAgentId })}
          onEdit={(message, text) => editQueued.mutateAsync({ deliveryId: message.deliveryId, targetAgentId: message.targetAgentId, text })}
          onDelete={(message) => cancelQueued.mutateAsync(message.deliveryId)}
        /> : null}
        {activeView === "main" ? <Composer
          draftStorageKey={chatStateKey("draft", `conversation.${conversationId}.${activeView}`)}
          conversationDraftId={conversationId}
          controls={runtimeControls}
          guidance={agents.length > 0
            ? "Send normally to start a fresh agent, use #agent to target an existing agent, or @ to reference a project file."
            : "Send normally to start a fresh agent, or use @ to reference a project file."}
          disabled={busy}
          running={operationRunning}
          allowSendWhileRunning
          mentionHandles={mentionHandles}
          commands={commands}
          capabilities={composerRuntime.capabilities}
          onCapabilitiesOpen={() => onRefreshCapabilities({ engineId: activeEngine?.id, model })}
          busyMentionHandles={busyMentionHandles}
          allowUnmentionedSend={engineReady || Boolean(directReplyTargetId)}
          placeholder={engineReady
              ? "Describe a request — starts a new agent"
              : "#tag an agent or use #broadcast for shared context"}
          onSend={(text, files, stagedIds) => submit(text, files, "steer", stagedIds)}
          onQueue={(text, files, stagedIds) => submit(text, files, "queue", stagedIds)}
          preferQueue={Boolean(directReplyTargetId && (queuedMessagesQuery.data ?? []).some((message) => message.targetAgentId === directReplyTargetId))}
          queuedMentionHandles={(queuedMessagesQuery.data ?? []).flatMap((message) => {
            const agent = agents.find((candidate) => candidate.id === message.targetAgentId);
            return agent ? [agentMentionHandle(agent.title)] : [];
          })}
          agentResponding={Boolean(directReplyTargetId && statusByAgentId.get(directReplyTargetId) === "running")}
          replyTo={replyTo}
          replyLabel={directReplyTargetId ? `Replying directly to #${agentMentionHandle(agentTitle(directReplyTargetId))}` : undefined}
          projectId={conversation.projectId}
          focusReply={Boolean(directReplyTargetId)}
          onCancel={stopOperation}
          onCancelReply={() => {
            clearReply();
          }}
        /> : null}
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

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Rename Project chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Project chat name"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            sx={{ mt: 1 }}
          />
          {rename.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(rename.error)}</Alert> : null}
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

      <Dialog open={Boolean(editingMessage)} onClose={() => !correctMessage.isPending && setEditingMessage(undefined)} fullWidth maxWidth="sm">
        <DialogTitle>Edit latest message</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>The original remains in append-only history. Shared-project edits update the visible revision without redelivering to an active agent.</Alert>
          <TextField autoFocus fullWidth multiline minRows={3} label="Message" value={correctionText} onChange={(event) => setCorrectionText(event.target.value)} />
          {correctMessage.isError ? <Alert severity="error" sx={{ mt: 2 }}>{String(correctMessage.error)}</Alert> : null}
        </DialogContent>
        <DialogActions><Button onClick={() => setEditingMessage(undefined)} disabled={correctMessage.isPending}>Cancel</Button><Button variant="contained" disabled={!correctionText.trim() || correctMessage.isPending} onClick={() => editingMessage && correctMessage.mutate(editingMessage)}>Save Edit</Button></DialogActions>
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
            This permanently deletes <Box component="strong">{conversation.title}</Box> and its chat
            history. Its agents are preserved in the Agents tab as unassigned agents. This cannot be undone.
          </Typography>
          {deleteConversation.isError ? (
            <Alert severity="error" sx={{ mt: 1 }}>{String(deleteConversation.error)}</Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleteConversation.isPending}>Cancel</Button>
          <Button color="error" variant="contained" disabled={deleteConversation.isPending} onClick={() => deleteConversation.mutate()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <AgentDeletionDialog
        open={Boolean(pendingDelete)}
        projectId={conversation.projectId}
        rootAgentIds={pendingDelete ? [pendingDelete.id] : []}
        onClose={() => setPendingDelete(undefined)}
        onDeleted={() => {
          invalidate();
          setPendingDelete(undefined);
        }}
      />
    </Box>
  );
}
