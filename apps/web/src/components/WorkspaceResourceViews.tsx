import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import SearchIcon from "@mui/icons-material/Search";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Alert, Box, Button, ButtonBase, FormControl, IconButton, InputAdornment, InputLabel, LinearProgress,
  Menu, MenuItem, Paper, Select, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { ProjectDto, ProjectSort, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import {
  resourcePreferenceKey, sortWorkspaceResources, starredWorkspaceResources,
  toggleWorkspaceResourceStar, workspaceResourceSort, workspaceResourceSortPatch,
} from "../resourcePreferences";
import type { Route } from "../routing";
import { reorderStableIds } from "./WorkspaceSidebar";
import { TokenUsageDetails } from "./TokenUsageButton";

function WorkspaceHeader({ icon, title, detail, action }: { icon: JSX.Element; title: string; detail: string; action?: JSX.Element }): JSX.Element {
  return <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: { sm: "center" }, borderBottom: 1, borderColor: "divider" }}>
    <Stack direction="row" spacing={1.25} sx={{ flex: 1, alignItems: "center" }}><Box sx={{ width: 42, height: 42, borderRadius: 2, bgcolor: "action.selected", display: "grid", placeItems: "center", color: "primary.main" }}>{icon}</Box><Box><Typography variant="h5" component="h1" fontWeight={850}>{title}</Typography><Typography variant="body2" color="text.secondary">{detail}</Typography></Box></Stack>
    {action}
  </Stack>;
}

function ResourceToolbar({ search, onSearch, sort, onSort, projectId, projects, onProject }: {
  search: string; onSearch(value: string): void; sort: ProjectSort; onSort(value: ProjectSort): void;
  projectId: string; projects: ProjectDto[]; onProject(value: string): void;
}): JSX.Element {
  return <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} sx={{ p: { xs: 2, md: 3 }, pb: 1.5 }}>
    <TextField size="small" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search" inputProps={{ "aria-label": "Search workspace resources" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }} sx={{ flex: 1 }} />
    <FormControl size="small" sx={{ minWidth: 190 }}><InputLabel id="resource-project-filter">Project</InputLabel><Select labelId="resource-project-filter" label="Project" value={projectId} onChange={(event) => onProject(event.target.value)}><MenuItem value="">All Projects</MenuItem>{projects.map((project) => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}</Select></FormControl>
    <FormControl size="small" sx={{ minWidth: 170 }}><InputLabel id="resource-sort">Sort</InputLabel><Select labelId="resource-sort" label="Sort" value={sort} onChange={(event) => onSort(event.target.value as ProjectSort)}><MenuItem value="last_used">Recent Activity</MenuItem><MenuItem value="alphabetical">Alphabetical</MenuItem><MenuItem value="custom">Custom Order</MenuItem></Select></FormControl>
  </Stack>;
}

function ResourceMenu({ menu, onClose, onOpenInNewTab }: { menu?: { anchor: HTMLElement; route: Route }; onClose(): void; onOpenInNewTab(route: Route): void }): JSX.Element | null {
  return menu ? <Menu anchorEl={menu.anchor} open onClose={onClose}><MenuItem onClick={() => { onOpenInNewTab(menu.route); onClose(); }}><OpenInNewIcon fontSize="small" sx={{ mr: 1 }} />Open in New Ponderosa Tab</MenuItem></Menu> : null;
}

