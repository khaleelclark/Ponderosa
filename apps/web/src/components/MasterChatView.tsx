import AddIcon from "@mui/icons-material/Add";
import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
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
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { EngineDto, MasterChatDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { agentStatusColor, agentStatusLabel, relativeTime, type AgentStatus } from "../agents";
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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["master-chat", masterChatId] });
    void queryClient.invalidateQueries({ queryKey: ["master-chats"] });
  };

  const sendMessage = useMutation({
    mutationFn: (text: string) => api.sendMasterChatMessage(masterChatId, { text }),
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

  if (detailQuery.isLoading) {
    return (
      <Box sx={{ p: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (!detailQuery.data) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Master chat not found.</Alert>
      </Box>
    );
  }

  const { masterChat, messages, threads } = detailQuery.data;
  const defaults = [
    masterChat.defaultEngine ? `Engine: ${masterChat.defaultEngine}` : null,
    masterChat.defaultModel ? `Model: ${masterChat.defaultModel}` : null,
    masterChat.defaultEffort ? `Effort: ${masterChat.defaultEffort}` : null,
  ].filter(Boolean);

  return (
    <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto 1fr auto" }}>
      <Box sx={{ px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" noWrap>
              {masterChat.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {defaults.length > 0 ? defaults.join(" · ") : "Model-agnostic · agents choose any engine"}
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
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => onNewAgent(masterChat)}
          >
            New Agent
          </Button>
        </Stack>
      </Box>

      <Box sx={{ minHeight: 0, overflow: "auto" }}>
        <Box sx={{ p: 1.5 }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            This is a shared context pool. Messages here are recorded for reference and inherited
            by new agents — they don't automatically interpret your message or launch an agent yet.
            Spawn an agent to do work.
          </Alert>

          <Stack spacing={1.25} sx={{ mb: 2 }}>
            {messages.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No messages yet. Capture goals, constraints, or context for the agents you spawn here.
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
            <Alert severity="info">No agents yet. Use “New Agent” to spawn one with these defaults.</Alert>
          ) : (
            <List dense disablePadding>
              {threads.map((agent) => {
                const status = statusByAgentId.get(agent.id) ?? "idle";
                return (
                  <ListItem key={agent.id} disablePadding sx={{ mb: 0.5 }}>
                    <ListItemButton
                      onClick={() => onOpenAgent(agent.id)}
                      sx={{ borderRadius: 1, border: 1, borderColor: "divider" }}
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
        disabled={sendMessage.isPending}
        running={false}
        placeholder="Add context or notes for agents spawned here"
        onSend={(text) => sendMessage.mutate(text)}
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
    </Box>
  );
}
