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
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  agentNameFromMessage,
  agentStatusColor,
  agentStatusLabel,
  relativeTime,
  type AgentStatus,
} from "../agents";
import { useMasterChat } from "../hooks/queries";
import { Composer } from "./panes";

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

  // The engine/model/effort currently selected for this master chat. Model-agnostic:
  // it can change any time and only affects agents spawned *after* the change —
  // already-running agents keep the model they were spawned with.
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const initializedFor = useRef<string | undefined>(undefined);

  const masterChat = detailQuery.data?.masterChat;

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
      // Record the message in the shared pool, spawn a named agent on the selected
      // engine, and hand it the message as its first turn so it starts working.
      await api.sendMasterChatMessage(masterChatId, { text });
      const agent = await api.createAgent(masterChat.projectId, masterChatId, {
        title: agentNameFromMessage(text),
        engine,
        model: model || undefined,
        effort: effort || undefined,
      });
      await api.sendMessage(agent.id, { text, model: model || undefined, effort: effort || undefined });
      return agent;
    },
    onSuccess: invalidate,
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

  if (!detailQuery.data || !masterChat) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Master chat not found.</Alert>
      </Box>
    );
  }

  const { messages, threads } = detailQuery.data;
  const activeEngine = engines.find((candidate) => candidate.id === engine);
  const models = activeEngine?.models ?? [];
  const efforts = activeEngine?.efforts ?? [];
  const engineReady = Boolean(activeEngine?.authenticated);

  return (
    <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto 1fr auto" }}>
      <Box sx={{ px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" noWrap>
              {masterChat.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              Model-agnostic control room · new messages spawn an agent
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

      <Box sx={{ minHeight: 0, overflow: "auto" }}>
        <Box sx={{ p: 1.5 }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            Each message here spawns a new agent on the selected engine and hands it that message
            as its first task. Spawning many agents is fine — this room is never locked. Changing the
            engine only affects agents you spawn afterwards; running agents keep their model. Delete an
            agent any time to stop and remove it.
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
                No messages yet. Send a task to spawn your first agent.
              </Typography>
            ) : null}
            {messages.map((message) => (
              <Box
                key={message.id}
                sx={{
                  alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "min(680px, 92%)",
                  px: 1.5,
                  py: 1,
                  borderRadius: 2,
                  bgcolor: message.role === "user" ? "primary.main" : "background.paper",
                  color: message.role === "user" ? "primary.contrastText" : "text.primary",
                  border: message.role === "user" ? 0 : 1,
                  borderColor: "divider",
                }}
              >
                <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {message.text}
                </Typography>
              </Box>
            ))}
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

      <Composer
        disabled={spawn.isPending || !engineReady}
        running={false}
        placeholder={
          engineReady
            ? `Describe a task — spawns an agent on ${activeEngine?.displayName ?? engine}`
            : "Select a signed-in engine to spawn agents"
        }
        onSend={(text) => spawn.mutate(text)}
      />

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
