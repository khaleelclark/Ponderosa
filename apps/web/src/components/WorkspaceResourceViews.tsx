import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Alert, Box, Button, Chip, FormControl, IconButton, InputLabel, LinearProgress,
  MenuItem, Select, Stack, Tooltip, Typography,
} from "@mui/material";
import type { ConversationDto, EngineDto, ProjectDto, TriggerDefinitionDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  useProjectAgentHealth,
  useProjectAgents,
  useProjectConversations,
} from "../hooks/useProjectCollections";
import { queryKeys } from "../queryKeys";
import {
  reorderStableIds, resourcePreferenceKey, sortWorkspaceResources, starredWorkspaceResources,
  toggleWorkspaceResourceStar, workspaceResourceSort, workspaceResourceSortPatch,
} from "../resourcePreferences";
import type { Route } from "../routing";
import { TokenUsageDetails } from "./TokenUsageButton";
import { AgentsTab } from "./AgentsTab";
import { mergeAgentStatuses } from "../agents";
import {
  CollectionDirectoryControls,
  CollectionEmptyState,
  CollectionHeader,
  CollectionTimestamp,
  CollectionToolbar,
  CollectionWorkspace,
  ResourceRow,
} from "./CollectionPrimitives";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";
import { markWorkspaceResourceUsed } from "../workspaceRecency";
import { ResourceDeletionDialog, TextInputDialog } from "./ConfirmationDialogs";

type ChatDirectoryResource = {
  route: Route;
  conversation: ConversationDto;
};

