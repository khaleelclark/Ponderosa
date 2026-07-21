import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Badge,
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import type { AgentDto, AgentHealthDto, ConversationDto, EngineDto, ProjectDto, WorkspaceNotificationDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { agentStatusColor, agentStatusLabel } from "../agents";
import { api } from "../api";
import { conversationDisplayTitle } from "../conversationLabels";
import { engineAvailabilityPresentation, engineIsAvailable } from "../conversationEngine";
import { routeProjectId, type Route } from "../routing";
import { currentProjectSnapshot, projectDisambiguator, unreadByConversation, workspaceAgents, workspaceCounts, type WorkspaceProjectSnapshot } from "../workspaceNavigation";
import { OperatorAvatar } from "./OperatorAvatar";
import {
  clampWorkspaceSidebarWidth,
  WORKSPACE_SIDEBAR_MAX_WIDTH,
  WORKSPACE_SIDEBAR_MIN_WIDTH,
} from "../workspaceSidebarState";

export const SIDEBAR_MIN_WIDTH = WORKSPACE_SIDEBAR_MIN_WIDTH;
export const SIDEBAR_MAX_WIDTH = WORKSPACE_SIDEBAR_MAX_WIDTH;
export const SIDEBAR_RAIL_WIDTH = 72;
export const SIDEBAR_PANEL_WIDTH = 318;

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
}

export function operatorInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "U";
  const initials = words.length === 1
    ? words[0]!.slice(0, 2)
    : `${words[0]![0] ?? ""}${words.at(-1)?.[0] ?? ""}`;
  return initials.toLocaleUpperCase();
}

export function globalSearchShortcutLabel(platform = typeof navigator === "undefined" ? "" : navigator.platform): "⌘K" | "Ctrl K" {
  return /Mac|iPhone|iPad/iu.test(platform) ? "⌘K" : "Ctrl K";
}

export function globalSearchShortcutAccessibleLabel(platform = typeof navigator === "undefined" ? "" : navigator.platform): "Command K" | "Control K" {
  return /Mac|iPhone|iPad/iu.test(platform) ? "Command K" : "Control K";
}

function actionableProjectHealth(
  health: AgentHealthDto[] | undefined,
  agents: Pick<AgentDto, "id" | "activeEngine">[],
  engines: EngineDto[],
): { health: AgentHealthDto[] | undefined; unavailableEngineFailures: number } {
  if (!health || engines.length === 0) {
    return { health, unavailableEngineFailures: 0 };
  }
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const enginesById = new Map(engines.map((engine) => [engine.id, engine]));
  let unavailableEngineFailures = 0;
  const actionable = health.filter((item) => {
    if (item.status !== "failed" && item.status !== "stalled") return true;
    const engine = enginesById.get(agentsById.get(item.agentId)?.activeEngine ?? "");
    if (!engine || engineIsAvailable(engine)) return true;
    unavailableEngineFailures += 1;
    return false;
  });
  return { health: actionable, unavailableEngineFailures };
}

export function projectHealthPresentation(
  health: AgentHealthDto[] | undefined,
  agents: Pick<AgentDto, "id" | "activeEngine">[] = [],
  engines: EngineDto[] = [],
): {
  label: string;
  color: "success.main" | "info.main" | "warning.main" | "error.main" | "text.disabled";
} {
  const actionable = actionableProjectHealth(health, agents, engines).health;
  if (!actionable) return { label: "Checking", color: "text.disabled" };
  if (actionable.some((agent) => agent.status === "failed" || agent.status === "stalled")) return { label: "Needs attention", color: "error.main" };
  if (actionable.some((agent) => agent.status === "blocked" || agent.status === "interrupted")) return { label: "Blocked", color: "warning.main" };
  if (actionable.some((agent) => agent.status === "running" || agent.status === "compacting")) return { label: "Active", color: "info.main" };
  if (actionable.some((agent) => agent.status === "waiting")) return { label: "Waiting", color: "warning.main" };
  return { label: "Healthy", color: "success.main" };
}

export function projectHealthDetail(
  health: AgentHealthDto[] | undefined,
  agents: Pick<AgentDto, "id" | "activeEngine">[] = [],
  engines: EngineDto[] = [],
): string {
  const presentation = projectHealthPresentation(health, agents, engines);
  if (engines.length === 0) return `${presentation.label}. Engine availability is still loading.`;
  const { unavailableEngineFailures } = actionableProjectHealth(health, agents, engines);
  const providerDetail = engineAvailabilityPresentation(engines).detail;
  const deferredDetail = unavailableEngineFailures > 0
    ? ` ${unavailableEngineFailures} ${unavailableEngineFailures === 1 ? "agent failure is" : "agent failures are"} tied to an unavailable engine and ${unavailableEngineFailures === 1 ? "remains" : "remain"} visible in Agent details without blocking this Project.`
    : "";
  return `${presentation.label}. ${providerDetail}${deferredDetail}`;
}

function projectSnapshots(
  projects: ProjectDto[],
  conversations: Array<ConversationDto[] | undefined>,
  agents: Array<Awaited<ReturnType<typeof api.listAgents>> | undefined>,
  health: Array<Awaited<ReturnType<typeof api.getAgentHealth>> | undefined>,
): WorkspaceProjectSnapshot[] {
  return projects.map((project, index) => ({
    project,
    conversations: conversations[index] ?? [],
    agents: agents[index] ?? [],
    health: health[index]?.agents ?? [],
  }));
}

function conversationGroup(updatedAt: string): "Today" | "Yesterday" | "Earlier" {
  const value = new Date(updatedAt);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const timestamp = value.getTime();
  if (timestamp >= start) return "Today";
  if (timestamp >= start - 86_400_000) return "Yesterday";
  return "Earlier";
}

