import { SidebarResourceRow } from "./SidebarResourceRow";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Box,
  Chip,
  IconButton,
  List,
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
  WorkspaceNotificationPageDto,
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
  useProjectRailDirectory,
  workspaceDirectoryItems,
} from "../hooks/useWorkspaceDirectory";
import { queryKeys } from "../queryKeys";
import { routeClearsProjectSidebarContext } from "../routeRegistry";
import { routeProjectId, type Route } from "../routing";
import { useAgent, useConversation, useNotificationProjection } from "../hooks/queries";
import {
  projectOrderPreferenceKey,
  reorderStableIds,
  resourcePreferenceKey,
  sortWorkspaceResources,
  starredWorkspaceResources,
  synchronizeProjectRailOrder,
  toggleWorkspaceResourceStar,
} from "../resourcePreferences";
import {
  projectDisambiguator,
  type UnreadNotificationProjection,
} from "../workspaceNavigation";
import { clampWorkspaceSidebarWidth } from "../workspaceSidebarState";
import { markWorkspaceResourceUsed } from "../workspaceRecency";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { ResourceContextMenu } from "./ResourceContextMenu";
import { TextInputDialog } from "./ConfirmationDialogs";
import {
  SIDEBAR_PANEL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  sidebarSurface,
} from "./WorkspaceSidebar.helpers";
import { CollectionStateFeedback } from "./CollectionPrimitives";
import {
  SidebarSectionHeading,
  SharedSidebarPanel,
} from "./WorkspaceSidebar.parts";
import {
  SettingsSidebarPanel,
} from "./WorkspaceSidebar.chrome";
import { ProjectRail } from "./ProjectNavigation";
import { ProjectDeletionDialog } from "./ProjectDeletionDialog";
import { ChatFolders } from "./ChatFolders";
import {
  useWorkspaceSidebarNavigation,
  useWorkspaceSidebarResize,
} from "./useWorkspaceSidebarState";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";

