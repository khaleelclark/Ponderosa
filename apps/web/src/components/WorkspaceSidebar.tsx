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
  WorkspaceAgentDirectoryItemDto,
  WorkspaceConversationDirectoryItemDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
  WorkspaceProjectDirectoryItemDto,
  WorkspaceTriggerDirectoryItemDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isOpenAttention, isUnreadNotificationUpdate } from "../attention";
import {
  useWorkspaceDirectory,
  workspaceDirectoryItems,
} from "../hooks/useWorkspaceDirectory";
import { queryKeys } from "../queryKeys";
import { routeProjectId, type Route } from "../routing";
import { useAgent, useConversation } from "../hooks/queries";
import {
  reorderStableIds,
  resourcePreferenceKey,
  sortWorkspaceResources,
  starredWorkspaceResources,
  toggleWorkspaceResourceStar,
  workspaceResourceSort,
} from "../resourcePreferences";
import {
  isOrdinaryMessageNotification,
  projectDisambiguator,
} from "../workspaceNavigation";
import { clampWorkspaceSidebarWidth } from "../workspaceSidebarState";
import { markWorkspaceResourceUsed } from "../workspaceRecency";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { ResourceContextMenu } from "./ResourceContextMenu";
import { TextInputDialog } from "./ConfirmationDialogs";
import { IconTitle } from "./IconTitle";
import {
  SIDEBAR_PANEL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  sidebarSurface,
  starColor,
} from "./WorkspaceSidebar.helpers";
import { CollectionStateFeedback } from "./CollectionPrimitives";
import {
  SidebarSectionHeading,
  SharedSidebarPanel,
} from "./WorkspaceSidebar.parts";
import {
  CreateSidebarPanel,
  SettingsSidebarPanel,
} from "./WorkspaceSidebar.chrome";
import { ProjectRail, ProjectSidebarHeader } from "./ProjectNavigation";
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
  onCreate,
  onPreferences,
  onRenameConversation,
  onDeleteConversation,
  onSearch,
  onOpenNotifications,
  onOpenEngineStatus,
  onDismiss,
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
  onCreate(kind: "project" | "chat" | "agent" | "trigger"): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onSearch?(): void;
  onOpenNotifications?(): void;
  onOpenEngineStatus?(): void;
  onDismiss?(): void;
  collapsed?: boolean;
  width?: number;
  onCollapsedChange?(collapsed: boolean): void;
  onWidthChange?(width: number): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const {
    sidebarSection,
    setSidebarSection,
    projectSection,
    setProjectSection,
    filter,
    setFilter,
    draggedResource,
    setDraggedResource,
    menu,
    setMenu,
    openResourceMenu,
  } = useWorkspaceSidebarNavigation(route);

  const routedProjectId = routeProjectId(route);
  const [drawerProjectId, setDrawerProjectId] = useState(routedProjectId);
  const [drawerProjectPanelOpen, setDrawerProjectPanelOpen] = useState(
    Boolean(routedProjectId),
  );
  useEffect(() => {
    if (!routedProjectId) return;
    setDrawerProjectId(routedProjectId);
    setDrawerProjectPanelOpen(true);
  }, [routedProjectId]);
  const createOverride = sidebarSection === "create";
  const projectContext = Boolean(drawerProjectId) && !createOverride;
  const showingAgents = projectContext && projectSection === "agents";
  const showingChats = projectContext && projectSection === "chats";
  const showingTriggers = projectContext && projectSection === "triggers";
  const showingProjectOverview = projectContext && projectSection === "overview";
  const showingCreate = createOverride;
  const showingSettings = !projectContext && sidebarSection === "settings";
  const directorySearch = projectContext ? filter : "";
  const directorySort = showingProjectOverview ? "last_used" as const : undefined;
  const projectDirectoryQuery =
    useWorkspaceDirectory<WorkspaceProjectDirectoryItemDto>("project", {
      search: "",
      enabled: true,
    });
  const chatDirectoryQuery =
    useWorkspaceDirectory<WorkspaceConversationDirectoryItemDto>("conversation", {
      search: directorySearch,
      projectId: drawerProjectId,
      sort: directorySort,
      enabled: projectContext,
    });
  const agentDirectoryQuery =
    useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
      search: showingAgents || showingProjectOverview ? directorySearch : "",
      projectId: drawerProjectId,
      sort: directorySort,
      enabled: projectContext,
    });
  const triggerDirectoryQuery =
    useWorkspaceDirectory<WorkspaceTriggerDirectoryItemDto>("trigger", {
      search: directorySearch,
      projectId: drawerProjectId,
      sort: directorySort,
      enabled: projectContext,
    });
  const projectDirectory = workspaceDirectoryItems(
    projectDirectoryQuery.data?.pages,
    preferences,
  );
  const chatDirectory = workspaceDirectoryItems(chatDirectoryQuery.data?.pages, preferences);
  const agentDirectory = workspaceDirectoryItems(
    agentDirectoryQuery.data?.pages,
    preferences,
  );
  const triggerDirectory = workspaceDirectoryItems(
    triggerDirectoryQuery.data?.pages,
    preferences,
  );
  const projectFallbackItems: WorkspaceProjectDirectoryItemDto[] =
    sortWorkspaceResources(
      projects,
      preferences.projectSort ?? "last_used",
      preferences.projectOrder,
      project => project.id,
      project => project.label,
      project => project.createdAt,
    ).map(project => ({
      kind: "project",
      project,
      displayPath: project.hostPath,
      conversationCount: 0,
      runningAgentCount: 0,
    }));
  const projectItems = projectDirectoryQuery.requestState.hasResolved
    ? [...projectDirectory.starredItems, ...projectDirectory.items]
    : projectFallbackItems;
  const chatItems = [...chatDirectory.starredItems, ...chatDirectory.items];
  const agentItems = [
    ...agentDirectory.starredItems,
    ...agentDirectory.items,
  ];
  const triggerItems = [
    ...triggerDirectory.starredItems,
    ...triggerDirectory.items,
  ];
  const homeProjectIds = new Set(drawerProjectId ? [drawerProjectId] : []);
  const projectById = new Map(projects.map(project => [project.id, project]));
  for (const item of projectItems) projectById.set(item.project.id, item.project);
  const snapshots = [...homeProjectIds].flatMap(projectId => {
    const project = projectById.get(projectId);
    if (!project) return [];
    return [{
      project,
      conversations: chatItems
        .filter(item => item.project.id === projectId)
        .map(item => item.conversation),
      agents: agentItems
        .filter(item => item.project.id === projectId)
        .map(item => item.agent),
      health: agentItems
        .filter(item => item.project.id === projectId)
        .map(item => item.health),
    }];
  });
  const activeProjectId = drawerProjectId;
  const activeProject = activeProjectId
    ? projectById.get(activeProjectId)
    : undefined;
  const activeConversationQuery = useConversation(
    route.kind === "conversation" ? route.conversationId : undefined,
    1,
  );
  const activeAgentQuery = useAgent(
    route.kind === "agent" ? route.agentId : undefined,
    1,
  );
  const counts = {
    running:
      agentDirectoryQuery.data?.pages.at(-1)?.activeCount ?? 0,
    unread: notifications.filter(
      notification =>
        !notification.readAt &&
        (notification.status ?? "open") === "open" &&
        Boolean(notification.conversationId) &&
      isOrdinaryMessageNotification(notification),
    ).length,
    attention: notifications.filter(isOpenAttention).length,
    updates: notifications.filter(isUnreadNotificationUpdate).length,
  };
  const projectBadgeCounts = new Map<string, number>();
  for (const notification of notifications) {
    if (
      !notification.projectId ||
      notification.readAt ||
      (notification.status ?? "open") !== "open" ||
      !notification.conversationId ||
      !isOrdinaryMessageNotification(notification)
    ) continue;
    projectBadgeCounts.set(
      notification.projectId,
      (projectBadgeCounts.get(notification.projectId) ?? 0) + 1,
    );
  }
  const healthQuery = useQuery({
    queryKey: queryKeys.health.all,
    queryFn: () => api.getHealth(),
    enabled: showingSettings,
    staleTime: 60_000,
  });
  const [renamingProject, setRenamingProject] = useState<ProjectDto>();
  const projectBrowseState = useRef(
    new Map<string, { section: typeof projectSection; filter: string }>(),
  );
  const setProjectFilter = (value: string) => {
    setFilter(value);
    if (activeProjectId) {
      projectBrowseState.current.set(activeProjectId, {
        section: projectSection,
        filter: value,
      });
    }
  };
  const renameProject = useMutation({
    mutationFn: ({ project, label }: { project: ProjectDto; label: string }) =>
      api.updateProject(project.id, { label }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDirectory.kind("project"),
      });
      setRenamingProject(undefined);
    },
  });
  const showNavigation = (next: Route) => {
    setDrawerProjectId(undefined);
    setDrawerProjectPanelOpen(false);
    setSidebarSection("home");
    setFilter("");
    onNavigate(next);
  };
  const openProject = (project: ProjectDto) => {
    if (project.id === activeProjectId) {
      if (drawer) {
        setDrawerProjectPanelOpen(open => !open);
      } else {
        onCollapsedChange?.(!collapsed);
      }
      return;
    }
    setSidebarSection("home");
    if (activeProjectId) {
      projectBrowseState.current.set(activeProjectId, {
        section: projectSection,
        filter,
      });
    }
    const remembered = projectBrowseState.current.get(project.id);
    setDrawerProjectId(project.id);
    setDrawerProjectPanelOpen(true);
    setProjectSection(remembered?.section ?? "overview");
    setFilter(remembered?.filter ?? "");
    if (!drawer && collapsed) onCollapsedChange?.(false);
  };
  const openTriggerManager = (
    projectId: string,
    agentId: string,
    triggerId: string,
  ) => {
    markWorkspaceResourceUsed(queryClient, "trigger", triggerId);
    onNavigate({ kind: "agent", projectId, agentId, view: "triggers" });
  };

  const openChat = (
    project: Pick<ProjectDto, "id" | "label" | "hostPath">,
    conversation: ConversationDto,
  ) => {
    void api.markProjectUsed(project.id, conversation.id);
    onNavigate({
      kind: "conversation",
      projectId: project.id,
      conversationId: conversation.id,
    });
  };

  const rail = (
    <ProjectRail
      drawer={drawer}
      projects={projects}
      activeProjectId={activeProjectId}
      route={route}
      profile={preferences.profile}
      unreadMessages={counts.unread}
      attentionNotifications={counts.attention}
      unreadNotificationUpdates={counts.updates}
      projectBadgeCounts={projectBadgeCounts}
      onOpenHome={() => showNavigation({ kind: "home" })}
      onOpenAllMessages={() => showNavigation({ kind: "allChat" })}
      onOpenProject={openProject}
      onOpenCreate={() => {
        setSidebarSection("create");
        setFilter("");
        setDrawerProjectPanelOpen(true);
        if (!drawer && collapsed) onCollapsedChange?.(false);
      }}
      onOpenSearch={() => onSearch?.()}
      onOpenNotifications={() => onOpenNotifications?.()}
      onOpenUsage={() => showNavigation({ kind: "usage" })}
      onOpenEngineStatus={() => onOpenEngineStatus?.()}
      onOpenSettings={() => showNavigation({ kind: "settings" })}
      onOpenProfile={() => showNavigation({ kind: "profile" })}
      onClose={onDismiss}
    />
  );

  const starredResourceIds = starredWorkspaceResources(preferences);
  const projectList = projectItems;
  const toggleStar = (
    kind: "project" | "conversation" | "agent" | "trigger",
    id: string,
  ) => onPreferences(toggleWorkspaceResourceStar(preferences, kind, id));
  const projectHeader = activeProject ? (
    <ProjectSidebarHeader
      project={activeProject}
      section={projectSection}
      counts={{
        chats: chatDirectoryQuery.requestState.hasResolved ? chatDirectory.total : undefined,
        agents: agentDirectoryQuery.requestState.hasResolved ? agentDirectory.total : undefined,
        triggers: triggerDirectoryQuery.requestState.hasResolved ? triggerDirectory.total : undefined,
      }}
      runningCount={agentDirectoryQuery.requestState.hasResolved ? counts.running : undefined}
      unreadCount={projectBadgeCounts.get(activeProject.id) ?? 0}
      drawer={drawer}
      onSectionChange={section => {
        setProjectSection(section);
        setFilter("");
        projectBrowseState.current.set(activeProject.id, { section, filter: "" });
      }}
      onOpenBrowser={() => onNavigate({ kind: "browser", projectId: activeProject.id })}
      onRename={() => setRenamingProject(activeProject)}
      onOpenSettings={() => onNavigate({ kind: "project", projectId: activeProject.id, view: "settings" })}
    />
  ) : undefined;
  const homePanel = (
    <HomeSidebarPanel
      header={projectHeader}
      title="Overview"
      includeProjects={false}
      showAllMessages={false}
      hideSearch
      snapshots={snapshots}
      triggers={triggerItems.map(item => item.trigger)}
      preferences={preferences}
      filter={filter}
      drawer={drawer}
      onFilterChange={setFilter}
      onNavigate={onNavigate}
      onOpenResourceMenu={(anchor, resourceRoute) =>
        openResourceMenu(anchor, resourceRoute)
      }
      onOpenAllMessages={() => showNavigation({ kind: "allChat" })}
      onViewHome={() => activeProject && onNavigate({ kind: "project", projectId: activeProject.id })}
      viewAllLabel="Open Project Overview"
      viewAllIcon={<FolderOutlinedIcon />}
      onToggleStar={toggleStar}
    />
  );
  const allChatRows = chatItems;
  const activeChatRow =
    route.kind === "conversation" &&
    activeProject &&
    activeConversationQuery.data?.conversation.projectId === activeProject.id &&
    !chatItems.some(item => item.conversation.id === route.conversationId)
      ? {
          kind: "conversation" as const,
          project: activeProject,
          conversation: activeConversationQuery.data.conversation,
        }
      : undefined;
  const chatRows = chatItems;
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
            data-resource-id={`sidebar-conversation:${conversation.id}`}
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
      header={projectHeader}
      icon={<ChatBubbleOutlineIcon />}
      title="Chats"
      total={chatDirectoryQuery.requestState.hasResolved ? chatDirectory.total : undefined}
      busy={chatDirectoryQuery.requestState.isInitialLoading || chatDirectoryQuery.requestState.isRefreshing || chatDirectoryQuery.requestState.isFetchingNextPage}
      searchLabel="Search chats"
      searchValue={filter}
      onSearchValueChange={setProjectFilter}
      topContent={activeChatRow ? (
        <Box component="section" sx={{ mb: 2 }}>
          <SidebarSectionHeading>Open now</SidebarSectionHeading>
          <List disablePadding>{globalChatResourceRows([activeChatRow])}</List>
        </Box>
      ) : undefined}
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
      collectionFeedback={<CollectionStateFeedback request={chatDirectoryQuery.requestState} itemCount={chatRows.length} filtersActive={Boolean(filter.trim())} resourceLabel="Chats" emptyTitle="No Project Chats Yet" noMatchTitle={"No Chats match “" + filter.trim() + "”."} onClearFilters={() => setFilter("")} compact />}
      viewAllLabel="View All Chats"
      viewAllIcon={<ChatBubbleOutlineIcon />}
      loadMoreLabel={chatDirectoryQuery.hasNextPage ? "Load more" : undefined}
      onLoadMore={() => void chatDirectoryQuery.fetchNextPage()}
      loadingMore={chatDirectoryQuery.isFetchingNextPage}
      onViewAll={() => activeProjectId && onNavigate({ kind: "allChats", filterProjectId: activeProjectId })}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "allChats" })
      }
      drawer={drawer}
    />
  );

  type AgentSidebarRow = {
    agent: (typeof agentItems)[number]["agent"];
    project: (typeof agentItems)[number]["project"];
    status?: (typeof agentItems)[number]["health"]["status"];
  };
  const allAgentRows: AgentSidebarRow[] = agentItems.map(({ agent, project, health }) => ({
    agent,
    project,
    status: health.status,
  }));
  const activeAgentRow: AgentSidebarRow | undefined =
    route.kind === "agent" &&
    activeProject &&
    activeAgentQuery.data?.agent.projectId === activeProject.id &&
    !allAgentRows.some(item => item.agent.id === route.agentId)
      ? { agent: activeAgentQuery.data.agent, project: activeProject }
      : undefined;
  const agentRows = allAgentRows;
  const agentResourceRows = (items: AgentSidebarRow[]) =>
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
            data-resource-id={"sidebar-agent:" + agent.id}
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
            {status ? <AgentStatusIndicator status={status} /> : null}
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
      header={projectHeader}
      icon={<SmartToyOutlinedIcon />}
      title="Agents"
      total={agentDirectoryQuery.requestState.hasResolved ? agentDirectory.total : undefined}
      busy={agentDirectoryQuery.requestState.isInitialLoading || agentDirectoryQuery.requestState.isRefreshing || agentDirectoryQuery.requestState.isFetchingNextPage}
      searchLabel="Search agents"
      searchValue={filter}
      onSearchValueChange={setProjectFilter}
      topContent={activeAgentRow ? (
        <Box component="section" sx={{ mb: 2 }}>
          <SidebarSectionHeading>Open now</SidebarSectionHeading>
          <List disablePadding>{agentResourceRows([activeAgentRow])}</List>
        </Box>
      ) : undefined}
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
      collectionFeedback={<CollectionStateFeedback request={agentDirectoryQuery.requestState} itemCount={agentRows.length} filtersActive={Boolean(filter.trim())} resourceLabel="Agents" emptyTitle="No Active Agents" noMatchTitle={"No Agents match “" + filter.trim() + "”."} onClearFilters={() => setFilter("")} compact />}
      viewAllLabel="View All Agents"
      viewAllIcon={<SmartToyOutlinedIcon />}
      loadMoreLabel={agentDirectoryQuery.hasNextPage ? "Load more" : undefined}
      onLoadMore={() => void agentDirectoryQuery.fetchNextPage()}
      loadingMore={agentDirectoryQuery.isFetchingNextPage}
      onViewAll={() => activeProjectId && onNavigate({ kind: "allAgents", filterProjectId: activeProjectId })}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "allAgents" })
      }
      drawer={drawer}
    />
  );

  const filteredTriggers = triggerItems;
  const triggerResourceRows = (items: typeof filteredTriggers) =>
    items.map(({ trigger, agent, project }) => {
      const destination = { agent, project };
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
                  triggerItems.map(item => item.trigger.id),
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
            aria-label={`Open Automations for ${destination.agent.title}`}
            data-resource-id={`sidebar-trigger:${trigger.id}`}
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
      header={projectHeader}
      icon={<BoltOutlinedIcon />}
      title="Automations"
      total={triggerDirectoryQuery.requestState.hasResolved ? triggerDirectory.total : undefined}
      busy={triggerDirectoryQuery.requestState.isInitialLoading || triggerDirectoryQuery.requestState.isRefreshing || triggerDirectoryQuery.requestState.isFetchingNextPage}
      searchLabel="Search Automations or Agents"
      searchValue={filter}
      onSearchValueChange={setProjectFilter}
      starredRows={triggerResourceRows(
        filteredTriggers.filter(({ trigger }) =>
          starredResourceIds.has(resourcePreferenceKey("trigger", trigger.id)),
        ),
      )}
      allRows={triggerResourceRows(
        filteredTriggers.filter(
          ({ trigger }) =>
            !starredResourceIds.has(
              resourcePreferenceKey("trigger", trigger.id),
            ),
        ),
      )}
      collectionFeedback={<CollectionStateFeedback request={triggerDirectoryQuery.requestState} itemCount={filteredTriggers.length} filtersActive={Boolean(filter.trim())} resourceLabel="Automations" emptyTitle="No Automations Configured Yet" noMatchTitle="No configured Automations match" onClearFilters={() => setFilter("")} compact />}
      viewAllLabel="View All Automations"
      viewAllIcon={<BoltOutlinedIcon />}
      loadMoreLabel={triggerDirectoryQuery.hasNextPage ? "Load more" : undefined}
      onLoadMore={() => void triggerDirectoryQuery.fetchNextPage()}
      loadingMore={triggerDirectoryQuery.isFetchingNextPage}
      onViewAll={() => activeProjectId && onNavigate({ kind: "project", projectId: activeProjectId, view: "triggers" })}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "allTriggers" })
      }
      drawer={drawer}
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
      onCreate={kind => {
        setSidebarSection("home");
        onCreate(kind);
      }}
    />
  );
  const panel = showingCreate
    ? createPanel
    : showingSettings
        ? settingsPanel
        : showingAgents
          ? agentsPanel
          : showingChats
            ? globalChatsPanel
            : showingTriggers
              ? triggersPanel
              : showingProjectOverview
                ? homePanel
                : null;
  const showPanel = Boolean(panel) &&
    (drawer ? drawerProjectPanelOpen : !collapsed);
  const { resizing, resizeStart } = useWorkspaceSidebarResize(
    width,
    onWidthChange,
  );

  return (
    <Box
      component="aside"
      aria-label="Workspace navigation"
      sx={{
        position: "relative",
        width: drawer
          ? showPanel ? "min(100vw, 390px)" : 64
          : showPanel
            ? width
            : SIDEBAR_RAIL_WIDTH,
        maxWidth: "100vw",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        borderRight: 1,
        borderColor: showPanel || drawer ? "divider" : "transparent",
        display: "grid",
        gridTemplateColumns:
          !showPanel
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
      {showPanel ? panel : null}
      {!drawer && showPanel && onWidthChange ? (
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
      <TextInputDialog
        open={Boolean(renamingProject)}
        title="Rename Project"
        label="Project name"
        initialValue={renamingProject?.label ?? ""}
        confirmLabel="Rename"
        pending={renameProject.isPending}
        error={renameProject.error instanceof Error ? renameProject.error.message : undefined}
        onCancel={() => setRenamingProject(undefined)}
        onConfirm={label => {
          if (renamingProject) renameProject.mutate({ project: renamingProject, label });
        }}
      />
    </Box>
  );
}
