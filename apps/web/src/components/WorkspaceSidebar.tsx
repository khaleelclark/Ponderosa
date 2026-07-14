import AddIcon from "@mui/icons-material/Add";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Badge, Box, Button, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, List, ListItemButton, ListItemText, Menu, MenuItem, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { ConversationDto, ProjectDto, WorkspaceNotificationDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAgents } from "../hooks/queries";
import type { Route } from "../routing";

export function WorkspaceSidebar({ projects, route, preferences, notifications, onNavigate, onCreateProject, onManageProject, onPreferences }: {
  projects: ProjectDto[];
  route: Route;
  preferences: WorkspacePreferencesDto;
  notifications: WorkspaceNotificationDto[];
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onManageProject(project: ProjectDto): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const selectedProjectId = route.kind === "home" ? undefined : route.projectId;
  const conversationsQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["conversations", project.id], queryFn: () => api.listConversations(project.id), staleTime: 10_000 })) });
  const healthQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agent-health", project.id], queryFn: () => api.getAgentHealth(project.id), staleTime: 5_000 })) });
  const activeAgents = useAgents(selectedProjectId).data ?? [];
  const selectedProjectIndex = projects.findIndex((project) => project.id === selectedProjectId);
  const selectedProject = selectedProjectIndex >= 0 ? projects[selectedProjectIndex] : undefined;
  const selectedHealth = new Map((healthQueries[selectedProjectIndex]?.data?.agents ?? []).map((agent) => [agent.agentId, agent.status]));
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; conversation: ConversationDto }>();
  const [rename, setRename] = useState<ConversationDto>();
  const [renameText, setRenameText] = useState("");
  const [deleting, setDeleting] = useState<ConversationDto>();
  const [draftWidth, setDraftWidth] = useState(preferences.sidebarWidth);
  const resizing = useRef(false);

  useEffect(() => { if (!resizing.current) setDraftWidth(preferences.sidebarWidth); }, [preferences.sidebarWidth]);

  useEffect(() => {
    if (selectedProjectId) setExpanded((current) => new Set(current).add(selectedProjectId));
  }, [selectedProjectId]);

  const unreadByConversation = useMemo(() => {
    const result = new Map<string, number>();
    for (const item of notifications) if (!item.readAt && item.conversationId) result.set(item.conversationId, (result.get(item.conversationId) ?? 0) + 1);
    return result;
  }, [notifications]);

  const createChat = async (project: ProjectDto) => {
    const conversation = await api.createConversation(project.id, { title: "New chat", defaultEngine: project.defaultEngine });
    await api.markProjectUsed(project.id, conversation.id);
    void queryClient.invalidateQueries({ queryKey: ["conversations", project.id] });
    onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };

  const moveProject = (projectId: string, offset: -1 | 1) => {
    const order = projects.map((project) => project.id);
    const from = order.indexOf(projectId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    onPreferences({ projectSort: "custom", projectOrder: order });
  };

  if (preferences.sidebarCollapsed) return <Box component="nav" aria-label="Workspace navigation" sx={{ width: 56, height: "100%", minHeight: 0, borderRight: 1, borderColor: "divider", bgcolor: "background.paper", pt: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
    <Tooltip title="Expand sidebar" placement="right"><IconButton aria-label="Expand sidebar" onClick={() => onPreferences({ sidebarCollapsed: false })}><ChevronRightIcon /></IconButton></Tooltip>
    {projects.map((project) => <Tooltip key={project.id} title={project.label} placement="right"><IconButton aria-label={`Open ${project.label}`} onClick={() => onNavigate({ kind: "project", projectId: project.id })}><FolderOutlinedIcon /></IconButton></Tooltip>)}
  </Box>;

  return <Box component="nav" aria-label="Workspace navigation" sx={{ position: "relative", width: draftWidth, height: "100%", minHeight: 0, minWidth: 220, maxWidth: 520, borderRight: 1, borderColor: "divider", bgcolor: "background.paper", overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
    <Stack direction="row" sx={{ alignItems: "center", px: 1, py: .5 }}>
      <Typography variant="overline" sx={{ flex: 1, px: 1 }}>Projects</Typography>
      <Tooltip title="New project"><IconButton size="small" aria-label="New project" onClick={onCreateProject}><AddIcon fontSize="small" /></IconButton></Tooltip>
      <Tooltip title="Collapse sidebar"><IconButton size="small" aria-label="Collapse sidebar" onClick={() => onPreferences({ sidebarCollapsed: true })}><ChevronLeftIcon fontSize="small" /></IconButton></Tooltip>
    </Stack>
    <Box sx={{ overflowY: "auto", minHeight: 0, overscrollBehavior: "contain" }}>
      <List dense disablePadding>
        {projects.map((project, index) => {
          const conversations = (conversationsQueries[index]?.data ?? []).filter((item) => !item.archived);
          const projectUnread = conversations.reduce((sum, item) => sum + (unreadByConversation.get(item.id) ?? 0), 0);
          const running = (healthQueries[index]?.data?.agents ?? []).filter((agent) => agent.status === "running" || agent.status === "compacting").length;
          const open = expanded.has(project.id);
          return <Box key={project.id}>
            <Stack direction="row" sx={{ px: .5, alignItems: "center" }}>
              <ListItemButton selected={selectedProjectId === project.id} onClick={() => { setExpanded((current) => { const next = new Set(current); open ? next.delete(project.id) : next.add(project.id); return next; }); onNavigate({ kind: "project", projectId: project.id }); }} sx={{ borderRadius: 1, minWidth: 0 }}>
                <ExpandMoreIcon fontSize="small" sx={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />
                <FolderOutlinedIcon fontSize="small" sx={{ mx: .75 }} />
                <ListItemText primary={project.label} primaryTypographyProps={{ noWrap: true, fontWeight: 700 }} />
                {projectUnread ? <Badge color="primary" badgeContent={projectUnread} sx={{ mr: 1 }} /> : null}
                {running ? <Chip size="small" color="info" label={running} aria-label={`${running} agents running`} /> : null}
              </ListItemButton>
              <IconButton size="small" aria-label={`Project settings for ${project.label}`} onClick={() => onManageProject(project)}><MoreHorizIcon fontSize="small" /></IconButton>
            </Stack>
            <Collapse in={open} unmountOnExit>
              <List dense disablePadding>
                {conversations.map((conversation) => <Stack key={conversation.id} direction="row" onContextMenu={(event) => { event.preventDefault(); setMenu({ anchor: event.currentTarget, conversation }); }} sx={{ pl: 3.5, pr: .5 }}>
                  <ListItemButton selected={route.kind === "conversation" && route.conversationId === conversation.id} onClick={() => { void api.markProjectUsed(project.id, conversation.id); void api.clearConversationNotifications(conversation.id); onNavigate({ kind: "conversation", projectId: project.id, conversationId: conversation.id }); }} sx={{ borderRadius: 1, minWidth: 0, minHeight: 40 }}>
                    <ListItemText primary={conversation.title} primaryTypographyProps={{ noWrap: true, fontSize: 13 }} />
                    {unreadByConversation.get(conversation.id) ? <Badge color="primary" badgeContent={unreadByConversation.get(conversation.id)} sx={{ mr: 1 }} /> : null}
                  </ListItemButton>
                  <IconButton size="small" aria-label={`Actions for ${conversation.title}`} onClick={(event) => setMenu({ anchor: event.currentTarget, conversation })}><MoreHorizIcon fontSize="small" /></IconButton>
                </Stack>)}
                <Button size="small" startIcon={<AddIcon />} onClick={() => void createChat(project)} sx={{ ml: 4, my: .5 }}>New chat</Button>
              </List>
            </Collapse>
          </Box>;
        })}
      </List>
      {selectedProjectId ? <Box sx={{ mt: 1, borderTop: 1, borderColor: "divider" }}>
        <ListItemButton onClick={() => setAgentsExpanded((value) => !value)}><ExpandMoreIcon fontSize="small" sx={{ transform: agentsExpanded ? "none" : "rotate(-90deg)" }} /><SmartToyOutlinedIcon fontSize="small" sx={{ mx: 1 }} /><ListItemText primary="Agents" primaryTypographyProps={{ fontWeight: 700 }} /></ListItemButton>
        <Collapse in={agentsExpanded}><List dense disablePadding>{activeAgents.filter((agent) => !agent.archived).map((agent) => {
          let level = 0; let parent = agent.managerAgentId;
          while (parent && level < 8) { level += 1; parent = activeAgents.find((item) => item.id === parent)?.managerAgentId; }
          const status = selectedHealth.get(agent.id) ?? (agent.archived ? "stopped" : "idle");
          return <ListItemButton key={agent.id} selected={route.kind === "agent" && route.agentId === agent.id} onClick={() => onNavigate({ kind: "agent", projectId: selectedProjectId, agentId: agent.id })} sx={{ pl: 2 + level * 2, minHeight: 38 }}><ListItemText primary={agent.title} secondary={`${status} · ${selectedProject?.label ?? "Project"} · level ${level}`} primaryTypographyProps={{ noWrap: true, fontSize: 13 }} secondaryTypographyProps={{ fontSize: 11, noWrap: true }} /></ListItemButton>;
        })}</List></Collapse>
      </Box> : null}
    </Box>
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", borderTop: 1, borderColor: "divider", p: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, display: preferences.projectSort === "custom" ? "none" : "block" }}>Sort projects</Typography>
      <TextField select size="small" value={preferences.projectSort} onChange={(event) => onPreferences({ projectSort: event.target.value as WorkspacePreferencesDto["projectSort"], ...(event.target.value === "custom" ? { projectOrder: projects.map((project) => project.id) } : {}) })} sx={{ minWidth: 112 }}>
        <MenuItem value="last_used">Last used</MenuItem>
        <MenuItem value="alphabetical">Alphabetical</MenuItem>
        <MenuItem value="custom">Custom</MenuItem>
      </TextField>
      {preferences.projectSort === "custom" ? <>
        <Tooltip title={selectedProject ? `Move ${selectedProject.label} up` : "Select a project to move it"}>
          <span><IconButton size="small" disabled={!selectedProject || selectedProjectIndex === 0} aria-label="Move selected project up" onClick={() => selectedProject && moveProject(selectedProject.id, -1)}><ArrowUpwardIcon fontSize="inherit" /></IconButton></span>
        </Tooltip>
        <Tooltip title={selectedProject ? `Move ${selectedProject.label} down` : "Select a project to move it"}>
          <span><IconButton size="small" disabled={!selectedProject || selectedProjectIndex === projects.length - 1} aria-label="Move selected project down" onClick={() => selectedProject && moveProject(selectedProject.id, 1)}><ArrowDownwardIcon fontSize="inherit" /></IconButton></span>
        </Tooltip>
      </> : null}
    </Stack>
    <Box role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft") onPreferences({ sidebarWidth: preferences.sidebarWidth - 16 }); if (event.key === "ArrowRight") onPreferences({ sidebarWidth: preferences.sidebarWidth + 16 }); }} onPointerDown={(event) => { resizing.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (resizing.current) setDraftWidth(Math.max(220, Math.min(520, event.clientX))); }} onPointerUp={(event) => { resizing.current = false; event.currentTarget.releasePointerCapture(event.pointerId); onPreferences({ sidebarWidth: draftWidth }); }} sx={{ position: "absolute", right: -3, top: 0, bottom: 0, width: 7, cursor: "col-resize", zIndex: 4, "&:focus": { bgcolor: "primary.main" } }} />
    <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(undefined)}><MenuItem onClick={() => { if (menu) { setRename(menu.conversation); setRenameText(menu.conversation.title); } setMenu(undefined); }}>Rename</MenuItem><MenuItem sx={{ color: "error.main" }} onClick={() => { setDeleting(menu?.conversation); setMenu(undefined); }}>Delete</MenuItem></Menu>
    <Dialog open={Boolean(rename)} onClose={() => setRename(undefined)} fullWidth maxWidth="xs"><DialogTitle>Rename Project chat</DialogTitle><DialogContent><TextField autoFocus fullWidth value={renameText} onChange={(event) => setRenameText(event.target.value)} sx={{ mt: 1 }} /></DialogContent><DialogActions><Button onClick={() => setRename(undefined)}>Cancel</Button><Button variant="contained" disabled={!renameText.trim()} onClick={() => void api.updateConversation(rename!.id, { title: renameText.trim() }).then(() => { void queryClient.invalidateQueries({ queryKey: ["conversations", rename!.projectId] }); setRename(undefined); })}>Save</Button></DialogActions></Dialog>
    <Dialog open={Boolean(deleting)} onClose={() => setDeleting(undefined)} fullWidth maxWidth="xs"><DialogTitle>Delete Project chat?</DialogTitle><DialogContent><Typography>This preserves project history and refuses deletion while an agent in this chat is running.</Typography></DialogContent><DialogActions><Button onClick={() => setDeleting(undefined)}>Cancel</Button><Button color="error" variant="contained" onClick={() => void api.deleteConversation(deleting!.id).then(() => { void queryClient.invalidateQueries({ queryKey: ["conversations", deleting!.projectId] }); setDeleting(undefined); })}>Delete</Button></DialogActions></Dialog>
  </Box>;
}
