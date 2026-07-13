import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import TuneIcon from "@mui/icons-material/Tune";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { AgentHealthDto, EngineCommand, EngineDto, ImageAttachmentDto, ConversationDto, ConversationMessageDto, ProjectEngineCapabilitiesDto, AgentDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { compactDefined } from "../collections";
import { agentStatusColor, agentStatusLabel, relativeTime, type AgentStatus } from "../agents";
import { pickAgentName } from "../parkNames";
import { useCollaborationView, useConversation } from "../hooks/queries";
import { agentIdForMentionHandle, agentMentionHandle, findMentionedAgents, findMentionedAgentsStrict, hasEveryoneMention, stripCollaborationRoutingTags } from "../mentions";
import { compactViewportQuery } from "../responsive";
import { managerBroadcastText, resolveConversationSendRoute, uploadDirectReplyFiles } from "../conversationReply";
import { ChatMessageBody, CommunicationDocumentCard, Composer, isChatNearBottom, scrollChatToBottom, UserMessageLabel } from "./panes";
import { MessageSenderLabel } from "./MessageSenderLabel";
import { MessageActionsAndTimestamp } from "./MessageTimestamp";
import { formatExecutionElapsed } from "./AgentDetail";

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
import { MessageContextMenu } from "./MessageContextMenu";
import { chatStateKey, readChatState, readScrollPosition, writeChatState } from "../chatState";

export function ConversationMessage({
  message,
  conversation,
  agentTitle,
  agentIdForHandle,
  compactViewport = false,
  onOpenAgent,
  onReply,
  onDirectReply,
  onReact,
}: {
  message: ConversationMessageDto;
  conversation: "main" | "collaboration";
  agentTitle(agentId: string | undefined): string;
  agentIdForHandle(handle: string): string | undefined;
  compactViewport?: boolean;
  onOpenAgent(agentId: string): void;
  onReply(message: ConversationMessageDto): void;
  onDirectReply(message: ConversationMessageDto): void;
  onReact(message: ConversationMessageDto, emoji: string): Promise<void>;
}): JSX.Element {
  const fromManager = !message.authorAgentId;
  const showUserLabel = fromManager && message.role === "user";

  return (
    <Box
      id={`master-message-${message.id}`}
      component="article"
      aria-label={`${fromManager ? "You" : agentTitle(message.authorAgentId)} message`}
      tabIndex={-1}
      sx={{ alignSelf: fromManager ? "flex-end" : "flex-start", maxWidth: { xs: "96%", sm: "min(680px, 92%)" }, minWidth: 0 }}
    >
      {showUserLabel ? <UserMessageLabel /> : null}
      <MessageContextMenu
        text={message.text}
        onReply={() => onReply(message)}
        onOpenAgent={message.authorAgentId ? () => onOpenAgent(message.authorAgentId!) : undefined}
      >
      <Box
        data-message-bubble="true"
        sx={{
          px: 1.5,
          py: 1,
          borderRadius: 2,
          bgcolor: fromManager ? "primary.main" : "background.paper",
          color: fromManager ? "primary.contrastText" : "text.primary",
          border: fromManager ? 0 : 1,
          borderColor: "divider",
        }}
      >
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "flex-start", minWidth: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <MessageSenderLabel name={fromManager ? "You" : agentTitle(message.authorAgentId)} />
          </Box>
          {message.authorAgentId ? (
            <IconButton
              size="small"
              aria-label={`Open agent ${agentTitle(message.authorAgentId)}`}
              onClick={() => onOpenAgent(message.authorAgentId!)}
              sx={{ color: "inherit", minWidth: 44, minHeight: 44, mt: -1, mr: -1 }}
            >
              <OpenInNewIcon fontSize="inherit" />
            </IconButton>
          ) : null}
        </Stack>
        {message.replyTo ? (
          <Box component="button" aria-label="Go to replied-to message" onClick={() => {
            const target = document.getElementById(`master-message-${message.replyTo!.messageId}`);
            target?.scrollIntoView({ behavior: "smooth", block: "center" });
            target?.focus({ preventScroll: true });
          }} sx={{ display: "block", width: "100%", mb: .75, p: .75, border: 0, borderLeft: 3, borderColor: "currentColor", bgcolor: "rgba(127,127,127,.14)", color: "inherit", textAlign: "left", cursor: "pointer", borderRadius: 1 }}>
            <Typography variant="caption" component="div" noWrap>{message.replyTo.text || "Original message unavailable"}</Typography>
          </Box>
        ) : null}
        <ChatMessageBody text={message.text} agentIdForHandle={agentIdForHandle} onOpenAgent={onOpenAgent} />
        {message.document ? <CommunicationDocumentCard document={message.document} /> : null}
        {message.attachments?.length ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: message.text ? 1 : 0 }}>
          {message.attachments.map((attachment) => <Box key={attachment.id} component="a" href={attachment.downloadUrl ?? attachment.url} target="_blank" rel="noreferrer" aria-label={`Download ${attachment.name}`} sx={{ maxWidth: "100%" }}>
            {attachment.previewUrl || !attachment.mediaType || attachment.mediaType.startsWith("image/")
              ? <Box component="img" src={attachment.previewUrl ?? attachment.url} alt={attachment.name} sx={{ display: "block", maxWidth: 220, maxHeight: 180, objectFit: "contain", borderRadius: 1 }} />
              : <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name} · {attachment.mediaType} · {attachment.size} bytes</Typography>}
          </Box>)}
        </Stack> : null}
        <MessageReactions reactions={message.reactions} />
        <MessageActionsAndTimestamp value={message.createdAt} actions={<Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mt: .5 }}>
          {message.authorAgentId && message.communicationEventId ? <EmojiReactionPicker recipientName={agentTitle(message.authorAgentId)} onReact={(emoji) => onReact(message, emoji)} /> : null}
          <Button size="small" color="inherit" onClick={() => onReply(message)}>Reply</Button>
          {conversation === "main" && message.authorAgentId ? (
            <Button
              size="small"
              color="inherit"
              aria-label={`Reply directly to ${agentTitle(message.authorAgentId)}`}
              onClick={() => onDirectReply(message)}
              sx={{ minHeight: compactViewport ? 44 : undefined }}
            >
              Reply Directly
            </Button>
          ) : null}
        </Stack>} />
      </Box>
      </MessageContextMenu>
    </Box>
  );
}

