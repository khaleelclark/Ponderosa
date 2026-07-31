import AddIcon from "@mui/icons-material/Add";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import FilterListOutlinedIcon from "@mui/icons-material/FilterListOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import ViewListOutlinedIcon from "@mui/icons-material/ViewListOutlined";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  IconButton,
  InputLabel,
  Menu,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import { agentRoleProfile } from "@ponderosa/core";
import type {
  ConversationDto,
  AgentDto,
  AgentHealthDto,
  EngineDto,
} from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { AgentOrganizationDialog } from "./AgentDetail.parts";
import { TextInputDialog } from "./ConfirmationDialogs";
import {
  ResourceContextMenu,
  type ResourceContextMenuState,
} from "./ResourceContextMenu";
import {
  CollectionEmptyState,
  CollectionTimestamp,
  CollectionToolbar,
  CollectionWorkspace,
  ResourceRow,
} from "./CollectionPrimitives";
import {
  agentBelongsToConversation,
  agentStatusColor,
  agentStatusLabel,
  orderedAgentOrganization,
  type AgentStatus,
} from "../agents";
import {
  agentHasCollapsedAncestor,
  agentHierarchyContextIds,
  agentStatusFilterOptions,
  matchesAgentStatusFilters,
  type StatusFilter,
} from "./AgentsTab.helpers";

