import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import SortOutlinedIcon from "@mui/icons-material/SortOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Alert, Box, Button, FormControl, IconButton, InputLabel, LinearProgress,
  Menu, MenuItem, Select, Stack, Tooltip, Typography,
} from "@mui/material";
import type { EngineDto, ProjectDto, ProjectSort, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
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
import { CollectionHeader, CollectionToolbar, ResourceRow } from "./CollectionPrimitives";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";

function ResourceToolbar({ search, onSearch, sort, onSort, projectId, projects, onProject }: {
  search: string; onSearch(value: string): void; sort: ProjectSort; onSort(value: ProjectSort): void;
  projectId: string; projects: ProjectDto[]; onProject(value: string): void;
}): JSX.Element {
  return <CollectionToolbar search={search} onSearch={onSearch} searchLabel="Search workspace resources">
    <FormControl size="small" sx={{ minWidth: 190 }}><InputLabel id="resource-project-filter">Project</InputLabel><Select labelId="resource-project-filter" label="Project" value={projectId} onChange={(event) => onProject(event.target.value)}><MenuItem value="">All Projects</MenuItem>{projects.map((project) => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}</Select></FormControl>
    <FormControl size="small" sx={{ minWidth: 170 }}><InputLabel id="resource-sort">Sort</InputLabel><Select labelId="resource-sort" label="Sort" value={sort} onChange={(event) => onSort(event.target.value as ProjectSort)}><MenuItem value="last_used">Recent Activity</MenuItem><MenuItem value="alphabetical">Alphabetical</MenuItem><MenuItem value="custom">Custom Order</MenuItem></Select></FormControl>
  </CollectionToolbar>;
}

export function AllChatsWorkspace({ projects, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void; onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
}): JSX.Element {
  const queries = useProjectConversations(projects);
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(filterProjectId ?? ""); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<ResourceContextMenuState<Route>>();
  const sort = workspaceResourceSort(preferences, "chat"); const starred = starredWorkspaceResources(preferences);
  const rows = projects.flatMap((project, index) => (queries[index]?.data ?? []).filter((conversation) => !conversation.archived).map((conversation) => ({ project, conversation })));
  const filtered = rows.filter(({ project, conversation }) => (!projectId || project.id === projectId) && (!search.trim() || `${conversation.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sortWorkspaceResources(filtered, sort, preferences.chatOrder, (row) => row.conversation.id, (row) => row.conversation.title, (row) => row.conversation.updatedAt);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}><CollectionHeader icon={<ChatBubbleOutlineIcon />} title="Chats" detail={`${rows.length} Project ${rows.length === 1 ? "Chat" : "Chats"} across Ponderosa`} actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Chat</Button>} /><ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={(value) => onPreferences(workspaceResourceSortPatch("chat", value))} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Stack spacing={1} sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>{ordered.map(({ project, conversation }) => {
      const route: Route = { kind: "conversation", projectId: project.id, conversationId: conversation.id };
      const key = resourcePreferenceKey("conversation", conversation.id);
      return <ResourceRow
        key={conversation.id}
        label={conversation.title}
        description={project.label}
        icon={<ChatBubbleOutlineIcon />}
        meta={<Typography variant="caption" color="text.secondary">{new Date(conversation.updatedAt).toLocaleString()}</Typography>}
        trailing={<Tooltip title={starred.has(key) ? "Unstar Chat" : "Star Chat"}><IconButton aria-label={starred.has(key) ? `Unstar ${conversation.title}` : `Star ${conversation.title}`} onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "conversation", conversation.id))}>{starred.has(key) ? <StarRoundedIcon color="primary" /> : <StarBorderRoundedIcon />}</IconButton></Tooltip>}
        onOpen={() => onNavigate(route)}
        onContextMenu={(anchor) => setMenu({ anchor, resource: route })}
        draggable
        onDragStart={() => setDragged(conversation.id)}
        onDragEnd={() => setDragged(undefined)}
        onDrop={() => {
          if (dragged) onPreferences({ chatSort: "custom", chatOrder: reorderStableIds(preferences.chatOrder, rows.map((row) => row.conversation.id), dragged, conversation.id) });
          setDragged(undefined);
        }}
      />;
    })}{!queries.some((query) => query.isLoading) && ordered.length === 0 ? <Alert severity="info">No Chats match these filters.</Alert> : null}</Stack>
    <ResourceContextMenu state={menu} onClose={() => setMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </Box>;
}

export function AllAgentsWorkspace({ projects, engines, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; engines: EngineDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string, managerAgentId?: string): void;
}): JSX.Element {
  const agentQueries = useProjectAgents(projects);
  const conversationQueries = useProjectConversations(projects);
  const healthQueries = useProjectAgentHealth(projects);
  const [projectId, setProjectId] = useState(filterProjectId ?? "");
  const [sortAnchor, setSortAnchor] = useState<HTMLElement>();
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
  return <Box className="ponderosa-scroll" sx={{ height: "100%", minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
    {projects.length ? <AgentsTab toolbarControls={<>
      <FormControl size="small" sx={{ minWidth: 220, width: { xs: "100%", sm: "auto" } }}><InputLabel id="agents-project-filter">Project</InputLabel><Select labelId="agents-project-filter" label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><MenuItem value="">All Projects</MenuItem>{projects.map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.label}</MenuItem>)}</Select></FormControl>
      <Button color="inherit" startIcon={<SortOutlinedIcon />} onClick={(event) => setSortAnchor(event.currentTarget)} sx={{ minHeight: 40, whiteSpace: "nowrap" }}>Sort</Button>
      {sortAnchor ? <Menu anchorEl={sortAnchor} open onClose={() => setSortAnchor(undefined)}>
        <MenuItem selected={sort === "last_used"} onClick={() => { onPreferences(workspaceResourceSortPatch("agent", "last_used")); setSortAnchor(undefined); }}>Recent Activity</MenuItem>
        <MenuItem selected={sort === "alphabetical"} onClick={() => { onPreferences(workspaceResourceSortPatch("agent", "alphabetical")); setSortAnchor(undefined); }}>Alphabetical</MenuItem>
        <MenuItem selected={sort === "custom"} onClick={() => { onPreferences(workspaceResourceSortPatch("agent", "custom")); setSortAnchor(undefined); }}>Custom Order</MenuItem>
      </Menu> : null}
    </>} agents={agents} projectId={projectId || undefined} engines={engines} conversations={conversations} statusByAgentId={statusByAgentId} healthByAgentId={healthByAgentId} projectByAgentId={projectId ? undefined : projectByAgentId} displayOrder={agents.map((agent) => agent.id)} selectionAllowed={Boolean(projectId)} onReorder={sort === "custom" ? (sourceId, targetId) => onPreferences({ agentOrder: reorderStableIds(preferences.agentOrder, rows.map((row) => row.agent.id), sourceId, targetId) }) : undefined} starredAgentIds={starredIds} onToggleStar={(agentId) => onPreferences(toggleWorkspaceResourceStar(preferences, "agent", agentId))} onOpenAgent={(agentId) => { const project = projectByAgentId.get(agentId)!; onNavigate({ kind: "agent", projectId: project.id, agentId }); }} onOpenAgentInNewTab={(agentId) => { const project = projectByAgentId.get(agentId)!; onOpenInNewTab({ kind: "agent", projectId: project.id, agentId }); }} onNewAgent={(managerAgentId) => onCreate(managerAgentId ? projectByAgentId.get(managerAgentId)?.id : projectId || undefined, managerAgentId)} /> : <Alert severity="info" sx={{ m: 2 }}>Create a Project before creating Agents.</Alert>}
  </Box>;
}

export function AllTriggersWorkspace({ projects, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; preferences: WorkspacePreferencesDto; onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(): void;
}): JSX.Element {
  const triggers = useQuery({ queryKey: queryKeys.triggers.all, queryFn: () => api.listAllTriggers(), staleTime: 5_000 });
  const agents = useProjectAgents(projects);
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(""); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<ResourceContextMenuState<Route>>();
  const sort = workspaceResourceSort(preferences, "trigger"); const starred = starredWorkspaceResources(preferences);
  const destinations = useMemo(() => new Map(projects.flatMap((project, index) => (agents[index]?.data ?? []).map((agent) => [agent.id, { project, agent }] as const))), [projects, agents.map((query) => query.data)]);
  const rows = (triggers.data ?? []).flatMap((trigger) => { const destination = destinations.get(trigger.agentId); return destination ? [{ trigger, ...destination }] : []; });
  const filtered = rows.filter(({ project, agent, trigger }) => (!projectId || project.id === projectId) && (!search.trim() || `${trigger.name} ${trigger.sourceKind} ${agent.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sortWorkspaceResources(filtered, sort, preferences.triggerOrder, (row) => row.trigger.id, (row) => row.trigger.name, (row) => row.trigger.updatedAt);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}><CollectionHeader icon={<BoltOutlinedIcon />} title="Triggers" detail={`${rows.length} configured automation${rows.length === 1 ? "" : "s"}`} actions={<Button variant="contained" startIcon={<AddIcon />} onClick={onCreate}>New Trigger</Button>} /><ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={(value) => onPreferences(workspaceResourceSortPatch("trigger", value))} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Stack spacing={1} sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>{ordered.map(({ project, agent, trigger }) => {
      const route: Route = { kind: "agent", projectId: project.id, agentId: agent.id, view: "triggers" };
      const key = resourcePreferenceKey("trigger", trigger.id);
      return <ResourceRow
        key={trigger.id}
        label={trigger.name}
        description={`${project.label} · ${agent.title} · ${trigger.sourceKind}`}
        icon={<BoltOutlinedIcon color={trigger.enabled ? "primary" : "disabled"} />}
        meta={<Typography variant="caption" color={trigger.enabled ? "success.main" : "text.disabled"}>{trigger.enabled ? "Enabled" : "Disabled"}</Typography>}
        trailing={<Tooltip title={starred.has(key) ? "Unstar Trigger" : "Star Trigger"}><IconButton aria-label={starred.has(key) ? `Unstar ${trigger.name}` : `Star ${trigger.name}`} onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "trigger", trigger.id))}>{starred.has(key) ? <StarRoundedIcon color="primary" /> : <StarBorderRoundedIcon />}</IconButton></Tooltip>}
        onOpen={() => onNavigate(route)}
        onContextMenu={(anchor) => setMenu({ anchor, resource: route })}
        draggable
        onDragStart={() => setDragged(trigger.id)}
        onDragEnd={() => setDragged(undefined)}
        onDrop={() => {
          if (dragged) onPreferences({ triggerSort: "custom", triggerOrder: reorderStableIds(preferences.triggerOrder, rows.map((row) => row.trigger.id), dragged, trigger.id) });
          setDragged(undefined);
        }}
      />;
    })}{!triggers.isLoading && ordered.length === 0 ? <Alert severity="info">No Triggers match these filters.</Alert> : null}</Stack>
    <ResourceContextMenu state={menu} onClose={() => setMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </Box>;
}

export function ProviderActivityWorkspace({ projects, projectId }: { projects: ProjectDto[]; projectId?: string }): JSX.Element {
  const agentQueries = useProjectAgents(projects);
  const agents = projects.flatMap((project, index) => (agentQueries[index]?.data ?? []).map((agent) => ({ project, agent })));
  const [scopeKey, setScopeKey] = useState(projectId ? `project:${projectId}` : "overall");
  const [rangeKey, setRangeKey] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const from = rangeKey === "all" ? undefined : new Date(Date.now() - ({ "24h": 1, "7d": 7, "30d": 30 }[rangeKey] * 86_400_000)).toISOString();
  const [scope, scopeId] = scopeKey === "overall" ? ["overall", undefined] as const : scopeKey.split(":", 2) as ["project" | "agent", string];
  const usage = useQuery({ queryKey: ["token-usage", scope, scopeId, rangeKey], queryFn: () => api.getTokenUsage(scope, scopeId, from ? { from } : {}), refetchInterval: 30_000 });
  return <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflow: "auto" }}><CollectionHeader icon={<ChatBubbleOutlineIcon />} title="Provider Activity" detail="Provider-reported Run telemetry for experiments and diagnostics" /><Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ p: { xs: 2, md: 3 }, pb: 2 }}><FormControl size="small" sx={{ minWidth: 260 }}><InputLabel id="usage-scope">Scope</InputLabel><Select labelId="usage-scope" label="Scope" value={scopeKey} onChange={(event) => setScopeKey(event.target.value)}><MenuItem value="overall">All Ponderosa</MenuItem>{projects.map((project) => <MenuItem key={`project:${project.id}`} value={`project:${project.id}`}>Project · {project.label}</MenuItem>)}{agents.map(({ project, agent }) => <MenuItem key={`agent:${agent.id}`} value={`agent:${agent.id}`}>Agent · {agent.title} · {project.label}</MenuItem>)}</Select></FormControl><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="usage-range">Time Range</InputLabel><Select labelId="usage-range" label="Time Range" value={rangeKey} onChange={(event) => setRangeKey(event.target.value as typeof rangeKey)}><MenuItem value="24h">Last 24 Hours</MenuItem><MenuItem value="7d">Last 7 Days</MenuItem><MenuItem value="30d">Last 30 Days</MenuItem><MenuItem value="all">All Time</MenuItem></Select></FormControl></Stack><Alert severity="info" sx={{ mx: { xs: 2, md: 3 }, mb: 2 }}>Input includes instructions, tools, conversation context, and cached reuse. These are provider-reported tokens, not subscription quota, remaining context, or a cost estimate.</Alert><Box sx={{ px: { xs: 2, md: 3 }, pb: 4 }}>{usage.isError ? <Alert severity="error">Provider activity could not be loaded.</Alert> : !usage.data ? <LinearProgress /> : <TokenUsageDetails data={usage.data} />}</Box></Box>;
}
