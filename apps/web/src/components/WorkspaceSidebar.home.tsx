import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  IconButton,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  TriggerDefinitionDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import {
  reorderStableIds,
  sortWorkspaceResources,
  starredWorkspaceResources,
  workspaceResourceSort,
} from "../resourcePreferences";
import type { Route } from "../routing";
import type { WorkspaceProjectSnapshot } from "../workspaceNavigation";
import { starColor } from "./WorkspaceSidebar.helpers";
import { SharedSidebarPanel } from "./WorkspaceSidebar.parts";

type DraggedResource = {
  kind: "home" | "chat" | "agent" | "trigger";
  id: string;
};

interface HomeSidebarPanelProps {
  snapshots: WorkspaceProjectSnapshot[];
  triggers: TriggerDefinitionDto[];
  preferences: WorkspacePreferencesDto;
  filter: string;
  drawer: boolean;
  draggedResource?: DraggedResource;
  onFilterChange(value: string): void;
  onDraggedResourceChange(value: DraggedResource | undefined): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigate(route: Route): void;
  onOpenResourceMenu(anchor: HTMLElement, route: Route): void;
  onOpenAllMessages(): void;
  onViewHome(): void;
  onToggleStar(
    kind: "project" | "conversation" | "agent" | "trigger",
    id: string,
  ): void;
}

export function HomeSidebarPanel({
  snapshots,
  triggers,
  preferences,
  filter,
  drawer,
  draggedResource,
  onFilterChange,
  onDraggedResourceChange,
  onPreferences,
  onNavigate,
  onOpenResourceMenu,
  onOpenAllMessages,
  onViewHome,
  onToggleStar,
}: HomeSidebarPanelProps): JSX.Element {
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const starredResourceIds = starredWorkspaceResources(preferences);
  const agentDestinations = new Map(
    snapshots.flatMap(snapshot =>
      snapshot.agents.map(
        agent => [agent.id, { agent, project: snapshot.project }] as const,
      ),
    ),
  );
  const resourceCatalog = [
    ...snapshots.map(snapshot => ({
      id: `project:${snapshot.project.id}`,
      title: snapshot.project.label,
      detail: "Project",
      updatedAt: snapshot.project.lastUsedAt ?? snapshot.project.createdAt,
      route: { kind: "project", projectId: snapshot.project.id } as Route,
      icon: <FolderOutlinedIcon fontSize="small" />,
    })),
    ...snapshots.flatMap(snapshot =>
      snapshot.conversations
        .filter(conversation => !conversation.archived)
        .map(conversation => ({
          id: `conversation:${conversation.id}`,
          title: conversation.title,
          detail: `${snapshot.project.label} · Chat`,
          updatedAt: conversation.updatedAt,
          route: {
            kind: "conversation",
            projectId: snapshot.project.id,
            conversationId: conversation.id,
          } as Route,
          icon: <ChatBubbleOutlineIcon fontSize="small" />,
        })),
    ),
    ...snapshots.flatMap(snapshot =>
      snapshot.agents
        .filter(agent => !agent.archived)
        .map(agent => ({
          id: `agent:${agent.id}`,
          title: agent.title,
          detail: `${snapshot.project.label} · Agent`,
          updatedAt: agent.updatedAt,
          route: {
            kind: "agent",
            projectId: snapshot.project.id,
            agentId: agent.id,
          } as Route,
          icon: <SmartToyOutlinedIcon fontSize="small" />,
        })),
    ),
    ...triggers.flatMap(trigger => {
      const destination = agentDestinations.get(trigger.agentId);
      return destination
        ? [{
            id: `trigger:${trigger.id}`,
            title: trigger.name,
            detail: `${destination.project.label} · Trigger`,
            updatedAt: trigger.updatedAt,
            route: {
              kind: "agent",
              projectId: destination.project.id,
              agentId: destination.agent.id,
              view: "triggers",
            } as Route,
            icon: <BoltOutlinedIcon fontSize="small" />,
          }]
        : [];
    }),
  ];
  const filteredResources = resourceCatalog.filter(
    item =>
      !normalizedFilter ||
      `${item.title} ${item.detail}`
        .toLocaleLowerCase()
        .includes(normalizedFilter),
  );
  const resources = sortWorkspaceResources(
    filteredResources,
    workspaceResourceSort(preferences, "home"),
    preferences.homeOrder,
    item => item.id,
    item => item.title,
    item => item.updatedAt,
  );
  const starredResources = resources.filter(item =>
    starredResourceIds.has(item.id),
  );
  const unstarredResources = resources.filter(
    item => !starredResourceIds.has(item.id),
  );

  const rows = (items: typeof resources) =>
    items.map(item => {
      const starred = starredResourceIds.has(item.id);
      return (
        <Stack
          key={item.id}
          direction="row"
          draggable
          onDragStart={() => onDraggedResourceChange({ kind: "home", id: item.id })}
          onDragEnd={() => onDraggedResourceChange(undefined)}
          onDragOver={event => {
            if (draggedResource?.kind === "home") event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            if (draggedResource?.kind === "home")
              onPreferences({
                homeSort: "custom",
                homeOrder: reorderStableIds(
                  preferences.homeOrder,
                  resources.map(resource => resource.id),
                  draggedResource.id,
                  item.id,
                ),
              });
            onDraggedResourceChange(undefined);
          }}
          onContextMenu={event => {
            event.preventDefault();
            onOpenResourceMenu(event.currentTarget, item.route);
          }}
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <ListItemButton
            onClick={() => onNavigate(item.route)}
            sx={{ borderRadius: 1.25, px: 1, py: 0.65, minWidth: 0 }}
          >
            <ListItemIcon sx={{ minWidth: 38 }}>{item.icon}</ListItemIcon>
            <ListItemText
              primary={item.title}
              secondary={item.detail}
              primaryTypographyProps={{
                noWrap: true,
                fontSize: 13,
                fontWeight: starred ? 750 : 500,
              }}
              secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
            />
          </ListItemButton>
          <Tooltip
            title={starred ? `Unstar ${item.title}` : `Star ${item.title}`}
          >
            <IconButton
              size="small"
              aria-label={`${starred ? "Unstar" : "Star"} ${item.title}`}
              onClick={() => {
                const [kind, id] = item.id.split(":", 2) as [
                  "project" | "conversation" | "agent" | "trigger",
                  string,
                ];
                onToggleStar(kind, id);
              }}
            >
              {starred ? (
                <StarRoundedIcon sx={{ color: starColor }} fontSize="small" />
              ) : (
                <StarBorderRoundedIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Stack>
      );
    });

  return (
    <SharedSidebarPanel
      icon={<HomeOutlinedIcon />}
      title="Home"
      total={resourceCatalog.length}
      searchLabel="Search Home"
      searchValue={filter}
      onSearchValueChange={onFilterChange}
      starredRows={rows(starredResources)}
      allRows={rows(unstarredResources)}
      empty={
        resources.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Your work will appear here.
          </Typography>
        ) : undefined
      }
      newLabel="All Messages"
      newIcon={<ChatBubbleOutlineIcon />}
      onNew={onOpenAllMessages}
      viewAllLabel="View Home"
      viewAllIcon={<HomeOutlinedIcon />}
      onViewAll={onViewHome}
      drawer={drawer}
    />
  );
}
