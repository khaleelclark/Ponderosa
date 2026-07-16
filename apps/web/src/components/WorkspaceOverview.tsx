import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Box,
  Button,
  Chip,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries } from "@tanstack/react-query";
import { agentStatusColor, agentStatusLabel } from "../agents";
import { api } from "../api";
import type { Route } from "../routing";
import { projectDisambiguator, workspaceAgents, type WorkspaceProjectSnapshot } from "../workspaceNavigation";

function useWorkspaceSnapshots(projects: ProjectDto[]): WorkspaceProjectSnapshot[] {
  const conversationQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["conversations", project.id],
      queryFn: () => api.listConversations(project.id),
      staleTime: 10_000,
    })),
  });
  const agentQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["agents", project.id],
      queryFn: () => api.listAgents(project.id),
      staleTime: 4_000,
    })),
  });
  const healthQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["agent-health", project.id],
      queryFn: () => api.getAgentHealth(project.id),
      staleTime: 5_000,
    })),
  });
  return projects.map((project, index) => ({
    project,
    conversations: conversationQueries[index]?.data ?? [],
    agents: agentQueries[index]?.data ?? [],
    health: healthQueries[index]?.data?.agents ?? [],
  }));
}

function openProjectRoute(snapshot: WorkspaceProjectSnapshot): Route {
  const active = snapshot.conversations.filter((conversation) => !conversation.archived);
  const conversation = active.find((item) => item.id === snapshot.project.lastConversationId)
    ?? [...active].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return conversation
    ? { kind: "conversation", projectId: snapshot.project.id, conversationId: conversation.id }
    : { kind: "agents", projectId: snapshot.project.id };
}

export function AllProjectsView({ projects, preferences, onNavigate, onCreateProject, onManageProject, onPreferences }: {
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onManageProject(project: ProjectDto): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const snapshots = useWorkspaceSnapshots(projects);
  const moveProject = (projectId: string, offset: -1 | 1) => {
    const order = projects.map((project) => project.id);
    const from = order.indexOf(projectId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    onPreferences({ projectSort: "custom", projectOrder: order });
  };
  return <Box sx={{ width: "100%", minWidth: 0, minHeight: 0, overflowY: "auto", p: { xs: 1.5, sm: 3 } }}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, mb: 2 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h2" fontWeight={800}>All projects</Typography>
        <Typography variant="body2" color="text.secondary">Every project stays identifiable by its host folder and recent Project chat.</Typography>
      </Box>
      <Stack direction="row" spacing={1}>
        <TextField
          select
          size="small"
          label="Sort"
          value={preferences.projectSort}
          onChange={(event) => onPreferences({ projectSort: event.target.value as WorkspacePreferencesDto["projectSort"] })}
          sx={{ minWidth: 132 }}
        >
          <MenuItem value="last_used">Last used</MenuItem>
          <MenuItem value="alphabetical">Alphabetical</MenuItem>
          <MenuItem value="custom">Custom</MenuItem>
        </TextField>
        <Button variant="contained" startIcon={<AddIcon />} onClick={onCreateProject}>New project</Button>
      </Stack>
    </Stack>
    <List aria-label="All projects" disablePadding sx={{ display: "grid", gap: 1, maxWidth: 920 }}>
      {snapshots.map((snapshot, index) => {
        const recent = [...snapshot.conversations].filter((item) => !item.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const running = snapshot.health.filter((entry) => entry.status === "running" || entry.status === "compacting").length;
        return <Stack key={snapshot.project.id} direction="row" sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, overflow: "hidden", bgcolor: "background.paper" }}>
          <ListItemButton aria-label={`Open project ${snapshot.project.label}`} onClick={() => onNavigate(openProjectRoute(snapshot))} sx={{ minWidth: 0, px: 1.5 }}>
            <ListItemIcon sx={{ minWidth: 38 }}><FolderOutlinedIcon /></ListItemIcon>
            <ListItemText
              primary={snapshot.project.label}
              secondary={`${snapshot.project.hostPath}${recent ? ` · Recent: ${recent.title}` : " · No Project chats"}`}
              primaryTypographyProps={{ fontWeight: 750, noWrap: true }}
              secondaryTypographyProps={{ noWrap: true }}
            />
            {running > 0 ? <Chip size="small" color="info" label={`${running} running`} sx={{ ml: 1 }} /> : null}
          </ListItemButton>
          {preferences.projectSort === "custom" ? <Stack direction="row" sx={{ alignItems: "center" }}>
            <IconButton size="small" disabled={index === 0} aria-label={`Move ${snapshot.project.label} up`} onClick={() => moveProject(snapshot.project.id, -1)}><ArrowUpwardIcon fontSize="small" /></IconButton>
            <IconButton size="small" disabled={index === snapshots.length - 1} aria-label={`Move ${snapshot.project.label} down`} onClick={() => moveProject(snapshot.project.id, 1)}><ArrowDownwardIcon fontSize="small" /></IconButton>
          </Stack> : null}
          <Tooltip title={`Project settings for ${snapshot.project.label}`}>
            <IconButton aria-label={`Project settings for ${snapshot.project.label}`} onClick={() => onManageProject(snapshot.project)} sx={{ borderRadius: 0 }}><MoreHorizIcon /></IconButton>
          </Tooltip>
        </Stack>;
      })}
    </List>
  </Box>;
}

export function AllAgentsView({ projects, onNavigate }: {
  projects: ProjectDto[];
  onNavigate(route: Route): void;
}): JSX.Element {
  const rows = workspaceAgents(useWorkspaceSnapshots(projects));
  const running = rows.filter((row) => row.status === "running" || row.status === "compacting").length;
  return <Box sx={{ width: "100%", minWidth: 0, minHeight: 0, overflowY: "auto", p: { xs: 1.5, sm: 3 } }}>
    <Box sx={{ mb: 2 }}>
      <Typography variant="h5" component="h2" fontWeight={800}>All agents</Typography>
      <Typography variant="body2" color="text.secondary">{rows.length} across {projects.length} projects{running ? ` · ${running} running` : ""}</Typography>
    </Box>
    <List aria-label="All agents across projects" disablePadding sx={{ display: "grid", gap: .75, maxWidth: 920 }}>
      {rows.map(({ agent, project, status }) => <ListItemButton
        key={agent.id}
        aria-label={`Open agent ${agent.title} in ${projectDisambiguator(project, projects)}`}
        onClick={() => onNavigate({ kind: "agent", projectId: project.id, agentId: agent.id })}
        sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, bgcolor: "background.paper", minWidth: 0, px: 1.5 }}
      >
        <ListItemIcon sx={{ minWidth: 38 }}><SmartToyOutlinedIcon /></ListItemIcon>
        <ListItemText
          primary={agent.title}
          secondary={`${projectDisambiguator(project, projects)} · ${agent.activeEngine}`}
          primaryTypographyProps={{ fontWeight: 750, noWrap: true }}
          secondaryTypographyProps={{ noWrap: true }}
        />
        <Chip size="small" color={agentStatusColor(status)} variant={status === "idle" ? "outlined" : "filled"} label={agentStatusLabel(status)} sx={{ ml: 1 }} />
      </ListItemButton>)}
      {rows.length === 0 ? <Typography color="text.secondary" sx={{ py: 2 }}>No active agents.</Typography> : null}
    </List>
  </Box>;
}
