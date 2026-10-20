import { SidebarResourceRow } from "./SidebarResourceRow";
import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Box,
  Button,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  AgentDto,
  ConversationDto,
  ProjectDto,
  ProjectSort,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceConversationDirectoryItemDto,
  WorkspaceNotificationDto,
  WorkspaceNotificationPageDto,
  WorkspacePreferencesDto,
  WorkspaceProjectDirectoryItemDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { isOpenAttention, isUnreadNotificationUpdate } from "../attention";
import {
  useWorkspaceDirectory,
  useProjectRailDirectory,
  workspaceDirectoryItems,
} from "../hooks/useWorkspaceDirectory";
import { queryKeys } from "../queryKeys";
import { routeToPath, routeClearsProjectSidebarContext } from "../routeRegistry";
import { routeProjectId, type Route } from "../routing";
import { useAgent, useConversation, useNotificationProjection } from "../hooks/queries";
import {
  customOrderSeed,
  sidebarChatItems,
  reorderStableIds,
  resourcePreferenceKey,
  sortWorkspaceResources,
  starredWorkspaceResources,
  toggleWorkspaceResourceStar,
  workspaceResourceSort,
  workspaceResourceSortPatch,
} from "../resourcePreferences";
import {
  projectDisambiguator,
  type UnreadNotificationProjection,
} from "../workspaceNavigation";
import { clampWorkspaceSidebarWidth } from "../workspaceSidebarState";
import { SidebarActivityBadge } from "./SidebarActivityBadge";
import { summarizeWorkspaceActivity } from "@ponderosa/core";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity";
import { isUnmodifiedPrimaryClick } from "../nativeNavigation";
import { ResourceContextMenu, type ResourceContextMenuAction } from "./ResourceContextMenu";
import { TextInputDialog } from "./ConfirmationDialogs";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
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
import { ChatFolders } from "./ChatFolders";
import { SidebarNotificationBadge } from "./SidebarNotificationBadge";
import {
  useWorkspaceSidebarNavigation,
  useWorkspaceSidebarResize,
} from "./useWorkspaceSidebarState";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";
import { SearchSnippet, routeForGlobalSearchSelection } from "./GlobalChatSearch";

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
  onSearch,
  onOpenNotifications,
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
    kind: "chat" | "agent",
    context?: {
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
    },
  ): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onSearch?(initial?: { query: string; scope: "chats" }): void;
  onOpenNotifications?(): void;
  onDismiss?(): void;
  collapsed?: boolean;
  width?: number;
  onCollapsedChange?(collapsed: boolean): void;
  onWidthChange?(width: number): void;
}): JSX.Element | null {
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
  useEffect(() => {
    if (["conversation", "agent"].includes(route.kind)) setSidebarSection("home");
    if (routedProjectId) {
      setDrawerProjectId(routedProjectId);
    } else if (routeClearsProjectSidebarContext(route)) {
      setDrawerProjectId(undefined);
    }
  }, [route, routedProjectId]);
  // Project IDs remain routing/working-context authority, not list filters.
  const projectContext = true;
  const showingSettings = sidebarSection === "settings";
  const showingAgents = !showingSettings && projectSection === "agents";
  const showingChats = !showingSettings && projectSection === "chats";
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === "visible");
  const [messageSearchTerm, setMessageSearchTerm] = useState("");
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setMessageSearchTerm(filter.trim()), 250);
    return () => clearTimeout(timer);
  }, [filter]);
  const sidebarVisible = documentVisible && (drawer || !collapsed);
  const messageSearch = useQuery({
    queryKey: ["sidebar-chat-message-search", messageSearchTerm],
    queryFn: ({ signal }) => api.searchGlobalChats(messageSearchTerm, 5, "conversation", "chats", signal),
    enabled: sidebarVisible && showingChats && Boolean(messageSearchTerm),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  useEffect(() => {
    if (!sidebarVisible || !showingChats || !filter.trim()) void queryClient.cancelQueries({ queryKey: ["sidebar-chat-message-search"] });
  }, [sidebarVisible, showingChats, filter, queryClient]);
  const currentMessageResults = messageSearchTerm === filter.trim() ? messageSearch.data : undefined;
  const messageSearchPending = Boolean(filter.trim()) &&
    (messageSearchTerm !== filter.trim() || messageSearch.isPending);
  const directorySearch = filter;
  useEffect(() => {
    if (route.kind === "allChat" || route.kind === "home" || route.kind === "manageChats") setProjectSection("chats");
    if (route.kind === "manageAgents") setProjectSection("agents");
  }, [route]);
  const projectDirectoryQuery = useProjectRailDirectory();
  const chatDirectoryQuery =
    useWorkspaceDirectory<WorkspaceConversationDirectoryItemDto>("conversation", {
      search: directorySearch,
      folders: true,
      projectId: undefined,
      enabled: projectContext && showingChats && sidebarVisible,
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
  const projectDirectory = workspaceDirectoryItems(
    projectDirectoryQuery.data?.pages,
    preferences,
  );
  const chatDirectory = workspaceDirectoryItems(chatDirectoryQuery.data?.pages, preferences);
  const agentDirectory = workspaceDirectoryItems(
    agentDirectoryQuery.data?.pages,
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
  const chatSort = workspaceResourceSort(preferences, "chat");
  const agentSort = workspaceResourceSort(preferences, "agent");
  const chatItems = sidebarChatItems([
    ...sortWorkspaceResources(chatDirectory.starredItems, chatSort, preferences.chatOrder, item => item.conversation.id, item => item.conversation.title, item => item.conversation.updatedAt),
    ...chatDirectory.items,
  ], chatDirectoryQuery.data?.pages[0]?.folderItems ?? [], preferences.chatFolders ?? []);
  const agentItems = [
    ...sortWorkspaceResources(agentDirectory.starredItems, agentSort, preferences.agentOrder, item => item.agent.id, item => item.agent.title, item => item.agent.updatedAt),
    ...agentDirectory.items,
  ];
  const projectionConversationIds = [
    ...chatItems.map(item => item.conversation.id),
    ...(route.kind === "conversation" ? [route.conversationId] : []),
  ];
  const notificationProjectionQuery = useNotificationProjection(
    projects.map(project => project.id),
    projectionConversationIds,
    preferences.chatFolders ?? [],
    // Wait for the first visible Chat page before starting folder batches, so
    // the initial empty directory cannot start a superseded set of requests.
    !(preferences.chatFolders?.length && showingChats && sidebarVisible &&
      !chatDirectoryQuery.requestState.hasResolved && !chatDirectoryQuery.requestState.isInitialError),
  );
  const activityQuery = useWorkspaceActivity(projectionConversationIds, preferences.chatFolders ?? [], showingChats && sidebarVisible && documentVisible);
  const activityFresh = workspaceConnection.phaseEvidenceFresh && !activityQuery.isError && !activityQuery.isStale;
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
  const activeProject = activeProjectId
    ? projectById.get(activeProjectId)
    : undefined;
  // Share the mounted timeline cache. The timeline owns its fallback poll;
  // sidebar metadata follows the same canonical fetch and SSE invalidations.
  const activeConversationQuery = useConversation(
    route.kind === "conversation" ? route.conversationId : undefined,
    100,
    false,
  );
  const activeAgentQuery = useAgent(
    route.kind === "agent" ? route.agentId : undefined,
    1,
  );
  const agentsActivity = activeWorkspaceAgentQuery.data?.pages.at(-1)?.activity;
  const counts = {
    attention: notificationCounts?.unacknowledgedActionCount ?? notifications.filter(isOpenAttention).length,
    updates: notificationCounts?.unreadUpdateCount ?? notifications.filter(isUnreadNotificationUpdate).length,
  };
  const healthQuery = useQuery({
    queryKey: queryKeys.health.all,
    queryFn: () => api.getHealth(),
    enabled: showingSettings,
    staleTime: 60_000,
  });
  const [renamingAgent, setRenamingAgent] = useState<AgentDto>();
  const [deletingAgent, setDeletingAgent] = useState<AgentDto>();
  const setProjectFilter = setFilter;
  const renameAgent = useMutation({
    mutationFn: ({ agent, title }: { agent: AgentDto; title: string }) =>
      api.updateAgent(agent.id, { title }),
    onSuccess: updated => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(updated.projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(updated.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("agent") });
      setRenamingAgent(undefined);
    },
  });
  const showNavigation = (next: Route) => {
    setDrawerProjectId(undefined);
    setSidebarSection("home");
    setFilter("");
    onNavigate(next);
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

  const selectSidebar = (section: typeof projectSection) => {
    setSidebarSection("home");
    setProjectSection(section);
    setFilter("");
    if (collapsed) onCollapsedChange?.(false);
  };
  const rail = (
    <ProjectRail
      sections={{ active: showingSettings ? undefined : projectSection, agentsActivity, agentsActivityFresh: workspaceConnection.phaseEvidenceFresh && !activeWorkspaceAgentQuery.isError, onSelect: selectSidebar }}
      drawer={drawer}
      route={route}
      profile={preferences.profile}
      attentionNotifications={counts.attention}
      unreadNotificationUpdates={counts.updates}
      onOpenHome={() => showNavigation({ kind: "home" })}
      onOpenAllMessages={() => showNavigation({ kind: "allChat" })}
      onManageSection={section => showNavigation(
        section === "agents"
          ? { kind: "manageAgents" }
          : { kind: "manageChats" },
      )}
      onOpenSearch={() => onSearch?.()}
      onOpenNotifications={() => onOpenNotifications?.()}
      onOpenSettings={() => onNavigate({ kind: "settings", section: "general" })}
      onCollapse={!drawer && onCollapsedChange ? () => {
        onCollapsedChange(true);
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('[aria-label="Open workspace navigation"]')?.focus();
        });
      } : undefined}
      onClose={onDismiss}
    />
  );

  const starredResourceIds = starredWorkspaceResources(preferences);
  const toggleStar = (
    kind: "project" | "conversation" | "agent",
    id: string,
  ) => onPreferences(toggleWorkspaceResourceStar(preferences, kind, id));
  const setResourceSort = (
    kind: "chat" | "agent",
    sort: ProjectSort,
    visibleIds: string[],
    currentOrder: string[] | undefined,
  ) => {
    const patch = workspaceResourceSortPatch(kind, sort);
    if (sort === "custom" && !currentOrder?.length) {
      const order = customOrderSeed(currentOrder, visibleIds);
      onPreferences({ ...patch, [kind === "chat" ? "chatOrder" : "agentOrder"]: order });
    } else onPreferences(patch);
  };
  const panelCreate = showingChats
    ? { label: "Create Chat", run: () => onCreate("chat", { projectId: activeProjectId ?? projects[0]?.id }) }
    : showingAgents
      ? { label: "Create Agent", run: () => onCreate("agent", { projectId: activeProjectId ?? projects[0]?.id }) }
      : undefined;
  const runningAgentCount = activeWorkspaceAgentQuery.data?.pages.at(-1)?.runningCount;
  const agentsHeading = runningAgentCount === undefined
    ? activeWorkspaceAgentQuery.isError ? "Agents · count unavailable" : "Agents · loading count…"
    : `Agents · ${runningAgentCount} working`;
  const panelHeader = <Stack direction="row" sx={{ alignItems: "center", pl: 2, pr: .25, pt: drawer ? .75 : 1.5, pb: 1 }}>
    <Typography component="div" sx={{ minWidth: 0, flex: 1, fontSize: 15, fontWeight: 700 }}>{showingAgents ? agentsHeading : "Chats"}</Typography>
    {panelCreate ? <Tooltip title={panelCreate.label}><IconButton size="small" aria-label={panelCreate.label} onClick={panelCreate.run}><AddIcon fontSize="small" /></IconButton></Tooltip> : null}
  </Stack>;
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
      const unread = conversationUnread(conversation.id);
      return (
        <Stack
          key={conversation.id}
          direction="row"
          sx={{ alignItems: "center", mb: 0.25 }}
        >
          <SidebarResourceRow href={routeToPath({ kind: "conversation", projectId: chatProject.id, conversationId: conversation.id })} id={`sidebar-conversation:${conversation.id}`} label={`Open Chat ${conversation.title}`} title={conversation.title} icon={<ChatBubbleOutlineIcon fontSize="small" />}
            starred={starred} emphasis={Boolean(unread.totalCount)} boldWhenStarred={false} selected={route.kind === "conversation" && route.conversationId === conversation.id}
            onOpen={() => openChat(chatProject, conversation)} onStar={() => toggleStar("conversation", conversation.id)}
            status={<>
              <SidebarNotificationBadge unread={notificationProjectionQuery.data?.conversations[conversation.id]} />
              <SidebarActivityBadge activity={activityQuery.data?.conversations[conversation.id]} fresh={activityFresh} /></>} />
        </Stack>
      );
    });
  const globalChatsPanel = (
    <ChatFolders items={chatRows} folders={preferences.chatFolders ?? []} sort={chatSort}
      folderUnread={notificationProjectionQuery.data?.chatFolders}
      folderActivity={activityQuery.data?.chatFolders} activityFresh={activityFresh}
      notificationState={notificationProjectionQuery.isError ? "unavailable" : "loading"}
      openItems={activeChatRow ? [activeChatRow] : []}
      starredIds={starredResourceIds} filtering={Boolean(filter.trim())}
      renderRow={item => globalChatResourceRows([item])}
      onChange={(chatFolders, customOrder) => onPreferences({ chatFolders, ...(customOrder ? {
        chatSort: "custom",
        ...(chatSort === "custom" ? {} : { chatOrder: customOrderSeed(preferences.chatOrder, allChatRows.map(row => row.conversation.id)) }),
      } : {}) })}
      onRename={onRenameConversation} onDelete={onDeleteConversation}
      onReorder={(source, target, position, chatFolders) => {
        const visibleIds = allChatRows.map(row => row.conversation.id);
        onPreferences({ chatSort: "custom", chatOrder: reorderStableIds(chatSort === "custom" ? preferences.chatOrder : customOrderSeed(preferences.chatOrder, visibleIds), visibleIds, source, target, position), ...(chatFolders ? { chatFolders } : {}) });
      }}>
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
      collectionFeedback={<>
        {filter.trim() ? <Box component="section" aria-label="Found in messages" sx={{ mt: 1 }}>
          <SidebarSectionHeading>Found in messages</SidebarSectionHeading>
          {messageSearchPending ? <Typography variant="caption" role="status">Searching messages…</Typography> :
            messageSearch.isError ? <Typography variant="caption" role="status">Message results are unavailable. Chat-name results are still shown.</Typography> :
            currentMessageResults?.results.map(result => <ListItemButton key={result.chat.id}
              component="a" href={routeToPath(routeForGlobalSearchSelection({ projectId: result.project.id, chat: result.chat, messageId: result.messageId }))}
              aria-label={`Open ${result.chat.title} at matching message`}
              onClick={event => { if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); showNavigation(routeForGlobalSearchSelection({ projectId: result.project.id, chat: result.chat, messageId: result.messageId })); } }}
              sx={{ display: "block", borderRadius: 1 }}>
              <Typography variant="body2" fontWeight={600}>{result.chat.title}</Typography>
              <Typography variant="caption" color="text.secondary">{result.project.label}</Typography>
              <Box><SearchSnippet snippet={result.snippet} ranges={result.highlights} query={filter.trim()} /></Box>
            </ListItemButton>)}
          {currentMessageResults?.truncated ? <Typography variant="caption">Older matches may not be shown.</Typography> : null}
          <Button size="small" onClick={() => onSearch?.({ query: filter.trim(), scope: "chats" })}>View more in full search</Button>
        </Box> : null}
        <CollectionStateFeedback request={chatDirectoryQuery.requestState} itemCount={chatRows.length} filtersActive={Boolean(filter.trim())} resourceLabel="Chats" emptyTitle="No Chats Yet" noMatchTitle={"No Chats match “" + filter.trim() + "”."} onClearFilters={() => setFilter("")} compact
          suppressEmpty={Boolean(filter.trim()) && (messageSearchPending || messageSearch.isError || Boolean(currentMessageResults?.results.length))} />
      </>}
      sort={chatSort}
      onSort={value => setResourceSort("chat", value, allChatRows.map(row => row.conversation.id), preferences.chatOrder)}
      drawer={drawer}
    />)}
    </ChatFolders>
  );

  type AgentSidebarRow = {
    agent: (typeof agentItems)[number]["agent"];
    project: (typeof agentItems)[number]["project"];
    ownerConversation?: WorkspaceAgentDirectoryItemDto["ownerConversation"];
    health?: WorkspaceAgentDirectoryItemDto["health"];
    healthConfirmedAt?: string;
    status?: (typeof agentItems)[number]["health"]["status"];
  };
  type AgentSidebarTreeRow = AgentSidebarRow & {
    depth: number;
    hasChildren: boolean;
  };
  const allAgentRows: AgentSidebarRow[] = agentItems.map(
    ({ agent, project, ownerConversation, health, healthConfirmedAt }) => ({
      agent,
      project,
      ownerConversation,
      health,
      healthConfirmedAt,
      status: health.status,
    }),
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
  const agentNameCounts = new Map<string, number>();
  for (const row of allAgentRows) agentNameCounts.set(row.agent.title, (agentNameCounts.get(row.agent.title) ?? 0) + 1);
  const duplicateAgentNames = new Set([...agentNameCounts].filter(([, count]) => count > 1).map(([name]) => name));
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
    items.map(({ agent, project: agentProject, ownerConversation, health, healthConfirmedAt, depth, hasChildren }) => {
      const starred = starredResourceIds.has(
        resourcePreferenceKey("agent", agent.id),
      );
      const ownerTitle = ownerConversation?.title ?? "Unavailable Chat";
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
            const source = allAgentRows.find(row => row.agent.id === draggedResource?.id);
            if (draggedResource?.kind === "agent" && source && source.agent.managerAgentId === agent.managerAgentId &&
                starredResourceIds.has(resourcePreferenceKey("agent", source.agent.id)) === starred) event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            const source = allAgentRows.find(row => row.agent.id === draggedResource?.id);
            if (draggedResource?.kind === "agent" && source && source.agent.managerAgentId === agent.managerAgentId &&
                starredResourceIds.has(resourcePreferenceKey("agent", source.agent.id)) === starred)
              onPreferences({
                agentSort: "custom",
                agentOrder: reorderStableIds(
                  agentSort === "custom" ? preferences.agentOrder : customOrderSeed(preferences.agentOrder, allAgentRows.map(row => row.agent.id)),
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
          <SidebarResourceRow href={routeToPath({ kind: "agent", projectId: agentProject.id, agentId: agent.id })} id={`sidebar-agent:${agent.id}`} label={`Open agent ${agent.title}, #${agent.handle}, in Chat ${ownerTitle}, ${projectDisambiguator(agentProject, projects)}`} title={agent.title}
            detail={`${ownerTitle} · #${agent.handle} · ${agent.activeEngine}`} subtitle={duplicateAgentNames.has(agent.title) ? `#${agent.handle} · ${ownerTitle}` : ownerTitle} icon={<SmartToyOutlinedIcon fontSize="small" />}
            starred={starred} nested={Boolean(agent.managerAgentId)} selected={route.kind === "agent" && route.agentId === agent.id}
            onOpen={() => onNavigate({ kind: "agent", projectId: agentProject.id, agentId: agent.id })} onStar={() => toggleStar("agent", agent.id)}
            onContextAction={anchor => openResourceMenu(anchor, { kind: "agent", projectId: agentProject.id, agentId: agent.id })}
            status={<SidebarActivityBadge activity={health ? summarizeWorkspaceActivity([health], healthConfirmedAt) : undefined} fresh={workspaceConnection.phaseEvidenceFresh} showLabel />} />
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
      sort={agentSort}
      onSort={value => setResourceSort("agent", value, allAgentRows.map(row => row.agent.id), preferences.agentOrder)}
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
  const menuRoute = menu?.resource.route;
  const menuAgent = menuRoute?.kind === "agent"
    ? [activeAgentRow, ...agentRows].find(item => item?.agent.id === menuRoute.agentId)
    : undefined;
  const menuActions: ResourceContextMenuAction<{ route: Route; conversation?: ConversationDto }>[] =
    menu?.resource.conversation ? [
      { id: "open-tab", label: "Open in new tab", onSelect: resource => { window.open(routeToPath(resource.route), "_blank", "noopener,noreferrer"); } },
      { id: "rename", label: "Rename", onSelect: resource => onRenameConversation(resource.conversation!) },
      { id: "delete", label: "Delete", color: "error", onSelect: resource => onDeleteConversation(resource.conversation!) },
    ] : menuRoute?.kind === "agent" && menuAgent ? [
      { id: "open-tab", label: "Open in new tab", onSelect: resource => { window.open(routeToPath(resource.route), "_blank", "noopener,noreferrer"); } },
      { id: "rename", label: "Rename", onSelect: () => setRenamingAgent(menuAgent.agent) },
      { id: "delete", label: "Delete", color: "error", onSelect: () => setDeletingAgent(menuAgent.agent) },
    ] : [];
  const panel = showingSettings
        ? settingsPanel
        : showingAgents
          ? agentsPanel
          : showingChats
            ? globalChatsPanel
            : null;
  const showPanel = Boolean(panel);
  const { resizing, resizeStart } = useWorkspaceSidebarResize(
    width,
    onWidthChange,
  );

  if (!drawer && collapsed) return null;

  return (
    <Box
      component="aside"
      aria-label="Workspace navigation"
      sx={{
        position: "relative",
        width: drawer ? "min(92vw, 390px)" : width,
        maxWidth: "100vw",
        height: "100%",
        alignSelf: "stretch",
        minHeight: 0,
        minWidth: 0,
        borderRight: 1,
        borderColor: resizing ? "primary.main" : "divider",
        "&:has(> [role=separator]:hover), &:has(> [role=separator]:focus-visible)": { borderColor: "primary.main" },
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "auto auto minmax(0, 1fr) auto",
        bgcolor: sidebarSurface,
        overflow: "hidden",
        transition:
          !drawer && !resizing
            ? "width 180ms cubic-bezier(0.2, 0, 0, 1)"
            : "none",
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
      }}
    >
      {rail}
      {showPanel ? <Box sx={{ gridRow: 3, minHeight: 0, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>{panel}</Box> : null}
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
          }}
        />
      ) : null}
      <ResourceContextMenu
        state={menuActions.length ? menu : undefined}
        onClose={() => setMenu(undefined)}
        actions={menuActions}
      />
      <TextInputDialog
        open={Boolean(renamingAgent)}
        title="Rename Agent"
        label="Agent name"
        initialValue={renamingAgent?.title ?? ""}
        confirmLabel="Save"
        pendingLabel="Saving…"
        pending={renameAgent.isPending}
        error={renameAgent.isError ? String(renameAgent.error) : undefined}
        validate={value => value.trim() ? undefined : "Enter an Agent name."}
        onCancel={() => {
          renameAgent.reset();
          setRenamingAgent(undefined);
        }}
        onConfirm={title => {
          if (renamingAgent) renameAgent.mutate({ agent: renamingAgent, title: title.trim() });
        }}
      />
      {deletingAgent ? <AgentDeletionDialog
        open
        projectId={deletingAgent.projectId}
        rootAgentIds={[deletingAgent.id]}
        onClose={() => setDeletingAgent(undefined)}
        onDeleted={deletedAgentIds => {
          setDeletingAgent(undefined);
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("agent") });
          if (route.kind === "agent" && deletedAgentIds.includes(route.agentId))
            onNavigate({ kind: "home" });
        }}
      /> : null}
    </Box>
  );
}