export function AllChatsWorkspace({ projects, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void; onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
}): JSX.Element {
  const queries = useQueries({ queries: projects.map((project) => ({ queryKey: ["conversations", project.id], queryFn: () => api.listConversations(project.id), staleTime: 10_000 })) });
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(filterProjectId ?? ""); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<{ anchor: HTMLElement; route: Route }>();
  const sort = workspaceResourceSort(preferences, "chat"); const starred = starredWorkspaceResources(preferences);
  const rows = projects.flatMap((project, index) => (queries[index]?.data ?? []).filter((conversation) => !conversation.archived).map((conversation) => ({ project, conversation })));
  const filtered = rows.filter(({ project, conversation }) => (!projectId || project.id === projectId) && (!search.trim() || `${conversation.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sortWorkspaceResources(filtered, sort, preferences.chatOrder, (row) => row.conversation.id, (row) => row.conversation.title, (row) => row.conversation.updatedAt);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}><WorkspaceHeader icon={<ChatBubbleOutlineIcon />} title="Chats" detail={`${rows.length} Project ${rows.length === 1 ? "Chat" : "Chats"} across Ponderosa`} action={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Chat</Button>} /><ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={(value) => onPreferences(workspaceResourceSortPatch("chat", value))} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Stack spacing={1} sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>{ordered.map(({ project, conversation }) => { const route: Route = { kind: "conversation", projectId: project.id, conversationId: conversation.id }; const key = resourcePreferenceKey("conversation", conversation.id); return <Paper key={conversation.id} variant="outlined" draggable onDragStart={() => setDragged(conversation.id)} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => { if (dragged) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragged) onPreferences({ chatSort: "custom", chatOrder: reorderStableIds(preferences.chatOrder, rows.map((row) => row.conversation.id), dragged, conversation.id) }); setDragged(undefined); }} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route }); }} sx={{ display: "flex", alignItems: "stretch" }}><ButtonBase onClick={() => onNavigate(route)} sx={{ minWidth: 0, flex: 1, p: 1.75, textAlign: "left", justifyContent: "flex-start", gap: 1.5 }}><ChatBubbleOutlineIcon /><Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={800} noWrap>{conversation.title}</Typography><Typography variant="body2" color="text.secondary">{project.label}</Typography></Box><Typography variant="caption" color="text.secondary">{new Date(conversation.updatedAt).toLocaleString()}</Typography></ButtonBase><Tooltip title={starred.has(key) ? "Unstar Chat" : "Star Chat"}><IconButton aria-label={starred.has(key) ? `Unstar ${conversation.title}` : `Star ${conversation.title}`} onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "conversation", conversation.id))}>{starred.has(key) ? <StarRoundedIcon color="primary" /> : <StarBorderRoundedIcon />}</IconButton></Tooltip></Paper>; })}{!queries.some((query) => query.isLoading) && ordered.length === 0 ? <Alert severity="info">No Chats match these filters.</Alert> : null}</Stack>
    <ResourceMenu menu={menu} onClose={() => setMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </Box>;
}

export function AllAgentsWorkspace({ projects, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void; onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
}): JSX.Element {
  const queries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 5_000 })) });
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(filterProjectId ?? ""); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<{ anchor: HTMLElement; route: Route }>();
  const sort = workspaceResourceSort(preferences, "agent"); const starred = starredWorkspaceResources(preferences);
  const rows = projects.flatMap((project, index) => (queries[index]?.data ?? []).filter((agent) => !agent.archived).map((agent) => ({ project, agent })));
  const filtered = rows.filter(({ project, agent }) => (!projectId || project.id === projectId) && (!search.trim() || `${agent.title} ${project.label} ${agent.activeEngine}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sortWorkspaceResources(filtered, sort, preferences.agentOrder, (row) => row.agent.id, (row) => row.agent.title, (row) => row.agent.updatedAt);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}><WorkspaceHeader icon={<GroupsOutlinedIcon />} title="Agents" detail={`${rows.length} Agents across ${projects.length} ${projects.length === 1 ? "Project" : "Projects"}`} action={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Agent</Button>} /><ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={(value) => onPreferences(workspaceResourceSortPatch("agent", value))} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Box sx={{ px: { xs: 2, md: 3 }, pb: 3, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 1.25 }}>{ordered.map(({ project, agent }) => { const route: Route = { kind: "agent", projectId: project.id, agentId: agent.id }; const key = resourcePreferenceKey("agent", agent.id); return <Paper key={agent.id} variant="outlined" draggable onDragStart={() => setDragged(agent.id)} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => { if (dragged) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragged) onPreferences({ agentSort: "custom", agentOrder: reorderStableIds(preferences.agentOrder, rows.map((row) => row.agent.id), dragged, agent.id) }); setDragged(undefined); }} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route }); }} sx={{ display: "flex" }}><ButtonBase onClick={() => onNavigate(route)} sx={{ minWidth: 0, flex: 1, p: 2, textAlign: "left", justifyContent: "flex-start", gap: 1.5 }}><Box sx={{ width: 42, height: 42, borderRadius: "50%", bgcolor: "action.selected", display: "grid", placeItems: "center" }}><SmartToyOutlinedIcon /></Box><Box sx={{ minWidth: 0 }}><Typography fontWeight={800} noWrap>{agent.title}</Typography><Typography variant="body2" color="text.secondary" noWrap>{project.label}</Typography><Typography variant="caption" color="text.secondary">{agent.activeEngine}</Typography></Box></ButtonBase><Tooltip title={starred.has(key) ? "Unstar Agent" : "Star Agent"}><IconButton aria-label={starred.has(key) ? `Unstar ${agent.title}` : `Star ${agent.title}`} onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "agent", agent.id))}>{starred.has(key) ? <StarRoundedIcon color="primary" /> : <StarBorderRoundedIcon />}</IconButton></Tooltip></Paper>; })}{!queries.some((query) => query.isLoading) && ordered.length === 0 ? <Alert severity="info">No Agents match these filters.</Alert> : null}</Box>
    <ResourceMenu menu={menu} onClose={() => setMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </Box>;
}

