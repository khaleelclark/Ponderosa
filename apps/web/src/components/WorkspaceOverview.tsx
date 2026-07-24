import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectAgentHealth, useProjectAgents, useProjectConversations } from "../hooks/useProjectCollections";
import type { Route } from "../routing";
import { resourcePreferenceKey, starredWorkspaceResources, toggleWorkspaceResourceStar } from "../resourcePreferences";
import type { WorkspaceProjectSnapshot } from "../workspaceNavigation";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";

function useWorkspaceSnapshots(projects: ProjectDto[]): WorkspaceProjectSnapshot[] {
  const conversationQueries = useProjectConversations(projects);
  const agentQueries = useProjectAgents(projects);
  const healthQueries = useProjectAgentHealth(projects);
  return projects.map((project, index) => ({
    project,
    conversations: conversationQueries[index]?.data ?? [],
    agents: agentQueries[index]?.data ?? [],
    health: healthQueries[index]?.data?.agents ?? [],
  }));
}

function openProjectRoute(snapshot: WorkspaceProjectSnapshot): Route {
  return { kind: "project", projectId: snapshot.project.id };
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

export function projectMovePreferencePatch(
  order: string[],
  projectId: string,
  direction: "before" | "after",
): Pick<WorkspacePreferencesDto, "projectSort" | "projectOrder"> | undefined {
  const currentIndex = order.indexOf(projectId);
  const targetIndex = direction === "before" ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= order.length) return undefined;
  return projectDropPreferencePatch(
    order,
    projectId,
    order[targetIndex]!,
    direction === "before" ? "before" : "after",
  );
}

export function AllProjectsView({ projects, preferences, onNavigate, onOpenInNewTab, onCreateProject, onManageProject, onPreferences }: {
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onOpenInNewTab?(route: Route): void;
  onCreateProject(): void;
  onManageProject(project: ProjectDto): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const snapshots = useWorkspaceSnapshots(projects);
  const [filter, setFilter] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ projectId: string; position: "before" | "after" }>();
  const [tabMenu, setTabMenu] = useState<ResourceContextMenuState<Route>>();
  const [orderAnnouncement, setOrderAnnouncement] = useState("");
  const reorderButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingReorderFocus = useRef<{ projectId: string; direction: "before" | "after" }>();
  const projectOrderKey = projects.map((project) => project.id).join("\u0000");
  useEffect(() => {
    const pending = pendingReorderFocus.current;
    if (!pending) return;
    const requested = reorderButtonRefs.current.get(`${pending.projectId}:${pending.direction}`);
    const fallbackDirection = pending.direction === "before" ? "after" : "before";
    const target = requested?.disabled
      ? reorderButtonRefs.current.get(`${pending.projectId}:${fallbackDirection}`)
      : requested;
    target?.focus();
    pendingReorderFocus.current = undefined;
  }, [projectOrderKey]);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const starredResourceIds = starredWorkspaceResources(preferences);
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
  const moveProject = (project: ProjectDto, direction: "before" | "after") => {
    const currentOrder = projects.map((candidate) => candidate.id);
    const patch = projectMovePreferencePatch(currentOrder, project.id, direction);
    if (!patch) return;
    const position = patch.projectOrder.indexOf(project.id) + 1;
    pendingReorderFocus.current = { projectId: project.id, direction };
    setOrderAnnouncement(`${project.label} moved to position ${position} of ${projects.length}.`);
    onPreferences(patch);
  };
  const toggleStar = (projectId: string) => onPreferences(toggleWorkspaceResourceStar(preferences, "project", projectId));
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
    <Box id="project-order-status" role="status" aria-live="polite" aria-atomic="true" sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{orderAnnouncement}</Box>
    <List aria-label="All projects" disablePadding sx={{ display: "grid", gap: 1, width: "100%" }}>
      {filteredSnapshots.map((snapshot) => {
        const recent = [...snapshot.conversations].filter((item) => !item.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const running = snapshot.health.filter((entry) => entry.status === "running" || entry.status === "compacting").length;
        const projectIndex = projects.findIndex((project) => project.id === snapshot.project.id);
        const previousProject = projectIndex > 0 ? projects[projectIndex - 1] : undefined;
        const nextProject = projectIndex >= 0 && projectIndex < projects.length - 1 ? projects[projectIndex + 1] : undefined;
        return <Stack
          key={snapshot.project.id}
          direction="row"
          onContextMenu={(event) => { event.preventDefault(); setTabMenu({ anchor: event.currentTarget, resource: openProjectRoute(snapshot) }); }}
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
          <Stack direction={{ xs: "column", sm: "row" }} spacing={0} sx={{ alignSelf: "stretch", justifyContent: "center", flexShrink: 0 }}>
            <Tooltip title={previousProject ? `Move before ${previousProject.label}` : "Already first"}>
              <span>
                <IconButton
                  ref={(node) => {
                    const key = `${snapshot.project.id}:before`;
                    if (node) reorderButtonRefs.current.set(key, node);
                    else reorderButtonRefs.current.delete(key);
                  }}
                  size="small"
                  disabled={!previousProject}
                  aria-label={previousProject ? `Move ${snapshot.project.label} before ${previousProject.label}` : `${snapshot.project.label} is first`}
                  aria-describedby="project-order-status"
                  onClick={() => moveProject(snapshot.project, "before")}
                  sx={{ minWidth: 36, minHeight: 36 }}
                ><ArrowUpwardIcon fontSize="small" /></IconButton>
              </span>
            </Tooltip>
            <Tooltip title={nextProject ? `Move after ${nextProject.label}` : "Already last"}>
              <span>
                <IconButton
                  ref={(node) => {
                    const key = `${snapshot.project.id}:after`;
                    if (node) reorderButtonRefs.current.set(key, node);
                    else reorderButtonRefs.current.delete(key);
                  }}
                  size="small"
                  disabled={!nextProject}
                  aria-label={nextProject ? `Move ${snapshot.project.label} after ${nextProject.label}` : `${snapshot.project.label} is last`}
                  aria-describedby="project-order-status"
                  onClick={() => moveProject(snapshot.project, "after")}
                  sx={{ minWidth: 36, minHeight: 36 }}
                ><ArrowDownwardIcon fontSize="small" /></IconButton>
              </span>
            </Tooltip>
          </Stack>
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
          <Tooltip title={`${starredResourceIds.has(resourcePreferenceKey("project", snapshot.project.id)) ? "Unstar" : "Star"} ${snapshot.project.label}`}>
            <IconButton aria-label={`${starredResourceIds.has(resourcePreferenceKey("project", snapshot.project.id)) ? "Unstar" : "Star"} ${snapshot.project.label}`} onClick={() => toggleStar(snapshot.project.id)}>
              {starredResourceIds.has(resourcePreferenceKey("project", snapshot.project.id)) ? <StarRoundedIcon sx={{ color: "#facc15" }} /> : <StarBorderRoundedIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title={`Project settings for ${snapshot.project.label}`}>
            <IconButton aria-label={`Project settings for ${snapshot.project.label}`} onClick={() => onManageProject(snapshot.project)} sx={{ borderRadius: 0 }}><MoreHorizIcon /></IconButton>
          </Tooltip>
        </Stack>;
      })}
      {filteredSnapshots.length === 0 ? <Box sx={{ py: 6, textAlign: "center" }}><Typography fontWeight={750}>No projects match “{filter.trim()}”</Typography><Typography variant="body2" color="text.secondary">Try a project name, folder, or chat title.</Typography></Box> : null}
    </List>
    <ResourceContextMenu state={tabMenu} onClose={() => setTabMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </Box>;
}
