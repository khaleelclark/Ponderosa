import AddIcon from "@mui/icons-material/Add";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import FolderDeleteOutlinedIcon from "@mui/icons-material/FolderDeleteOutlined";
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
  AgentDto,
  AgentHealthDto,
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
import { createPortal } from "react-dom";
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
import { stopActiveAgentRuns } from "./AgentsTab";
import { DestructiveConfirmDialog, TextInputDialog } from "./ConfirmationDialogs";
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

type DeletedOrganizationNode = Extract<
  AgentOrganizationNodeDto,
  { relation: { kind: "deleted" } }
>;

interface TreeState {
  projectId: string;
  expanded: ReadonlySet<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  focusedId?: string;
  setFocusedId(id: string): void;
  treeRef: MutableRefObject<HTMLDivElement | null>;
  pendingChildFocusRef: MutableRefObject<string | undefined>;
  childControlsHost: HTMLDivElement | null;
  ownerLoading: boolean;
  connectionStatus: "connecting" | "live" | "reconnecting" | "stale" | "unavailable";
  phaseEvidenceFresh: boolean;
  allowExpansion: boolean;
  selectionMode: boolean;
  selectedAgentIds: ReadonlySet<string>;
  toggleSelection(agentId: string): void;
  onOpenAgent(agentId: string): void;
  onActions(node: AgentOrganizationNodeDto, anchor: HTMLElement): void;
  onCleanupRetained(node: DeletedOrganizationNode): void;
  registerNode(agentId: string, parentId: string | undefined, live: boolean): () => void;
}

function focusTreeRow(tree: HTMLDivElement | null, selector: string): void {
  globalThis.setTimeout(() => {
    tree?.querySelector<HTMLElement>(selector)?.focus();
  }, 0);
}

function ownsTreeItemEvent(currentTarget: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[role='treeitem']") === currentTarget;
}

function ownsPresentationEvent(currentTarget: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Element &&
    target.closest("[role='treeitem']") === currentTarget.closest("[role='treeitem']");
}

