import {
  Box,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { ConversationDto, ProjectDto } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProjectShell } from "./components/ProjectShell";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
import { ProviderStatusFlow } from "./components/ProviderStatusFlow";
import {
  GlobalChatSearch,
  isGlobalSearchShortcut,
  routeForGlobalSearchSelection,
} from "./components/GlobalChatSearch";
import { NotificationPanel } from "./components/NotificationPanel";
import { OperatorProfileDialog } from "./components/OperatorProfileDialog";
import { ProjectCreationDialog } from "./components/ProjectCreationDialog";
import {
  OnboardingCompleteDialog,
  SidebarConversationDialogs,
  type SidebarConversationAction,
} from "./components/WorkspaceDialogs";
import {
  useEngines,
  useNotifications,
  useProjects,
  useWorkspacePreferences,
} from "./hooks/queries";
import {
  useProjectAgents,
  useProjectConversations,
} from "./hooks/useProjectCollections";
import { useWorkspaceStream } from "./hooks/useWorkspaceStream";
import {
  loadLastProjectId,
  parseRoute,
  routeProjectId,
  saveLastProjectId,
  useRoute,
  type Route,
} from "./routing";
import {
  isProjectRoute,
  routeTabLabel,
  workspaceTabKey,
} from "./routeRegistry";
import type { ColorMode } from "./theme";
import {
  closeReadPushNotifications,
  inspectWebPush,
  subscribeWebPushChanges,
  syncWebPush,
} from "./pushNotifications";
import {
  consumeProjectBrowserRequest,
  ProjectBrowserContext,
  type ProjectBrowserRequest,
} from "./components/ProjectBrowserContext";
import { engineAvailabilityPresentation } from "./conversationEngine";
import {
  WORKSPACE_TABS_STORAGE_KEY,
  adjacentWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceTab,
  initializeWorkspaceTabSession,
  navigateWorkspaceTab,
  openWorkspaceTab,
  openWorkspaceTabInBackground,
  removeProjectWorkspaceTabs,
  removeProjectWorkspaceTabsWithFallback,
  removeWorkspaceRouteWithFallback,
  renameWorkspaceTab,
  reusableWorkspaceTab,
  reorderWorkspaceTabs,
  restoreWorkspaceTabSession,
  serializeWorkspaceTabs,
} from "./workspaceTabs";
import {
  WORKSPACE_SIDEBAR_STORAGE_KEY,
  restoreWorkspaceSidebarState,
  serializeWorkspaceSidebarState,
} from "./workspaceSidebarState";
import { queryKeys } from "./queryKeys";
import { MobileWorkspaceDrawer, MobileWorkspaceHeader } from "./App.mobile";
import { WorkspaceRouteOutlet } from "./App.workspace-content";
import {
  markWorkspaceResourceUsed,
  workspaceResourceFromRoute,
} from "./workspaceRecency";

const OPERATOR_PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const OPERATOR_PROFILE_IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif";