export function AllChatsWorkspace({ projects, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate, onConversationAction }: {
  projects: ProjectDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void; onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
  onConversationAction(kind: "rename" | "delete", conversation: ConversationDto): void;
}): JSX.Element {
  const queries = useProjectConversations(projects);
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(filterProjectId ?? ""); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<ResourceContextMenuState<ChatDirectoryResource>>();
  useEffect(() => setProjectId(filterProjectId ?? ""), [filterProjectId]);
  const sort = workspaceResourceSort(preferences, "chat"); const starred = starredWorkspaceResources(preferences);
  const rows = projects.flatMap((project, index) => (queries[index]?.data ?? []).filter((conversation) => !conversation.archived).map((conversation) => ({ project, conversation })));
  const scopedProject = filterProjectId
    ? projects.find(project => project.id === filterProjectId)
    : undefined;
  const scopedRows = filterProjectId
    ? rows.filter(({ project }) => project.id === filterProjectId)
    : rows;
  const filtered = scopedRows.filter(({ project, conversation }) => (!projectId || project.id === projectId) && (!search.trim() || `${conversation.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sortWorkspaceResources(filtered, sort, preferences.chatOrder, (row) => row.conversation.id, (row) => row.conversation.title, (row) => row.conversation.updatedAt);
  const filtersActive = Boolean(search.trim() || (!filterProjectId && projectId));
  return <CollectionWorkspace
    icon={<ChatBubbleOutlineIcon />}
    title="All Chats"
    detail={
      scopedProject
        ? filtersActive
          ? `${ordered.length} of ${scopedRows.length} Chats in ${scopedProject.label}`
          : `${scopedRows.length} ${scopedRows.length === 1 ? "Chat" : "Chats"} in ${scopedProject.label}`
        : filtersActive
          ? `${ordered.length} of ${rows.length} Project Chats`
          : `${rows.length} Project ${rows.length === 1 ? "Chat" : "Chats"} across Ponderosa`
    }
    primaryAction={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Chat</Button>}
    toolbar={<CollectionToolbar search={search} onSearch={setSearch} searchLabel="Search Chats">
      <CollectionDirectoryControls
        projects={filterProjectId ? undefined : projects}
        projectId={filterProjectId ? undefined : projectId}
        onProject={filterProjectId ? undefined : setProjectId}
        sort={sort}
        onSort={value => onPreferences(workspaceResourceSortPatch("chat", value))}
      />
    </CollectionToolbar>}
    listLabel="All Chats"
  >
    {ordered.map(({ project, conversation }) => {
      const route: Route = { kind: "conversation", projectId: project.id, conversationId: conversation.id };
      const menuResource = { route, conversation };
      const key = resourcePreferenceKey("conversation", conversation.id);
      return <ResourceRow
        key={conversation.id}
        label={conversation.title}
        description={filterProjectId ? undefined : project.label}
        icon={<ChatBubbleOutlineIcon />}
        meta={<CollectionTimestamp value={conversation.updatedAt} />}
        starAction={<Tooltip title={starred.has(key) ? "Unstar Chat" : "Star Chat"}><IconButton aria-label={starred.has(key) ? `Unstar ${conversation.title}` : `Star ${conversation.title}`} onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "conversation", conversation.id))}>{starred.has(key) ? <StarRoundedIcon sx={{ color: "var(--ponderosa-star)" }} /> : <StarBorderRoundedIcon />}</IconButton></Tooltip>}
        overflowAction={<Tooltip title={`Actions for ${conversation.title}`}><IconButton aria-label={`Actions for ${conversation.title}`} onClick={(event) => setMenu({ anchor: event.currentTarget, resource: menuResource })}><MoreVertIcon /></IconButton></Tooltip>}
        onOpen={() => onNavigate(route)}
        onContextMenu={(anchor) => setMenu({ anchor, resource: menuResource })}
        draggable
        onDragStart={() => setDragged(conversation.id)}
        onDragEnd={() => setDragged(undefined)}
        onDrop={() => {
          if (dragged) onPreferences({ chatSort: "custom", chatOrder: reorderStableIds(preferences.chatOrder, scopedRows.map((row) => row.conversation.id), dragged, conversation.id) });
          setDragged(undefined);
        }}
      />;
    })}
    {!queries.some((query) => query.isLoading) && ordered.length === 0 ? <CollectionEmptyState
      title={scopedRows.length === 0 && !filtersActive ? "No Chats Yet" : "No Chats match these filters"}
      detail={scopedRows.length === 0 && !filtersActive ? "Create a Chat to get started." : `Try a different search${filterProjectId ? "." : " or Project filter."}`}
      action={filtersActive ? {
        label: "Clear Filters",
        onClick: () => {
          setSearch("");
          if (!filterProjectId) setProjectId("");
        },
      } : undefined}
    /> : null}
    <ResourceContextMenu
      state={menu}
      onClose={() => setMenu(undefined)}
      onOpenInNewTab={({ route }) => onOpenInNewTab(route)}
      actions={[
        {
          id: "rename",
          label: "Rename",
          icon: <EditOutlinedIcon fontSize="small" />,
          onSelect: ({ conversation }) => onConversationAction("rename", conversation),
        },
        {
          id: "delete",
          label: "Delete",
          icon: <DeleteOutlineIcon fontSize="small" />,
          color: "error",
          onSelect: ({ conversation }) => onConversationAction("delete", conversation),
        },
      ]}
    />
  </CollectionWorkspace>;
}

export function AllAgentsWorkspace({ projects, engines, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; engines: EngineDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigate(route: Route): void; onOpenInNewTab(route: Route): void;
  onCreate(projectId?: string, managerAgentId?: string): void;
}): JSX.Element {
  const agentQueries = useProjectAgents(projects);
  const conversationQueries = useProjectConversations(projects);
  const healthQueries = useProjectAgentHealth(projects);
  const [projectId, setProjectId] = useState(filterProjectId ?? "");
  useEffect(() => setProjectId(filterProjectId ?? ""), [filterProjectId]);
  const sort = workspaceResourceSort(preferences, "agent");
  const rows = projects.flatMap((project, index) => (agentQueries[index]?.data ?? []).filter((agent) => !agent.archived).map((agent) => ({ project, agent })));
  const scopedRows = rows.filter(({ project }) => !projectId || project.id === projectId);
  const orderedRows = sortWorkspaceResources(scopedRows, sort, preferences.agentOrder, (row) => row.agent.id, (row) => row.agent.title, (row) => row.agent.updatedAt);
  const agents = orderedRows.map((row) => row.agent);
  const conversations = projects.flatMap((project, index) => (!projectId || project.id === projectId) ? (conversationQueries[index]?.data ?? []).filter((conversation) => !conversation.archived) : []);
  const allHealth = projects.flatMap((project, index) => (!projectId || project.id === projectId) ? (healthQueries[index]?.data?.agents ?? []) : []);
  const healthByAgentId = new Map(allHealth.map((item) => [item.agentId, item]));
  const statusByAgentId = mergeAgentStatuses(agents, allHealth, new Map());
  const projectByAgentId = new Map(rows.map(({ project, agent }) => [agent.id, { id: project.id, label: project.label }]));
  const starredIds = starredWorkspaceResources(preferences);
  const scopedProject = projectId
    ? projects.find(project => project.id === projectId)
    : undefined;
  return <Box sx={{ height: "100%", minHeight: 0, overflow: "hidden" }}>
    <AgentsTab collection={{
      title: "All Agents",
      detail: scopedProject
        ? `${scopedRows.length} ${scopedRows.length === 1 ? "Agent" : "Agents"} in ${scopedProject.label}`
        : `${rows.length} ${rows.length === 1 ? "Agent" : "Agents"} across Ponderosa`,
      totalCount: scopedRows.length,
    }} toolbarControls={<>
      <CollectionDirectoryControls
        projects={projects}
        projectId={projectId}
        onProject={setProjectId}
        sort={sort}
        onSort={value => onPreferences(workspaceResourceSortPatch("agent", value))}
      />
    </>} agents={agents} projectId={projectId || undefined} engines={engines} conversations={conversations} statusByAgentId={statusByAgentId} healthByAgentId={healthByAgentId} projectByAgentId={projectByAgentId} displayOrder={agents.map((agent) => agent.id)} selectionAllowed onReorder={(sourceId, targetId) => onPreferences({ agentSort: "custom", agentOrder: reorderStableIds(preferences.agentOrder, agents.map((agent) => agent.id), sourceId, targetId) })} starredAgentIds={starredIds} onToggleStar={(agentId) => onPreferences(toggleWorkspaceResourceStar(preferences, "agent", agentId))} onOpenAgent={(agentId) => { const project = projectByAgentId.get(agentId)!; onNavigate({ kind: "agent", projectId: project.id, agentId }); }} onOpenAgentInNewTab={(agentId) => { const project = projectByAgentId.get(agentId)!; onOpenInNewTab({ kind: "agent", projectId: project.id, agentId }); }} onOpenAgentSettings={(agentId) => { const project = projectByAgentId.get(agentId)!; onNavigate({ kind: "agent", projectId: project.id, agentId, view: "settings" }); }} onNewAgent={(managerAgentId) => onCreate(
      managerAgentId
        ? projectByAgentId.get(managerAgentId)?.id
        : projectId || undefined,
      managerAgentId,
    )} showImportAction={false} />
  </Box>;
}

type TriggerDirectoryResource = {
  route: Route;
  trigger: TriggerDefinitionDto;
};

export function AllTriggersWorkspace({
  projects,
  filterProjectId,
  filterAgentIds,
  scopeTitle,
  embedded = false,
  preferences,
  onPreferences,
  onNavigate,
  onOpenInNewTab,
  onCreate,
}: {
  projects: ProjectDto[]; preferences: WorkspacePreferencesDto; onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  filterProjectId?: string;
  filterAgentIds?: readonly string[];
  scopeTitle?: string;
  embedded?: boolean;
  onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const triggers = useQuery({ queryKey: queryKeys.triggers.all, queryFn: () => api.listAllTriggers(), staleTime: 5_000 });
  const agents = useProjectAgents(projects);
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(filterProjectId ?? ""); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<ResourceContextMenuState<TriggerDirectoryResource>>();
  useEffect(() => setProjectId(filterProjectId ?? ""), [filterProjectId]);
  const [triggerAction, setTriggerAction] = useState<{
    kind: "rename" | "delete";
    trigger: TriggerDefinitionDto;
  }>();
  const renameTrigger = useMutation({
    mutationFn: ({ trigger, name }: { trigger: TriggerDefinitionDto; name: string }) =>
      api.updateTrigger(trigger.id, { name }),
    onSuccess: (_updated, { trigger }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.agent(trigger.agentId) });
      setTriggerAction(undefined);
    },
  });
  const deleteTrigger = useMutation({
    mutationFn: (trigger: TriggerDefinitionDto) => api.deleteTrigger(trigger.id),
    onSuccess: (_deleted, trigger) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.agent(trigger.agentId) });
      setTriggerAction(undefined);
    },
  });
  const sort = workspaceResourceSort(preferences, "trigger"); const starred = starredWorkspaceResources(preferences);
  const destinations = useMemo(() => new Map(projects.flatMap((project, index) => (agents[index]?.data ?? []).map((agent) => [agent.id, { project, agent }] as const))), [projects, agents.map((query) => query.data)]);
  const scopedAgentIds = filterAgentIds ? new Set(filterAgentIds) : undefined;
  const rows = (triggers.data ?? []).flatMap((trigger) => {
    if (scopedAgentIds && !scopedAgentIds.has(trigger.agentId)) return [];
    const destination = destinations.get(trigger.agentId);
    return destination ? [{ trigger, ...destination }] : [];
  });
  const scopedRows = filterProjectId
    ? rows.filter(({ project }) => project.id === filterProjectId)
    : rows;
  const filtered = scopedRows.filter(({ project, agent, trigger }) => (!projectId || project.id === projectId) && (!search.trim() || `${trigger.name} ${trigger.sourceKind} ${agent.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sortWorkspaceResources(filtered, sort, preferences.triggerOrder, (row) => row.trigger.id, (row) => row.trigger.name, (row) => row.trigger.updatedAt);
  const filtersActive = Boolean(search.trim() || (!filterProjectId && projectId));
  const scopedProject = filterProjectId
    ? projects.find(project => project.id === filterProjectId)
    : undefined;
  const createButton = (
    <Button variant="contained" startIcon={<AddIcon />} onClick={onCreate}>
      New Trigger
    </Button>
  );
  return <CollectionWorkspace
    icon={<BoltOutlinedIcon />}
    title={scopeTitle ?? (scopedProject ? "Project Triggers" : "All Triggers")}
    detail={
      scopedProject
        ? filtersActive
          ? `${ordered.length} of ${scopedRows.length} Triggers in ${scopedProject.label}`
          : `${scopedRows.length} ${scopedRows.length === 1 ? "Trigger" : "Triggers"} in ${scopedProject.label}`
        : filtersActive
          ? `${ordered.length} of ${rows.length} Triggers`
          : `${rows.length} ${rows.length === 1 ? "Trigger" : "Triggers"} across Ponderosa`
    }
    primaryAction={createButton}
    toolbar={<CollectionToolbar search={search} onSearch={setSearch} searchLabel="Search Triggers">
      <CollectionDirectoryControls
        projects={filterProjectId ? undefined : projects}
        projectId={filterProjectId ? undefined : projectId}
        onProject={filterProjectId ? undefined : setProjectId}
        sort={sort}
        onSort={value => onPreferences(workspaceResourceSortPatch("trigger", value))}
      />
      {embedded ? createButton : null}
    </CollectionToolbar>}
    listLabel={scopeTitle ?? "All Triggers"}
    variant={embedded ? "embedded" : "page"}
  >
    {ordered.map(({ project, agent, trigger }) => {
      const route: Route = { kind: "agent", projectId: project.id, agentId: agent.id, view: "triggers" };
      const menuResource = { route, trigger };
      const key = resourcePreferenceKey("trigger", trigger.id);
      return <ResourceRow
        key={trigger.id}
        label={trigger.name}
        description={`${filterProjectId ? "" : `${project.label} · `}${agent.title} · ${trigger.sourceKind.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())}`}
        icon={<BoltOutlinedIcon />}
        meta={<Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Chip
            size="small"
            label={trigger.enabled ? "Enabled" : "Disabled"}
            color={trigger.enabled ? "success" : "default"}
            variant={trigger.enabled ? "filled" : "outlined"}
          />
          <CollectionTimestamp value={trigger.updatedAt} hideBelow="md" />
        </Stack>}
        starAction={<Tooltip title={starred.has(key) ? "Unstar Trigger" : "Star Trigger"}><IconButton aria-label={starred.has(key) ? `Unstar ${trigger.name}` : `Star ${trigger.name}`} onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "trigger", trigger.id))}>{starred.has(key) ? <StarRoundedIcon sx={{ color: "var(--ponderosa-star)" }} /> : <StarBorderRoundedIcon />}</IconButton></Tooltip>}
        overflowAction={<Tooltip title={`Actions for ${trigger.name}`}><IconButton aria-label={`Actions for ${trigger.name}`} onClick={(event) => setMenu({ anchor: event.currentTarget, resource: menuResource })}><MoreVertIcon /></IconButton></Tooltip>}
        onOpen={() => {
          markWorkspaceResourceUsed(queryClient, "trigger", trigger.id);
          onNavigate(route);
        }}
        onContextMenu={(anchor) => setMenu({ anchor, resource: menuResource })}
        draggable
        onDragStart={() => setDragged(trigger.id)}
        onDragEnd={() => setDragged(undefined)}
        onDrop={() => {
          if (dragged) onPreferences({ triggerSort: "custom", triggerOrder: reorderStableIds(preferences.triggerOrder, scopedRows.map((row) => row.trigger.id), dragged, trigger.id) });
          setDragged(undefined);
        }}
      />;
    })}
    {!triggers.isLoading && ordered.length === 0 ? <CollectionEmptyState
      title={scopedRows.length === 0 && !filtersActive ? "No Triggers Yet" : "No Triggers match these filters"}
      detail={scopedRows.length === 0 && !filtersActive ? "Create a Trigger to automate Agent work." : `Try a different search${filterProjectId ? "." : " or Project filter."}`}
      action={filtersActive ? {
        label: "Clear Filters",
        onClick: () => {
          setSearch("");
          if (!filterProjectId) setProjectId("");
        },
      } : undefined}
    /> : null}
    <ResourceContextMenu
      state={menu}
      onClose={() => setMenu(undefined)}
      onOpenInNewTab={({ route }) => onOpenInNewTab(route)}
      actions={[
        {
          id: "settings",
          label: "Trigger Settings",
          icon: <SettingsOutlinedIcon fontSize="small" />,
          onSelect: ({ route, trigger }) => {
            if (route.kind === "agent")
              onNavigate({ ...route, triggerId: trigger.id });
          },
        },
        {
          id: "rename",
          label: "Rename",
          icon: <EditOutlinedIcon fontSize="small" />,
          onSelect: ({ trigger }) => setTriggerAction({ kind: "rename", trigger }),
        },
        {
          id: "delete",
          label: "Delete",
          icon: <DeleteOutlineIcon fontSize="small" />,
          color: "error",
          onSelect: ({ trigger }) => setTriggerAction({ kind: "delete", trigger }),
        },
      ]}
    />
    <TextInputDialog
      open={triggerAction?.kind === "rename"}
      title="Rename Trigger"
      label="Trigger name"
      initialValue={triggerAction?.trigger.name ?? ""}
      confirmLabel="Save"
      pendingLabel="Saving…"
      pending={renameTrigger.isPending}
      error={renameTrigger.isError ? String(renameTrigger.error) : undefined}
      validate={(value) => value.trim() ? undefined : "Enter a Trigger name."}
      onCancel={() => {
        renameTrigger.reset();
        setTriggerAction(undefined);
      }}
      onConfirm={(name) => {
        if (triggerAction?.kind === "rename")
          renameTrigger.mutate({ trigger: triggerAction.trigger, name: name.trim() });
      }}
    />
    <ResourceDeletionDialog
      open={triggerAction?.kind === "delete"}
      resourceType="Trigger"
      resourceName={triggerAction?.trigger.name}
      pendingLabel="Deleting…"
      pending={deleteTrigger.isPending}
      error={deleteTrigger.isError ? String(deleteTrigger.error) : undefined}
      onCancel={() => {
        deleteTrigger.reset();
        setTriggerAction(undefined);
      }}
      onConfirm={() => {
        if (triggerAction?.kind === "delete") deleteTrigger.mutate(triggerAction.trigger);
      }}
    >
      <Typography sx={{ pt: 1 }}>
        Pending occurrences will be cancelled. Immutable occurrence history
        remains available.
      </Typography>
    </ResourceDeletionDialog>
  </CollectionWorkspace>;
}

