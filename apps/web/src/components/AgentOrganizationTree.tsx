import AddIcon from "@mui/icons-material/Add";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type {
  AgentOperationalStatus,
  AgentOrganizationNodeDto,
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import {
  isLiveOrganizationNode,
  organizationOwnerLabel,
  pruneExpandedAgentIds,
} from "../agentOrganization";
import { agentStatusColor, agentStatusPresentation } from "../agents";
import { useAgentOrganization } from "../hooks/useAgentOrganization";
import { queryKeys } from "../queryKeys";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { TextInputDialog } from "./ConfirmationDialogs";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";
import {
  ResourceContextMenu,
  type ResourceContextMenuState,
} from "./ResourceContextMenu";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";

const STATUS_OPTIONS: Array<{ value: "" | AgentOperationalStatus; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "preparing", label: "Preparing" },
  { value: "waiting", label: "Waiting" },
  { value: "needs_decision", label: "Needs decision" },
  { value: "blocked", label: "Blocked" },
  { value: "stalled", label: "Stalled" },
  { value: "interrupted", label: "Interrupted" },
  { value: "compacting", label: "Refreshing context" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
  { value: "idle", label: "Idle" },
];

interface TreeState {
  projectId: string;
  expanded: ReadonlySet<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  focusedId?: string;
  setFocusedId(id: string): void;
  treeRef: MutableRefObject<HTMLDivElement | null>;
  ownerLoading: boolean;
  connectionStatus: "connecting" | "live" | "reconnecting" | "stale" | "unavailable";
  phaseEvidenceFresh: boolean;
  allowExpansion: boolean;
  onOpenAgent(agentId: string): void;
  onActions(node: AgentOrganizationNodeDto, anchor: HTMLElement): void;
  registerNode(agentId: string, parentId?: string): () => void;
}

function focusTreeRow(tree: HTMLDivElement | null, selector: string): void {
  globalThis.setTimeout(() => {
    tree?.querySelector<HTMLElement>(selector)?.focus();
  }, 0);
}

function OrganizationRow({
  node,
  index,
  level,
  setSize,
  parentId,
  state,
}: {
  node: AgentOrganizationNodeDto;
  index: number;
  level: number;
  setSize: number;
  parentId?: string;
  state: TreeState;
}): JSX.Element {
  const live = isLiveOrganizationNode(node);
  const expanded = live && state.expanded.has(node.id);
  const expandable = live && state.allowExpansion && node.directReportCount > 0;
  useEffect(
    () => state.registerNode(node.id, parentId),
    [node.id, parentId, state.registerNode],
  );
  const presentation = live
    ? agentStatusPresentation(node.health, {
        status: node.health?.status,
        connectionStatus: state.connectionStatus,
        phaseEvidenceFresh: state.phaseEvidenceFresh && !state.ownerLoading,
      })
    : undefined;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(state.treeRef.current?.querySelectorAll<HTMLElement>("[role='treeitem']") ?? [])];
    const currentIndex = rows.indexOf(event.currentTarget);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[currentIndex + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if (event.key === "ArrowRight" && expandable) {
      event.preventDefault();
      if (!expanded) {
        state.setExpanded(current => new Set(current).add(node.id));
        focusTreeRow(state.treeRef.current, `[data-parent-id="${CSS.escape(node.id)}"]`);
      } else {
        focusTreeRow(state.treeRef.current, `[data-parent-id="${CSS.escape(node.id)}"]`);
      }
    } else if (event.key === "ArrowLeft" && live) {
      event.preventDefault();
      if (expanded) {
        state.setExpanded(current => {
          const next = new Set(current);
          next.delete(node.id);
          return next;
        });
      } else if (parentId) {
        focusTreeRow(state.treeRef.current, `[data-agent-id="${CSS.escape(parentId)}"]`);
      }
    } else if (event.key === "Enter" && live) {
      event.preventDefault();
      state.onOpenAgent(node.id);
    }
  };
  return (
    <Box
      role="treeitem"
      data-agent-id={node.id}
      data-parent-id={parentId}
      aria-level={level}
      aria-setsize={setSize}
      aria-posinset={index + 1}
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={state.focusedId === node.id ? 0 : -1}
      onFocus={() => state.setFocusedId(node.id)}
      onKeyDown={handleKeyDown}
      sx={{ outline: "none", ml: `${Math.min(level - 1, 5) * 18}px` }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          minHeight: 56,
          alignItems: "center",
          border: 1,
          borderLeftWidth: level > 1 ? 3 : 1,
          borderColor: "divider",
          borderLeftColor: level > 1 ? "primary.main" : "divider",
          borderRadius: 1.5,
          px: 0.5,
          py: 0.5,
          bgcolor: level > 1 ? "var(--ponderosa-delegated-surface)" : "background.paper",
          "[role='treeitem']:focus-visible > &": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: 2,
          },
        }}
      >
        {live && state.allowExpansion ? (
          <IconButton
            tabIndex={-1}
            aria-label={expandable
              ? `${expanded ? "Collapse" : "Expand"} ${node.title}`
              : `${node.title} has no direct reports`}
            disabled={!expandable}
            onClick={() => state.setExpanded(current => {
              const next = new Set(current);
              if (next.has(node.id)) next.delete(node.id);
              else next.add(node.id);
              return next;
            })}
            sx={{ width: 44, height: 44, flex: "0 0 auto" }}
          >
            {expandable
              ? expanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />
              : <Box sx={{ width: 24 }} />}
          </IconButton>
        ) : (
          <Box sx={{ width: 12, flex: "0 0 auto" }} />
        )}
        <SmartToyOutlinedIcon color={live ? "inherit" : "disabled"} />
        <Box
          component={live ? "button" : "div"}
          type={live ? "button" : undefined}
          tabIndex={live ? -1 : undefined}
          onClick={live ? () => state.onOpenAgent(node.id) : undefined}
          sx={{
            minWidth: 0,
            flex: 1,
            border: 0,
            bgcolor: "transparent",
            color: "inherit",
            textAlign: "left",
            p: 0,
            minHeight: 44,
            cursor: live ? "pointer" : "default",
          }}
        >
          <Typography fontWeight={600} sx={{ overflowWrap: "anywhere" }}>
            {node.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            {organizationOwnerLabel(node, live && node.relation.kind === "managed" && state.ownerLoading)}
            {live && node.directReportCount > 0 ? ` · ${node.directReportCount} direct ${node.directReportCount === 1 ? "report" : "reports"}` : ""}
          </Typography>
          {!live ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
              ID: {node.id}
            </Typography>
          ) : null}
        </Box>
        {live && presentation ? (
          <Stack spacing={0.25} sx={{ alignItems: "flex-end", maxWidth: { xs: 120, sm: 220 } }}>
            <Chip
              size="small"
              label={presentation.label}
              color={agentStatusColor(node.health?.status ?? "idle")}
              aria-label={presentation.accessibleLabel}
              title={presentation.detail}
            />
            {node.health?.attention ? (
              <Typography variant="caption" color="error.main" sx={{ textAlign: "right" }}>
                Attention: {node.health.attention.status.replaceAll("_", " ")}
              </Typography>
            ) : null}
            <Typography variant="caption" color="text.secondary" sx={{ display: { xs: "none", sm: "block" } }}>
              {node.activeEngine}
            </Typography>
          </Stack>
        ) : null}
        {live ? (
          <IconButton
            aria-label={`Actions for ${node.title}`}
            tabIndex={-1}
            onClick={event => state.onActions(node, event.currentTarget)}
            sx={{ width: 44, height: 44 }}
          >
            <MoreVertIcon />
          </IconButton>
        ) : null}
      </Stack>
      {expanded ? (
        <OrganizationChildren parentId={node.id} level={level + 1} state={state} />
      ) : null}
    </Box>
  );
}

