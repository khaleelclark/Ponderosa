import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Badge,
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  ConversationDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { agentStatusColor, agentStatusLabel } from "../agents";
import { api } from "../api";
import {
  useProjectAgentHealth,
  useProjectAgents,
  useProjectConversations,
} from "../hooks/useProjectCollections";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import {
  reorderStableIds,
  resourcePreferenceKey,
  sortWorkspaceResources,
  starredWorkspaceResources,
  toggleWorkspaceResourceStar,
  workspaceResourceSort,
} from "../resourcePreferences";
import {
  projectDisambiguator,
  workspaceAgents,
  workspaceCounts,
  type WorkspaceProjectSnapshot,
} from "../workspaceNavigation";
import { clampWorkspaceSidebarWidth } from "../workspaceSidebarState";
import { ponderosaLayoutTokens } from "../theme";
import {
  ResourceContextMenu,
  type ResourceContextMenuState,
} from "./ResourceContextMenu";
import { IconTitle } from "./IconTitle";

const SIDEBAR_RAIL_WIDTH = ponderosaLayoutTokens.sidebarRailWidth;
const SIDEBAR_PANEL_WIDTH = ponderosaLayoutTokens.sidebarPanelWidth;

function projectSnapshots(
  projects: ProjectDto[],
  conversations: Array<ConversationDto[] | undefined>,
  agents: Array<Awaited<ReturnType<typeof api.listAgents>> | undefined>,
  health: Array<Awaited<ReturnType<typeof api.getAgentHealth>> | undefined>,
): WorkspaceProjectSnapshot[] {
  return projects.map((project, index) => ({
    project,
    conversations: conversations[index] ?? [],
    agents: agents[index] ?? [],
    health: health[index]?.agents ?? [],
  }));
}

const sidebarSurface = "var(--ponderosa-sidebar)";
const railSurface = "var(--ponderosa-rail)";
const starColor = "var(--ponderosa-star)";

