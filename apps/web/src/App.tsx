import AddIcon from "@mui/icons-material/Add";
import SettingsIcon from "@mui/icons-material/Settings";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  AppBar,
  Box,
  Badge,
  Button,
  Chip,
  SwipeableDrawer,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { ConversationDto, ProjectDto } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProjectShell } from "./components/ProjectShell";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WikiView } from "./components/WikiView";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
import { AllProjectsView } from "./components/WorkspaceOverview";
import { ProviderStatusFlow } from "./components/ProviderStatusFlow";
import { GlobalChatSearch, isGlobalSearchShortcut, routeForGlobalSearchSelection } from "./components/GlobalChatSearch";
import { AllChatView } from "./components/AllChatView";
import { NotificationPanel } from "./components/NotificationPanel";
import { HomeView } from "./components/HomeView";
import { NewWorkspace } from "./components/NewWorkspace";
import { AllAgentsWorkspace, AllChatsWorkspace, AllTriggersWorkspace, ProviderActivityWorkspace } from "./components/WorkspaceResourceViews";
import { OperatorProfileWorkspace, WorkspaceSettingsView } from "./components/WorkspaceSettingsView";
import { OperatorAvatar } from "./components/OperatorAvatar";
import { OperatorProfileDialog } from "./components/OperatorProfileDialog";
import { ProjectCreationDialog } from "./components/ProjectCreationDialog";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
import {
  HomeCreateDestinationDialog,
  OnboardingCompleteDialog,
  SidebarConversationDialogs,
  TriggerOwnerDialog,
  type SidebarConversationAction,
} from "./components/WorkspaceDialogs";
import { useEngines, useNotifications, useProjects, useWorkspacePreferences } from "./hooks/queries";
import { useProjectAgents } from "./hooks/useProjectCollections";
import { useWorkspaceStream } from "./hooks/useWorkspaceStream";
import {
  loadLastProjectId,
  parseRoute,
  routeProjectId,
  saveLastProjectId,
  useRoute,
  type Route,
} from "./routing";
import { assertNeverRoute, isProjectRoute } from "./routeRegistry";
import type { ColorMode } from "./theme";
import { nextProjectAfterDelete } from "./projectLifecycle";
import { closeReadPushNotifications, inspectWebPush, subscribeWebPushChanges, syncWebPush } from "./pushNotifications";
import { consumeProjectBrowserRequest, ProjectBrowserContext, type ProjectBrowserRequest } from "./components/ProjectBrowserContext";
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
  removeWorkspaceRoute,
  renameWorkspaceTab,
  reusableWorkspaceTab,
  reorderWorkspaceTabs,
  restoreWorkspaceTabSession,
  serializeWorkspaceTabs,
} from "./workspaceTabs";
import { hasUnreadConversationNotifications } from "./workspaceNavigation";
import { WORKSPACE_SIDEBAR_STORAGE_KEY, restoreWorkspaceSidebarState, serializeWorkspaceSidebarState } from "./workspaceSidebarState";
import { routeForTriggerAgentSelection, triggerAgentDestinations } from "./triggerCreation";
import { queryKeys } from "./queryKeys";