export function WorkspaceSidebar({
  projects,
  preferences,
  route,
  notifications,
  notificationCounts,
  drawer = false,
  onNavigate,
  onCreate,
  onPreferences,
  onRenameConversation,
  onDeleteConversation,
  onProjectDeleted,
  onSearch,
  onOpenNotifications,
  onOpenEngineStatus,
  creating,
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
  notificationCounts?: Pick<WorkspaceNotificationPageDto, "unacknowledgedActionCount" | "unreadUpdateCount">;
  drawer?: boolean;
  onNavigate(route: Route): void;
  onCreate(
    kind: "project" | "chat" | "agent" | "trigger",
    context?: {
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
      agentId?: string;
    },
  ): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onProjectDeleted(projectId: string): void;
  onSearch?(): void;
  onOpenNotifications?(): void;
  onOpenEngineStatus?(): void;
  creating?: "project" | "chat" | "agent" | "trigger";
  onDismiss?(): void;
  collapsed?: boolean;
  width?: number;
  onCollapsedChange?(collapsed: boolean): void;
  onWidthChange?(width: number): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const workspaceConnection = useWorkspaceConnection();
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
  } = useWorkspaceSidebarNavigation(route, true);
  const [collapsedSidebarAgentIds, setCollapsedSidebarAgentIds] =
    useState<Set<string>>(() => new Set());

  const routedProjectId = routeProjectId(route);
  const [drawerProjectId, setDrawerProjectId] = useState(routedProjectId);
  const [drawerProjectPanelOpen, setDrawerProjectPanelOpen] = useState(
    Boolean(routedProjectId),
  );
  useEffect(() => {
    if (["conversation", "agent", "automation", "allChats", "allAgents", "allTriggers"].includes(route.kind)) setSidebarSection("home");
    if (routedProjectId) {
      setDrawerProjectId(routedProjectId);
      setDrawerProjectPanelOpen(true);
    } else if (routeClearsProjectSidebarContext(route)) {
      setDrawerProjectId(undefined);
      setDrawerProjectPanelOpen(false);
    }
  }, [route, routedProjectId]);
  // Project IDs remain routing/working-context authority, not list filters.
  const projectContext = true;
  const showingSettings = sidebarSection === "settings";
  const showingAgents = !showingSettings && projectSection === "agents";
  const showingChats = !showingSettings && projectSection === "chats";
  const showingTriggers = !showingSettings && projectSection === "triggers";
  const directorySearch = filter;
  useEffect(() => {
    if (route.kind === "allChats" || route.kind === "allChat" || route.kind === "home") setProjectSection("chats");
    if (route.kind === "allAgents") setProjectSection("agents");
    if (route.kind === "allTriggers") setProjectSection("triggers");
  }, [route]);
  const projectDirectoryQuery = useProjectRailDirectory();
  const chatDirectoryQuery =
    useWorkspaceDirectory<WorkspaceConversationDirectoryItemDto>("conversation", {
      search: directorySearch,
      projectId: undefined,
      enabled: projectContext && showingChats,
    });
  const agentDirectoryQuery =
    useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
      search: showingAgents ? directorySearch : "",
      projectId: undefined,
      enabled: projectContext && showingAgents,
    });
  const activeWorkspaceAgentQuery =
    useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
      projectId: undefined,
      active: true,
      enabled: projectContext,
      summary: true,
    });
  const triggerDirectoryQuery =
    useWorkspaceDirectory<WorkspaceTriggerDirectoryItemDto>("trigger", {
      search: directorySearch,
      projectId: undefined,
      enabled: projectContext && showingTriggers,
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
  const agentItems = [...agentDirectory.starredItems, ...agentDirectory.items];
  const triggerItems = [...triggerDirectory.starredItems, ...triggerDirectory.items];
  const projectionConversationIds = [
    ...chatItems.map(item => item.conversation.id),
    ...(route.kind === "conversation" ? [route.conversationId] : []),
  ];
  const notificationProjectionQuery = useNotificationProjection(
    projects.map(project => project.id),
    projectionConversationIds,
  );
  const emptyUnread: UnreadNotificationProjection = {
    importantCount: 0,
    ordinaryCount: 0,
    totalCount: 0,
  };
  const conversationUnread = (conversationId: string): UnreadNotificationProjection =>
    notificationProjectionQuery.data?.conversations[conversationId] ?? emptyUnread;
  const projectById = new Map(projects.map(project => [project.id, project]));
  for (const item of projectItems) projectById.set(item.project.id, item.project);
  const activeProjectId = drawerProjectId;
  const railProjectIds = useRef<string[]>([]);
  const railProjectOrderKey = useRef<string>();
  const canonicalProjectOrderKey = projectOrderPreferenceKey(preferences, projects);
  const canonicalProjectOrderChanged =
    railProjectOrderKey.current !== canonicalProjectOrderKey;
  const stableProjectIds = synchronizeProjectRailOrder(
    railProjectIds.current,
    projects.map(project => project.id),
    canonicalProjectOrderChanged,
  );
  railProjectOrderKey.current = canonicalProjectOrderKey;
  railProjectIds.current = stableProjectIds;
  const stableRailProjects = stableProjectIds.flatMap(projectId => {
    const project = projects.find(candidate => candidate.id === projectId);
    return project ? [project] : [];
  });
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
      activeWorkspaceAgentQuery.data?.pages.at(-1)?.total ?? 0,
    attention: notificationCounts?.unacknowledgedActionCount ?? notifications.filter(isOpenAttention).length,
    updates: notificationCounts?.unreadUpdateCount ?? notifications.filter(isUnreadNotificationUpdate).length,
  };
  const allMessagesUnread = notificationProjectionQuery.data?.allMessages ?? emptyUnread;
  const projectUnread = new Map(projects.map(project => [
    project.id,
    notificationProjectionQuery.data?.projects[project.id] ?? emptyUnread,
  ]));
  const healthQuery = useQuery({
    queryKey: queryKeys.health.all,
    queryFn: () => api.getHealth(),
    enabled: showingSettings,
    staleTime: 60_000,
  });
  const [renamingProject, setRenamingProject] = useState<ProjectDto>();
  const [deletingProject, setDeletingProject] = useState<ProjectDto>();
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
    setProjectSection(remembered?.section ?? "chats");
    setFilter(remembered?.filter ?? "");
    if (!drawer && collapsed) onCollapsedChange?.(false);
  };
  const reorderRailProject = (
    sourceProjectId: string,
    targetProjectId: string,
    position: "before" | "after",
  ) => {
    const currentOrder = stableRailProjects.map(project => project.id);
    const projectOrder = reorderStableIds(
      currentOrder,
      currentOrder,
      sourceProjectId,
      targetProjectId,
      position,
    );
    if (projectOrder.every((projectId, index) => projectId === currentOrder[index])) {
      return;
    }
    railProjectIds.current = projectOrder;
    onPreferences({ projectSort: "custom", projectOrder });
  };
  const openTriggerManager = (
    projectId: string,
    _agentId: string | undefined,
    triggerId: string,
  ) => {
    markWorkspaceResourceUsed(queryClient, "trigger", triggerId);
    onNavigate({ kind: "automation", projectId, triggerId });
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

  const selectSidebar = (section: typeof projectSection | "settings") => {
    const selected = section === "settings" ? showingSettings : !showingSettings && section === projectSection;
    if (!drawer && !collapsed && selected && onCollapsedChange) {
      onCollapsedChange(true);
      return;
    }
    setSidebarSection(section === "settings" ? "settings" : "home");
    if (section !== "settings") setProjectSection(section);
    setFilter("");
    setDrawerProjectPanelOpen(true);
    if (collapsed) onCollapsedChange?.(false);
  };
  const rail = (
    <ProjectRail
      sections={{ active: showingSettings ? undefined : projectSection, agentsWorking: counts.running > 0, onSelect: selectSidebar }}
      drawer={drawer}
      projects={stableRailProjects}
      activeProjectId={
        projectContext && (drawer ? drawerProjectPanelOpen : !collapsed)
          ? activeProjectId
          : undefined
      }
      currentProjectId={routedProjectId}
      route={route}
      profile={preferences.profile}
      allMessagesUnread={allMessagesUnread}
      attentionNotifications={counts.attention}
      unreadNotificationUpdates={counts.updates}
      projectUnread={projectUnread}
      folders={preferences.projectFolders ?? []}
      onFoldersChange={projectFolders => onPreferences({ projectFolders })}
      onRenameProject={setRenamingProject}
      onProjectSettings={project => onNavigate({ kind: "project", projectId: project.id, view: "settings" })}
      onDeleteProject={setDeletingProject}
      projectRunningCounts={new Map([...projectDirectory.starredItems, ...projectDirectory.items].map(item => [item.project.id, item.runningAgentCount]))}
      onReorderProject={reorderRailProject}
      onOpenHome={() => showNavigation({ kind: "home" })}
      onOpenAllMessages={() => showNavigation({ kind: "allChat" })}
      onOpenProject={openProject}
      onOpenCreate={() => onCreate("project")}
      createProjectOpen={creating === "project"}
      onOpenSearch={() => onSearch?.()}
      onOpenNotifications={() => onOpenNotifications?.()}
      onOpenUsage={() => showNavigation({ kind: "usage" })}
      onOpenEngineStatus={() => onOpenEngineStatus?.()}
      onOpenSettings={() => selectSidebar("settings")}
      onOpenProfile={() => showNavigation({ kind: "profile" })}
      onClose={onDismiss}
    />
  );

  const starredResourceIds = starredWorkspaceResources(preferences);
  const toggleStar = (
    kind: "project" | "conversation" | "agent" | "trigger",
    id: string,
  ) => onPreferences(toggleWorkspaceResourceStar(preferences, kind, id));
  const panelHeader = <Box sx={{ px: 2, pt: drawer ? .75 : 1.5, pb: 1 }}><Typography component="h2" sx={{ fontSize: 15, fontWeight: 700 }}>{showingAgents ? "Agents" : showingTriggers ? "Automations" : "Chats"}</Typography><Typography variant="caption" color="text.secondary">Browse · select an item to open it</Typography></Box>;
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
    items.map(({ project: chatProject, conversation, runningAgentCount = 0 }) => {
      const starred = starredResourceIds.has(
        resourcePreferenceKey("conversation", conversation.id),
      );
      const unread = conversationUnread(conversation.id);
      return (
        <Stack
          key={conversation.id}
          direction="row"
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <SidebarResourceRow id={`sidebar-conversation:${conversation.id}`} label={`Open Chat ${conversation.title}`} title={conversation.title} icon={<ChatBubbleOutlineIcon fontSize="small" />}
            starred={starred} emphasis={Boolean(unread.totalCount)} selected={route.kind === "conversation" && route.conversationId === conversation.id}
            onOpen={() => openChat(chatProject, conversation)} onStar={() => toggleStar("conversation", conversation.id)}
            status={<>{runningAgentCount > 0 ? <AgentStatusIndicator status="running" /> : null}
              {unread.importantCount ? <Chip size="small" color="error" label={unread.importantCount} aria-label={`${unread.importantCount} important unread`} sx={{ height: 20 }} /> : null}
              {unread.ordinaryCount ? <Box role="img" aria-label={`${unread.ordinaryCount} ordinary unread`} sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "text.secondary" }} /> : null}</>} />
        </Stack>
      );
    });
  const globalChatsPanel = (
    <ChatFolders items={chatRows} folders={preferences.chatFolders ?? []}
      openItems={activeChatRow ? [activeChatRow] : []}
      starredIds={starredResourceIds} filtering={Boolean(filter.trim())}
      renderRow={item => globalChatResourceRows([item])}
      onChange={chatFolders => onPreferences({ chatFolders })}
      onRename={onRenameConversation} onDelete={onDeleteConversation}
      onReorder={(source, target, position) => onPreferences({ chatSort: "custom", chatOrder: reorderStableIds(preferences.chatOrder, allChatRows.map(row => row.conversation.id), source, target, position) })}>
    {({ starredRows, allRows, openRows }) => (
    <SharedSidebarPanel
      header={panelHeader}
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
          <List disablePadding>{openRows}</List>
        </Box>
      ) : undefined}
      starredRows={starredRows}
      allRows={allRows}
      collectionFeedback={<CollectionStateFeedback request={chatDirectoryQuery.requestState} itemCount={chatRows.length} filtersActive={Boolean(filter.trim())} resourceLabel="Chats" emptyTitle="No Chats Yet" noMatchTitle={"No Chats match “" + filter.trim() + "”."} onClearFilters={() => setFilter("")} compact />}
      viewAllLabel="View All Chats"
      viewAllIcon={<ChatBubbleOutlineIcon />}
      onViewAll={() => onNavigate({ kind: "allChats" })}
      onViewAllContextMenu={anchor =>
        openResourceMenu(anchor, { kind: "allChats" })
      }
      createLabel="Create Chat"
      onCreate={() => onCreate("chat", { projectId: activeProjectId ?? projects[0]?.id })}
      drawer={drawer}
    />)}
    </ChatFolders>
  );

  type AgentSidebarRow = {
    agent: (typeof agentItems)[number]["agent"];
    project: (typeof agentItems)[number]["project"];
    ownerConversation?: WorkspaceAgentDirectoryItemDto["ownerConversation"];
    health?: WorkspaceAgentDirectoryItemDto["health"];
    status?: (typeof agentItems)[number]["health"]["status"];
  };
  type AgentSidebarTreeRow = AgentSidebarRow & {
    depth: number;
    hasChildren: boolean;
  };
  const allAgentRows: AgentSidebarRow[] = agentItems.map(
    ({ agent, project, ownerConversation, health }) => ({
      agent,
      project,
      ownerConversation,
      health,
      status: health.status,
    }),
  );
  const agentNamesById = new Map(
    allAgentRows.map(row => [row.agent.id, row.agent.title]),
  );
  const activeAgentRow: AgentSidebarRow | undefined =
    route.kind === "agent" &&
    activeProject &&
    activeAgentQuery.data?.agent.projectId === activeProject.id &&
    !allAgentRows.some(item => item.agent.id === route.agentId)
      ? {
          agent: activeAgentQuery.data.agent,
          project: activeProject,
          ownerConversation: activeAgentQuery.data.ownerConversation,
        }
      : undefined;
  const agentRows = allAgentRows;
  const agentHierarchyRows = (items: AgentSidebarRow[]): AgentSidebarTreeRow[] => {
    const byId = new Map(items.map(item => [item.agent.id, item]));
    const childrenByManagerId = new Map<string, AgentSidebarRow[]>();
    for (const item of items) {
      const managerId = item.agent.managerAgentId;
      if (!managerId || !byId.has(managerId)) continue;
      const children = childrenByManagerId.get(managerId) ?? [];
      children.push(item);
      childrenByManagerId.set(managerId, children);
    }
    const roots = items.filter(item =>
      !item.agent.managerAgentId || !byId.has(item.agent.managerAgentId));
    const visited = new Set<string>();
    const visible: AgentSidebarTreeRow[] = [];
    const visit = (item: AgentSidebarRow, depth: number, parentVisible: boolean) => {
      if (visited.has(item.agent.id)) return;
      visited.add(item.agent.id);
      const children = childrenByManagerId.get(item.agent.id) ?? [];
      if (parentVisible) {
        visible.push({ ...item, depth, hasChildren: children.length > 0 });
      }
      const childrenVisible = parentVisible &&
        !collapsedSidebarAgentIds.has(item.agent.id);
      for (const child of children) visit(child, depth + 1, childrenVisible);
    };
    for (const root of roots) visit(root, 0, true);
    // Defensive fallback for malformed cyclic relationships: keep every loaded
    // Agent reachable without allowing recursion to loop.
    for (const item of items) if (!visited.has(item.agent.id)) visit(item, 0, true);
    return visible;
  };
  const agentResourceRows = (items: AgentSidebarTreeRow[]) =>
    items.map(({ agent, project: agentProject, ownerConversation, health, status, depth, hasChildren }) => {
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
          sx={{
            alignItems: "center",
            mb: 0.25,
            pl: Math.min(depth, 4) * 1.75,
          }}
        >
          <Box sx={{ width: 20, flex: "0 0 20px", display: "grid", placeItems: "center" }}>
            {hasChildren ? (
              <Tooltip
                title={`${collapsedSidebarAgentIds.has(agent.id) ? "Expand" : "Collapse"} ${agent.title}`}
              >
                <IconButton
                  size="small"
                  aria-label={`${collapsedSidebarAgentIds.has(agent.id) ? "Expand" : "Collapse"} ${agent.title}`}
                  aria-expanded={!collapsedSidebarAgentIds.has(agent.id)}
                  onClick={() => setCollapsedSidebarAgentIds(current => {
                    const next = new Set(current);
                    if (next.has(agent.id)) next.delete(agent.id);
                    else next.add(agent.id);
                    return next;
                  })}
                  sx={{ width: 28, minWidth: 28, height: { xs: 44, sm: 28 }, minHeight: { xs: 44, sm: 28 } }}
                >
                  {collapsedSidebarAgentIds.has(agent.id) ? (
                    <KeyboardArrowRightIcon fontSize="small" />
                  ) : (
                    <KeyboardArrowDownIcon fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>
            ) : null}
          </Box>
          <SidebarResourceRow id={`sidebar-agent:${agent.id}`} label={`Open agent ${agent.title} in ${projectDisambiguator(agentProject, projects)}`} title={agent.title}
            detail={`${ownerConversation?.title ?? "Unavailable Chat"} · ${agent.activeEngine}`} icon={<SmartToyOutlinedIcon fontSize="small" />}
            starred={starred} nested={Boolean(agent.managerAgentId)} selected={route.kind === "agent" && route.agentId === agent.id}
            onOpen={() => onNavigate({ kind: "agent", projectId: agentProject.id, agentId: agent.id })} onStar={() => toggleStar("agent", agent.id)}
            onMore={anchor => openResourceMenu(anchor, { kind: "agent", projectId: agentProject.id, agentId: agent.id })}
            status={status ? <AgentStatusIndicator status={status} health={health} connectionStatus={workspaceConnection.status} phaseEvidenceFresh={workspaceConnection.phaseEvidenceFresh} agentNameForId={id => agentNamesById.get(id)} /> : null} />
        </Stack>
      );
    });
  const agentsPanel = (
    <SharedSidebarPanel
      header={panelHeader}
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
          <List disablePadding>{agentResourceRows([{
            ...activeAgentRow,
            depth: 0,
            hasChildren: false,
          }])}</List>
        </Box>
      ) : undefined}
      starredRows={agentResourceRows(
        agentHierarchyRows(agentRows.filter(({ agent }) =>
          starredResourceIds.has(resourcePreferenceKey("agent", agent.id)),
        )),
      )}
      allRows={agentResourceRows(
        agentHierarchyRows(agentRows.filter(
          ({ agent }) =>
            !starredResourceIds.has(resourcePreferenceKey("agent", agent.id)),
        )),
      )}
      collectionFeedback={<CollectionStateFeedback request={agentDirectoryQuery.requestState} itemCount={agentRows.length} filtersActive={Boolean(filter.trim())} resourceLabel="Agents" emptyTitle="No Active Agents" noMatchTitle={"No Agents match “" + filter.trim() + "”."} onClearFilters={() => setFilter("")} compact />}
      createLabel="Create Agent"
      viewAllLabel="View All Agents"
      viewAllIcon={<SmartToyOutlinedIcon />}
      onViewAll={() => onNavigate({ kind: "allAgents" })}
      onCreate={() => onCreate("agent", { projectId: activeProjectId ?? projects[0]?.id })}
      drawer={drawer}
    />
  );

  const filteredTriggers = triggerItems;
  const triggerResourceRows = (items: typeof filteredTriggers) =>
    items.map(({ trigger, targetAgent, project }) => {
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
              kind: "automation",
              projectId: project.id,
              triggerId: trigger.id,
            });
          }}
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <SidebarResourceRow id={`sidebar-trigger:${trigger.id}`} label={`Open ${trigger.name} Automation`} title={trigger.name}
            detail={`${project.label} · ${targetAgent?.title ?? "Reassignment required"}`} icon={<BoltOutlinedIcon fontSize="small" />} starred={starred}
            selected={route.kind === "automation" && route.triggerId === trigger.id}
            onOpen={() => openTriggerManager(project.id, targetAgent?.id, trigger.id)} onStar={() => toggleStar("trigger", trigger.id)}
            onMore={anchor => openResourceMenu(anchor, { kind: "automation", projectId: project.id, triggerId: trigger.id })}
            status={<Box role="img" aria-label={trigger.enabled ? "Enabled" : "Disabled"} title={trigger.enabled ? "Enabled" : "Disabled"} sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: trigger.enabled ? "success.main" : "text.disabled" }} />} />
        </Stack>
      );
    });
  const triggersPanel = (
    <SharedSidebarPanel
      header={panelHeader}
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
      createLabel="Create Automation"
      viewAllLabel="View All Automations"
      viewAllIcon={<BoltOutlinedIcon />}
      onViewAll={() => onNavigate({ kind: "allTriggers" })}
      onCreate={() => onCreate("trigger", { projectId: activeProjectId ?? projects[0]?.id })}
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
  const panel = showingSettings
        ? settingsPanel
        : showingAgents
          ? agentsPanel
          : showingChats
            ? globalChatsPanel
            : showingTriggers
              ? triggersPanel
              : null;
  const showPanel = Boolean(panel) &&
    (drawer || !collapsed);
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
          ? "min(92vw, 390px)"
          : showPanel
            ? width
            : SIDEBAR_RAIL_WIDTH,
        maxWidth: "100vw",
        height: "100%",
        alignSelf: "stretch",
        minHeight: 0,
        minWidth: 0,
        borderRight: 1,
        borderColor: showPanel || drawer ? "divider" : "transparent",
        display: "grid",
        gridTemplateColumns:
          drawer ? "minmax(0, 1fr)" : !showPanel
            ? `${SIDEBAR_RAIL_WIDTH}px`
            : `${drawer ? 64 : SIDEBAR_RAIL_WIDTH}px minmax(0, 1fr)`,
        gridTemplateRows: drawer ? "auto auto minmax(0, 1fr) auto" : undefined,
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
      {showPanel ? drawer ? <Box sx={{ gridRow: 3, minHeight: 0, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>{panel}</Box> : panel : null}
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
      {deletingProject ? (
        <ProjectDeletionDialog
          project={deletingProject}
          open
          onClose={() => setDeletingProject(undefined)}
          onDeleted={projectId => {
            setDeletingProject(undefined);
            onProjectDeleted(projectId);
          }}
        />
      ) : null}
    </Box>
  );
}