function findTreeRow(tree: HTMLDivElement | null, agentId: string | undefined): HTMLElement | undefined {
  if (!agentId) return undefined;
  return tree?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(agentId)}"]`) ?? undefined;
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
  setSize?: number;
  parentId?: string;
  state: TreeState;
}): JSX.Element {
  const live = isLiveOrganizationNode(node);
  const expanded = live && state.expanded.has(node.id);
  const expandable = live && state.allowExpansion && node.directReportCount > 0;
  useEffect(
    () => state.registerNode(node.id, parentId, live),
    [live, node.id, parentId, state.registerNode],
  );
  const presentation = live
    ? agentStatusPresentation(node.health, {
        status: node.health?.status,
        connectionStatus: state.connectionStatus,
        phaseEvidenceFresh: state.phaseEvidenceFresh && !state.ownerLoading,
      })
    : undefined;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ownsTreeItemEvent(event.currentTarget, event.target)) return;
    event.stopPropagation();
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
        state.pendingChildFocusRef.current = node.id;
        state.setExpanded(current => new Set(current).add(node.id));
      } else {
        focusTreeRow(state.treeRef.current, `[data-parent-id="${CSS.escape(node.id)}"]`);
      }
    } else if (event.key === "ArrowLeft" && live) {
      event.preventDefault();
      if (expanded) {
        if (state.pendingChildFocusRef.current === node.id) state.pendingChildFocusRef.current = undefined;
        state.setExpanded(current => {
          const next = new Set(current);
          next.delete(node.id);
          return next;
        });
      } else if (parentId) {
        focusTreeRow(state.treeRef.current, `[data-agent-id="${CSS.escape(parentId)}"]`);
      }
    } else if (event.key === " " && live && state.selectionMode) {
      event.preventDefault();
      state.toggleSelection(node.id);
    } else if (event.key === "Enter" && live) {
      event.preventDefault();
      state.onOpenAgent(node.id);
    } else if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && live) {
      event.preventDefault();
      state.onActions(node, event.currentTarget);
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
      aria-selected={live && state.selectionMode ? state.selectedAgentIds.has(node.id) : undefined}
      aria-keyshortcuts={live ? "Shift+F10" : undefined}
      tabIndex={state.focusedId === node.id ? 0 : -1}
      onFocus={event => {
        if (!ownsTreeItemEvent(event.currentTarget, event.target)) return;
        state.setFocusedId(node.id);
      }}
      onKeyDown={handleKeyDown}
      onClick={live ? event => {
        if (!ownsTreeItemEvent(event.currentTarget, event.target)) return;
        event.stopPropagation();
        if (state.selectionMode) state.toggleSelection(node.id);
        else state.onOpenAgent(node.id);
      } : undefined}
      onContextMenu={live ? event => {
        if (!ownsTreeItemEvent(event.currentTarget, event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        state.onActions(node, event.currentTarget);
      } : undefined}
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
        {live && state.selectionMode ? (
          <Box
            role="presentation"
            aria-hidden="true"
            sx={{ width: 44, height: 44, flex: "0 0 auto", display: "grid", placeItems: "center" }}
          >
            {state.selectedAgentIds.has(node.id) ? <CheckBoxIcon color="primary" /> : <CheckBoxOutlineBlankIcon />}
          </Box>
        ) : null}
        {live && state.allowExpansion ? (
          <Box
            component="span"
            role="presentation"
            aria-hidden="true"
            title={expandable ? `${expanded ? "Collapse" : "Expand"} ${node.title}` : undefined}
            onClick={expandable ? event => {
              if (!ownsPresentationEvent(event.currentTarget, event.target)) return;
              event.stopPropagation();
              state.setExpanded(current => {
                const next = new Set(current);
                if (next.has(node.id)) {
                  next.delete(node.id);
                  if (state.pendingChildFocusRef.current === node.id) state.pendingChildFocusRef.current = undefined;
                } else {
                  next.add(node.id);
                }
                return next;
              });
            } : undefined}
            sx={{
              width: 44,
              height: 44,
              flex: "0 0 auto",
              display: "grid",
              placeItems: "center",
              cursor: expandable ? "pointer" : "default",
            }}
          >
            {expandable
              ? expanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />
              : <Box sx={{ width: 24 }} />}
          </Box>
        ) : (
          <Box sx={{ width: 12, flex: "0 0 auto" }} />
        )}
        <SmartToyOutlinedIcon color={live ? "inherit" : "disabled"} />
        <Box
          role="presentation"
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
        {!live && node.retainedWorkingCopy ? (
          <Button
            color="error"
            variant="outlined"
            size="small"
            startIcon={<FolderDeleteOutlinedIcon />}
            onClick={event => {
              event.stopPropagation();
              state.onCleanupRetained(node);
            }}
            sx={{ minHeight: 40, flex: "0 0 auto" }}
          >
            Clean Up Git Copy
          </Button>
        ) : null}
        {live ? (
          <Box
            component="span"
            role="presentation"
            aria-hidden="true"
            title={`Actions for ${node.title}`}
            onClick={event => {
              if (!ownsPresentationEvent(event.currentTarget, event.target)) return;
              event.stopPropagation();
              state.onActions(node, event.currentTarget);
            }}
            sx={{ width: 44, height: 44, display: "grid", placeItems: "center", cursor: "pointer" }}
          >
            <MoreVertIcon />
          </Box>
        ) : null}
      </Stack>
      {expanded ? (
        <OrganizationChildren parentId={node.id} parentTitle={node.title} level={level + 1} state={state} />
      ) : null}
    </Box>
  );
}

function OrganizationRows({
  id,
  items,
  level,
  total,
  startIndex = 0,
  parentId,
  state,
}: {
  id?: string;
  items: AgentOrganizationNodeDto[];
  level: number;
  total?: number;
  startIndex?: number;
  parentId?: string;
  state: TreeState;
}): JSX.Element {
  return (
    <Stack id={id} role={parentId ? "group" : "presentation"} spacing={0.75} sx={{ mt: parentId ? 0.75 : 0 }}>
      {items.map((node, index) => (
        <OrganizationRow
          key={node.id}
          node={node}
          index={startIndex + index}
          level={level}
          setSize={total}
          parentId={parentId}
          state={state}
        />
      ))}
    </Stack>
  );
}

interface PageMoreResult {
  hasNextPage: boolean;
  failed: boolean;
}

function PageFooter({
  label,
  controlsId,
  focusScopeKey,
  itemIds,
  fallbackAgentId,
  treeRef,
  hasNextPage,
  fetching,
  error,
  initialError = false,
  onMore,
}: {
  label: string;
  controlsId: string;
  focusScopeKey: string;
  itemIds: readonly string[];
  fallbackAgentId?: string;
  treeRef: MutableRefObject<HTMLDivElement | null>;
  hasNextPage: boolean;
  fetching: boolean;
  error: boolean;
  initialError?: boolean;
  onMore(): Promise<PageMoreResult>;
}): JSX.Element | null {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  const scopeKeyRef = useRef(focusScopeKey);
  const itemIdsRef = useRef(itemIds);
  const fallbackAgentIdRef = useRef(fallbackAgentId);
  const activationRef = useRef(0);
  const focusTimerRef = useRef<ReturnType<typeof globalThis.setTimeout>>();
  scopeKeyRef.current = focusScopeKey;
  itemIdsRef.current = itemIds;
  fallbackAgentIdRef.current = fallbackAgentId;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (focusTimerRef.current !== undefined) globalThis.clearTimeout(focusTimerRef.current);
    };
  }, []);

  const handleMore = async () => {
    const activation = activationRef.current + 1;
    activationRef.current = activation;
    const activationScopeKey = focusScopeKey;
    const previousIds = new Set(itemIds);
    let result: PageMoreResult;
    try {
      result = await onMore();
    } catch {
      result = { hasNextPage: true, failed: true };
    }
    if (!mountedRef.current || activationRef.current !== activation || scopeKeyRef.current !== activationScopeKey) return;
    if (focusTimerRef.current !== undefined) globalThis.clearTimeout(focusTimerRef.current);
    const focusAfterCommit = (remainingAttempts: number) => {
      focusTimerRef.current = globalThis.setTimeout(() => {
        focusTimerRef.current = undefined;
        if (!mountedRef.current || activationRef.current !== activation || scopeKeyRef.current !== activationScopeKey) return;
        if (result.failed || result.hasNextPage) {
          const button = buttonRef.current;
          if ((!button?.isConnected || button.disabled) && remainingAttempts > 0) {
            focusAfterCommit(remainingAttempts - 1);
            return;
          }
          button?.focus();
          return;
        }
        const currentItemIds = itemIdsRef.current;
        const firstNewId = currentItemIds.find(agentId => !previousIds.has(agentId));
        if (!firstNewId && remainingAttempts > 0) {
          focusAfterCommit(remainingAttempts - 1);
          return;
        }
        const target = findTreeRow(treeRef.current, firstNewId) ??
          findTreeRow(treeRef.current, fallbackAgentIdRef.current) ??
          findTreeRow(treeRef.current, currentItemIds.at(-1)) ??
          treeRef.current?.querySelector<HTMLElement>("[role='treeitem'][tabindex='0'], [role='treeitem']") ??
          undefined;
        if (target?.isConnected && treeRef.current?.contains(target)) target.focus();
      }, 0);
    };
    focusAfterCommit(3);
  };
  if (!hasNextPage && !error && !initialError) return null;
  return (
    <Stack role="group" aria-label={`${label} paging`} direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Button
        ref={buttonRef}
        color={error || initialError ? "error" : "inherit"}
        disabled={fetching}
        onKeyDown={event => event.stopPropagation()}
        onKeyUp={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onPointerUp={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          void handleMore();
        }}
        aria-controls={controlsId}
        aria-label={`${error || initialError ? "Retry" : "Load more"} ${label}`}
        sx={{ minHeight: 44 }}
      >
        {fetching ? "Loading…" : error || initialError ? "Retry this page" : "Load more"}
      </Button>
    </Stack>
  );
}