const OPERATOR_PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const OPERATOR_PROFILE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";

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
      const restored = restoreWorkspaceTabSession(window.localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY));
      return initializeWorkspaceTabSession(restored, route);
    } catch {
      // Fall through to the required first tab.
    }
    return initializeWorkspaceTabSession({ tabs: [] }, route);
  });
  const [workspaceTabs, setWorkspaceTabs] = useState(initialWorkspaceSession.tabs);
  const [activeWorkspaceTabKey, setActiveWorkspaceTabKey] = useState(initialWorkspaceSession.activeKey);
  const [sidebarPresentation, setSidebarPresentation] = useState(() => {
    try { return restoreWorkspaceSidebarState(window.localStorage.getItem(WORKSPACE_SIDEBAR_STORAGE_KEY)); }
    catch { return restoreWorkspaceSidebarState(null); }
  });
  const projectsQuery = useProjects();
  const enginesQuery = useEngines();
  const preferencesQuery = useWorkspacePreferences();
  const notificationsQuery = useNotifications();
  const projectOrder = preferencesQuery.data?.projectOrder ?? [];
  const projects = [...(projectsQuery.data ?? [])].sort((a, b) => {
    if (preferencesQuery.data?.projectSort === "alphabetical") return a.label.localeCompare(b.label);
    if (preferencesQuery.data?.projectSort === "custom") {
      const ai = projectOrder.indexOf(a.id);
      const bi = projectOrder.indexOf(b.id);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
    }
    return (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt) || a.id.localeCompare(b.id);
  });
  const engines = enginesQuery.data ?? [];
  const engineAvailability = engineAvailabilityPresentation(engines);
  const appIconSource = colorMode === "light" ? "/icons/app-icon-inverted.png" : "/icons/app-icon.png";
  const theme = useTheme();
  const mobileWorkspace = useMediaQuery(theme.breakpoints.down("md"));

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [onboardingProjectCreation, setOnboardingProjectCreation] = useState(false);
  const [onboardingCompleteOpen, setOnboardingCompleteOpen] = useState(false);
  const onboardingPrompted = useRef(false);
  const [operatorProfileOpen, setOperatorProfileOpen] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [engineStatusOpen, setEngineStatusOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<ProjectDto>();
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [homeCreateKind, setHomeCreateKind] = useState<"chat" | "agent">();
  const [homeCreateContinueToTrigger, setHomeCreateContinueToTrigger] = useState(false);
  const [triggerCreateOpen, setTriggerCreateOpen] = useState(false);
  const [sidebarConversationAction, setSidebarConversationAction] = useState<SidebarConversationAction>();
  const [projectBrowserRequest, setProjectBrowserRequest] = useState<ProjectBrowserRequest>();
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const projectBrowserRequestId = useRef(0);
  const readinessQuery = useQuery({
    queryKey: queryKeys.readiness.all,
    queryFn: () => api.getReadiness(),
    enabled: engineStatusOpen,
    staleTime: 30_000,
  });
  const projectAgentQueries = useProjectAgents(projects);
  const triggerAgentOptions = triggerAgentDestinations(
    projects,
    projectAgentQueries.map((query) => query.data),
  );

  useEffect(() => {
    setWorkspaceTabs((current) => navigateWorkspaceTab(current, activeWorkspaceTabKey, route));
  }, [route, activeWorkspaceTabKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, serializeWorkspaceTabs(workspaceTabs, activeWorkspaceTabKey));
    } catch {
      // Tabs remain available for this session when storage is unavailable.
    }
  }, [workspaceTabs, activeWorkspaceTabKey]);

  useEffect(() => {
    try { window.localStorage.setItem(WORKSPACE_SIDEBAR_STORAGE_KEY, serializeWorkspaceSidebarState(sidebarPresentation)); }
    catch { /* Device-local presentation can remain in memory when storage is unavailable. */ }
  }, [sidebarPresentation]);

  useEffect(() => {
    if (workspaceTabs.some((tab) => tab.key === activeWorkspaceTabKey)) return;
    const next = workspaceTabs[0];
    if (!next) return;
    setActiveWorkspaceTabKey(next.key);
    navigate(next.route, { replace: true });
  }, [workspaceTabs, activeWorkspaceTabKey, navigate]);

  useEffect(() => {
    if (!projectsQuery.isSuccess) return;
    const projectIds = new Set(projects.map((project) => project.id));
    setWorkspaceTabs((current) => {
      const next = removeProjectWorkspaceTabs(current, projectIds);
      return next.length === current.length ? current : next;
    });
  }, [projectsQuery.isSuccess, projectsQuery.data]);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const conversationId = route.kind === "conversation" ? route.conversationId : undefined;
    if (!pageVisible || !hasUnreadConversationNotifications(notificationsQuery.data ?? [], conversationId)) return;
    const readAt = new Date().toISOString();
    queryClient.setQueryData<import("@ponderosa/core").WorkspaceNotificationDto[]>(queryKeys.notifications.all, (current = []) =>
      current.map((item) => item.conversationId === conversationId && !item.readAt && ["mentions", "directReplies", "projectChatMessages", "broadcasts"].includes(item.kind) ? { ...item, readAt } : item));
    void api.clearConversationNotifications(conversationId!, "messages").then(() => {
      return queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    }).catch(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    });
  }, [route.kind, route.kind === "conversation" ? route.conversationId : undefined, notificationsQuery.data, pageVisible, queryClient]);

  useEffect(() => {
    const refresh = () => { void inspectWebPush(); };
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      void syncWebPush(false);
    } else refresh();
    const unsubscribe = subscribeWebPushChanges(refresh);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { unsubscribe(); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  useEffect(() => {
    void closeReadPushNotifications(notificationsQuery.data ?? []);
  }, [notificationsQuery.data]);

  const routedProjectId = routeProjectId(route);
  const selectedProjectId =
    routedProjectId && projects.some((project) => project.id === routedProjectId)
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
    const target = projects.find((project) => project.id === preferred) ?? projects[0];
    if (!target) return;
    let cancelled = false;
    void api.listConversations(target.id).then((items) => {
      if (cancelled) return;
      const active = items.filter((item) => !item.archived);
      const conversation = active.find((item) => item.id === target.lastConversationId) ?? active[0];
      saveLastProjectId(target.id);
      if (conversation) {
        void api.markProjectUsed(target.id, conversation.id);
        navigate({ kind: "conversation", projectId: target.id, conversationId: conversation.id }, { replace: true });
      } else navigate({ kind: "agents", projectId: target.id }, { replace: true });
    });
    return () => { cancelled = true; };
  }, [projects, selectedProjectId, navigate, route.kind]);

  const openSidebarConversationAction = (kind: "rename" | "delete", conversation: ConversationDto) => {
    setSidebarConversationAction({ kind, conversation });
  };

  const preferences = preferencesQuery.data ?? { projectSort: "last_used" as const, projectOrder: [], homeSort: "last_used" as const, homeOrder: [], chatSort: "last_used" as const, chatOrder: [], agentSort: "last_used" as const, agentOrder: [], triggerSort: "last_used" as const, triggerOrder: [], starredResourceIds: [], starredProjectIds: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter" as const, providerAvailability: {}, engineDefaults: {}, globalInstructions: "", maxConcurrentAgentRuns: 8, onboardingCompletedAt: null, profile: { displayName: "User", handle: "operator", avatarId: "default-user" }, updatedAt: new Date(0).toISOString() };
  const savePreferences = (patch: Partial<typeof preferences>) => {
    queryClient.setQueryData(queryKeys.workspacePreferences.all, { ...preferences, ...patch });
    void api.updateWorkspacePreferences(patch).then((value) => queryClient.setQueryData(queryKeys.workspacePreferences.all, value));
  };
  const openProjectCreator = (onboarding = false) => {
    setOnboardingProjectCreation(onboarding);
    setProjectDialogOpen(true);
  };
  const closeProjectCreator = () => {
    setProjectDialogOpen(false);
    setOnboardingProjectCreation(false);
  };

  useEffect(() => {
    if (!projectsQuery.isSuccess || !preferencesQuery.isSuccess || !enginesQuery.isSuccess || onboardingPrompted.current) return;
    if (projects.length > 0 || preferences.onboardingCompletedAt) return;
    onboardingPrompted.current = true;
    setOnboardingProjectCreation(true);
    setProjectDialogOpen(true);
  }, [engines, enginesQuery.isSuccess, preferences.onboardingCompletedAt, preferencesQuery.isSuccess, projects.length, projectsQuery.isSuccess]);


  useEffect(() => {
    const families = {
      inter: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      sans: 'Arial, Helvetica, sans-serif',
    } as const;
    document.documentElement.style.setProperty("--ponderosa-font-family", families[preferences.fontFamily]);
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

  const navigateWorkspace = (next: Route) => {
    const reusable = reusableWorkspaceTab(workspaceTabs, activeWorkspaceTabKey, next);
    const targetKey = reusable?.key ?? activeWorkspaceTabKey;
    if (reusable) setActiveWorkspaceTabKey(targetKey);
    setWorkspaceTabs((current) => navigateWorkspaceTab(current, targetKey, next));
    navigate(next);
  };
  const activateWorkspaceView = (key: string) => {
    const tab = workspaceTabs.find((candidate) => candidate.key === key);
    if (!tab) return;
    setActiveWorkspaceTabKey(key);
    setWorkspaceTabs((current) => navigateWorkspaceTab(current, key, tab.route));
    navigate(tab.route);
  };
  const createWorkspaceView = () => {
    const tab = createWorkspaceTab({ kind: "home" });
    setWorkspaceTabs((current) => openWorkspaceTab(current, tab.route, tab.lastActivatedAt, tab.key));
    setActiveWorkspaceTabKey(tab.key);
    navigate(tab.route);
  };
  const openWorkspaceRoute = (next: Route) => {
    const tab = createWorkspaceTab(next);
    setWorkspaceTabs((current) => openWorkspaceTab(current, next, tab.lastActivatedAt, tab.key));
    setActiveWorkspaceTabKey(tab.key);
    navigate(next);
  };
  const openNewWorkspace = (createKind: "project" | "chat" | "agent" | "trigger") => {
    openWorkspaceRoute({ kind: "new", createKind });
  };
  const openWorkspaceRouteInBackground = (next: Route) => {
    const tab = createWorkspaceTab(next);
    setWorkspaceTabs((current) => openWorkspaceTabInBackground(current, next, tab.lastActivatedAt, tab.key));
  };
  const openProjectBrowser = (url?: string) => {
    if (!selectedProjectId) return;
    projectBrowserRequestId.current += 1;
    setProjectBrowserRequest({ ...(url ? { url } : {}), requestId: projectBrowserRequestId.current });
    openWorkspaceRoute({ kind: "browser", projectId: selectedProjectId });
  };
  const createHomeChat = async (projectId?: string) => {
    const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];
    if (!project) return;
    const conversation = await api.createConversation(project.id, { title: "New Project Chat", defaultEngine: project.defaultEngine });
    await api.markProjectUsed(project.id, conversation.id);
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.project(project.id) });
    navigateWorkspace({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };
  const createHomeAgent = (projectId?: string, continueToTrigger = false, managerAgentId?: string) => {
    const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];
    if (project) navigateWorkspace({
      kind: "agents",
      projectId: project.id,
      create: true,
      ...(managerAgentId ? { managerAgentId } : {}),
      ...(continueToTrigger ? { continueToTrigger: true } : {}),
    });
  };
  const beginTriggerCreate = () => {
    setTriggerCreateOpen(true);
  };
  const beginHomeCreate = (kind: "chat" | "agent" | "trigger") => {
    if (kind === "trigger") {
      beginTriggerCreate();
      return;
    }
    if (projects.length === 1) {
      const projectId = projects[0]!.id;
      if (kind === "chat") void createHomeChat(projectId);
      else createHomeAgent(projectId);
      return;
    }
    setHomeCreateContinueToTrigger(false);
    setHomeCreateKind(kind);
  };

  const continueHomeCreate = (projectId: string) => {
    if (!homeCreateKind) return;
    const kind = homeCreateKind;
    const continueToTrigger = homeCreateContinueToTrigger;
    setHomeCreateKind(undefined);
    setHomeCreateContinueToTrigger(false);
    if (kind === "chat") void createHomeChat(projectId);
    else createHomeAgent(projectId, continueToTrigger);
  };

  useEffect(() => {
    const openNotificationRoute = (event: MessageEvent) => {
      if (event.data?.type !== "ponderosa:open-route" || typeof event.data.url !== "string") return;
      const target = new URL(event.data.url, window.location.origin);
      if (target.origin !== window.location.origin) return;
      openWorkspaceRoute(parseRoute(target.pathname, target.search));
    };
    navigator.serviceWorker?.addEventListener("message", openNotificationRoute);
    return () => navigator.serviceWorker?.removeEventListener("message", openNotificationRoute);
  }, [workspaceTabs, activeWorkspaceTabKey]);
  const closeWorkspaceView = (key: string) => {
    if (workspaceTabs.length <= 1) return;
    const nextActive = key === activeWorkspaceTabKey ? adjacentWorkspaceTab(workspaceTabs, key) : undefined;
    const remaining = closeWorkspaceTab(workspaceTabs, key);
    setWorkspaceTabs(remaining);
    if (nextActive) {
      setActiveWorkspaceTabKey(nextActive.key);
      navigate(nextActive.route);
    }
  };
  const closeOtherWorkspaceViews = (key: string) => {
    const retained = workspaceTabs.find((tab) => tab.key === key);
    if (!retained) return;
    setWorkspaceTabs([retained]);
    setActiveWorkspaceTabKey(key);
    navigate(retained.route);
  };
  const renameWorkspaceView = (key: string, title: string) => setWorkspaceTabs((current) => renameWorkspaceTab(current, key, title));
  const reorderWorkspaceViews = (draggedKey: string, targetKey: string) => {
    setWorkspaceTabs((current) => reorderWorkspaceTabs(current, draggedKey, targetKey));
  };
  const removeWorkspaceView = (removedRoute: Route) => {
    setWorkspaceTabs((current) => removeWorkspaceRoute(current, removedRoute));
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
        const target = position === 9 ? workspaceTabs.at(-1) : workspaceTabs[position - 1];
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
  const openProjectSettings = (project: ProjectDto) => {
    setSettingsProject(project);
  };

  return (
    <ProjectBrowserContext.Provider value={{ projectId: selectedProjectId, open: openProjectBrowser }}>
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
          zIndex: (theme) => theme.zIndex.tooltip + 1,
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
      <AppBar position="static" color="inherit" elevation={0} sx={{ display: { xs: "block", md: "none" }, borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ minHeight: { xs: 52, sm: 56 }, px: { xs: 1.5, sm: 3 }, pt: "env(safe-area-inset-top)" }}>
          <IconButton aria-label="Open workspace navigation" onClick={() => setMobileNavOpen(true)} sx={{ display: { xs: "inline-flex", md: "none" }, mr: 0.25 }}><MenuIcon /></IconButton>
          <Box component="img" src={appIconSource} alt="" sx={{ display: "block", width: { xs: 26, sm: 28 }, height: { xs: 26, sm: 28 }, mr: { xs: 0.75, sm: 1 }, borderRadius: 1, objectFit: "contain", flexShrink: 0 }} />
          <Box aria-label="Ponderosa" sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" component="h1" sx={{ fontWeight: 800, minWidth: 0 }} noWrap>Ponderosa</Typography>
          </Box>
          <Tooltip title={`${engineAvailability.label}. Click for provider details.`} arrow enterTouchDelay={0}>
            <Chip
              size="small"
              label={engineAvailability.label}
              color={engineAvailability.severity}
              variant="outlined"
              tabIndex={0}
              aria-label={`${engineAvailability.label}. ${engineAvailability.detail}`}
              onClick={() => setEngineStatusOpen(true)}
              sx={{ maxWidth: { sm: 132, md: "none" }, display: { xs: "none", sm: "inline-flex" }, cursor: "pointer" }}
            />
          </Tooltip>
          <Tooltip title="Notifications"><IconButton aria-label="Open notifications" onClick={() => setNotificationPanelOpen(true)}><Badge color="primary" badgeContent={(notificationsQuery.data ?? []).filter((item) => !item.readAt && (item.status ?? "open") === "open").length}><NotificationsOutlinedIcon /></Badge></IconButton></Tooltip>
          <Tooltip title="New Project"><IconButton aria-label="New project" onClick={() => openProjectCreator()} sx={{ display: { xs: "none", sm: "inline-flex", md: "none" } }}><AddIcon /></IconButton></Tooltip>
          <Tooltip title="Operator Profile"><IconButton aria-label="Open operator profile" onClick={openOperatorProfile} sx={{ ml: .5, p: 0, width: 44, height: 44 }}><OperatorAvatar profile={preferences.profile} size={32} /></IconButton></Tooltip>
          <Tooltip title="Settings"><IconButton aria-label="Open settings" onClick={openSettings} sx={{ ml: 0.5 }}><SettingsIcon /></IconButton></Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "auto minmax(0, 1fr)" } }}>
        <Box sx={{ display: { xs: "none", md: "block" }, minHeight: 0 }}>
          <WorkspaceSidebar
            projects={projects}
            preferences={preferences}
            route={route}
            notifications={notificationsQuery.data ?? []}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRouteInBackground}
            onCreateProject={() => openNewWorkspace("project")}
            onCreateChat={() => openNewWorkspace("chat")}
            onCreateAgent={() => openNewWorkspace("agent")}
            onCreateTrigger={() => openNewWorkspace("trigger")}
            onPreferences={savePreferences}
            onRenameConversation={(conversation) => openSidebarConversationAction("rename", conversation)}
            onDeleteConversation={(conversation) => openSidebarConversationAction("delete", conversation)}
            onSearch={() => setGlobalSearchOpen(true)}
            collapsed={sidebarPresentation.collapsed}
            width={sidebarPresentation.width}
            onCollapsedChange={(collapsed) => setSidebarPresentation((current) => ({ ...current, collapsed }))}
            onWidthChange={(width) => setSidebarPresentation((current) => ({ ...current, width }))}
          />
        </Box>
      <Box component="main" id="main-content" sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: { xs: "minmax(0, 1fr)", md: "auto minmax(0, 1fr)" } }}>
        {!mobileWorkspace ? <WorkspaceTabs
          tabs={workspaceTabs}
          projects={projects}
          preferences={preferences}
          activeKey={activeWorkspaceTabKey}
          onActivate={activateWorkspaceView}
          notificationCount={(notificationsQuery.data ?? []).filter((item) => !item.readAt && (item.status ?? "open") === "open").length}
          onCreate={createWorkspaceView}
          onClose={closeWorkspaceView}
          onSearch={() => setGlobalSearchOpen(true)}
          onOpenInbox={() => setNotificationPanelOpen(true)}
          onOpenProfile={openOperatorProfile}
          onCloseOthers={closeOtherWorkspaceViews}
          onRename={renameWorkspaceView}
          onReorder={reorderWorkspaceViews}
        /> : null}
        <WorkspaceErrorBoundary
          title="This workspace view could not be displayed."
          resetKey={`${activeWorkspaceTabKey}:${JSON.stringify(route)}`}
        >
        <Box sx={{ minHeight: 0, minWidth: 0, display: "grid" }}>
        {projectsQuery.isError || enginesQuery.isError ? (
          <Box sx={{ p: 2 }}>
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    void projectsQuery.refetch();
                    void enginesQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              }
            >
              Ponderosa could not load its workspace data. Check the server connection and try again.
            </Alert>
          </Box>
        ) : route.kind === "wiki" ? (
          <WikiView articleId={route.articleId} navigate={navigateWorkspace} />
        ) : route.kind === "new" ? (
          <NewWorkspace
            initialKind={route.createKind}
            onKindChange={(createKind) => navigateWorkspace({ kind: "new", createKind })}
            onCreate={(createKind) => {
              if (createKind === "project") openProjectCreator();
              else beginHomeCreate(createKind);
            }}
          />
        ) : route.kind === "home" ? (
          <HomeView
            projects={projects}
            engines={engines}
            notifications={notificationsQuery.data ?? []}
            preferences={preferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRouteInBackground}
            onPreferences={savePreferences}
            onCreateProject={() => openNewWorkspace("project")}
            onCreateChat={() => openNewWorkspace("chat")}
            onCreateAgent={() => openNewWorkspace("agent")}
            onCreateTrigger={() => openNewWorkspace("trigger")}
            onOpenInbox={() => setNotificationPanelOpen(true)}
          />
        ) : route.kind === "allChat" ? (
          <AllChatView onNavigate={navigateWorkspace} notifications={notificationsQuery.data ?? []} />
        ) : route.kind === "projects" ? (
          <AllProjectsView
            projects={projects}
            preferences={preferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRouteInBackground}
            onCreateProject={() => openNewWorkspace("project")}
            onManageProject={openProjectSettings}
            onPreferences={savePreferences}
          />
        ) : route.kind === "allAgents" ? (
          <AllAgentsWorkspace
            projects={projects}
            engines={engines}
            filterProjectId={route.filterProjectId}
            preferences={preferences}
            onPreferences={savePreferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRouteInBackground}
            onCreate={(projectId, managerAgentId) => projectId ? createHomeAgent(projectId, false, managerAgentId) : openNewWorkspace("agent")}
          />
        ) : route.kind === "allChats" ? (
          <AllChatsWorkspace
            projects={projects}
            filterProjectId={route.filterProjectId}
            preferences={preferences}
            onPreferences={savePreferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRouteInBackground}
            onCreate={(projectId) => projectId ? void createHomeChat(projectId) : openNewWorkspace("chat")}
          />
        ) : route.kind === "allTriggers" ? (
          <AllTriggersWorkspace
            projects={projects}
            preferences={preferences}
            onPreferences={savePreferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRouteInBackground}
            onCreate={() => openNewWorkspace("trigger")}
          />
        ) : route.kind === "settings" ? (
          <WorkspaceSettingsView
            preferences={preferences}
            engines={engines}
            colorMode={colorMode}
            onToggleColorMode={onToggleColorMode}
            onPreferences={savePreferences}
            section={route.section}
          />
        ) : route.kind === "profile" ? (
          <OperatorProfileWorkspace preferences={preferences} onPreferences={savePreferences} />
        ) : route.kind === "usage" ? (
          <ProviderActivityWorkspace projects={projects} projectId={route.projectId} />
        ) : isProjectRoute(route) ? (
          selectedProjectId ? (
            <ProjectShell
              projectId={selectedProjectId}
              project={projects.find((project) => project.id === selectedProjectId)!}
              route={route}
              engines={engines}
              notifications={notificationsQuery.data ?? []}
              preferences={preferences}
              onPreferences={savePreferences}
              onManageProject={openProjectSettings}
              onRenameConversation={(conversation) => openSidebarConversationAction("rename", conversation)}
              onDeleteConversation={(conversation) => openSidebarConversationAction("delete", conversation)}
              onOpenEngineStatus={() => setEngineStatusOpen(true)}
              navigate={navigateWorkspace}
              browserRequest={projectBrowserRequest}
              onBrowserRequestHandled={(requestId) => setProjectBrowserRequest((current) => consumeProjectBrowserRequest(current, requestId))}
              openInNewTab={openWorkspaceRouteInBackground}
              onResourceDeleted={removeWorkspaceView}
            />
          ) : (
            <Box />
          )
        ) : (
          assertNeverRoute(route)
        )}
        </Box>
        </WorkspaceErrorBoundary>
      </Box>
      </Box>

      <SwipeableDrawer
        open={mobileNavOpen}
        onOpen={() => setMobileNavOpen(true)}
        onClose={() => setMobileNavOpen(false)}
        disableDiscovery
        PaperProps={{ sx: { width: "min(100vw, 390px)", maxWidth: "100vw", height: "100dvh", overflow: "hidden" } }}
      >
        <Box sx={{ position: "relative", height: "100%", minHeight: 0 }}>
        <Tooltip title="Close Navigation">
          <IconButton aria-label="Close workspace navigation" onClick={() => setMobileNavOpen(false)} sx={{ position: "absolute", zIndex: 4, top: "max(8px, env(safe-area-inset-top))", right: 8, bgcolor: "background.paper", boxShadow: 1 }}><CloseIcon /></IconButton>
        </Tooltip>
        <WorkspaceSidebar
          drawer
          projects={projects}
          preferences={preferences}
          route={route}
          notifications={notificationsQuery.data ?? []}
          onNavigate={(next) => { setMobileNavOpen(false); navigateWorkspace(next); }}
          onOpenInNewTab={(next) => { setMobileNavOpen(false); openWorkspaceRoute(next); }}
          onCreateProject={() => { setMobileNavOpen(false); openNewWorkspace("project"); }}
          onCreateChat={() => { setMobileNavOpen(false); openNewWorkspace("chat"); }}
          onCreateAgent={() => { setMobileNavOpen(false); openNewWorkspace("agent"); }}
          onCreateTrigger={() => { setMobileNavOpen(false); openNewWorkspace("trigger"); }}
          onPreferences={savePreferences}
          onRenameConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("rename", conversation); }}
          onDeleteConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("delete", conversation); }}
          onSearch={() => { setMobileNavOpen(false); setGlobalSearchOpen(true); }}
        />
        </Box>
      </SwipeableDrawer>

      <SidebarConversationDialogs
        action={sidebarConversationAction}
        onClose={() => setSidebarConversationAction(undefined)}
        onRenamed={() => setSidebarConversationAction(undefined)}
        onDeleted={(conversation) => {
          setWorkspaceTabs((current) => removeWorkspaceRoute(current, { kind: "conversation", projectId: conversation.projectId, conversationId: conversation.id }));
          setSidebarConversationAction(undefined);
          if (route.kind === "conversation" && route.conversationId === conversation.id) {
            navigate({ kind: "project", projectId: conversation.projectId }, { replace: true });
          }
        }}
      />

      <GlobalChatSearch
        open={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
        onSelect={(selection) => {
          saveLastProjectId(selection.projectId);
          if (selection.chat.kind === "conversation") {
            void api.markProjectUsed(selection.projectId, selection.chat.id);
          }
          navigate(routeForGlobalSearchSelection(selection));
        }}
        onOpenInNewTab={(selection) => {
          saveLastProjectId(selection.projectId);
          if (selection.chat.kind === "conversation") {
            void api.markProjectUsed(selection.projectId, selection.chat.id);
          }
          openWorkspaceRouteInBackground(routeForGlobalSearchSelection(selection));
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
          navigate(project.lastConversationId
            ? { kind: "conversation", projectId: project.id, conversationId: project.lastConversationId }
            : { kind: "project", projectId: project.id });
        }}
      />
      <HomeCreateDestinationDialog
        kind={homeCreateKind}
        projects={projects}
        onClose={() => setHomeCreateKind(undefined)}
        onContinue={continueHomeCreate}
      />
      <TriggerOwnerDialog
        open={triggerCreateOpen}
        options={triggerAgentOptions}
        loading={projectAgentQueries.some((query) => query.isLoading)}
        onClose={() => setTriggerCreateOpen(false)}
        onCreateAgent={() => {
          setTriggerCreateOpen(false);
          setHomeCreateContinueToTrigger(true);
          if (projects.length === 1) createHomeAgent(projects[0]!.id, true);
          else setHomeCreateKind("agent");
        }}
        onContinue={(agentId) => {
          const destination = routeForTriggerAgentSelection(agentId, triggerAgentOptions);
          if (!destination) return;
          setTriggerCreateOpen(false);
          navigateWorkspace(destination);
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
        onNavigate={navigate}
        onOpenSettings={openSettings}
      />
      <ProviderStatusFlow
        open={engineStatusOpen}
        engines={engines}
        networkSecurity={readinessQuery.data?.networkSecurity}
        networkSecurityLoading={readinessQuery.isLoading}
        networkSecurityError={readinessQuery.isError ? String(readinessQuery.error) : undefined}
        onOpenSettings={() => { setEngineStatusOpen(false); openSettings(); }}
        onClose={() => setEngineStatusOpen(false)}
      />
      <OperatorProfileDialog
        open={operatorProfileOpen}
        profile={preferences.profile}
        onClose={() => setOperatorProfileOpen(false)}
        onSave={(profile) => savePreferences({ profile })}
      />
      <ProjectSettingsDialog
        project={settingsProject}
        engines={engines}
        preferences={preferences}
        onClose={() => setSettingsProject(undefined)}
        onImported={(projectId, agentId) => {
          setSettingsProject(undefined);
          navigateWorkspace({ kind: "agent", projectId, agentId });
        }}
        onDeleted={(projectId) => {
          const next = nextProjectAfterDelete(projects, projectId);
          const survivingProjectIds = new Set(projects.filter((project) => project.id !== projectId).map((project) => project.id));
          setWorkspaceTabs((current) => removeProjectWorkspaceTabs(current, survivingProjectIds));
          setSettingsProject(undefined);
          if (next) {
            saveLastProjectId(next.id);
            navigate({ kind: "project", projectId: next.id });
          } else navigate({ kind: "home" });
        }}
      />
    </Box>
    </ProjectBrowserContext.Provider>
  );
}
