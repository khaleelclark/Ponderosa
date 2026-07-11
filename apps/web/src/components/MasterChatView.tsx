import AddIcon from "@mui/icons-material/Add";
import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import TuneIcon from "@mui/icons-material/Tune";
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
  Link,
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
import type { EngineDto, MasterChatDto, MasterChatMessageDto, ThreadDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { compactDefined } from "../collections";
import { agentStatusColor, agentStatusLabel, relativeTime, type AgentStatus } from "../agents";
import { pickAgentName } from "../parkNames";
import { useCollaborationChat, useMasterChat } from "../hooks/queries";
import { agentMentionHandle, findMentionedAgents } from "../mentions";
import { compactViewportQuery } from "../responsive";
import { isSubagentUiEnabled, type SubagentUiBinding } from "../subagents";
import { ChatMarkdown, Composer, isChatNearBottom, scrollChatToBottom } from "./panes";
import { SubagentTreePanel } from "./SubagentTreePanel";
import { useSubagents } from "../hooks/useSubagents";

export function MasterChatView({
  masterChatId,
  engines,
  statusByAgentId,
  onOpenAgent,
  onNewAgent,
  onArchived,
  onDeleted,
  subagents,
}: {
  masterChatId: string;
  engines: EngineDto[];
  statusByAgentId: Map<string, AgentStatus>;
  onOpenAgent(agentId: string): void;
  onNewAgent(master: MasterChatDto): void;
  onArchived(): void;
  onDeleted(): void;
  /** Normalized UI binding; REST/SSE details stay in the future transport hook. */
  subagents?: SubagentUiBinding;
}): JSX.Element {
  const queryClient = useQueryClient();
  const detailQuery = useMasterChat(masterChatId);
  const collaborationQuery = useCollaborationChat(masterChatId);
  const [conversation, setConversation] = useState<"main" | "collaboration">("main");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ThreadDto | undefined>();
  const [queuedReplyNotice, setQueuedReplyNotice] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<MasterChatMessageDto | undefined>();
  const [runSetupOpen, setRunSetupOpen] = useState(false);

  // The engine/model/effort currently selected for this master chat. Model-agnostic:
  // it can change any time and only affects agents spawned *after* the change —
  // already-running agents keep the model they were spawned with.
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const initializedFor = useRef<string | undefined>(undefined);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowNewMessages = useRef(true);
  const displayedMasterChatId = useRef(masterChatId);
  const displayedConversation = useRef(conversation);
  const theme = useTheme();
  const mobileRoster = useMediaQuery(theme.breakpoints.down("sm"));
  const compactViewport = useMediaQuery(compactViewportQuery(theme.breakpoints.down("sm")));
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const showSubagents = isSubagentUiEnabled(env);
  const liveSubagents = useSubagents(masterChatId, showSubagents);
  const subagentBinding = subagents ?? liveSubagents;

  const masterChat = detailQuery.data?.masterChat;
  // Live query updates can briefly leave sparse entries in cached collections.
  // Compact at the page boundary so historical chats remain renderable.
  const messages = compactDefined(detailQuery.data?.messages ?? []);
  const threads = compactDefined(detailQuery.data?.threads ?? []);
  const collaborationMessages = compactDefined(collaborationQuery.data?.messages ?? []);
  useLayoutEffect(() => {
    if (
      displayedMasterChatId.current !== masterChatId ||
      displayedConversation.current !== conversation
    ) {
      displayedMasterChatId.current = masterChatId;
      displayedConversation.current = conversation;
      shouldFollowNewMessages.current = true;
    }
    if (chatScrollRef.current && shouldFollowNewMessages.current) {
      scrollChatToBottom(chatScrollRef.current);
    }
  }, [masterChatId, conversation, messages, collaborationMessages]);

  useEffect(() => {
    if (!masterChat || initializedFor.current === masterChat.id) {
      return;
    }
    initializedFor.current = masterChat.id;
    setEngine(
      masterChat.defaultEngine ??
        engines.find((candidate) => candidate.authenticated)?.id ??
        engines[0]?.id ??
        "",
    );
    setModel(masterChat.defaultModel ?? "");
    setEffort(masterChat.defaultEffort ?? "");
  }, [masterChat, engines]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["master-chat", masterChatId] });
    void queryClient.invalidateQueries({ queryKey: ["master-chats"] });
    void queryClient.invalidateQueries({ queryKey: ["collaboration-chat", masterChatId] });
    if (masterChat) {
      void queryClient.invalidateQueries({ queryKey: ["threads", masterChat.projectId] });
    }
  };

  // Persist the selection so "the model selected for this master chat" survives
  // reloads and prefills the New Agent dialog.
  const persistDefaults = useMutation({
    mutationFn: (patch: {
      defaultEngine?: EngineDto["id"];
      defaultModel?: string | null;
      defaultEffort?: string | null;
    }) => api.updateMasterChat(masterChatId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["master-chat", masterChatId] });
      void queryClient.invalidateQueries({ queryKey: ["master-chats"] });
    },
  });

  const spawn = useMutation({
    mutationFn: async ({ text, files }: { text: string; files: File[] }) => {
      if (!masterChat) {
        throw new Error("Master chat not loaded");
      }
      // Record the message in the shared pool, spawn a park-named agent on the
      // selected engine, and hand it the message as its first turn.
      const agent = await api.createAgent(masterChat.projectId, masterChatId, {
        title: pickAgentName((detailQuery.data?.threads ?? []).map((thread) => thread.title)),
        engine,
        model: model || undefined,
        effort: effort || undefined,
      });
      try {
        const attachments = await Promise.all(files.map((file) => api.uploadAttachment(agent.id, file)));
        await api.sendMasterChatMessage(masterChatId, { text, attachments, replyToMessageId: replyTo?.id });
        await api.sendMessage(agent.id, { text, attachmentIds: attachments.map((item) => item.id), sourceChannel: "main" });
      } catch (error) {
        await api.deleteThread(agent.id).catch(() => undefined);
        throw error;
      }
      return agent;
    },
    onSuccess: () => {
      setReplyTo(undefined);
      invalidate();
    },
  });

  // Route a message to an existing agent (a follow-up turn) instead of spawning.
  // Recorded in the shared pool so it stays as context for future agents.
  const reply = useMutation({
    mutationFn: async ({ agentIds, text, files, replyToMessageId }: { agentIds: string[]; text: string; files: File[]; replyToMessageId?: string }) => {
      const perAgent = await Promise.all(agentIds.map(async (agentId) => {
        const attachments = await Promise.all(files.map((file) => api.uploadAttachment(agentId, file)));
        return { agentId, attachments };
      }));
      await api.sendMasterChatMessage(masterChatId, { text, attachments: perAgent[0]?.attachments, replyToMessageId });
      return Promise.all(perAgent.map(({ agentId, attachments }) => api.sendMessage(agentId, {
        text,
        attachmentIds: attachments.map((item) => item.id),
        sourceChannel: "main",
        sourceMasterChatId: masterChatId,
      })));
    },
    onSuccess: (responses, variables) => {
      setReplyTo(undefined);
      invalidate();
      const queuedTitles = variables.agentIds
        .filter((_, index) => responses[index]?.queued)
        .map((agentId) => detailQuery.data?.threads.find((thread) => thread.id === agentId)?.title ?? "Agent");
      setQueuedReplyNotice(
        queuedTitles.length > 0
          ? `Queued for ${queuedTitles.join(", ")}; it will start when the current response finishes.`
          : undefined,
      );
      for (const agentId of variables.agentIds) {
        void queryClient.invalidateQueries({ queryKey: ["thread", agentId] });
      }
    },
  });

  const collaborate = useMutation({
    mutationFn: ({ text, replyToMessageId }: { text: string; replyToMessageId?: string }) => api.sendCollaborationMessage(masterChatId, { text, replyToMessageId }),
    onSuccess: () => {
      setReplyTo(undefined);
      void queryClient.invalidateQueries({ queryKey: ["collaboration-chat", masterChatId] });
      if (masterChat) void queryClient.invalidateQueries({ queryKey: ["threads", masterChat.projectId] });
    },
  });

  const rename = useMutation({
    mutationFn: (title: string) => api.updateMasterChat(masterChatId, { title }),
    onSuccess: () => {
      invalidate();
      setRenameOpen(false);
    },
  });

  const archive = useMutation({
    mutationFn: () => api.updateMasterChat(masterChatId, { archived: true }),
    onSuccess: () => {
      invalidate();
      setArchiveOpen(false);
      onArchived();
    },
  });

  const deleteMasterChat = useMutation({
    mutationFn: () => api.deleteMasterChat(masterChatId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["master-chat", masterChatId] });
      void queryClient.invalidateQueries({ queryKey: ["master-chats"] });
      void queryClient.invalidateQueries({ queryKey: ["threads", masterChat?.projectId] });
      setDeleteOpen(false);
      onDeleted();
    },
  });

  const deleteAgent = useMutation({
    mutationFn: (agentId: string) => api.deleteThread(agentId),
    onSuccess: (_data, agentId) => {
      queryClient.removeQueries({ queryKey: ["thread", agentId] });
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
          This master chat could not be loaded. Check the server connection and try again.
        </Alert>
      </Box>
    );
  }

  if (!detailQuery.data || !masterChat) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Master chat not found.</Alert>
      </Box>
    );
  }

  const activeEngine = engines.find((candidate) => candidate.id === engine);
  const models = activeEngine?.models ?? [];
  const efforts = activeEngine?.efforts ?? [];
  const engineReady = Boolean(activeEngine?.authenticated);

  const agentTitle = (threadId: string | undefined): string =>
    threads.find((thread) => thread.id === threadId)?.title ?? "Agent";
  const mentionHandles = conversation === "collaboration"
    ? ["everyone", ...threads.filter((thread) => !thread.archived).map((thread) => agentMentionHandle(thread.title))]
    : threads.filter((thread) => !thread.archived).map((thread) => agentMentionHandle(thread.title));
  const findMentioned = (text: string): ThreadDto[] => findMentionedAgents(text, threads);

  const busyMentionHandles = threads
    .filter((agent) => statusByAgentId.get(agent.id) === "running")
    .map((agent) => agentMentionHandle(agent.title));
  const busy = spawn.isPending || reply.isPending || collaborate.isPending;

  const submit = async (text: string, files: File[]) => {
    if (conversation === "collaboration") {
      if (files.length) throw new Error("Image attachments require a manager-to-agent message.");
      await collaborate.mutateAsync({ text, replyToMessageId: replyTo?.id });
      return;
    }
    const targets = findMentioned(text);
    if (targets.length > 0) {
      await reply.mutateAsync({ agentIds: targets.map((target) => target.id), text, files, replyToMessageId: replyTo?.id });
    } else {
      await spawn.mutateAsync({ text, files });
    }
  };

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
      <Box sx={{ px: { xs: 1, sm: 1.5, md: 2 }, py: { xs: 0.75, sm: 1.25 }, borderBottom: 1, borderColor: "divider" }}>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ alignItems: "center", minWidth: 0, flexWrap: { xs: "wrap", sm: "nowrap" } }}
        >
          <Box sx={{ minWidth: 0, flex: 1, flexBasis: { xs: "100%", sm: "auto" } }}>
            <Typography variant="h6" noWrap>
              {masterChat.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap sx={{ display: { xs: "none", sm: "block" } }}>
              Team group chat · agents report back here when done or stuck
            </Typography>
          </Box>
          <Tooltip title="Rename">
            <IconButton
              aria-label="Rename master chat"
              sx={{ minWidth: 44, minHeight: 44 }}
              onClick={() => {
                setRenameValue(masterChat.title);
                setRenameOpen(true);
              }}
            >
              <DriveFileRenameOutlineIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Archive">
            <IconButton aria-label="Archive master chat" onClick={() => setArchiveOpen(true)} sx={{ minWidth: 44, minHeight: 44 }}>
              <ArchiveOutlinedIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton aria-label="Delete master chat" color="error" onClick={() => setDeleteOpen(true)} sx={{ minWidth: 44, minHeight: 44 }}>
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
            aria-label={`View ${threads.length} agents`}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
          >
            <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>Agents </Box>({threads.length})
          </Button>
          <Button
            variant={conversation === "collaboration" ? "contained" : "outlined"}
            size="small"
            startIcon={<ForumOutlinedIcon />}
            onClick={() => {
              setReplyTo(undefined);
              setConversation((current) => current === "main" ? "collaboration" : "main");
            }}
            aria-pressed={conversation === "collaboration"}
            aria-label={conversation === "collaboration" ? "Switch to main chat" : "Switch to collaboration chat"}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
          >
            {conversation === "collaboration" ? "Main" : "Collab"}
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => onNewAgent(masterChat)}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
          >
            <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>New </Box>Agent
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
          }
        }}
        sx={{ minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" }}
      >
        <Box sx={{ p: { xs: 1, sm: 1.5 } }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {conversation === "collaboration" ? (
              <>This is a separate, opt-in agent collaboration chat. A valid <Box component="strong">@mention</Box> notifies one agent; <Box component="strong">@everyone</Box> queues one notification for every active room member. Interrupted delivery turns may retry. Untagged messages stay here.</>
            ) : (
              <>This is your team's group chat. A plain message spawns a new agent on the selected engine; <Box component="strong">@mention</Box> an agent to reply to it instead. Replies to busy agents queue automatically.</>
            )}
          </Alert>
          {conversation === "main" && !engineReady ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              {activeEngine?.displayName ?? "The selected engine"} is not signed in. Sign in on the
              host, or pick a signed-in engine, before spawning agents.
            </Alert>
          ) : null}

          <Stack spacing={1.25} sx={{ mb: 2 }}>
            {conversation === "collaboration" && showSubagents && subagentBinding ? (
              <SubagentTreePanel
                store={subagentBinding.store}
                cancelling={subagentBinding.cancelling}
                onCancel={subagentBinding.cancel}
                onOpenAgent={onOpenAgent}
              />
            ) : null}
            {(conversation === "collaboration" ? collaborationMessages : messages).length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {conversation === "collaboration"
                  ? "No collaboration messages yet. @mention an agent to give it this chat's context."
                  : "No messages yet. Send a task to spawn your first agent — it reports back here when it finishes or gets stuck."}
              </Typography>
            ) : null}
            {(conversation === "collaboration" ? collaborationMessages : messages).map((message) => {
              const fromManager = !message.authorThreadId;
              return (
                <Box
                  key={message.id}
                  id={`master-message-${message.id}`}
                  tabIndex={-1}
                  sx={{ alignSelf: fromManager ? "flex-end" : "flex-start", maxWidth: { xs: "96%", sm: "min(680px, 92%)" }, minWidth: 0 }}
                >
                  {message.authorThreadId ? (
                    <Link
                      component="button"
                      variant="caption"
                      onClick={() => onOpenAgent(message.authorThreadId!)}
                      sx={{ display: "block", mb: 0.25, ml: 0.5, fontWeight: 700 }}
                    >
                      {agentTitle(message.authorThreadId)}
                    </Link>
                  ) : null}
                  <Box
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
                    {message.replyTo ? (
                      <Box component="button" aria-label="Go to replied-to message" onClick={() => {
                        const target = document.getElementById(`master-message-${message.replyTo!.messageId}`);
                        target?.scrollIntoView({ behavior: "smooth", block: "center" });
                        target?.focus({ preventScroll: true });
                      }} sx={{ display: "block", width: "100%", mb: .75, p: .75, border: 0, borderLeft: 3, borderColor: "currentColor", bgcolor: "rgba(127,127,127,.14)", color: "inherit", textAlign: "left", cursor: "pointer", borderRadius: 1 }}>
                        <Typography variant="caption" component="div" noWrap>{message.replyTo.text || "Original message unavailable"}</Typography>
                      </Box>
                    ) : null}
                    <ChatMarkdown>{message.text}</ChatMarkdown>
                    {message.attachments?.length ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: message.text ? 1 : 0 }}>
                      {message.attachments.map((attachment) => <Box key={attachment.id} component="a" href={attachment.url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}>
                        <Box component="img" src={attachment.url} alt={attachment.name} sx={{ display: "block", maxWidth: 220, maxHeight: 180, objectFit: "contain", borderRadius: 1 }} />
                      </Box>)}
                    </Stack> : null}
                    <Button size="small" color="inherit" onClick={() => setReplyTo(message)} sx={{ mt: .5 }}>Reply</Button>
                  </Box>
                </Box>
              );
            })}
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
        <Box sx={{ p: 2, minHeight: 0, overflow: "auto" }} role="dialog" aria-label="Agents in this master chat">
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
            <Typography variant="h6" sx={{ flex: 1 }}>Agents in this master chat</Typography>
            <Chip size="small" label={threads.length} />
          </Stack>
          {threads.length === 0 ? (
            <Alert severity="info">No agents yet. Send a message to spawn one.</Alert>
          ) : (
            <List dense disablePadding>
              {threads.map((agent) => {
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
        {spawn.isError || reply.isError || collaborate.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Message not sent. {String((spawn.error ?? reply.error ?? collaborate.error) as Error)}
          </Alert>
        ) : null}
        {threads.length > 0 ? (
          <Box sx={{ px: { xs: 1, sm: 1.5 }, pt: 0.75, borderTop: 1, borderColor: "divider" }}>
            {conversation === "collaboration" ? (
              <Typography variant="caption" color="text.secondary">
                Only valid <Box component="strong">@mentions</Box> receive this collaboration chat's context. Use <Box component="strong">@everyone</Box> to notify every active room member.
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">
                Type <Box component="strong">@</Box> to reply to an agent, or just send to spawn a new one.
              </Typography>
            )}
          </Box>
        ) : null}
        <Composer
          disabled={busy}
          running={false}
          mentionHandles={mentionHandles}
          busyMentionHandles={busyMentionHandles}
          allowUnmentionedSend={conversation === "collaboration" || engineReady}
          placeholder={
            conversation === "collaboration"
              ? "@mention agents to collaborate — untagged messages stay private to this chat"
              : engineReady
                ? `Describe a task — spawns an agent on ${activeEngine?.displayName ?? engine}`
                : "@mention an agent, or select a signed-in engine to spawn one"
          }
          onSend={submit}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(undefined)}
        />
      </Box>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Rename master chat</DialogTitle>
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

      <Dialog open={archiveOpen} onClose={() => setArchiveOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Archive master chat?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            <Box component="strong">{masterChat.title}</Box> will be hidden from the sidebar. Its
            agents keep running and remain visible in the Agents tab.
          </Typography>
          {archive.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(archive.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setArchiveOpen(false)} disabled={archive.isPending}>
            Cancel
          </Button>
          <Button color="warning" variant="contained" disabled={archive.isPending} onClick={() => archive.mutate()}>
            Archive
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          if (!deleteMasterChat.isPending) setDeleteOpen(false);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete master chat?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently deletes <Box component="strong">{masterChat.title}</Box> and its chat
            history. Its agents are preserved in the Agents tab as unassigned agents. This cannot be undone.
          </Typography>
          {deleteMasterChat.isError ? (
            <Alert severity="error" sx={{ mt: 1 }}>{String(deleteMasterChat.error)}</Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleteMasterChat.isPending}>Cancel</Button>
          <Button color="error" variant="contained" disabled={deleteMasterChat.isPending} onClick={() => deleteMasterChat.mutate()}>
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
