import AddIcon from "@mui/icons-material/Add";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import SettingsIcon from "@mui/icons-material/Settings";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import LanguageIcon from "@mui/icons-material/Language";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import CloseIcon from "@mui/icons-material/Close";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import PhotoCameraOutlinedIcon from "@mui/icons-material/PhotoCameraOutlined";
import {
  Alert,
  AppBar,
  Box,
  Badge,
  Button,
  ButtonBase,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  SwipeableDrawer,
  Checkbox,
  FormControlLabel,
  IconButton,
  FormControl,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { ConversationDto, ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProjectShell } from "./components/ProjectShell";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WikiView } from "./components/WikiView";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { AllProjectsView } from "./components/WorkspaceOverview";
import { HostFolderPicker } from "./components/HostFolderPicker";
import { ProviderStatusDialog } from "./components/ProviderStatusDialog";
import { GlobalChatSearch, isGlobalSearchShortcut, routeForGlobalSearchSelection } from "./components/GlobalChatSearch";
import { AllChatView } from "./components/AllChatView";
import { NotificationPanel } from "./components/NotificationPanel";
import { HomeView } from "./components/HomeView";
import { AllAgentsWorkspace, AllChatsWorkspace, AllTriggersWorkspace, ProviderActivityWorkspace } from "./components/WorkspaceResourceViews";
import { OperatorProfileWorkspace, WorkspaceSettingsView } from "./components/WorkspaceSettingsView";
import { ImportAgentDialog } from "./components/ImportAgentDialog";
import { OperatorAvatar } from "./components/OperatorAvatar";
import { parseAgentRunConcurrencyLimit, RuntimeSettings } from "./components/RuntimeSettings";
import { useEngines, useNotifications, useProjects, useWorkspacePreferences } from "./hooks/queries";
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
  initializeWorkspaceTabSession,
  navigateWorkspaceTab,
  openWorkspaceTab,
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
  const [projectLabel, setProjectLabel] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectFolderMode, setProjectFolderMode] = useState<ProjectFolderMode>("none");
  const [projectDefaultEngine, setProjectDefaultEngine] = useState("");
  const [projectDefaultModel, setProjectDefaultModel] = useState("");
  const [projectDefaultEffort, setProjectDefaultEffort] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [onboardingProjectCreation, setOnboardingProjectCreation] = useState(false);
  const [onboardingCompleteOpen, setOnboardingCompleteOpen] = useState(false);
  const onboardingPrompted = useRef(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [operatorProfileOpen, setOperatorProfileOpen] = useState(false);
  const [globalInstructionsDraft, setGlobalInstructionsDraft] = useState("");
  const [maxConcurrentAgentRunsDraft, setMaxConcurrentAgentRunsDraft] = useState("8");
  const [profileNameDraft, setProfileNameDraft] = useState("User");
  const [profileHandleDraft, setProfileHandleDraft] = useState("operator");
  const [profileAvatarDraft, setProfileAvatarDraft] = useState("default-user");
  const [profileUploadBusy, setProfileUploadBusy] = useState(false);
  const [profileUploadError, setProfileUploadError] = useState<string>();
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [engineStatusOpen, setEngineStatusOpen] = useState(false);
  const [pushState, setPushState] = useState<WebPushState>({ kind: "permission_default", message: "Checking browser push status…" });
  const [pushBusy, setPushBusy] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [projectImportOpen, setProjectImportOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string>();
  const [renamedProjectLabel, setRenamedProjectLabel] = useState("");
  const [projectInstructions, setProjectInstructions] = useState("");
  const [settingsProjectDefaultEngine, setSettingsProjectDefaultEngine] = useState("");
  const [settingsProjectDefaultModel, setSettingsProjectDefaultModel] = useState("");
  const [settingsProjectDefaultEffort, setSettingsProjectDefaultEffort] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [homeCreateKind, setHomeCreateKind] = useState<"chat" | "agent" | "trigger">();
  const [homeCreateProjectId, setHomeCreateProjectId] = useState("");
  const [sidebarConversationAction, setSidebarConversationAction] = useState<{ kind: "rename" | "delete"; conversation: ConversationDto }>();
  const [sidebarConversationTitle, setSidebarConversationTitle] = useState("");
  const [projectBrowserRequest, setProjectBrowserRequest] = useState<ProjectBrowserRequest>();
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const projectBrowserRequestId = useRef(0);
  const settingsProjectConversationsQuery = useQuery({
    queryKey: ["conversations", settingsProjectId],
    queryFn: () => api.listConversations(settingsProjectId!),
    enabled: projectImportOpen && Boolean(settingsProjectId),
    staleTime: 10_000,
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
    if (["home", "projects", "allChat", "allChats", "allAgents", "allTriggers", "settings", "profile", "usage", "wiki"].includes(route.kind)) return;
    // Every project-scoped route is already a concrete destination. In
    // particular, Project overview intentionally uses the bare project route;
    // treating it like an unresolved landing page caused it to flash and then
    // redirect back to the most recent chat.
    if (["project", "projectWork", "conversation", "agents", "agent", "review", "browser"].includes(route.kind) && selectedProjectId) return;
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
      setProjectFolderMode("none");
      setProjectDefaultEngine("");
      setProjectDefaultModel("");
      setProjectDefaultEffort("");
      if (onboardingProjectCreation) {
        const completedAt = new Date().toISOString();
        queryClient.setQueryData(["workspace-preferences"], (current: import("@ponderosa/core").WorkspacePreferencesDto | undefined) => current ? { ...current, onboardingCompletedAt: completedAt } : current);
        void api.updateWorkspacePreferences({ onboardingCompletedAt: completedAt }).then((value) => queryClient.setQueryData(["workspace-preferences"], value));
        setOnboardingProjectCreation(false);
        setOnboardingCompleteOpen(true);
      }
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
      else navigate({ kind: "home" });
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

  const preferences = preferencesQuery.data ?? { projectSort: "last_used" as const, projectOrder: [], homeSort: "last_used" as const, homeOrder: [], chatSort: "last_used" as const, chatOrder: [], agentSort: "last_used" as const, agentOrder: [], triggerSort: "last_used" as const, triggerOrder: [], starredResourceIds: [], starredProjectIds: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter" as const, providerAvailability: {}, engineDefaults: {}, globalInstructions: "", maxConcurrentAgentRuns: 8, onboardingCompletedAt: null, profile: { displayName: "User", handle: "operator", avatarId: "default-user" }, updatedAt: new Date(0).toISOString() };
  const savePreferences = (patch: Partial<typeof preferences>) => {
    queryClient.setQueryData(["workspace-preferences"], { ...preferences, ...patch });
    void api.updateWorkspacePreferences(patch).then((value) => queryClient.setQueryData(["workspace-preferences"], value));
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
    void queryClient.invalidateQueries({ queryKey: ["conversations", project.id] });
    navigateWorkspace({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
  };
  const createHomeAgent = (projectId?: string) => {
    const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];
    if (project) navigateWorkspace({ kind: "agents", projectId: project.id, create: true });
  };
  const createHomeTrigger = async (projectId?: string) => {
    const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];
    if (!project) return;
    const agents = await api.listAgents(project.id);
    const agent = agents.find((candidate) => !candidate.archived);
    navigateWorkspace(agent
      ? { kind: "agent", projectId: project.id, agentId: agent.id, view: "triggers" }
      : { kind: "agents", projectId: project.id });
  };
  const beginHomeCreate = (kind: "chat" | "agent" | "trigger") => {
    if (projects.length === 1) {
      const projectId = projects[0]!.id;
      if (kind === "chat") void createHomeChat(projectId);
      else if (kind === "agent") createHomeAgent(projectId);
      else void createHomeTrigger(projectId);
      return;
    }
    setHomeCreateProjectId("");
    setHomeCreateKind(kind);
  };

  const continueHomeCreate = () => {
    if (!homeCreateKind || !homeCreateProjectId) return;
    const kind = homeCreateKind;
    const projectId = homeCreateProjectId;
    setHomeCreateKind(undefined);
    if (kind === "chat") void createHomeChat(projectId);
    else if (kind === "agent") createHomeAgent(projectId);
    else void createHomeTrigger(projectId);
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
    navigateWorkspace({ kind: "settings", section: "general" });
  };
  const openOperatorProfile = () => {
    setProfileNameDraft(preferences.profile.displayName);
    setProfileHandleDraft(preferences.profile.handle);
    setProfileAvatarDraft(preferences.profile.avatarId);
    setProfileUploadError(undefined);
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
          <Tooltip title="Notifications"><IconButton aria-label="Open notifications" onClick={() => setNotificationPanelOpen(true)} sx={{ minWidth: 44, minHeight: 44 }}><Badge color="primary" badgeContent={(notificationsQuery.data ?? []).filter((item) => !item.readAt).length}><NotificationsOutlinedIcon /></Badge></IconButton></Tooltip>
          <Tooltip title={selectedProjectId ? "Shared Browser" : "Select a Project to use its Shared Browser"}><span><IconButton aria-label="Open Shared Browser" disabled={!selectedProjectId} onClick={() => openProjectBrowser()} sx={{ minWidth: 44, minHeight: 44 }}><LanguageIcon /></IconButton></span></Tooltip>
          <Tooltip title="New Project"><IconButton aria-label="New project" onClick={() => openProjectCreator()} sx={{ display: { xs: "none", sm: "inline-flex", md: "none" } }}><AddIcon /></IconButton></Tooltip>
          <Tooltip title="Operator Profile"><IconButton aria-label="Open operator profile" onClick={openOperatorProfile} sx={{ ml: .5, p: 0, width: 44, height: 44 }}><OperatorAvatar profile={preferences.profile} size={32} /></IconButton></Tooltip>
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
            onCreateProject={() => openProjectCreator()}
            onCreateChat={() => beginHomeCreate("chat")}
            onCreateAgent={() => beginHomeCreate("agent")}
            onCreateTrigger={() => beginHomeCreate("trigger")}
            onManageProject={openProjectSettings}
            onPreferences={savePreferences}
            onRenameConversation={(conversation) => openSidebarConversationAction("rename", conversation)}
            onDeleteConversation={(conversation) => openSidebarConversationAction("delete", conversation)}
            onSearch={() => setGlobalSearchOpen(true)}
            onOpenNotifications={() => setNotificationPanelOpen(true)}
            onOpenSettings={openSettings}
            onOpenEngineStatus={() => setEngineStatusOpen(true)}
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
          notificationCount={(notificationsQuery.data ?? []).filter((item) => !item.readAt).length}
          onCreate={createWorkspaceView}
          onClose={closeWorkspaceView}
          onSearch={() => setGlobalSearchOpen(true)}
          onOpenInbox={() => setNotificationPanelOpen(true)}
          onOpenProfile={openOperatorProfile}
          onCloseOthers={closeOtherWorkspaceViews}
          onRename={renameWorkspaceView}
          onReorder={reorderWorkspaceViews}
        /> : null}
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
        ) : route.kind === "home" ? (
          <HomeView
            projects={projects}
            engines={engines}
            notifications={notificationsQuery.data ?? []}
            preferences={preferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRoute}
            onPreferences={savePreferences}
            onCreateProject={() => openProjectCreator()}
            onCreateChat={() => beginHomeCreate("chat")}
            onCreateAgent={() => beginHomeCreate("agent")}
            onCreateTrigger={() => beginHomeCreate("trigger")}
            onOpenInbox={() => setNotificationPanelOpen(true)}
          />
        ) : route.kind === "allChat" ? (
          <AllChatView onNavigate={navigateWorkspace} />
        ) : route.kind === "projects" ? (
          <AllProjectsView
            projects={projects}
            preferences={preferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRoute}
            onCreateProject={() => openProjectCreator()}
            onManageProject={openProjectSettings}
            onPreferences={savePreferences}
          />
        ) : route.kind === "allAgents" ? (
          <AllAgentsWorkspace
            projects={projects}
            filterProjectId={route.filterProjectId}
            preferences={preferences}
            onPreferences={savePreferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRoute}
            onCreate={(projectId) => projectId ? createHomeAgent(projectId) : beginHomeCreate("agent")}
          />
        ) : route.kind === "allChats" ? (
          <AllChatsWorkspace
            projects={projects}
            filterProjectId={route.filterProjectId}
            preferences={preferences}
            onPreferences={savePreferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRoute}
            onCreate={(projectId) => projectId ? void createHomeChat(projectId) : beginHomeCreate("chat")}
          />
        ) : route.kind === "allTriggers" ? (
          <AllTriggersWorkspace
            projects={projects}
            preferences={preferences}
            onPreferences={savePreferences}
            onNavigate={navigateWorkspace}
            onOpenInNewTab={openWorkspaceRoute}
            onCreate={(projectId) => projectId ? void createHomeTrigger(projectId) : beginHomeCreate("trigger")}
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

      <SwipeableDrawer
        open={mobileNavOpen}
        onOpen={() => setMobileNavOpen(true)}
        onClose={() => setMobileNavOpen(false)}
        disableDiscovery
        PaperProps={{ sx: { width: "min(100vw, 390px)", maxWidth: "100vw", height: "100dvh", overflow: "hidden" } }}
      >
        <Box sx={{ position: "relative", height: "100%", minHeight: 0 }}>
        <Tooltip title="Close Navigation">
          <IconButton aria-label="Close workspace navigation" onClick={() => setMobileNavOpen(false)} sx={{ position: "absolute", zIndex: 4, top: "max(8px, env(safe-area-inset-top))", right: 8, minWidth: 44, minHeight: 44, bgcolor: "background.paper", boxShadow: 1 }}><CloseIcon /></IconButton>
        </Tooltip>
        <WorkspaceSidebar
          drawer
          projects={projects}
          engines={engines}
          preferences={preferences}
          route={route}
          notifications={notificationsQuery.data ?? []}
          onNavigate={(next) => { setMobileNavOpen(false); navigateWorkspace(next); }}
          onOpenInNewTab={(next) => { setMobileNavOpen(false); openWorkspaceRoute(next); }}
          onCreateProject={() => { setMobileNavOpen(false); openProjectCreator(); }}
          onCreateChat={() => { setMobileNavOpen(false); beginHomeCreate("chat"); }}
          onCreateAgent={() => { setMobileNavOpen(false); beginHomeCreate("agent"); }}
          onCreateTrigger={() => { setMobileNavOpen(false); beginHomeCreate("trigger"); }}
          onManageProject={(project) => { setMobileNavOpen(false); openProjectSettings(project); }}
          onPreferences={savePreferences}
          onRenameConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("rename", conversation); }}
          onDeleteConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("delete", conversation); }}
          onSearch={() => { setMobileNavOpen(false); setGlobalSearchOpen(true); }}
          onOpenNotifications={() => { setMobileNavOpen(false); setNotificationPanelOpen(true); }}
          onOpenSettings={() => { setMobileNavOpen(false); openSettings(); }}
          onOpenEngineStatus={() => { setMobileNavOpen(false); setEngineStatusOpen(true); }}
        />
        </Box>
      </SwipeableDrawer>

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

      <Dialog open={projectDialogOpen} onClose={closeProjectCreator} fullWidth maxWidth="sm">
        <DialogTitle>{onboardingProjectCreation ? "Welcome to Ponderosa" : "New Project"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {onboardingProjectCreation ? <Alert severity="info">Create your first Project to start prompting. You can change these choices later in Project Settings.</Alert> : null}
            <TextField
              label="Project Name"
              value={projectLabel}
              onChange={(event) => setProjectLabel(event.target.value)}
              autoFocus
              fullWidth
            />
            <Box><Typography variant="subtitle2">Default AI Runtime</Typography><Typography variant="body2" color="text.secondary">Choose the provider for this Project. Chats and Agents can override its model and reasoning later.</Typography></Box>
            <FormControl fullWidth><InputLabel shrink id="project-default-engine-label">AI Provider</InputLabel><Select labelId="project-default-engine-label" label="AI Provider" value={projectDefaultEngine} displayEmpty onChange={(event) => { setProjectDefaultEngine(event.target.value); setProjectDefaultModel(""); setProjectDefaultEffort(""); }}>
              <MenuItem value="" disabled>Select a Provider</MenuItem>
              {engines.map((engine) => <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>{engine.displayName}{engineIsAvailable(engine) ? "" : engine.authenticated ? " — Unavailable" : " — Not Signed In"}</MenuItem>)}
            </Select></FormControl>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <FormControl fullWidth disabled={!projectDefaultEngine}><InputLabel id="project-default-model-label">Model</InputLabel><Select labelId="project-default-model-label" label="Model" value={projectDefaultModel} onChange={(event) => { setProjectDefaultModel(event.target.value); setProjectDefaultEffort(""); }}>
                  <MenuItem value="">Provider Default — {(newProjectEngine?.models.find((option) => option.id === newProjectInherited.model)?.label ?? newProjectInherited.model) || "Automatic"}</MenuItem>
                  {(newProjectEngine?.models ?? []).filter((option) => option.id).map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
                </Select></FormControl>
                <FormControl fullWidth disabled={!projectDefaultEngine}><InputLabel id="project-default-effort-label">Reasoning</InputLabel><Select labelId="project-default-effort-label" label="Reasoning" value={projectDefaultEffort} onChange={(event) => setProjectDefaultEffort(event.target.value)}>
                  <MenuItem value="">Provider Default — {(newProjectEfforts.find((option) => option.id === newProjectInherited.effort)?.label ?? newProjectInherited.effort) || "Automatic"}</MenuItem>
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
            <Box>
              <Typography variant="subtitle2">Working Folder</Typography>
              <RadioGroup value={projectFolderMode} onChange={(event) => {
                const mode = event.target.value as ProjectFolderMode;
                setProjectFolderMode(mode);
                if (mode === "none") setProjectPath("");
              }}>
                <FormControlLabel value="none" control={<Radio />} label="Private Empty Workspace" />
                <FormControlLabel value="existing" control={<Radio />} label="Use a Folder on This Host" />
              </RadioGroup>
              {projectFolderMode === "existing" ? <Stack spacing={1}><Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{projectPath || "No folder selected"}</Typography><Button variant="outlined" startIcon={<FolderOutlinedIcon />} onClick={() => setFolderPickerOpen(true)}>{projectPath ? "Change Folder…" : "Choose Folder…"}</Button></Stack> : <Typography variant="body2" color="text.secondary">Ponderosa will create a private empty workspace.</Typography>}
            </Box>
            {createProject.isError ? <Alert severity="error">{String(createProject.error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeProjectCreator}>{onboardingProjectCreation ? "Not Now" : "Cancel"}</Button>
          <Button
            variant="contained"
            disabled={projectCreationDisabled({ label: projectLabel, mode: projectFolderMode, existingPath: projectPath, defaultEngine: projectDefaultEngine, pending: createProject.isPending })}
            onClick={() => createProject.mutate()}
          >
            {onboardingProjectCreation ? "Create Project and Continue" : "Create"}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(homeCreateKind)} onClose={() => setHomeCreateKind(undefined)} fullWidth maxWidth="xs">
        <DialogTitle>Create {homeCreateKind ? homeCreateKind.charAt(0).toUpperCase() + homeCreateKind.slice(1) : ""}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography color="text.secondary">Choose the Project where this {homeCreateKind ?? "item"} belongs.</Typography>
            <FormControl fullWidth><InputLabel id="home-create-project-label">Project</InputLabel><Select labelId="home-create-project-label" label="Project" value={homeCreateProjectId} onChange={(event) => setHomeCreateProjectId(event.target.value)}>{projects.map((project) => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}</Select></FormControl>
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setHomeCreateKind(undefined)}>Cancel</Button><Button variant="contained" disabled={!homeCreateProjectId} onClick={continueHomeCreate}>Continue</Button></DialogActions>
      </Dialog>
      <Dialog open={onboardingCompleteOpen} onClose={() => setOnboardingCompleteOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>You’re Ready to Build</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center", pt: 1 }}>
            <Box sx={{ width: 56, height: 56, borderRadius: "50%", display: "grid", placeItems: "center", bgcolor: "action.selected", color: "primary.main" }}><MenuBookOutlinedIcon fontSize="large" /></Box>
            <Typography>You’re all set. Have fun prompting, creating Agents, and building organizations.</Typography>
            <Alert severity="info" icon={<MenuBookOutlinedIcon />}>Need help? Open the Wiki anytime using the book icon in the sidebar.</Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button startIcon={<MenuBookOutlinedIcon />} onClick={() => { setOnboardingCompleteOpen(false); navigateWorkspace({ kind: "wiki" }); }}>Open Wiki</Button>
          <Button autoFocus variant="contained" onClick={() => setOnboardingCompleteOpen(false)}>Start Prompting</Button>
        </DialogActions>
      </Dialog>
      <HostFolderPicker open={folderPickerOpen} initialPath={projectPath || undefined} onClose={() => setFolderPickerOpen(false)} onChoose={(path) => {
        setProjectFolderMode("existing");
        setProjectPath(path);
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
        <DialogTitle>Operator Profile</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">This synced identity controls how Agents address you and how your profile appears throughout Ponderosa.</Typography>
            <TextField autoFocus label="What Agents call you" value={profileNameDraft} onChange={(event) => setProfileNameDraft(event.target.value)} inputProps={{ maxLength: 80 }} />
            <TextField label="Handle" value={profileHandleDraft} onChange={(event) => setProfileHandleDraft(event.target.value.replace(/^#/, "").toLowerCase())} helperText="Used as your stable #handle." inputProps={{ maxLength: 32 }} />
            <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
              <OperatorAvatar profile={{ displayName: profileNameDraft || "User", handle: profileHandleDraft || "operator", avatarId: profileAvatarDraft }} size={56} />
              <Button component="label" variant="outlined" startIcon={<PhotoCameraOutlinedIcon />} disabled={profileUploadBusy}>
                {profileUploadBusy ? "Uploading…" : "Upload Picture"}
                <input hidden type="file" accept={OPERATOR_PROFILE_IMAGE_ACCEPT} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > OPERATOR_PROFILE_IMAGE_MAX_BYTES) {
                    setProfileUploadError("Picture must be 10 MiB or smaller.");
                    return;
                  }
                  setProfileUploadBusy(true);
                  setProfileUploadError(undefined);
                  void api.uploadOperatorAvatar(file).then((uploaded) => setProfileAvatarDraft(uploaded.avatarId))
                    .catch((reason) => setProfileUploadError(reason instanceof Error ? reason.message : "Picture upload failed."))
                    .finally(() => setProfileUploadBusy(false));
                }} />
              </Button>
            </Stack>
            <FormControl fullWidth><InputLabel id="operator-profile-avatar-label">Generated Picture</InputLabel><Select labelId="operator-profile-avatar-label" label="Generated Picture" value={profileAvatarDraft} onChange={(event) => setProfileAvatarDraft(event.target.value)}>{profileAvatarDraft.startsWith("uploaded:") ? <MenuItem value={profileAvatarDraft}>Uploaded Picture</MenuItem> : null}<MenuItem value="default-user">Pine</MenuItem><MenuItem value="sunset">Sunset</MenuItem><MenuItem value="river">River</MenuItem><MenuItem value="mountain">Mountain</MenuItem><MenuItem value="fox">Fox</MenuItem><MenuItem value="owl">Owl</MenuItem></Select></FormControl>
            <Typography variant="caption" color="text.secondary">PNG, JPEG, WebP, GIF, or AVIF up to 10 MiB. HEIC is not accepted because current browsers cannot render it reliably. Uploaded pictures are stored in Ponderosa-managed workspace data.</Typography>
            {profileUploadError ? <Alert severity="error">{profileUploadError}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOperatorProfileOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={profileUploadBusy || !profileNameDraft.trim() || !/^[a-z][a-z0-9_-]{1,31}$/.test(profileHandleDraft) || ["broadcast", "everyone", "user"].includes(profileHandleDraft)} onClick={() => {
            savePreferences({ profile: { displayName: profileNameDraft.trim(), handle: profileHandleDraft, avatarId: profileAvatarDraft } });
            setOperatorProfileOpen(false);
          }}>Save Profile</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Project Settings</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
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
          <Button variant="outlined" startIcon={<FileUploadOutlinedIcon />} onClick={() => { setProjectSettingsOpen(false); setProjectImportOpen(true); }}>Import Agent or Organization</Button>
          {updateProject.isError ? <Alert severity="error">{String(updateProject.error)}</Alert> : null}
          <Button color="error" variant="outlined" onClick={() => setDeleteConfirmationOpen(true)}>Delete Project Permanently</Button>
        </Stack></DialogContent><DialogActions><Button onClick={() => setProjectSettingsOpen(false)}>Cancel</Button><Button variant="contained" disabled={!renamedProjectLabel.trim() || updateProject.isPending} onClick={() => updateProject.mutate()}>Save</Button></DialogActions>
      </Dialog>
      {settingsProjectId ? <ImportAgentDialog
        open={projectImportOpen}
        projectId={settingsProjectId}
        engines={engines}
        conversations={settingsProjectConversationsQuery.data ?? []}
        onClose={() => setProjectImportOpen(false)}
        onImported={(agentId) => navigateWorkspace({ kind: "agent", projectId: settingsProjectId, agentId })}
      /> : null}

      <Dialog open={deleteConfirmationOpen} onClose={() => setDeleteConfirmationOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete this project?</DialogTitle><DialogContent><Alert severity="warning">This permanently deletes its Project chats, agents, runs, work items, and files &amp; results. The working folder and its source files are not deleted.</Alert>{deleteProject.isError ? <Alert severity="error" sx={{ mt: 2 }}>{String(deleteProject.error)}</Alert> : null}</DialogContent>
        <DialogActions><Button onClick={() => setDeleteConfirmationOpen(false)}>Cancel</Button><Button color="error" variant="contained" disabled={deleteProject.isPending} onClick={() => deleteProject.mutate()}>Delete Permanently</Button></DialogActions>
      </Dialog>
    </Box>
    </ProjectBrowserContext.Provider>
  );
}
