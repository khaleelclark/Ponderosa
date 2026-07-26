import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Box,
  Chip,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
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
import { ResourceContextMenu } from "./ResourceContextMenu";
import { IconTitle } from "./IconTitle";
import {
  SIDEBAR_PANEL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  projectSnapshots,
  sidebarSurface,
  starColor,
} from "./WorkspaceSidebar.helpers";
import {
  SharedSidebarPanel,
} from "./WorkspaceSidebar.parts";
import {
  SettingsSidebarPanel,
  WikiSidebarPanel,
  WorkspaceSidebarRail,
} from "./WorkspaceSidebar.chrome";
import {
  useWorkspaceSidebarNavigation,
  useWorkspaceSidebarResize,
} from "./useWorkspaceSidebarState";

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
  const {
    sidebarSection,
    setSidebarSection,
    filter,
    setFilter,
    draggedResource,
    setDraggedResource,
    menu,
    setMenu,
    openResourceMenu,
  } = useWorkspaceSidebarNavigation(route);

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
    queryKey: queryKeys.wiki.index,
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
    onNavigate({
      kind: "conversation",
      projectId: project.id,
      conversationId: conversation.id,
    });
  };

    const rail = (
    <WorkspaceSidebarRail
      drawer={drawer}
      runningCount={counts.running}
      showingAgents={showingAgents}
      showingChats={showingChats}
      showingHome={showingHome}
      showingProjects={showingProjects}
      showingSettings={showingSettings}
      showingTriggers={showingTriggers}
      showingWiki={showingWiki}
      onShowAgents={showAgents}
      onShowChats={showChats}
      onShowHome={showHome}
      onShowProjects={showProjects}
      onShowSettings={() => revealSection("settings")}
      onShowTriggers={showTriggers}
      onShowWiki={showWiki}
    />
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
    <WikiSidebarPanel
      activeArticleId={activeWikiArticleId}
      drawer={drawer}
      filter={filter}
      isError={wikiIndexQuery.isError}
      isLoading={wikiIndexQuery.isLoading}
      sections={wikiSections}
      onFilterChange={setFilter}
      onNavigateArticle={articleId => {
        setFilter("");
        onNavigate({ kind: "wiki", articleId });
      }}
      onOpenArticleMenu={(anchor, articleId) => {
        openResourceMenu(anchor, { kind: "wiki", articleId });
      }}
    />
  );

    const settingsPanel = (
    <SettingsSidebarPanel route={route} onNavigate={onNavigate} />
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
  const { resizing, resizeStart } = useWorkspaceSidebarResize(
    width,
    onWidthChange,
  );

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