export default function App({
  colorMode,
  onToggleColorMode,
}: {
  colorMode: ColorMode;
  onToggleColorMode(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  useWorkspaceStream();
  const { route, navigate } = useRoute();
  const [initialWorkspaceSession] = useState(() => {
    try {
      const restored = restoreWorkspaceTabSession(
        window.localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY),
      );
      return initializeWorkspaceTabSession(restored, route);
    } catch {
      // Fall through to the required first tab.
    }
    return initializeWorkspaceTabSession({ tabs: [] }, route);
  });
  const [workspaceTabs, setWorkspaceTabs] = useState(
    initialWorkspaceSession.tabs,
  );
  const [activeWorkspaceTabKey, setActiveWorkspaceTabKey] = useState(
    initialWorkspaceSession.activeKey,
  );
  const [sidebarPresentation, setSidebarPresentation] = useState(() => {
    try {
      return restoreWorkspaceSidebarState(
        window.localStorage.getItem(WORKSPACE_SIDEBAR_STORAGE_KEY),
      );
    } catch {
      return restoreWorkspaceSidebarState(null);
    }
  });
  const projectsQuery = useProjects();
  const enginesQuery = useEngines();
  const preferencesQuery = useWorkspacePreferences();
  const notificationsQuery = useNotifications();
  const projectOrder = preferencesQuery.data?.projectOrder ?? [];
  const projects = [...(projectsQuery.data ?? [])].sort((a, b) => {
    if (preferencesQuery.data?.projectSort === "alphabetical")
      return a.label.localeCompare(b.label);
    if (preferencesQuery.data?.projectSort === "custom") {
      const ai = projectOrder.indexOf(a.id);
      const bi = projectOrder.indexOf(b.id);
      if (ai >= 0 || bi >= 0)
        return (
          (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) -
          (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
        );
    }
    return (
      (b.lastUsedAt ?? b.createdAt).localeCompare(
        a.lastUsedAt ?? a.createdAt,
      ) || a.id.localeCompare(b.id)
    );
  });
  const engines = enginesQuery.data ?? [];
  const engineAvailability = engineAvailabilityPresentation(engines);
  const theme = useTheme();
  const mobileWorkspace = useMediaQuery(theme.breakpoints.down("md"));

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [onboardingProjectCreation, setOnboardingProjectCreation] =
    useState(false);
  const [onboardingCompleteOpen, setOnboardingCompleteOpen] = useState(false);
  const onboardingPrompted = useRef(false);
  const [operatorProfileOpen, setOperatorProfileOpen] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [engineStatusOpen, setEngineStatusOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [sidebarConversationAction, setSidebarConversationAction] =
    useState<SidebarConversationAction>();
  const [projectBrowserRequest, setProjectBrowserRequest] =
    useState<ProjectBrowserRequest>();
  const projectBrowserRequestId = useRef(0);
  const creationOriginByWorkspace = useRef(new Map<string, Route>());
  const readinessQuery = useQuery({
    queryKey: queryKeys.readiness.all,
    queryFn: () => api.getReadiness(),
    enabled: engineStatusOpen,
    staleTime: 30_000,
  });
  const projectConversationQueries = useProjectConversations(projects);
  const projectAgentQueries = useProjectAgents(projects);
  const preferredQuotaProvider = route.kind === "agent"
    ? projectAgentQueries[
        projects.findIndex((project) => project.id === route.projectId)
      ]?.data?.find((agent) => agent.id === route.agentId)?.activeEngine
    : undefined;
  useEffect(() => {
    setWorkspaceTabs(current =>
      navigateWorkspaceTab(current, activeWorkspaceTabKey, route),
    );
  }, [route, activeWorkspaceTabKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WORKSPACE_TABS_STORAGE_KEY,
        serializeWorkspaceTabs(workspaceTabs, activeWorkspaceTabKey),
      );
    } catch {
      // Tabs remain available for this session when storage is unavailable.
    }
  }, [workspaceTabs, activeWorkspaceTabKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WORKSPACE_SIDEBAR_STORAGE_KEY,
        serializeWorkspaceSidebarState(sidebarPresentation),
      );
    } catch {
      /* Device-local presentation can remain in memory when storage is unavailable. */
    }
  }, [sidebarPresentation]);

  useEffect(() => {
    if (workspaceTabs.some(tab => tab.key === activeWorkspaceTabKey)) return;
    const next = workspaceTabs[0];
    if (!next) return;
    setActiveWorkspaceTabKey(next.key);
    navigate(next.route, { replace: true });
  }, [workspaceTabs, activeWorkspaceTabKey, navigate]);

  useEffect(() => {
    if (!projectsQuery.isSuccess) return;
    const projectIds = new Set(projects.map(project => project.id));
    setWorkspaceTabs(current => {
      const next = removeProjectWorkspaceTabs(current, projectIds);
      return next.length === current.length ? current : next;
    });
  }, [projectsQuery.isSuccess, projectsQuery.data]);

  useEffect(() => {
    const refresh = () => {
      void inspectWebPush();
    };
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      void syncWebPush(false);
    } else refresh();
    const unsubscribe = subscribeWebPushChanges(refresh);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    void closeReadPushNotifications(notificationsQuery.data ?? []);
  }, [notificationsQuery.data]);

  const routedProjectId = routeProjectId(route);
  const selectedProjectId =
    routedProjectId && projects.some(project => project.id === routedProjectId)
      ? routedProjectId
      : undefined;

  // Land on a concrete project: honour the URL, else the last-used project, else
  // the first available. Uses replace so the initial redirect isn't a history step.
  useEffect(() => {
    if (projects.length === 0) {
      return;
    }
    if (!isProjectRoute(route)) return;
    // Every project-scoped route is already a concrete destination. In
    // particular, Project overview intentionally uses the bare project route;
    // treating it like an unresolved landing page caused it to flash and then
    // redirect back to the most recent chat.
    if (selectedProjectId) return;
    const preferred = selectedProjectId ?? loadLastProjectId();
    const target =
      projects.find(project => project.id === preferred) ?? projects[0];
    if (!target) return;
    let cancelled = false;
    void api.listConversations(target.id).then(items => {
      if (cancelled) return;
      const active = items.filter(item => !item.archived);
      const conversation =
        active.find(item => item.id === target.lastConversationId) ?? active[0];
      saveLastProjectId(target.id);
      if (conversation) {
        void api.markProjectUsed(target.id, conversation.id);
        navigate(
          {
            kind: "conversation",
            projectId: target.id,
            conversationId: conversation.id,
          },
          { replace: true },
        );
      } else
        navigate({ kind: "agents", projectId: target.id }, { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [projects, selectedProjectId, navigate, route.kind]);

  const openSidebarConversationAction = (
    kind: "rename" | "delete",
    conversation: ConversationDto,
  ) => {
    setSidebarConversationAction({ kind, conversation });
  };

  const preferences = preferencesQuery.data ?? { projectSort: "last_used" as const, projectOrder: [], homeSort: "last_used" as const, homeOrder: [], chatSort: "last_used" as const, chatOrder: [], agentSort: "last_used" as const, agentOrder: [], triggerSort: "last_used" as const, triggerOrder: [], starredResourceIds: [], starredProjectIds: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter" as const, providerAvailability: {}, defaultUsageProvider: undefined as string | undefined, engineDefaults: {}, claudeModelOptions: [], globalInstructions: "", maxConcurrentAgentRuns: 8, contextRolloverEnabled: false, contextRolloverTokens: 150_000, contextRolloverWindowFraction: 0.7, onboardingCompletedAt: null, profile: { displayName: "User", handle: "operator", avatarId: "default-user" }, updatedAt: new Date(0).toISOString() };
  const usageProviders = engines.filter(engine =>
    engine.authenticated && Boolean(engine.providerUsageCommand)
  );
  const defaultQuotaProvider = usageProviders.some(
    engine => engine.id === preferences.defaultUsageProvider,
  )
    ? preferences.defaultUsageProvider
    : usageProviders[0]?.id;
  const displayedQuotaProvider = preferredQuotaProvider ?? defaultQuotaProvider;
  const mobileWorkspaceTabs = workspaceTabs.map(tab => {
    const projectId =
      "projectId" in tab.route && typeof tab.route.projectId === "string"
        ? tab.route.projectId
        : undefined;
    const projectIndex = projectId
      ? projects.findIndex(project => project.id === projectId)
      : -1;
    const project = projectIndex >= 0 ? projects[projectIndex] : undefined;
    const conversations =
      projectIndex >= 0
        ? (projectConversationQueries[projectIndex]?.data ?? [])
        : [];
    const agents =
      projectIndex >= 0 ? (projectAgentQueries[projectIndex]?.data ?? []) : [];
    return {
      ...tab,
      label:
        tab.title ??
        routeTabLabel(tab.route, {
          conversationTitle: conversationId =>
            conversations.find(item => item.id === conversationId)?.title,
          agentTitle: agentId =>
            agents.find(item => item.id === agentId)?.title,
          projectLabel: project?.label,
        }),
    };
  });
  const mobileWorkspaceTitle =
    mobileWorkspaceTabs.find(tab => tab.key === activeWorkspaceTabKey)?.label ??
    "Ponderosa";
  const savePreferences = (patch: Partial<typeof preferences>) => {
    queryClient.setQueryData(queryKeys.workspacePreferences.all, { ...preferences, ...patch });
    void api.updateWorkspacePreferences(patch).then((value) => {
      queryClient.setQueryData(queryKeys.workspacePreferences.all, value);
      if (patch.claudeModelOptions !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.engines.all });
        void queryClient.invalidateQueries({ queryKey: ["engine-models"] });
      }
    });
  };
  const closeProjectCreator = () => {
    setProjectDialogOpen(false);
    setOnboardingProjectCreation(false);
  };

  useEffect(() => {
    if (
      !projectsQuery.isSuccess ||
      !preferencesQuery.isSuccess ||
      !enginesQuery.isSuccess ||
      onboardingPrompted.current
    )
      return;
    if (projects.length > 0 || preferences.onboardingCompletedAt) return;
    onboardingPrompted.current = true;
    setOnboardingProjectCreation(true);
    setProjectDialogOpen(true);
  }, [
    engines,
    enginesQuery.isSuccess,
    preferences.onboardingCompletedAt,
    preferencesQuery.isSuccess,
    projects.length,
    projectsQuery.isSuccess,
  ]);

  useEffect(() => {
    const families = {
      inter:
        'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      system:
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      sans: "Arial, Helvetica, sans-serif",
    } as const;
    document.documentElement.style.setProperty(
      "--ponderosa-font-family",
      families[preferences.fontFamily],
    );
  }, [preferences.fontFamily]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isGlobalSearchShortcut(event)) return;
      event.preventDefault();
      setGlobalSearchOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const recordWorkspaceRouteUse = (next: Route) => {
    const resource = workspaceResourceFromRoute(next);
    if (resource) {
      markWorkspaceResourceUsed(
        queryClient,
        resource.kind,
        resource.resourceId,
      );
    }
  };
  const navigateWorkspace = (next: Route) => {
    if (next.kind !== "create") {
      creationOriginByWorkspace.current.delete(activeWorkspaceTabKey);
    }
    recordWorkspaceRouteUse(next);
    const reusable = reusableWorkspaceTab(
      workspaceTabs,
      activeWorkspaceTabKey,
      next,
    );
    const targetKey = reusable?.key ?? activeWorkspaceTabKey;
    if (reusable) setActiveWorkspaceTabKey(targetKey);
    setWorkspaceTabs(current => navigateWorkspaceTab(current, targetKey, next));
    navigate(next);
  };
  const replaceActiveWorkspace = (next: Route) => {
    if (next.kind !== "create") {
      creationOriginByWorkspace.current.delete(activeWorkspaceTabKey);
    }
    recordWorkspaceRouteUse(next);
    setWorkspaceTabs(current =>
      navigateWorkspaceTab(current, activeWorkspaceTabKey, next),
    );
    navigate(next);
  };
  const activateWorkspaceView = (key: string) => {
    const tab = workspaceTabs.find(candidate => candidate.key === key);
    if (!tab) return;
    recordWorkspaceRouteUse(tab.route);
    setActiveWorkspaceTabKey(key);
    setWorkspaceTabs(current => navigateWorkspaceTab(current, key, tab.route));
    navigate(tab.route);
  };
  const createWorkspaceView = () => {
    const tab = createWorkspaceTab({ kind: "home" });
    setWorkspaceTabs(current =>
      openWorkspaceTab(current, tab.route, tab.lastActivatedAt, tab.key),
    );
    setActiveWorkspaceTabKey(tab.key);
    navigate(tab.route);
  };
  const openWorkspaceRoute = (next: Route) => {
    recordWorkspaceRouteUse(next);
    const tab = createWorkspaceTab(next);
    setWorkspaceTabs(current =>
      openWorkspaceTab(current, next, tab.lastActivatedAt, tab.key),
    );
    setActiveWorkspaceTabKey(tab.key);
    navigate(next);
  };
  const openCreationForm = (
    kind: "project" | "chat" | "agent" | "trigger",
    context?: {
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
      agentId?: string;
    },
  ) => {
    if (route.kind !== "create") {
      creationOriginByWorkspace.current.set(activeWorkspaceTabKey, route);
    }
    const destination: Route = {
      kind: "create",
      resource: kind,
      surface: "workspace",
      ...(context?.projectId ? { projectId: context.projectId } : {}),
      ...(context?.conversationId
        ? { conversationId: context.conversationId }
        : {}),
      ...(context?.managerAgentId
        ? { managerAgentId: context.managerAgentId }
        : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
    };
    replaceActiveWorkspace(destination);
  };
  const replaceWorkspaceWithCreationForm = (
    kind: "project" | "chat" | "agent" | "trigger",
  ) => {
    if (route.kind !== "create") {
      creationOriginByWorkspace.current.set(activeWorkspaceTabKey, route);
    }
    replaceActiveWorkspace({
      kind: "create",
      resource: kind,
    });
  };
  const openWorkspaceRouteInBackground = (next: Route) => {
    recordWorkspaceRouteUse(next);
    const tab = createWorkspaceTab(next);
    setWorkspaceTabs(current =>
      openWorkspaceTabInBackground(current, next, tab.lastActivatedAt, tab.key),
    );
  };
  const openProjectBrowser = (url?: string) => {
    if (!selectedProjectId) return;
    projectBrowserRequestId.current += 1;
    setProjectBrowserRequest({
      ...(url ? { url } : {}),
      requestId: projectBrowserRequestId.current,
    });
    openWorkspaceRoute({ kind: "browser", projectId: selectedProjectId });
  };
  useEffect(() => {
    const openNotificationRoute = (event: MessageEvent) => {
      if (
        event.data?.type !== "ponderosa:open-route" ||
        typeof event.data.url !== "string"
      )
        return;
      const target = new URL(event.data.url, window.location.origin);
      if (target.origin !== window.location.origin) return;
      openWorkspaceRoute(parseRoute(target.pathname, target.search));
    };
    navigator.serviceWorker?.addEventListener("message", openNotificationRoute);
    return () =>
      navigator.serviceWorker?.removeEventListener(
        "message",
        openNotificationRoute,
      );
  }, [workspaceTabs, activeWorkspaceTabKey]);
  const closeWorkspaceView = (key: string) => {
    if (workspaceTabs.length <= 1) return;
    const nextActive =
      key === activeWorkspaceTabKey
        ? adjacentWorkspaceTab(workspaceTabs, key)
        : undefined;
    const remaining = closeWorkspaceTab(workspaceTabs, key);
    setWorkspaceTabs(remaining);
    if (nextActive) {
      setActiveWorkspaceTabKey(nextActive.key);
      recordWorkspaceRouteUse(nextActive.route);
      navigate(nextActive.route);
    }
  };
  const cancelCreationWorkspace = () => {
    const origin = creationOriginByWorkspace.current.get(
      activeWorkspaceTabKey,
    );
    if (origin) {
      creationOriginByWorkspace.current.delete(activeWorkspaceTabKey);
      replaceActiveWorkspace(origin);
      return;
    }
    if (workspaceTabs.length > 1) {
      closeWorkspaceView(activeWorkspaceTabKey);
      return;
    }
    navigateWorkspace({ kind: "home" });
  };
  const closeOtherWorkspaceViews = (key: string) => {
    const retained = workspaceTabs.find(tab => tab.key === key);
    if (!retained) return;
    setWorkspaceTabs([retained]);
    setActiveWorkspaceTabKey(key);
    recordWorkspaceRouteUse(retained.route);
    navigate(retained.route);
  };
  const renameWorkspaceView = (key: string, title: string) =>
    setWorkspaceTabs(current => renameWorkspaceTab(current, key, title));
  const reorderWorkspaceViews = (draggedKey: string, targetKey: string) => {
    setWorkspaceTabs(current =>
      reorderWorkspaceTabs(current, draggedKey, targetKey),
    );
  };
  const removeWorkspaceView = (removedRoute: Route) => {
    if (removedRoute.kind === "project") {
      const fallbackRoute: Route = { kind: "projects" };
      const activeRoute = workspaceTabs.find(
        tab => tab.key === activeWorkspaceTabKey,
      )?.route;
      const removedActiveProject =
        activeRoute !== undefined &&
        "projectId" in activeRoute &&
        activeRoute.projectId === removedRoute.projectId;
      setWorkspaceTabs(current =>
        removeProjectWorkspaceTabsWithFallback(
          current,
          activeWorkspaceTabKey,
          removedRoute.projectId,
          fallbackRoute,
        ),
      );
      if (removedActiveProject) {
        navigate(fallbackRoute, { replace: true });
      }
      return;
    }
    const fallbackRoute: Route =
      removedRoute.kind === "conversation"
        ? { kind: "project", projectId: removedRoute.projectId }
        : removedRoute.kind === "agent"
          ? { kind: "agents", projectId: removedRoute.projectId }
          : { kind: "home" };
    const activeRoute = workspaceTabs.find(
      tab => tab.key === activeWorkspaceTabKey,
    )?.route;
    const removedActiveResource =
      activeRoute !== undefined &&
      workspaceTabKey(activeRoute) === workspaceTabKey(removedRoute);
    setWorkspaceTabs(current =>
      removeWorkspaceRouteWithFallback(
        current,
        activeWorkspaceTabKey,
        removedRoute,
        fallbackRoute,
      ),
    );
    if (removedActiveResource) {
      recordWorkspaceRouteUse(fallbackRoute);
      navigate(fallbackRoute, { replace: true });
    }
  };
  const handleProjectDeleted = (projectId: string) => {
    removeWorkspaceView({ kind: "project", projectId });
  };
  useEffect(() => {
    const onWorkspaceTabShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        createWorkspaceView();
        return;
      }
      if (event.key.toLowerCase() === "w" && workspaceTabs.length > 1) {
        event.preventDefault();
        closeWorkspaceView(activeWorkspaceTabKey);
        return;
      }
      const position = Number(event.key);
      if (Number.isInteger(position) && position >= 1 && position <= 9) {
        const target =
          position === 9 ? workspaceTabs.at(-1) : workspaceTabs[position - 1];
        if (target) {
          event.preventDefault();
          activateWorkspaceView(target.key);
        }
      }
    };
    window.addEventListener("keydown", onWorkspaceTabShortcut);
    return () => window.removeEventListener("keydown", onWorkspaceTabShortcut);
  }, [workspaceTabs, activeWorkspaceTabKey]);
  const openSettings = () => {
    navigateWorkspace({ kind: "settings", section: "general" });
  };
  const openOperatorProfile = () => {
    setOperatorProfileOpen(true);
  };
  return (
    <ProjectBrowserContext.Provider
      value={{ projectId: selectedProjectId, open: openProjectBrowser }}
    >
      <Box
        data-testid="ponderosa-app"
        sx={{
          height: "100dvh",
          width: "100%",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: { xs: "auto minmax(0, 1fr)", md: "minmax(0, 1fr)" },
          bgcolor: "background.default",
        }}
      >
        <Box
          component="a"
          href="#main-content"
          sx={{
            position: "fixed",
            top: 8,
            left: 8,
            zIndex: theme => theme.zIndex.tooltip + 1,
            px: 2,
            py: 1,
            borderRadius: 1,
            bgcolor: "background.paper",
            color: "text.primary",
            boxShadow: 3,
            transform: "translateY(calc(-100% - 16px))",
            transition: "transform 120ms ease",
            "&:focus": { transform: "translateY(0)" },
          }}
        >
          Skip to content
        </Box>
        <MobileWorkspaceHeader
          title={mobileWorkspaceTitle}
          route={route}
          preferredQuotaProvider={displayedQuotaProvider}
          engineAvailability={engineAvailability}
          unreadNotifications={(notificationsQuery.data ?? []).filter(
            item => !item.readAt && (item.status ?? "open") === "open",
          ).length}
          profile={preferences.profile}
          onOpenNavigation={() => setMobileNavOpen(true)}
          onOpenEngineStatus={() => setEngineStatusOpen(true)}
          onOpenNotifications={() => setNotificationPanelOpen(true)}
          onCreateProject={() => openCreationForm("project")}
          onOpenProfile={openOperatorProfile}
          onOpenSettings={openSettings}
        />

        <Box
          sx={{
            minHeight: 0,
            minWidth: 0,
            display: "grid",
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              md: "auto minmax(0, 1fr)",
            },
          }}
        >
          <Box sx={{ display: { xs: "none", md: "block" }, minHeight: 0 }}>
            <WorkspaceSidebar
              projects={projects}
              preferences={preferences}
              route={route}
              notifications={notificationsQuery.data ?? []}
              onNavigate={navigateWorkspace}
              onOpenInNewTab={openWorkspaceRouteInBackground}
              onCreate={replaceWorkspaceWithCreationForm}
              onPreferences={savePreferences}
              onRenameConversation={conversation =>
                openSidebarConversationAction("rename", conversation)
              }
              onDeleteConversation={conversation =>
                openSidebarConversationAction("delete", conversation)
              }
              onSearch={() => setGlobalSearchOpen(true)}
              collapsed={sidebarPresentation.collapsed}
              width={sidebarPresentation.width}
              onCollapsedChange={collapsed =>
                setSidebarPresentation(current => ({ ...current, collapsed }))
              }
              onWidthChange={width =>
                setSidebarPresentation(current => ({ ...current, width }))
              }
            />
          </Box>
          <Box
            component="main"
            id="main-content"
            sx={{
              minHeight: 0,
              minWidth: 0,
              display: "grid",
              gridTemplateRows: {
                xs: "minmax(0, 1fr)",
                md: "auto minmax(0, 1fr)",
              },
            }}
          >
            {!mobileWorkspace ? (
              <WorkspaceTabs
                tabs={workspaceTabs}
                projects={projects}
                preferences={preferences}
                activeKey={activeWorkspaceTabKey}
                onActivate={activateWorkspaceView}
                notificationCount={
                  (notificationsQuery.data ?? []).filter(
                    item => !item.readAt && (item.status ?? "open") === "open",
                  ).length
                }
                onCreate={createWorkspaceView}
                onClose={closeWorkspaceView}
                onSearch={() => setGlobalSearchOpen(true)}
                onOpenInbox={() => setNotificationPanelOpen(true)}
                onOpenProfile={openOperatorProfile}
                onCloseOthers={closeOtherWorkspaceViews}
                onRename={renameWorkspaceView}
                onReorder={reorderWorkspaceViews}
                preferredProvider={displayedQuotaProvider}
              />
            ) : null}
            <WorkspaceErrorBoundary
              title="This workspace view could not be displayed."
              resetKey={`${activeWorkspaceTabKey}:${JSON.stringify(route)}`}
            >
              <WorkspaceRouteOutlet
                route={route}
                selectedProjectId={selectedProjectId}
                projects={projects}
                engines={engines}
                notifications={notificationsQuery.data ?? []}
                preferences={preferences}
                colorMode={colorMode}
                projectBrowserRequest={projectBrowserRequest}
                loadError={projectsQuery.isError || enginesQuery.isError}
                onRetryLoad={() => {
                  void projectsQuery.refetch();
                  void enginesQuery.refetch();
                }}
                onNavigate={navigateWorkspace}
                onOpenInNewTab={openWorkspaceRouteInBackground}
                onPreferences={savePreferences}
                onCreate={openCreationForm}
                onCancelCreate={cancelCreationWorkspace}
                onOpenInbox={() => setNotificationPanelOpen(true)}
                onProjectDeleted={handleProjectDeleted}
                onConversationAction={openSidebarConversationAction}
                onOpenEngineStatus={() => setEngineStatusOpen(true)}
                onBrowserRequestHandled={requestId =>
                  setProjectBrowserRequest(current =>
                    consumeProjectBrowserRequest(current, requestId),
                  )
                }
                onResourceDeleted={removeWorkspaceView}
                onToggleColorMode={onToggleColorMode}
              />
            </WorkspaceErrorBoundary>
          </Box>
        </Box>

        <MobileWorkspaceDrawer
          open={mobileNavOpen}
          projects={projects}
          preferences={preferences}
          route={route}
          notifications={notificationsQuery.data ?? []}
          onOpenChange={setMobileNavOpen}
          onNavigate={navigateWorkspace}
          onOpenInNewTab={openWorkspaceRoute}
          onCreate={replaceWorkspaceWithCreationForm}
          onPreferences={savePreferences}
          onConversationAction={openSidebarConversationAction}
          onSearch={() => setGlobalSearchOpen(true)}
        />

        <SidebarConversationDialogs
          action={sidebarConversationAction}
          onClose={() => setSidebarConversationAction(undefined)}
          onRenamed={() => setSidebarConversationAction(undefined)}
          onDeleted={conversation => {
            removeWorkspaceView({
              kind: "conversation",
              projectId: conversation.projectId,
              conversationId: conversation.id,
            });
            setSidebarConversationAction(undefined);
          }}
        />

        <GlobalChatSearch
          open={globalSearchOpen}
          onClose={() => setGlobalSearchOpen(false)}
          onSelect={selection => {
            saveLastProjectId(selection.projectId);
            if (selection.chat.kind === "conversation") {
              void api.markProjectUsed(selection.projectId, selection.chat.id);
            }
            const destination = routeForGlobalSearchSelection(selection);
            recordWorkspaceRouteUse(destination);
            navigate(destination);
          }}
          onOpenInNewTab={selection => {
            saveLastProjectId(selection.projectId);
            if (selection.chat.kind === "conversation") {
              void api.markProjectUsed(selection.projectId, selection.chat.id);
            }
            openWorkspaceRouteInBackground(
              routeForGlobalSearchSelection(selection),
            );
          }}
        />

        <ProjectCreationDialog
          open={projectDialogOpen}
          onboarding={onboardingProjectCreation}
          engines={engines}
          preferences={preferences}
          onClose={closeProjectCreator}
          onCreated={(project, onboarding) => {
            setProjectDialogOpen(false);
            if (onboarding) {
              const completedAt = new Date().toISOString();
              savePreferences({ onboardingCompletedAt: completedAt });
              setOnboardingProjectCreation(false);
              setOnboardingCompleteOpen(true);
            }
            navigate({ kind: "project", projectId: project.id });
          }}
        />
        <OnboardingCompleteDialog
          open={onboardingCompleteOpen}
          onClose={() => setOnboardingCompleteOpen(false)}
          onOpenWiki={() => {
            setOnboardingCompleteOpen(false);
            navigateWorkspace({ kind: "wiki" });
          }}
        />
        <NotificationPanel
          open={notificationPanelOpen}
          projects={projects}
          notifications={notificationsQuery.data ?? []}
          onClose={() => setNotificationPanelOpen(false)}
          onNavigate={openWorkspaceRoute}
          onOpenSettings={openSettings}
        />
        <ProviderStatusFlow
          open={engineStatusOpen}
          engines={engines}
          networkSecurity={readinessQuery.data?.networkSecurity}
          networkSecurityLoading={readinessQuery.isLoading}
          networkSecurityError={
            readinessQuery.isError ? String(readinessQuery.error) : undefined
          }
          onOpenSettings={() => {
            setEngineStatusOpen(false);
            openSettings();
          }}
          onClose={() => setEngineStatusOpen(false)}
        />
        <OperatorProfileDialog
          open={operatorProfileOpen}
          profile={preferences.profile}
          onClose={() => setOperatorProfileOpen(false)}
          onSave={profile => savePreferences({ profile })}
        />
      </Box>
    </ProjectBrowserContext.Provider>
  );
}
