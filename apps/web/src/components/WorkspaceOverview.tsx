import AddIcon from "@mui/icons-material/Add";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
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

export function reorderProjectIds(order: string[], draggedId: string, targetId: string, position: "before" | "after" = "before"): string[] {
  if (draggedId === targetId) return order;
  const next = order.filter((projectId) => projectId !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0 || next.length === order.length) return order;
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, draggedId);
  return next;
}

export function projectDropPreferencePatch(
  order: string[],
  draggedId: string,
  targetId: string,
  position: "before" | "after" = "before",
): Pick<WorkspacePreferencesDto, "projectSort" | "projectOrder"> | undefined {
  const projectOrder = reorderProjectIds(order, draggedId, targetId, position);
  return projectOrder === order ? undefined : { projectSort: "custom", projectOrder };
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
  const [draggedProjectId, setDraggedProjectId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ projectId: string; position: "before" | "after" }>();
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
  const dropProject = (targetId: string, position: "before" | "after") => {
    if (!draggedProjectId) return;
    const currentOrder = projects.map((project) => project.id);
    const patch = projectDropPreferencePatch(currentOrder, draggedProjectId, targetId, position);
    if (patch) onPreferences(patch);
    setDraggedProjectId(undefined);
    setDropTarget(undefined);
  };
  const toggleStar = (projectId: string) => onPreferences({
    starredProjectIds: starredProjectIds.has(projectId)
      ? preferences.starredProjectIds.filter((id) => id !== projectId)
      : [...preferences.starredProjectIds, projectId],
  });
  return <Box sx={{ width: "100%", minWidth: 0, minHeight: 0, overflowY: "auto", p: { xs: 1.5, sm: 3 } }}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, mb: 2 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h2" fontWeight={800}>All Projects</Typography>
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
          <MenuItem value="last_used">Last Used</MenuItem>
          <MenuItem value="alphabetical">Alphabetical</MenuItem>
          <MenuItem value="custom">Custom</MenuItem>
        </TextField>
        <Button variant="contained" startIcon={<AddIcon />} onClick={onCreateProject} sx={{ whiteSpace: "nowrap" }}>New Project</Button>
      </Stack>
    </Stack>
    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>{filteredSnapshots.length === projects.length ? `${projects.length} projects` : `${filteredSnapshots.length} of ${projects.length} projects`}</Typography>
    <List aria-label="All projects" disablePadding sx={{ display: "grid", gap: 1, width: "100%" }}>
      {filteredSnapshots.map((snapshot) => {
        const recent = [...snapshot.conversations].filter((item) => !item.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const running = snapshot.health.filter((entry) => entry.status === "running" || entry.status === "compacting").length;
        return <Stack
          key={snapshot.project.id}
          direction="row"
          onDragOver={(event) => {
            if (!draggedProjectId || draggedProjectId === snapshot.project.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const bounds = event.currentTarget.getBoundingClientRect();
            setDropTarget({ projectId: snapshot.project.id, position: event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before" });
          }}
          onDrop={(event) => {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            dropProject(snapshot.project.id, event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before");
          }}
          sx={{ border: 1, borderColor: dropTarget?.projectId === snapshot.project.id ? "primary.main" : "divider", borderRadius: 1.5, overflow: "hidden", bgcolor: dropTarget?.projectId === snapshot.project.id ? "action.hover" : "background.paper", transform: dropTarget?.projectId === snapshot.project.id ? `translateY(${dropTarget.position === "before" ? 2 : -2}px)` : "none", transition: "border-color 120ms ease, background-color 120ms ease, transform 120ms ease" }}
        >
          <ListItemButton aria-label={`Open project ${snapshot.project.label}`} onClick={() => onNavigate(openProjectRoute(snapshot))} sx={{ minWidth: 0, px: 1.5 }}>
            <ListItemIcon sx={{ minWidth: 38 }}><FolderOutlinedIcon /></ListItemIcon>
            <ListItemText
              primary={snapshot.project.label}
              secondary={`${snapshot.project.hostPath}${recent ? ` · Recent: ${recent.title}` : " · No Project chats"}`}
              primaryTypographyProps={{ fontWeight: 750, sx: { overflowWrap: "anywhere" } }}
              secondaryTypographyProps={{ noWrap: true }}
            />
            {running > 0 ? <Chip size="small" color="info" label={`${running} running`} sx={{ ml: 1 }} /> : null}
          </ListItemButton>
          <Tooltip title={`Drag to reorder ${snapshot.project.label}`}>
            <IconButton
              size="small"
              draggable
              aria-label={`Drag ${snapshot.project.label} to reorder`}
              onDragStart={(event) => {
                setDraggedProjectId(snapshot.project.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", snapshot.project.id);
              }}
              onDragEnd={() => { setDraggedProjectId(undefined); setDropTarget(undefined); }}
              sx={{ cursor: draggedProjectId === snapshot.project.id ? "grabbing" : "grab", color: "text.secondary" }}
            ><DragIndicatorIcon fontSize="small" /></IconButton>
          </Tooltip>
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
