import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import SearchIcon from "@mui/icons-material/Search";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Alert, Box, Button, ButtonBase, FormControl, InputAdornment, InputLabel, LinearProgress,
  Menu, MenuItem, Paper, Select, Stack, TextField, Typography,
} from "@mui/material";
import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import type { Route } from "../routing";
import { orderByStableIds, reorderStableIds } from "./WorkspaceSidebar";
import { TokenUsageDetails } from "./TokenUsageButton";

type ResourceSort = "recent" | "alphabetical" | "custom";

function WorkspaceHeader({ icon, title, detail, action }: { icon: JSX.Element; title: string; detail: string; action?: JSX.Element }): JSX.Element {
  return <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: { sm: "center" }, borderBottom: 1, borderColor: "divider" }}>
    <Stack direction="row" spacing={1.25} sx={{ flex: 1, alignItems: "center" }}>
      <Box sx={{ width: 42, height: 42, borderRadius: 2, bgcolor: "action.selected", display: "grid", placeItems: "center", color: "primary.main" }}>{icon}</Box>
      <Box><Typography variant="h5" component="h1" fontWeight={850}>{title}</Typography><Typography variant="body2" color="text.secondary">{detail}</Typography></Box>
    </Stack>
    {action}
  </Stack>;
}

function ResourceToolbar({ search, onSearch, sort, onSort, projectId, projects, onProject }: {
  search: string; onSearch(value: string): void; sort: ResourceSort; onSort(value: ResourceSort): void;
  projectId: string; projects: ProjectDto[]; onProject(value: string): void;
}): JSX.Element {
  return <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} sx={{ p: { xs: 2, md: 3 }, pb: 1.5 }}>
    <TextField size="small" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search" inputProps={{ "aria-label": "Search workspace resources" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }} sx={{ flex: 1 }} />
    <FormControl size="small" sx={{ minWidth: 190 }}><InputLabel id="resource-project-filter">Project</InputLabel><Select labelId="resource-project-filter" label="Project" value={projectId} onChange={(event) => onProject(event.target.value)}><MenuItem value="">All Projects</MenuItem>{projects.map((project) => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}</Select></FormControl>
    <FormControl size="small" sx={{ minWidth: 170 }}><InputLabel id="resource-sort">Sort</InputLabel><Select labelId="resource-sort" label="Sort" value={sort} onChange={(event) => onSort(event.target.value as ResourceSort)}><MenuItem value="recent">Recent Activity</MenuItem><MenuItem value="alphabetical">Alphabetical</MenuItem><MenuItem value="custom">Custom Order</MenuItem></Select></FormControl>
  </Stack>;
}

