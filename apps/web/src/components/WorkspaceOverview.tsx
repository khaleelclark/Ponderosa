import AddIcon from "@mui/icons-material/Add";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Box,
  Button,
  Chip,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useMemo, useRef, useState } from "react";
import { useProjectAgentHealth, useProjectAgents, useProjectConversations } from "../hooks/useProjectCollections";
import type { Route } from "../routing";
import { resourcePreferenceKey, starredWorkspaceResources, toggleWorkspaceResourceStar } from "../resourcePreferences";
import type { WorkspaceProjectSnapshot } from "../workspaceNavigation";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";
import { CollectionDirectoryControls, CollectionEmptyState, CollectionToolbar, CollectionWorkspace, ResourceRow } from "./CollectionPrimitives";

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

function reorderProjectIds(order: string[], draggedId: string, targetId: string, position: "before" | "after" = "before"): string[] {
  if (draggedId === targetId) return order;
  const next = order.filter((projectId) => projectId !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0 || next.length === order.length) return order;
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, draggedId);
  return next;
}

function projectDropPreferencePatch(
  order: string[],
  draggedId: string,
  targetId: string,
  position: "before" | "after" = "before",
): Pick<WorkspacePreferencesDto, "projectSort" | "projectOrder"> | undefined {
  const projectOrder = reorderProjectIds(order, draggedId, targetId, position);
  return projectOrder === order ? undefined : { projectSort: "custom", projectOrder };
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
  const dragPreviewRef = useRef<HTMLElement>();
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
  const toggleStar = (projectId: string) => onPreferences(toggleWorkspaceResourceStar(preferences, "project", projectId));
  return <CollectionWorkspace
    icon={<FolderOutlinedIcon />}
    title="All Projects"
    detail={filteredSnapshots.length === projects.length ? `${projects.length} ${projects.length === 1 ? "Project" : "Projects"} across Ponderosa` : `${filteredSnapshots.length} of ${projects.length} Projects`}
    primaryAction={<Button variant="contained" startIcon={<AddIcon />} onClick={onCreateProject} sx={{ whiteSpace: "nowrap" }}>New Project</Button>}
    toolbar={<CollectionToolbar search={filter} onSearch={setFilter} searchLabel="Search Projects">
      <CollectionDirectoryControls
        sort={preferences.projectSort}
        onSort={projectSort => onPreferences({ projectSort })}
      />
    </CollectionToolbar>}
    listLabel="All Projects"
  >
    {filteredSnapshots.map((snapshot) => {
        const recent = [...snapshot.conversations].filter((item) => !item.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const running = snapshot.health.filter((entry) => entry.status === "running" || entry.status === "compacting").length;
        return <ResourceRow
          key={snapshot.project.id}
          label={snapshot.project.label}
          description={`${snapshot.project.hostPath}${recent ? " · Recent chat" : " · No Project chats"}`}
          icon={<FolderOutlinedIcon />}
          meta={running > 0 ? <Chip size="small" color="info" label={`${running} running`} sx={{ ml: 1 }} /> : null}
          onOpen={() => onNavigate(openProjectRoute(snapshot))}
          onContextMenu={(anchor) => setTabMenu({ anchor, resource: openProjectRoute(snapshot) })}
          draggable
          onDragStart={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            dragPreviewRef.current?.remove();
            const preview = document.createElement("div");
            const content = event.currentTarget.firstElementChild?.cloneNode(true);
            const rowStyles = window.getComputedStyle(event.currentTarget);
            preview.setAttribute("aria-hidden", "true");
            Object.assign(preview.style, {
              position: "fixed",
              left: `${bounds.left}px`,
              top: `${bounds.top}px`,
              zIndex: "2147483647",
              boxSizing: "border-box",
              width: `${bounds.width}px`,
              height: `${bounds.height}px`,
              display: "flex",
              overflow: "hidden",
              pointerEvents: "none",
              background: rowStyles.background,
              border: rowStyles.border,
              borderRadius: rowStyles.borderRadius,
              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
            });
            if (content instanceof HTMLElement) {
              content.removeAttribute("role");
              content.removeAttribute("tabindex");
              content.removeAttribute("aria-label");
              content.style.width = "100%";
              content.style.pointerEvents = "none";
              preview.appendChild(content);
            }
            document.body.appendChild(preview);
            dragPreviewRef.current = preview;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", snapshot.project.id);
            event.dataTransfer.setDragImage(
              preview,
              event.clientX - bounds.left,
              event.clientY - bounds.top,
            );
            setDraggedProjectId(snapshot.project.id);
          }}
          onDragEnd={() => {
            dragPreviewRef.current?.remove();
            dragPreviewRef.current = undefined;
            setDraggedProjectId(undefined);
            setDropTarget(undefined);
          }}
          onDragOver={(event) => {
            if (!draggedProjectId || draggedProjectId === snapshot.project.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const bounds = event.currentTarget.getBoundingClientRect();
            setDropTarget({ projectId: snapshot.project.id, position: event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before" });
          }}
          onDrop={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            dropProject(snapshot.project.id, event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before");
          }}
          highlighted={dropTarget?.projectId === snapshot.project.id}
          starAction={
          <Tooltip title={`${starredResourceIds.has(resourcePreferenceKey("project", snapshot.project.id)) ? "Unstar" : "Star"} ${snapshot.project.label}`}>
            <IconButton aria-label={`${starredResourceIds.has(resourcePreferenceKey("project", snapshot.project.id)) ? "Unstar" : "Star"} ${snapshot.project.label}`} onClick={() => toggleStar(snapshot.project.id)}>
              {starredResourceIds.has(resourcePreferenceKey("project", snapshot.project.id)) ? <StarRoundedIcon sx={{ color: "var(--ponderosa-star)" }} /> : <StarBorderRoundedIcon />}
            </IconButton>
          </Tooltip>
          }
          overflowAction={
          <Tooltip title={`Project settings for ${snapshot.project.label}`}>
            <IconButton aria-label={`Project settings for ${snapshot.project.label}`} onClick={() => onManageProject(snapshot.project)}><MoreVertIcon /></IconButton>
          </Tooltip>
          }
        />;
      })}
    {filteredSnapshots.length === 0 ? <CollectionEmptyState
      title={projects.length === 0 && !filter.trim() ? "No Projects yet" : `No Projects match “${filter.trim()}”`}
      detail={projects.length === 0 && !filter.trim() ? "Create a Project to get started." : "Try a Project name, folder, or Chat title."}
    /> : null}
    <ResourceContextMenu state={tabMenu} onClose={() => setTabMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </CollectionWorkspace>;
}