export function ConversationView({
  conversationId,
  engines,
  engineCapabilities,
  statusByAgentId,
  healthByAgentId,
  onOpenAgent,
  onNewAgent,
  onDeleted,
}: {
  conversationId: string;
  engines: EngineDto[];
  engineCapabilities: ProjectEngineCapabilitiesDto[];
  statusByAgentId: Map<string, AgentStatus>;
  healthByAgentId: Map<string, AgentHealthDto>;
  onOpenAgent(agentId: string): void;
  onNewAgent(master: ConversationDto): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const detailQuery = useConversation(conversationId);
  const collaborationQuery = useCollaborationView(conversationId);
  const [activeView, setActiveView] = useState<"main" | "collaboration">(() =>
    readChatState(chatStateKey("view", `conversation.${conversationId}`)) === "collaboration" ? "collaboration" : "main",
  );
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentDto | undefined>();
  const [queuedReplyNotice, setQueuedReplyNotice] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<ConversationMessageDto | undefined>();
  const [directReplyTargetId, setDirectReplyTargetId] = useState<string | undefined>();
  const [directReplyRequestId, setDirectReplyRequestId] = useState<string | undefined>();
  const directReplyUploads = useRef(new Map<string, ImageAttachmentDto[]>());
  const [runSetupOpen, setRunSetupOpen] = useState(false);
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
  const theme = useTheme();
  const mobileRoster = useMediaQuery(theme.breakpoints.down("sm"));
  const compactViewport = useMediaQuery(compactViewportQuery(theme.breakpoints.down("sm")));

  useEffect(() => {
    setActiveView(readChatState(chatStateKey("view", `conversation.${conversationId}`)) === "collaboration" ? "collaboration" : "main");
  }, [conversationId]);

  useEffect(() => {
    writeChatState(chatStateKey("view", `conversation.${conversationId}`), activeView);
  }, [activeView, conversationId]);

  const conversation = detailQuery.data?.conversation;
  // Live query updates can briefly leave sparse entries in cached collections.
  // Compact at the page boundary so historical chats remain renderable.
  const messages = compactDefined(detailQuery.data?.messages ?? []);
  const agents = compactDefined(detailQuery.data?.agents ?? []);
  const collaborationMessages = compactDefined(collaborationQuery.data?.messages ?? []);
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
        return;
      }
      shouldFollowNewMessages.current = true;
    }
    if (chatScrollRef.current && shouldFollowNewMessages.current) {
      scrollChatToBottom(chatScrollRef.current);
    }
  }, [conversationId, activeView, messages, collaborationMessages]);

  useEffect(() => {
    if (!conversation || initializedFor.current === conversation.id) {
      return;
    }
    initializedFor.current = conversation.id;
    setEngine(
      conversation.defaultEngine ??
        engines.find((candidate) => candidate.authenticated)?.id ??
        engines[0]?.id ??
        "",
    );
    setModel(conversation.defaultModel ?? "");
    setEffort(conversation.defaultEffort ?? "");
  }, [conversation, engines]);

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
    mutationFn: async ({ text, files }: { text: string; files: File[] }) => {
      if (!conversation) {
        throw new Error("Master chat not loaded");
      }
      // Record the message in the shared pool, spawn a park-named agent on the
      // selected engine, and hand it the message as its first turn.
      const agent = await api.createAgent(conversation.projectId, conversationId, {
        title: pickAgentName((detailQuery.data?.agents ?? []).map((agent) => agent.title)),
        engine,
        model: model || undefined,
        effort: effort || undefined,
      });
      try {
        const attachments = await Promise.all(files.map((file) => api.uploadAttachment(agent.id, file)));
        await api.sendMessage(agent.id, {
          text,
          attachmentIds: attachments.map((item) => item.id),
          sourceChannel: "main",
          shareWithOrganization: true,
          sourceConversationId: conversationId,
          replyToMessageId: replyTo?.id,
        });
      } catch (error) {
        await api.deleteAgent(agent.id).catch(() => undefined);
        throw error;
      }
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
    mutationFn: async ({ agentIds, text, files, replyToMessageId, requestId }: { agentIds: string[]; text: string; files: File[]; replyToMessageId?: string; requestId: string }) => {
      const recipients = await Promise.all(agentIds.map(async (agentId) => {
        const attachments = await Promise.all(files.map((file) => api.uploadAttachment(agentId, file)));
        return { agentId, attachmentIds: attachments.map((item) => item.id) };
      }));
      return api.sendMultiAgentDirectMessage(conversationId, {
        text,
        recipients,
        replyToMessageId,
        idempotencyKey: requestId,
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
          ? `Queued for ${queuedTitles.join(", ")}; it will start when the current response finishes.`
          : undefined,
      );
      for (const agentId of variables.agentIds) {
        void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      }
    },
  });

  const broadcast = useMutation({
    mutationFn: ({ text, replyToMessageId }: { text: string; replyToMessageId?: string }) =>
      api.sendConversationMessage(conversationId, { text, replyToMessageId }),
    onSuccess: () => {
      clearReply();
      invalidate();
    },
  });

  const directReply = useMutation({
    mutationFn: async ({ targetId, text, files, replyToMessageId, requestId }: { targetId: string; text: string; files: File[]; replyToMessageId: string; requestId: string }) => {
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
      });
    },
    onSuccess: (response, variables) => {
      directReplyUploads.current.delete(variables.requestId);
      clearReply();
      invalidate();
      setQueuedReplyNotice(response.queued ? `Queued for ${agentTitle(response.targetAuthorAgentId)}; it will start when the current response finishes.` : undefined);
      void queryClient.invalidateQueries({ queryKey: ["agent", response.targetAuthorAgentId] });
    },
  });

  const sendReaction = useMutation({
    mutationFn: ({ communicationEventId, emoji, requestId }: { communicationEventId: string; emoji: string; requestId: string }) =>
      api.sendUserReaction({ projectId: conversation!.projectId, communicationEventId, emoji, idempotencyKey: requestId }),
    onSuccess: (response) => {
      invalidate();
      setQueuedReplyNotice(response.queued ? `Queued for ${agentTitle(response.targetAuthorAgentId)}; it will start when the current response finishes.` : undefined);
      void queryClient.invalidateQueries({ queryKey: ["agent", response.targetAuthorAgentId] });
    },
  });

  const collaborate = useMutation({
    mutationFn: ({ text, recipientAgentIds, replyToMessageId }: { text: string; recipientAgentIds: string[]; replyToMessageId?: string }) =>
      api.sendCollaborationMessage(conversationId, { text, recipientAgentIds, replyToMessageId }),
    onSuccess: () => {
      clearReply();
      void queryClient.invalidateQueries({ queryKey: ["collaboration-chat", conversationId] });
      if (conversation) void queryClient.invalidateQueries({ queryKey: ["agents", conversation.projectId] });
    },
  });

  const rename = useMutation({
    mutationFn: (title: string) => api.updateConversation(conversationId, { title }),
    onSuccess: () => {
      invalidate();
      setRenameOpen(false);
    },
  });

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

  const deleteAgent = useMutation({
    mutationFn: (agentId: string) => api.deleteAgent(agentId),
    onSuccess: (_data, agentId) => {
      queryClient.removeQueries({ queryKey: ["agent", agentId] });
      invalidate();
      setPendingDelete(undefined);
    },
  });

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
          This conversation could not be loaded. Check the server connection and try again.
        </Alert>
      </Box>
    );
  }

  if (!detailQuery.data || !conversation) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Master chat not found.</Alert>
      </Box>
    );
  }

  const activeEngine = engines.find((candidate) => candidate.id === engine);
  const commands: EngineCommand[] = [
    ...(engineCapabilities.find((item) => item.engineId === activeEngine?.id)?.commands ?? []),
  ];
  const models = activeEngine?.models ?? [];
  const efforts = activeEngine?.efforts ?? [];
  const engineReady = Boolean(activeEngine?.authenticated);

  const agentTitle = (agentId: string | undefined): string =>
    agents.find((agent) => agent.id === agentId)?.title ?? "Agent";
  const agentIdForHandle = (handle: string): string | undefined => agentIdForMentionHandle(agents, handle);
  const mentionHandles = activeView === "collaboration"
    ? [
        "everyone",
        ...agents.filter((agent) => !agent.archived).map((agent) => agentMentionHandle(agent.title)),
      ]
    : [
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
  const busy = spawn.isPending || reply.isPending || directReply.isPending || collaborate.isPending || broadcast.isPending;

  const submit = async (text: string, files: File[]) => {
    if (activeView === "collaboration") {
      if (files.length) throw new Error("Image attachments require a manager-to-agent message.");
      const activeAgents = agents.filter((agent) => !agent.archived);
      let targets = hasEveryoneMention(text) ? activeAgents : findMentionedAgentsStrict(text, activeAgents);
      if (targets.length === 0 && replyTo?.authorAgentId) {
        const author = activeAgents.find((agent) => agent.id === replyTo.authorAgentId);
        if (author) targets = [author];
      }
      if (targets.length === 0) throw new Error("Tag one unambiguous agent with #name, use #everyone, or reply to an agent message.");
      const messageText = stripCollaborationRoutingTags(text, activeAgents);
      if (!messageText) throw new Error("Add a message after the routing tag.");
      await collaborate.mutateAsync({ text: messageText, recipientAgentIds: targets.map((target) => target.id), replyToMessageId: replyTo?.id });
      return;
    }
    const broadcastText = managerBroadcastText(text);
    if (broadcastText !== undefined) {
      if (!broadcastText) throw new Error("Add informational context after #broadcast.");
      if (files.length) throw new Error("#broadcast does not currently support attachments.");
      await broadcast.mutateAsync({ text: broadcastText, replyToMessageId: replyTo?.id });
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
      await directReply.mutateAsync({
        targetId: route.agentIds[0],
        text,
        files,
        replyToMessageId: replyTo.id,
        requestId: directReplyRequestId,
      });
      return;
    }
    if (route.kind === "mentioned-reply") {
      await reply.mutateAsync({
        agentIds: route.agentIds,
        text,
        files,
        replyToMessageId: replyTo?.id,
        requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      });
    } else {
      await spawn.mutateAsync({ text, files });
    }
  };

  return (
    <Box data-testid="conversation" data-conversation-id={conversationId} sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
      <Box sx={{ px: { xs: 1, sm: 1.5, md: 2 }, py: { xs: 0.75, sm: 1.25 }, borderBottom: 1, borderColor: "divider" }}>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ alignItems: "center", minWidth: 0, flexWrap: { xs: "wrap", sm: "nowrap" } }}
        >
          <Box sx={{ minWidth: 0, flex: 1, flexBasis: { xs: "100%", sm: "auto" } }}>
            <Typography variant="h6" noWrap>
              {conversation.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap sx={{ display: { xs: "none", sm: "block" } }}>
              Team group chat · agents report back here when done or stuck
            </Typography>
          </Box>
          <Tooltip title="Rename">
            <IconButton
              aria-label="Rename conversation"
              sx={{ minWidth: 44, minHeight: 44 }}
              onClick={() => {
                setRenameValue(conversation.title);
                setRenameOpen(true);
              }}
            >
              <DriveFileRenameOutlineIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton aria-label="Delete conversation" color="error" onClick={() => setDeleteOpen(true)} sx={{ minWidth: 44, minHeight: 44 }}>
              <DeleteOutlineIcon />
            </IconButton>
          </Tooltip>
          <Button
            variant="outlined"
            size="small"
            startIcon={<GroupsOutlinedIcon />}
            onClick={() => setAgentsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={agentsOpen}
            aria-label={`View ${agents.length} agents`}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
          >
            <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>Agents </Box>({agents.length})
          </Button>
          <Button
            variant={activeView === "collaboration" ? "contained" : "outlined"}
            size="small"
            startIcon={<ForumOutlinedIcon />}
            onClick={() => {
              clearReply();
              setActiveView((current) => current === "main" ? "collaboration" : "main");
            }}
            aria-pressed={activeView === "collaboration"}
            aria-label={activeView === "collaboration" ? "Switch to project chat" : "Switch to team chat"}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
          >
            {activeView === "collaboration" ? "Project chat" : "Team chat"}
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => onNewAgent(conversation)}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
          >
            <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>New</Box>{" "}Agent
          </Button>
          <Button
            variant={runSetupOpen ? "contained" : "outlined"}
            size="small"
            startIcon={<TuneIcon />}
            onClick={() => setRunSetupOpen((open) => !open)}
            aria-expanded={runSetupOpen}
            aria-controls="master-run-setup"
            sx={{ display: compactViewport ? "inline-flex" : "none", minHeight: 44 }}
          >
            Setup
          </Button>
        </Stack>

        <Stack
          id="master-run-setup"
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ mt: 1, display: compactViewport && !runSetupOpen ? "none" : "flex" }}
        >
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 190 } }}>
            <InputLabel id="master-engine-label">Engine</InputLabel>
            <Select
              labelId="master-engine-label"
              label="Engine"
              value={engines.some((o) => o.id === engine) ? engine : ""}
              onChange={(event: SelectChangeEvent) => {
                const next = event.target.value;
                setEngine(next);
                setModel("");
                setEffort("");
                persistDefaults.mutate({
                  defaultEngine: next as EngineDto["id"],
                  defaultModel: null,
                  defaultEffort: null,
                });
              }}
            >
              {engines.map((option) => (
                <MenuItem key={option.id} value={option.id} disabled={!option.authenticated}>
                  {option.displayName}
                  {option.authenticated ? "" : " — not signed in"}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {models.length > 0 ? (
            <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 170 } }}>
              <InputLabel id="master-model-label">Model</InputLabel>
              <Select
                labelId="master-model-label"
                label="Model"
                value={models.some((o) => o.id === model) ? model : ""}
                onChange={(event: SelectChangeEvent) => {
                  const next = event.target.value;
                  setModel(next);
                  persistDefaults.mutate({ defaultModel: next || null });
                }}
              >
                <MenuItem value="">Engine default</MenuItem>
                {models.map((option) => (
                  <MenuItem key={option.id} value={option.id}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          {efforts.length > 0 ? (
            <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 150 } }}>
              <InputLabel id="master-effort-label">Effort</InputLabel>
              <Select
                labelId="master-effort-label"
                label="Effort"
                value={efforts.some((o) => o.id === effort) ? effort : ""}
                onChange={(event: SelectChangeEvent) => {
                  const next = event.target.value;
                  setEffort(next);
                  persistDefaults.mutate({ defaultEffort: next || null });
                }}
              >
                <MenuItem value="">Engine default</MenuItem>
                {efforts.map((option) => (
                  <MenuItem key={option.id} value={option.id}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
        </Stack>
      </Box>

      <Box
        ref={chatScrollRef}
        onScroll={() => {
          if (chatScrollRef.current) {
            shouldFollowNewMessages.current = isChatNearBottom(chatScrollRef.current);
            writeChatState(
              chatStateKey("scroll", `conversation.${conversationId}.${activeView}`),
              String(chatScrollRef.current.scrollTop),
            );
          }
        }}
        sx={{ minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" }}
      >
        <Box sx={{ p: { xs: 1, sm: 1.5 } }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {activeView === "collaboration" ? (
              <>This is a separate agent team chat. Tag an agent by name, reply to an agent message, or use <Box component="strong">#everyone</Box> for the current active room members.</>
            ) : (
              <>Chat normally to start a fresh agent with the conversation’s shared context. Use <Box component="strong">#</Box> for explicit routing or <Box component="strong">@</Box> to reference a project file when you need them.</>
            )}
          </Alert>
          {activeView === "main" && !engineReady ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              {activeEngine?.displayName ?? "The selected engine"} is not signed in. Sign in on the
              host, or pick a signed-in engine, before spawning agents.
            </Alert>
          ) : null}
          {activeView === "main" ? <MasterRespondingIndicator agents={agents} healthByAgentId={healthByAgentId} /> : null}

          <Stack spacing={1.25} sx={{ mb: 2 }}>
            {(activeView === "collaboration" ? collaborationMessages : messages).length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {activeView === "collaboration"
                  ? "No collaboration messages yet. Tag an agent to give them this chat's context."
                  : "No messages yet. Send a task to spawn your first agent — it reports back here when it finishes or gets stuck."}
              </Typography>
            ) : null}
            {(activeView === "collaboration" ? collaborationMessages : messages).map((message) => (
              <ConversationMessage
                key={message.id}
                message={message}
                conversation={activeView}
                agentTitle={agentTitle}
                agentIdForHandle={agentIdForHandle}
                compactViewport={compactViewport}
                onOpenAgent={onOpenAgent}
                onReply={(selected) => {
                  clearReply();
                  setReplyTo(selected);
                }}
                onDirectReply={(selected) => {
                  clearReply();
                  setReplyTo(selected);
                  setDirectReplyTargetId(selected.authorAgentId);
                  setDirectReplyRequestId(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
                }}
                onReact={(selected, emoji) => sendReaction.mutateAsync({
                  communicationEventId: selected.communicationEventId!,
                  emoji,
                  requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
                }).then(() => undefined)}
              />
            ))}
          </Stack>

        </Box>
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
        <Box sx={{ p: 2, minHeight: 0, overflow: "auto" }} role="dialog" aria-label="Agents in this conversation">
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
            <Typography variant="h6" sx={{ flex: 1 }}>Agents in this conversation</Typography>
            <Chip size="small" label={agents.length} />
          </Stack>
          {agents.length === 0 ? (
            <Alert severity="info">No agents yet. Send a message to spawn one.</Alert>
          ) : (
            <List dense disablePadding>
              {agents.map((agent) => {
                const status = statusByAgentId.get(agent.id) ?? "idle";
                return (
                  <ListItem
                    key={agent.id}
                    disablePadding
                    sx={{ mb: 0.5 }}
                    secondaryAction={
                      <Tooltip title="Delete agent">
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
                        onOpenAgent(agent.id);
                      }}
                      sx={{ borderRadius: 1, border: 1, borderColor: "divider", pr: 12 }}
                    >
                      <ListItemText
                        primary={agent.title}
                        secondary={`${agent.activeEngine} · updated ${relativeTime(agent.updatedAt)}`}
                        primaryTypographyProps={{ fontWeight: 700, noWrap: true }}
                        secondaryTypographyProps={{ noWrap: true }}
                      />
                      <Chip
                        size="small"
                        label={agentStatusLabel(status)}
                        color={agentStatusColor(status)}
                        sx={{ mr: 1 }}
                      />
                    </ListItemButton>
                  </ListItem>
                );
              })}
            </List>
          )}
        </Box>
      </Drawer>

      <Box>
        {queuedReplyNotice ? <Alert severity="info" sx={{ mx: 1.5, mt: 1 }}>{queuedReplyNotice}</Alert> : null}
        {spawn.isError || reply.isError || directReply.isError || collaborate.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Message not sent. {String((spawn.error ?? reply.error ?? directReply.error ?? collaborate.error) as Error)}
          </Alert>
        ) : null}
        {agents.length > 0 ? (
          <Box sx={{ px: { xs: 1, sm: 1.5 }, pt: 0.75, borderTop: 1, borderColor: "divider" }}>
            {activeView === "collaboration" ? (
              <Typography variant="caption" color="text.secondary">
                Agent #tags resolve to stable identities. Ambiguous names fail closed; #everyone is always explicit.
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">
                Type <Box component="strong">@</Box> to reply to an agent, or just send to spawn a new one.
              </Typography>
            )}
          </Box>
        ) : null}
        <Composer
          draftStorageKey={chatStateKey("draft", `conversation.${conversationId}.${activeView}`)}
          disabled={busy}
          running={false}
          mentionHandles={mentionHandles}
          commands={commands}
          busyMentionHandles={busyMentionHandles}
          allowUnmentionedSend={activeView === "collaboration" ? Boolean(replyTo?.authorAgentId) : engineReady}
          placeholder={
            activeView === "collaboration"
              ? replyTo?.authorAgentId ? `Reply to ${agentTitle(replyTo.authorAgentId)}` : "Tag #agent or #everyone"
              : engineReady
                ? `Describe a task — spawns an agent on ${activeEngine?.displayName ?? engine}`
                : "#tag an agent or use #broadcast for shared context"
          }
          onSend={submit}
          replyTo={replyTo}
          replyLabel={directReplyTargetId ? `Replying directly to #${agentMentionHandle(agentTitle(directReplyTargetId))}` : undefined}
          projectId={conversation.projectId}
          onCancelReply={() => {
            clearReply();
          }}
        />
      </Box>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Rename conversation</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Master chat name"
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

      <Dialog
        open={deleteOpen}
        onClose={() => {
          if (!deleteConversation.isPending) setDeleteOpen(false);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete conversation?</DialogTitle>
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

      <Dialog
        open={Boolean(pendingDelete)}
        onClose={() => {
          if (!deleteAgent.isPending) setPendingDelete(undefined);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete agent?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently deletes <Box component="strong">{pendingDelete?.title}</Box>, including
            its event log, tasks, and artifacts. Any in-flight run is stopped. This cannot be undone.
          </Typography>
          {deleteAgent.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(deleteAgent.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(undefined)} disabled={deleteAgent.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteAgent.isPending}
            onClick={() => {
              if (pendingDelete) deleteAgent.mutate(pendingDelete.id);
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