function OrganizationChildren({
  parentId,
  parentTitle,
  level,
  state,
}: {
  parentId: string;
  parentTitle: string;
  level: number;
  state: TreeState;
}): JSX.Element {
  const query = useAgentOrganization(state.projectId, {
    scope: "children",
    parentAgentId: parentId,
  });
  useEffect(() => {
    if (state.pendingChildFocusRef.current !== parentId || query.items.length === 0) return;
    state.pendingChildFocusRef.current = undefined;
    focusTreeRow(
      state.treeRef.current,
      `[data-parent-id="${CSS.escape(parentId)}"]`,
    );
  }, [parentId, query.items.length, state.pendingChildFocusRef, state.treeRef]);
  useEffect(() => () => {
    if (state.pendingChildFocusRef.current === parentId) state.pendingChildFocusRef.current = undefined;
  }, [parentId, state.pendingChildFocusRef]);
  const groupId = `agent-organization-children-${parentId}`;
  const pageControls = (
    <PageFooter
      label={`Direct reports for ${parentTitle}`}
      controlsId={groupId}
      focusScopeKey={`${state.projectId}:children:${parentId}`}
      itemIds={query.items.map(item => item.id)}
      fallbackAgentId={parentId}
      treeRef={state.treeRef}
      hasNextPage={Boolean(query.hasNextPage)}
      fetching={query.isFetchingNextPage}
      error={query.isFetchNextPageError}
      initialError={query.isError && !query.pages}
      onMore={async () => {
        if (query.isError) {
          const result = await query.refetch();
          return {
            hasNextPage: Boolean(result.data?.pages.at(-1)?.nextCursor),
            failed: result.isError,
          };
        }
        const result = await query.fetchNextPage();
        return {
          hasNextPage: Boolean(result.hasNextPage),
          failed: result.isFetchNextPageError,
        };
      }}
    />
  );
  return (
    <Box role="presentation" aria-busy={query.isFetching}>
      <OrganizationRows
        id={groupId}
        items={query.items}
        level={level}
        total={query.summary?.total ?? query.items.length}
        parentId={parentId}
        state={{ ...state, ownerLoading: query.isFetching }}
      />
      {state.childControlsHost ? createPortal(pageControls, state.childControlsHost) : null}
    </Box>
  );
}