function OrganizationRows({
  items,
  level,
  total,
  parentId,
  state,
}: {
  items: AgentOrganizationNodeDto[];
  level: number;
  total: number;
  parentId?: string;
  state: TreeState;
}): JSX.Element {
  return (
    <Stack role={parentId ? "group" : undefined} spacing={0.75} sx={{ mt: parentId ? 0.75 : 0 }}>
      {items.map((node, index) => (
        <OrganizationRow
          key={node.id}
          node={node}
          index={index}
          level={level}
          setSize={total}
          parentId={parentId}
          state={state}
        />
      ))}
    </Stack>
  );
}

function PageFooter({
  hasNextPage,
  fetching,
  error,
  onMore,
}: {
  hasNextPage: boolean;
  fetching: boolean;
  error: boolean;
  onMore(): void;
}): JSX.Element | null {
  if (!hasNextPage && !error) return null;
  return (
    <Button
      color={error ? "error" : "inherit"}
      disabled={fetching}
      onClick={onMore}
      sx={{ minHeight: 44, mt: 0.75 }}
    >
      {fetching ? "Loading…" : error ? "Retry this page" : "Load more"}
    </Button>
  );
}

function OrganizationChildren({
  parentId,
  level,
  state,
}: {
  parentId: string;
  level: number;
  state: TreeState;
}): JSX.Element {
  const query = useAgentOrganization(state.projectId, {
    scope: "children",
    parentAgentId: parentId,
  });
  useEffect(() => {
    if (state.focusedId !== parentId || query.items.length === 0) return;
    focusTreeRow(
      state.treeRef.current,
      `[data-parent-id="${CSS.escape(parentId)}"]`,
    );
  }, [parentId, query.items.length, state.focusedId, state.treeRef]);
  return (
    <Box aria-busy={query.isFetching}>
      {query.isLoading ? <LinearProgress aria-label="Loading direct reports" /> : null}
      {query.isError && !query.pages ? (
        <Alert severity="error" action={<Button onClick={() => void query.refetch()}>Retry</Button>}>
          Direct reports could not be loaded.
        </Alert>
      ) : null}
      <OrganizationRows
        items={query.items}
        level={level}
        total={query.summary?.total ?? query.items.length}
        parentId={parentId}
        state={{ ...state, ownerLoading: query.isFetching }}
      />
      <PageFooter
        hasNextPage={Boolean(query.hasNextPage)}
        fetching={query.isFetchingNextPage}
        error={query.isFetchNextPageError}
        onMore={() => void (query.isFetchNextPageError ? query.refetch() : query.fetchNextPage())}
      />
    </Box>
  );
}