function relativeChatTime(updatedAt: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(updatedAt).getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function orderByStableIds<T>(items: T[], order: readonly string[] | undefined, id: (item: T) => string): T[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((value, index) => [value, index] as const));
  return [...items].sort((a, b) => {
    const left = rank.get(id(a));
    const right = rank.get(id(b));
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
}

export function reorderStableIds(current: readonly string[] | undefined, visibleIds: readonly string[], sourceId: string, targetId: string): string[] {
  const ordered = [...new Set([...(current ?? []).filter((id) => visibleIds.includes(id)), ...visibleIds])];
  const source = ordered.indexOf(sourceId);
  const target = ordered.indexOf(targetId);
  if (source < 0 || target < 0 || source === target) return ordered;
  ordered.splice(source, 1);
  ordered.splice(target, 0, sourceId);
  return ordered;
}

function RailButton({ label, selected = false, badge, badgeColor = "primary", children, onClick }: {
  label: string;
  selected?: boolean;
  badge?: number;
  badgeColor?: "primary" | "info" | "error";
  children: ReactNode;
  onClick(): void;
}): JSX.Element {
  return <Tooltip title={label} placement="right">
    <IconButton
      aria-label={label}
      onClick={onClick}
      sx={{
        width: 48,
        height: 48,
        borderRadius: 1,
        color: selected ? "primary.light" : "text.secondary",
        bgcolor: selected ? "action.selected" : "transparent",
        "&:hover": { bgcolor: selected ? "action.focus" : "action.hover", color: "text.primary" },
      }}
    ><Badge color={badgeColor} badgeContent={badge} max={99}>{children}</Badge></IconButton>
  </Tooltip>;
}

export function WorkspaceSidebar({
  projects,
  engines,
  preferences,
  route,
  notifications,
  drawer = false,
  onNavigate,
  onOpenInNewTab,
  onCreateProject,
  onCreateAgent,
  onCreateTrigger,
  onManageProject,
  onPreferences,
  onRenameConversation,
  onDeleteConversation,
  onSearch,
  onOpenNotifications,
  onOpenSettings,
  onOpenProfile,
  onOpenEngineStatus,
  collapsed = false,
  width = SIDEBAR_RAIL_WIDTH + SIDEBAR_PANEL_WIDTH,
  onCollapsedChange,
  onWidthChange,
}: {
  projects: ProjectDto[];
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  route: Route;
  notifications: WorkspaceNotificationDto[];
  drawer?: boolean;
  onNavigate(route: Route): void;
  onOpenInNewTab?(route: Route): void;
  onCreateProject(): void;
  onCreateAgent?(): void;
  onCreateTrigger?(): void;
  onManageProject(project: ProjectDto): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onSearch?(): void;
  onOpenNotifications?(): void;
  onOpenSettings?(): void;
  onOpenProfile?(): void;
  onOpenEngineStatus?(): void;
  collapsed?: boolean;
  width?: number;
  onCollapsedChange?(collapsed: boolean): void;
  onWidthChange?(width: number): void;
}): JSX.Element {
  const theme = useTheme();
  const appIconSource = theme.palette.mode === "light" ? "/icons/app-icon-inverted.png" : "/icons/app-icon.png";
  const queryClient = useQueryClient();
  const routedProjectId = routeProjectId(route);
  const selectedProjectId = routedProjectId && projects.some((project) => project.id === routedProjectId) ? routedProjectId : undefined;
  const conversationQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["conversations", project.id], queryFn: () => api.listConversations(project.id), staleTime: 10_000 })) });
  const agentQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 4_000 })) });
  const healthQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agent-health", project.id], queryFn: () => api.getAgentHealth(project.id), staleTime: 5_000 })) });
  const snapshots = projectSnapshots(projects, conversationQueries.map((query) => query.data), agentQueries.map((query) => query.data), healthQueries.map((query) => query.data));
  const selected = currentProjectSnapshot(snapshots, selectedProjectId);
  const counts = workspaceCounts(snapshots, notifications);
  const unread = useMemo(() => unreadByConversation(notifications), [notifications]);
  const insideProject = Boolean(selected && ["project", "projectWork", "conversation", "agents", "agent", "review", "browser"].includes(route.kind));
  const [sidebarSection, setSidebarSection] = useState<"home" | "project" | "projects" | "agents" | "triggers" | "wiki" | "settings" | "profile">(() => route.kind === "allAgents" ? "agents" : route.kind === "allTriggers" ? "triggers" : route.kind === "wiki" ? "wiki" : route.kind === "settings" || route.kind === "usage" ? "settings" : route.kind === "profile" ? "profile" : insideProject ? "project" : "home");
  const [filter, setFilter] = useState("");
  const [draggedResource, setDraggedResource] = useState<{ kind: "home" | "chat" | "agent" | "trigger"; id: string }>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; route: Route; conversation?: ConversationDto }>();
  useEffect(() => {
    if (route.kind !== "wiki") return;
    setSidebarSection("wiki");
    setFilter("");
  }, [route.kind]);

  const [sortMenuAnchor, setSortMenuAnchor] = useState<HTMLElement>();
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const showingAgents = sidebarSection === "agents";
  const showingProjects = sidebarSection === "projects";
  const showingProjectNavigation = sidebarSection === "project";
  const showingTriggers = sidebarSection === "triggers";
  const showingHome = sidebarSection === "home";
  const showingWiki = sidebarSection === "wiki";
  const showingSettings = sidebarSection === "settings";
  const showingProfile = sidebarSection === "profile";
  const allTriggersQuery = useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.listAllTriggers(),
    enabled: showingTriggers || showingHome,
    staleTime: 5_000,
  });
  const wikiIndexQuery = useQuery({
    queryKey: ["wiki", "index"],
    queryFn: () => api.getWikiIndex(),
    enabled: showingWiki,
    staleTime: 60_000,
  });
  const showNavigation = (next?: Route) => {
    setSidebarSection("home");
    setFilter("");
    if (next) onNavigate(next);
  };
  const revealSection = (section: typeof sidebarSection) => {
    if (!drawer && section === sidebarSection && !collapsed) { onCollapsedChange?.(true); return; }
    setSidebarSection(section);
    setFilter("");
    if (!drawer && collapsed) onCollapsedChange?.(false);
  };
  const showAgents = () => revealSection("agents");
  const showProjects = () => revealSection("projects");
  const showHome = () => revealSection("home");
  const openAllProjects = () => {
    showProjects();
    onNavigate({ kind: "projects" });
  };
  const showTriggers = () => revealSection("triggers");
  const showWiki = () => revealSection("wiki");
  const openTriggerManager = (projectId: string, agentId: string) => {
    onNavigate({ kind: "agent", projectId, agentId, view: "triggers" });
  };

  const openProject = (snapshot: WorkspaceProjectSnapshot) => {
    setSidebarSection("project");
    onNavigate({ kind: "project", projectId: snapshot.project.id });
  };
  const openChat = (project: ProjectDto, conversation: ConversationDto) => {
    setSidebarSection("project");
    void api.markProjectUsed(project.id, conversation.id);
    void api.clearConversationNotifications(conversation.id);
    onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };
  const createChat = async (project: ProjectDto) => {
    setSidebarSection("project");
    const conversation = await api.createConversation(project.id, { title: "New Project Chat", defaultEngine: project.defaultEngine });
    await api.markProjectUsed(project.id, conversation.id);
    void queryClient.invalidateQueries({ queryKey: ["conversations", project.id] });
    onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };

  const rail = <Box
    component="nav"
    aria-label="Primary navigation"
    sx={{
      width: drawer ? 64 : SIDEBAR_RAIL_WIDTH,
      minWidth: drawer ? 64 : SIDEBAR_RAIL_WIDTH,
      minHeight: 0,
      borderRight: 1,
      borderColor: "divider",
      bgcolor: (theme) => theme.palette.mode === "dark" ? "#17221E" : "#F1EEE5",
      display: "grid",
      gridTemplateRows: "auto minmax(0, 1fr) auto",
      justifyItems: "center",
      py: 1.5,
    }}
  >
    <Stack spacing={.4} sx={{ alignItems: "center" }}>
      <Tooltip title="Ponderosa" placement="right"><Box component="img" src={appIconSource} alt="Ponderosa" sx={{ width: 40, height: 40, mb: 2.5, borderRadius: 1.25, objectFit: "contain" }} /></Tooltip>
      <RailButton label="Home" selected={showingHome} onClick={showHome}><HomeOutlinedIcon /></RailButton>
      <RailButton label="Projects" selected={showingProjects || showingProjectNavigation} onClick={showProjects}><FolderOutlinedIcon /></RailButton>
      <RailButton label="Agents" selected={showingAgents} badge={counts.running || undefined} badgeColor="info" onClick={showAgents}><PersonOutlineIcon /></RailButton>
      <RailButton label="Triggers" selected={showingTriggers} onClick={showTriggers}><BoltOutlinedIcon /></RailButton>
      <RailButton label="Wiki" selected={showingWiki} onClick={showWiki}><MenuBookOutlinedIcon /></RailButton>
    </Stack>
    <Box />
    <Stack spacing={.65} sx={{ alignItems: "center" }}>
      {!drawer && onCollapsedChange ? <RailButton label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => onCollapsedChange(!collapsed)}>{collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}</RailButton> : null}
      <RailButton label="Settings" selected={showingSettings} onClick={() => revealSection("settings")}><SettingsOutlinedIcon /></RailButton>
      <Tooltip title="Operator Profile" placement="right"><IconButton aria-label="Open operator profile navigation" onClick={() => revealSection("profile")} sx={{ width: 46, height: 46, borderRadius: "50%", p: 0, bgcolor: showingProfile ? "action.selected" : "transparent" }}><Box sx={{ position: "relative", width: 42, height: 42 }}><OperatorAvatar profile={preferences.profile} size={42} fallback={operatorInitials(preferences.profile.displayName)} /><Box sx={{ position: "absolute", right: -1, bottom: 1, width: 10, height: 10, borderRadius: "50%", bgcolor: "success.main", border: 2, borderColor: (theme) => theme.palette.mode === "dark" ? "#17221E" : "#F1EEE5" }} /></Box></IconButton></Tooltip>
    </Stack>
  </Box>;

  const projectList = snapshots.filter((snapshot) => !normalizedFilter || `${snapshot.project.label} ${snapshot.project.hostPath}`.toLocaleLowerCase().includes(normalizedFilter));
  const starredProjectIds = new Set(preferences.starredProjectIds);
  const starred = projectList.filter((snapshot) => starredProjectIds.has(snapshot.project.id));
  const remaining = projectList.filter((snapshot) => !starredProjectIds.has(snapshot.project.id));
  const homeAgentDestinations = new Map(snapshots.flatMap((snapshot) => snapshot.agents.map((agent) => [agent.id, { agent, project: snapshot.project }] as const)));
  const homeResources = orderByStableIds([
    ...snapshots.map((snapshot) => ({ id: `project:${snapshot.project.id}`, title: snapshot.project.label, detail: "Project", updatedAt: snapshot.project.lastUsedAt ?? snapshot.project.createdAt, route: { kind: "project", projectId: snapshot.project.id } as Route, icon: <FolderOutlinedIcon fontSize="small" /> })),
    ...snapshots.flatMap((snapshot) => snapshot.conversations.filter((conversation) => !conversation.archived).map((conversation) => ({ id: `conversation:${conversation.id}`, title: conversation.title, detail: `${snapshot.project.label} · Chat`, updatedAt: conversation.updatedAt, route: { kind: "conversation", projectId: snapshot.project.id, conversationId: conversation.id } as Route, icon: <ChatBubbleOutlineIcon fontSize="small" /> }))),
    ...snapshots.flatMap((snapshot) => snapshot.agents.filter((agent) => !agent.archived).map((agent) => ({ id: `agent:${agent.id}`, title: agent.title, detail: `${snapshot.project.label} · Agent`, updatedAt: agent.updatedAt, route: { kind: "agent", projectId: snapshot.project.id, agentId: agent.id } as Route, icon: <SmartToyOutlinedIcon fontSize="small" /> }))),
    ...(allTriggersQuery.data ?? []).flatMap((trigger) => { const destination = homeAgentDestinations.get(trigger.agentId); return destination ? [{ id: `trigger:${trigger.id}`, title: trigger.name, detail: `${destination.project.label} · Trigger`, updatedAt: trigger.updatedAt, route: { kind: "agent", projectId: destination.project.id, agentId: destination.agent.id, view: "triggers" } as Route, icon: <BoltOutlinedIcon fontSize="small" /> }] : []; }),
  ].filter((item) => !normalizedFilter || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(normalizedFilter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 18), preferences.homeOrder, (item) => item.id);
  const sortLabel = preferences.projectSort === "alphabetical" ? "A–Z" : preferences.projectSort === "custom" ? "Custom" : "Recent Activity";
  const toggleStar = (projectId: string) => onPreferences({
    starredProjectIds: starredProjectIds.has(projectId)
      ? preferences.starredProjectIds.filter((id) => id !== projectId)
      : [...preferences.starredProjectIds, projectId],
  });

  const sidebarSurface = (theme: { palette: { mode: "light" | "dark" } }) => theme.palette.mode === "dark" ? "#17221E" : "#F1EEE5";
  const projectsPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", pl: 2.25, pr: drawer ? 7 : 2.25, pt: 2, pb: 1.25 }}><Typography variant="h6" fontWeight={800} sx={{ flex: 1 }}>{showingProjects ? "Projects" : "Home"}</Typography><Typography variant="caption" color="text.secondary">{projects.length} {projects.length === 1 ? "Project" : "Projects"}</Typography></Stack>
    <Box sx={{ px: 1.75, pb: 1.5 }}><TextField
      fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={showingHome ? "Search recent" : "Search projects"}
      inputProps={{ "aria-label": showingHome ? "Search recent" : "Search projects" }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
    /></Box>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      {!showingProjects ? <List disablePadding sx={{ mb: 1.5 }}><ListItemButton aria-label="Open Messages" selected={route.kind === "allChat"} onClick={() => showNavigation({ kind: "allChat" })} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "allChat" } }); }} sx={{ borderRadius: 1, px: 1, minHeight: 48 }}><ListItemIcon sx={{ minWidth: 38 }}><ChatBubbleOutlineIcon fontSize="small" /></ListItemIcon><ListItemText primary="Messages" secondary="Everything sent to or from you" primaryTypographyProps={{ fontWeight: 750 }} secondaryTypographyProps={{ noWrap: true }} /></ListItemButton></List> : null}
      {showingHome ? <Box component="section" sx={{ mb: 2 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>Recent</Typography><List disablePadding sx={{ mt: .5 }}>{homeResources.map((item) => <ListItemButton key={item.id} draggable onDragStart={() => setDraggedResource({ kind: "home", id: item.id })} onDragEnd={() => setDraggedResource(undefined)} onDragOver={(event) => { if (draggedResource?.kind === "home") event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (draggedResource?.kind === "home") onPreferences({ homeOrder: reorderStableIds(preferences.homeOrder, homeResources.map((resource) => resource.id), draggedResource.id, item.id) }); setDraggedResource(undefined); }} onClick={() => onNavigate(item.route)} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: item.route }); }} sx={{ borderRadius: 1.25, px: 1, py: .65, mb: .25 }}><ListItemIcon sx={{ minWidth: 38 }}>{item.icon}</ListItemIcon><ListItemText primary={item.title} secondary={item.detail} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 750 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} /></ListItemButton>)}</List>{homeResources.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>Your recent work will appear here.</Typography> : null}</Box> : null}
      {starred.length ? <Box component="section" sx={{ mb: 2 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>Starred</Typography><List disablePadding sx={{ mt: .5 }}>{starred.map((snapshot) => <Stack key={snapshot.project.id} direction="row" onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "project", projectId: snapshot.project.id } }); }} sx={{ mb: .35, borderRadius: 1, overflow: "hidden", bgcolor: snapshot.project.id === selectedProjectId ? "action.selected" : "transparent", "&:hover": { bgcolor: "action.hover" } }}><ListItemButton aria-label={`Open project ${snapshot.project.label}`} selected={snapshot.project.id === selectedProjectId} onClick={() => openProject(snapshot)} sx={{ minWidth: 0, px: 1 }}><ListItemIcon sx={{ minWidth: 38 }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon><ListItemText primary={snapshot.project.label} secondary={`${snapshot.conversations.filter((item) => !item.archived).length} active chats`} primaryTypographyProps={{ fontWeight: 750, sx: { overflowWrap: "anywhere" } }} secondaryTypographyProps={{ noWrap: true }} /></ListItemButton><Tooltip title={`Unstar ${snapshot.project.label}`}><IconButton size="small" aria-label={`Unstar ${snapshot.project.label}`} onClick={() => toggleStar(snapshot.project.id)} sx={{ color: "primary.light" }}><StarRoundedIcon fontSize="small" /></IconButton></Tooltip></Stack>)}</List></Box> : null}
      <Box component="section"><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>All Projects</Typography><List disablePadding sx={{ mt: .5 }}>{remaining.map((snapshot) => <Stack key={snapshot.project.id} direction="row" onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "project", projectId: snapshot.project.id } }); }} sx={{ alignItems: "center" }}><ListItemButton aria-label={`Open project ${snapshot.project.label}`} onClick={() => openProject(snapshot)} sx={{ borderRadius: 1, px: 1, minHeight: 48, minWidth: 0 }}><ListItemIcon sx={{ minWidth: 38 }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon><ListItemText primary={snapshot.project.label} primaryTypographyProps={{ sx: { overflowWrap: "anywhere" } }} /><Typography variant="caption" color="text.secondary" sx={{ ml: 2, minWidth: 24, textAlign: "right", flexShrink: 0 }}>{snapshot.conversations.filter((item) => !item.archived).length}</Typography></ListItemButton><Tooltip title={`Star ${snapshot.project.label}`}><IconButton size="small" aria-label={`Star ${snapshot.project.label}`} onClick={() => toggleStar(snapshot.project.id)}><StarBorderRoundedIcon fontSize="small" /></IconButton></Tooltip></Stack>)}</List></Box>
      {projectList.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>No projects match “{filter.trim()}”.</Typography> : null}
    </Box>
    <Box sx={{ p: 1.75, boxShadow: (theme) => `inset 0 1px 0 ${theme.palette.divider}` }}><Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={onCreateProject} sx={{ justifyContent: "flex-start", bgcolor: "background.paper" }}>New Project</Button><Button fullWidth color="inherit" startIcon={<FolderOutlinedIcon />} onClick={openAllProjects} sx={{ mt: 0.5, justifyContent: "flex-start", color: "text.secondary" }}>View All Projects</Button><Button fullWidth color="inherit" aria-label="Sort projects" endIcon={<ExpandMoreIcon fontSize="small" />} onClick={(event) => setSortMenuAnchor(event.currentTarget)} sx={{ mt: 0.5, px: .75, justifyContent: "space-between", color: "text.secondary" }}><Typography variant="caption">Sort: <Box component="span" sx={{ color: "text.primary" }}>{sortLabel}</Box></Typography></Button>{sortMenuAnchor ? <Menu anchorEl={sortMenuAnchor} open onClose={() => setSortMenuAnchor(undefined)}><MenuItem selected={preferences.projectSort === "last_used"} onClick={() => { onPreferences({ projectSort: "last_used" }); setSortMenuAnchor(undefined); }}>Recent Activity</MenuItem><MenuItem selected={preferences.projectSort === "alphabetical"} onClick={() => { onPreferences({ projectSort: "alphabetical" }); setSortMenuAnchor(undefined); }}>Alphabetical (A–Z)</MenuItem><MenuItem selected={preferences.projectSort === "custom"} onClick={() => { onPreferences({ projectSort: "custom" }); setSortMenuAnchor(undefined); }}>Custom Order</MenuItem></Menu> : null}</Box>
  </Box>;

  const allAgentRows = workspaceAgents(snapshots);
  const agentRows = orderByStableIds(allAgentRows.filter(({ agent, project }) => !normalizedFilter
    || `${agent.title} ${project.label} ${project.hostPath} ${agent.activeEngine}`.toLocaleLowerCase().includes(normalizedFilter)),
  preferences.agentOrder, (row) => row.agent.id);
  const agentsPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", pl: 2.25, pr: drawer ? 7 : 2.25, pt: 2, pb: 1.25 }}>
      <Typography variant="h6" fontWeight={800} sx={{ flex: 1 }}>Agents</Typography>
      <Typography variant="caption" color="text.secondary">{workspaceAgents(snapshots).length} total</Typography>
    </Stack>
    <Box sx={{ px: 1.75, pb: 1 }}><TextField
      fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search agents"
      inputProps={{ "aria-label": "Search agents" }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
    /></Box>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      <List disablePadding aria-label="Agents across projects">{agentRows.map(({ agent, project: agentProject, status }) => <ListItemButton
        key={agent.id}
        draggable
        onDragStart={() => setDraggedResource({ kind: "agent", id: agent.id })}
        onDragEnd={() => setDraggedResource(undefined)}
        onDragOver={(event) => { if (draggedResource?.kind === "agent") event.preventDefault(); }}
        onDrop={(event) => {
          event.preventDefault();
          if (draggedResource?.kind === "agent") onPreferences({ agentOrder: reorderStableIds(preferences.agentOrder, allAgentRows.map((row) => row.agent.id), draggedResource.id, agent.id) });
          setDraggedResource(undefined);
        }}
        aria-label={`Open agent ${agent.title} in ${projectDisambiguator(agentProject, projects)}`}
        selected={route.kind === "agent" && route.agentId === agent.id}
        onClick={() => onNavigate({ kind: "agent", projectId: agentProject.id, agentId: agent.id })}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "agent", projectId: agentProject.id, agentId: agent.id } }); }}
        sx={{ borderRadius: 1.25, px: 1, py: .75, mb: .35, minWidth: 0 }}
      >
        <ListItemIcon sx={{ minWidth: 38 }}><Box sx={{ width: 30, height: 30, borderRadius: "50%", bgcolor: "action.hover", display: "grid", placeItems: "center" }}><SmartToyOutlinedIcon sx={{ fontSize: 17 }} /></Box></ListItemIcon>
        <ListItemText
          primary={agent.title}
          secondary={`${projectDisambiguator(agentProject, projects)} · ${agent.activeEngine}`}
          primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 750 }}
          secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
        />
        <Box title={agentStatusLabel(status)} aria-label={agentStatusLabel(status)} sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: agentStatusColor(status) === "default" ? "text.disabled" : `${agentStatusColor(status)}.main`, flex: "0 0 auto" }} />
      </ListItemButton>)}</List>
      {agentRows.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>{filter.trim() ? `No agents match “${filter.trim()}”.` : "No active agents."}</Typography> : null}
    </Box>
    <Box sx={{ p: 1.75, boxShadow: (theme) => `inset 0 1px 0 ${theme.palette.divider}` }}><Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={() => onCreateAgent?.()} sx={{ justifyContent: "flex-start", bgcolor: "background.paper" }}>New Agent</Button><Button fullWidth color="inherit" startIcon={<GroupsOutlinedIcon />} onClick={() => onNavigate({ kind: "allAgents" })} sx={{ mt: .5, justifyContent: "flex-start", color: "text.secondary" }}>View All Agents</Button><Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 1, pt: 1 }}>Drag Agents to set a custom order.</Typography></Box>
  </Box>;

  const triggerDestinations = workspaceAgents(snapshots);
  const triggerAgentById = new Map(triggerDestinations.map((destination) => [destination.agent.id, destination] as const));
  const filteredTriggers = orderByStableIds((allTriggersQuery.data ?? []).filter((trigger) => {
    const destination = triggerAgentById.get(trigger.agentId);
    return !normalizedFilter || [
      trigger.name,
      trigger.instructions,
      trigger.sourceKind,
      destination?.agent.title,
      destination?.project.label,
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedFilter);
  }), preferences.triggerOrder, (trigger) => trigger.id);
  const triggerManagers = triggerDestinations.filter(({ agent, project: triggerProject }) => !normalizedFilter
    || `${agent.title} ${triggerProject.label} ${agent.activeEngine}`.toLocaleLowerCase().includes(normalizedFilter));
  const triggersPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", pl: 2.25, pr: drawer ? 7 : 2.25, pt: 2, pb: 1.25 }}>
      <Box sx={{ width: 32, height: 32, borderRadius: "50%", bgcolor: "action.hover", display: "grid", placeItems: "center", mr: 1 }}><BoltOutlinedIcon fontSize="small" /></Box>
      <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="h6" fontWeight={800}>Triggers</Typography><Typography variant="caption" color="text.secondary">Automations across every project</Typography></Box>
      <Typography variant="caption" color="text.secondary">{allTriggersQuery.data?.length ?? 0}</Typography>
    </Stack>
    <Box sx={{ px: 1.75, pb: 1.25 }}><TextField
      fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search triggers or agents"
      inputProps={{ "aria-label": "Search triggers" }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
    /></Box>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25, pb: 2 }}>
      {allTriggersQuery.isLoading ? <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>Loading triggers…</Typography> : null}
      {allTriggersQuery.isError ? <Typography variant="body2" color="error" sx={{ p: 1 }}>Triggers could not be loaded.</Typography> : null}
      <Box component="section" sx={{ mb: 2 }}>
        <Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>Configured triggers</Typography>
        <List disablePadding sx={{ mt: .5 }}>{filteredTriggers.map((trigger) => {
          const destination = triggerAgentById.get(trigger.agentId);
          if (!destination) return null;
          return <ListItemButton
            key={trigger.id}
            draggable
            onDragStart={() => setDraggedResource({ kind: "trigger", id: trigger.id })}
            onDragEnd={() => setDraggedResource(undefined)}
            onDragOver={(event) => { if (draggedResource?.kind === "trigger") event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedResource?.kind === "trigger") onPreferences({ triggerOrder: reorderStableIds(preferences.triggerOrder, (allTriggersQuery.data ?? []).map((item) => item.id), draggedResource.id, trigger.id) });
              setDraggedResource(undefined);
            }}
            aria-label={`Manage trigger ${trigger.name}`}
            onClick={() => openTriggerManager(destination.project.id, destination.agent.id)}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "agent", projectId: destination.project.id, agentId: destination.agent.id, view: "triggers" } }); }}
            sx={{ borderRadius: 1.25, px: 1, py: .75, mb: .35, minWidth: 0 }}
          >
            <ListItemIcon sx={{ minWidth: 38 }}><BoltOutlinedIcon sx={{ fontSize: 18 }} /></ListItemIcon>
            <ListItemText primary={trigger.name} secondary={`${destination.project.label} · ${destination.agent.title} · ${trigger.sourceKind}`} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 750 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
            <Box title={trigger.enabled ? "Enabled" : "Disabled"} sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: trigger.enabled ? "success.main" : "text.disabled" }} />
          </ListItemButton>;
        })}</List>
        {!allTriggersQuery.isLoading && filteredTriggers.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1 }}>{filter.trim() ? "No configured triggers match." : "No triggers configured yet."}</Typography> : null}
      </Box>
      <Box component="section">
        <Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>Create or edit by agent</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 1, mb: .5 }}>Choose an agent to open its Trigger manager.</Typography>
        <List disablePadding>{triggerManagers.map(({ agent, project: triggerProject }) => <ListItemButton
          key={agent.id}
          aria-label={`Open triggers for ${agent.title}`}
          onClick={() => openTriggerManager(triggerProject.id, agent.id)}
          onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "agent", projectId: triggerProject.id, agentId: agent.id, view: "triggers" } }); }}
          sx={{ borderRadius: 1.25, px: 1, py: .65, mb: .25, minWidth: 0 }}
        >
          <ListItemIcon sx={{ minWidth: 38 }}><SmartToyOutlinedIcon sx={{ fontSize: 17 }} /></ListItemIcon>
          <ListItemText primary={agent.title} secondary={triggerProject.label} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 700 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
        </ListItemButton>)}</List>
      </Box>
    </Box>
    <Box sx={{ p: 1.75, boxShadow: (theme) => `inset 0 1px 0 ${theme.palette.divider}` }}><Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={() => onCreateTrigger?.()} sx={{ justifyContent: "flex-start", bgcolor: "background.paper" }}>New Trigger</Button><Button fullWidth color="inherit" startIcon={<BoltOutlinedIcon />} onClick={() => onNavigate({ kind: "allTriggers" })} sx={{ mt: .5, justifyContent: "flex-start", color: "text.secondary" }}>View All Triggers</Button><Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 1, pt: 1 }}>Drag Triggers to set a custom order.</Typography></Box>
  </Box>;

  const wikiSections = (wikiIndexQuery.data?.sections ?? []).map((section) => ({
    ...section,
    articles: section.articles.filter((article) => !normalizedFilter || `${article.title} ${article.summary}`.toLocaleLowerCase().includes(normalizedFilter)),
  })).filter((section) => section.articles.length > 0);
  const activeWikiArticleId = route.kind === "wiki" ? route.articleId ?? wikiIndexQuery.data?.sections[0]?.articles[0]?.id : undefined;
  const wikiArticleCount = wikiIndexQuery.data?.sections.reduce((total, section) => total + section.articles.length, 0) ?? 0;
  const wikiPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", pl: 2.25, pr: drawer ? 7 : 2.25, pt: 2, pb: 1.25 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flex: 1, minWidth: 0 }}><MenuBookOutlinedIcon color="primary" /><Box sx={{ minWidth: 0 }}><Typography variant="h6" fontWeight={800}>Wiki</Typography><Typography variant="caption" color="text.secondary">Ponderosa guide</Typography></Box></Stack>
      <Typography variant="caption" color="text.secondary">{wikiArticleCount}</Typography>
    </Stack>
    <Box sx={{ px: 1.75, pb: 1.5 }}><TextField
      fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search Wiki"
      inputProps={{ "aria-label": "Search Wiki" }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
    /></Box>
    <Box component="nav" aria-label="Wiki navigation" data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25, pb: 2 }}>
      {wikiIndexQuery.isLoading ? <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>Loading Wiki…</Typography> : null}
      {wikiIndexQuery.isError ? <Typography variant="body2" color="error" sx={{ p: 1 }}>Wiki navigation could not be loaded.</Typography> : null}
      {wikiSections.map((section) => <Box component="section" key={section.id} sx={{ mb: 2 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>{section.title}</Typography><List dense disablePadding>{section.articles.map((article) => <ListItemButton key={article.id} selected={article.id === activeWikiArticleId} onClick={() => { setFilter(""); onNavigate({ kind: "wiki", articleId: article.id }); }} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "wiki", articleId: article.id } }); }} sx={{ borderRadius: 1.25, mb: .25 }}><ListItemText primary={article.title} primaryTypographyProps={{ fontSize: 13, fontWeight: article.id === activeWikiArticleId ? 800 : 600 }} /></ListItemButton>)}</List></Box>)}
      {!wikiIndexQuery.isLoading && wikiSections.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>{filter.trim() ? `No Wiki articles match “${filter.trim()}”.` : "No Wiki articles are available."}</Typography> : null}
    </Box>
  </Box>;

  const project = selected;
  const selectedProjectIndex = project ? projects.findIndex((candidate) => candidate.id === project.project.id) : -1;
  const selectedHealth = selectedProjectIndex >= 0 ? healthQueries[selectedProjectIndex]?.data?.agents : undefined;
  const projectHealth = projectHealthPresentation(selectedHealth, project?.agents ?? [], engines);
  const projectHealthTooltip = projectHealthDetail(selectedHealth, project?.agents ?? [], engines);
  const activeConversations = orderByStableIds((project?.conversations ?? []).filter((conversation) => !conversation.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), preferences.chatOrder, (conversation) => conversation.id);
  const filteredConversations = activeConversations.filter((conversation) => !normalizedFilter || conversationDisplayTitle(conversation, activeConversations).toLocaleLowerCase().includes(normalizedFilter));
  const grouped = (["Today", "Yesterday", "Earlier"] as const).map((group) => ({ group, conversations: filteredConversations.filter((conversation) => conversationGroup(conversation.updatedAt) === group) }));

  const chatsPanel = project ? <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto auto minmax(0, 1fr) auto", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", pl: 1.25, pr: drawer ? 7 : 1.25, pt: 1.25 }}><Button size="small" color="inherit" startIcon={<ArrowBackIcon />} onClick={showProjects} sx={{ color: "text.secondary", justifyContent: "flex-start" }}>Projects</Button><IconButton aria-label={`Project settings for ${project.project.label}`} onClick={() => onManageProject(project.project)} sx={{ ml: "auto" }}><MoreHorizIcon /></IconButton></Stack>
    <Stack spacing={.4} sx={{ alignItems: "flex-start", px: 2, py: 1, minWidth: 0 }}><Typography variant="h6" fontWeight={800} sx={{ minWidth: 0, overflowWrap: "anywhere", lineHeight: 1.25 }}>{project.project.label}</Typography><Tooltip title={`${projectHealthTooltip} Click for AI provider details.`} arrow><Stack direction="row" spacing={.75} role="button" tabIndex={0} aria-label={`${projectHealth.label}. ${projectHealthTooltip} Open AI provider details.`} onClick={() => onOpenEngineStatus?.()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenEngineStatus?.(); } }} sx={{ alignItems: "center", cursor: "pointer" }}><Typography variant="caption" sx={{ color: projectHealth.color }}>{projectHealth.label}</Typography><Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: projectHealth.color }} /></Stack></Tooltip></Stack>
    <Stack spacing={1.25} sx={{ px: 1.75, pb: 1.5 }}><TextField fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search Project Chats" inputProps={{ "aria-label": "Search Project Chats" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }} /></Stack>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      {grouped.map(({ group, conversations }) => conversations.length ? <Box key={group} component="section" sx={{ mb: 1.75 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>{group}</Typography><List disablePadding>{conversations.map((conversation) => {
        const title = conversationDisplayTitle(conversation, activeConversations);
        return <Stack key={conversation.id} direction="row" draggable
          onDragStart={() => setDraggedResource({ kind: "chat", id: conversation.id })}
          onDragEnd={() => setDraggedResource(undefined)}
          onDragOver={(event) => { if (draggedResource?.kind === "chat") event.preventDefault(); }}
          onDrop={(event) => {
            event.preventDefault();
            if (draggedResource?.kind === "chat") onPreferences({ chatOrder: reorderStableIds(preferences.chatOrder, activeConversations.map((item) => item.id), draggedResource.id, conversation.id) });
            setDraggedResource(undefined);
          }}
          onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, conversation, route: { kind: "conversation", projectId: project.project.id, conversationId: conversation.id } }); }} sx={{ alignItems: "center" }}><ListItemButton selected={route.kind === "conversation" && route.conversationId === conversation.id} onClick={() => openChat(project.project, conversation)} sx={{ borderRadius: 1, px: 1, minWidth: 0 }}><ListItemIcon sx={{ minWidth: 38 }}><Box sx={{ width: 30, height: 30, borderRadius: "50%", bgcolor: "action.hover", display: "grid", placeItems: "center" }}><ChatBubbleOutlineIcon sx={{ fontSize: 16 }} /></Box></ListItemIcon><ListItemText primary={title} secondary={`${unread.get(conversation.id) ? `${unread.get(conversation.id)} unread · ` : ""}${relativeChatTime(conversation.updatedAt)}`} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 700 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />{unread.get(conversation.id) ? <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.light" }} /> : null}</ListItemButton></Stack>;
      })}</List></Box> : null)}
      {filteredConversations.length === 0 ? filter.trim() ? <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>No Project Chats match “{filter.trim()}”.</Typography> : <Stack spacing={.75} sx={{ p: 2, textAlign: "center", alignItems: "center" }}><Typography variant="subtitle2" fontWeight={750}>No Project Chats Yet</Typography><Typography variant="body2" color="text.secondary">Project Chats are shared spaces where you and your Agents prompt, plan, and coordinate work. Create one to get started.</Typography></Stack> : null}
    </Box>
    <Box sx={{ boxShadow: (theme) => `inset 0 1px 0 ${theme.palette.divider}`, p: 1.5 }}>
      <Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={() => void createChat(project.project)} sx={{ mb: .75, justifyContent: "flex-start", bgcolor: "background.paper" }}>New Project Chat</Button>
      <Button fullWidth color="inherit" aria-label="View all Project Chats" onClick={() => onNavigate({ kind: "allChats", filterProjectId: project.project.id })} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "allChats", filterProjectId: project.project.id } }); }} startIcon={<ChatBubbleOutlineIcon />} sx={{ justifyContent: "flex-start", color: "text.secondary" }}>View All Chats</Button>
      <Button fullWidth color="inherit" aria-label="Open project agents" aria-current={route.kind === "allAgents" && route.filterProjectId === project.project.id ? "page" : undefined} onClick={() => onNavigate({ kind: "allAgents", filterProjectId: project.project.id })} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "allAgents", filterProjectId: project.project.id } }); }} startIcon={<GroupsOutlinedIcon />} sx={{ justifyContent: "flex-start", color: route.kind === "allAgents" && route.filterProjectId === project.project.id ? "text.primary" : "text.secondary", bgcolor: route.kind === "allAgents" && route.filterProjectId === project.project.id ? "action.selected" : "transparent" }}>Project Agents</Button>
      <Button fullWidth color="inherit" aria-label="Open Shared Browser" aria-current={route.kind === "browser" ? "page" : undefined} onClick={() => onNavigate({ kind: "browser", projectId: project.project.id })} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "browser", projectId: project.project.id } }); }} startIcon={<LanguageIcon />} sx={{ justifyContent: "flex-start", color: route.kind === "browser" ? "text.primary" : "text.secondary", bgcolor: route.kind === "browser" ? "action.selected" : "transparent" }}>Shared Browser</Button>
      <Button fullWidth color="inherit" aria-label="Open project overview" aria-current={route.kind === "project" ? "page" : undefined} onClick={() => onNavigate({ kind: "project", projectId: project.project.id })} onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, route: { kind: "project", projectId: project.project.id } }); }} startIcon={<FolderOutlinedIcon />} sx={{ justifyContent: "flex-start", color: route.kind === "project" ? "text.primary" : "text.secondary", bgcolor: route.kind === "project" ? "action.selected" : "transparent" }}>Project Overview</Button>
    </Box>
  </Box> : null;

  const settingsPanel = <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", bgcolor: sidebarSurface }}><Stack direction="row" sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}><SettingsOutlinedIcon sx={{ mr: 1 }} /><Typography variant="h6" fontWeight={800}>Settings</Typography></Stack><List sx={{ px: 1.25 }}><ListItemButton selected={route.kind === "settings" && (route.section ?? "general") === "general"} onClick={() => onNavigate({ kind: "settings", section: "general" })} sx={{ borderRadius: 1.25 }}><ListItemIcon><SettingsOutlinedIcon /></ListItemIcon><ListItemText primary="General" secondary="Appearance and Agent defaults" /></ListItemButton><ListItemButton selected={route.kind === "settings" && route.section === "providers"} onClick={() => onNavigate({ kind: "settings", section: "providers" })} sx={{ borderRadius: 1.25 }}><ListItemIcon><SmartToyOutlinedIcon /></ListItemIcon><ListItemText primary="AI Providers" secondary="Availability, models, and reasoning" /></ListItemButton><ListItemButton selected={route.kind === "settings" && route.section === "notifications"} onClick={() => onNavigate({ kind: "settings", section: "notifications" })} sx={{ borderRadius: 1.25 }}><ListItemIcon><NotificationsNoneOutlinedIcon /></ListItemIcon><ListItemText primary="Notifications" secondary="In-app and browser attention" /></ListItemButton><ListItemButton selected={route.kind === "usage"} onClick={() => onNavigate({ kind: "usage" })} sx={{ borderRadius: 1.25 }}><ListItemIcon><DataUsageOutlinedIcon /></ListItemIcon><ListItemText primary="Provider Activity" secondary="Run telemetry and estimates" /></ListItemButton></List></Box>;
  const profilePanel = <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", bgcolor: sidebarSurface }}><Stack direction="row" spacing={1.25} sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}><OperatorAvatar profile={preferences.profile} size={42} /><Box sx={{ minWidth: 0 }}><Typography variant="h6" fontWeight={800} noWrap>{preferences.profile.displayName}</Typography><Typography variant="caption" color="text.secondary">#{preferences.profile.handle}</Typography></Box></Stack><List sx={{ px: 1.25 }}><ListItemButton selected={route.kind === "profile"} onClick={() => onNavigate({ kind: "profile" })} sx={{ borderRadius: 1.25 }}><ListItemIcon><PersonOutlineIcon /></ListItemIcon><ListItemText primary="Edit Operator Profile" secondary="Name, handle, and picture" /></ListItemButton><ListItemButton onClick={() => revealSection("settings")} sx={{ borderRadius: 1.25 }}><ListItemIcon><SettingsOutlinedIcon /></ListItemIcon><ListItemText primary="Workspace Settings" /></ListItemButton></List></Box>;
  const panel = showingAgents ? agentsPanel : showingTriggers ? triggersPanel : showingWiki ? wikiPanel : showingSettings ? settingsPanel : showingProfile ? profilePanel : showingProjects ? projectsPanel : showingProjectNavigation && insideProject ? chatsPanel : projectsPanel;
  const [resizing, setResizing] = useState(false);
  const resizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);
    const move = (next: PointerEvent) => onWidthChange(clampWorkspaceSidebarWidth(startWidth + next.clientX - startX));
    const stop = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return <Box component="aside" aria-label="Workspace navigation" data-sidebar-state={collapsed ? "collapsed" : "expanded"} data-sidebar-resizing={resizing ? "true" : "false"} sx={{ position: "relative", width: drawer ? "min(100vw, 390px)" : collapsed ? SIDEBAR_RAIL_WIDTH : width, maxWidth: "100vw", height: "100%", minHeight: 0, minWidth: 0, borderRight: 1, borderColor: "divider", display: "grid", gridTemplateColumns: collapsed && !drawer ? `${SIDEBAR_RAIL_WIDTH}px` : `${drawer ? 64 : SIDEBAR_RAIL_WIDTH}px minmax(0, 1fr)`, bgcolor: sidebarSurface, overflow: "hidden", transition: !drawer && !resizing ? "width 180ms cubic-bezier(0.2, 0, 0, 1), grid-template-columns 180ms cubic-bezier(0.2, 0, 0, 1)" : "none", "@media (prefers-reduced-motion: reduce)": { transition: "none" } }}>
    {rail}
    {collapsed && !drawer ? null : panel}
    {!drawer && !collapsed && onWidthChange ? <Box
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={resizeStart}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onWidthChange(clampWorkspaceSidebarWidth(width + (event.key === "ArrowRight" ? 16 : -16)));
      }}
      sx={{ position: "absolute", zIndex: 2, insetBlock: 0, right: 0, width: 12, cursor: "col-resize", touchAction: "none", "&::after": { content: '""', position: "absolute", insetBlock: 0, left: 5, width: 2, bgcolor: "transparent" }, "&:hover::after, &:focus-visible::after": { bgcolor: "primary.main" } }}
    /> : null}
    {menu ? <Menu anchorEl={menu.anchor} open onClose={() => setMenu(undefined)}>
      <MenuItem disabled={!onOpenInNewTab} onClick={() => {
        onOpenInNewTab?.(menu.route);
        setMenu(undefined);
      }}>Open in New Ponderosa Tab</MenuItem>
      {menu.conversation ? <MenuItem onClick={() => { onRenameConversation(menu.conversation!); setMenu(undefined); }}>Rename</MenuItem> : null}
      {menu.conversation ? <MenuItem sx={{ color: "error.main" }} onClick={() => { onDeleteConversation(menu.conversation!); setMenu(undefined); }}>Delete</MenuItem> : null}
    </Menu> : null}
  </Box>;
}