function AgentRosterShell({
  collection,
  scopeLabel,
  headerActions,
  toolbar,
  children,
}: {
  collection?: {
    title: string;
    detail: string;
    totalCount?: number;
    variant?: "page" | "embedded";
  };
  scopeLabel?: string;
  headerActions: ReactNode;
  toolbar: ReactNode;
  children: ReactNode;
}): JSX.Element {
  if (collection) {
    return (
      <CollectionWorkspace
        icon={<SmartToyOutlinedIcon />}
        title={collection.title}
        detail={collection.detail}
        primaryAction={
          collection.variant === "embedded" ? undefined : headerActions
        }
        toolbar={toolbar}
        listLabel={collection.title}
        variant={collection.variant}
      >
        {children}
      </CollectionWorkspace>
    );
  }
  return (
    <Box
      data-testid="agent-roster"
      sx={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateRows: "auto auto minmax(0, 1fr)",
      }}
    >
      <Stack
        direction="row"
        useFlexGap
        flexWrap="wrap"
        spacing={1}
        sx={{
          alignItems: "center",
          px: { xs: 1.5, md: 2 },
          py: 1.25,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="h1">
            Agents
          </Typography>
          {scopeLabel ? (
            <Typography variant="caption" color="text.secondary">
              {scopeLabel} organization
            </Typography>
          ) : null}
        </Box>
        {headerActions}
      </Stack>
      {toolbar}
      {children}
    </Box>
  );
}

export function AgentsTab({
  searchValue,
  onSearchValueChange,
  agents,
  projectId,
  engines,
  conversations,
  statusByAgentId,
  healthByAgentId,
  onOpenAgent,
  onOpenAgentInNewTab,
  onOpenAgentSettings,
  onAgentsDeleted,
  onNewAgent,
  showImportAction = true,
  projectByAgentId,
  starredAgentIds,
  onToggleStar,
  displayOrder,
  selectionAllowed = true,
  onReorder,
  toolbarControls,
  scopeLabel,
  collection,
  collectionFooter,
  visibleLimit,
  organizationRootAgentId,
}: {
  searchValue?: string;
  onSearchValueChange?(value: string): void;
  agents: AgentDto[];
  projectId?: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  statusByAgentId: ReadonlyMap<string, AgentStatus>;
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>;
  onOpenAgent(agentId: string): void;
  onOpenAgentInNewTab?(agentId: string): void;
  onOpenAgentSettings?(agentId: string): void;
  onAgentsDeleted?(projectId: string, agentIds: string[]): void;
  onNewAgent(managerAgentId?: string): void;
  showImportAction?: boolean;
  projectByAgentId?: Map<string, { id: string; label: string }>;
  starredAgentIds?: ReadonlySet<string>;
  onToggleStar?(agentId: string): void;
  displayOrder?: readonly string[];
  selectionAllowed?: boolean;
  onReorder?(
    sourceAgentId: string,
    targetAgentId: string,
    position?: "before" | "after",
  ): void;
  toolbarControls?: ReactNode;
  scopeLabel?: string;
  collection?: {
    title: string;
    detail: string;
    totalCount?: number;
    variant?: "page" | "embedded";
  };
  collectionFooter?: ReactNode;
  /** Bound large embedded rosters while retaining full hierarchy context. */
  visibleLimit?: number;
  /** Limit the roster to descendants of this Agent while retaining the full
   * Project organization for parent labels and hierarchy validation. */
  organizationRootAgentId?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [statusFilters, setStatusFilters] = useState<StatusFilter[]>([]);
  const [masterFilter, setMasterFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const effectiveSearch = searchValue ?? search;
  const setEffectiveSearch = onSearchValueChange ?? setSearch;
  const [pendingDelete, setPendingDelete] = useState<AgentDto | undefined>();
  const [pendingRename, setPendingRename] = useState<AgentDto | undefined>();
  const [pendingOrganization, setPendingOrganization] = useState<
    AgentDto | undefined
  >();
  const [organizationParentId, setOrganizationParentId] = useState("");
  const [bulkError, setBulkError] = useState<string>();
  const [stoppingAll, setStoppingAll] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteSelectedGroups, setDeleteSelectedGroups] = useState<
    Array<{ projectId: string; agentIds: string[] }>
  >([]);
  const [importOpen, setImportOpen] = useState(false);
  const [agentMenu, setAgentMenu] =
    useState<ResourceContextMenuState<string>>();
  const [statusAnchor, setStatusAnchor] = useState<HTMLElement>();
  const [draggedAgentId, setDraggedAgentId] = useState<string>();
  const [organizationView, setOrganizationView] = useState<
    "hierarchy" | "flat"
  >("hierarchy");
  const [collapsedAgentIds, setCollapsedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );

  const updateOrganization = useMutation({
    mutationFn: () => {
      if (!pendingOrganization)
        throw new Error("Choose an Agent before changing its reporting line.");
      return api.updateAgentOrganization(pendingOrganization.id, {
        managerAgentId: organizationParentId || null,
      });
    },
    onSuccess: updated => {
      setPendingOrganization(undefined);
      queryClient.setQueriesData<AgentDto[]>(
        { queryKey: queryKeys.agents.all },
        current =>
          current?.map(agent => (agent.id === updated.id ? updated : agent)),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(updated.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(updated.id),
      });
    },
  });
  const renameAgent = useMutation({
    mutationFn: ({ agent, title }: { agent: AgentDto; title: string }) =>
      api.updateAgent(agent.id, { title }),
    onSuccess: updated => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(updated.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(updated.id),
      });
      setPendingRename(undefined);
    },
  });

  const masterName = (id: string | undefined): string =>
    id
      ? (conversations.find(master => master.id === id)?.title ??
        "Unknown Project Chat")
      : "Unassigned";

  const organizationRows = orderedAgentOrganization(agents);
  const agentsById = new Map(agents.map(agent => [agent.id, agent]));
  const childrenByManager = new Map<string, AgentDto[]>();
  for (const agent of agents) {
    if (!agent.managerAgentId || !agentsById.has(agent.managerAgentId))
      continue;
    childrenByManager.set(agent.managerAgentId, [
      ...(childrenByManager.get(agent.managerAgentId) ?? []),
      agent,
    ]);
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
  const scopedAgentIds = organizationRootAgentId
    ? new Set(descendantIds(organizationRootAgentId))
    : new Set(organizationRows.map(({ agent }) => agent.id));
  const rootDepth = organizationRootAgentId
    ? (organizationRows.find(
        ({ agent }) => agent.id === organizationRootAgentId,
      )?.depth ?? -1)
    : -1;
  const scopedOrganizationRows = organizationRows
    .filter(({ agent }) => scopedAgentIds.has(agent.id))
    .map(({ agent, depth }) => ({
      agent,
      depth: organizationRootAgentId
        ? Math.max(0, depth - rootDepth - 1)
        : depth,
    }));
  const scopedAgents = scopedOrganizationRows.map(({ agent }) => agent);
  const orderRank = new Map(displayOrder?.map((id, index) => [id, index]));
  const matchingAgentIds = new Set(
    scopedOrganizationRows
      .filter(({ agent }) => {
        const status = statusByAgentId.get(agent.id) ?? "idle";
        if (!matchesAgentStatusFilters(agent, status, statusFilters))
          return false;
        if (
          masterFilter !== "all" &&
          !agentBelongsToConversation(agent, masterFilter)
        ) {
          return false;
        }
        if (
          effectiveSearch.trim() &&
          !agent.title
            .toLocaleLowerCase()
            .includes(effectiveSearch.trim().toLocaleLowerCase())
        )
          return false;
        return true;
      })
      .map(({ agent }) => agent.id),
  );
  const filtersActive = Boolean(
    effectiveSearch.trim() || statusFilters.length || masterFilter !== "all",
  );
  const contextAgentIds =
    organizationView === "hierarchy"
      ? new Set(
          [...agentHierarchyContextIds(agents, matchingAgentIds)].filter(id =>
            scopedAgentIds.has(id),
          ),
        )
      : new Set(matchingAgentIds);
  const filtered = (
    organizationView === "flat"
      ? scopedOrganizationRows
          .filter(({ agent }) => matchingAgentIds.has(agent.id))
          .map(({ agent }) => ({ agent, depth: 0 }))
      : scopedOrganizationRows.filter(
          ({ agent }) =>
            contextAgentIds.has(agent.id) &&
            (filtersActive ||
              !agentHasCollapsedAncestor(agent, agentsById, collapsedAgentIds)),
        )
  ).sort((left, right) =>
    organizationView === "flat" && displayOrder
      ? (orderRank.get(left.agent.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderRank.get(right.agent.id) ?? Number.MAX_SAFE_INTEGER)
      : 0,
  );
  const visibleFiltered = visibleLimit === undefined
    ? filtered
    : filtered.slice(0, visibleLimit);
  const statusOptions = agentStatusFilterOptions(scopedAgents, statusByAgentId);
  const activeRunTargets = scopedAgents.flatMap(agent => {
    const runId = healthByAgentId.get(agent.id)?.runtimeActivity?.executionId;
    return runId ? [{ agentId: agent.id, runId }] : [];
  });
  const toggleSelection = (agentId: string) =>
    setSelectedAgentIds(current => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  const leaveSelectionMode = () => {
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
    setDeleteSelectedGroups([]);
  };
  const beginSelectedDeletion = () => {
    const grouped = new Map<string, string[]>();
    for (const agentId of selectedAgentIds) {
      const owningProjectId = projectByAgentId?.get(agentId)?.id ?? projectId;
      if (!owningProjectId) {
        setBulkError(
          "Ponderosa could not determine the Project for every selected Agent.",
        );
        return;
      }
      grouped.set(owningProjectId, [
        ...(grouped.get(owningProjectId) ?? []),
        agentId,
      ]);
    }
    setBulkError(undefined);
    setDeleteSelectedGroups(
      [...grouped].map(([owningProjectId, agentIds]) => ({
        projectId: owningProjectId,
        agentIds,
      })),
    );
  };
  const stopAll = async () => {
    setStoppingAll(true);
    setBulkError(undefined);
    const results = await Promise.allSettled(
      activeRunTargets.map(({ agentId, runId }) =>
        api.cancelRun(agentId, {
          targetRunId: runId,
          idempotencyKey: `bulk-stop:${agentId}:${runId}:${createClientId()}`,
        }),
      ),
    );
    const failed = results.filter(item => item.status === "rejected").length;
    if (failed)
      setBulkError(
        `${activeRunTargets.length - failed} agents stopped; ${failed} could not be stopped. Retry or open those agents for details.`,
      );
    await queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    setStoppingAll(false);
  };
  const embeddedCollection = collection?.variant === "embedded";
  const collectionPresentation = collection
    ? {
        ...collection,
        detail:
          collection.totalCount !== undefined &&
          filtered.length !== collection.totalCount
            ? `${filtered.length} of ${collection.totalCount} Agents`
            : collection.detail,
      }
    : undefined;
  const visibleAgentIds = visibleFiltered.map(({ agent }) => agent.id);
  const allVisibleSelected =
    visibleAgentIds.length > 0 &&
    visibleAgentIds.every(id => selectedAgentIds.has(id));
  const toggleVisibleSelection = () =>
    setSelectedAgentIds(current => {
      const next = new Set(current);
      const shouldSelect = visibleAgentIds.some(id => !current.has(id));
      visibleAgentIds.forEach(id =>
        shouldSelect ? next.add(id) : next.delete(id),
      );
      return next;
    });
  const selectionControls = selectionMode ? (
    <Stack
      data-collection-toolbar-actions
      direction="row"
      spacing={0.75}
      useFlexGap
      flexWrap="wrap"
      sx={{ alignItems: "center" }}
    >
      <Button color="inherit" size="small" onClick={toggleVisibleSelection}>
        {allVisibleSelected ? "Clear Visible" : "Select All Visible"}
      </Button>
      <Button
        color="error"
        variant="outlined"
        size="small"
        disabled={selectedAgentIds.size === 0}
        onClick={beginSelectedDeletion}
      >
        Delete Selected ({selectedAgentIds.size})
      </Button>
      <Button color="inherit" size="small" onClick={leaveSelectionMode}>
        Cancel Selection
      </Button>
    </Stack>
  ) : null;
  const headerActions = (
    <Stack
      data-collection-toolbar-actions
      direction="row"
      spacing={1}
      useFlexGap
      flexWrap="wrap"
      sx={{ alignItems: "center" }}
    >
      {selectionMode ? selectionControls : null}
      {!selectionMode && selectionAllowed && agents.length > 0 ? (
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={() => setSelectionMode(true)}
        >
          Select Agents
        </Button>
      ) : null}
      {collection && !selectionMode ? (
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => onNewAgent(organizationRootAgentId)}
        >
          New Agent
        </Button>
      ) : null}
      {!selectionMode && activeRunTargets.length > 0 ? (
        <Button
          size="small"
          color="error"
          variant="outlined"
          disabled={stoppingAll}
          onClick={() => void stopAll()}
        >
          {stoppingAll ? "Stopping…" : "Stop All"}
        </Button>
      ) : null}
      {!selectionMode && showImportAction ? (
        <Button
          size="small"
          color="inherit"
          variant="outlined"
          startIcon={<FileUploadOutlinedIcon />}
          disabled={!projectId}
          onClick={() => setImportOpen(true)}
        >
          Import
        </Button>
      ) : null}
    </Stack>
  );
  return (
    <AgentRosterShell
      collection={collectionPresentation}
      scopeLabel={scopeLabel}
      headerActions={headerActions}
      toolbar={
        <CollectionToolbar
          search={effectiveSearch}
          onSearch={setEffectiveSearch}
          searchLabel="Search Agents"
          searchMaxWidth={300}
          reorderHint={
            organizationView === "flat" && Boolean(onReorder)
          }
        >
          {toolbarControls}
              <Stack
                direction="row"
                role="group"
                aria-label="Agent organization view"
                sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}
              >
                <Tooltip title="Hierarchy">
                  <IconButton
                    size="small"
                    color={organizationView === "hierarchy" ? "primary" : "default"}
                    aria-pressed={organizationView === "hierarchy"}
                    aria-label="Show Agent hierarchy"
                    onClick={() => setOrganizationView("hierarchy")}
                  >
                    <AccountTreeOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Flat List">
                  <IconButton
                    size="small"
                    color={organizationView === "flat" ? "primary" : "default"}
                    aria-pressed={organizationView === "flat"}
                    aria-label="Show flat Agent list"
                    onClick={() => setOrganizationView("flat")}
                  >
                    <ViewListOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Button
                color="inherit"
                variant={statusFilters.length ? "outlined" : "text"}
                startIcon={<FilterListOutlinedIcon />}
                onClick={event => setStatusAnchor(event.currentTarget)}
                aria-label="Filter Agents by status"
                sx={{ minHeight: 40, whiteSpace: "nowrap" }}
              >
                {statusFilters.length
                  ? `Status (${statusFilters.length})`
                  : "Status"}
              </Button>
              {statusAnchor ? (
                <Menu
                  anchorEl={statusAnchor}
                  open
                  onClose={() => setStatusAnchor(undefined)}
                >
                  <MenuItem onClick={() => setStatusFilters([])}>
                    <Checkbox checked={statusFilters.length === 0} />
                    All ({scopedAgents.length})
                  </MenuItem>
                  {statusOptions
                    .filter(option => option.value !== "all")
                    .map(option => (
                      <MenuItem
                        key={option.value}
                        onClick={() =>
                          setStatusFilters(current =>
                            current.includes(option.value as StatusFilter)
                              ? current.filter(value => value !== option.value)
                              : [...current, option.value as StatusFilter],
                          )
                        }
                      >
                        <Checkbox
                          checked={statusFilters.includes(
                            option.value as StatusFilter,
                          )}
                        />
                        {option.label} ({option.count})
                      </MenuItem>
                    ))}
                </Menu>
              ) : null}
              {embeddedCollection ? null : (
                <FormControl
                  size="small"
                  sx={{ minWidth: 155, width: { xs: "100%", sm: "auto" } }}
                >
                  <InputLabel id="agents-master-filter-label">
                    Project Chat
                  </InputLabel>
                  <Select
                    labelId="agents-master-filter-label"
                    label="Project Chat"
                    value={masterFilter}
                    onChange={(event: SelectChangeEvent) =>
                      setMasterFilter(event.target.value)
                    }
                  >
                    <MenuItem value="all">All Project Chats</MenuItem>
                    {conversations.map(master => (
                      <MenuItem key={master.id} value={master.id}>
                        {master.title}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
              {embeddedCollection ? headerActions : null}
        </CollectionToolbar>
      }
    >
      {bulkError ? (
        <Alert severity="warning" sx={{ mx: 2, mt: 1 }}>
          {bulkError}
        </Alert>
      ) : null}

      {projectId ? (
        <ImportAgentDialog
          open={importOpen}
          projectId={projectId}
          engines={engines}
          conversations={conversations}
          initialConversationId={conversations[0]?.id}
          onClose={() => setImportOpen(false)}
          onImported={onOpenAgent}
        />
      ) : null}

      <Box
        sx={{
          minHeight: 0,
          minWidth: 0,
          overflowY: collection ? "visible" : "auto",
          overflowX: "hidden",
          p: collection ? 0 : { xs: 1, sm: 1.5, md: 2 },
          pt: 0,
        }}
      >
        {filtered.length === 0 ? (
          <CollectionEmptyState
            title={
              scopedAgents.length === 0
                ? organizationRootAgentId
                  ? "No Delegated Agents Yet"
                  : "No Agents Yet"
                : "No Agents match these filters"
            }
            detail={
              scopedAgents.length === 0
                ? organizationRootAgentId
                  ? "Create a delegated Agent to build this organization."
                  : "Create an Agent to get started."
                : "Try a different search, status, Project, or Chat filter."
            }
            action={
              statusFilters.length > 0 || masterFilter !== "all" || effectiveSearch
                ? {
                    label: "Clear Filters",
                    onClick: () => {
                      setStatusFilters([]);
                      setMasterFilter("all");
                      setEffectiveSearch("");
                    },
                  }
                : undefined
            }
          />
        ) : (
          <Stack spacing={0.75} role="tree" aria-label="Agent organization">
            {visibleFiltered.map(({ agent, depth }, index) => {
              const status = statusByAgentId.get(agent.id) ?? "idle";
              const profile = agentRoleProfile(agent);
              const organizationParent = agent.managerAgentId
                ? agents.find(
                    candidate => candidate.id === agent.managerAgentId,
                  )
                : undefined;
              const orphaned = Boolean(
                agent.managerAgentId && !organizationParent,
              );
              const descendants = descendantIds(agent.id);
              const childAgents = childrenByManager.get(agent.id) ?? [];
              const expanded = !collapsedAgentIds.has(agent.id);
              const contextOnly = !matchingAgentIds.has(agent.id);
              const activeDescendants = descendants.filter(id =>
                [
                  "running",
                  "waiting",
                  "blocked",
                  "stalled",
                  "interrupted",
                  "compacting",
                ].includes(statusByAgentId.get(id) ?? "idle"),
              ).length;
              return (
                <Stack
                  key={agent.id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={childAgents.length ? expanded : undefined}
                  spacing={0.25}
                  sx={{
                    ml:
                      organizationView === "hierarchy"
                        ? `${Math.min(depth, 8) * 28}px`
                        : 0,
                    pl: organizationView === "hierarchy" && depth ? 0.75 : 0,
                    opacity: contextOnly ? 0.62 : 1,
                    "& > .MuiPaper-root": {
                      borderLeftWidth:
                        organizationView === "hierarchy" && depth ? 3 : 1,
                      borderLeftColor:
                        organizationView === "hierarchy" && depth
                          ? "primary.main"
                          : "divider",
                      bgcolor:
                        organizationView === "hierarchy" && depth
                          ? "var(--ponderosa-delegated-surface)"
                          : "background.paper",
                      "& > button:hover":
                        organizationView === "hierarchy" && depth
                          ? {
                              bgcolor: "var(--ponderosa-delegated-hover)",
                            }
                          : undefined,
                    },
                  }}
                >
                  <ResourceRow
                    label={agent.title}
                    description={
                      <>
                        {orphaned
                          ? "Unlinked Agent"
                          : organizationParent
                            ? `Delegated under ${organizationParent.title}`
                            : profile.role}
                        {!expanded && descendants.length
                          ? ` · ${descendants.length} children${activeDescendants ? `, ${activeDescendants} active` : ""}`
                          : ""}
                      </>
                    }
                    icon={<SmartToyOutlinedIcon />}
                    leading={
                      <>
                        {organizationView === "hierarchy" ? (
                          <IconButton
                            size="small"
                            disabled={childAgents.length === 0}
                            aria-label={
                              childAgents.length
                                ? `${expanded ? "Collapse" : "Expand"} ${agent.title}`
                                : `${agent.title} has no delegated agents`
                            }
                            onClick={event => {
                              event.stopPropagation();
                              setCollapsedAgentIds(current => {
                                const next = new Set(current);
                                if (next.has(agent.id)) next.delete(agent.id);
                                else next.add(agent.id);
                                return next;
                              });
                            }}
                            sx={{ ml: 0.5 }}
                          >
                            {childAgents.length ? (
                              expanded ? (
                                <KeyboardArrowDownIcon />
                              ) : (
                                <KeyboardArrowRightIcon />
                              )
                            ) : (
                              <Box sx={{ width: 24 }} />
                            )}
                          </IconButton>
                        ) : null}
                        {selectionMode ? (
                          <Checkbox
                            checked={selectedAgentIds.has(agent.id)}
                            onChange={() => toggleSelection(agent.id)}
                            onClick={event => event.stopPropagation()}
                            inputProps={{
                              "aria-label": `Select ${agent.title}`,
                            }}
                            sx={{ ml: 0.5 }}
                          />
                        ) : null}
                      </>
                    }
                    meta={
                      <Stack
                        direction="row"
                        spacing={1.25}
                        sx={{ alignItems: "center", minWidth: 0 }}
                      >
                        <Chip
                          size="small"
                          label={agentStatusLabel(status)}
                          color={agentStatusColor(status)}
                        />
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          noWrap
                          sx={{
                            display: { xs: "none", md: "block" },
                            width: 150,
                          }}
                        >
                          {projectByAgentId?.get(agent.id)?.label ??
                            masterName(agent.conversationId)}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          noWrap
                          sx={{
                            display: { xs: "none", sm: "block" },
                            width: 100,
                          }}
                        >
                          {agent.activeEngine}
                        </Typography>
                        <CollectionTimestamp
                          value={agent.updatedAt}
                          hideBelow="lg"
                        />
                      </Stack>
                    }
                    starAction={
                      !selectionMode && onToggleStar ? (
                        <Tooltip
                          title={
                            starredAgentIds?.has(agent.id)
                              ? "Unstar Agent"
                              : "Star Agent"
                          }
                        >
                          <IconButton
                            aria-label={
                              starredAgentIds?.has(agent.id)
                                ? `Unstar ${agent.title}`
                                : `Star ${agent.title}`
                            }
                            onClick={() => onToggleStar(agent.id)}
                          >
                            {starredAgentIds?.has(agent.id) ? (
                              <StarRoundedIcon
                                sx={{ color: "var(--ponderosa-star)" }}
                              />
                            ) : (
                              <StarBorderRoundedIcon />
                            )}
                          </IconButton>
                        </Tooltip>
                      ) : null
                    }
                    overflowAction={
                      !selectionMode ? (
                        <IconButton
                          data-resource-menu-trigger
                          size="small"
                          aria-label={`Actions for ${agent.title}`}
                          aria-haspopup="menu"
                          aria-expanded={agentMenu?.resource === agent.id}
                          onClick={event =>
                            setAgentMenu({
                              anchor: event.currentTarget,
                              resource: agent.id,
                            })
                          }
                        >
                          <MoreVertIcon />
                        </IconButton>
                      ) : null
                    }
                    onOpen={() =>
                      selectionMode
                        ? toggleSelection(agent.id)
                        : onOpenAgent(agent.id)
                    }
                    onContextMenu={
                      selectionMode
                        ? undefined
                        : anchor => setAgentMenu({ anchor, resource: agent.id })
                    }
                    draggable={
                      organizationView === "flat" && Boolean(onReorder)
                    }
                    onDragStart={() => setDraggedAgentId(agent.id)}
                    onDragEnd={() => setDraggedAgentId(undefined)}
                    onDrop={() => {
                      if (draggedAgentId && draggedAgentId !== agent.id)
                        onReorder?.(draggedAgentId, agent.id);
                      setDraggedAgentId(undefined);
                    }}
                    onKeyboardMove={
                      organizationView === "flat" && onReorder
                        ? direction => {
                            const target =
                              filtered[
                                direction === "up" ? index - 1 : index + 1
                              ];
                            if (!target) return false;
                            onReorder(
                              agent.id,
                              target.agent.id,
                              direction === "up" ? "before" : "after",
                            );
                            return {
                              position:
                                direction === "up" ? index : index + 2,
                              total: filtered.length,
                            };
                          }
                        : undefined
                    }
                  />
                </Stack>
              );
            })}
          </Stack>
        )}
      </Box>
      {collectionFooter}

      {pendingDelete ? (
        <AgentDeletionDialog
          open={Boolean(pendingDelete)}
          projectId={pendingDelete.projectId}
          rootAgentIds={pendingDelete ? [pendingDelete.id] : []}
          onClose={() => setPendingDelete(undefined)}
          onDeleted={(deletedAgentIds) => {
            onAgentsDeleted?.(pendingDelete.projectId, deletedAgentIds);
            setPendingDelete(undefined);
          }}
        />
      ) : null}
      <TextInputDialog
        open={Boolean(pendingRename)}
        title="Rename Agent"
        label="Agent name"
        initialValue={pendingRename?.title ?? ""}
        confirmLabel="Save"
        pendingLabel="Saving…"
        pending={renameAgent.isPending}
        error={renameAgent.isError ? String(renameAgent.error) : undefined}
        validate={(value) => value.trim() ? undefined : "Enter an Agent name."}
        onCancel={() => {
          renameAgent.reset();
          setPendingRename(undefined);
        }}
        onConfirm={(title) => {
          if (pendingRename)
            renameAgent.mutate({ agent: pendingRename, title: title.trim() });
        }}
      />
      {pendingOrganization ? (
        <AgentOrganizationDialog
          open
          onClose={() => {
            if (updateOrganization.isPending) return;
            updateOrganization.reset();
            setPendingOrganization(undefined);
          }}
          organizationParentId={organizationParentId}
          setOrganizationParentId={setOrganizationParentId}
          agent={pendingOrganization}
          agents={agents}
          updateOrganization={updateOrganization}
        />
      ) : null}
      <ResourceContextMenu
        state={agentMenu}
        onClose={() => setAgentMenu(undefined)}
        onOpenInNewTab={onOpenAgentInNewTab}
        actions={
          agentMenu
            ? [
                ...(onOpenAgentSettings
                  ? [
                      {
                        id: "settings",
                        label: "Agent Settings",
                        icon: <SettingsOutlinedIcon fontSize="small" />,
                        onSelect: onOpenAgentSettings,
                      },
                    ]
                  : []),
                {
                  id: "rename",
                  label: "Rename",
                  icon: <EditOutlinedIcon fontSize="small" />,
                  onSelect: (agentId: string) =>
                    setPendingRename(agentsById.get(agentId)),
                },
                {
                  id: "delegate",
                  label: "Add Delegated Agent",
                  icon: <PersonAddAlt1Icon fontSize="small" />,
                  onSelect: onNewAgent,
                },
                {
                  id: "reporting-line",
                  label: "Change Reporting Line",
                  icon: <AccountTreeOutlinedIcon fontSize="small" />,
                  onSelect: (agentId: string) => {
                    const agent = agentsById.get(agentId);
                    if (!agent) return;
                    setOrganizationParentId(agent.managerAgentId ?? "");
                    updateOrganization.reset();
                    setPendingOrganization(agent);
                  },
                },
                {
                  id: "delete",
                  label: "Delete",
                  icon: <DeleteOutlineIcon fontSize="small" />,
                  color: "error" as const,
                  onSelect: (agentId: string) =>
                    setPendingDelete(agentsById.get(agentId)),
                },
              ]
            : []
        }
      />
      {deleteSelectedGroups[0] ? (
        <AgentDeletionDialog
          open
          projectId={deleteSelectedGroups[0].projectId}
          rootAgentIds={deleteSelectedGroups[0].agentIds}
          title={
            deleteSelectedGroups.length > 1
              ? `Delete selected agents? (${deleteSelectedGroups.length} Projects remaining)`
              : "Delete selected agents?"
          }
          confirmationText="DELETE SELECTED"
          onClose={() => setDeleteSelectedGroups([])}
          onDeleted={(deletedAgentIds) => {
            const deletedProjectId = deleteSelectedGroups[0]!.projectId;
            onAgentsDeleted?.(deletedProjectId, deletedAgentIds);
            if (deleteSelectedGroups.length > 1) {
              const deletedIds = new Set(deletedAgentIds);
              setSelectedAgentIds(current => {
                const next = new Set(current);
                deletedIds.forEach(id => next.delete(id));
                return next;
              });
              setDeleteSelectedGroups(current => current.slice(1));
            } else {
              leaveSelectionMode();
            }
          }}
        />
      ) : null}
    </AgentRosterShell>
  );
}
