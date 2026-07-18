import AddIcon from "@mui/icons-material/Add";
import SettingsIcon from "@mui/icons-material/Settings";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
import LanguageIcon from "@mui/icons-material/Language";
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProjectShell } from "./components/ProjectShell";
import { TokenUsageButton } from "./components/TokenUsageButton";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { AllProjectsView } from "./components/WorkspaceOverview";
import { HostFolderPicker } from "./components/HostFolderPicker";
import { GlobalChatSearch, isGlobalSearchShortcut, routeForGlobalSearchSelection } from "./components/GlobalChatSearch";
import { NotificationPanel } from "./components/NotificationPanel";
import { useEngines, useNotifications, useProjectFolders, useProjects, useWorkspacePreferences } from "./hooks/queries";
import { announceWorkspaceRefresh, useWorkspaceStream } from "./hooks/useWorkspaceStream";
import {
  loadLastProjectId,
  routeProjectId,
  saveLastProjectId,
  useRoute,
  type Route,
} from "./routing";
import type { ColorMode } from "./theme";
import { createProjectRequest, nextProjectAfterDelete, projectCreationDisabled, type ProjectFolderMode } from "./projectLifecycle";
import { closeReadPushNotifications, disableWebPush, inspectWebPush, subscribeWebPushChanges, syncWebPush, type WebPushState } from "./pushNotifications";
import { ProjectBrowserContext, type ProjectBrowserRequest } from "./components/ProjectBrowserContext";
import { ProjectBrowserDialog } from "./components/ProjectBrowserDialog";
import { engineIsAvailable } from "./conversationEngine";
import {
  WORKSPACE_TABS_STORAGE_KEY,
  closeWorkspaceTab,
  mostRecentWorkspaceTab,
  openWorkspaceTab,
  removeProjectWorkspaceTabs,
  removeWorkspaceRoute,
  restoreWorkspaceTabs,
  serializeWorkspaceTabs,
  workspaceTabKey,
} from "./workspaceTabs";
import { hasUnreadConversationNotifications } from "./workspaceNavigation";

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
  const [workspaceTabs, setWorkspaceTabs] = useState(() => {
    try {
      return restoreWorkspaceTabs(window.localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY));
    } catch {
      return [];
    }
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

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectLabel, setProjectLabel] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectFolderMode, setProjectFolderMode] = useState<ProjectFolderMode>("none");
  const [projectFolderName, setProjectFolderName] = useState("");
  const [projectDefaultEngine, setProjectDefaultEngine] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [globalInstructionsDraft, setGlobalInstructionsDraft] = useState("");
  const [profileNameDraft, setProfileNameDraft] = useState("User");
  const [profileHandleDraft, setProfileHandleDraft] = useState("operator");
  const [profileAvatarDraft, setProfileAvatarDraft] = useState("default-user");
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [pushState, setPushState] = useState<WebPushState>({ kind: "permission_default", message: "Checking browser push status…" });
  const [pushBusy, setPushBusy] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string>();
  const [renamedProjectLabel, setRenamedProjectLabel] = useState("");
  const [projectInstructions, setProjectInstructions] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [sidebarConversationAction, setSidebarConversationAction] = useState<{ kind: "rename" | "delete"; conversation: ConversationDto }>();
  const [sidebarConversationTitle, setSidebarConversationTitle] = useState("");
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
  const [projectBrowserRequest, setProjectBrowserRequest] = useState<ProjectBrowserRequest>();
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const projectBrowserRequestId = useRef(0);
  const projectFoldersQuery = useProjectFolders(projectDialogOpen);

  useEffect(() => {
    setWorkspaceTabs((current) => openWorkspaceTab(current, route));
  }, [route]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, serializeWorkspaceTabs(workspaceTabs));
    } catch {
      // Tabs remain available for this session when storage is unavailable.
    }
  }, [workspaceTabs]);

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

  const openProjectBrowser = (url?: string) => {
    projectBrowserRequestId.current += 1;
    setProjectBrowserRequest({ ...(url ? { url } : {}), requestId: projectBrowserRequestId.current });
    setProjectBrowserOpen(true);
  };

  // Land on a concrete project: honour the URL, else the last-used project, else
  // the first available. Uses replace so the initial redirect isn't a history step.
  useEffect(() => {
    if (projects.length === 0) {
      return;
    }
    if (route.kind === "home" || route.kind === "projects" || route.kind === "allAgents") return;
    // Every project-scoped route is already a concrete destination. In
    // particular, Project files intentionally uses the bare project route;
    // treating it like an unresolved landing page caused it to flash and then
    // redirect back to the most recent chat.
    if (["project", "conversation", "agents", "agent"].includes(route.kind) && selectedProjectId) return;
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
      api.createProject(createProjectRequest({ label: projectLabel, mode: projectFolderMode, existingPath: projectPath, newFolderName: projectFolderName, defaultEngine: projectDefaultEngine as ProjectDto["defaultEngine"] })),
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
    mutationFn: () => api.updateProject(settingsProjectId!, { label: renamedProjectLabel.trim(), instructions: projectInstructions }),
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

  const preferences = preferencesQuery.data ?? { projectSort: "last_used" as const, projectOrder: [], starredProjectIds: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter" as const, providerAvailability: {}, globalInstructions: "", profile: { displayName: "User", handle: "operator", avatarId: "default-user" }, updatedAt: new Date(0).toISOString() };
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

  const goHome = (next: Route) => navigate(next);
  const closeWorkspaceView = (key: string) => {
    const remaining = closeWorkspaceTab(workspaceTabs, key);
    setWorkspaceTabs(remaining);
    if (workspaceTabKey(route) === key) {
      navigate(mostRecentWorkspaceTab(remaining)?.route ?? { kind: "home" });
    }
  };
  const closeAllWorkspaceViews = () => {
    setWorkspaceTabs([]);
    navigate({ kind: "home" });
  };
  const removeWorkspaceView = (removedRoute: Route) => {
    setWorkspaceTabs((current) => removeWorkspaceRoute(current, removedRoute));
  };
  const openSettings = () => {
    setGlobalInstructionsDraft(preferences.globalInstructions);
    setProfileNameDraft(preferences.profile.displayName);
    setProfileHandleDraft(preferences.profile.handle);
    setProfileAvatarDraft(preferences.profile.avatarId);
    setNotificationSettingsOpen(true);
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
      <AppBar position="static" color="inherit" elevation={0} sx={{ display: { xs: "block", md: "none" }, borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ minHeight: { xs: 52, sm: 56 }, px: { xs: 1.5, sm: 3 }, pt: "env(safe-area-inset-top)" }}>
          <IconButton aria-label="Open workspace navigation" onClick={() => setMobileNavOpen(true)} sx={{ display: { xs: "inline-flex", md: "none" }, mr: 0.5 }}><MenuIcon /></IconButton>
          <Box component="img" src="/icons/app-icon.png" alt="" sx={{ width: 28, height: 28, mr: 1, borderRadius: 1 }} />
          <Typography variant="h6" component="h1" sx={{ fontWeight: 800, flex: 1, minWidth: 0 }} noWrap>
            Ponderosa
          </Typography>
          <Chip
            size="small"
            label={engines.some(engineIsAvailable) ? "Engine ready" : engines.some((engine) => engine.authenticated) ? "Engine unavailable" : "Engine auth needed"}
            color={engines.some(engineIsAvailable) ? "success" : "warning"}
            variant="outlined"
            sx={{ maxWidth: { sm: 132, md: "none" }, display: { xs: "none", sm: "inline-flex" } }}
          />
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
          <Tooltip title="Search chats"><IconButton aria-label="Search all chats" onClick={() => setGlobalSearchOpen(true)} sx={{ display: { xs: "inline-flex", md: "none" } }}><SearchIcon /></IconButton></Tooltip>
          <Tooltip title="Notifications"><IconButton aria-label="Open notifications" onClick={() => setNotificationPanelOpen(true)}><Badge color="primary" badgeContent={(notificationsQuery.data ?? []).filter((item) => !item.readAt).length}><NotificationsOutlinedIcon /></Badge></IconButton></Tooltip>
          <Tooltip title={selectedProjectId ? "Project browser" : "Select a Project to use its browser"}><span><IconButton aria-label="Open Project browser" disabled={!selectedProjectId} onClick={() => openProjectBrowser()}><LanguageIcon /></IconButton></span></Tooltip>
          <Tooltip title="New project"><IconButton aria-label="New project" onClick={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }} sx={{ display: { xs: "none", sm: "inline-flex", md: "none" } }}><AddIcon /></IconButton></Tooltip>
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
            preferences={preferences}
            route={route}
            notifications={notificationsQuery.data ?? []}
            onNavigate={goHome}
            onCreateProject={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}
            onManageProject={(project) => { setSettingsProjectId(project.id); setRenamedProjectLabel(project.label); setProjectInstructions(project.instructions ?? ""); setProjectSettingsOpen(true); }}
            onPreferences={savePreferences}
            onRenameConversation={(conversation) => openSidebarConversationAction("rename", conversation)}
            onDeleteConversation={(conversation) => openSidebarConversationAction("delete", conversation)}
            onSearch={() => setGlobalSearchOpen(true)}
            onOpenNotifications={() => setNotificationPanelOpen(true)}
            onOpenSettings={openSettings}
          />
        </Box>
      <Box component="main" id="main-content" sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: { xs: "minmax(0, 1fr)", md: "auto minmax(0, 1fr)" } }}>
        <WorkspaceTabs tabs={workspaceTabs} projects={projects} route={route} navigate={goHome} onClose={closeWorkspaceView} onCloseAll={closeAllWorkspaceViews} />
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
        ) : projects.length === 0 && !projectsQuery.isLoading ? (
          <Box sx={{ minHeight: 0, display: "grid", placeItems: "center", p: 2 }}>
            <Stack spacing={1.5} sx={{ alignItems: "center", maxWidth: 480, textAlign: "center", p: { xs: 2.5, sm: 4 }, border: 1, borderColor: "divider", borderRadius: 3, bgcolor: "background.paper" }}>
              <Box component="img" src="/icons/app-icon.png" alt="" sx={{ width: 56, height: 56, borderRadius: 2 }} />
              <Typography variant="h5" component="h2" fontWeight={800}>Start your first project</Typography>
              <Typography color="text.secondary">Choose a working folder, then chat normally. Ponderosa handles agents and orchestration behind the conversation.</Typography>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}>New project</Button>
            </Stack>
          </Box>
        ) : route.kind === "projects" || route.kind === "home" || route.kind === "allAgents" ? (
          <AllProjectsView
            projects={projects}
            preferences={preferences}
            onNavigate={goHome}
            onCreateProject={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}
            onManageProject={(project) => { setSettingsProjectId(project.id); setRenamedProjectLabel(project.label); setProjectInstructions(project.instructions ?? ""); setProjectSettingsOpen(true); }}
            onPreferences={savePreferences}
          />
        ) : selectedProjectId ? (
          <ProjectShell
            projectId={selectedProjectId}
            route={route}
            engines={engines}
            navigate={goHome}
            onResourceDeleted={removeWorkspaceView}
          />
        ) : (
          <Box />
        )}
        </Box>
      </Box>
      </Box>

      <Drawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} PaperProps={{ sx: { width: "min(88vw, 360px)" } }}>
        <WorkspaceSidebar
          drawer
          projects={projects}
          preferences={preferences}
          route={route}
          notifications={notificationsQuery.data ?? []}
          onNavigate={(next) => { setMobileNavOpen(false); goHome(next); }}
          onCreateProject={() => { setMobileNavOpen(false); if (!projectDefaultEngine) setProjectDefaultEngine(engines.find(engineIsAvailable)?.id ?? ""); setProjectDialogOpen(true); }}
          onManageProject={(project) => { setMobileNavOpen(false); setSettingsProjectId(project.id); setRenamedProjectLabel(project.label); setProjectInstructions(project.instructions ?? ""); setProjectSettingsOpen(true); }}
          onPreferences={savePreferences}
          onRenameConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("rename", conversation); }}
          onDeleteConversation={(conversation) => { setMobileNavOpen(false); openSidebarConversationAction("delete", conversation); }}
          onSearch={() => { setMobileNavOpen(false); setGlobalSearchOpen(true); }}
          onOpenNotifications={() => { setMobileNavOpen(false); setNotificationPanelOpen(true); }}
          onOpenSettings={() => { setMobileNavOpen(false); openSettings(); }}
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
            <FormControl fullWidth><InputLabel id="project-default-engine-label">Default engine</InputLabel><Select labelId="project-default-engine-label" label="Default engine" value={projectDefaultEngine} onChange={(event) => setProjectDefaultEngine(event.target.value)}>
              {engines.map((engine) => <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>{engine.displayName}{engineIsAvailable(engine) ? "" : engine.authenticated ? " — unavailable" : " — not signed in"}</MenuItem>)}
            </Select></FormControl>
            {engines.filter((engine) => engine.authenticated && !engineIsAvailable(engine)).map((engine) => <Alert
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
              >{recheckEngine.isPending && recheckEngine.variables === engine.id ? "Testing…" : "Test access"}</Button>}
            >
              {engine.displayName} is configured but unavailable. {engine.availabilityDetail}
            </Alert>)}
            {recheckEngine.isError ? <Alert severity="error">{String(recheckEngine.error)}</Alert> : null}
            <FormControl fullWidth><InputLabel id="project-folder-mode-label">Working folder</InputLabel><Select labelId="project-folder-mode-label" label="Working folder" value={projectFolderMode} onChange={(event) => setProjectFolderMode(event.target.value as typeof projectFolderMode)}>
              <MenuItem value="none">No folder yet — use a private empty workspace</MenuItem>
              <MenuItem value="existing">Choose an existing folder</MenuItem>
              <MenuItem value="create">Create a named empty folder</MenuItem>
            </Select></FormControl>
            {projectFolderMode === "none" ? <Typography variant="body2" color="text.secondary">
              Ponderosa will create a private empty workspace now. You can use this project for chat and agents without choosing a folder.
            </Typography> : null}
            {projectFolderMode === "existing" ? <>
              <FormControl fullWidth><InputLabel id="existing-project-folder-label">Registered or managed folder</InputLabel><Select labelId="existing-project-folder-label" label="Registered or managed folder" value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
                {(projectFoldersQuery.data?.folders ?? []).map((folder) => <MenuItem key={folder.hostPath} value={folder.hostPath}>{folder.name} — {folder.hostPath}</MenuItem>)}
              </Select></FormControl>
              <TextField label="Or enter an existing absolute path" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/Users/you/Projects/app" fullWidth />
              <Button variant="outlined" onClick={() => setFolderPickerOpen(true)}>Browse folders on host…</Button>
            </> : null}
            {projectFolderMode === "create" ? <TextField label="New folder name" value={projectFolderName} onChange={(event) => setProjectFolderName(event.target.value)} helperText={`Created inside ${projectFoldersQuery.data?.managedRoot ?? "the managed workspace"}`} fullWidth /> : null}
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
      <HostFolderPicker open={folderPickerOpen} initialPath={projectPath || undefined} onClose={() => setFolderPickerOpen(false)} onChoose={(hostPath) => { setProjectPath(hostPath); setFolderPickerOpen(false); }} />
      <NotificationPanel
        open={notificationPanelOpen}
        projects={projects}
        notifications={notificationsQuery.data ?? []}
        onClose={() => setNotificationPanelOpen(false)}
        onNavigate={navigate}
        onOpenSettings={() => {
          setGlobalInstructionsDraft(preferences.globalInstructions);
          setProfileNameDraft(preferences.profile.displayName);
          setProfileHandleDraft(preferences.profile.handle);
          setProfileAvatarDraft(preferences.profile.avatarId);
          setNotificationSettingsOpen(true);
        }}
      />
      <Dialog open={notificationSettingsOpen} onClose={() => setNotificationSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Settings</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="subtitle2">Appearance</Typography>
            <Button variant="outlined" onClick={onToggleColorMode}>Use {colorMode === "dark" ? "light" : "dark"} mode</Button>
            <FormControl fullWidth>
              <InputLabel id="font-preference-label">Font</InputLabel>
              <Select labelId="font-preference-label" label="Font" value={preferences.fontFamily} onChange={(event) => savePreferences({ fontFamily: event.target.value as typeof preferences.fontFamily })}>
                <MenuItem value="inter">Inter</MenuItem><MenuItem value="system">System</MenuItem><MenuItem value="sans">Classic sans</MenuItem>
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
              }}>{pushState.kind === "subscription_failed" ? "Retry browser push" : "Enable browser push"}</Button>
            ) : null}
            {pushState.kind === "active" ? (
              <Button color="inherit" disabled={pushBusy} onClick={() => {
                setPushBusy(true);
                void disableWebPush().then(setPushState)
                  .finally(() => setPushBusy(false));
              }}>Disable on this device</Button>
            ) : null}
            <Typography variant="subtitle2">AI providers</Typography>
            <Typography variant="body2" color="text.secondary">Disabled providers finish active Runs, then hold queued work until re-enabled.</Typography>
            {engines.map((engine) => <FormControlLabel key={engine.id} control={<Switch checked={engine.enabled !== false} disabled={updateEngine.isPending} onChange={(_, enabled) => updateEngine.mutate({ engineId: engine.id, enabled })} />} label={`${engine.displayName}${engine.available ? "" : ` — ${engine.availabilityDetail ?? "unavailable"}`}`} />)}
            <Typography variant="subtitle2">Your profile</Typography>
            <TextField label="What Agents call you" value={profileNameDraft} onChange={(event) => setProfileNameDraft(event.target.value)} inputProps={{ maxLength: 80 }} />
            <TextField label="Handle" value={profileHandleDraft} onChange={(event) => setProfileHandleDraft(event.target.value.replace(/^#/, "").toLowerCase())} helperText="Used as your stable #handle." inputProps={{ maxLength: 32 }} />
            <FormControl fullWidth><InputLabel id="profile-avatar-label">Picture</InputLabel><Select labelId="profile-avatar-label" label="Picture" value={profileAvatarDraft} onChange={(event) => setProfileAvatarDraft(event.target.value)}><MenuItem value="default-user">Pine</MenuItem><MenuItem value="sunset">Sunset</MenuItem><MenuItem value="river">River</MenuItem><MenuItem value="mountain">Mountain</MenuItem><MenuItem value="fox">Fox</MenuItem><MenuItem value="owl">Owl</MenuItem></Select></FormControl>
            <Typography variant="subtitle2">Master rules</Typography>
            <TextField label="Rules for every Ponderosa Agent" value={globalInstructionsDraft} onChange={(event) => setGlobalInstructionsDraft(event.target.value)} multiline minRows={5} helperText="Ponderosa stores these rules directly and starts affected Agents with a fresh provider session on their next Run." />
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setNotificationSettingsOpen(false)}>Cancel</Button><Button variant="contained" disabled={!profileNameDraft.trim() || !/^[a-z][a-z0-9_-]{1,31}$/.test(profileHandleDraft) || ["broadcast", "everyone", "user"].includes(profileHandleDraft)} onClick={() => {
          savePreferences({ globalInstructions: globalInstructionsDraft, profile: { displayName: profileNameDraft.trim(), handle: profileHandleDraft, avatarId: profileAvatarDraft } });
          setNotificationSettingsOpen(false);
        }}>Save settings</Button></DialogActions>
      </Dialog>

      <Dialog open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Project settings</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Project name" value={renamedProjectLabel} onChange={(event) => setRenamedProjectLabel(event.target.value)} fullWidth />
          <TextField label="Project master rules" value={projectInstructions} onChange={(event) => setProjectInstructions(event.target.value)} multiline minRows={5} helperText="These rules apply after global rules to every Agent working in this Project." fullWidth />
          {updateProject.isError ? <Alert severity="error">{String(updateProject.error)}</Alert> : null}
          <Button color="error" variant="outlined" onClick={() => setDeleteConfirmationOpen(true)}>Delete project permanently</Button>
        </Stack></DialogContent><DialogActions><Button onClick={() => setProjectSettingsOpen(false)}>Cancel</Button><Button variant="contained" disabled={!renamedProjectLabel.trim() || updateProject.isPending} onClick={() => updateProject.mutate()}>Save</Button></DialogActions>
      </Dialog>

      <Dialog open={deleteConfirmationOpen} onClose={() => setDeleteConfirmationOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete this project?</DialogTitle><DialogContent><Alert severity="warning">This permanently deletes its Project chats, agents, runs, work items, and files &amp; results. The working folder and its source files are not deleted.</Alert>{deleteProject.isError ? <Alert severity="error" sx={{ mt: 2 }}>{String(deleteProject.error)}</Alert> : null}</DialogContent>
        <DialogActions><Button onClick={() => setDeleteConfirmationOpen(false)}>Cancel</Button><Button color="error" variant="contained" disabled={deleteProject.isPending} onClick={() => deleteProject.mutate()}>Delete permanently</Button></DialogActions>
      </Dialog>
      <ProjectBrowserDialog projectId={selectedProjectId} open={projectBrowserOpen} request={projectBrowserRequest} onClose={() => setProjectBrowserOpen(false)} />
    </Box>
    </ProjectBrowserContext.Provider>
  );
}
