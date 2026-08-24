import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
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
  AgentHealthDto,
  TriggerDefinitionDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AgentStatus } from "../agents";
import {
  sortWorkspaceResources,
  starredWorkspaceResources,
} from "../resourcePreferences";
import type { Route } from "../routing";
import type { WorkspaceProjectSnapshot } from "../workspaceNavigation";
import {
  markWorkspaceResourceUsed,
  useWorkspaceResourceRecency,
  workspaceResourceRecencyTime,
} from "../workspaceRecency";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { starColor } from "./WorkspaceSidebar.helpers";
import { SharedSidebarPanel } from "./WorkspaceSidebar.parts";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";

interface HomeSidebarPanelProps {
  snapshots: WorkspaceProjectSnapshot[];
  triggers: TriggerDefinitionDto[];
  preferences: WorkspacePreferencesDto;
  filter: string;
  drawer: boolean;
  onFilterChange(value: string): void;
  onNavigate(route: Route): void;
  onOpenResourceMenu(anchor: HTMLElement, route: Route): void;
  onOpenAllMessages(): void;
  onViewHome(): void;
  header?: ReactNode;
  title?: string;
  includeProjects?: boolean;
  showAllMessages?: boolean;
  hideSearch?: boolean;
  viewAllLabel?: string;
  viewAllIcon?: ReactNode;
  onToggleStar(
    kind: "project" | "conversation" | "agent" | "trigger",
    id: string,
  ): void;
}

type HomeResource = {
  id: string;
  title: string;
  detail: string;
  updatedAt: string;
  route: Route;
  icon: JSX.Element;
  status?: AgentStatus;
  health?: AgentHealthDto;
};

export function HomeSidebarPanel({
  snapshots,
  triggers,
  preferences,
  filter,
  drawer,
  onFilterChange,
  onNavigate,
  onOpenResourceMenu,
  onOpenAllMessages,
  onViewHome,
  onToggleStar,
  header,
  title = "Home",
  includeProjects = true,
  showAllMessages = true,
  hideSearch = false,
  viewAllLabel = "View Home",
  viewAllIcon = <HomeOutlinedIcon />,
}: HomeSidebarPanelProps): JSX.Element {
  const queryClient = useQueryClient();
  const workspaceConnection = useWorkspaceConnection();
  const recencyQuery = useWorkspaceResourceRecency();
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const starredResourceIds = starredWorkspaceResources(preferences);
  const agentStatusById = new Map<string, AgentStatus>(
    snapshots.flatMap(snapshot =>
      snapshot.health.map(entry => [entry.agentId, entry.status] as const),
    ),
  );
  const agentHealthById = new Map(
    snapshots.flatMap(snapshot =>
      snapshot.health.map(entry => [entry.agentId, entry] as const),
    ),
  );
  const agentNamesById = new Map(
    snapshots.flatMap(snapshot =>
      snapshot.agents.map(agent => [agent.id, agent.title] as const),
    ),
  );
  const agentDestinations = new Map(
    snapshots.flatMap(snapshot =>
      snapshot.agents.map(
        agent => [agent.id, { agent, project: snapshot.project }] as const,
      ),
    ),
  );
  const resourceCatalog: HomeResource[] = [
    ...(includeProjects ? snapshots.map(snapshot => ({
      id: `project:${snapshot.project.id}`,
      title: snapshot.project.label,
      detail: "Project",
      updatedAt: snapshot.project.lastUsedAt ?? snapshot.project.createdAt,
      route: { kind: "project", projectId: snapshot.project.id } as Route,
      icon: <FolderOutlinedIcon fontSize="small" />,
    })) : []),
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
          status: agentStatusById.get(agent.id) ?? "idle",
          health: agentHealthById.get(agent.id),
        })),
    ),
    ...triggers.flatMap(trigger => {
      const destination = agentDestinations.get(trigger.agentId);
      return destination
        ? [{
            id: `trigger:${trigger.id}`,
            title: trigger.name,
            detail: `${destination.project.label} · Automation`,
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
    "last_used",
    [],
    item => item.id,
    item => item.title,
    item => workspaceResourceRecencyTime(recencyQuery.data, item.id, item.updatedAt),
  );
  const starredResources = resources.filter(item =>
    starredResourceIds.has(item.id),
  );
  const unstarredResources = resources
    .filter(item => !starredResourceIds.has(item.id))
    .slice(0, normalizedFilter ? undefined : 12);

  const rows = (items: typeof resources) =>
    items.map(item => {
      const starred = starredResourceIds.has(item.id);
      return (
        <Stack
          key={item.id}
          direction="row"
          onContextMenu={event => {
            event.preventDefault();
            onOpenResourceMenu(event.currentTarget, item.route);
          }}
          sx={{ alignItems: "center", mb: 0.25, minWidth: 0, width: "100%" }}
        >
          <ListItemButton
            onClick={() => {
              if (item.id.startsWith("trigger:")) {
                markWorkspaceResourceUsed(
                  queryClient,
                  "trigger",
                  item.id.slice("trigger:".length),
                );
              }
              onNavigate(item.route);
            }}
            sx={{ borderRadius: 1.25, px: 1, py: 0.65, minWidth: 0, flex: 1 }}
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
            {item.status ? (
              <AgentStatusIndicator
                status={item.status}
                health={item.health}
                connectionStatus={workspaceConnection.status}
                phaseEvidenceFresh={workspaceConnection.phaseEvidenceFresh}
                agentNameForId={agentId => agentNamesById.get(agentId)}
              />
            ) : null}
          </ListItemButton>
          <Tooltip
            title={starred ? `Unstar ${item.title}` : `Star ${item.title}`}
          >
            <IconButton
              size="small"
              aria-label={`${starred ? "Unstar" : "Star"} ${item.title}`}
              sx={{ flex: "0 0 40px" }}
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
      header={header}
      icon={<HomeOutlinedIcon />}
      title={title}
      total={resourceCatalog.length}
      searchLabel={`Search ${title}`}
      searchValue={filter}
      onSearchValueChange={onFilterChange}
      hideSearch={hideSearch}
      topContent={showAllMessages ? (
        <ListItemButton
          onClick={onOpenAllMessages}
          onContextMenu={event => {
            event.preventDefault();
            onOpenResourceMenu(event.currentTarget, { kind: "allChat" });
          }}
          sx={{
            borderRadius: 1.25,
            px: 1,
            py: 0.75,
            mb: 1.5,
          }}
        >
          <ListItemIcon sx={{ minWidth: 38 }}>
            <ForumOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Messages Across Ponderosa"
            secondary="Every Project, Chat, and Agent"
            primaryTypographyProps={{
              noWrap: true,
              fontSize: 13,
              fontWeight: 700,
            }}
            secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
          />
        </ListItemButton>
      ) : undefined}
      starredRows={rows(starredResources)}
      allRows={rows(unstarredResources)}
      empty={
        resources.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Your work will appear here.
          </Typography>
        ) : undefined
      }
      viewAllLabel={viewAllLabel}
      viewAllIcon={viewAllIcon}
      onViewAll={onViewHome}
      onViewAllContextMenu={anchor =>
        onOpenResourceMenu(anchor, { kind: "home" })
      }
      drawer={drawer}
    />
  );
}