function SidebarSectionHeading({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <Typography
      variant="subtitle2"
      color="text.secondary"
      sx={{
        px: 1,
        mb: 0.5,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: ".06em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </Typography>
  );
}

function SharedSidebarPanel({
  icon,
  title,
  total,
  searchLabel,
  searchValue,
  onSearchValueChange,
  topContent,
  starredRows,
  allRows,
  empty,
  newLabel,
  newIcon,
  onNew,
  newDisabled = false,
  viewAllLabel,
  viewAllIcon,
  onViewAll,
  drawer,
}: {
  icon: ReactNode;
  title: string;
  total: number;
  searchLabel: string;
  searchValue: string;
  onSearchValueChange(value: string): void;
  topContent?: ReactNode;
  starredRows: ReactNode;
  allRows: ReactNode;
  empty?: ReactNode;
  newLabel: string;
  newIcon?: ReactNode;
  onNew(): void;
  newDisabled?: boolean;
  viewAllLabel: string;
  viewAllIcon: ReactNode;
  onViewAll(): void;
  drawer: boolean;
}): JSX.Element {
  return (
    <Box
      data-sidebar-layout="shared-resource"
      data-sidebar-panel={title.toLocaleLowerCase()}
      sx={{
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto auto minmax(0, 1fr) auto",
        bgcolor: sidebarSurface,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "baseline",
          pl: 2.25,
          pr: drawer ? 7 : 2.25,
          pt: 2,
          pb: 1.25,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <IconTitle icon={icon} title={title} />
        </Box>
        <Typography variant="caption" color="text.secondary">
          {total} total
        </Typography>
      </Stack>
      <Box sx={{ px: 1.75, pb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          value={searchValue}
          onChange={event => onSearchValueChange(event.target.value)}
          placeholder={searchLabel}
          inputProps={{ "aria-label": searchLabel }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
      </Box>
      <Box
        data-testid="workspace-navigation-scroll"
        className="ponderosa-scroll"
        sx={{ minHeight: 0, overflowY: "auto", px: 1.25, pb: 1.5 }}
      >
        {topContent}
        <Box component="section" data-sidebar-section="starred" sx={{ mb: 2 }}>
          <SidebarSectionHeading>Starred</SidebarSectionHeading>
          <List disablePadding>{starredRows}</List>
        </Box>
        <Box component="section" data-sidebar-section="all">
          <SidebarSectionHeading>
            {title === "Home" ? "All" : `All ${title}`}
          </SidebarSectionHeading>
          <List disablePadding>{allRows}</List>
        </Box>
        {empty}
      </Box>
      <Box
        sx={{
          p: 1.75,
          boxShadow: theme => `inset 0 1px 0 ${theme.palette.divider}`,
        }}
      >
        <Button
          fullWidth
          color="inherit"
          startIcon={newIcon ?? <AddIcon />}
          onClick={onNew}
          disabled={newDisabled}
          sx={{
            justifyContent: "flex-start",
            color: "text.secondary",
          }}
        >
          {newLabel}
        </Button>
        <Button
          fullWidth
          startIcon={viewAllIcon}
          onClick={onViewAll}
          sx={{
            justifyContent: "flex-start",
            color: "text.secondary",
          }}
        >
          {viewAllLabel}
        </Button>
      </Box>
    </Box>
  );
}

function RailButton({
  label,
  selected = false,
  badge,
  badgeColor = "primary",
  children,
  onClick,
}: {
  label: string;
  selected?: boolean;
  badge?: number;
  badgeColor?: "primary" | "info" | "error";
  children: ReactNode;
  onClick(): void;
}): JSX.Element {
  return (
    <Tooltip title={label} placement="right">
      <IconButton
        aria-label={label}
        onClick={onClick}
        sx={{
          width: 48,
          height: 48,
          borderRadius: 1,
          color: selected
            ? "var(--ponderosa-rail-foreground-active)"
            : "var(--ponderosa-rail-foreground)",
          bgcolor: selected ? "rgba(124, 191, 138, .14)" : "transparent",
          "&:hover": {
            bgcolor: selected
              ? "rgba(124, 191, 138, .20)"
              : "rgba(178, 187, 180, .10)",
            color: "#E6E7DF",
          },
        }}
      >
        <Badge color={badgeColor} badgeContent={badge} max={99}>
          {children}
        </Badge>
      </IconButton>
    </Tooltip>
  );
}

export function WorkspaceSidebar({
  projects,
  preferences,
  route,
  notifications,
  drawer = false,
  onNavigate,
  onOpenInNewTab,
  onCreateProject,
  onCreateChat,
  onCreateAgent,
  onCreateTrigger,
  onPreferences,
  onRenameConversation,
  onDeleteConversation,
  onSearch,
  collapsed = false,
  width = SIDEBAR_RAIL_WIDTH + SIDEBAR_PANEL_WIDTH,
  onCollapsedChange,
  onWidthChange,
}: {
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  route: Route;
  notifications: WorkspaceNotificationDto[];
  drawer?: boolean;
  onNavigate(route: Route): void;
  onOpenInNewTab?(route: Route): void;
  onCreateProject(): void;
  onCreateChat?(): void;
  onCreateAgent?(): void;
  onCreateTrigger?(): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onSearch?(): void;
  collapsed?: boolean;
  width?: number;
  onCollapsedChange?(collapsed: boolean): void;
  onWidthChange?(width: number): void;
}): JSX.Element {
  const conversationQueries = useProjectConversations(projects);
  const agentQueries = useProjectAgents(projects);
  const healthQueries = useProjectAgentHealth(projects);
  const snapshots = projectSnapshots(
    projects,
    conversationQueries.map(query => query.data),
    agentQueries.map(query => query.data),
    healthQueries.map(query => query.data),
  );
  const counts = workspaceCounts(snapshots, notifications);
  const [sidebarSection, setSidebarSection] = useState<
    "home" | "projects" | "chats" | "agents" | "triggers" | "wiki" | "settings"
  >(() =>
    route.kind === "allChats"
      ? "chats"
      : route.kind === "allAgents"
        ? "agents"
        : route.kind === "allTriggers"
          ? "triggers"
          : route.kind === "projects"
            ? "projects"
            : route.kind === "wiki"
              ? "wiki"
              : route.kind === "settings" || route.kind === "usage"
                ? "settings"
                : "home",
  );
  const [filter, setFilter] = useState("");
  const [draggedResource, setDraggedResource] = useState<{
    kind: "home" | "chat" | "agent" | "trigger";
    id: string;
  }>();
  type SidebarMenuResource = { route: Route; conversation?: ConversationDto };
  const [menu, setMenu] =
    useState<ResourceContextMenuState<SidebarMenuResource>>();
  const openResourceMenu = (
    anchor: HTMLElement,
    route: Route,
    conversation?: ConversationDto,
  ) =>
    setMenu({
      anchor,
      resource: { route, ...(conversation ? { conversation } : {}) },
    });
  useEffect(() => {
    // Directory workplaces are destinations, not sidebar-section commands.
    // Keep the operator's current panel, filter, and scroll state when one opens.
    const section =
      route.kind === "wiki"
        ? "wiki"
        : route.kind === "settings" || route.kind === "usage"
          ? "settings"
          : undefined;
    if (!section) return;
    setSidebarSection(section);
    setFilter("");
  }, [route.kind]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const showingAgents = sidebarSection === "agents";
  const showingChats = sidebarSection === "chats";
  const showingProjects = sidebarSection === "projects";
  const showingTriggers = sidebarSection === "triggers";
  const showingHome = sidebarSection === "home";
  const showingWiki = sidebarSection === "wiki";
  const showingSettings = sidebarSection === "settings";
  const allTriggersQuery = useQuery({
    queryKey: queryKeys.triggers.all,
    queryFn: () => api.listAllTriggers(),
    enabled: showingTriggers || showingHome,
    staleTime: 5_000,
  });
  const wikiIndexQuery = useQuery({
    queryKey: ["wiki", "index"],
    queryFn: () => api.getWikiIndex(),
    enabled: showingWiki,
    staleTime: 60_000,
  });
  const showNavigation = (next?: Route) => {
    setSidebarSection("home");
    setFilter("");
    if (next) onNavigate(next);
  };
  const revealSection = (section: typeof sidebarSection) => {
    if (!drawer && section === sidebarSection && !collapsed) {
      onCollapsedChange?.(true);
      return;
    }
    setSidebarSection(section);
    setFilter("");
    if (!drawer && collapsed) onCollapsedChange?.(false);
  };
  const showAgents = () => revealSection("agents");
  const showChats = () => revealSection("chats");
  const showProjects = () => revealSection("projects");
  const showHome = () => revealSection("home");
  const openAllProjects = () => {
    setSidebarSection("projects");
    onNavigate({ kind: "projects" });
  };
  const showTriggers = () => revealSection("triggers");
  const showWiki = () => revealSection("wiki");
  const openTriggerManager = (projectId: string, agentId: string) => {
    onNavigate({ kind: "agent", projectId, agentId, view: "triggers" });
  };

  const openProject = (snapshot: WorkspaceProjectSnapshot) => {
    onNavigate({ kind: "project", projectId: snapshot.project.id });
  };
  const openChat = (project: ProjectDto, conversation: ConversationDto) => {
    void api.markProjectUsed(project.id, conversation.id);
    void api.clearConversationNotifications(conversation.id);
    onNavigate({
      kind: "conversation",
      projectId: project.id,
      conversationId: conversation.id,
    });
  };

  const rail = (
    <Box
      component="nav"
      aria-label="Primary navigation"
      sx={{
        width: drawer ? 64 : SIDEBAR_RAIL_WIDTH,
        minWidth: drawer ? 64 : SIDEBAR_RAIL_WIDTH,
        minHeight: 0,
        borderRight: 1,
        borderColor: "var(--ponderosa-rail-border)",
        bgcolor: railSurface,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        justifyItems: "center",
        py: 1.5,
      }}
    >
      <Stack spacing={0.4} sx={{ alignItems: "center" }}>
        <Tooltip title="Ponderosa" placement="right">
          <Box
            component="img"
            src="/icons/app-icon.png"
            alt="Ponderosa"
            sx={{
              width: 42,
              height: 42,
              mb: 3.25,
              p: 0.25,
              borderRadius: 1,
              objectFit: "cover",
            }}
          />
        </Tooltip>
        <RailButton label="Home" selected={showingHome} onClick={showHome}>
          <HomeOutlinedIcon />
        </RailButton>
        <Box
          aria-hidden
          sx={{
            width: 40,
            borderTop: 1,
            borderColor: "var(--ponderosa-rail-border)",
            my: 0.5,
          }}
        />
        <RailButton
          label="Projects"
          selected={showingProjects}
          onClick={showProjects}
        >
          <FolderOutlinedIcon />
        </RailButton>
        <RailButton label="Chats" selected={showingChats} onClick={showChats}>
          <ChatBubbleOutlineIcon />
        </RailButton>
        <RailButton
          label="Agents"
          selected={showingAgents}
          badge={counts.running || undefined}
          badgeColor="info"
          onClick={showAgents}
        >
          <SmartToyOutlinedIcon />
        </RailButton>
        <RailButton
          label="Triggers"
          selected={showingTriggers}
          onClick={showTriggers}
        >
          <BoltOutlinedIcon />
        </RailButton>
      </Stack>
      <Box />
      <Stack spacing={0.65} sx={{ alignItems: "center" }}>
        <Box
          aria-hidden
          sx={{
            width: 40,
            borderTop: 1,
            borderColor: "var(--ponderosa-rail-border)",
            mb: 0.25,
          }}
        />
        <RailButton label="Wiki" selected={showingWiki} onClick={showWiki}>
          <MenuBookOutlinedIcon />
        </RailButton>
        <RailButton
          label="Settings"
          selected={showingSettings}
          onClick={() => revealSection("settings")}
        >
          <SettingsOutlinedIcon />
        </RailButton>
      </Stack>
    </Box>
  );

  const starredResourceIds = starredWorkspaceResources(preferences);
  const projectList = sortWorkspaceResources(
    snapshots.filter(
      snapshot =>
        !normalizedFilter ||
        `${snapshot.project.label} ${snapshot.project.hostPath}`
          .toLocaleLowerCase()
          .includes(normalizedFilter),
    ),
    preferences.projectSort,
    preferences.projectOrder,
    snapshot => snapshot.project.id,
    snapshot => snapshot.project.label,
    snapshot => snapshot.project.lastUsedAt ?? snapshot.project.createdAt,
  );
  const homeAgentDestinations = new Map(
    snapshots.flatMap(snapshot =>
      snapshot.agents.map(
        agent => [agent.id, { agent, project: snapshot.project }] as const,
      ),
    ),
  );
  const homeResourceCatalog = [
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
    ...(allTriggersQuery.data ?? []).flatMap(trigger => {
      const destination = homeAgentDestinations.get(trigger.agentId);
      return destination
        ? [
            {
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
            },
          ]
        : [];
    }),
  ];
  const allHomeResources = homeResourceCatalog.filter(
    item =>
      !normalizedFilter ||
      `${item.title} ${item.detail}`
        .toLocaleLowerCase()
        .includes(normalizedFilter),
  );
  const homeResources = sortWorkspaceResources(
    allHomeResources,
    workspaceResourceSort(preferences, "home"),
    preferences.homeOrder,
    item => item.id,
    item => item.title,
    item => item.updatedAt,
  );
  const starredHomeResources = homeResources.filter(item =>
    starredResourceIds.has(item.id),
  );
  const allUnstarredHomeResources = homeResources.filter(
    item => !starredResourceIds.has(item.id),
  );
  const toggleStar = (
    kind: "project" | "conversation" | "agent" | "trigger",
    id: string,
  ) => onPreferences(toggleWorkspaceResourceStar(preferences, kind, id));

  const homeResourceRows = (items: typeof homeResources) =>
    items.map(item => {
      const starred = starredResourceIds.has(item.id);
      return (
        <Stack
          key={item.id}
          direction="row"
          draggable
          onDragStart={() => setDraggedResource({ kind: "home", id: item.id })}
          onDragEnd={() => setDraggedResource(undefined)}
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
                  homeResources.map(resource => resource.id),
                  draggedResource.id,
                  item.id,
                ),
              });
            setDraggedResource(undefined);
          }}
          onContextMenu={event => {
            event.preventDefault();
            openResourceMenu(event.currentTarget, item.route);
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
                toggleStar(kind, id);
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
  const homePanel = (
    <SharedSidebarPanel
      icon={<HomeOutlinedIcon />}
      title="Home"
      total={homeResourceCatalog.length}
      searchLabel="Search Home"
      searchValue={filter}
      onSearchValueChange={setFilter}
      starredRows={homeResourceRows(starredHomeResources)}
      allRows={homeResourceRows(allUnstarredHomeResources)}
      empty={
        homeResources.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Your work will appear here.
          </Typography>
        ) : undefined
      }
      newLabel="All Messages"
      newIcon={<ChatBubbleOutlineIcon />}
      onNew={() => showNavigation({ kind: "allChat" })}
      viewAllLabel="View Home"
      viewAllIcon={<HomeOutlinedIcon />}
      onViewAll={() => onNavigate({ kind: "home" })}
      drawer={drawer}
    />
  );
  const projectResourceRows = (items: typeof projectList) =>
    items.map(snapshot => {
      const starred = starredResourceIds.has(
        resourcePreferenceKey("project", snapshot.project.id),
      );
      return (
        <Stack
          key={snapshot.project.id}
          direction="row"
          onContextMenu={event => {
            event.preventDefault();
            openResourceMenu(event.currentTarget, {
              kind: "project",
              projectId: snapshot.project.id,
            });
          }}
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <ListItemButton
            aria-label={`Open project ${snapshot.project.label}`}
            onClick={() => openProject(snapshot)}
            sx={{ borderRadius: 1.25, px: 1, py: 0.65, minWidth: 0 }}
          >
            <ListItemIcon sx={{ minWidth: 38 }}>
              <FolderOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={snapshot.project.label}
              secondary={snapshot.project.hostPath}
              primaryTypographyProps={{
                noWrap: true,
                fontSize: 13,
                fontWeight: starred ? 750 : 500,
              }}
              secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ ml: 1, minWidth: 24, textAlign: "right", flexShrink: 0 }}
            >
              {snapshot.conversations.filter(item => !item.archived).length}
            </Typography>
          </ListItemButton>
          <Tooltip
            title={
              starred
                ? `Unstar ${snapshot.project.label}`
                : `Star ${snapshot.project.label}`
            }
          >
            <IconButton
              size="small"
              aria-label={`${starred ? "Unstar" : "Star"} ${snapshot.project.label}`}
              onClick={() => toggleStar("project", snapshot.project.id)}
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
  const starredProjects = projectList.filter(snapshot =>
    starredResourceIds.has(
      resourcePreferenceKey("project", snapshot.project.id),
    ),
  );
  const unstarredProjects = projectList.filter(
    snapshot =>
      !starredResourceIds.has(
        resourcePreferenceKey("project", snapshot.project.id),
      ),
  );
  const projectsPanel = (
    <SharedSidebarPanel
      icon={<FolderOutlinedIcon />}
      title="Projects"
      total={projects.length}
      searchLabel="Search projects"
      searchValue={filter}
      onSearchValueChange={setFilter}
      starredRows={projectResourceRows(starredProjects)}
      allRows={projectResourceRows(unstarredProjects)}
      empty={
        projectList.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ p: 2, textAlign: "center" }}
          >
            {filter.trim()
              ? `No projects match “${filter.trim()}”.`
              : "No projects yet."}
          </Typography>
        ) : undefined
      }
      newLabel="New Project"
      onNew={() => onCreateProject()}
      viewAllLabel="View All Projects"
      viewAllIcon={<FolderOutlinedIcon />}
      onViewAll={openAllProjects}
      drawer={drawer}
    />
  );
  const allChatRows = snapshots.flatMap(snapshot =>
    snapshot.conversations
      .filter(conversation => !conversation.archived)
      .map(conversation => ({ project: snapshot.project, conversation })),
  );
  const chatRows = sortWorkspaceResources(
    allChatRows.filter(
      ({ project: chatProject, conversation }) =>
        !normalizedFilter ||
        `${conversation.title} ${chatProject.label}`
          .toLocaleLowerCase()
          .includes(normalizedFilter),
    ),
    workspaceResourceSort(preferences, "chat"),
    preferences.chatOrder,
    row => row.conversation.id,
    row => row.conversation.title,
    row => row.conversation.updatedAt,
  );
  const globalChatResourceRows = (items: typeof chatRows) =>
    items.map(({ project: chatProject, conversation }) => {
      const starred = starredResourceIds.has(
        resourcePreferenceKey("conversation", conversation.id),
      );
      return (
        <Stack
          key={conversation.id}
          direction="row"
          draggable
          onDragStart={() =>
            setDraggedResource({ kind: "chat", id: conversation.id })
          }
          onDragEnd={() => setDraggedResource(undefined)}
          onDragOver={event => {
            if (draggedResource?.kind === "chat") event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            if (draggedResource?.kind === "chat")
              onPreferences({
                chatSort: "custom",
                chatOrder: reorderStableIds(
                  preferences.chatOrder,
                  allChatRows.map(row => row.conversation.id),
                  draggedResource.id,
                  conversation.id,
                ),
              });
            setDraggedResource(undefined);
          }}
          onContextMenu={event => {
            event.preventDefault();
            openResourceMenu(
              event.currentTarget,
              {
                kind: "conversation",
                projectId: chatProject.id,
                conversationId: conversation.id,
              },
              conversation,
            );
          }}
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <ListItemButton
            onClick={() => openChat(chatProject, conversation)}
            sx={{ borderRadius: 1.25, px: 1, py: 0.65, minWidth: 0 }}
          >
            <ListItemIcon sx={{ minWidth: 38 }}>
              <ChatBubbleOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={conversation.title}
              secondary={projectDisambiguator(chatProject, projects)}
              primaryTypographyProps={{
                noWrap: true,
                fontSize: 13,
                fontWeight: starred ? 750 : 500,
              }}
              secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
            />
          </ListItemButton>
          <Tooltip
            title={
              starred
                ? `Unstar ${conversation.title}`
                : `Star ${conversation.title}`
            }
          >
            <IconButton
              size="small"
              aria-label={`${starred ? "Unstar" : "Star"} ${conversation.title}`}
              onClick={() => toggleStar("conversation", conversation.id)}
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
  const globalChatsPanel = (
    <SharedSidebarPanel
      icon={<ChatBubbleOutlineIcon />}
      title="Chats"
      total={allChatRows.length}
      searchLabel="Search chats"
      searchValue={filter}
      onSearchValueChange={setFilter}
      starredRows={globalChatResourceRows(
        chatRows.filter(({ conversation }) =>
          starredResourceIds.has(
            resourcePreferenceKey("conversation", conversation.id),
          ),
        ),
      )}
      allRows={globalChatResourceRows(
        chatRows.filter(
          ({ conversation }) =>
            !starredResourceIds.has(
              resourcePreferenceKey("conversation", conversation.id),
            ),
        ),
      )}
      empty={
        chatRows.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ p: 2, textAlign: "center" }}
          >
            {filter.trim()
              ? `No chats match “${filter.trim()}”.`
              : "No Project Chats yet."}
          </Typography>
        ) : undefined
      }
      newLabel="New Chat"
      onNew={() => onCreateChat?.()}
      newDisabled={!projects.length}
      viewAllLabel="View All Chats"
      viewAllIcon={<ChatBubbleOutlineIcon />}
      onViewAll={() => onNavigate({ kind: "allChats" })}
      drawer={drawer}
    />
  );

  const allAgentRows = workspaceAgents(snapshots);
  const agentRows = sortWorkspaceResources(
    allAgentRows.filter(
      ({ agent, project }) =>
        !normalizedFilter ||
        `${agent.title} ${project.label} ${project.hostPath} ${agent.activeEngine}`
          .toLocaleLowerCase()
          .includes(normalizedFilter),
    ),
    workspaceResourceSort(preferences, "agent"),
    preferences.agentOrder,
    row => row.agent.id,
    row => row.agent.title,
    row => row.agent.updatedAt,
  );
  const agentResourceRows = (items: typeof agentRows) =>
    items.map(({ agent, project: agentProject, status }) => {
      const starred = starredResourceIds.has(
        resourcePreferenceKey("agent", agent.id),
      );
      return (
        <Stack
          key={agent.id}
          direction="row"
          draggable
          onDragStart={() =>
            setDraggedResource({ kind: "agent", id: agent.id })
          }
          onDragEnd={() => setDraggedResource(undefined)}
          onDragOver={event => {
            if (draggedResource?.kind === "agent") event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            if (draggedResource?.kind === "agent")
              onPreferences({
                agentSort: "custom",
                agentOrder: reorderStableIds(
                  preferences.agentOrder,
                  allAgentRows.map(row => row.agent.id),
                  draggedResource.id,
                  agent.id,
                ),
              });
            setDraggedResource(undefined);
          }}
          onContextMenu={event => {
            event.preventDefault();
            openResourceMenu(event.currentTarget, {
              kind: "agent",
              projectId: agentProject.id,
              agentId: agent.id,
            });
          }}
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <ListItemButton
            aria-label={`Open agent ${agent.title} in ${projectDisambiguator(agentProject, projects)}`}
            selected={route.kind === "agent" && route.agentId === agent.id}
            onClick={() =>
              onNavigate({
                kind: "agent",
                projectId: agentProject.id,
                agentId: agent.id,
              })
            }
            sx={{ borderRadius: 1.25, px: 1, py: 0.65, minWidth: 0 }}
          >
            <ListItemIcon sx={{ minWidth: 38 }}>
              <SmartToyOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={agent.title}
              secondary={`${projectDisambiguator(agentProject, projects)} · ${agent.activeEngine}`}
              primaryTypographyProps={{
                noWrap: true,
                fontSize: 13,
                fontWeight: starred ? 750 : 500,
              }}
              secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
            />
            <Box
              title={agentStatusLabel(status)}
              aria-label={agentStatusLabel(status)}
              sx={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                bgcolor:
                  agentStatusColor(status) === "default"
                    ? "text.disabled"
                    : `${agentStatusColor(status)}.main`,
                flex: "0 0 auto",
              }}
            />
          </ListItemButton>
          <Tooltip title={`${starred ? "Unstar" : "Star"} ${agent.title}`}>
            <IconButton
              size="small"
              aria-label={`${starred ? "Unstar" : "Star"} ${agent.title}`}
              onClick={() => toggleStar("agent", agent.id)}
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
  const agentsPanel = (
    <SharedSidebarPanel
      icon={<SmartToyOutlinedIcon />}
      title="Agents"
      total={allAgentRows.length}
      searchLabel="Search agents"
      searchValue={filter}
      onSearchValueChange={setFilter}
      starredRows={agentResourceRows(
        agentRows.filter(({ agent }) =>
          starredResourceIds.has(resourcePreferenceKey("agent", agent.id)),
        ),
      )}
      allRows={agentResourceRows(
        agentRows.filter(
          ({ agent }) =>
            !starredResourceIds.has(resourcePreferenceKey("agent", agent.id)),
        ),
      )}
      empty={
        agentRows.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ p: 2, textAlign: "center" }}
          >
            {filter.trim()
              ? `No agents match “${filter.trim()}”.`
              : "No active agents."}
          </Typography>
        ) : undefined
      }
      newLabel="New Agent"
      onNew={() => onCreateAgent?.()}
      viewAllLabel="View All Agents"
      viewAllIcon={<SmartToyOutlinedIcon />}
      onViewAll={() => onNavigate({ kind: "allAgents" })}
      drawer={drawer}
    />
  );

  const triggerDestinations = workspaceAgents(snapshots);
  const triggerAgentById = new Map(
    triggerDestinations.map(
      destination => [destination.agent.id, destination] as const,
    ),
  );
  const filteredTriggers = sortWorkspaceResources(
    (allTriggersQuery.data ?? []).filter(trigger => {
      const destination = triggerAgentById.get(trigger.agentId);
      return (
        !normalizedFilter ||
        [
          trigger.name,
          trigger.instructions,
          trigger.sourceKind,
          destination?.agent.title,
          destination?.project.label,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedFilter)
      );
    }),
    workspaceResourceSort(preferences, "trigger"),
    preferences.triggerOrder,
    trigger => trigger.id,
    trigger => trigger.name,
    trigger => trigger.updatedAt,
  );
  const triggerResourceRows = (items: typeof filteredTriggers) =>
    items.map(trigger => {
      const destination = triggerAgentById.get(trigger.agentId);
      if (!destination) return null;
      const starred = starredResourceIds.has(
        resourcePreferenceKey("trigger", trigger.id),
      );
      return (
        <Stack
          key={trigger.id}
          direction="row"
          draggable
          onDragStart={() =>
            setDraggedResource({ kind: "trigger", id: trigger.id })
          }
          onDragEnd={() => setDraggedResource(undefined)}
          onDragOver={event => {
            if (draggedResource?.kind === "trigger") event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            if (draggedResource?.kind === "trigger")
              onPreferences({
                triggerSort: "custom",
                triggerOrder: reorderStableIds(
                  preferences.triggerOrder,
                  (allTriggersQuery.data ?? []).map(item => item.id),
                  draggedResource.id,
                  trigger.id,
                ),
              });
            setDraggedResource(undefined);
          }}
          onContextMenu={event => {
            event.preventDefault();
            openResourceMenu(event.currentTarget, {
              kind: "agent",
              projectId: destination.project.id,
              agentId: destination.agent.id,
              view: "triggers",
            });
          }}
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <ListItemButton
            aria-label={`Open triggers for ${destination.agent.title}`}
            onClick={() =>
              openTriggerManager(destination.project.id, destination.agent.id)
            }
            sx={{ borderRadius: 1.25, px: 1, py: 0.65, minWidth: 0 }}
          >
            <ListItemIcon sx={{ minWidth: 38 }}>
              <BoltOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={trigger.name}
              secondary={`${destination.project.label} · ${destination.agent.title}`}
              primaryTypographyProps={{
                noWrap: true,
                fontSize: 13,
                fontWeight: starred ? 750 : 500,
              }}
              secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
            />
            <Box
              title={trigger.enabled ? "Enabled" : "Disabled"}
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                bgcolor: trigger.enabled ? "success.main" : "text.disabled",
                flex: "0 0 auto",
              }}
            />
          </ListItemButton>
          <Tooltip title={`${starred ? "Unstar" : "Star"} ${trigger.name}`}>
            <IconButton
              size="small"
              aria-label={`${starred ? "Unstar" : "Star"} ${trigger.name}`}
              onClick={() => toggleStar("trigger", trigger.id)}
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
  const triggersPanel = (
    <SharedSidebarPanel
      icon={<BoltOutlinedIcon />}
      title="Triggers"
      total={(allTriggersQuery.data ?? []).length}
      searchLabel="Search triggers or agents"
      searchValue={filter}
      onSearchValueChange={setFilter}
      topContent={
        allTriggersQuery.isLoading ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Loading triggers…
          </Typography>
        ) : allTriggersQuery.isError ? (
          <Typography variant="body2" color="error" sx={{ p: 1 }}>
            Triggers could not be loaded.
          </Typography>
        ) : undefined
      }
      starredRows={triggerResourceRows(
        filteredTriggers.filter(trigger =>
          starredResourceIds.has(resourcePreferenceKey("trigger", trigger.id)),
        ),
      )}
      allRows={triggerResourceRows(
        filteredTriggers.filter(
          trigger =>
            !starredResourceIds.has(
              resourcePreferenceKey("trigger", trigger.id),
            ),
        ),
      )}
      empty={
        !allTriggersQuery.isLoading && filteredTriggers.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 1, py: 1 }}
          >
            {filter.trim()
              ? "No configured triggers match."
              : "No triggers configured yet."}
          </Typography>
        ) : undefined
      }
      newLabel="New Trigger"
      onNew={() => onCreateTrigger?.()}
      viewAllLabel="View All Triggers"
      viewAllIcon={<BoltOutlinedIcon />}
      onViewAll={() => onNavigate({ kind: "allTriggers" })}
      drawer={drawer}
    />
  );

  const wikiSections = (wikiIndexQuery.data?.sections ?? [])
    .map(section => ({
      ...section,
      articles: section.articles.filter(
        article =>
          !normalizedFilter ||
          `${article.title} ${article.summary}`
            .toLocaleLowerCase()
            .includes(normalizedFilter),
      ),
    }))
    .filter(section => section.articles.length > 0);
  const activeWikiArticleId =
    route.kind === "wiki"
      ? (route.articleId ?? wikiIndexQuery.data?.sections[0]?.articles[0]?.id)
      : undefined;
  const wikiPanel = (
    <Box
      sx={{
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto auto minmax(0, 1fr)",
        bgcolor: sidebarSurface,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          pl: 2.25,
          pr: drawer ? 7 : 2.25,
          pt: 2,
          pb: 1.25,
        }}
      >
        <IconTitle icon={<MenuBookOutlinedIcon />} title="Wiki" />
      </Stack>
      <Box sx={{ px: 1.75, pb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="Search Wiki"
          inputProps={{ "aria-label": "Search Wiki" }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
      </Box>
      <Box
        component="nav"
        aria-label="Wiki navigation"
        data-testid="workspace-navigation-scroll"
        className="ponderosa-scroll"
        sx={{ minHeight: 0, overflowY: "auto", px: 1.25, pb: 2 }}
      >
        {wikiIndexQuery.isLoading ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Loading Wiki…
          </Typography>
        ) : null}
        {wikiIndexQuery.isError ? (
          <Typography variant="body2" color="error" sx={{ p: 1 }}>
            Wiki navigation could not be loaded.
          </Typography>
        ) : null}
        {wikiSections.map(section => (
          <Box component="section" key={section.id} sx={{ mb: 2 }}>
            <SidebarSectionHeading>{section.title}</SidebarSectionHeading>
            <List dense disablePadding>
              {section.articles.map(article => (
                <ListItemButton
                  key={article.id}
                  selected={article.id === activeWikiArticleId}
                  onClick={() => {
                    setFilter("");
                    onNavigate({ kind: "wiki", articleId: article.id });
                  }}
                  onContextMenu={event => {
                    event.preventDefault();
                    openResourceMenu(event.currentTarget, {
                      kind: "wiki",
                      articleId: article.id,
                    });
                  }}
                  sx={{ borderRadius: 1.25, mb: 0.25 }}
                >
                  <ListItemText
                    primary={article.title}
                    primaryTypographyProps={{
                      fontSize: 13,
                      fontWeight:
                        article.id === activeWikiArticleId ? 800 : 600,
                    }}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
        ))}
        {!wikiIndexQuery.isLoading && wikiSections.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            {filter.trim()
              ? `No Wiki articles match “${filter.trim()}”.`
              : "No Wiki articles are available."}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );

  const settingsPanel = (
    <Box
      sx={{
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        bgcolor: sidebarSurface,
      }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}
      >
        <IconTitle icon={<SettingsOutlinedIcon />} title="Settings" />
      </Stack>
      <List sx={{ px: 1.25 }}>
        <ListItemButton
          selected={
            route.kind === "settings" &&
            (route.section ?? "general") === "general"
          }
          onClick={() => onNavigate({ kind: "settings", section: "general" })}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon />
          </ListItemIcon>
          <ListItemText
            primary="General"
            secondary="Appearance and Agent defaults"
          />
        </ListItemButton>
        <ListItemButton
          selected={route.kind === "settings" && route.section === "providers"}
          onClick={() => onNavigate({ kind: "settings", section: "providers" })}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <SmartToyOutlinedIcon />
          </ListItemIcon>
          <ListItemText
            primary="AI Providers"
            secondary="Availability, models, and reasoning"
          />
        </ListItemButton>
        <ListItemButton
          selected={
            route.kind === "settings" && route.section === "notifications"
          }
          onClick={() =>
            onNavigate({ kind: "settings", section: "notifications" })
          }
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <NotificationsNoneOutlinedIcon />
          </ListItemIcon>
          <ListItemText
            primary="Notifications"
            secondary="In-app and browser attention"
          />
        </ListItemButton>
        <ListItemButton
          selected={route.kind === "usage"}
          onClick={() => onNavigate({ kind: "usage" })}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <DataUsageOutlinedIcon />
          </ListItemIcon>
          <ListItemText
            primary="Provider Activity"
            secondary="Tokens and Run telemetry"
          />
        </ListItemButton>
      </List>
    </Box>
  );
  const panel = showingAgents
    ? agentsPanel
    : showingChats
      ? globalChatsPanel
      : showingTriggers
        ? triggersPanel
        : showingWiki
          ? wikiPanel
          : showingSettings
            ? settingsPanel
            : showingProjects
              ? projectsPanel
              : homePanel;
  const [resizing, setResizing] = useState(false);
  const resizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);
    const move = (next: PointerEvent) =>
      onWidthChange(
        clampWorkspaceSidebarWidth(startWidth + next.clientX - startX),
      );
    const stop = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <Box
      component="aside"
      aria-label="Workspace navigation"
      data-sidebar-state={collapsed ? "collapsed" : "expanded"}
      data-sidebar-resizing={resizing ? "true" : "false"}
      sx={{
        position: "relative",
        width: drawer
          ? "min(100vw, 390px)"
          : collapsed
            ? SIDEBAR_RAIL_WIDTH
            : width,
        maxWidth: "100vw",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        borderRight: 1,
        borderColor: collapsed && !drawer ? "transparent" : "divider",
        display: "grid",
        gridTemplateColumns:
          collapsed && !drawer
            ? `${SIDEBAR_RAIL_WIDTH}px`
            : `${drawer ? 64 : SIDEBAR_RAIL_WIDTH}px minmax(0, 1fr)`,
        bgcolor: sidebarSurface,
        overflow: "hidden",
        transition:
          !drawer && !resizing
            ? "width 180ms cubic-bezier(0.2, 0, 0, 1), grid-template-columns 180ms cubic-bezier(0.2, 0, 0, 1)"
            : "none",
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
      }}
    >
      {rail}
      {collapsed && !drawer ? null : panel}
      {!drawer && !collapsed && onWidthChange ? (
        <Box
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={resizeStart}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            onWidthChange(
              clampWorkspaceSidebarWidth(
                width + (event.key === "ArrowRight" ? 16 : -16),
              ),
            );
          }}
          sx={{
            position: "absolute",
            zIndex: 2,
            insetBlock: 0,
            right: 0,
            width: 12,
            cursor: "col-resize",
            touchAction: "none",
            "&::after": {
              content: '""',
              position: "absolute",
              insetBlock: 0,
              left: 5,
              width: 2,
              bgcolor: "transparent",
            },
            "&:hover::after, &:focus-visible::after": {
              bgcolor: "primary.main",
            },
          }}
        />
      ) : null}
      <ResourceContextMenu
        state={menu}
        onClose={() => setMenu(undefined)}
        onOpenInNewTab={
          onOpenInNewTab
            ? resource => onOpenInNewTab(resource.route)
            : undefined
        }
        actions={
          menu?.resource.conversation
            ? [
                {
                  id: "rename",
                  label: "Rename",
                  onSelect: resource =>
                    onRenameConversation(resource.conversation!),
                },
                {
                  id: "delete",
                  label: "Delete",
                  color: "error",
                  onSelect: resource =>
                    onDeleteConversation(resource.conversation!),
                },
              ]
            : []
        }
      />
    </Box>
  );
}