export function AllChatsWorkspace({ projects, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void; onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
}): JSX.Element {
  const queries = useQueries({ queries: projects.map((project) => ({ queryKey: ["conversations", project.id], queryFn: () => api.listConversations(project.id), staleTime: 10_000 })) });
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(filterProjectId ?? ""); const [sort, setSort] = useState<ResourceSort>("custom"); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<{ anchor: HTMLElement; route: Route }>();
  const rows = projects.flatMap((project, index) => (queries[index]?.data ?? []).filter((conversation) => !conversation.archived).map((conversation) => ({ project, conversation })));
  const filtered = rows.filter(({ project, conversation }) => (!projectId || project.id === projectId) && (!search.trim() || `${conversation.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sort === "alphabetical" ? [...filtered].sort((a, b) => a.conversation.title.localeCompare(b.conversation.title)) : sort === "recent" ? [...filtered].sort((a, b) => b.conversation.updatedAt.localeCompare(a.conversation.updatedAt)) : orderByStableIds(filtered, preferences.chatOrder, (row) => row.conversation.id);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}><WorkspaceHeader icon={<ChatBubbleOutlineIcon />} title="Chats" detail={`${rows.length} Project ${rows.length === 1 ? "Chat" : "Chats"} across Ponderosa`} action={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Chat</Button>} /><ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={setSort} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Stack spacing={1} sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>{ordered.map(({ project, conversation }) => { const route: Route = { kind: "conversation", projectId: project.id, conversationId: conversation.id }; return <Paper key={conversation.id} variant="outlined" draggable={sort === "custom"} onDragStart={() => setDragged(conversation.id)} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => { if (dragged) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragged) onPreferences({ chatOrder: reorderStableIds(preferences.chatOrder, rows.map((row) => row.conversation.id), dragged, conversation.id) }); setDragged(undefined); }} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route }); }}><ButtonBase onClick={() => onNavigate(route)} sx={{ width: "100%", p: 1.75, textAlign: "left", justifyContent: "flex-start", gap: 1.5 }}><ChatBubbleOutlineIcon /><Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={800} noWrap>{conversation.title}</Typography><Typography variant="body2" color="text.secondary">{project.label}</Typography></Box><Typography variant="caption" color="text.secondary">{new Date(conversation.updatedAt).toLocaleString()}</Typography></ButtonBase></Paper>; })}{!queries.some((query) => query.isLoading) && ordered.length === 0 ? <Alert severity="info">No Chats match these filters.</Alert> : null}</Stack>
    {menu ? <Menu anchorEl={menu.anchor} open onClose={() => setMenu(undefined)}><MenuItem onClick={() => { onOpenInNewTab(menu.route); setMenu(undefined); }}><OpenInNewIcon fontSize="small" sx={{ mr: 1 }} />Open in New Ponderosa Tab</MenuItem></Menu> : null}
  </Box>;
}

export function AllAgentsWorkspace({ projects, filterProjectId, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void; onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
}): JSX.Element {
  const queries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 5_000 })) });
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState(filterProjectId ?? "");
  const [sort, setSort] = useState<ResourceSort>("custom");
  const [dragged, setDragged] = useState<string>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; route: Route }>();
  const rows = projects.flatMap((project, index) => (queries[index]?.data ?? []).filter((agent) => !agent.archived).map((agent) => ({ project, agent })));
  const filtered = rows.filter(({ project, agent }) => (!projectId || project.id === projectId) && (!search.trim() || `${agent.title} ${project.label} ${agent.activeEngine}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sort === "alphabetical" ? [...filtered].sort((a, b) => a.agent.title.localeCompare(b.agent.title)) : sort === "recent" ? [...filtered].sort((a, b) => b.agent.updatedAt.localeCompare(a.agent.updatedAt)) : orderByStableIds(filtered, preferences.agentOrder, (row) => row.agent.id);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}>
    <WorkspaceHeader icon={<GroupsOutlinedIcon />} title="Agents" detail={`${rows.length} Agents across ${projects.length} ${projects.length === 1 ? "Project" : "Projects"}`} action={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Agent</Button>} />
    <ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={setSort} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Box sx={{ px: { xs: 2, md: 3 }, pb: 3, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 1.25 }}>
      {ordered.map(({ project, agent }) => { const route: Route = { kind: "agent", projectId: project.id, agentId: agent.id }; return <Paper key={agent.id} variant="outlined" draggable={sort === "custom"} onDragStart={() => setDragged(agent.id)} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => { if (dragged) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragged) onPreferences({ agentOrder: reorderStableIds(preferences.agentOrder, rows.map((row) => row.agent.id), dragged, agent.id) }); setDragged(undefined); }} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route }); }}>
        <ButtonBase onClick={() => onNavigate(route)} sx={{ width: "100%", p: 2, textAlign: "left", justifyContent: "flex-start", gap: 1.5 }}><Box sx={{ width: 42, height: 42, borderRadius: "50%", bgcolor: "action.selected", display: "grid", placeItems: "center" }}><SmartToyOutlinedIcon /></Box><Box sx={{ minWidth: 0 }}><Typography fontWeight={800} noWrap>{agent.title}</Typography><Typography variant="body2" color="text.secondary" noWrap>{project.label}</Typography><Typography variant="caption" color="text.secondary">{agent.activeEngine}</Typography></Box></ButtonBase>
      </Paper>; })}
      {!queries.some((query) => query.isLoading) && ordered.length === 0 ? <Alert severity="info">No Agents match these filters.</Alert> : null}
    </Box>
    {menu ? <Menu anchorEl={menu.anchor} open onClose={() => setMenu(undefined)}><MenuItem onClick={() => { onOpenInNewTab(menu.route); setMenu(undefined); }}><OpenInNewIcon fontSize="small" sx={{ mr: 1 }} />Open in New Ponderosa Tab</MenuItem></Menu> : null}
  </Box>;
}

