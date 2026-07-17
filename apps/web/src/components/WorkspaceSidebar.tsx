import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import {
  Badge,
  Box,
  Button,
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
import type { ConversationDto, ProjectDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import { conversationDisplayTitle } from "../conversationLabels";
import { routeProjectId, type Route } from "../routing";
import { currentProjectSnapshot, unreadByConversation, workspaceCounts, type WorkspaceProjectSnapshot } from "../workspaceNavigation";

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
        bgcolor: selected ? "rgba(121, 196, 178, .14)" : "transparent",
        "&:hover": { bgcolor: selected ? "rgba(121, 196, 178, .2)" : "action.hover", color: "text.primary" },
      }}
    ><Badge color="primary" badgeContent={badge} max={99}>{children}</Badge></IconButton>
  </Tooltip>;
}

export function WorkspaceSidebar({
  projects,
  route,
  notifications,
  drawer = false,
  onNavigate,
  onCreateProject,
  onManageProject,
  onRenameConversation,
  onDeleteConversation,
  onSearch,
  onOpenNotifications,
  onOpenSettings,
}: {
  projects: ProjectDto[];
  route: Route;
  notifications: WorkspaceNotificationDto[];
  drawer?: boolean;
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onManageProject(project: ProjectDto): void;
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
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; conversation: ConversationDto }>();
  const normalizedFilter = filter.trim().toLocaleLowerCase();

  const openProject = (snapshot: WorkspaceProjectSnapshot) => {
    const conversations = snapshot.conversations.filter((conversation) => !conversation.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const target = conversations.find((conversation) => conversation.id === snapshot.project.lastConversationId) ?? conversations[0];
    onNavigate(target
      ? { kind: "conversation", projectId: snapshot.project.id, conversationId: target.id }
      : { kind: "agents", projectId: snapshot.project.id });
  };
  const openChat = (project: ProjectDto, conversation: ConversationDto) => {
    void api.markProjectUsed(project.id, conversation.id);
    void api.clearConversationNotifications(conversation.id);
    onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };
  const createChat = async (project: ProjectDto) => {
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
      bgcolor: "#061416",
      display: "grid",
      gridTemplateRows: "auto minmax(0, 1fr) auto",
      justifyItems: "center",
      py: 1.5,
    }}
  >
    <Stack spacing={.4} sx={{ alignItems: "center" }}>
      <Tooltip title="Ponderosa" placement="right"><Box component="img" src="/icons/icon.svg" alt="Ponderosa" sx={{ width: 40, height: 40, mb: 1.25 }} /></Tooltip>
      <RailButton label="Home" selected={route.kind === "home"} onClick={() => onNavigate({ kind: "home" })}><HomeOutlinedIcon /></RailButton>
      <RailButton label="Projects" selected={route.kind === "projects" || insideProject} onClick={() => onNavigate({ kind: "projects" })}><FolderOutlinedIcon /></RailButton>
      <RailButton label="Agents" selected={route.kind === "allAgents" || route.kind === "agents" || route.kind === "agent"} badge={counts.running || undefined} onClick={() => onNavigate({ kind: "allAgents" })}><PersonOutlineIcon /></RailButton>
      <RailButton label="Inbox" badge={counts.unread || undefined} onClick={() => onOpenNotifications?.()}><InboxOutlinedIcon /></RailButton>
    </Stack>
    <Box />
    <Stack spacing={.65} sx={{ alignItems: "center" }}>
      <RailButton label="Settings" onClick={() => onOpenSettings?.()}><SettingsOutlinedIcon /></RailButton>
      <Tooltip title="Operator profile" placement="right"><Box sx={{ position: "relative", width: 42, height: 42, borderRadius: "50%", border: 1, borderColor: "divider", display: "grid", placeItems: "center", fontSize: 13 }}>KC<Box sx={{ position: "absolute", right: -1, bottom: 1, width: 10, height: 10, borderRadius: "50%", bgcolor: "success.main", border: "2px solid #061416" }} /></Box></Tooltip>
    </Stack>
  </Box>;

  const projectList = snapshots.filter((snapshot) => !normalizedFilter || `${snapshot.project.label} ${snapshot.project.hostPath}`.toLocaleLowerCase().includes(normalizedFilter));
  const featured = projectList[0];
  const remaining = projectList.slice(featured ? 1 : 0);

  const projectsPanel = <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: "background.default" }}>
    <Stack direction="row" sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}><Typography variant="h6" fontWeight={800} sx={{ flex: 1 }}>Projects</Typography><Typography variant="caption" color="text.secondary">{projects.length} total</Typography></Stack>
    <Box sx={{ px: 1.75, pb: 1.5 }}><TextField
      fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search projects"
      inputProps={{ "aria-label": "Search projects" }}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, endAdornment: <Box component="kbd" sx={{ px: .75, py: .35, borderRadius: .75, bgcolor: "action.hover", color: "text.secondary", fontSize: 10 }}>⌘K</Box> }}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") onSearch?.(); }}
    /></Box>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      {featured ? <Box component="section" sx={{ mb: 2 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>Starred</Typography><List disablePadding sx={{ mt: .5 }}><ListItemButton selected={featured.project.id === selectedProjectId} onClick={() => openProject(featured)} sx={{ borderRadius: 1.25, border: 1, borderColor: "primary.dark", bgcolor: "rgba(121,196,178,.08)" }}><ListItemIcon sx={{ minWidth: 38 }}><Box component="img" src="/icons/icon.svg" alt="" sx={{ width: 28, height: 28 }} /></ListItemIcon><ListItemText primary={featured.project.label} secondary={`${featured.conversations.filter((item) => !item.archived).length} active chats`} primaryTypographyProps={{ fontWeight: 750 }} /></ListItemButton></List></Box> : null}
      <Box component="section"><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>All projects</Typography><List disablePadding sx={{ mt: .5 }}>{remaining.map((snapshot) => <ListItemButton key={snapshot.project.id} onClick={() => openProject(snapshot)} sx={{ borderRadius: 1, px: 1, minHeight: 48 }}><ListItemIcon sx={{ minWidth: 38 }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon><ListItemText primary={snapshot.project.label} primaryTypographyProps={{ noWrap: true }} /><Typography variant="caption" color="text.secondary">{snapshot.conversations.filter((item) => !item.archived).length}</Typography></ListItemButton>)}</List></Box>
      {projectList.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>No projects match “{filter.trim()}”.</Typography> : null}
    </Box>
    <Box sx={{ p: 1.75, borderTop: 1, borderColor: "divider" }}><Button fullWidth variant="outlined" startIcon={<AddIcon />} onClick={onCreateProject} sx={{ justifyContent: "flex-start" }}>New project</Button><Stack direction="row" sx={{ mt: 2, px: .75, color: "text.secondary" }}><Typography variant="caption" sx={{ flex: 1 }}>Sorted by recent activity</Typography><Typography variant="caption" color="primary.light">A–Z⌄</Typography></Stack></Box>
  </Box>;

  const project = selected;
  const activeConversations = (project?.conversations ?? []).filter((conversation) => !conversation.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const filteredConversations = activeConversations.filter((conversation) => !normalizedFilter || conversationDisplayTitle(conversation, activeConversations).toLocaleLowerCase().includes(normalizedFilter));
  const grouped = (["Today", "Yesterday", "Earlier"] as const).map((group) => ({ group, conversations: filteredConversations.filter((conversation) => conversationGroup(conversation.updatedAt) === group) }));

  const chatsPanel = project ? <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto auto minmax(0, 1fr) auto", bgcolor: "background.default" }}>
    <Stack direction="row" sx={{ alignItems: "center", px: 1.25, pt: 1.25 }}><Button size="small" color="inherit" startIcon={<ArrowBackIcon />} onClick={() => onNavigate({ kind: "projects" })} sx={{ color: "text.secondary", justifyContent: "flex-start" }}>All Projects</Button><IconButton aria-label={`Project settings for ${project.project.label}`} onClick={() => onManageProject(project.project)} sx={{ ml: "auto" }}><MoreHorizIcon /></IconButton></Stack>
    <Stack direction="row" sx={{ alignItems: "center", px: 2, py: 1 }}><Typography variant="h6" fontWeight={800} sx={{ flex: 1 }} noWrap>{project.project.label}</Typography><Stack direction="row" spacing={.75} sx={{ alignItems: "center" }}><Typography variant="caption" color="primary.light">Healthy</Typography><Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: "success.main" }} /></Stack></Stack>
    <Stack spacing={1.25} sx={{ px: 1.75, pb: 1.5 }}><TextField fullWidth size="small" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search Project Chats" inputProps={{ "aria-label": "Search Project Chats" }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, endAdornment: <Box component="kbd" sx={{ px: .75, py: .35, borderRadius: .75, bgcolor: "action.hover", color: "text.secondary", fontSize: 10 }}>⌘K</Box> }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") onSearch?.(); }} /><Button fullWidth variant="contained" startIcon={<AddIcon />} onClick={() => void createChat(project.project)} sx={{ justifyContent: "flex-start", color: "#061416", bgcolor: "primary.light", "&:hover": { bgcolor: "primary.main" } }}>New Project Chat</Button></Stack>
    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: 1.25 }}>
      {grouped.map(({ group, conversations }) => conversations.length ? <Box key={group} component="section" sx={{ mb: 1.75 }}><Typography variant="overline" color="text.secondary" sx={{ px: 1 }}>{group}</Typography><List disablePadding>{conversations.map((conversation) => {
        const title = conversationDisplayTitle(conversation, activeConversations);
        return <Stack key={conversation.id} direction="row" onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, conversation }); }} sx={{ alignItems: "center" }}><ListItemButton selected={route.kind === "conversation" && route.conversationId === conversation.id} onClick={() => openChat(project.project, conversation)} sx={{ borderRadius: 1, px: 1, minWidth: 0 }}><ListItemIcon sx={{ minWidth: 38 }}><Box sx={{ width: 30, height: 30, borderRadius: "50%", bgcolor: "action.hover", display: "grid", placeItems: "center" }}><ChatBubbleOutlineIcon sx={{ fontSize: 16 }} /></Box></ListItemIcon><ListItemText primary={title} secondary={`${unread.get(conversation.id) ? `${unread.get(conversation.id)} unread · ` : ""}${relativeChatTime(conversation.updatedAt)}`} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 700 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />{unread.get(conversation.id) ? <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.light" }} /> : null}</ListItemButton></Stack>;
      })}</List></Box> : null)}
      {filteredConversations.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>No Project Chats match “{filter.trim()}”.</Typography> : null}
    </Box>
    <Box sx={{ borderTop: 1, borderColor: "divider", p: 1.5 }}><Button fullWidth color="inherit" startIcon={<FolderOutlinedIcon />} sx={{ justifyContent: "flex-start", color: "text.secondary" }}>Project files</Button><Button fullWidth color="inherit" onClick={() => onManageProject(project.project)} sx={{ justifyContent: "space-between", color: "text.secondary" }}>Manage {project.project.label}<Box component="span">›</Box></Button></Box>
  </Box> : null;

  return <Box component="aside" aria-label="Workspace navigation" data-sidebar-state="expanded" sx={{ width: drawer ? "min(100vw, 390px)" : SIDEBAR_RAIL_WIDTH + SIDEBAR_PANEL_WIDTH, height: "100%", minHeight: 0, minWidth: 0, borderRight: 1, borderColor: "divider", display: "grid", gridTemplateColumns: `${drawer ? 64 : SIDEBAR_RAIL_WIDTH}px minmax(0, 1fr)`, bgcolor: "background.default", overflow: "hidden" }}>
    {rail}
    {insideProject ? chatsPanel : projectsPanel}
    {menu ? <Menu anchorEl={menu.anchor} open onClose={() => setMenu(undefined)}><MenuItem onClick={() => { onRenameConversation(menu.conversation); setMenu(undefined); }}>Rename</MenuItem><MenuItem sx={{ color: "error.main" }} onClick={() => { onDeleteConversation(menu.conversation); setMenu(undefined); }}>Delete</MenuItem></Menu> : null}
  </Box>;
}
