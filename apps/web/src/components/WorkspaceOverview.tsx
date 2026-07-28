import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import { useProjectAgentHealth, useProjectAgents, useProjectConversations } from "../hooks/useProjectCollections";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import { resourcePreferenceKey, starredWorkspaceResources, toggleWorkspaceResourceStar } from "../resourcePreferences";
import type { WorkspaceProjectSnapshot } from "../workspaceNavigation";
import { DestructiveConfirmDialog, TextInputDialog } from "./ConfirmationDialogs";
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

type ProjectDirectoryResource = {
  route: Route;
  project: ProjectDto;
};

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

export function AllProjectsView({ projects, preferences, onNavigate, onOpenInNewTab, onCreateProject, onManageProject, onProjectDeleted, onPreferences }: {
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onOpenInNewTab?(route: Route): void;
  onCreateProject(): void;
  onManageProject(project: ProjectDto): void;
  onProjectDeleted(projectId: string): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const snapshots = useWorkspaceSnapshots(projects);
  const [filter, setFilter] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ projectId: string; position: "before" | "after" }>();
  const [tabMenu, setTabMenu] = useState<ResourceContextMenuState<ProjectDirectoryResource>>();
  const [projectAction, setProjectAction] = useState<{
    kind: "rename" | "delete";
    project: ProjectDto;
  }>();
  const renameProject = useMutation({
    mutationFn: ({ project, label }: { project: ProjectDto; label: string }) =>
      api.updateProject(project.id, { label }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      setProjectAction(undefined);
    },
  });
  const deleteProject = useMutation({
    mutationFn: (project: ProjectDto) => api.deleteProject(project.id),
    onSuccess: (_deleted, project) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      setProjectAction(undefined);
      onProjectDeleted(project.id);
    },
  });
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
        const route = openProjectRoute(snapshot);
        const menuResource = { route, project: snapshot.project };
        return <ResourceRow
          key={snapshot.project.id}
          label={snapshot.project.label}
          description={`${snapshot.project.hostPath}${recent ? " · Recent chat" : " · No Project chats"}`}
          icon={<FolderOutlinedIcon />}
          meta={running > 0 ? <Chip size="small" color="info" label={`${running} running`} sx={{ ml: 1 }} /> : null}
          onOpen={() => onNavigate(route)}
          onContextMenu={(anchor) => setTabMenu({ anchor, resource: menuResource })}
          draggable
          onDragStart={() => setDraggedProjectId(snapshot.project.id)}
          onDragEnd={() => {
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
          <Tooltip title={`Actions for ${snapshot.project.label}`}>
            <IconButton
              aria-label={`Actions for ${snapshot.project.label}`}
              onClick={(event) => setTabMenu({ anchor: event.currentTarget, resource: menuResource })}
            >
              <MoreVertIcon />
            </IconButton>
          </Tooltip>
          }
        />;
      })}
    {filteredSnapshots.length === 0 ? <CollectionEmptyState
      title={projects.length === 0 && !filter.trim() ? "No Projects yet" : `No Projects match “${filter.trim()}”`}
      detail={projects.length === 0 && !filter.trim() ? "Create a Project to get started." : "Try a Project name, folder, or Chat title."}
    /> : null}
    <ResourceContextMenu
      state={tabMenu}
      onClose={() => setTabMenu(undefined)}
      onOpenInNewTab={onOpenInNewTab ? ({ route }) => onOpenInNewTab(route) : undefined}
      actions={[
        {
          id: "settings",
          label: "Project Settings",
          icon: <SettingsOutlinedIcon fontSize="small" />,
          onSelect: ({ project }) => onManageProject(project),
        },
        {
          id: "rename",
          label: "Rename",
          icon: <EditOutlinedIcon fontSize="small" />,
          onSelect: ({ project }) => setProjectAction({ kind: "rename", project }),
        },
        {
          id: "delete",
          label: "Delete",
          icon: <DeleteOutlineIcon fontSize="small" />,
          color: "error",
          onSelect: ({ project }) => setProjectAction({ kind: "delete", project }),
        },
      ]}
    />
    <TextInputDialog
      open={projectAction?.kind === "rename"}
      title="Rename Project"
      label="Project name"
      initialValue={projectAction?.project.label ?? ""}
      confirmLabel="Save"
      pendingLabel="Saving…"
      pending={renameProject.isPending}
      error={renameProject.isError ? String(renameProject.error) : undefined}
      validate={(value) => value.trim() ? undefined : "Enter a Project name."}
      onCancel={() => {
        renameProject.reset();
        setProjectAction(undefined);
      }}
      onConfirm={(label) => {
        if (projectAction?.kind === "rename")
          renameProject.mutate({ project: projectAction.project, label: label.trim() });
      }}
    />
    <DestructiveConfirmDialog
      open={projectAction?.kind === "delete"}
      title="Delete Project?"
      confirmLabel="Delete Permanently"
      pendingLabel="Deleting…"
      pending={deleteProject.isPending}
      error={deleteProject.isError ? String(deleteProject.error) : undefined}
      onCancel={() => {
        deleteProject.reset();
        setProjectAction(undefined);
      }}
      onConfirm={() => {
        if (projectAction?.kind === "delete") deleteProject.mutate(projectAction.project);
      }}
    >
      <Typography sx={{ pt: 1 }}>
        This permanently deletes its Project chats, Agents, Runs, work items, and Files &amp; Results. The working folder and its source files are not deleted.
      </Typography>
    </DestructiveConfirmDialog>
  </CollectionWorkspace>;
}
