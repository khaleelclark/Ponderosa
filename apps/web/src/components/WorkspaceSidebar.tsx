import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
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
} from "@mui/material";
import type { ConversationDto, ProjectDto, WorkspaceNotificationDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { agentStatusColor, agentStatusLabel } from "../agents";
import { api } from "../api";
import { chatStateKey, writeChatState } from "../chatState";
import { conversationDisplayTitle } from "../conversationLabels";
import { routeProjectId, type Route } from "../routing";
import { currentProjectSnapshot, projectDisambiguator, unreadByConversation, workspaceAgents, workspaceCounts, type WorkspaceProjectSnapshot } from "../workspaceNavigation";

export const SIDEBAR_MIN_WIDTH = 320;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_RAIL_WIDTH = 72;
export const SIDEBAR_PANEL_WIDTH = 318;

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
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

function RailButton({ label, selected = false, badge, children, onClick }: {
  label: string;
  selected?: boolean;
  badge?: number;
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
    ><Badge color="primary" badgeContent={badge} max={99}>{children}</Badge></IconButton>
  </Tooltip>;
}

export function WorkspaceSidebar({
  projects,
  preferences,
  route,
  notifications,
  drawer = false,
  onNavigate,
  onCreateProject,
  onManageProject,
  onPreferences,
  onRenameConversation,
  onDeleteConversation,
  onSearch,
  onOpenNotifications,
  onOpenSettings,
}: {
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  route: Route;
  notifications: WorkspaceNotificationDto[];
  drawer?: boolean;
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onManageProject(project: ProjectDto): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onSearch?(): void;
  onOpenNotifications?(): void;
  onOpenSettings?(): void;
}): JSX.Element {
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
  const insideProject = Boolean(selected && ["project", "conversation", "agents", "agent"].includes(route.kind));
  const [sidebarSection, setSidebarSection] = useState<"navigation" | "projects" | "agents" | "triggers">(() => route.kind === "allAgents" ? "agents" : "navigation");
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; conversation: ConversationDto }>();
  const [sortMenuAnchor, setSortMenuAnchor] = useState<HTMLElement>();
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const showingAgents = sidebarSection === "agents";
  const showingProjects = sidebarSection === "projects";
  const showingTriggers = sidebarSection === "triggers";
  const allTriggersQuery = useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.listAllTriggers(),
    enabled: showingTriggers,
    staleTime: 5_000,
  });
  const showNavigation = (next?: Route) => {
    setSidebarSection("navigation");
    setFilter("");
    if (next) onNavigate(next);
  };
  const showAgents = () => {
    setSidebarSection("agents");
    setFilter("");
  };
  const showProjects = () => {
    setSidebarSection("projects");
    setFilter("");
  };
  const showTriggers = () => {
    setSidebarSection("triggers");
    setFilter("");
  };
  const openTriggerManager = (projectId: string, agentId: string) => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), "triggers");
    onNavigate({ kind: "agent", projectId, agentId });
  };

  const openProject = (snapshot: WorkspaceProjectSnapshot) => {
    setSidebarSection("navigation");
    const conversations = snapshot.conversations.filter((conversation) => !conversation.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const target = conversations.find((conversation) => conversation.id === snapshot.project.lastConversationId) ?? conversations[0];
    onNavigate(target
      ? { kind: "conversation", projectId: snapshot.project.id, conversationId: target.id }
      : { kind: "agents", projectId: snapshot.project.id });
  };
  const openChat = (project: ProjectDto, conversation: ConversationDto) => {
    setSidebarSection("navigation");
    void api.markProjectUsed(project.id, conversation.id);
    void api.clearConversationNotifications(conversation.id);
    onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };
  const createChat = async (project: ProjectDto) => {
    setSidebarSection("navigation");
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
      <Tooltip title="Ponderosa" placement="right"><Box component="img" src="/icons/app-icon.png" alt="Ponderosa" sx={{ width: 40, height: 40, mb: 1.25, borderRadius: 1.25 }} /></Tooltip>
      <RailButton label="Home" selected={!showingAgents && !showingTriggers && route.kind === "home"} onClick={() => showNavigation({ kind: "home" })}><HomeOutlinedIcon /></RailButton>
      <RailButton label="Projects" selected={!showingAgents && !showingTriggers && (showingProjects || route.kind === "projects" || insideProject)} onClick={showProjects}><FolderOutlinedIcon /></RailButton>
      <RailButton label="Agents" selected={showingAgents} badge={counts.running || undefined} onClick={showAgents}><PersonOutlineIcon /></RailButton>
      <RailButton label="Triggers" selected={showingTriggers} onClick={showTriggers}><BoltOutlinedIcon /></RailButton>
      <RailButton label="Inbox" badge={counts.unread || undefined} onClick={() => onOpenNotifications?.()}><InboxOutlinedIcon /></RailButton>
    </Stack>
    <Box />
    <Stack spacing={.65} sx={{ alignItems: "center" }}>
      <RailButton label="Settings" onClick={() => onOpenSettings?.()}><SettingsOutlinedIcon /></RailButton>
      <Tooltip title="Operator profile" placement="right"><Box sx={{ position: "relative", width: 42, height: 42, borderRadius: "50%", bgcolor: "background.paper", display: "grid", placeItems: "center", fontSize: 13, boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}` }}>KC<Box sx={{ position: "absolute", right: -1, bottom: 1, width: 10, height: 10, borderRadius: "50%", bgcolor: "success.main", border: 2, borderColor: (theme) => theme.palette.mode === "dark" ? "#17221E" : "#F1EEE5" }} /></Box></Tooltip>
    </Stack>
  </Box>;

  const projectList = snapshots.filter((snapshot) => !normalizedFilter || `${snapshot.project.label} ${snapshot.project.hostPath}`.toLocaleLowerCase().includes(normalizedFilter));
  const starredProjectIds = new Set(preferences.starredProjectIds);
  const starred = projectList.filter((snapshot) => starredProjectIds.has(snapshot.project.id));
  const remaining = projectList.filter((snapshot) => !starredProjectIds.has(snapshot.project.id));
  const sortLabel = preferences.projectSort === "alphabetical" ? "A–Z" : preferences.projectSort === "custom" ? "Custom" : "Recent activity";
  const toggleStar = (projectId: string) => onPreferences({
    starredProjectIds: starredProjectIds.has(projectId)
      ? preferences.starredProjectIds.filter((id) => id !== projectId)
      : [...preferences.starredProjectIds, projectId],
  });

  const sidebarSurface = (theme: { palette: { mode: "light" | "dark" } }) => theme.palette.mode === "dark" ? "#17221E" : "#F1EEE5";
  const projectsPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}><Typography variant="h6" fontWeight={800} sx={{ flex: 1 }}>Projects</Typography><Typography variant="caption" color="text.secondary">{projects.length} total</Typography></Stack>
    <Box sx={{ px: 1.75, pb: 1.5 }}><TextField
      fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search projects"
      inputProps={{ "aria-label": "Search projects" }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, endAdornment: <Box component="kbd" sx={{ px: .75, py: .35, borderRadius: .75, bgcolor: "action.hover", color: "text.secondary", fontSize: 10 }}>⌘K</Box> }}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") onSearch?.(); }}
    /></Box>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      {starred.length ? <Box component="section" sx={{ mb: 2 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>Starred</Typography><List disablePadding sx={{ mt: .5 }}>{starred.map((snapshot) => <Stack key={snapshot.project.id} direction="row" sx={{ mb: .35, borderRadius: 1, overflow: "hidden", bgcolor: snapshot.project.id === selectedProjectId ? "action.selected" : "transparent", "&:hover": { bgcolor: "action.hover" } }}><ListItemButton aria-label={`Open project ${snapshot.project.label}`} selected={snapshot.project.id === selectedProjectId} onClick={() => openProject(snapshot)} sx={{ minWidth: 0, px: 1 }}><ListItemIcon sx={{ minWidth: 38 }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon><ListItemText primary={snapshot.project.label} secondary={`${snapshot.conversations.filter((item) => !item.archived).length} active chats`} primaryTypographyProps={{ fontWeight: 750, noWrap: true }} secondaryTypographyProps={{ noWrap: true }} /></ListItemButton><Tooltip title={`Unstar ${snapshot.project.label}`}><IconButton size="small" aria-label={`Unstar ${snapshot.project.label}`} onClick={() => toggleStar(snapshot.project.id)} sx={{ color: "primary.light" }}><StarRoundedIcon fontSize="small" /></IconButton></Tooltip></Stack>)}</List></Box> : null}
      <Box component="section"><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>All projects</Typography><List disablePadding sx={{ mt: .5 }}>{remaining.map((snapshot) => <Stack key={snapshot.project.id} direction="row" sx={{ alignItems: "center" }}><ListItemButton aria-label={`Open project ${snapshot.project.label}`} onClick={() => openProject(snapshot)} sx={{ borderRadius: 1, px: 1, minHeight: 48, minWidth: 0 }}><ListItemIcon sx={{ minWidth: 38 }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon><ListItemText primary={snapshot.project.label} primaryTypographyProps={{ noWrap: true }} /><Typography variant="caption" color="text.secondary">{snapshot.conversations.filter((item) => !item.archived).length}</Typography></ListItemButton><Tooltip title={`Star ${snapshot.project.label}`}><IconButton size="small" aria-label={`Star ${snapshot.project.label}`} onClick={() => toggleStar(snapshot.project.id)}><StarBorderRoundedIcon fontSize="small" /></IconButton></Tooltip></Stack>)}</List></Box>
      {projectList.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>No projects match “{filter.trim()}”.</Typography> : null}
    </Box>
    <Box sx={{ p: 1.75, boxShadow: (theme) => `inset 0 1px 0 ${theme.palette.divider}` }}><Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={onCreateProject} sx={{ justifyContent: "flex-start", bgcolor: "background.paper" }}>New project</Button><Button fullWidth color="inherit" aria-label="Sort projects" endIcon={<ExpandMoreIcon fontSize="small" />} onClick={(event) => setSortMenuAnchor(event.currentTarget)} sx={{ mt: 1, px: .75, justifyContent: "space-between", color: "text.secondary" }}><Typography variant="caption">Sort: <Box component="span" sx={{ color: "text.primary" }}>{sortLabel}</Box></Typography></Button>{sortMenuAnchor ? <Menu anchorEl={sortMenuAnchor} open onClose={() => setSortMenuAnchor(undefined)}><MenuItem selected={preferences.projectSort === "last_used"} onClick={() => { onPreferences({ projectSort: "last_used" }); setSortMenuAnchor(undefined); }}>Recent activity</MenuItem><MenuItem selected={preferences.projectSort === "alphabetical"} onClick={() => { onPreferences({ projectSort: "alphabetical" }); setSortMenuAnchor(undefined); }}>Alphabetical (A–Z)</MenuItem><MenuItem selected={preferences.projectSort === "custom"} onClick={() => { onPreferences({ projectSort: "custom" }); setSortMenuAnchor(undefined); }}>Custom order</MenuItem></Menu> : null}</Box>
  </Box>;

  const agentRows = workspaceAgents(snapshots).filter(({ agent, project }) => !normalizedFilter
    || `${agent.title} ${project.label} ${project.hostPath} ${agent.activeEngine}`.toLocaleLowerCase().includes(normalizedFilter));
  const agentsPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto auto minmax(0, 1fr) auto", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}>
      <Typography variant="h6" fontWeight={800} sx={{ flex: 1 }}>Agents</Typography>
      <Typography variant="caption" color="text.secondary">{workspaceAgents(snapshots).length} total</Typography>
    </Stack>
    <Box sx={{ px: 1.75, pb: 1 }}><TextField
      fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search agents"
      inputProps={{ "aria-label": "Search agents" }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, endAdornment: <Box component="kbd" sx={{ px: .75, py: .35, borderRadius: .75, bgcolor: "action.hover", color: "text.secondary", fontSize: 10 }}>⌘K</Box> }}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") onSearch?.(); }}
    /></Box>
    <Stack direction="row" spacing={1} sx={{ px: 2, pb: 1.25, color: "text.secondary", alignItems: "center" }}>
      <Typography variant="caption">Across {projects.length} projects</Typography>
      {counts.running ? <Chip size="small" color="success" variant="outlined" label={`${counts.running} running`} /> : null}
    </Stack>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      <List disablePadding aria-label="Agents across projects">{agentRows.map(({ agent, project: agentProject, status }) => <ListItemButton
        key={agent.id}
        aria-label={`Open agent ${agent.title} in ${projectDisambiguator(agentProject, projects)}`}
        selected={route.kind === "agent" && route.agentId === agent.id}
        onClick={() => onNavigate({ kind: "agent", projectId: agentProject.id, agentId: agent.id })}
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
    <Box sx={{ p: 1.75, boxShadow: (theme) => `inset 0 1px 0 ${theme.palette.divider}` }}><Button fullWidth color="inherit" startIcon={<FolderOutlinedIcon />} onClick={showProjects} sx={{ justifyContent: "flex-start", color: "text.secondary" }}>Browse projects</Button></Box>
  </Box>;

  const triggerDestinations = workspaceAgents(snapshots);
  const triggerAgentById = new Map(triggerDestinations.map((destination) => [destination.agent.id, destination] as const));
  const filteredTriggers = (allTriggersQuery.data ?? []).filter((trigger) => {
    const destination = triggerAgentById.get(trigger.agentId);
    return !normalizedFilter || [
      trigger.name,
      trigger.instructions,
      trigger.sourceKind,
      destination?.agent.title,
      destination?.project.label,
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedFilter);
  });
  const triggerManagers = triggerDestinations.filter(({ agent, project: triggerProject }) => !normalizedFilter
    || `${agent.title} ${triggerProject.label} ${agent.activeEngine}`.toLocaleLowerCase().includes(normalizedFilter));
  const triggersPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}>
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
            aria-label={`Manage trigger ${trigger.name}`}
            onClick={() => openTriggerManager(destination.project.id, destination.agent.id)}
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
          aria-label={`Manage triggers for ${agent.title}`}
          onClick={() => openTriggerManager(triggerProject.id, agent.id)}
          sx={{ borderRadius: 1.25, px: 1, py: .65, mb: .25, minWidth: 0 }}
        >
          <ListItemIcon sx={{ minWidth: 38 }}><SmartToyOutlinedIcon sx={{ fontSize: 17 }} /></ListItemIcon>
          <ListItemText primary={agent.title} secondary={triggerProject.label} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 700 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
          <Typography variant="caption" color="text.secondary">Manage</Typography>
        </ListItemButton>)}</List>
      </Box>
    </Box>
  </Box>;

  const project = selected;
  const activeConversations = (project?.conversations ?? []).filter((conversation) => !conversation.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const filteredConversations = activeConversations.filter((conversation) => !normalizedFilter || conversationDisplayTitle(conversation, activeConversations).toLocaleLowerCase().includes(normalizedFilter));
  const grouped = (["Today", "Yesterday", "Earlier"] as const).map((group) => ({ group, conversations: filteredConversations.filter((conversation) => conversationGroup(conversation.updatedAt) === group) }));

  const chatsPanel = project ? <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto auto minmax(0, 1fr) auto", bgcolor: sidebarSurface }}>
    <Stack direction="row" sx={{ alignItems: "center", px: 1.25, pt: 1.25 }}><Button size="small" color="inherit" startIcon={<ArrowBackIcon />} onClick={showProjects} sx={{ color: "text.secondary", justifyContent: "flex-start" }}>All Projects</Button><IconButton aria-label={`Project settings for ${project.project.label}`} onClick={() => onManageProject(project.project)} sx={{ ml: "auto" }}><MoreHorizIcon /></IconButton></Stack>
    <Stack direction="row" sx={{ alignItems: "center", px: 2, py: 1 }}><Typography variant="h6" fontWeight={800} sx={{ flex: 1 }} noWrap>{project.project.label}</Typography><Stack direction="row" spacing={.75} sx={{ alignItems: "center" }}><Typography variant="caption" color="primary.light">Healthy</Typography><Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: "success.main" }} /></Stack></Stack>
    <Stack spacing={1.25} sx={{ px: 1.75, pb: 1.5 }}><TextField fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search Project Chats" inputProps={{ "aria-label": "Search Project Chats" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, endAdornment: <Box component="kbd" sx={{ px: .75, py: .35, borderRadius: .75, bgcolor: "action.hover", color: "text.secondary", fontSize: 10 }}>⌘K</Box> }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") onSearch?.(); }} /><Button fullWidth variant="contained" startIcon={<AddIcon />} onClick={() => void createChat(project.project)} sx={{ justifyContent: "flex-start" }}>New Project Chat</Button></Stack>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      {grouped.map(({ group, conversations }) => conversations.length ? <Box key={group} component="section" sx={{ mb: 1.75 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>{group}</Typography><List disablePadding>{conversations.map((conversation) => {
        const title = conversationDisplayTitle(conversation, activeConversations);
        return <Stack key={conversation.id} direction="row" onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, conversation }); }} sx={{ alignItems: "center" }}><ListItemButton selected={route.kind === "conversation" && route.conversationId === conversation.id} onClick={() => openChat(project.project, conversation)} sx={{ borderRadius: 1, px: 1, minWidth: 0 }}><ListItemIcon sx={{ minWidth: 38 }}><Box sx={{ width: 30, height: 30, borderRadius: "50%", bgcolor: "action.hover", display: "grid", placeItems: "center" }}><ChatBubbleOutlineIcon sx={{ fontSize: 16 }} /></Box></ListItemIcon><ListItemText primary={title} secondary={`${unread.get(conversation.id) ? `${unread.get(conversation.id)} unread · ` : ""}${relativeChatTime(conversation.updatedAt)}`} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 700 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />{unread.get(conversation.id) ? <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.light" }} /> : null}</ListItemButton></Stack>;
      })}</List></Box> : null)}
      {filteredConversations.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>No Project Chats match “{filter.trim()}”.</Typography> : null}
    </Box>
    <Box sx={{ boxShadow: (theme) => `inset 0 1px 0 ${theme.palette.divider}`, p: 1.5 }}><Button fullWidth color="inherit" aria-label="Open project files" aria-current={route.kind === "project" ? "page" : undefined} onClick={() => onNavigate({ kind: "project", projectId: project.project.id })} startIcon={<FolderOutlinedIcon />} sx={{ justifyContent: "flex-start", color: route.kind === "project" ? "text.primary" : "text.secondary", bgcolor: route.kind === "project" ? "action.selected" : "transparent" }}>Project files</Button><Button fullWidth color="inherit" onClick={() => onManageProject(project.project)} sx={{ justifyContent: "space-between", color: "text.secondary" }}>Manage {project.project.label}<Box component="span">›</Box></Button></Box>
  </Box> : null;

  return <Box component="aside" aria-label="Workspace navigation" data-sidebar-state="expanded" sx={{ width: drawer ? "min(100vw, 390px)" : SIDEBAR_RAIL_WIDTH + SIDEBAR_PANEL_WIDTH, height: "100%", minHeight: 0, minWidth: 0, borderRight: 1, borderColor: "divider", display: "grid", gridTemplateColumns: `${drawer ? 64 : SIDEBAR_RAIL_WIDTH}px minmax(0, 1fr)`, bgcolor: sidebarSurface, overflow: "hidden" }}>
    {rail}
    {showingAgents ? agentsPanel : showingTriggers ? triggersPanel : showingProjects ? projectsPanel : insideProject ? chatsPanel : projectsPanel}
    {menu ? <Menu anchorEl={menu.anchor} open onClose={() => setMenu(undefined)}><MenuItem onClick={() => { onRenameConversation(menu.conversation); setMenu(undefined); }}>Rename</MenuItem><MenuItem sx={{ color: "error.main" }} onClick={() => { onDeleteConversation(menu.conversation); setMenu(undefined); }}>Delete</MenuItem></Menu> : null}
  </Box>;
}
