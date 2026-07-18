import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
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
import { agentRoleProfile } from "@ponderosa/core";
import type { ConversationDto, AgentDetailDto, AgentDto, AgentHealthDto, EngineDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import {
  agentActivity,
  agentBelongsToConversation,
  agentStatusColor,
  agentStatusLabel,
  relativeTime,
  orderedAgentOrganization,
  type AgentStatus,
} from "../agents";

type StatusFilter = "all" | "running" | "waiting" | "idle" | "unassigned";

export function AgentsTab({
  agents,
  projectId,
  engines,
  conversations,
  statusByAgentId,
  healthByAgentId,
  detailByAgentId,
  onOpenAgent,
  onNewAgent,
}: {
  agents: AgentDto[];
  projectId: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  statusByAgentId: Map<string, AgentStatus>;
  healthByAgentId: Map<string, AgentHealthDto>;
  detailByAgentId: Map<string, AgentDetailDto | undefined>;
  onOpenAgent(agentId: string): void;
  onNewAgent(managerAgentId?: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [masterFilter, setMasterFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AgentDto | undefined>();
  const [bulkError, setBulkError] = useState<string>();
  const [stoppingAll, setStoppingAll] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const promoteAgent = useMutation({
    mutationFn: (agentId: string) => api.updateAgentOrganization(agentId, { managerAgentId: null }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["agents", updated.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["agent", updated.id] });
    },
  });

  const masterName = (id: string | undefined): string =>
    id ? (conversations.find((master) => master.id === id)?.title ?? "Unknown Project chat") : "Unassigned";

  const filtered = orderedAgentOrganization(agents).filter(({ agent }) => {
    const status = statusByAgentId.get(agent.id) ?? "idle";
    if (statusFilter === "unassigned" && agent.conversationIds.length > 0) {
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
    if (masterFilter !== "all" && !agentBelongsToConversation(agent, masterFilter)) {
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
  const activeRunTargets = agents.flatMap((agent) => {
    const runId = healthByAgentId.get(agent.id)?.runtimeActivity?.executionId;
    return runId ? [{ agentId: agent.id, runId }] : [];
  });
  const toggleSelection = (agentId: string) => setSelectedAgentIds((current) => {
    const next = new Set(current);
    if (next.has(agentId)) next.delete(agentId);
    else next.add(agentId);
    return next;
  });
  const leaveSelectionMode = () => {
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
    setDeleteSelectedOpen(false);
  };
  const stopAll = async () => {
    setStoppingAll(true); setBulkError(undefined);
    const results = await Promise.allSettled(activeRunTargets.map(({ agentId, runId }) => api.cancelRun(agentId, {
      targetRunId: runId,
      idempotencyKey: `bulk-stop:${agentId}:${runId}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
    })));
    const failed = results.filter((item) => item.status === "rejected").length;
    if (failed) setBulkError(`${activeRunTargets.length - failed} agents stopped; ${failed} could not be stopped. Retry or open those agents for details.`);
    await queryClient.invalidateQueries({ queryKey: ["agents"] });
    setStoppingAll(false);
  };
  return (
    <Box data-testid="agent-roster" sx={{ minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)" }}>
      <Stack
        direction="row"
        useFlexGap
        flexWrap="wrap"
        spacing={1}
        sx={{ alignItems: "center", px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}
      >
        <Typography variant="h6" sx={{ flex: 1 }}>
          Agents
        </Typography>
        <Button variant="outlined" size="small" disabled={activeRunTargets.length === 0 || stoppingAll} onClick={() => void stopAll()}>Stop all</Button>
        {selectionMode ? <>
          <Button color="inherit" size="small" onClick={() => {
            const visibleIds = filtered.map(({ agent }) => agent.id);
            const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedAgentIds.has(id));
            setSelectedAgentIds((current) => {
              const next = new Set(current);
              visibleIds.forEach((id) => allVisibleSelected ? next.delete(id) : next.add(id));
              return next;
            });
          }}>{filtered.length > 0 && filtered.every(({ agent }) => selectedAgentIds.has(agent.id)) ? "Clear visible" : "Select all visible"}</Button>
          <Button color="error" variant="outlined" size="small" disabled={selectedAgentIds.size === 0} onClick={() => setDeleteSelectedOpen(true)}>Delete selected ({selectedAgentIds.size})</Button>
          <Button color="inherit" size="small" onClick={leaveSelectionMode}>Cancel selection</Button>
        </> : <Button color="inherit" variant="outlined" size="small" disabled={agents.length === 0} onClick={() => setSelectionMode(true)}>Select agents</Button>}
        <Button variant="outlined" size="small" onClick={() => setImportOpen(true)}>Import Agent or organization</Button>
        <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={() => onNewAgent()} sx={{ flexShrink: 0, minHeight: 44 }}>
          New Agent
        </Button>
      </Stack>
      {bulkError ? <Alert severity="warning" sx={{ mx: 2, mt: 1 }}>{bulkError}</Alert> : null}

      <ImportAgentDialog
        open={importOpen}
        projectId={projectId}
        engines={engines}
        conversations={conversations}
        initialConversationId={conversations[0]?.id}
        onClose={() => setImportOpen(false)}
        onImported={onOpenAgent}
      />

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
          <InputLabel id="agents-master-filter-label">Project chat</InputLabel>
          <Select
            labelId="agents-master-filter-label"
            label="Project chat"
            value={masterFilter}
            onChange={(event: SelectChangeEvent) => setMasterFilter(event.target.value)}
          >
            <MenuItem value="all">All Project chats</MenuItem>
            {conversations.map((master) => (
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
              const profile = agentRoleProfile(agent);
              const organizationParent = agent.managerAgentId
                ? agents.find((candidate) => candidate.id === agent.managerAgentId)
                : undefined;
              return (
                <Stack key={agent.id} spacing={0.75} sx={{ ml: { xs: Math.min(depth, 2), sm: depth * 3 }, borderLeft: depth ? 2 : 0, borderColor: "divider", pl: depth ? 1 : 0 }}>
                  <Paper
                    variant="outlined"
                    sx={{ display: "flex", alignItems: "flex-start", overflow: "hidden" }}
                  >
                  {selectionMode ? <Checkbox
                    checked={selectedAgentIds.has(agent.id)}
                    onChange={() => toggleSelection(agent.id)}
                    inputProps={{ "aria-label": `Select ${agent.title}` }}
                    sx={{ mt: 0.75, ml: 0.5 }}
                  /> : null}
                  <ButtonBase
                    onClick={() => selectionMode ? toggleSelection(agent.id) : onOpenAgent(agent.id)}
                    aria-label={`Open agent ${agent.title}`}
                    sx={{ flex: 1, minWidth: 0, p: 1.5, display: "block", textAlign: "left" }}
                  >
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
                      <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0, fontWeight: 700 }} noWrap>
                        {agent.title}
                      </Typography>
                      <Chip size="small" label={agentStatusLabel(status)} color={agentStatusColor(status)} />
                    </Stack>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {profile.role} · {profile.description}
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      flexWrap="wrap"
                      sx={{ mt: 0.75, alignItems: "center" }}
                    >
                      <Chip size="small" variant="outlined" label={agent.activeEngine} />
                      {organizationParent ? <Chip size="small" color="secondary" variant="outlined" label={`Reports to ${organizationParent.title}`} /> : null}
                      <Chip
                        size="small"
                        variant="outlined"
                        color={agent.conversationId ? "default" : "warning"}
                        label={masterName(agent.conversationId)}
                      />
                      {agent.conversationIds.length > 1 ? (
                        <Chip size="small" variant="outlined" label={`+${agent.conversationIds.length - 1} Project chats`} />
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
                        Current activity: {activity}
                      </Typography>
                    ) : null}
                  </ButtonBase>
                  {!selectionMode ? <Tooltip title="Delete agent">
                    <IconButton
                      size="small"
                      aria-label={`Delete agent ${agent.title}`}
                      onClick={() => setPendingDelete(agent)}
                      sx={{ m: 0.75, minWidth: 44, minHeight: 44 }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip> : null}
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
                  <Tooltip title={`Create an agent reporting to ${agent.title}`}>
                    <IconButton
                      size="small"
                      aria-label={`Add subagent to ${agent.title}`}
                      onClick={() => onNewAgent(agent.id)}
                      sx={{ mt: 0.75, minWidth: 44, minHeight: 44 }}
                    >
                      <PersonAddAlt1Icon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  </Paper>
                </Stack>
              );
            })}
          </Stack>
        )}
      </Box>

      <AgentDeletionDialog
        open={Boolean(pendingDelete)}
        projectId={projectId}
        rootAgentIds={pendingDelete ? [pendingDelete.id] : []}
        onClose={() => setPendingDelete(undefined)}
        onDeleted={() => setPendingDelete(undefined)}
      />
      <AgentDeletionDialog
        open={deleteSelectedOpen}
        projectId={projectId}
        rootAgentIds={[...selectedAgentIds]}
        title="Delete selected agents?"
        confirmationText="DELETE SELECTED"
        onClose={() => setDeleteSelectedOpen(false)}
        onDeleted={leaveSelectionMode}
      />
    </Box>
  );
}