export function AllTriggersWorkspace({ projects, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; preferences: WorkspacePreferencesDto; onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
}): JSX.Element {
  const triggers = useQuery({ queryKey: ["triggers"], queryFn: () => api.listAllTriggers(), staleTime: 5_000 });
  const agents = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 5_000 })) });
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(""); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<{ anchor: HTMLElement; route: Route }>();
  const sort = workspaceResourceSort(preferences, "trigger"); const starred = starredWorkspaceResources(preferences);
  const destinations = useMemo(() => new Map(projects.flatMap((project, index) => (agents[index]?.data ?? []).map((agent) => [agent.id, { project, agent }] as const))), [projects, agents.map((query) => query.data)]);
  const rows = (triggers.data ?? []).flatMap((trigger) => { const destination = destinations.get(trigger.agentId); return destination ? [{ trigger, ...destination }] : []; });
  const filtered = rows.filter(({ project, agent, trigger }) => (!projectId || project.id === projectId) && (!search.trim() || `${trigger.name} ${trigger.sourceKind} ${agent.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sortWorkspaceResources(filtered, sort, preferences.triggerOrder, (row) => row.trigger.id, (row) => row.trigger.name, (row) => row.trigger.updatedAt);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}><WorkspaceHeader icon={<BoltOutlinedIcon />} title="Triggers" detail={`${rows.length} configured automation${rows.length === 1 ? "" : "s"}`} action={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Trigger</Button>} /><ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={(value) => onPreferences(workspaceResourceSortPatch("trigger", value))} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Stack spacing={1} sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>{ordered.map(({ project, agent, trigger }) => { const route: Route = { kind: "agent", projectId: project.id, agentId: agent.id, view: "triggers" }; const key = resourcePreferenceKey("trigger", trigger.id); return <Paper key={trigger.id} variant="outlined" draggable onDragStart={() => setDragged(trigger.id)} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => { if (dragged) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragged) onPreferences({ triggerSort: "custom", triggerOrder: reorderStableIds(preferences.triggerOrder, rows.map((row) => row.trigger.id), dragged, trigger.id) }); setDragged(undefined); }} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route }); }} sx={{ display: "flex" }}><ButtonBase onClick={() => onNavigate(route)} sx={{ minWidth: 0, flex: 1, p: 1.75, textAlign: "left", justifyContent: "flex-start", gap: 1.5 }}><BoltOutlinedIcon color={trigger.enabled ? "primary" : "disabled"} /><Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={800}>{trigger.name}</Typography><Typography variant="body2" color="text.secondary">{project.label} · {agent.title} · {trigger.sourceKind}</Typography></Box><Typography variant="caption" color={trigger.enabled ? "success.main" : "text.disabled"}>{trigger.enabled ? "Enabled" : "Disabled"}</Typography></ButtonBase><Tooltip title={starred.has(key) ? "Unstar Trigger" : "Star Trigger"}><IconButton aria-label={starred.has(key) ? `Unstar ${trigger.name}` : `Star ${trigger.name}`} onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "trigger", trigger.id))}>{starred.has(key) ? <StarRoundedIcon color="primary" /> : <StarBorderRoundedIcon />}</IconButton></Tooltip></Paper>; })}{!triggers.isLoading && ordered.length === 0 ? <Alert severity="info">No Triggers match these filters.</Alert> : null}</Stack>
    <ResourceMenu menu={menu} onClose={() => setMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </Box>;
}

export function ProviderActivityWorkspace({ projects, projectId }: { projects: ProjectDto[]; projectId?: string }): JSX.Element {
  const agentQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 10_000 })) });
  const agents = projects.flatMap((project, index) => (agentQueries[index]?.data ?? []).map((agent) => ({ project, agent })));
  const [scopeKey, setScopeKey] = useState(projectId ? `project:${projectId}` : "overall");
  const [rangeKey, setRangeKey] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const from = rangeKey === "all" ? undefined : new Date(Date.now() - ({ "24h": 1, "7d": 7, "30d": 30 }[rangeKey] * 86_400_000)).toISOString();
  const [scope, scopeId] = scopeKey === "overall" ? ["overall", undefined] as const : scopeKey.split(":", 2) as ["project" | "agent", string];
  const usage = useQuery({ queryKey: ["token-usage", scope, scopeId, rangeKey], queryFn: () => api.getTokenUsage(scope, scopeId, from ? { from } : {}), refetchInterval: 30_000 });
  return <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflow: "auto" }}><WorkspaceHeader icon={<ChatBubbleOutlineIcon />} title="Provider Activity" detail="Provider-reported Run telemetry for experiments and diagnostics" /><Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ p: { xs: 2, md: 3 }, pb: 2 }}><FormControl size="small" sx={{ minWidth: 260 }}><InputLabel id="usage-scope">Scope</InputLabel><Select labelId="usage-scope" label="Scope" value={scopeKey} onChange={(event) => setScopeKey(event.target.value)}><MenuItem value="overall">All Ponderosa</MenuItem>{projects.map((project) => <MenuItem key={`project:${project.id}`} value={`project:${project.id}`}>Project · {project.label}</MenuItem>)}{agents.map(({ project, agent }) => <MenuItem key={`agent:${agent.id}`} value={`agent:${agent.id}`}>Agent · {agent.title} · {project.label}</MenuItem>)}</Select></FormControl><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="usage-range">Time Range</InputLabel><Select labelId="usage-range" label="Time Range" value={rangeKey} onChange={(event) => setRangeKey(event.target.value as typeof rangeKey)}><MenuItem value="24h">Last 24 Hours</MenuItem><MenuItem value="7d">Last 7 Days</MenuItem><MenuItem value="30d">Last 30 Days</MenuItem><MenuItem value="all">All Time</MenuItem></Select></FormControl></Stack><Alert severity="info" sx={{ mx: { xs: 2, md: 3 }, mb: 2 }}>Input includes instructions, tools, conversation context, and cached reuse. These are provider-reported tokens, not subscription quota, remaining context, or a cost estimate.</Alert><Box sx={{ px: { xs: 2, md: 3 }, pb: 4 }}>{usage.isError ? <Alert severity="error">Provider activity could not be loaded.</Alert> : !usage.data ? <LinearProgress /> : <TokenUsageDetails data={usage.data} />}</Box></Box>;
}
