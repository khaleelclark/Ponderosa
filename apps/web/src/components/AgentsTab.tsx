import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
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
  TextField,
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
import {
  agentActivity,
  agentBelongsToMasterChat,
  agentStatusColor,
  agentStatusLabel,
  relativeTime,
  orderedAgentOrganization,
  type AgentStatus,
} from "../agents";

type StatusFilter = "all" | "running" | "waiting" | "idle" | "unassigned";

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
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ThreadDto | undefined>();
  const delegationByChildId = new Map(subagents.flatMap((run) => run.childThreadId ? [[run.childThreadId, run] as const] : []));

  const deleteAgent = useMutation({
    mutationFn: (agentId: string) => api.deleteThread(agentId),
    onSuccess: (_data, agentId) => {
      queryClient.removeQueries({ queryKey: ["thread", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: ["master-chat"] });
      setPendingDelete(undefined);
    },
  });
  const promoteAgent = useMutation({
    mutationFn: (agentId: string) => api.updateAgentOrganization(agentId, { parentAgentId: null }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["threads", updated.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["thread", updated.id] });
    },
  });

  const masterName = (id: string | undefined): string =>
    id ? (masterChats.find((master) => master.id === id)?.title ?? "Unknown master chat") : "Unassigned";

  const filtered = orderedAgentOrganization(agents).filter(({ agent }) => {
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
    if (statusFilter === "idle" && status !== "idle") {
      return false;
    }
    if (masterFilter !== "all" && !agentBelongsToMasterChat(agent, masterFilter)) {
      return false;
    }
    if (search.trim() && !agent.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
    return true;
  });
  const statusCounts = agents.reduce(
    (counts, agent) => {
      const status = statusByAgentId.get(agent.id) ?? "idle";
      counts[status] += 1;
      return counts;
    },
    { running: 0, stalled: 0, interrupted: 0, waiting: 0, blocked: 0, compacting: 0, cancelled: 0, completed: 0, failed: 0, idle: 0 } satisfies Record<AgentStatus, number>,
  );

  return (
    <Box data-testid="agent-roster" sx={{ minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)" }}>
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
          aria-label={`${statusCounts.running} running, ${statusCounts.stalled} stalled, ${statusCounts.interrupted} interrupted, ${statusCounts.waiting} waiting, ${statusCounts.compacting} compacting, ${statusCounts.blocked} blocked, ${statusCounts.failed} failed, ${statusCounts.cancelled} cancelled, ${statusCounts.completed} completed`}
        >
          <Chip size="small" color="info" label={`${statusCounts.running} running`} />
          {statusCounts.stalled ? <Chip size="small" color="error" label={`${statusCounts.stalled} stalled`} /> : null}
          {statusCounts.interrupted ? <Chip size="small" color="error" label={`${statusCounts.interrupted} interrupted`} /> : null}
          <Chip size="small" color="warning" label={`${statusCounts.waiting} waiting`} />
          <Chip size="small" label={`${statusCounts.idle} idle`} />
          {statusCounts.compacting ? <Chip size="small" color="info" label={`${statusCounts.compacting} compacting`} /> : null}
          {statusCounts.blocked ? <Chip size="small" color="error" label={`${statusCounts.blocked} blocked`} /> : null}
          {statusCounts.failed ? <Chip size="small" color="error" label={`${statusCounts.failed} failed`} /> : null}
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
        <TextField size="small" label="Search agents" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ minWidth: 200, width: { xs: "100%", sm: "auto" } }} />
      </Stack>

      <Box sx={{ minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", p: { xs: 1, sm: 1.5, md: 2 }, pt: 0 }}>
        {filtered.length === 0 ? (
          <Alert
            severity="info"
            action={
              statusFilter !== "all" || masterFilter !== "all" || search ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setStatusFilter("all");
                    setMasterFilter("all");
                    setSearch("");
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
            {filtered.map(({ agent, depth }) => {
              const status = statusByAgentId.get(agent.id) ?? "idle";
              const activity = agentActivity(detailByAgentId.get(agent.id));
              const delegation = delegationByChildId.get(agent.id);
              const organizationParent = agent.organizationalParentAgentId
                ? agents.find((candidate) => candidate.id === agent.organizationalParentAgentId)
                : undefined;
              return (
                <Stack key={agent.id} spacing={0.75} sx={{ ml: { xs: Math.min(depth, 2), sm: depth * 3 }, borderLeft: depth ? 2 : 0, borderColor: "divider", pl: depth ? 1 : 0 }}>
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
                      {organizationParent ? <Chip size="small" color="secondary" variant="outlined" label={`Reports to ${organizationParent.title}`} /> : null}
                      {delegation ? <Chip size="small" variant="outlined" label={`Delegated · ${delegation.status}`} /> : null}
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
                  {organizationParent ? (
                    <Tooltip title="Promote to top level">
                      <IconButton
                        size="small"
                        aria-label={`Promote agent ${agent.title} to top level`}
                        disabled={promoteAgent.isPending}
                        onClick={() => promoteAgent.mutate(agent.id)}
                        sx={{ mt: 0.75, minWidth: 44, minHeight: 44 }}
                      >
                        <ArrowUpwardIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  </Paper>
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
