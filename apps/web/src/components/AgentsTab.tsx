import AddIcon from "@mui/icons-material/Add";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import FilterListOutlinedIcon from "@mui/icons-material/FilterListOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
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
  Menu,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import { agentRoleProfile } from "@ponderosa/core";
import type { ConversationDto, AgentDto, AgentHealthDto, EngineDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api } from "../api";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import {
  agentBelongsToConversation,
  agentStatusColor,
  agentStatusLabel,
  relativeTime,
  orderedAgentOrganization,
  type AgentStatus,
} from "../agents";

export type StatusFilter = AgentStatus | "unassigned";

export const STATUS_FILTERS: Array<{ value: Exclude<StatusFilter, "all" | "unassigned">; label: string }> = [
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "blocked", label: "Blocked" },
  { value: "stalled", label: "Stalled" },
  { value: "interrupted", label: "Interrupted" },
  { value: "compacting", label: "Compacting" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "completed", label: "Completed" },
  { value: "idle", label: "Idle" },
];

export function agentStatusFilterOptions(
  agents: AgentDto[],
  statusByAgentId: ReadonlyMap<string, AgentStatus>,
): Array<{ value: StatusFilter | "all"; label: string; count: number }> {
  const counts = agents.reduce(
    (result, agent) => {
      result.status[statusByAgentId.get(agent.id) ?? "idle"] += 1;
      if (agent.conversationIds.length === 0) result.unassigned += 1;
      return result;
    },
    {
      status: { running: 0, stalled: 0, interrupted: 0, waiting: 0, blocked: 0, compacting: 0, cancelled: 0, completed: 0, failed: 0, idle: 0 } satisfies Record<AgentStatus, number>,
      unassigned: 0,
    },
  );
  return [
    { value: "all", label: "All", count: agents.length },
    ...STATUS_FILTERS.map((option) => ({ ...option, count: counts.status[option.value] })),
    { value: "unassigned", label: "Unassigned", count: counts.unassigned },
  ];
}

export function matchesAgentStatusFilters(
  agent: Pick<AgentDto, "conversationIds">,
  status: AgentStatus,
  selected: readonly StatusFilter[],
): boolean {
  if (selected.length === 0) return true;
  return selected.some((filter) => filter === "unassigned"
    ? agent.conversationIds.length === 0
    : status === filter);
}