export function AgentOrganizationTree({
  projectId,
  scopeLabel,
  engines,
  conversations,
  onOpenAgent,
  onOpenAgentSettings,
  onAgentsDeleted,
  onNewAgent,
}: {
  projectId: string;
  scopeLabel: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  onOpenAgent(agentId: string): void;
  onOpenAgentSettings(agentId: string): void;
  onAgentsDeleted(agentIds: string[]): void;
  onNewAgent(managerAgentId?: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const connection = useWorkspaceConnection();
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | AgentOperationalStatus>("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string>();
  const [orphansExpanded, setOrphansExpanded] = useState(true);
  const [deletedExpanded, setDeletedExpanded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [menu, setMenu] = useState<ResourceContextMenuState<string>>();
  const [selectedNode, setSelectedNode] = useState<AgentOrganizationNodeDto>();
  const [pendingRename, setPendingRename] = useState<{ id: string; title: string }>();
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string }>();
  const mountedNodeIds = useRef(new Set<string>());
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => globalThis.clearTimeout(timer);
  }, [searchInput]);
  const filtered = Boolean(search || status);
  const roots = useAgentOrganization(projectId, {
    scope: "roots",
    search,
    status: status || undefined,
  });
  const orphans = useAgentOrganization(projectId, {
    scope: "orphaned",
    enabled: !filtered && orphansExpanded,
  });
  const deleted = useAgentOrganization(projectId, {
    scope: "deleted",
    enabled: !filtered && deletedExpanded,
  });
  const registerNode = useMemo(() => (agentId: string, parentId?: string) => {
    mountedNodeIds.current.add(agentId);
    return () => {
      mountedNodeIds.current.delete(agentId);
      setExpanded(current => pruneExpandedAgentIds(current, [agentId]));
      setFocusedId(current => {
        if (current !== agentId) return current;
        const survivingParentId = parentId && mountedNodeIds.current.has(parentId)
          ? parentId
          : undefined;
        focusTreeRow(
          treeRef.current,
          survivingParentId
            ? `[data-agent-id="${CSS.escape(survivingParentId)}"]`
            : "[role='treeitem']",
        );
        return survivingParentId;
      });
    };
  }, []);
  useEffect(() => {
    const first = roots.items[0]?.id ?? orphans.items[0]?.id ?? deleted.items[0]?.id;
    if (first) setFocusedId(current => current ?? first);
  }, [deleted.items, orphans.items, roots.items]);
  const state: TreeState = {
    projectId,
    expanded,
    setExpanded,
    focusedId,
    setFocusedId,
    treeRef,
    ownerLoading: roots.isFetching,
    connectionStatus: connection.status,
    phaseEvidenceFresh: connection.phaseEvidenceFresh,
    allowExpansion: !filtered,
    onOpenAgent,
    onActions: (node, anchor) => {
      setSelectedNode(node);
      setMenu({ resource: node.id, anchor });
    },
    registerNode,
  };
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.updateAgent(id, { title }),
    onSuccess: () => {
      setPendingRename(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.organizationProject(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
    },
  });
  const summary = roots.summary;
  return (
    <Box sx={{ height: "100%", minHeight: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <AccountTreeOutlinedIcon />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h1" variant="h6">Agent organization</Typography>
          <Typography variant="caption" color="text.secondary">{scopeLabel} · ownership from canonical reporting lines</Typography>
        </Box>
        <PrimaryHeaderActionsOutlet />
        <Button variant="outlined" startIcon={<FileUploadOutlinedIcon />} onClick={() => setImportOpen(true)} sx={{ minHeight: 44, display: { xs: "none", sm: "inline-flex" } }}>
          Import
        </Button>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => onNewAgent()} sx={{ minHeight: 44 }}>
          New Agent
        </Button>
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ p: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <TextField
          size="small"
          label="Search Agents"
          value={searchInput}
          onChange={event => setSearchInput(event.target.value)}
          inputProps={{ maxLength: 200 }}
          sx={{ flex: 1, "& .MuiInputBase-root": { minHeight: 44 } }}
        />
        <FormControl size="small" sx={{ minWidth: 180, "& .MuiInputBase-root": { minHeight: 44 } }}>
          <InputLabel id="agent-organization-status-label">Status</InputLabel>
          <Select
            labelId="agent-organization-status-label"
            value={status}
            label="Status"
            onChange={(event: SelectChangeEvent) => setStatus(event.target.value as "" | AgentOperationalStatus)}
          >
            {STATUS_OPTIONS.map(option => <MenuItem key={option.value || "all"} value={option.value}>{option.label}</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>
      <Box sx={{ overflowY: "auto", minHeight: 0, p: { xs: 1, sm: 1.5, md: 2 } }}>
        <Box aria-live="polite" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {roots.isFetching ? "Refreshing Agent organization" : `${roots.items.length} Agents visible`}
        </Box>
        {roots.isLoading ? <LinearProgress aria-label="Loading Agent organization" /> : null}
        {roots.isError && !roots.pages ? (
          <Alert severity="error" action={<Button onClick={() => void roots.refetch()}>Retry</Button>}>
            The Agent organization could not be loaded.
          </Alert>
        ) : null}
        <Stack ref={treeRef} role="tree" aria-label="Agent organization" spacing={1.5} aria-busy={roots.isFetching || undefined}>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
              {filtered ? "Filtered Agents" : `Reports to you (${summary?.specialGroupCounts.independent ?? 0})`}
            </Typography>
            {filtered ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.75 }}>
                Flat, server-paged results with canonical owner breadcrumbs. Status applies to each bounded candidate page.
              </Typography>
            ) : null}
            <OrganizationRows items={roots.items} level={1} total={summary?.total ?? roots.items.length} state={state} />
            <PageFooter
              hasNextPage={Boolean(roots.hasNextPage)}
              fetching={roots.isFetchingNextPage}
              error={roots.isFetchNextPageError}
              onMore={() => void (roots.isFetchNextPageError ? roots.refetch() : roots.fetchNextPage())}
            />
          </Box>
          {!filtered && (summary?.specialGroupCounts.orphaned ?? 0) > 0 ? (
            <Box>
              <Button
                color="inherit"
                startIcon={orphansExpanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                onClick={() => setOrphansExpanded(value => !value)}
                aria-expanded={orphansExpanded}
                aria-label={`${orphansExpanded ? "Collapse" : "Expand"} Orphaned Agents`}
                sx={{ minHeight: 44 }}
              >
                Orphaned ({summary?.specialGroupCounts.orphaned ?? 0})
              </Button>
              {orphansExpanded ? (
                <Box aria-busy={orphans.isFetching || undefined}>
                  <OrganizationRows items={orphans.items} level={1} total={orphans.summary?.total ?? orphans.items.length} state={{ ...state, ownerLoading: orphans.isFetching }} />
                  <PageFooter hasNextPage={Boolean(orphans.hasNextPage)} fetching={orphans.isFetchingNextPage} error={orphans.isFetchNextPageError} onMore={() => void (orphans.isFetchNextPageError ? orphans.refetch() : orphans.fetchNextPage())} />
                </Box>
              ) : null}
            </Box>
          ) : null}
          {!filtered && (summary?.specialGroupCounts.deleted ?? 0) > 0 ? (
            <Box>
              <Button
                color="inherit"
                startIcon={deletedExpanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                onClick={() => setDeletedExpanded(value => !value)}
                aria-expanded={deletedExpanded}
                aria-label={`${deletedExpanded ? "Collapse" : "Expand"} Deleted History`}
                sx={{ minHeight: 44 }}
              >
                Deleted History ({summary?.specialGroupCounts.deleted ?? 0})
              </Button>
              {deletedExpanded ? (
                <Box aria-busy={deleted.isFetching || undefined}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.75 }}>
                    Minimal tombstones only. Deleted Agents cannot expand or reconstruct ancestry.
                  </Typography>
                  <OrganizationRows items={deleted.items} level={1} total={deleted.summary?.total ?? deleted.items.length} state={{ ...state, allowExpansion: false, ownerLoading: false }} />
                  <PageFooter hasNextPage={Boolean(deleted.hasNextPage)} fetching={deleted.isFetchingNextPage} error={deleted.isFetchNextPageError} onMore={() => void (deleted.isFetchNextPageError ? deleted.refetch() : deleted.fetchNextPage())} />
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Stack>
      </Box>
      <ImportAgentDialog open={importOpen} projectId={projectId} engines={engines} conversations={conversations} initialConversationId={conversations[0]?.id} onClose={() => setImportOpen(false)} onImported={onOpenAgent} />
      {pendingDelete ? (
        <AgentDeletionDialog
          open
          projectId={projectId}
          rootAgentIds={[pendingDelete.id]}
          onClose={() => setPendingDelete(undefined)}
          onDeleted={agentIds => {
            setPendingDelete(undefined);
            onAgentsDeleted(agentIds);
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.organizationProject(projectId) });
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
        pending={rename.isPending}
        error={rename.isError ? String(rename.error) : undefined}
        validate={value => value.trim() ? undefined : "Enter an Agent name."}
        onCancel={() => setPendingRename(undefined)}
        onConfirm={title => pendingRename && rename.mutate({ id: pendingRename.id, title: title.trim() })}
      />
      <ResourceContextMenu
        state={menu}
        onClose={() => setMenu(undefined)}
        actions={menu ? [
          { id: "settings", label: "Agent Settings", icon: <SettingsOutlinedIcon fontSize="small" />, onSelect: onOpenAgentSettings },
          { id: "rename", label: "Rename", icon: <EditOutlinedIcon fontSize="small" />, onSelect: (id: string) => {
            if (selectedNode?.id === id) setPendingRename({ id, title: selectedNode.title });
          } },
          { id: "delegate", label: "Add Delegated Agent", icon: <PersonAddAlt1Icon fontSize="small" />, onSelect: onNewAgent },
          { id: "reporting", label: "Change Reporting Line", icon: <AccountTreeOutlinedIcon fontSize="small" />, onSelect: onOpenAgentSettings },
          { id: "delete", label: "Delete", icon: <DeleteOutlineIcon fontSize="small" />, color: "error" as const, onSelect: (id: string) => {
            if (selectedNode?.id === id) setPendingDelete({ id, title: selectedNode.title });
          } },
        ] : []}
      />
    </Box>
  );
}
