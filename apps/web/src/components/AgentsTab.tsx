import AddIcon from "@mui/icons-material/Add";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import FilterListOutlinedIcon from "@mui/icons-material/FilterListOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import ViewListOutlinedIcon from "@mui/icons-material/ViewListOutlined";
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
import { queryKeys } from "../queryKeys";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";
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

export function agentHierarchyContextIds(
  agents: readonly AgentDto[],
  matchingAgentIds: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const result = new Set(matchingAgentIds);
  for (const id of matchingAgentIds) {
    let parentId = byId.get(id)?.managerAgentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      result.add(parentId);
      parentId = byId.get(parentId)?.managerAgentId;
    }
  }
  return result;
}

export function agentHasCollapsedAncestor(
  agent: AgentDto,
  agentsById: ReadonlyMap<string, AgentDto>,
  collapsedAgentIds: ReadonlySet<string>,
): boolean {
  let parentId = agent.managerAgentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (collapsedAgentIds.has(parentId)) return true;
    seen.add(parentId);
    parentId = agentsById.get(parentId)?.managerAgentId;
  }
  return false;
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
  scopeLabel,
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
  scopeLabel?: string;
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
  const [agentMenu, setAgentMenu] = useState<ResourceContextMenuState<string>>();
  const [actionsAnchor, setActionsAnchor] = useState<HTMLElement>();
  const [statusAnchor, setStatusAnchor] = useState<HTMLElement>();
  const [draggedAgentId, setDraggedAgentId] = useState<string>();
  const [organizationView, setOrganizationView] = useState<"hierarchy" | "flat">("hierarchy");
  const [collapsedAgentIds, setCollapsedAgentIds] = useState<Set<string>>(() => new Set());

  const promoteAgent = useMutation({
    mutationFn: (agentId: string) => api.updateAgentOrganization(agentId, { managerAgentId: null }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(updated.projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(updated.id) });
    },
  });

  const masterName = (id: string | undefined): string =>
    id ? (conversations.find((master) => master.id === id)?.title ?? "Unknown Project chat") : "Unassigned";

  const organizationRows = orderedAgentOrganization(agents);
  const orderRank = new Map(displayOrder?.map((id, index) => [id, index]));
  const matchingAgentIds = new Set(organizationRows.filter(({ agent }) => {
    const status = statusByAgentId.get(agent.id) ?? "idle";
    if (!matchesAgentStatusFilters(agent, status, statusFilters)) return false;
    if (masterFilter !== "all" && !agentBelongsToConversation(agent, masterFilter)) {
      return false;
    }
    if (search.trim() && !agent.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
    return true;
  }).map(({ agent }) => agent.id));
  const filtersActive = Boolean(search.trim() || statusFilters.length || masterFilter !== "all");
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const contextAgentIds = organizationView === "hierarchy"
    ? agentHierarchyContextIds(agents, matchingAgentIds)
    : new Set(matchingAgentIds);
  const childrenByManager = new Map<string, AgentDto[]>();
  for (const agent of agents) {
    if (!agent.managerAgentId || !agentsById.has(agent.managerAgentId)) continue;
    childrenByManager.set(agent.managerAgentId, [...(childrenByManager.get(agent.managerAgentId) ?? []), agent]);
  }
  const descendantIds = (agentId: string): string[] => {
    const result: string[] = [];
    const seen = new Set<string>([agentId]);
    const visit = (id: string) => {
      for (const child of childrenByManager.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        result.push(child.id);
        visit(child.id);
      }
    };
    visit(agentId);
    return result;
  };
  const filtered = (organizationView === "flat"
    ? organizationRows.filter(({ agent }) => matchingAgentIds.has(agent.id)).map(({ agent }) => ({ agent, depth: 0 }))
    : organizationRows.filter(({ agent }) => contextAgentIds.has(agent.id) && (filtersActive || !agentHasCollapsedAncestor(agent, agentsById, collapsedAgentIds))))
    .sort((left, right) => organizationView === "flat" && displayOrder
      ? (orderRank.get(left.agent.id) ?? Number.MAX_SAFE_INTEGER) - (orderRank.get(right.agent.id) ?? Number.MAX_SAFE_INTEGER)
      : 0);
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
    await queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
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
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="h1">Agents</Typography>
          {scopeLabel ? <Typography variant="caption" color="text.secondary">{scopeLabel} organization</Typography> : null}
        </Box>
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
        </> : <Tooltip title="Agent actions: stop, select, import, or create"><IconButton aria-label="Agent actions" onClick={(event) => setActionsAnchor(event.currentTarget)}><MoreVertIcon /></IconButton></Tooltip>}
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
        <Stack direction="row" role="group" aria-label="Agent organization view" sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Tooltip title="Hierarchy"><IconButton size="small" color={organizationView === "hierarchy" ? "primary" : "default"} aria-pressed={organizationView === "hierarchy"} aria-label="Show Agent hierarchy" onClick={() => setOrganizationView("hierarchy")}><AccountTreeOutlinedIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Flat List"><IconButton size="small" color={organizationView === "flat" ? "primary" : "default"} aria-pressed={organizationView === "flat"} aria-label="Show flat Agent list" onClick={() => setOrganizationView("flat")}><ViewListOutlinedIcon fontSize="small" /></IconButton></Tooltip>
        </Stack>
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
          <Stack spacing={0.5} role="tree" aria-label="Agent organization">
            {filtered.map(({ agent, depth }) => {
              const status = statusByAgentId.get(agent.id) ?? "idle";
              const profile = agentRoleProfile(agent);
              const organizationParent = agent.managerAgentId
                ? agents.find((candidate) => candidate.id === agent.managerAgentId)
                : undefined;
              const orphaned = Boolean(agent.managerAgentId && !organizationParent);
              const descendants = descendantIds(agent.id);
              const childAgents = childrenByManager.get(agent.id) ?? [];
              const expanded = !collapsedAgentIds.has(agent.id);
              const contextOnly = !matchingAgentIds.has(agent.id);
              const activeDescendants = descendants.filter((id) => ["running", "waiting", "blocked", "stalled", "interrupted", "compacting"].includes(statusByAgentId.get(id) ?? "idle")).length;
              return (
                <Stack key={agent.id} role="treeitem" aria-level={depth + 1} aria-expanded={childAgents.length ? expanded : undefined} spacing={0.25} sx={{ ml: organizationView === "hierarchy" ? `${Math.min(depth, 8) * 22}px` : 0, borderLeft: organizationView === "hierarchy" && depth ? 1 : 0, borderColor: "divider", pl: organizationView === "hierarchy" && depth ? 0.75 : 0, opacity: contextOnly ? 0.62 : 1 }}>
                  <Paper
                    variant="outlined"
                    draggable={Boolean(onReorder)}
                    onDragStart={() => setDraggedAgentId(agent.id)}
                    onDragEnd={() => setDraggedAgentId(undefined)}
                    onDragOver={(event) => { if (draggedAgentId) event.preventDefault(); }}
                    onDrop={(event) => { event.preventDefault(); if (draggedAgentId && draggedAgentId !== agent.id) onReorder?.(draggedAgentId, agent.id); setDraggedAgentId(undefined); }}
                    sx={{ display: "flex", alignItems: "center", overflow: "hidden", minHeight: 54 }}
                  >
                  {organizationView === "hierarchy" ? <IconButton
                    size="small"
                    disabled={childAgents.length === 0}
                    aria-label={childAgents.length ? `${expanded ? "Collapse" : "Expand"} ${agent.title}` : `${agent.title} has no delegated agents`}
                    onClick={() => setCollapsedAgentIds((current) => {
                      const next = new Set(current);
                      if (next.has(agent.id)) next.delete(agent.id); else next.add(agent.id);
                      return next;
                    })}
                    sx={{ ml: 0.5 }}
                  >{childAgents.length ? expanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon /> : <Box sx={{ width: 24 }} />}</IconButton> : null}
                  {selectionMode ? <Checkbox
                    checked={selectedAgentIds.has(agent.id)}
                    onChange={() => toggleSelection(agent.id)}
                    inputProps={{ "aria-label": `Select ${agent.title}` }}
                    sx={{ mt: 0.75, ml: 0.5 }}
                  /> : null}
                  <ButtonBase
                    onClick={() => selectionMode ? toggleSelection(agent.id) : onOpenAgent(agent.id)}
                    onContextMenu={(event) => { if (selectionMode) return; event.preventDefault(); setAgentMenu({ anchor: event.currentTarget, resource: agent.id }); }}
                    aria-label={`Open agent ${agent.title}`}
                    sx={{ flex: 1, minWidth: 0, px: 1, py: 0.75, display: "block", textAlign: "left" }}
                  >
                    <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", minWidth: 0 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ minWidth: 0, fontWeight: 700 }} noWrap>
                        {agent.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {orphaned ? "Unlinked Agent" : organizationParent ? `Delegated under ${organizationParent.title}` : profile.role}
                        {!expanded && descendants.length ? ` · ${descendants.length} children${activeDescendants ? `, ${activeDescendants} active` : ""}` : ""}
                      </Typography>
                      </Box>
                      <Chip size="small" label={agentStatusLabel(status)} color={agentStatusColor(status)} />
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", md: "block" }, width: 150 }}>
                        {projectByAgentId?.get(agent.id)?.label ?? masterName(agent.conversationId)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", sm: "block" }, width: 100 }}>
                        {agent.activeEngine}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", lg: "block" }, width: 92, textAlign: "right" }}>
                        {relativeTime(agent.updatedAt)}
                      </Typography>
                    </Stack>
                  </ButtonBase>
                  {!selectionMode && onToggleStar ? <Tooltip title={starredAgentIds?.has(agent.id) ? "Unstar Agent" : "Star Agent"}><IconButton aria-label={starredAgentIds?.has(agent.id) ? `Unstar ${agent.title}` : `Star ${agent.title}`} onClick={() => onToggleStar(agent.id)} sx={{ mt: 0.75 }}>{starredAgentIds?.has(agent.id) ? <StarRoundedIcon sx={{ color: "#facc15" }} /> : <StarBorderRoundedIcon />}</IconButton></Tooltip> : null}
                  {!selectionMode ? <IconButton size="small" aria-label={`Actions for ${agent.title}`} onClick={(event) => setAgentMenu({ anchor: event.currentTarget, resource: agent.id })} sx={{ mr: 0.5 }}><MoreVertIcon /></IconButton> : null}
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
      <ResourceContextMenu
        state={agentMenu}
        onClose={() => setAgentMenu(undefined)}
        onOpenInNewTab={onOpenAgentInNewTab}
        actions={agentMenu ? [
          {
            id: "delegate",
            label: "Add Delegated Agent",
            icon: <PersonAddAlt1Icon fontSize="small" />,
            onSelect: onNewAgent,
          },
          ...(agentsById.get(agentMenu.resource)?.managerAgentId ? [{
            id: "promote",
            label: "Move to Top Level",
            icon: <ArrowUpwardIcon fontSize="small" />,
            disabled: promoteAgent.isPending,
            onSelect: (agentId: string) => promoteAgent.mutate(agentId),
          }] : []),
          {
            id: "delete",
            label: "Delete Agent",
            icon: <DeleteOutlineIcon fontSize="small" />,
            color: "error" as const,
            onSelect: (agentId: string) => setPendingDelete(agentsById.get(agentId)),
          },
        ] : []}
      />
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
