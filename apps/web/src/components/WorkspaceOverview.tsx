import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import SearchIcon from "@mui/icons-material/Search";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
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
import { useMemo, useState } from "react";
import { api } from "../api";
import type { Route } from "../routing";
import type { WorkspaceProjectSnapshot } from "../workspaceNavigation";

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
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const starredProjectIds = new Set(preferences.starredProjectIds);
  const filteredSnapshots = useMemo(() => normalizedFilter
    ? snapshots.filter((snapshot) => {
      const searchable = [
        snapshot.project.label,
        snapshot.project.hostPath,
        ...snapshot.conversations.map((conversation) => conversation.title),
      ].join(" ").toLocaleLowerCase();
      return searchable.includes(normalizedFilter);
    })
    : snapshots, [snapshots, normalizedFilter]);
  const moveProject = (projectId: string, offset: -1 | 1) => {
    const order = projects.map((project) => project.id);
    const from = order.indexOf(projectId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    onPreferences({ projectSort: "custom", projectOrder: order });
  };
  const toggleStar = (projectId: string) => onPreferences({
    starredProjectIds: starredProjectIds.has(projectId)
      ? preferences.starredProjectIds.filter((id) => id !== projectId)
      : [...preferences.starredProjectIds, projectId],
  });
  return <Box sx={{ width: "100%", minWidth: 0, minHeight: 0, overflowY: "auto", p: { xs: 1.5, sm: 3 } }}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, mb: 2 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h2" fontWeight={800}>All projects</Typography>
        <Typography variant="body2" color="text.secondary">Every project stays identifiable by its host folder and recent Project chat.</Typography>
      </Box>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ width: { xs: "100%", sm: "auto" } }}>
        <TextField
          size="small"
          label="Filter projects"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ minWidth: { sm: 220 } }}
        />
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
        <Button variant="contained" startIcon={<AddIcon />} onClick={onCreateProject} sx={{ whiteSpace: "nowrap" }}>New project</Button>
      </Stack>
    </Stack>
    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>{filteredSnapshots.length === projects.length ? `${projects.length} projects` : `${filteredSnapshots.length} of ${projects.length} projects`}</Typography>
    <List aria-label="All projects" disablePadding sx={{ display: "grid", gap: 1, width: "100%" }}>
      {filteredSnapshots.map((snapshot) => {
        const index = projects.findIndex((project) => project.id === snapshot.project.id);
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
          <Tooltip title={`${starredProjectIds.has(snapshot.project.id) ? "Unstar" : "Star"} ${snapshot.project.label}`}>
            <IconButton aria-label={`${starredProjectIds.has(snapshot.project.id) ? "Unstar" : "Star"} ${snapshot.project.label}`} onClick={() => toggleStar(snapshot.project.id)}>
              {starredProjectIds.has(snapshot.project.id) ? <StarRoundedIcon color="primary" /> : <StarBorderRoundedIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title={`Project settings for ${snapshot.project.label}`}>
            <IconButton aria-label={`Project settings for ${snapshot.project.label}`} onClick={() => onManageProject(snapshot.project)} sx={{ borderRadius: 0 }}><MoreHorizIcon /></IconButton>
          </Tooltip>
        </Stack>;
      })}
      {filteredSnapshots.length === 0 ? <Box sx={{ py: 6, textAlign: "center" }}><Typography fontWeight={750}>No projects match “{filter.trim()}”</Typography><Typography variant="body2" color="text.secondary">Try a project name, folder, or chat title.</Typography></Box> : null}
    </List>
  </Box>;
}
