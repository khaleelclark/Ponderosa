import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { MasterChatDto, SubagentRunDto, ThreadDetailDto, ThreadDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { subagentRootsByParentThread, type SubagentTreeNode } from "../subagents";
import {
  agentActivity,
  agentBelongsToMasterChat,
  agentStatusColor,
  agentStatusLabel,
  relativeTime,
  type AgentStatus,
} from "../agents";

type StatusFilter = "all" | "running" | "waiting" | "error" | "idle" | "unassigned";

export function AgentsTab({
  agents,
  masterChats,
  statusByAgentId,
  detailByAgentId,
  subagents,
  onOpenAgent,
  onNewAgent,
}: {
  agents: ThreadDto[];
  masterChats: MasterChatDto[];
  statusByAgentId: Map<string, AgentStatus>;
  detailByAgentId: Map<string, ThreadDetailDto | undefined>;
  subagents: SubagentRunDto[];
  onOpenAgent(agentId: string): void;
  onNewAgent(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [masterFilter, setMasterFilter] = useState<string>("all");
  const [pendingDelete, setPendingDelete] = useState<ThreadDto | undefined>();
  const subagentsByParent = subagentRootsByParentThread(subagents);
  const childThreadIds = new Set(subagents.flatMap((run) => run.childThreadId ? [run.childThreadId] : []));

  const subagentColor = (status: SubagentRunDto["status"]): "default" | "info" | "success" | "error" => {
    if (status === "running") return "info";
    if (status === "completed") return "success";
    if (status === "failed" || status === "blocked") return "error";
    return "default";
  };

  const renderSubagent = (run: SubagentTreeNode): JSX.Element => (
    <Box key={run.id} sx={{ ml: { xs: 1, sm: 4 }, minWidth: 0, borderLeft: 2, borderColor: "divider", pl: 1 }}>
      <Paper
        component={ButtonBase}
        disabled={!run.childThreadId}
        onClick={() => run.childThreadId && onOpenAgent(run.childThreadId)}
        aria-label={`Open subagent ${run.displayLabel}`}
        variant="outlined"
        sx={{ p: 1.25, bgcolor: "action.hover", display: "block", width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden", textAlign: "left" }}
      >
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
          <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0, flexBasis: { xs: "100%", sm: 140 }, overflowWrap: "anywhere" }}>{run.displayLabel}</Typography>
          <Chip size="small" variant="outlined" color="secondary" label="Subagent" />
          <Chip size="small" label={run.status} color={subagentColor(run.status)} />
        </Stack>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 0.75, alignItems: "center" }}>
          <Chip size="small" variant="outlined" label={run.runtime} />
          <Typography variant="caption" color="text.secondary">
            depth {run.depth} · updated {relativeTime(run.updatedAt)}
          </Typography>
        </Stack>
        {run.failure ? <Alert severity="error" sx={{ mt: 1 }}>{run.failure.message}</Alert> : null}
      </Paper>
      {run.children.map(renderSubagent)}
    </Box>
  );

  const deleteAgent = useMutation({
    mutationFn: (agentId: string) => api.deleteThread(agentId),
    onSuccess: (_data, agentId) => {
      queryClient.removeQueries({ queryKey: ["thread", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: ["master-chat"] });
      setPendingDelete(undefined);
    },
  });

  const masterName = (id: string | undefined): string =>
    id ? (masterChats.find((master) => master.id === id)?.title ?? "Unknown master chat") : "Unassigned";

  const filtered = agents.filter((agent) => {
    if (childThreadIds.has(agent.id)) return false;
    const status = statusByAgentId.get(agent.id) ?? "idle";
    if (statusFilter === "unassigned" && agent.masterChatIds.length > 0) {
      return false;
    }
    if (statusFilter === "running" && status !== "running") {
      return false;
    }
    if (statusFilter === "waiting" && status !== "waiting") {
      return false;
    }
    if (statusFilter === "error" && status !== "error") {
      return false;
    }
    if (statusFilter === "idle" && status !== "idle") {
      return false;
    }
    if (masterFilter !== "all" && !agentBelongsToMasterChat(agent, masterFilter)) {
      return false;
    }
    return true;
  });
  const statusCounts = agents.reduce(
    (counts, agent) => {
      const status = statusByAgentId.get(agent.id) ?? "idle";
      counts[status] += 1;
      return counts;
    },
    { running: 0, waiting: 0, error: 0, idle: 0 } satisfies Record<AgentStatus, number>,
  );

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)" }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}
      >
        <Typography variant="h6" sx={{ flex: 1 }}>
          Agents
        </Typography>
        <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={onNewAgent} sx={{ flexShrink: 0, minHeight: 44 }}>
          New Agent
        </Button>
      </Stack>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{ alignItems: { sm: "center" }, px: { xs: 1.5, md: 2 }, py: 1 }}
      >
        <Stack
          direction="row"
          spacing={0.75}
          useFlexGap
          flexWrap="wrap"
          role="status"
          aria-label={`${statusCounts.running} running, ${statusCounts.waiting} waiting, ${statusCounts.error} errors, ${statusCounts.idle} idle`}
        >
          <Chip size="small" color="info" label={`${statusCounts.running} running`} />
          <Chip size="small" color="warning" label={`${statusCounts.waiting} waiting`} />
          <Chip size="small" color="error" label={`${statusCounts.error} errors`} />
          <Chip size="small" label={`${statusCounts.idle} idle`} />
        </Stack>
        <Box sx={{ maxWidth: "100%", overflowX: "auto", pb: 0.25 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={statusFilter}
            onChange={(_event, value: StatusFilter | null) => value && setStatusFilter(value)}
            aria-label="Filter agents by status"
            sx={{ "& .MuiToggleButton-root": { minHeight: 44 } }}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="running">Running</ToggleButton>
            <ToggleButton value="waiting">Waiting</ToggleButton>
            <ToggleButton value="error">Error</ToggleButton>
            <ToggleButton value="idle">Idle</ToggleButton>
            <ToggleButton value="unassigned">Unassigned</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <FormControl size="small" sx={{ minWidth: 200, width: { xs: "100%", sm: "auto" } }}>
          <InputLabel id="agents-master-filter-label">Master chat</InputLabel>
          <Select
            labelId="agents-master-filter-label"
            label="Master chat"
            value={masterFilter}
            onChange={(event: SelectChangeEvent) => setMasterFilter(event.target.value)}
          >
            <MenuItem value="all">All master chats</MenuItem>
            {masterChats.map((master) => (
              <MenuItem key={master.id} value={master.id}>
                {master.title}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      <Box sx={{ minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", p: { xs: 1, sm: 1.5, md: 2 }, pt: 0 }}>
        {filtered.length === 0 ? (
          <Alert
            severity="info"
            action={
              statusFilter !== "all" || masterFilter !== "all" ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setStatusFilter("all");
                    setMasterFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {agents.length === 0 ? "No agents yet. Create one to get started." : "No agents match these filters."}
          </Alert>
        ) : (
          <Stack spacing={1.25}>
            {filtered.map((agent) => {
              const status = statusByAgentId.get(agent.id) ?? "idle";
              const activity = agentActivity(detailByAgentId.get(agent.id));
              const delegated = subagentsByParent.get(agent.id) ?? [];
              return (
                <Stack key={agent.id} spacing={0.75}>
                  <Paper
                    variant="outlined"
                    sx={{ display: "flex", alignItems: "flex-start", overflow: "hidden" }}
                  >
                  <ButtonBase
                    onClick={() => onOpenAgent(agent.id)}
                    aria-label={`Open agent ${agent.title}`}
                    sx={{ flex: 1, minWidth: 0, p: 1.5, display: "block", textAlign: "left" }}
                  >
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
                      <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0, fontWeight: 700 }} noWrap>
                        {agent.title}
                      </Typography>
                      <Chip size="small" label={agentStatusLabel(status)} color={agentStatusColor(status)} />
                    </Stack>
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      flexWrap="wrap"
                      sx={{ mt: 0.75, alignItems: "center" }}
                    >
                      <Chip size="small" variant="outlined" label={agent.activeEngine} />
                      <Chip
                        size="small"
                        variant="outlined"
                        color={agent.masterChatId ? "default" : "warning"}
                        label={masterName(agent.masterChatId)}
                      />
                      {agent.masterChatIds.length > 1 ? (
                        <Chip size="small" variant="outlined" label={`+${agent.masterChatIds.length - 1} chats`} />
                      ) : null}
                      <Typography variant="caption" color="text.secondary">
                        updated {relativeTime(agent.updatedAt)}
                      </Typography>
                    </Stack>
                    {activity ? (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mt: 0.5, overflowWrap: "anywhere" }}
                        noWrap
                      >
                        {activity}
                      </Typography>
                    ) : null}
                  </ButtonBase>
                  <Tooltip title="Delete agent">
                    <IconButton
                      size="small"
                      aria-label={`Delete agent ${agent.title}`}
                      onClick={() => setPendingDelete(agent)}
                      sx={{ m: 0.75, minWidth: 44, minHeight: 44 }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  </Paper>
                  {delegated.map(renderSubagent)}
                </Stack>
              );
            })}
          </Stack>
        )}
      </Box>

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
