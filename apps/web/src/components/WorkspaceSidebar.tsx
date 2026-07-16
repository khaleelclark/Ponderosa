import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Badge,
  Box,
  Button,
  Chip,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ConversationDto, ProjectDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentStatusColor, agentStatusLabel } from "../agents";
import { api } from "../api";
import { loadLastProjectId, routeProjectId, type Route } from "../routing";
import { conversationDisplayTitle } from "../conversationLabels";
import {
  currentProjectSnapshot,
  projectDisambiguator,
  unreadByConversation,
  workspaceAgents,
  workspaceChats,
  workspaceCounts,
  type WorkspaceProjectSnapshot,
} from "../workspaceNavigation";

export const SIDEBAR_MIN_WIDTH = 252;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_RAIL_WIDTH = 64;

const storageKeys = {
  collapsed: "ponderosa.sidebar.collapsed",
  width: "ponderosa.sidebar.width",
  agentsExpanded: "ponderosa.sidebar.agentsExpanded",
} as const;

function localValue(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveLocalValue(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    // Device-local presentation state is optional when storage is unavailable.
  }
}

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

export function WorkspaceSidebar({ projects, route, notifications, drawer = false, onNavigate, onCreateProject, onManageProject, onRenameConversation, onDeleteConversation }: {
  projects: ProjectDto[];
  route: Route;
  notifications: WorkspaceNotificationDto[];
  /** Phone drawer always presents the full list/detail navigator, independent of desktop rail state. */
  drawer?: boolean;
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onManageProject(project: ProjectDto): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const routedProjectId = routeProjectId(route);
  const rememberedProjectId = loadLastProjectId();
  const selectedProjectId = routedProjectId
    ?? projects.find((project) => project.id === rememberedProjectId)?.id
    ?? projects[0]?.id;
  const conversationQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["conversations", project.id], queryFn: () => api.listConversations(project.id), staleTime: 10_000 })) });
  const agentQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 4_000 })) });
  const healthQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agent-health", project.id], queryFn: () => api.getAgentHealth(project.id), staleTime: 5_000 })) });
  const snapshots = projectSnapshots(
    projects,
    conversationQueries.map((query) => query.data),
    agentQueries.map((query) => query.data),
    healthQueries.map((query) => query.data),
  );
  const selected = currentProjectSnapshot(snapshots, selectedProjectId);
  const unread = useMemo(() => unreadByConversation(notifications), [notifications]);
  const recentChats = workspaceChats(snapshots, notifications, 6);
  const allAgents = workspaceAgents(snapshots);
  const counts = workspaceCounts(snapshots, notifications);
  const previewAgents = [...allAgents].sort((a, b) => Number(b.project.id === selectedProjectId) - Number(a.project.id === selectedProjectId)).slice(0, 4);

  const initialWidth = clampSidebarWidth(Number(localValue(storageKeys.width)) || 288);
  const [localWidth, setLocalWidth] = useState(initialWidth);
  const [draftWidth, setDraftWidth] = useState(initialWidth);
  const [collapsed, setCollapsed] = useState(() => localValue(storageKeys.collapsed) === "true");
  const [agentsExpanded, setAgentsExpanded] = useState(() => localValue(storageKeys.agentsExpanded) !== "false");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; conversation: ConversationDto }>();
  const resizing = useRef(false);

  useEffect(() => { if (!resizing.current) setDraftWidth(localWidth); }, [localWidth]);

  const setSidebarCollapsed = (value: boolean) => {
    setCollapsed(value);
    saveLocalValue(storageKeys.collapsed, String(value));
  };
  const setAgentSectionExpanded = (value: boolean) => {
    setAgentsExpanded(value);
    saveLocalValue(storageKeys.agentsExpanded, String(value));
  };
  const openChat = (project: ProjectDto, conversation: ConversationDto) => {
    void api.markProjectUsed(project.id, conversation.id);
    void api.clearConversationNotifications(conversation.id);
    onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };
  const createChat = async (project: ProjectDto) => {
    const conversation = await api.createConversation(project.id, { title: "New Chat", defaultEngine: project.defaultEngine });
    await api.markProjectUsed(project.id, conversation.id);
    void queryClient.invalidateQueries({ queryKey: ["conversations", project.id] });
    onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };

  if (collapsed && !drawer) {
    const badge = counts.running || counts.unread;
    return <Box component="nav" aria-label="Workspace navigation" data-sidebar-state="collapsed" sx={{ width: SIDEBAR_RAIL_WIDTH, height: "100%", minHeight: 0, borderRight: 1, borderColor: "divider", bgcolor: "background.paper", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", justifyItems: "center", py: 1 }}>
      <Tooltip title="Expand sidebar" placement="right"><IconButton aria-label="Expand sidebar" onClick={() => setSidebarCollapsed(false)} sx={{ minWidth: 44, minHeight: 44 }}><ChevronRightIcon /></IconButton></Tooltip>
      <Stack spacing={.5} sx={{ alignItems: "center", pt: 1 }}>
        <Tooltip title={selected ? `Current project: ${selected.project.label}` : "View all projects"} placement="right">
          <IconButton aria-label={selected ? `Current project ${selected.project.label}` : "View all projects"} onClick={() => onNavigate(selected ? { kind: "project", projectId: selected.project.id } : { kind: "projects" })} sx={{ minWidth: 44, minHeight: 44 }}><FolderOutlinedIcon /></IconButton>
        </Tooltip>
        <Tooltip title="View all projects" placement="right"><IconButton aria-label="View all projects" onClick={() => onNavigate({ kind: "projects" })} sx={{ minWidth: 44, minHeight: 44 }}><ChatBubbleOutlineIcon /></IconButton></Tooltip>
      </Stack>
      <Tooltip title={`Agents: ${counts.running} running, ${counts.unread} unread`} placement="right">
        <IconButton aria-label={`View all agents, ${counts.running} running, ${counts.unread} unread`} onClick={() => onNavigate({ kind: "allAgents" })} sx={{ minWidth: 44, minHeight: 44 }}>
          <Badge color={counts.running ? "info" : "primary"} badgeContent={badge} max={99}><SmartToyOutlinedIcon /></Badge>
        </IconButton>
      </Tooltip>
    </Box>;
  }

  return <Box component="nav" aria-label="Workspace navigation" data-sidebar-state="expanded" sx={{ position: "relative", width: drawer ? "100%" : draftWidth, height: "100%", minHeight: 0, minWidth: SIDEBAR_MIN_WIDTH, maxWidth: drawer ? "none" : SIDEBAR_MAX_WIDTH, borderRight: 1, borderColor: "divider", bgcolor: "background.paper", overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
    <Stack direction="row" sx={{ height: 52, alignItems: "center", px: 1 }}>
      <Typography variant="subtitle2" sx={{ flex: 1, px: 1, fontWeight: 800 }}>Workspace</Typography>
      <Tooltip title="New project"><IconButton size="small" aria-label="New project" onClick={onCreateProject} sx={{ minWidth: 44, minHeight: 44 }}><AddIcon fontSize="small" /></IconButton></Tooltip>
      {!drawer ? <Tooltip title="Collapse sidebar"><IconButton size="small" aria-label="Collapse sidebar" onClick={() => setSidebarCollapsed(true)} sx={{ minWidth: 44, minHeight: 44 }}><ChevronLeftIcon fontSize="small" /></IconButton></Tooltip> : null}
    </Stack>

    <Box data-testid="workspace-navigation-scroll" className="ponderosa-scroll" sx={{ overflowY: "auto", minHeight: 0, overscrollBehavior: "contain", scrollbarGutter: "stable" }}>
      <Box component="section" aria-labelledby="current-project-heading" sx={{ px: 1, pb: 1 }}>
        <Stack direction="row" sx={{ alignItems: "center", px: .5 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id="current-project-heading" variant="overline" color="text.secondary">Current project</Typography>
            <Typography variant="body2" fontWeight={800} noWrap>{selected?.project.label ?? "No project selected"}</Typography>
          </Box>
          {selected ? <Tooltip title={`Project settings for ${selected.project.label}`}><IconButton size="small" aria-label={`Project settings for ${selected.project.label}`} onClick={() => onManageProject(selected.project)}><MoreHorizIcon fontSize="small" /></IconButton></Tooltip> : null}
        </Stack>
        {selected ? <>
          <List dense disablePadding aria-label={`Project chats in ${selected.project.label}`} sx={{ mt: .5 }}>
            {[...selected.conversations].filter((conversation) => !conversation.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((conversation) => {
              const displayTitle = conversationDisplayTitle(conversation, selected.conversations);
              return <Stack key={conversation.id} direction="row" onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, conversation }); }} sx={{ alignItems: "center" }}>
              <ListItemButton selected={route.kind === "conversation" && route.conversationId === conversation.id} aria-label={`Open ${displayTitle} in ${selected.project.label}`} onClick={() => openChat(selected.project, conversation)} sx={{ borderRadius: 1, minWidth: 0, px: 1, minHeight: 44 }}>
                <ListItemIcon sx={{ minWidth: 30 }}><ChatBubbleOutlineIcon fontSize="small" /></ListItemIcon>
                <ListItemText primary={displayTitle} primaryTypographyProps={{ noWrap: true, fontSize: 13, fontWeight: 650 }} />
                {unread.get(conversation.id) ? <Badge color="primary" badgeContent={unread.get(conversation.id)} sx={{ mr: 1 }} /> : null}
              </ListItemButton>
              <IconButton size="small" aria-label={`Actions for ${displayTitle}`} onClick={(event) => setMenu({ anchor: event.currentTarget, conversation })} sx={{ minWidth: 44, minHeight: 44 }}><MoreHorizIcon fontSize="small" /></IconButton>
            </Stack>;
            })}
          </List>
          <Button size="small" startIcon={<AddIcon />} onClick={() => void createChat(selected.project)} sx={{ ml: .5 }}>New chat</Button>
        </> : null}
      </Box>

      <Box component="section" aria-labelledby="recent-chats-heading" sx={{ borderTop: 1, borderColor: "divider", py: 1, px: 1 }}>
        <Typography id="recent-chats-heading" variant="overline" color="text.secondary" sx={{ px: 1 }}>Recent chats</Typography>
        <List dense disablePadding aria-label="Recent chats across projects">
          {recentChats.map(({ conversation, project, unread: unreadCount }) => {
            const projectConversations = snapshots.find((snapshot) => snapshot.project.id === project.id)?.conversations ?? [conversation];
            const displayTitle = conversationDisplayTitle(conversation, projectConversations);
            return <ListItemButton key={`${project.id}:${conversation.id}`} aria-label={`Open recent chat ${displayTitle} in ${projectDisambiguator(project, projects)}`} selected={route.kind === "conversation" && route.conversationId === conversation.id} onClick={() => openChat(project, conversation)} sx={{ borderRadius: 1, minWidth: 0, px: 1, minHeight: 48 }}>
            <ListItemText primary={displayTitle} secondary={projectDisambiguator(project, projects)} primaryTypographyProps={{ noWrap: true, fontSize: 13 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
            {unreadCount ? <Badge color="primary" badgeContent={unreadCount} sx={{ mr: 1 }} /> : null}
          </ListItemButton>;
          })}
        </List>
      </Box>

      <Box sx={{ borderTop: 1, borderColor: "divider", p: 1 }}>
        <ListItemButton selected={route.kind === "projects"} aria-label="View all projects" onClick={() => onNavigate({ kind: "projects" })} sx={{ borderRadius: 1, px: 1 }}>
          <ListItemIcon sx={{ minWidth: 32 }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="View all projects" secondary={`${projects.length} project${projects.length === 1 ? "" : "s"}`} primaryTypographyProps={{ fontWeight: 750 }} />
          <ChevronRightIcon fontSize="small" />
        </ListItemButton>
      </Box>
    </Box>

    <Box component="section" aria-labelledby="agents-heading" sx={{ borderTop: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <ListItemButton aria-expanded={agentsExpanded} onClick={() => setAgentSectionExpanded(!agentsExpanded)} sx={{ px: 1, minHeight: 48 }}>
        <ExpandMoreIcon fontSize="small" sx={{ transform: agentsExpanded ? "none" : "rotate(-90deg)", transition: "transform 120ms" }} />
        <SmartToyOutlinedIcon fontSize="small" sx={{ mx: 1 }} />
        <ListItemText id="agents-heading" primary="Agents" primaryTypographyProps={{ fontWeight: 800 }} />
        {counts.running ? <Chip size="small" color="info" label={`${counts.running} running`} /> : null}
        {counts.unread ? <Badge color="primary" badgeContent={counts.unread} sx={{ ml: 1, mr: .5 }} /> : null}
      </ListItemButton>
      <Collapse in={agentsExpanded}>
        <List dense disablePadding aria-label="Agent preview">
          {previewAgents.map(({ agent, project, status }) => <ListItemButton key={agent.id} selected={route.kind === "agent" && route.agentId === agent.id} aria-label={`Open agent ${agent.title} in ${projectDisambiguator(project, projects)}`} onClick={() => onNavigate({ kind: "agent", projectId: project.id, agentId: agent.id })} sx={{ px: 1.5, minHeight: 44, borderRadius: 1, mx: .5 }}>
            <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: status === "idle" ? "text.disabled" : `${agentStatusColor(status)}.main`, mr: 1.25, flex: "0 0 auto" }} />
            <ListItemText primary={agent.title} secondary={`${projectDisambiguator(project, projects)} · ${agentStatusLabel(status)}`} primaryTypographyProps={{ noWrap: true, fontSize: 13 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11 }} />
          </ListItemButton>)}
        </List>
        <Button fullWidth aria-label="View all agents across projects" endIcon={<ChevronRightIcon />} onClick={() => onNavigate({ kind: "allAgents" })} sx={{ justifyContent: "space-between", px: 2 }}>View all agents</Button>
      </Collapse>
    </Box>

    {!drawer ? <Box role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const next = clampSidebarWidth(localWidth + (event.key === "ArrowLeft" ? -16 : 16));
        setLocalWidth(next); setDraftWidth(next); saveLocalValue(storageKeys.width, String(next));
      }}
      onPointerDown={(event) => { resizing.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (resizing.current) setDraftWidth(clampSidebarWidth(event.clientX)); }}
      onPointerUp={(event) => { resizing.current = false; event.currentTarget.releasePointerCapture(event.pointerId); const next = clampSidebarWidth(draftWidth); setLocalWidth(next); setDraftWidth(next); saveLocalValue(storageKeys.width, String(next)); }}
      sx={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 5, cursor: "col-resize", zIndex: 4, bgcolor: "transparent", "&:focus-visible": { bgcolor: "primary.main" } }}
    /> : null}

    {menu ? <Menu anchorEl={menu.anchor} open onClose={() => setMenu(undefined)}>
      <MenuItem onClick={() => { onRenameConversation(menu.conversation); setMenu(undefined); }}>Rename</MenuItem>
      <MenuItem sx={{ color: "error.main" }} onClick={() => { onDeleteConversation(menu.conversation); setMenu(undefined); }}>Delete</MenuItem>
    </Menu> : null}
  </Box>;
}