export function AgentsTab({
  agents,
  projectId,
  engines,
  conversations,
  statusByAgentId,
  healthByAgentId,
  onOpenAgent,
  onOpenAgentInNewTab,
  onNewAgent,
  projectByAgentId,
  starredAgentIds,
  onToggleStar,
  displayOrder,
  selectionAllowed = true,
  onReorder,
  toolbarControls,
}: {
  agents: AgentDto[];
  projectId?: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  statusByAgentId: Map<string, AgentStatus>;
  healthByAgentId: Map<string, AgentHealthDto>;
  onOpenAgent(agentId: string): void;
  onOpenAgentInNewTab?(agentId: string): void;
  onNewAgent(managerAgentId?: string): void;
  projectByAgentId?: Map<string, { id: string; label: string }>;
  starredAgentIds?: ReadonlySet<string>;
  onToggleStar?(agentId: string): void;
  displayOrder?: readonly string[];
  selectionAllowed?: boolean;
  onReorder?(sourceAgentId: string, targetAgentId: string): void;
  toolbarControls?: ReactNode;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [statusFilters, setStatusFilters] = useState<StatusFilter[]>([]);
  const [masterFilter, setMasterFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AgentDto | undefined>();
  const [bulkError, setBulkError] = useState<string>();
  const [stoppingAll, setStoppingAll] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [agentMenu, setAgentMenu] = useState<{ anchor: HTMLElement; agentId: string }>();
  const [actionsAnchor, setActionsAnchor] = useState<HTMLElement>();
  const [statusAnchor, setStatusAnchor] = useState<HTMLElement>();
  const [draggedAgentId, setDraggedAgentId] = useState<string>();

  const promoteAgent = useMutation({
    mutationFn: (agentId: string) => api.updateAgentOrganization(agentId, { managerAgentId: null }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["agents", updated.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["agent", updated.id] });
    },
  });

  const masterName = (id: string | undefined): string =>
    id ? (conversations.find((master) => master.id === id)?.title ?? "Unknown Project chat") : "Unassigned";

  const organizationRows = orderedAgentOrganization(agents);
  const orderRank = new Map(displayOrder?.map((id, index) => [id, index]));
  const filtered = organizationRows.filter(({ agent }) => {
    const status = statusByAgentId.get(agent.id) ?? "idle";
    if (!matchesAgentStatusFilters(agent, status, statusFilters)) return false;
    if (masterFilter !== "all" && !agentBelongsToConversation(agent, masterFilter)) {
      return false;
    }
    if (search.trim() && !agent.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
    return true;
  }).sort((left, right) => displayOrder ? (orderRank.get(left.agent.id) ?? Number.MAX_SAFE_INTEGER) - (orderRank.get(right.agent.id) ?? Number.MAX_SAFE_INTEGER) : 0);
  const statusOptions = agentStatusFilterOptions(agents, statusByAgentId);
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
        {selectionMode ? <>
          <Button color="inherit" size="small" onClick={() => {
            const visibleIds = filtered.map(({ agent }) => agent.id);
            const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedAgentIds.has(id));
            setSelectedAgentIds((current) => {
              const next = new Set(current);
              visibleIds.forEach((id) => allVisibleSelected ? next.delete(id) : next.add(id));
              return next;
            });
          }}>{filtered.length > 0 && filtered.every(({ agent }) => selectedAgentIds.has(agent.id)) ? "Clear Visible" : "Select All Visible"}</Button>
          <Button color="error" variant="outlined" size="small" disabled={selectedAgentIds.size === 0} onClick={() => setDeleteSelectedOpen(true)}>Delete Selected ({selectedAgentIds.size})</Button>
          <Button color="inherit" size="small" onClick={leaveSelectionMode}>Cancel Selection</Button>
        </> : <Tooltip title="Agent actions: stop, select, import, or create"><IconButton aria-label="Agent actions" onClick={(event) => setActionsAnchor(event.currentTarget)} sx={{ minWidth: 44, minHeight: 44 }}><MoreVertIcon /></IconButton></Tooltip>}
        {actionsAnchor ? <Menu anchorEl={actionsAnchor} open onClose={() => setActionsAnchor(undefined)}>
          <MenuItem disabled={activeRunTargets.length === 0 || stoppingAll} onClick={() => { setActionsAnchor(undefined); void stopAll(); }}>Stop All</MenuItem>
          <MenuItem disabled={agents.length === 0 || !selectionAllowed} onClick={() => { setActionsAnchor(undefined); setSelectionMode(true); }}>Select Agents</MenuItem>
          <MenuItem disabled={!projectId} onClick={() => { setActionsAnchor(undefined); setImportOpen(true); }}><FileUploadOutlinedIcon fontSize="small" sx={{ mr: 1 }} />Import Agent or Organization</MenuItem>
          <MenuItem onClick={() => { setActionsAnchor(undefined); onNewAgent(); }}><AddIcon fontSize="small" sx={{ mr: 1 }} />New Agent</MenuItem>
        </Menu> : null}
      </Stack>
      {bulkError ? <Alert severity="warning" sx={{ mx: 2, mt: 1 }}>{bulkError}</Alert> : null}

      {projectId ? <ImportAgentDialog
        open={importOpen}
        projectId={projectId}
        engines={engines}
        conversations={conversations}
        initialConversationId={conversations[0]?.id}
        onClose={() => setImportOpen(false)}
        onImported={onOpenAgent}
      /> : null}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{ alignItems: { sm: "center" }, px: { xs: 1.5, md: 2 }, py: 1 }}
      >
        <TextField size="small" label="Search Agents" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ minWidth: 220, flex: { sm: 1 }, width: { xs: "100%", sm: "auto" } }} />
        {toolbarControls}
        <Button
          color="inherit"
          variant={statusFilters.length ? "outlined" : "text"}
          startIcon={<FilterListOutlinedIcon />}
          onClick={(event) => setStatusAnchor(event.currentTarget)}
          aria-label="Filter Agents by status"
          sx={{ minHeight: 40, whiteSpace: "nowrap" }}
        >
          {statusFilters.length ? `Status (${statusFilters.length})` : "Status"}
        </Button>
        {statusAnchor ? <Menu anchorEl={statusAnchor} open onClose={() => setStatusAnchor(undefined)}>
          <MenuItem onClick={() => setStatusFilters([])}>
            <Checkbox checked={statusFilters.length === 0} />
            All ({agents.length})
          </MenuItem>
          {statusOptions.filter((option) => option.value !== "all").map((option) => <MenuItem key={option.value} onClick={() => setStatusFilters((current) => current.includes(option.value as StatusFilter) ? current.filter((value) => value !== option.value) : [...current, option.value as StatusFilter])}>
            <Checkbox checked={statusFilters.includes(option.value as StatusFilter)} />
            {option.label} ({option.count})
          </MenuItem>)}
        </Menu> : null}
        <FormControl size="small" sx={{ minWidth: 200, width: { xs: "100%", sm: "auto" } }}>
          <InputLabel id="agents-master-filter-label">Project chat</InputLabel>
          <Select
            labelId="agents-master-filter-label"
            label="Project chat"
            value={masterFilter}
            onChange={(event: SelectChangeEvent) => setMasterFilter(event.target.value)}
          >
            <MenuItem value="all">All Project Chats</MenuItem>
            {conversations.map((master) => (
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
              statusFilters.length > 0 || masterFilter !== "all" || search ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setStatusFilters([]);
                    setMasterFilter("all");
                    setSearch("");
                  }}
                >
                  Clear Filters
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
              const profile = agentRoleProfile(agent);
              const organizationParent = agent.managerAgentId
                ? agents.find((candidate) => candidate.id === agent.managerAgentId)
                : undefined;
              return (
                <Stack key={agent.id} spacing={0.75} sx={{ ml: { xs: Math.min(depth, 2), sm: depth * 3 }, borderLeft: depth ? 2 : 0, borderColor: "divider", pl: depth ? 1 : 0 }}>
                  <Paper
                    variant="outlined"
                    draggable={Boolean(onReorder)}
                    onDragStart={() => setDraggedAgentId(agent.id)}
                    onDragEnd={() => setDraggedAgentId(undefined)}
                    onDragOver={(event) => { if (draggedAgentId) event.preventDefault(); }}
                    onDrop={(event) => { event.preventDefault(); if (draggedAgentId && draggedAgentId !== agent.id) onReorder?.(draggedAgentId, agent.id); setDraggedAgentId(undefined); }}
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
                    onContextMenu={(event) => { if (selectionMode) return; event.preventDefault(); setAgentMenu({ anchor: event.currentTarget, agentId: agent.id }); }}
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
                      {projectByAgentId?.get(agent.id) ? <Chip size="small" variant="outlined" label={projectByAgentId.get(agent.id)!.label} /> : null}
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
                  </ButtonBase>
                  {!selectionMode ? <Tooltip title="Delete Agent">
                    <IconButton
                      size="small"
                      aria-label={`Delete agent ${agent.title}`}
                      onClick={() => setPendingDelete(agent)}
                      sx={{ m: 0.75, minWidth: 44, minHeight: 44 }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip> : null}
                  {!selectionMode && onToggleStar ? <Tooltip title={starredAgentIds?.has(agent.id) ? "Unstar Agent" : "Star Agent"}><IconButton aria-label={starredAgentIds?.has(agent.id) ? `Unstar ${agent.title}` : `Star ${agent.title}`} onClick={() => onToggleStar(agent.id)} sx={{ mt: 0.75, minWidth: 44, minHeight: 44 }}>{starredAgentIds?.has(agent.id) ? <StarRoundedIcon color="primary" /> : <StarBorderRoundedIcon />}</IconButton></Tooltip> : null}
                  {organizationParent ? (
                    <Tooltip title="Promote to Top Level">
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

      {pendingDelete ? <AgentDeletionDialog
        open={Boolean(pendingDelete)}
        projectId={projectByAgentId?.get(pendingDelete.id)?.id ?? projectId!}
        rootAgentIds={pendingDelete ? [pendingDelete.id] : []}
        onClose={() => setPendingDelete(undefined)}
        onDeleted={() => setPendingDelete(undefined)}
      /> : null}
      {agentMenu ? <Menu anchorEl={agentMenu.anchor} open onClose={() => setAgentMenu(undefined)}><MenuItem disabled={!onOpenAgentInNewTab} onClick={() => { onOpenAgentInNewTab?.(agentMenu.agentId); setAgentMenu(undefined); }}>Open in New Ponderosa Tab</MenuItem></Menu> : null}
      {projectId ? <AgentDeletionDialog
        open={deleteSelectedOpen}
        projectId={projectId}
        rootAgentIds={[...selectedAgentIds]}
        title="Delete selected agents?"
        confirmationText="DELETE SELECTED"
        onClose={() => setDeleteSelectedOpen(false)}
        onDeleted={leaveSelectionMode}
      /> : null}
    </Box>
  );
}
