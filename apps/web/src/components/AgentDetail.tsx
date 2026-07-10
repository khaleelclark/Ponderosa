import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DifferenceIcon from "@mui/icons-material/Difference";
import TerminalIcon from "@mui/icons-material/Terminal";
import TimelineIcon from "@mui/icons-material/Timeline";
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
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  Link,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { EngineDto, MasterChatDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { agentStatusColor, agentStatusLabel, deriveAgentStatus } from "../agents";
import { useThread } from "../hooks/queries";
import { useSendMessage } from "../hooks/useSendMessage";
import { useThreadStream } from "../hooks/useThreadStream";
import { ArtifactsPane, ChatPane, Composer, LiveLogPane, TasksPane } from "./panes";

type AgentTab = "chat" | "log" | "tasks" | "artifacts";

export function AgentDetail({
  agentId,
  engines,
  masterChats,
  onBack,
  onOpenMaster,
  onDeleted,
}: {
  agentId: string;
  engines: EngineDto[];
  masterChats: MasterChatDto[];
  onBack(): void;
  onOpenMaster(masterChatId: string): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const threadQuery = useThread(agentId);
  const stream = useThreadStream(agentId);
  const sendMessage = useSendMessage(agentId);
  const [tab, setTab] = useState<AgentTab>("chat");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const detail = threadQuery.data;
  const engine =
    engines.find((candidate) => candidate.id === detail?.thread.activeEngine) ?? engines[0];

  useEffect(() => {
    if (!engine) {
      setModel("");
      setEffort("");
      return;
    }
    setModel((current) => (current === "" || engine.models.some((o) => o.id === current) ? current : ""));
    setEffort((current) => (current === "" || engine.efforts.some((o) => o.id === current) ? current : ""));
  }, [engine]);

  const running = stream.running || sendMessage.isPending;

  const errorHint = useMemo(
    () => stream.timeline.at(-1)?.event.type === "error",
    [stream.timeline],
  );
  const status = deriveAgentStatus(detail, { running: stream.running, error: errorHint });

  const cancelRun = useMutation({
    mutationFn: () => api.cancelRun(agentId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["thread", agentId] }),
  });

  const deleteAgent = useMutation({
    mutationFn: () => api.deleteThread(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.removeQueries({ queryKey: ["thread", agentId] });
      setDeleteOpen(false);
      onDeleted();
    },
  });

  if (threadQuery.isLoading) {
    return (
      <Box sx={{ p: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (!detail) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Agent not found.</Alert>
      </Box>
    );
  }

  const models = engine?.models ?? [];
  const efforts = engine?.efforts ?? [];
  const master = detail.thread.masterChatId
    ? masterChats.find((candidate) => candidate.id === detail.thread.masterChatId)
    : undefined;

  const panes: Record<AgentTab, JSX.Element> = {
    chat: <ChatPane messages={detail.messages} />,
    log: <LiveLogPane timeline={stream.timeline} connected={stream.connected} running={stream.running} />,
    tasks: <TasksPane tasks={detail.tasks} timeline={stream.timeline} />,
    artifacts: <ArtifactsPane artifacts={detail.artifacts} threadId={detail.thread.id} timeline={stream.timeline} />,
  };

  return (
    <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto auto 1fr auto" }}>
      <Box sx={{ px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          <Tooltip title="Back to agents">
            <IconButton aria-label="Back to agents" onClick={onBack} edge="start">
              <ArrowBackIcon />
            </IconButton>
          </Tooltip>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" noWrap>
              {detail.thread.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {detail.state.branch ?? "No branch"} {detail.state.commit ? `· ${detail.state.commit}` : ""}
              {master ? (
                <>
                  {" · "}
                  <Link component="button" variant="body2" onClick={() => onOpenMaster(master.id)}>
                    {master.title}
                  </Link>
                </>
              ) : (
                " · Unassigned"
              )}
            </Typography>
          </Box>
          <Chip size="small" label={agentStatusLabel(status)} color={agentStatusColor(status)} />
          <Chip
            size="small"
            label={stream.connected ? "Live" : "Reconnecting"}
            color={stream.connected ? "success" : "warning"}
            variant={stream.connected ? "filled" : "outlined"}
          />
          {running ? (
            <Button size="small" color="error" variant="outlined" onClick={() => cancelRun.mutate()}>
              Cancel
            </Button>
          ) : null}
          <Tooltip title="Delete agent">
            <IconButton aria-label="Delete agent" onClick={() => setDeleteOpen(true)}>
              <DeleteOutlineIcon />
            </IconButton>
          </Tooltip>
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
          <Chip
            label={`${engine?.displayName ?? detail.thread.activeEngine}${engine?.authenticated ? "" : " · not signed in"}`}
            color={engine?.authenticated ? "default" : "warning"}
            sx={{ justifyContent: "flex-start" }}
          />
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 180 } }}>
            <InputLabel id="agent-detail-model-label">Model</InputLabel>
            <Select
              labelId="agent-detail-model-label"
              value={models.some((o) => o.id === model) ? model : ""}
              label="Model"
              onChange={(event: SelectChangeEvent) => setModel(event.target.value)}
            >
              <MenuItem value="">Engine default</MenuItem>
              {models.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 140 } }}>
            <InputLabel id="agent-detail-effort-label">Effort</InputLabel>
            <Select
              labelId="agent-detail-effort-label"
              value={efforts.some((o) => o.id === effort) ? effort : ""}
              label="Effort"
              onChange={(event: SelectChangeEvent) => setEffort(event.target.value)}
            >
              <MenuItem value="">Engine default</MenuItem>
              {efforts.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        {running ? <LinearProgress sx={{ mt: 1 }} /> : null}
      </Box>

      <Tabs
        value={tab}
        onChange={(_event, value: AgentTab) => setTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 48 }}
      >
        <Tab value="chat" icon={<ChatBubbleOutlineIcon />} iconPosition="start" label="Chat" sx={{ minHeight: 48 }} />
        <Tab value="log" icon={<TimelineIcon />} iconPosition="start" label="Live Log" sx={{ minHeight: 48 }} />
        <Tab value="tasks" icon={<TerminalIcon />} iconPosition="start" label="Tasks" sx={{ minHeight: 48 }} />
        <Tab value="artifacts" icon={<DifferenceIcon />} iconPosition="start" label="Artifacts" sx={{ minHeight: 48 }} />
      </Tabs>

      <Box sx={{ minHeight: 0, overflow: "auto" }}>{panes[tab]}</Box>

      <Composer
        disabled={running}
        running={running}
        placeholder="Message this agent directly"
        onSend={(text) => {
          sendMessage.mutate({ text, model: model || undefined, effort: effort || undefined });
          setTab("chat");
        }}
        onCancel={() => cancelRun.mutate()}
      />

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete agent?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently deletes <Box component="strong">{detail.thread.title}</Box>, including its
            event log, tasks, and artifacts. This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleteAgent.isPending}>
            Cancel
          </Button>
          <Button color="error" variant="contained" disabled={deleteAgent.isPending} onClick={() => deleteAgent.mutate()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