export function ProviderActivityWorkspace({ projects, projectId }: { projects: ProjectDto[]; projectId?: string }): JSX.Element {
  const agentQueries = useProjectAgents(projects);
  const agents = projects.flatMap((project, index) => (agentQueries[index]?.data ?? []).map((agent) => ({ project, agent })));
  const [scopeKey, setScopeKey] = useState(projectId ? `project:${projectId}` : "overall");
  const [rangeKey, setRangeKey] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const from = rangeKey === "all" ? undefined : new Date(Date.now() - ({ "24h": 1, "7d": 7, "30d": 30 }[rangeKey] * 86_400_000)).toISOString();
  const [scope, scopeId] = scopeKey === "overall" ? ["overall", undefined] as const : scopeKey.split(":", 2) as ["project" | "agent", string];
  const usage = useQuery({ queryKey: queryKeys.tokenUsage.detail(scope, scopeId, rangeKey), queryFn: () => api.getTokenUsage(scope, scopeId, from ? { from } : {}), refetchInterval: 30_000 });
  return <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflow: "auto" }}><CollectionHeader icon={<ChatBubbleOutlineIcon />} title="Provider Activity" detail="Provider-reported Run telemetry for experiments and diagnostics" /><Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ p: { xs: 2, md: 3 }, pb: 2 }}><FormControl size="small" sx={{ minWidth: 260 }}><InputLabel id="usage-scope">Scope</InputLabel><Select labelId="usage-scope" label="Scope" value={scopeKey} onChange={(event) => setScopeKey(event.target.value)}><MenuItem value="overall">All Ponderosa</MenuItem>{projects.map((project) => <MenuItem key={`project:${project.id}`} value={`project:${project.id}`}>Project · {project.label}</MenuItem>)}{agents.map(({ project, agent }) => <MenuItem key={`agent:${agent.id}`} value={`agent:${agent.id}`}>Agent · {agent.title} · {project.label}</MenuItem>)}</Select></FormControl><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="usage-range">Time Range</InputLabel><Select labelId="usage-range" label="Time Range" value={rangeKey} onChange={(event) => setRangeKey(event.target.value as typeof rangeKey)}><MenuItem value="24h">Last 24 Hours</MenuItem><MenuItem value="7d">Last 7 Days</MenuItem><MenuItem value="30d">Last 30 Days</MenuItem><MenuItem value="all">All Time</MenuItem></Select></FormControl></Stack><Alert severity="info" sx={{ mx: { xs: 2, md: 3 }, mb: 2 }}>Input includes instructions, tools, conversation context, and cached reuse. These are provider-reported tokens, not subscription quota, remaining context, or a cost estimate.</Alert><Box sx={{ px: { xs: 2, md: 3 }, pb: 4 }}>{usage.isError ? <Alert severity="error">Provider activity could not be loaded.</Alert> : !usage.data ? <LinearProgress /> : <TokenUsageDetails data={usage.data} />}</Box></Box>;
}