export function AllTriggersWorkspace({ projects, preferences, onPreferences, onNavigate, onOpenInNewTab, onCreate }: {
  projects: ProjectDto[]; preferences: WorkspacePreferencesDto; onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigate(route: Route): void; onOpenInNewTab(route: Route): void; onCreate(projectId?: string): void;
}): JSX.Element {
  const triggers = useQuery({ queryKey: ["triggers"], queryFn: () => api.listAllTriggers(), staleTime: 5_000 });
  const agents = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 5_000 })) });
  const [search, setSearch] = useState(""); const [projectId, setProjectId] = useState(""); const [sort, setSort] = useState<ResourceSort>("custom"); const [dragged, setDragged] = useState<string>(); const [menu, setMenu] = useState<{ anchor: HTMLElement; route: Route }>();
  const destinations = useMemo(() => new Map(projects.flatMap((project, index) => (agents[index]?.data ?? []).map((agent) => [agent.id, { project, agent }] as const))), [projects, agents.map((query) => query.data)]);
  const rows = (triggers.data ?? []).flatMap((trigger) => { const destination = destinations.get(trigger.agentId); return destination ? [{ trigger, ...destination }] : []; });
  const filtered = rows.filter(({ project, agent, trigger }) => (!projectId || project.id === projectId) && (!search.trim() || `${trigger.name} ${trigger.sourceKind} ${agent.title} ${project.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const ordered = sort === "alphabetical" ? [...filtered].sort((a, b) => a.trigger.name.localeCompare(b.trigger.name)) : sort === "recent" ? [...filtered].sort((a, b) => b.trigger.updatedAt.localeCompare(a.trigger.updatedAt)) : orderByStableIds(filtered, preferences.triggerOrder, (row) => row.trigger.id);
  return <Box sx={{ minHeight: 0, overflow: "auto" }}><WorkspaceHeader icon={<BoltOutlinedIcon />} title="Triggers" detail={`${rows.length} configured automation${rows.length === 1 ? "" : "s"}`} action={<Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(projectId || undefined)}>New Trigger</Button>} /><ResourceToolbar search={search} onSearch={setSearch} sort={sort} onSort={setSort} projectId={projectId} projects={projects} onProject={setProjectId} />
    <Stack spacing={1} sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>{ordered.map(({ project, agent, trigger }) => { const route: Route = { kind: "agent", projectId: project.id, agentId: agent.id, view: "triggers" }; return <Paper key={trigger.id} variant="outlined" draggable={sort === "custom"} onDragStart={() => setDragged(trigger.id)} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => { if (dragged) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragged) onPreferences({ triggerOrder: reorderStableIds(preferences.triggerOrder, rows.map((row) => row.trigger.id), dragged, trigger.id) }); setDragged(undefined); }} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route }); }}><ButtonBase onClick={() => onNavigate(route)} sx={{ width: "100%", p: 1.75, textAlign: "left", justifyContent: "flex-start", gap: 1.5 }}><BoltOutlinedIcon color={trigger.enabled ? "primary" : "disabled"} /><Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={800}>{trigger.name}</Typography><Typography variant="body2" color="text.secondary">{project.label} · {agent.title} · {trigger.sourceKind}</Typography></Box><Typography variant="caption" color={trigger.enabled ? "success.main" : "text.disabled"}>{trigger.enabled ? "Enabled" : "Disabled"}</Typography></ButtonBase></Paper>; })}{!triggers.isLoading && ordered.length === 0 ? <Alert severity="info">No Triggers match these filters.</Alert> : null}</Stack>
    {menu ? <Menu anchorEl={menu.anchor} open onClose={() => setMenu(undefined)}><MenuItem onClick={() => { onOpenInNewTab(menu.route); setMenu(undefined); }}><OpenInNewIcon fontSize="small" sx={{ mr: 1 }} />Open in New Ponderosa Tab</MenuItem></Menu> : null}
  </Box>;
}

export function ProviderActivityWorkspace({ projects, projectId }: { projects: ProjectDto[]; projectId?: string }): JSX.Element {
  const [scopeProjectId, setScopeProjectId] = useState(projectId ?? "");
  const [rangeKey, setRangeKey] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const from = rangeKey === "all" ? undefined : new Date(Date.now() - ({ "24h": 1, "7d": 7, "30d": 30 }[rangeKey] * 86_400_000)).toISOString();
  const usage = useQuery({ queryKey: ["token-usage", scopeProjectId || "overall", rangeKey], queryFn: () => api.getTokenUsage(scopeProjectId ? "project" : "overall", scopeProjectId || undefined, from ? { from } : {}), refetchInterval: 30_000 });
  return <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflow: "auto" }}><WorkspaceHeader icon={<ChatBubbleOutlineIcon />} title="Provider Activity" detail="Provider-reported Run telemetry, not subscription quota or remaining context" /><Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ p: { xs: 2, md: 3 }, pb: 2 }}><FormControl size="small" sx={{ minWidth: 220 }}><InputLabel id="usage-project">Scope</InputLabel><Select labelId="usage-project" label="Scope" value={scopeProjectId} onChange={(event) => setScopeProjectId(event.target.value)}><MenuItem value="">All Ponderosa</MenuItem>{projects.map((project) => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}</Select></FormControl><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="usage-range">Time Range</InputLabel><Select labelId="usage-range" label="Time Range" value={rangeKey} onChange={(event) => setRangeKey(event.target.value as typeof rangeKey)}><MenuItem value="24h">Last 24 Hours</MenuItem><MenuItem value="7d">Last 7 Days</MenuItem><MenuItem value="30d">Last 30 Days</MenuItem><MenuItem value="all">All Time</MenuItem></Select></FormControl></Stack><Alert severity="info" sx={{ mx: { xs: 2, md: 3 }, mb: 2 }}>Input includes instructions, tools, conversation context, and cached reuse. A high total alone does not mean Ponderosa repeated work.</Alert><Box sx={{ px: { xs: 2, md: 3 }, pb: 4 }}>{usage.isError ? <Alert severity="error">Provider activity could not be loaded.</Alert> : !usage.data ? <LinearProgress /> : <TokenUsageDetails data={usage.data} />}</Box></Box>;
}
