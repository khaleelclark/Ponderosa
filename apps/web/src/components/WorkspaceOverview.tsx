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
import type { ProjectDto, WorkspacePreferencesDto, WorkspaceProjectDirectoryItemDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useWorkspaceDirectory, workspaceDirectoryItems } from "../hooks/useWorkspaceDirectory";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import { resourcePreferenceKey, starredWorkspaceResources, toggleWorkspaceResourceStar } from "../resourcePreferences";
import { TextInputDialog } from "./ConfirmationDialogs";
import { ProjectDeletionDialog } from "./ProjectDeletionDialog";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";
import {
  CollectionDirectoryControls,
  CollectionEmptyState,
  CollectionTimestamp,
  CollectionToolbar,
  CollectionWorkspace,
  ResourceRow,
} from "./CollectionPrimitives";

function openProjectRoute(item: WorkspaceProjectDirectoryItemDto): Route {
  return { kind: "project", projectId: item.project.id };
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

export function AllProjectsView({ projects, preferences, onNavigate, onOpenInNewTab, onCreateProject, onProjectDeleted, onPreferences }: {
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onOpenInNewTab?(route: Route): void;
  onCreateProject(): void;
  onProjectDeleted(projectId: string): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const directoryQuery =
    useWorkspaceDirectory<WorkspaceProjectDirectoryItemDto>("project", {
      search: filter,
      preferenceRevision: preferences.updatedAt,
    });
  const directory = workspaceDirectoryItems(directoryQuery.data?.pages);
  const filteredSnapshots = [
    ...directory.starredItems,
    ...directory.items,
  ];
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("project") });
      setProjectAction(undefined);
    },
  });
  const starredResourceIds = starredWorkspaceResources(preferences);
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
    detail={filter.trim() ? `${directory.total} matching ${directory.total === 1 ? "Project" : "Projects"}` : `${directory.total} ${directory.total === 1 ? "Project" : "Projects"} across Ponderosa`}
    primaryAction={<Button variant="contained" startIcon={<AddIcon />} onClick={onCreateProject} sx={{ whiteSpace: "nowrap" }}>New Project</Button>}
    toolbar={<CollectionToolbar search={filter} onSearch={setFilter} searchLabel="Search Projects" reorderHint>
      <CollectionDirectoryControls
        sort={preferences.projectSort}
        onSort={projectSort => onPreferences({ projectSort })}
      />
    </CollectionToolbar>}
    listLabel="All Projects"
  >
    {filteredSnapshots.map((snapshot, index) => {
        const recent = snapshot.recentConversation;
        const running = snapshot.runningAgentCount;
        const route = openProjectRoute(snapshot);
        const menuResource = { route, project: snapshot.project };
        return <ResourceRow
          key={snapshot.project.id}
          label={snapshot.project.label}
          description={`${snapshot.project.hostPath}${recent ? " · Recent chat" : " · No Project chats"}`}
          icon={<FolderOutlinedIcon />}
          meta={
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              {running > 0 ? (
                <Chip size="small" color="info" label={`${running} running`} />
              ) : null}
              <CollectionTimestamp
                value={recent?.updatedAt ?? snapshot.project.lastUsedAt ?? snapshot.project.createdAt}
                hideBelow="md"
              />
            </Box>
          }
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
          onKeyboardMove={(direction) => {
            const target =
              filteredSnapshots[
                direction === "up" ? index - 1 : index + 1
              ];
            if (!target) return false;
            const patch = projectDropPreferencePatch(
              projects.map(project => project.id),
              snapshot.project.id,
              target.project.id,
              direction === "up" ? "before" : "after",
            );
            if (!patch) return false;
            onPreferences(patch);
            return {
              position: direction === "up" ? index : index + 2,
              total: filteredSnapshots.length,
            };
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
              data-resource-menu-trigger
              aria-label={`Actions for ${snapshot.project.label}`}
              aria-haspopup="menu"
              aria-expanded={
                tabMenu?.resource.project.id === snapshot.project.id
              }
              onClick={(event) => setTabMenu({ anchor: event.currentTarget, resource: menuResource })}
            >
              <MoreVertIcon />
            </IconButton>
          </Tooltip>
          }
        />;
      })}
    {directoryQuery.hasNextPage ? <Button
      color="inherit"
      disabled={directoryQuery.isFetchingNextPage}
      onClick={() => void directoryQuery.fetchNextPage()}
    >
      {directoryQuery.isFetchingNextPage
        ? "Loading…"
        : preferences.projectSort === "last_used"
          ? "Load older Projects"
          : "Load more Projects"}
    </Button> : null}
    {filteredSnapshots.length === 0 ? <CollectionEmptyState
      title={directory.total === 0 && !filter.trim() ? "No Projects Yet" : `No Projects match “${filter.trim()}”`}
      detail={directory.total === 0 && !filter.trim() ? "Create a Project to get started." : "Try a Project name, folder, or Chat title."}
      action={filter.trim() ? {
        label: "Clear Search",
        onClick: () => setFilter(""),
      } : undefined}
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
          onSelect: ({ project }) =>
            onNavigate({ kind: "project", projectId: project.id, view: "settings" }),
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
    {projectAction?.kind === "delete" ? <ProjectDeletionDialog
      project={projectAction.project}
      open={projectAction?.kind === "delete"}
      onClose={() => setProjectAction(undefined)}
      onDeleted={(projectId) => {
        setProjectAction(undefined);
        onProjectDeleted(projectId);
      }}
    /> : null}
  </CollectionWorkspace>;
}
