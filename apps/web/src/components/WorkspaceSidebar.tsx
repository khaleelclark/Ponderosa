import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { markWorkspaceResourceUsed } from "../workspaceRecency";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
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
  CreateSidebarPanel,
  SettingsSidebarPanel,
  WikiSidebarPanel,
  WorkspaceSidebarRail,
} from "./WorkspaceSidebar.chrome";
import { HomeSidebarPanel } from "./WorkspaceSidebar.home";
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
  onCreate,
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
  onCreate(kind: "project" | "chat" | "agent" | "trigger"): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onSearch?(): void;
  collapsed?: boolean;
  width?: number;
  onCollapsedChange?(collapsed: boolean): void;
  onWidthChange?(width: number): void;
}): JSX.Element {
  const queryClient = useQueryClient();
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
  const showingCreate = sidebarSection === "create";
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
  const healthQuery = useQuery({
    queryKey: queryKeys.health.all,
    queryFn: () => api.getHealth(),
    enabled: showingSettings,
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
  const showCreate = () => revealSection("create");
  const openAllProjects = () => {
    setSidebarSection("projects");
    onNavigate({ kind: "projects" });
  };
  const showTriggers = () => revealSection("triggers");
  const showWiki = () => revealSection("wiki");
  const openTriggerManager = (
    projectId: string,
    agentId: string,
    triggerId: string,
  ) => {
    markWorkspaceResourceUsed(queryClient, "trigger", triggerId);
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
      showingCreate={showingCreate}
      showingProjects={showingProjects}
      showingSettings={showingSettings}
      showingTriggers={showingTriggers}
      showingWiki={showingWiki}
      onShowAgents={showAgents}
      onShowChats={showChats}
      onShowHome={showHome}
      onShowCreate={showCreate}
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
  const toggleStar = (
    kind: "project" | "conversation" | "agent" | "trigger",
    id: string,
  ) => onPreferences(toggleWorkspaceResourceStar(preferences, kind, id));
  const homePanel = (
    <HomeSidebarPanel
      snapshots={snapshots}
      triggers={allTriggersQuery.data ?? []}
      preferences={preferences}
      filter={filter}
      drawer={drawer}
      onFilterChange={setFilter}
      onNavigate={onNavigate}
      onOpenResourceMenu={(anchor, resourceRoute) =>
        openResourceMenu(anchor, resourceRoute)
      }
      onOpenAllMessages={() => showNavigation({ kind: "allChat" })}
      onViewHome={() => onNavigate({ kind: "home" })}
      onToggleStar={toggleStar}
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
      viewAllLabel="View All Projects"
      viewAllIcon={<FolderOutlinedIcon />}
      onViewAll={openAllProjects}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "projects" })
      }
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
      viewAllLabel="View All Chats"
      viewAllIcon={<ChatBubbleOutlineIcon />}
      onViewAll={() => onNavigate({ kind: "allChats" })}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "allChats" })
      }
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
            <AgentStatusIndicator status={status} />
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
      viewAllLabel="View All Agents"
      viewAllIcon={<SmartToyOutlinedIcon />}
      onViewAll={() => onNavigate({ kind: "allAgents" })}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "allAgents" })
      }
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
              openTriggerManager(
                destination.project.id,
                destination.agent.id,
                trigger.id,
              )
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
      viewAllLabel="View All Triggers"
      viewAllIcon={<BoltOutlinedIcon />}
      onViewAll={() => onNavigate({ kind: "allTriggers" })}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "allTriggers" })
      }
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
    <SettingsSidebarPanel
      route={route}
      version={healthQuery.data?.version}
      onNavigate={onNavigate}
    />
  );
  const createPanel = (
    <CreateSidebarPanel
      selected={route.kind === "create" ? route.resource : undefined}
      drawer={drawer}
      onCreate={onCreate}
    />
  );
  const panel = showingCreate
    ? createPanel
    : showingAgents
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