export function AgentOrganizationTree({
  projectId,
  scopeLabel,
  engines,
  conversations,
  projectAgents,
  projectHealth,
  onOpenAgent,
  onOpenAgentSettings,
  onAgentsDeleted,
  onNewAgent,
}: {
  projectId: string;
  scopeLabel: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  projectAgents: AgentDto[];
  projectHealth: AgentHealthDto[];
  onOpenAgent(agentId: string): void;
  onOpenAgentSettings(agentId: string): void;
  onAgentsDeleted(agentIds: string[]): void;
  onNewAgent(managerAgentId?: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const connection = useWorkspaceConnection();
  const treeRef = useRef<HTMLDivElement | null>(null);
  const pendingChildFocusRef = useRef<string>();
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
  const [pendingCopyCleanup, setPendingCopyCleanup] = useState<DeletedOrganizationNode>();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkError, setBulkError] = useState<string>();
  const [stoppingAll, setStoppingAll] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(0);
  const [childControlsHost, setChildControlsHost] = useState<HTMLDivElement | null>(null);
  const mountedNodeIds = useRef(new Set<string>());
  const mountedLiveNodeIds = useRef(new Set<string>());
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
  const registerNode = useMemo(() => (agentId: string, parentId: string | undefined, live: boolean) => {
    const added = !mountedNodeIds.current.has(agentId);
    mountedNodeIds.current.add(agentId);
    if (live) mountedLiveNodeIds.current.add(agentId);
    if (added) setVisibleCount(count => count + 1);
    return () => {
      const removed = mountedNodeIds.current.delete(agentId);
      mountedLiveNodeIds.current.delete(agentId);
      if (removed) setVisibleCount(count => Math.max(0, count - 1));
      setExpanded(current => pruneExpandedAgentIds(current, [agentId]));
      setSelectedAgentIds(current => {
        if (!current.has(agentId)) return current;
        const next = new Set(current);
        next.delete(agentId);
        return next;
      });
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
    if (!first) return;
    setFocusedId(current => current && mountedNodeIds.current.has(current) ? current : first);
  }, [deleted.items, focusedId, orphans.items, roots.items]);
  const state: TreeState = {
    projectId,
    expanded,
    setExpanded,
    focusedId,
    setFocusedId,
    treeRef,
    pendingChildFocusRef,
    childControlsHost,
    ownerLoading: roots.isFetching,
    connectionStatus: connection.status,
    phaseEvidenceFresh: connection.phaseEvidenceFresh,
    allowExpansion: !filtered,
    selectionMode,
    selectedAgentIds,
    toggleSelection: agentId => setSelectedAgentIds(current => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    }),
    onOpenAgent,
    onActions: (node, anchor) => {
      setSelectedNode(node);
      setMenu({ resource: node.id, anchor });
    },
    onCleanupRetained: setPendingCopyCleanup,
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
  const cleanupRetainedCopy = useMutation({
    mutationFn: ({ id }: { id: string }) => api.cleanupDeletedAgentWorkingCopy(projectId, id),
    onSuccess: () => {
      setPendingCopyCleanup(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.organizationProject(projectId) });
    },
  });
  const summary = roots.summary;
  const rootTotal = summary?.total ?? roots.items.length;
  const orphanTotal = orphans.summary?.total ?? summary?.specialGroupCounts.orphaned ?? orphans.items.length;
  const deletedTotal = deleted.summary?.total ?? summary?.specialGroupCounts.deleted ?? deleted.items.length;
  const topLevelSetSize = filtered
    ? status ? undefined : rootTotal
    : rootTotal + (orphansExpanded ? orphanTotal : 0) + (deletedExpanded ? deletedTotal : 0);
  const visibleLiveAgentIds = [...mountedLiveNodeIds.current];
  const allVisibleSelected = visibleLiveAgentIds.length > 0 &&
    visibleLiveAgentIds.every(id => selectedAgentIds.has(id));
  const activeRunTargets = useMemo(() => {
    const healthByAgentId = new Map(projectHealth.map(health => [health.agentId, health]));
    return projectAgents.flatMap(agent => {
      const runId = healthByAgentId.get(agent.id)?.runtimeActivity?.executionId;
      return runId ? [{ agentId: agent.id, runId }] : [];
    });
  }, [projectAgents, projectHealth]);
  const leaveSelectionMode = () => {
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
    setBulkDeleteOpen(false);
  };
  const toggleVisibleSelection = () => {
    setSelectedAgentIds(current => {
      const next = new Set(current);
      const select = visibleLiveAgentIds.some(id => !current.has(id));
      visibleLiveAgentIds.forEach(id => select ? next.add(id) : next.delete(id));
      return next;
    });
  };
  const stopAll = async () => {
    setStoppingAll(true);
    setBulkError(undefined);
    try {
      const { stopped, failed } = await stopActiveAgentRuns(activeRunTargets);
      if (failed) {
        setBulkError(`${stopped} agents stopped; ${failed} could not be stopped. Retry or open those agents for details.`);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.health(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.organizationProject(projectId) }),
      ]);
    } finally {
      setStoppingAll(false);
    }
  };
  const focusAfterDeletion = (deletedAgentIds: readonly string[]) => {
    const deletedIds = new Set(deletedAgentIds);
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>("[role='treeitem']") ?? [])];
    const firstDeletedIndex = rows.findIndex(row => {
      const id = row.dataset.agentId;
      return id ? deletedIds.has(id) : false;
    });
    const following = firstDeletedIndex >= 0
      ? rows.slice(firstDeletedIndex + 1).find(row => {
          const id = row.dataset.agentId;
          return id ? !deletedIds.has(id) : false;
        })
      : undefined;
    const preceding = firstDeletedIndex > 0
      ? rows.slice(0, firstDeletedIndex).reverse().find(row => {
          const id = row.dataset.agentId;
          return id ? !deletedIds.has(id) : false;
        })
      : undefined;
    const targetId = following?.dataset.agentId ?? preceding?.dataset.agentId;
    setFocusedId(targetId);
    globalThis.setTimeout(() => {
      focusTreeRow(
        treeRef.current,
        targetId
          ? `[data-agent-id="${CSS.escape(targetId)}"]`
          : "[role='treeitem']",
      );
    }, 100);
  };
  return (
    <Box sx={{ height: "100%", minHeight: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)" }}>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <AccountTreeOutlinedIcon />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h1" variant="h6">Agent organization</Typography>
          <Typography variant="caption" color="text.secondary">{scopeLabel} · ownership from canonical reporting lines</Typography>
        </Box>
        <PrimaryHeaderActionsOutlet />
        {selectionMode ? (
          <>
            <Button color="inherit" onClick={toggleVisibleSelection} sx={{ minHeight: 44 }}>
              {allVisibleSelected ? "Clear Visible" : "Select All Visible"}
            </Button>
            <Button
              color="error"
              variant="outlined"
              disabled={selectedAgentIds.size === 0}
              onClick={() => setBulkDeleteOpen(true)}
              sx={{ minHeight: 44 }}
            >
              Delete Selected ({selectedAgentIds.size})
            </Button>
            <Button color="inherit" onClick={leaveSelectionMode} sx={{ minHeight: 44 }}>
              Cancel Selection
            </Button>
          </>
        ) : (
          <>
            {visibleLiveAgentIds.length > 0 ? (
              <Button variant="outlined" color="inherit" onClick={() => setSelectionMode(true)} sx={{ minHeight: 44 }}>
                Select Agents
              </Button>
            ) : null}
            {activeRunTargets.length > 0 ? (
              <Button
                color="error"
                variant="outlined"
                disabled={stoppingAll}
                onClick={() => void stopAll()}
                sx={{ minHeight: 44 }}
              >
                {stoppingAll ? "Stopping…" : "Stop All"}
              </Button>
            ) : null}
            <Button variant="outlined" startIcon={<FileUploadOutlinedIcon />} onClick={() => setImportOpen(true)} sx={{ minHeight: 44, display: { xs: "none", sm: "inline-flex" } }}>
              Import
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => onNewAgent()} sx={{ minHeight: 44 }}>
              New Agent
            </Button>
          </>
        )}
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
          {roots.isFetching ? "Refreshing Agent organization" : `${visibleCount} Agent rows visible`}
        </Box>
        {bulkError ? <Alert severity="warning" sx={{ mb: 1 }}>{bulkError}</Alert> : null}
        {roots.isLoading ? <LinearProgress aria-label="Loading Agent organization" /> : null}
        {roots.isError && !roots.pages ? (
          <Alert severity="error" action={<Button onClick={() => void roots.refetch()}>Retry</Button>}>
            The Agent organization could not be loaded.
          </Alert>
        ) : null}
        <Stack role="group" aria-label="Agent organization sections" spacing={0.75} sx={{ mb: 1 }}>
          <Typography variant="subtitle2">
            {filtered ? "Filtered Agents" : `Reports to you (${summary?.specialGroupCounts.independent ?? 0})`}
          </Typography>
          {filtered ? (
            <Typography variant="caption" color="text.secondary">
              Flat, server-paged results with canonical owner breadcrumbs. Status applies to each bounded candidate page.
            </Typography>
          ) : null}
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {!filtered && (summary?.specialGroupCounts.orphaned ?? 0) > 0 ? (
              <Button
                color="inherit"
                startIcon={orphansExpanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                onClick={() => setOrphansExpanded(value => !value)}
                aria-expanded={orphansExpanded}
                aria-controls="agent-organization-orphaned"
                aria-label={`${orphansExpanded ? "Collapse" : "Expand"} Orphaned Agents`}
                sx={{ minHeight: 44 }}
              >
                Orphaned ({summary?.specialGroupCounts.orphaned ?? 0})
              </Button>
            ) : null}
            {!filtered && (summary?.specialGroupCounts.deleted ?? 0) > 0 ? (
              <Button
                color="inherit"
                startIcon={deletedExpanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                onClick={() => setDeletedExpanded(value => !value)}
                aria-expanded={deletedExpanded}
                aria-controls="agent-organization-deleted"
                aria-label={`${deletedExpanded ? "Collapse" : "Expand"} Deleted History`}
                sx={{ minHeight: 44 }}
              >
                Deleted History ({summary?.specialGroupCounts.deleted ?? 0})
              </Button>
            ) : null}
          </Stack>
          {!filtered && deletedExpanded && (summary?.specialGroupCounts.deleted ?? 0) > 0 ? (
            <Typography variant="caption" color="text.secondary">
              Deleted History contains minimal tombstones only. Deleted Agents cannot expand or reconstruct ancestry.
            </Typography>
          ) : null}
        </Stack>
        <Stack ref={treeRef} role="tree" aria-label="Agent organization" spacing={1.5} aria-busy={roots.isFetching || undefined}>
          <Box
            id="agent-organization-roots"
            role="group"
            aria-label={filtered ? "Filtered Agents" : "Reports to you"}
            aria-busy={roots.isFetching || undefined}
          >
            <OrganizationRows items={roots.items} level={1} total={topLevelSetSize} state={state} />
          </Box>
          {!filtered && orphansExpanded && (summary?.specialGroupCounts.orphaned ?? 0) > 0 ? (
            <Box
              id="agent-organization-orphaned"
              role="group"
              aria-label="Orphaned Agents"
              aria-busy={orphans.isFetching || undefined}
            >
              <OrganizationRows items={orphans.items} level={1} total={topLevelSetSize} startIndex={rootTotal} state={{ ...state, ownerLoading: orphans.isFetching }} />
            </Box>
          ) : null}
          {!filtered && deletedExpanded && (summary?.specialGroupCounts.deleted ?? 0) > 0 ? (
            <Box
              id="agent-organization-deleted"
              role="group"
              aria-label="Deleted History"
              aria-description="Minimal tombstones only. Deleted Agents cannot expand or reconstruct ancestry."
              aria-busy={deleted.isFetching || undefined}
            >
              <OrganizationRows
                items={deleted.items}
                level={1}
                total={topLevelSetSize}
                startIndex={rootTotal + (orphansExpanded ? orphanTotal : 0)}
                state={{ ...state, allowExpansion: false, ownerLoading: false }}
              />
            </Box>
          ) : null}
        </Stack>
        <Stack role="group" aria-label="Agent organization paging" spacing={0.75} sx={{ mt: 1 }}>
          <PageFooter
            label={filtered ? "Filtered Agents" : "Reports to you"}
            controlsId="agent-organization-roots"
            focusScopeKey={`${projectId}:roots:${search}:${status}`}
            itemIds={roots.items.map(item => item.id)}
            treeRef={treeRef}
            hasNextPage={Boolean(roots.hasNextPage)}
            fetching={roots.isFetchingNextPage}
            error={roots.isFetchNextPageError}
            onMore={async () => {
              if (roots.isFetchNextPageError) {
                const result = await roots.refetch();
                return {
                  hasNextPage: Boolean(result.data?.pages.at(-1)?.nextCursor),
                  failed: result.isError,
                };
              }
              const result = await roots.fetchNextPage();
              return {
                hasNextPage: Boolean(result.hasNextPage),
                failed: result.isFetchNextPageError,
              };
            }}
          />
          {!filtered && orphansExpanded ? (
            <PageFooter
              label="Orphaned Agents"
              controlsId="agent-organization-orphaned"
              focusScopeKey={`${projectId}:orphaned`}
              itemIds={orphans.items.map(item => item.id)}
              treeRef={treeRef}
              hasNextPage={Boolean(orphans.hasNextPage)}
              fetching={orphans.isFetchingNextPage}
              error={orphans.isFetchNextPageError}
              onMore={async () => {
                if (orphans.isFetchNextPageError) {
                  const result = await orphans.refetch();
                  return {
                    hasNextPage: Boolean(result.data?.pages.at(-1)?.nextCursor),
                    failed: result.isError,
                  };
                }
                const result = await orphans.fetchNextPage();
                return {
                  hasNextPage: Boolean(result.hasNextPage),
                  failed: result.isFetchNextPageError,
                };
              }}
            />
          ) : null}
          {!filtered && deletedExpanded ? (
            <PageFooter
              label="Deleted History"
              controlsId="agent-organization-deleted"
              focusScopeKey={`${projectId}:deleted`}
              itemIds={deleted.items.map(item => item.id)}
              treeRef={treeRef}
              hasNextPage={Boolean(deleted.hasNextPage)}
              fetching={deleted.isFetchingNextPage}
              error={deleted.isFetchNextPageError}
              onMore={async () => {
                if (deleted.isFetchNextPageError) {
                  const result = await deleted.refetch();
                  return {
                    hasNextPage: Boolean(result.data?.pages.at(-1)?.nextCursor),
                    failed: result.isError,
                  };
                }
                const result = await deleted.fetchNextPage();
                return {
                  hasNextPage: Boolean(result.hasNextPage),
                  failed: result.isFetchNextPageError,
                };
              }}
            />
          ) : null}
          <Stack ref={setChildControlsHost} spacing={0.75} />
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
            focusAfterDeletion(agentIds);
            setPendingDelete(undefined);
            onAgentsDeleted(agentIds);
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.organizationProject(projectId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.health(projectId) });
          }}
        />
      ) : null}
      {bulkDeleteOpen ? (
        <AgentDeletionDialog
          open
          projectId={projectId}
          rootAgentIds={[...selectedAgentIds]}
          title="Delete selected agents?"
          confirmationText="DELETE SELECTED"
          onClose={() => setBulkDeleteOpen(false)}
          onDeleted={agentIds => {
            focusAfterDeletion(agentIds);
            leaveSelectionMode();
            onAgentsDeleted(agentIds);
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.organizationProject(projectId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.agents.health(projectId) });
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
      {pendingCopyCleanup?.retainedWorkingCopy ? (
        <DestructiveConfirmDialog
          open
          title={`Clean up ${pendingCopyCleanup.title}'s retained Git copy?`}
          confirmLabel="Delete Git Copy"
          pendingLabel="Deleting…"
          pending={cleanupRetainedCopy.isPending}
          error={cleanupRetainedCopy.isError ? String(cleanupRetainedCopy.error) : undefined}
          onCancel={() => setPendingCopyCleanup(undefined)}
          onConfirm={() => cleanupRetainedCopy.mutate({ id: pendingCopyCleanup.id })}
        >
          This permanently removes the retained folder and its Agent-owned branch
          {pendingCopyCleanup.retainedWorkingCopy.branch
            ? ` (${pendingCopyCleanup.retainedWorkingCopy.branch})`
            : ""}. Any unmerged work in that copy will be lost.
        </DestructiveConfirmDialog>
      ) : null}
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
