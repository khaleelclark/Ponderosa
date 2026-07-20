import AddIcon from "@mui/icons-material/Add";
import SettingsIcon from "@mui/icons-material/Settings";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
import LanguageIcon from "@mui/icons-material/Language";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import {
  Alert,
  AppBar,
  Box,
  Badge,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  Checkbox,
  FormControlLabel,
  IconButton,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ConversationDto, ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProjectShell } from "./components/ProjectShell";
import { TokenUsageButton } from "./components/TokenUsageButton";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WikiView } from "./components/WikiView";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { AllProjectsView } from "./components/WorkspaceOverview";
import { HostFolderPicker } from "./components/HostFolderPicker";
import { ProviderStatusDialog } from "./components/ProviderStatusDialog";
import { GlobalChatSearch, isGlobalSearchShortcut, routeForGlobalSearchSelection } from "./components/GlobalChatSearch";
import { AllChatView } from "./components/AllChatView";
import { NotificationPanel } from "./components/NotificationPanel";
import { parseAgentRunConcurrencyLimit, RuntimeSettings } from "./components/RuntimeSettings";
import { useEngines, useNotifications, useProjectFolders, useProjects, useWorkspacePreferences } from "./hooks/queries";
import { announceWorkspaceRefresh, useWorkspaceStream } from "./hooks/useWorkspaceStream";
import {
  loadLastProjectId,
  parseRoute,
  routeProjectId,
  saveLastProjectId,
  useRoute,
  type Route,
} from "./routing";
import type { ColorMode } from "./theme";
import { createProjectRequest, nextProjectAfterDelete, projectCreationDisabled, type ProjectFolderMode } from "./projectLifecycle";
import { closeReadPushNotifications, disableWebPush, inspectWebPush, subscribeWebPushChanges, syncWebPush, type WebPushState } from "./pushNotifications";
import { consumeProjectBrowserRequest, ProjectBrowserContext, type ProjectBrowserRequest } from "./components/ProjectBrowserContext";
import { effortOptionsForModel, engineAvailabilityPresentation, engineCanTestAccess, engineIsAvailable, resolveRuntimeSelection } from "./conversationEngine";
import {
  WORKSPACE_TABS_STORAGE_KEY,
  adjacentWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceTab,
  navigateWorkspaceTab,
  openWorkspaceTab,
  removeProjectWorkspaceTabs,
  removeWorkspaceRoute,
  renameWorkspaceTab,
  reorderWorkspaceTabs,
  restoreWorkspaceTabSession,
  serializeWorkspaceTabs,
} from "./workspaceTabs";
import { hasUnreadConversationNotifications } from "./workspaceNavigation";
import { WORKSPACE_SIDEBAR_STORAGE_KEY, restoreWorkspaceSidebarState, serializeWorkspaceSidebarState } from "./workspaceSidebarState";

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
      if (restored.tabs.length > 0) return {
        tabs: restored.tabs,
        activeKey: restored.activeKey ?? restored.tabs[0]!.key,
      };
    } catch {
      // Fall through to the required first tab.
    }
    const first = createWorkspaceTab(route);
    return { tabs: [first], activeKey: first.key };
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

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectLabel, setProjectLabel] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectFolderMode, setProjectFolderMode] = useState<ProjectFolderMode>("none");
  const [projectFolderName, setProjectFolderName] = useState("");
  const [projectDefaultEngine, setProjectDefaultEngine] = useState("");
  const [projectDefaultModel, setProjectDefaultModel] = useState("");
  const [projectDefaultEffort, setProjectDefaultEffort] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [operatorProfileOpen, setOperatorProfileOpen] = useState(false);
  const [globalInstructionsDraft, setGlobalInstructionsDraft] = useState("");
  const [maxConcurrentAgentRunsDraft, setMaxConcurrentAgentRunsDraft] = useState("8");
  const [profileNameDraft, setProfileNameDraft] = useState("User");
  const [profileHandleDraft, setProfileHandleDraft] = useState("operator");
  const [profileAvatarDraft, setProfileAvatarDraft] = useState("default-user");
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [engineStatusOpen, setEngineStatusOpen] = useState(false);
  const [pushState, setPushState] = useState<WebPushState>({ kind: "permission_default", message: "Checking browser push status…" });
  const [pushBusy, setPushBusy] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string>();
  const [renamedProjectLabel, setRenamedProjectLabel] = useState("");
  const [projectInstructions, setProjectInstructions] = useState("");
  const [settingsProjectDefaultEngine, setSettingsProjectDefaultEngine] = useState("");
  const [settingsProjectDefaultModel, setSettingsProjectDefaultModel] = useState("");
  const [settingsProjectDefaultEffort, setSettingsProjectDefaultEffort] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [sidebarConversationAction, setSidebarConversationAction] = useState<{ kind: "rename" | "delete"; conversation: ConversationDto }>();
  const [sidebarConversationTitle, setSidebarConversationTitle] = useState("");
  const [projectBrowserRequest, setProjectBrowserRequest] = useState<ProjectBrowserRequest>();
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const projectBrowserRequestId = useRef(0);
  const projectFoldersQuery = useProjectFolders(projectDialogOpen);
  const providerUsageQuery = useQuery({
    queryKey: ["token-usage", "overall", undefined, "all"],
    queryFn: () => api.getTokenUsage("overall", undefined, {}),
    enabled: engineStatusOpen,
    staleTime: 30_000,
  });
  const readinessQuery = useQuery({
    queryKey: ["readiness"],
    queryFn: () => api.getReadiness(),
    enabled: engineStatusOpen,
    staleTime: 30_000,
  });

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
    queryClient.setQueryData<import("@ponderosa/core").WorkspaceNotificationDto[]>(["notifications"], (current = []) =>
      current.map((item) => item.conversationId === conversationId && !item.readAt ? { ...item, readAt } : item));
    void api.clearConversationNotifications(conversationId!).then(() => {
      announceWorkspaceRefresh();
      return queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }).catch(() => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    });
  }, [route.kind, route.kind === "conversation" ? route.conversationId : undefined, notificationsQuery.data, pageVisible, queryClient]);

  useEffect(() => {
    const refresh = () => { void inspectWebPush().then(setPushState); };
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      void syncWebPush(false).then(setPushState);
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
    if (route.kind === "projects" || route.kind === "allChat" || route.kind === "allAgents" || route.kind === "wiki") return;
    // Every project-scoped route is already a concrete destination. In
    // particular, Project overview intentionally uses the bare project route;
    // treating it like an unresolved landing page caused it to flash and then
    // redirect back to the most recent chat.
    if (["project", "conversation", "agents", "agent", "review", "browser"].includes(route.kind) && selectedProjectId) return;
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

  const createProject = useMutation({
    mutationFn: () =>
      api.createProject(createProjectRequest({
        label: projectLabel,
        mode: projectFolderMode,
        existingPath: projectPath,
        newFolderName: projectFolderName,
        defaultEngine: projectDefaultEngine as ProjectDto["defaultEngine"],
        defaultModel: projectDefaultModel,
        defaultEffort: projectDefaultEffort,
      })),
    onSuccess: (project) => {
      queryClient.setQueryData<ProjectDto[]>(["projects"], (current = []) =>
        current.some((item) => item.id === project.id) ? current : [...current, project],
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectDialogOpen(false);
      setProjectLabel("");
      setProjectPath("");
      setProjectFolderName("");
      setProjectFolderMode("none");
      setProjectDefaultEngine("");
      setProjectDefaultModel("");
      setProjectDefaultEffort("");
      navigate(project.lastConversationId ? { kind: "conversation", projectId: project.id, conversationId: project.lastConversationId } : { kind: "project", projectId: project.id });
    },
  });

  const recheckEngine = useMutation({
    mutationFn: (engineId: string) => api.recheckEngine(engineId),
    onSuccess: (updated) => {
      queryClient.setQueryData<import("@ponderosa/core").EngineDto[]>(["engines"], (current) =>
        current?.map((candidate) => candidate.id === updated.id ? updated : candidate));
      void queryClient.invalidateQueries({ queryKey: ["engines"] });
      if (updated.available) setProjectDefaultEngine(updated.id);
    },
  });
  const updateEngine = useMutation({
    mutationFn: ({ engineId, enabled }: { engineId: string; enabled: boolean }) => api.updateEngine(engineId, { enabled }),
    onSuccess: (updated) => {
      queryClient.setQueryData<import("@ponderosa/core").EngineDto[]>(["engines"], (current) => current?.map((candidate) => candidate.id === updated.id ? updated : candidate));
      void queryClient.invalidateQueries({ queryKey: ["workspace-preferences"] });
    },
  });

  const updateProject = useMutation({
    mutationFn: () => api.updateProject(settingsProjectId!, {
      label: renamedProjectLabel.trim(),
      instructions: projectInstructions,
      defaultEngine: settingsProjectDefaultEngine,
      defaultModel: settingsProjectDefaultModel || null,
      defaultEffort: settingsProjectDefaultEffort || null,
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["projects"] }); setProjectSettingsOpen(false); },
  });

  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject(settingsProjectId!),
    onSuccess: () => {
      const next = nextProjectAfterDelete(projects, settingsProjectId!);
      const survivingProjectIds = new Set(projects.filter((project) => project.id !== settingsProjectId).map((project) => project.id));
      setWorkspaceTabs((current) => removeProjectWorkspaceTabs(current, survivingProjectIds));
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDeleteConfirmationOpen(false);
      setProjectSettingsOpen(false);
      if (next) { saveLastProjectId(next.id); navigate({ kind: "project", projectId: next.id }); }
      else navigate({ kind: "allChat" });
    },
  });

  const renameSidebarConversation = useMutation({
    mutationFn: ({ conversation, title }: { conversation: ConversationDto; title: string }) =>
      api.updateConversation(conversation.id, { title }),
    onSuccess: (_updated, { conversation }) => {
      void queryClient.invalidateQueries({ queryKey: ["conversations", conversation.projectId] });
      setSidebarConversationAction(undefined);
    },
  });

  const deleteSidebarConversation = useMutation({
    mutationFn: (conversation: ConversationDto) => api.deleteConversation(conversation.id),
    onSuccess: (_deleted, conversation) => {
      setWorkspaceTabs((current) => removeWorkspaceRoute(current, { kind: "conversation", projectId: conversation.projectId, conversationId: conversation.id }));
      void queryClient.invalidateQueries({ queryKey: ["conversations", conversation.projectId] });
      setSidebarConversationAction(undefined);
      if (route.kind === "conversation" && route.conversationId === conversation.id) {
        navigate({ kind: "project", projectId: conversation.projectId }, { replace: true });
      }
    },
  });

  const openSidebarConversationAction = (kind: "rename" | "delete", conversation: ConversationDto) => {
    renameSidebarConversation.reset();
    deleteSidebarConversation.reset();
    setSidebarConversationTitle(conversation.title);
    setSidebarConversationAction({ kind, conversation });
  };

  const preferences = preferencesQuery.data ?? { projectSort: "last_used" as const, projectOrder: [], starredProjectIds: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter" as const, providerAvailability: {}, engineDefaults: {}, globalInstructions: "", maxConcurrentAgentRuns: 8, profile: { displayName: "User", handle: "operator", avatarId: "default-user" }, updatedAt: new Date(0).toISOString() };
  const savePreferences = (patch: Partial<typeof preferences>) => {
    queryClient.setQueryData(["workspace-preferences"], { ...preferences, ...patch });
    void api.updateWorkspacePreferences(patch).then((value) => queryClient.setQueryData(["workspace-preferences"], value));
  };

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
    setWorkspaceTabs((current) => navigateWorkspaceTab(current, activeWorkspaceTabKey, next));
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
    const tab = createWorkspaceTab({ kind: "allChat" });
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
  const openProjectBrowser = (url?: string) => {
    if (!selectedProjectId) return;
    projectBrowserRequestId.current += 1;
    setProjectBrowserRequest({ ...(url ? { url } : {}), requestId: projectBrowserRequestId.current });
    openWorkspaceRoute({ kind: "browser", projectId: selectedProjectId });
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
    setGlobalInstructionsDraft(preferences.globalInstructions);
    setMaxConcurrentAgentRunsDraft(String(preferences.maxConcurrentAgentRuns));
    setNotificationSettingsOpen(true);
  };
  const openOperatorProfile = () => {
    setProfileNameDraft(preferences.profile.displayName);
    setProfileHandleDraft(preferences.profile.handle);
    setProfileAvatarDraft(preferences.profile.avatarId);
    setOperatorProfileOpen(true);
  };
  const openProjectSettings = (project: ProjectDto) => {
    setSettingsProjectId(project.id);
    setRenamedProjectLabel(project.label);
    setProjectInstructions(project.instructions ?? "");
    setSettingsProjectDefaultEngine(project.defaultEngine);
    setSettingsProjectDefaultModel(project.defaultModel ?? "");
    setSettingsProjectDefaultEffort(project.defaultEffort ?? "");
    setProjectSettingsOpen(true);
  };
  const newProjectEngine = engines.find((candidate) => candidate.id === projectDefaultEngine);
  const newProjectInherited = resolveRuntimeSelection(newProjectEngine, preferences);
  const newProjectModel = projectDefaultModel || newProjectInherited.model;
  const newProjectEfforts = effortOptionsForModel(newProjectEngine, newProjectModel);
  const settingsEngine = engines.find((candidate) => candidate.id === settingsProjectDefaultEngine);
  const settingsInherited = resolveRuntimeSelection(settingsEngine, preferences);
  const settingsModel = settingsProjectDefaultModel || settingsInherited.model;
  const settingsEfforts = effortOptionsForModel(settingsEngine, settingsModel);

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
      <AppBar position="static" color="inherit" elevation={0} sx={{ display: { xs: "block", md: "none" }, borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ minHeight: { xs: 52, sm: 56 }, px: { xs: 1.5, sm: 3 }, pt: "env(safe-area-inset-top)" }}>
          <IconButton aria-label="Open workspace navigation" onClick={() => setMobileNavOpen(true)} sx={{ display: { xs: "inline-flex", md: "none" }, mr: 0.25, minWidth: 44, minHeight: 44 }}><MenuIcon /></IconButton>
          <Box component="img" src={appIconSource} alt="" sx={{ display: { xs: "none", sm: "block" }, width: 28, height: 28, mr: 1, borderRadius: 1, objectFit: "contain" }} />
          <Typography variant="h6" component="h1" sx={{ fontWeight: 800, flex: 1, minWidth: 0 }} noWrap>
            Ponderosa
          </Typography>
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
          <Button
            variant="outlined"
            color="inherit"
            startIcon={<SearchIcon />}
            onClick={() => setGlobalSearchOpen(true)}
            aria-label="Search all chats"
            sx={{ ml: 1, minWidth: { md: 190 }, justifyContent: "space-between", display: { xs: "none", md: "inline-flex" }, color: "text.secondary", borderColor: "divider" }}
          >
            Search <Box component="kbd" sx={{ ml: 2, px: .75, py: .15, border: 1, borderColor: "divider", borderRadius: .75, fontSize: 11, fontFamily: "inherit" }}>{typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</Box>
          </Button>
          <Tooltip title="Search Chats"><IconButton aria-label="Search all chats" onClick={() => setGlobalSearchOpen(true)} sx={{ display: { xs: "inline-flex", md: "none" }, minWidth: 44, minHeight: 44 }}><SearchIcon /></IconButton></Tooltip>
          <Tooltip title="Notifications"><IconButton aria-label="Open notifications" onClick={() => setNotificationPanelOpen(true)} sx={{ minWidth: 44, minHeight: 44 }}><Badge color="primary" badgeContent={(notificationsQuery.data ?? []).filter((item) => !item.readAt).length}><NotificationsOutlinedIcon /></Badge></IconButton></Tooltip>
          <Tooltip title={selectedProjectId ? "Project browser" : "Select a Project to use its browser"}><span><IconButton aria-label="Open Project browser" disabled={!selectedProjectId} onClick={() => openProjectBrowser()} sx={{ minWidth: 44, minHeight: 44 }}><LanguageIcon /></IconButton></span></Tooltip>
          <Tooltip title="New Project"><IconButton aria-label="New project" onClick={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }} sx={{ display: { xs: "none", sm: "inline-flex", md: "none" } }}><AddIcon /></IconButton></Tooltip>
          <Box sx={{ ml: 1, display: { xs: "none", sm: "block" } }}>
            <TokenUsageButton scope="overall" label="Overall" />
          </Box>
          <Tooltip title="Settings"><IconButton aria-label="Open settings" onClick={openSettings} sx={{ ml: 0.5, minWidth: 44, minHeight: 44 }}><SettingsIcon /></IconButton></Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "auto minmax(0, 1fr)" } }}>
        <Box sx={{ display: { xs: "none", md: "block" }, minHeight: 0 }}>
          <WorkspaceSidebar
            projects={projects}
            engines={engines}
            preferences={preferences}
            route={route}
            notifications={notificationsQuery.data ?? []}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRoute}
            onCreateProject={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}
            onManageProject={openProjectSettings}
            onPreferences={savePreferences}
            onRenameConversation={(conversation) => openSidebarConversationAction("rename", conversation)}
            onDeleteConversation={(conversation) => openSidebarConversationAction("delete", conversation)}
            onSearch={() => setGlobalSearchOpen(true)}
            onOpenNotifications={() => setNotificationPanelOpen(true)}
            onOpenSettings={openSettings}
            onOpenProfile={openOperatorProfile}
            onOpenEngineStatus={() => setEngineStatusOpen(true)}
            collapsed={sidebarPresentation.collapsed}
            width={sidebarPresentation.width}
            onCollapsedChange={(collapsed) => setSidebarPresentation((current) => ({ ...current, collapsed }))}
            onWidthChange={(width) => setSidebarPresentation((current) => ({ ...current, width }))}
          />
        </Box>
      <Box component="main" id="main-content" sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
        <WorkspaceTabs
          tabs={workspaceTabs}
          projects={projects}
          activeKey={activeWorkspaceTabKey}
          onActivate={activateWorkspaceView}
          onCreate={createWorkspaceView}
          onClose={closeWorkspaceView}
          onCloseOthers={closeOtherWorkspaceViews}
          onRename={renameWorkspaceView}
          onReorder={reorderWorkspaceViews}
        />
        <Box sx={{ minHeight: 0, minWidth: 0, display: "grid" }}>
        {route.kind === "wiki" ? (
          <WikiView articleId={route.articleId} navigate={navigateWorkspace} />
        ) : projectsQuery.isError || enginesQuery.isError ? (
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
        ) : projects.length === 0 && !projectsQuery.isLoading ? (
          <Box sx={{ minHeight: 0, display: "grid", placeItems: "center", p: 2 }}>
            <Stack spacing={1.5} sx={{ alignItems: "center", maxWidth: 480, textAlign: "center", p: { xs: 2.5, sm: 4 }, border: 1, borderColor: "divider", borderRadius: 3, bgcolor: "background.paper" }}>
              <Box component="img" src={appIconSource} alt="" sx={{ width: 56, height: 56, borderRadius: 2, objectFit: "contain" }} />
              <Typography variant="h5" component="h2" fontWeight={800}>Start your first project</Typography>
              <Typography color="text.secondary">Choose a working folder, then chat normally. Ponderosa handles agents and orchestration behind the conversation.</Typography>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}>New Project</Button>
            </Stack>
          </Box>
        ) : route.kind === "allChat" ? (
          <AllChatView onNavigate={navigateWorkspace} />
        ) : route.kind === "projects" || route.kind === "allAgents" ? (
          <AllProjectsView
            projects={projects}
            preferences={preferences}
            onNavigate={navigateWorkspace}
            onCreateProject={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}
            onManageProject={openProjectSettings}
            onPreferences={savePreferences}
          />
        ) : selectedProjectId ? (
          <ProjectShell
            projectId={selectedProjectId}
            project={projects.find((project) => project.id === selectedProjectId)!}
            route={route}
            engines={engines}
            navigate={navigateWorkspace}
            browserRequest={projectBrowserRequest}
            onBrowserRequestHandled={(requestId) => setProjectBrowserRequest((current) => consumeProjectBrowserRequest(current, requestId))}
            openInNewTab={openWorkspaceRoute}
            onResourceDeleted={removeWorkspaceView}
          />
        ) : (
          <Box />
        )}
        </Box>
      </Box>
      </Box>

      <Drawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} PaperProps={{ sx: { width: "min(100vw, 390px)", maxWidth: "100vw", height: "100dvh", overflow: "hidden" } }}>
        <WorkspaceSidebar
          drawer
          projects={projects}
          engines={engines}
          preferences={preferences}
          route={route}
          notifications={notificationsQuery.data ?? []}
          onNavigate={(next) => { setMobileNavOpen(false); navigateWorkspace(next); }}
          onOpenInNewTab={(next) => { setMobileNavOpen(false); openWorkspaceRoute(next); }}
          onCreateProject={() => { setMobileNavOpen(false); if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}
          onManageProject={(project) => { setMobileNavOpen(false); openProjectSettings(project); }}
          onPreferences={savePreferences}
          onRenameConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("rename", conversation); }}
          onDeleteConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("delete", conversation); }}
          onSearch={() => { setMobileNavOpen(false); setGlobalSearchOpen(true); }}
          onOpenNotifications={() => { setMobileNavOpen(false); setNotificationPanelOpen(true); }}
          onOpenSettings={() => { setMobileNavOpen(false); openSettings(); }}
          onOpenProfile={() => { setMobileNavOpen(false); openOperatorProfile(); }}
          onOpenEngineStatus={() => { setMobileNavOpen(false); setEngineStatusOpen(true); }}
        />
      </Drawer>

      <Dialog
        open={sidebarConversationAction?.kind === "rename"}
        onClose={() => setSidebarConversationAction(undefined)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Rename Project chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Project chat name"
            value={sidebarConversationTitle}
            onChange={(event) => setSidebarConversationTitle(event.target.value)}
            sx={{ mt: 1 }}
          />
          {renameSidebarConversation.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(renameSidebarConversation.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSidebarConversationAction(undefined)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!sidebarConversationTitle.trim() || renameSidebarConversation.isPending}
            onClick={() => {
              if (sidebarConversationAction?.kind === "rename") {
                renameSidebarConversation.mutate({ conversation: sidebarConversationAction.conversation, title: sidebarConversationTitle.trim() });
              }
            }}
          >
            {renameSidebarConversation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={sidebarConversationAction?.kind === "delete"}
        onClose={() => setSidebarConversationAction(undefined)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete Project chat?</DialogTitle>
        <DialogContent>
          <Typography>This permanently deletes this Project chat and refuses deletion while an assigned agent is running.</Typography>
          {deleteSidebarConversation.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(deleteSidebarConversation.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSidebarConversationAction(undefined)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteSidebarConversation.isPending}
            onClick={() => {
              if (sidebarConversationAction?.kind === "delete") deleteSidebarConversation.mutate(sidebarConversationAction.conversation);
            }}
          >
            {deleteSidebarConversation.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>

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
          openWorkspaceRoute(routeForGlobalSearchSelection(selection));
        }}
      />

      <Dialog open={projectDialogOpen} onClose={() => setProjectDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Project</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Label"
              value={projectLabel}
              onChange={(event) => setProjectLabel(event.target.value)}
              autoFocus
              fullWidth
            />
            <Box><Typography variant="subtitle2">Default AI runtime</Typography><Typography variant="body2" color="text.secondary">Used when a new chat or Agent does not choose its own provider, model, or reasoning level. Every chat can override these defaults.</Typography></Box>
            <FormControl fullWidth><InputLabel id="project-default-engine-label">Default AI provider</InputLabel><Select labelId="project-default-engine-label" label="Default AI provider" value={projectDefaultEngine} onChange={(event) => { setProjectDefaultEngine(event.target.value); setProjectDefaultModel(""); setProjectDefaultEffort(""); }}>
              {engines.map((engine) => <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>{engine.displayName}{engineIsAvailable(engine) ? "" : engine.authenticated ? " — Unavailable" : " — Not Signed In"}</MenuItem>)}
            </Select></FormControl>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <FormControl fullWidth><InputLabel id="project-default-model-label">Default model</InputLabel><Select labelId="project-default-model-label" label="Default model" value={projectDefaultModel} onChange={(event) => { setProjectDefaultModel(event.target.value); setProjectDefaultEffort(""); }}>
                <MenuItem value="">Automatic Default — {newProjectEngine?.models.find((option) => option.id === newProjectInherited.model)?.label ?? newProjectInherited.model}</MenuItem>
                {(newProjectEngine?.models ?? []).filter((option) => option.id).map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
              </Select></FormControl>
              <FormControl fullWidth><InputLabel id="project-default-effort-label">Default reasoning</InputLabel><Select labelId="project-default-effort-label" label="Default reasoning" value={projectDefaultEffort} onChange={(event) => setProjectDefaultEffort(event.target.value)}>
                <MenuItem value="">Automatic Default — {newProjectEfforts.find((option) => option.id === newProjectInherited.effort)?.label ?? newProjectInherited.effort}</MenuItem>
                {newProjectEfforts.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
              </Select></FormControl>
            </Stack>
            {engines.filter(engineCanTestAccess).map((engine) => <Alert
              key={engine.id}
              severity="warning"
              action={<Button
                color="inherit"
                size="small"
                disabled={recheckEngine.isPending}
                onClick={() => {
                  if (!window.confirm(`Test ${engine.displayName} access now? This sends one minimal subscription-backed request.`)) return;
                  recheckEngine.mutate(engine.id);
                }}
              >{recheckEngine.isPending && recheckEngine.variables === engine.id ? "Testing…" : "Test Access"}</Button>}
            >
              {engine.displayName} is configured but unavailable. {engine.availabilityDetail}
            </Alert>)}
            {recheckEngine.isError ? <Alert severity="error">{String(recheckEngine.error)}</Alert> : null}
            <Box><Typography variant="subtitle2">Working folder</Typography><Typography variant="body2" color="text.secondary">{projectFolderMode === "existing" ? projectPath || "No existing folder selected" : projectFolderMode === "create" ? `New managed folder: ${projectFolderName || "not named"}` : "Private empty workspace"}</Typography></Box>
            <Button variant="outlined" startIcon={<FolderOutlinedIcon />} onClick={() => setFolderPickerOpen(true)}>Choose Working Folder…</Button>
            {createProject.isError ? <Alert severity="error">{String(createProject.error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProjectDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={projectCreationDisabled({ label: projectLabel, mode: projectFolderMode, existingPath: projectPath, newFolderName: projectFolderName, defaultEngine: projectDefaultEngine, pending: createProject.isPending })}
            onClick={() => createProject.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
      <HostFolderPicker open={folderPickerOpen} initialMode={projectFolderMode} initialPath={projectPath || undefined} initialFolderName={projectFolderName || undefined} managedRoot={projectFoldersQuery.data?.managedRoot} onClose={() => setFolderPickerOpen(false)} onChoose={(selection) => {
        setProjectFolderMode(selection.mode);
        setProjectPath(selection.path ?? "");
        setProjectFolderName(selection.newFolderName ?? "");
        setFolderPickerOpen(false);
      }} />
      <NotificationPanel
        open={notificationPanelOpen}
        projects={projects}
        notifications={notificationsQuery.data ?? []}
        onClose={() => setNotificationPanelOpen(false)}
        onNavigate={navigate}
        onOpenSettings={openSettings}
      />
      <ProviderStatusDialog
        open={engineStatusOpen}
        engines={engines}
        networkSecurity={readinessQuery.data?.networkSecurity}
        networkSecurityLoading={readinessQuery.isLoading}
        networkSecurityError={readinessQuery.isError ? String(readinessQuery.error) : undefined}
        usage={providerUsageQuery.data}
        usageLoading={providerUsageQuery.isLoading}
        recheckingEngineId={recheckEngine.isPending ? recheckEngine.variables : undefined}
        error={recheckEngine.isError ? String(recheckEngine.error) : undefined}
        onTestAccess={(engine) => {
          if (!window.confirm(`Test ${engine.displayName} access now? This sends one minimal subscription-backed request.`)) return;
          recheckEngine.mutate(engine.id);
        }}
        onOpenSettings={() => { setEngineStatusOpen(false); openSettings(); }}
        onClose={() => setEngineStatusOpen(false)}
      />
      <Dialog open={notificationSettingsOpen} onClose={() => setNotificationSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Settings</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="subtitle2">Appearance</Typography>
            <Button variant="outlined" onClick={onToggleColorMode}>Use {colorMode === "dark" ? "Light" : "Dark"} Mode</Button>
            <FormControl fullWidth>
              <InputLabel id="font-preference-label">Font</InputLabel>
              <Select labelId="font-preference-label" label="Font" value={preferences.fontFamily} onChange={(event) => savePreferences({ fontFamily: event.target.value as typeof preferences.fontFamily })}>
                <MenuItem value="inter">Inter</MenuItem><MenuItem value="system">System</MenuItem><MenuItem value="sans">Classic Sans</MenuItem>
              </Select>
            </FormControl>
            <Typography variant="subtitle2">Notifications</Typography>
            {(Object.entries({ mentions: "Mentions", directReplies: "Direct replies", projectChatMessages: "Project-chat messages", broadcasts: "Broadcasts / #everyone", allMessages: "All messages" }) as Array<[keyof typeof preferences.notifications, string]>).map(([key, label]) => {
              const all = key !== "allMessages" && preferences.notifications.allMessages;
              return <FormControlLabel key={key} control={<Checkbox checked={preferences.notifications[key]} disabled={all} onChange={(event) => savePreferences({ notifications: { ...preferences.notifications, [key]: event.target.checked } })} />} label={all ? `${label} (included by All messages)` : label} />;
            })}
            <Alert severity={pushState.kind === "active" ? "success" : ["permission_denied", "insecure_origin", "host_unconfigured", "subscription_failed"].includes(pushState.kind) ? "warning" : "info"}>
              {pushState.message} In-app notifications remain available.
              {pushState.kind === "host_unconfigured" && pushState.setupCommand ? <Typography component="code" variant="caption" sx={{ display: "block", mt: 1, overflowWrap: "anywhere" }}>{pushState.setupCommand}</Typography> : null}
            </Alert>
            {["permission_default", "permission_granted", "subscription_failed"].includes(pushState.kind) ? (
              <Button variant="outlined" disabled={pushBusy} onClick={() => {
                setPushBusy(true);
                void syncWebPush(true).then(setPushState)
                  .finally(() => setPushBusy(false));
              }}>{pushState.kind === "subscription_failed" ? "Retry Browser Push" : "Enable Browser Push"}</Button>
            ) : null}
            {pushState.kind === "active" ? (
              <Button color="inherit" disabled={pushBusy} onClick={() => {
                setPushBusy(true);
                void disableWebPush().then(setPushState)
                  .finally(() => setPushBusy(false));
              }}>Disable on This Device</Button>
            ) : null}
            <RuntimeSettings value={maxConcurrentAgentRunsDraft} onChange={setMaxConcurrentAgentRunsDraft} />
            <Typography variant="subtitle2">AI providers</Typography>
            <Typography variant="body2" color="text.secondary">Disabled providers finish active Runs, then hold queued work until re-enabled.</Typography>
            {engines.map((engine) => {
              const resolved = resolveRuntimeSelection(engine, preferences);
              const modelOptions = engine.models.filter((option) => option.id);
              const effortOptions = effortOptionsForModel(engine, resolved.model);
              return <Stack key={engine.id} spacing={1} sx={{ p: 1.5, borderRadius: 2, bgcolor: "background.default" }}>
                <FormControlLabel control={<Switch checked={engine.enabled !== false} disabled={updateEngine.isPending} onChange={(_, enabled) => updateEngine.mutate({ engineId: engine.id, enabled })} />} label={`${engine.displayName}${engine.available ? "" : ` — ${engine.availabilityDetail ?? "unavailable"}`}`} />
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <FormControl fullWidth size="small"><InputLabel id={`workspace-model-${engine.id}`}>New-agent model</InputLabel><Select labelId={`workspace-model-${engine.id}`} label="New-agent model" value={resolved.model} onChange={(event) => {
                    const model = event.target.value;
                    const modelEfforts = effortOptionsForModel(engine, model);
                    const effort = engine.models.find((option) => option.id === model)?.defaultEffort ?? engine.defaultEffort ?? modelEfforts[0]?.id;
                    savePreferences({ engineDefaults: { ...preferences.engineDefaults, [engine.id]: { model, ...(effort ? { effort } : {}) } } });
                  }}>{modelOptions.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}</Select></FormControl>
                  <FormControl fullWidth size="small"><InputLabel id={`workspace-effort-${engine.id}`}>New-agent effort</InputLabel><Select labelId={`workspace-effort-${engine.id}`} label="New-agent effort" value={resolved.effort} onChange={(event) => savePreferences({ engineDefaults: { ...preferences.engineDefaults, [engine.id]: { model: resolved.model, effort: event.target.value } } })}>{effortOptions.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}</Select></FormControl>
                </Stack>
              </Stack>;
            })}
            {engines.some((engine) => engine.enabled !== false && !engineIsAvailable(engine)) ? <Alert severity={engines.some(engineIsAvailable) ? "warning" : "error"}>
              {engineAvailability.detail} {engines.some(engineIsAvailable) ? "Ponderosa can continue through an available engine." : "Enable or restore at least one engine before starting new work."}
            </Alert> : null}
            <Typography variant="subtitle2">Master rules</Typography>
            <TextField label="Rules for every Ponderosa Agent" value={globalInstructionsDraft} onChange={(event) => setGlobalInstructionsDraft(event.target.value)} multiline minRows={5} helperText="Ponderosa stores these rules directly and starts affected Agents with a fresh provider session on their next Run." />
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setNotificationSettingsOpen(false)}>Cancel</Button><Button variant="contained" disabled={parseAgentRunConcurrencyLimit(maxConcurrentAgentRunsDraft) === undefined} onClick={() => {
          savePreferences({
            globalInstructions: globalInstructionsDraft,
            maxConcurrentAgentRuns: parseAgentRunConcurrencyLimit(maxConcurrentAgentRunsDraft)!,
          });
          setNotificationSettingsOpen(false);
        }}>Save Settings</Button></DialogActions>
      </Dialog>

      <Dialog open={operatorProfileOpen} onClose={() => setOperatorProfileOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Operator profile</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">This synced identity controls how Agents address you and how your profile appears throughout Ponderosa.</Typography>
            <TextField autoFocus label="What Agents call you" value={profileNameDraft} onChange={(event) => setProfileNameDraft(event.target.value)} inputProps={{ maxLength: 80 }} />
            <TextField label="Handle" value={profileHandleDraft} onChange={(event) => setProfileHandleDraft(event.target.value.replace(/^#/, "").toLowerCase())} helperText="Used as your stable #handle." inputProps={{ maxLength: 32 }} />
            <FormControl fullWidth><InputLabel id="operator-profile-avatar-label">Picture</InputLabel><Select labelId="operator-profile-avatar-label" label="Picture" value={profileAvatarDraft} onChange={(event) => setProfileAvatarDraft(event.target.value)}><MenuItem value="default-user">Pine</MenuItem><MenuItem value="sunset">Sunset</MenuItem><MenuItem value="river">River</MenuItem><MenuItem value="mountain">Mountain</MenuItem><MenuItem value="fox">Fox</MenuItem><MenuItem value="owl">Owl</MenuItem></Select></FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOperatorProfileOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!profileNameDraft.trim() || !/^[a-z][a-z0-9_-]{1,31}$/.test(profileHandleDraft) || ["broadcast", "everyone", "user"].includes(profileHandleDraft)} onClick={() => {
            savePreferences({ profile: { displayName: profileNameDraft.trim(), handle: profileHandleDraft, avatarId: profileAvatarDraft } });
            setOperatorProfileOpen(false);
          }}>Save Profile</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Project settings</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Project name" value={renamedProjectLabel} onChange={(event) => setRenamedProjectLabel(event.target.value)} fullWidth />
          <FormControl fullWidth><InputLabel id="settings-project-engine-label">Default engine</InputLabel><Select labelId="settings-project-engine-label" label="Default engine" value={settingsProjectDefaultEngine} onChange={(event) => { setSettingsProjectDefaultEngine(event.target.value); setSettingsProjectDefaultModel(""); setSettingsProjectDefaultEffort(""); }}>{engines.map((engine) => <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>{engine.displayName}</MenuItem>)}</Select></FormControl>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <FormControl fullWidth><InputLabel id="settings-project-model-label">Project model</InputLabel><Select labelId="settings-project-model-label" label="Project model" value={settingsProjectDefaultModel} onChange={(event) => { setSettingsProjectDefaultModel(event.target.value); setSettingsProjectDefaultEffort(""); }}>
              <MenuItem value="">Use Workspace Setting — {settingsEngine?.models.find((option) => option.id === settingsInherited.model)?.label ?? settingsInherited.model}</MenuItem>
              {(settingsEngine?.models ?? []).filter((option) => option.id).map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
            </Select></FormControl>
            <FormControl fullWidth><InputLabel id="settings-project-effort-label">Project effort</InputLabel><Select labelId="settings-project-effort-label" label="Project effort" value={settingsProjectDefaultEffort} onChange={(event) => setSettingsProjectDefaultEffort(event.target.value)}>
              <MenuItem value="">Use Workspace Setting — {settingsEfforts.find((option) => option.id === settingsInherited.effort)?.label ?? settingsInherited.effort}</MenuItem>
              {settingsEfforts.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
            </Select></FormControl>
          </Stack>
          <TextField label="Project master rules" value={projectInstructions} onChange={(event) => setProjectInstructions(event.target.value)} multiline minRows={5} helperText="These rules apply after global rules to every Agent working in this Project." fullWidth />
          {updateProject.isError ? <Alert severity="error">{String(updateProject.error)}</Alert> : null}
          <Button color="error" variant="outlined" onClick={() => setDeleteConfirmationOpen(true)}>Delete Project Permanently</Button>
        </Stack></DialogContent><DialogActions><Button onClick={() => setProjectSettingsOpen(false)}>Cancel</Button><Button variant="contained" disabled={!renamedProjectLabel.trim() || updateProject.isPending} onClick={() => updateProject.mutate()}>Save</Button></DialogActions>
      </Dialog>

      <Dialog open={deleteConfirmationOpen} onClose={() => setDeleteConfirmationOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete this project?</DialogTitle><DialogContent><Alert severity="warning">This permanently deletes its Project chats, agents, runs, work items, and files &amp; results. The working folder and its source files are not deleted.</Alert>{deleteProject.isError ? <Alert severity="error" sx={{ mt: 2 }}>{String(deleteProject.error)}</Alert> : null}</DialogContent>
        <DialogActions><Button onClick={() => setDeleteConfirmationOpen(false)}>Cancel</Button><Button color="error" variant="contained" disabled={deleteProject.isPending} onClick={() => deleteProject.mutate()}>Delete Permanently</Button></DialogActions>
      </Dialog>
    </Box>
    </ProjectBrowserContext.Provider>
  );
}
