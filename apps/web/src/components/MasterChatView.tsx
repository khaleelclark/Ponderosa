import AddIcon from "@mui/icons-material/Add";
import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
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
  Divider,
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
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { EngineDto, MasterChatDto, ThreadDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { agentStatusColor, agentStatusLabel, relativeTime, type AgentStatus } from "../agents";
import { pickAgentName } from "../parkNames";
import { useMasterChat } from "../hooks/queries";
import { agentMentionHandle, findMentionedAgents } from "../mentions";
import { Composer, scrollChatToBottom } from "./panes";

export function MasterChatView({
  masterChatId,
  engines,
  statusByAgentId,
  onOpenAgent,
  onNewAgent,
  onArchived,
}: {
  masterChatId: string;
  engines: EngineDto[];
  statusByAgentId: Map<string, AgentStatus>;
  onOpenAgent(agentId: string): void;
  onNewAgent(master: MasterChatDto): void;
  onArchived(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const detailQuery = useMasterChat(masterChatId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ThreadDto | undefined>();
  // Mirror of the composer text so we can show a live @mention target + guard.
  // A message with no @mention spawns a new agent; @Handle routes to that agent.
  const [composerText, setComposerText] = useState("");

  // The engine/model/effort currently selected for this master chat. Model-agnostic:
  // it can change any time and only affects agents spawned *after* the change —
  // already-running agents keep the model they were spawned with.
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const initializedFor = useRef<string | undefined>(undefined);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const masterChat = detailQuery.data?.masterChat;
  const messages = detailQuery.data?.messages ?? [];

  useLayoutEffect(() => {
    if (chatScrollRef.current) {
      scrollChatToBottom(chatScrollRef.current);
    }
  }, [messages]);

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
    mutationFn: async (text: string) => {
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
        initialMessage: text,
      });
      return agent;
    },
    onSuccess: invalidate,
  });

  // Route a message to an existing agent (a follow-up turn) instead of spawning.
  // Recorded in the shared pool so it stays as context for future agents.
  const reply = useMutation({
    mutationFn: async ({ agentIds, text }: { agentIds: string[]; text: string }) => {
      await api.sendMasterChatMessage(masterChatId, { text });
      await Promise.all(agentIds.map((agentId) => api.sendMessage(agentId, { text })));
    },
    onSuccess: (_data, variables) => {
      invalidate();
      for (const agentId of variables.agentIds) {
        void queryClient.invalidateQueries({ queryKey: ["thread", agentId] });
      }
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

  const { threads } = detailQuery.data;
  const activeEngine = engines.find((candidate) => candidate.id === engine);
  const models = activeEngine?.models ?? [];
  const efforts = activeEngine?.efforts ?? [];
  const engineReady = Boolean(activeEngine?.authenticated);

  const agentTitle = (threadId: string | undefined): string =>
    threads.find((thread) => thread.id === threadId)?.title ?? "Agent";
  const mentionHandles = threads.map((thread) => agentMentionHandle(thread.title));
  const findMentioned = (text: string): ThreadDto[] => findMentionedAgents(text, threads);

  // Live target derived from what's currently typed (for the hint + guard).
  const mentioned = findMentioned(composerText);
  const mentionedRunning = mentioned.some((agent) => statusByAgentId.get(agent.id) === "running");
  const mentionedHandles = mentioned.map((agent) => `@${agentMentionHandle(agent.title)}`).join(", ");
  const busyHandles = mentioned
    .filter((agent) => statusByAgentId.get(agent.id) === "running")
    .map((agent) => `@${agentMentionHandle(agent.title)}`)
    .join(", ");
  // Replying to an existing agent needs it idle (routing a turn to a running agent
  // is the steering case, deferred). Spawning a new agent needs a signed-in engine.
  const canSend = mentioned.length > 0 ? !mentionedRunning : engineReady;
  const busy = spawn.isPending || reply.isPending;

  const submit = (text: string) => {
    const targets = findMentioned(text);
    if (targets.length > 0) {
      if (targets.some((target) => statusByAgentId.get(target.id) === "running")) return;
      reply.mutate({ agentIds: targets.map((target) => target.id), text });
    } else {
      spawn.mutate(text);
    }
  };

  return (
    <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto 1fr auto" }}>
      <Box sx={{ px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", minWidth: 0, flexWrap: { xs: "wrap", sm: "nowrap" } }}
        >
          <Box sx={{ minWidth: 0, flex: 1, flexBasis: { xs: "100%", sm: "auto" } }}>
            <Typography variant="h6" noWrap>
              {masterChat.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              Team group chat · agents report back here when done or stuck
            </Typography>
          </Box>
          <Tooltip title="Rename">
            <IconButton
              aria-label="Rename master chat"
              onClick={() => {
                setRenameValue(masterChat.title);
                setRenameOpen(true);
              }}
            >
              <DriveFileRenameOutlineIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Archive">
            <IconButton aria-label="Archive master chat" onClick={() => setArchiveOpen(true)}>
              <ArchiveOutlinedIcon />
            </IconButton>
          </Tooltip>
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => onNewAgent(masterChat)}
          >
            New Agent
          </Button>
        </Stack>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
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

      <Box ref={chatScrollRef} sx={{ minHeight: 0, overflow: "auto" }}>
        <Box sx={{ p: 1.5 }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            This is your team's group chat. A plain message spawns a new agent on the selected engine;
            <Box component="strong"> @mention</Box> an agent to reply to it instead. Agents post back
            here when they finish or get stuck, and everything stays as shared context for future agents.
          </Alert>
          {!engineReady ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              {activeEngine?.displayName ?? "The selected engine"} is not signed in. Sign in on the
              host, or pick a signed-in engine, before spawning agents.
            </Alert>
          ) : null}

          <Stack spacing={1.25} sx={{ mb: 2 }}>
            {messages.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No messages yet. Send a task to spawn your first agent — it reports back here when
                it finishes or gets stuck.
              </Typography>
            ) : null}
            {messages.map((message) => {
              const fromManager = !message.authorThreadId;
              return (
                <Box
                  key={message.id}
                  sx={{ alignSelf: fromManager ? "flex-end" : "flex-start", maxWidth: "min(680px, 92%)" }}
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
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {message.text}
                    </Typography>
                  </Box>
                </Box>
              );
            })}
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", mb: 1 }}>
            <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
              Agents in this master chat
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {threads.length}
            </Typography>
          </Stack>
          {threads.length === 0 ? (
            <Alert severity="info">No agents yet. Send a message above to spawn one.</Alert>
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
                      onClick={() => onOpenAgent(agent.id)}
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
      </Box>

      <Box>
        {spawn.isError || reply.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Message not sent. {String((spawn.error ?? reply.error) as Error)}
          </Alert>
        ) : null}
        {(mentioned.length > 0 || threads.length > 0) ? (
          <Box sx={{ px: 1.5, pt: 1, borderTop: 1, borderColor: "divider" }}>
            {mentioned.length > 0 ? (
              mentionedRunning ? (
                <Typography variant="caption" color="warning.main">
                  {busyHandles} {busyHandles.includes(",") ? "are" : "is"} busy — replying to a running agent needs steering
                  (coming soon). Wait for it to finish, or send without a mention to spawn a new agent.
                </Typography>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Replying to <Box component="strong">{mentionedHandles}</Box>
                </Typography>
              )
            ) : (
              <Typography variant="caption" color="text.secondary">
                Type <Box component="strong">@</Box> to reply to an agent, or just send to spawn a new one.
              </Typography>
            )}
          </Box>
        ) : null}
        <Composer
          disabled={busy || !canSend}
          running={false}
          mentionHandles={mentionHandles}
          onChangeText={setComposerText}
          placeholder={
            mentioned.length > 0
              ? mentionedRunning
                ? `${busyHandles} ${busyHandles.includes(",") ? "are" : "is"} busy`
                : `Reply to ${mentionedHandles}`
              : engineReady
                ? `Describe a task — spawns an agent on ${activeEngine?.displayName ?? engine}`
                : "Select a signed-in engine to spawn agents"
          }
          onSend={submit}
        />
      </Box>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Rename master chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
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
