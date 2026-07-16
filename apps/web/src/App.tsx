import AddIcon from "@mui/icons-material/Add";
import SettingsIcon from "@mui/icons-material/Settings";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
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
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { ProjectShell } from "./components/ProjectShell";
import { TokenUsageButton } from "./components/TokenUsageButton";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { AllAgentsView, AllProjectsView } from "./components/WorkspaceOverview";
import { HostFolderPicker } from "./components/HostFolderPicker";
import { GlobalChatSearch, isGlobalSearchShortcut, routeForGlobalSearchSelection } from "./components/GlobalChatSearch";
import { useEngines, useNotifications, useProjectFolders, useProjects, useWorkspacePreferences } from "./hooks/queries";
import { useWorkspaceStream } from "./hooks/useWorkspaceStream";
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
  const [projectFolderMode, setProjectFolderMode] = useState<ProjectFolderMode>("existing");
  const [projectFolderName, setProjectFolderName] = useState("");
  const [projectDefaultEngine, setProjectDefaultEngine] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [pushState, setPushState] = useState<WebPushState>({ kind: "permission_default", message: "Checking browser push status…" });
  const [pushBusy, setPushBusy] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string>();
  const [renamedProjectLabel, setRenamedProjectLabel] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const projectFoldersQuery = useProjectFolders(projectDialogOpen);

  useEffect(() => {
    if (route.kind !== "conversation") return;
    const conversationId = route.conversationId;
    queryClient.setQueryData<import("@ponderosa/core").WorkspaceNotificationDto[]>(["notifications"], (current = []) =>
      current.map((item) => item.conversationId === conversationId && !item.readAt ? { ...item, readAt: new Date().toISOString() } : item));
    void api.clearConversationNotifications(conversationId).then(() => queryClient.invalidateQueries({ queryKey: ["notifications"] }));
  }, [route.kind, route.kind === "conversation" ? route.conversationId : undefined, queryClient]);

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
    if (route.kind === "projects" || route.kind === "allAgents") return;
    if (["conversation", "agents", "agent"].includes(route.kind) && selectedProjectId) return;
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
      setProjectFolderMode("existing");
      setProjectDefaultEngine("");
      navigate(project.lastConversationId ? { kind: "conversation", projectId: project.id, conversationId: project.lastConversationId } : { kind: "project", projectId: project.id });
    },
  });

  const updateProject = useMutation({
    mutationFn: () => api.updateProject(settingsProjectId!, { label: renamedProjectLabel.trim() }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["projects"] }); setProjectSettingsOpen(false); },
  });

  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject(settingsProjectId!),
    onSuccess: () => {
      const next = nextProjectAfterDelete(projects, settingsProjectId!);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDeleteConfirmationOpen(false);
      setProjectSettingsOpen(false);
      if (next) { saveLastProjectId(next.id); navigate({ kind: "project", projectId: next.id }); }
      else navigate({ kind: "home" });
    },
  });

  const preferences = preferencesQuery.data ?? { projectSort: "last_used" as const, projectOrder: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false }, fontFamily: "inter" as const, updatedAt: new Date(0).toISOString() };
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

  return (
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
        gridTemplateRows: "auto minmax(0, 1fr)",
        bgcolor: "background.default",
      }}
    >
      <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ minHeight: { xs: 52, sm: 56 }, px: { xs: 1.5, sm: 3 }, pt: "env(safe-area-inset-top)" }}>
          <IconButton aria-label="Open workspace navigation" onClick={() => setMobileNavOpen(true)} sx={{ display: { xs: "inline-flex", md: "none" }, mr: 0.5 }}><MenuIcon /></IconButton>
          <Box component="img" src="/icons/icon.svg" alt="" sx={{ width: 28, height: 28, mr: 1 }} />
          <Typography variant="h6" component="h1" sx={{ fontWeight: 800, flex: 1, minWidth: 0 }} noWrap>
            Ponderosa
          </Typography>
          <Chip
            size="small"
            label={engines.some((engine) => engine.authenticated) ? "Engine ready" : "Engine auth needed"}
            color={engines.some((engine) => engine.authenticated) ? "success" : "warning"}
            variant="outlined"
            sx={{ maxWidth: { xs: 132, sm: "none" } }}
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
          <Tooltip title="New project"><IconButton aria-label="New project" onClick={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find((engine) => engine.authenticated)?.id ?? ""); setProjectDialogOpen(true); }} sx={{ display: { xs: "inline-flex", md: "none" } }}><AddIcon /></IconButton></Tooltip>
          <Box sx={{ ml: 1, display: { xs: "none", sm: "block" } }}>
            <TokenUsageButton scope="overall" label="Overall" />
          </Box>
          <Box sx={{ ml: 0.5, display: { xs: "block", sm: "none" } }}>
            <TokenUsageButton scope="overall" label="Overall" compact />
          </Box>
          <Tooltip title="Settings"><IconButton aria-label="Open settings" onClick={() => setNotificationSettingsOpen(true)} sx={{ ml: 0.5, minWidth: 44, minHeight: 44 }}><SettingsIcon /></IconButton></Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "auto minmax(0, 1fr)" } }}>
        <Box sx={{ display: { xs: "none", md: "block" }, minHeight: 0 }}>
          <WorkspaceSidebar
            projects={projects}
            route={route}
            notifications={notificationsQuery.data ?? []}
            onNavigate={goHome}
            onCreateProject={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find((engine) => engine.authenticated)?.id ?? ""); setProjectDialogOpen(true); }}
            onManageProject={(project) => { setSettingsProjectId(project.id); setRenamedProjectLabel(project.label); setProjectSettingsOpen(true); }}
          />
        </Box>
      <Box component="main" id="main-content" sx={{ minHeight: 0, minWidth: 0, display: "grid" }}>
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
          <Box sx={{ p: 2 }}>
            <Alert severity="info">Create a project to get started.</Alert>
          </Box>
        ) : route.kind === "projects" ? (
          <AllProjectsView
            projects={projects}
            preferences={preferences}
            onNavigate={goHome}
            onCreateProject={() => { if (!projectDefaultEngine) setProjectDefaultEngine(engines.find((engine) => engine.authenticated)?.id ?? ""); setProjectDialogOpen(true); }}
            onManageProject={(project) => { setSettingsProjectId(project.id); setRenamedProjectLabel(project.label); setProjectSettingsOpen(true); }}
            onPreferences={savePreferences}
          />
        ) : route.kind === "allAgents" ? (
          <AllAgentsView projects={projects} onNavigate={goHome} />
        ) : selectedProjectId ? (
          <ProjectShell
            projectId={selectedProjectId}
            route={route}
            engines={engines}
            navigate={goHome}
          />
        ) : (
          <Box />
        )}
      </Box>
      </Box>

      <Drawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} PaperProps={{ sx: { width: "min(88vw, 360px)" } }}>
        <WorkspaceSidebar
          drawer
          projects={projects}
          route={route}
          notifications={notificationsQuery.data ?? []}
          onNavigate={(next) => { setMobileNavOpen(false); goHome(next); }}
          onCreateProject={() => { setMobileNavOpen(false); if (!projectDefaultEngine) setProjectDefaultEngine(engines.find((engine) => engine.authenticated)?.id ?? ""); setProjectDialogOpen(true); }}
          onManageProject={(project) => { setMobileNavOpen(false); setSettingsProjectId(project.id); setRenamedProjectLabel(project.label); setProjectSettingsOpen(true); }}
        />
      </Drawer>

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
              {engines.map((engine) => <MenuItem key={engine.id} value={engine.id} disabled={!engine.authenticated}>{engine.displayName}{engine.authenticated ? "" : " — not signed in"}</MenuItem>)}
            </Select></FormControl>
            <FormControl fullWidth><InputLabel id="project-folder-mode-label">Working folder</InputLabel><Select labelId="project-folder-mode-label" label="Working folder" value={projectFolderMode} onChange={(event) => setProjectFolderMode(event.target.value as typeof projectFolderMode)}>
              <MenuItem value="existing">Choose an existing folder</MenuItem>
              <MenuItem value="create">Create a named empty folder</MenuItem>
            </Select></FormControl>
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
      <Dialog open={notificationPanelOpen} onClose={() => setNotificationPanelOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Notifications</DialogTitle>
        <DialogContent>
          <Stack spacing={1} sx={{ pt: 1 }}>
            {Array.from((notificationsQuery.data ?? []).reduce((groups, item) => {
              const key = `${item.projectId}:${item.conversationId ?? "project"}`;
              const group = groups.get(key) ?? []; group.push(item); groups.set(key, group); return groups;
            }, new Map<string, import("@ponderosa/core").WorkspaceNotificationDto[]>()).entries()).map(([key, items]) => {
              const [projectId = "", conversationId] = key.split(":");
              const project = projects.find((candidate) => candidate.id === projectId);
              return <Box key={key} sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
                <Button fullWidth sx={{ justifyContent: "flex-start", px: 1.5 }} onClick={() => { if (conversationId && conversationId !== "project") { setNotificationPanelOpen(false); navigate({ kind: "conversation", projectId, conversationId }); } }}>
                  {project?.label ?? "Project"} · {conversationId && conversationId !== "project" ? "Project chat" : "Project"} ({items.length})
                </Button>
                <List dense disablePadding>{items.map((item) => <ListItem key={item.id} disablePadding><ListItemButton selected={!item.readAt} onClick={() => { if (item.conversationId) { setNotificationPanelOpen(false); navigate({ kind: "conversation", projectId: item.projectId, conversationId: item.conversationId, ...(item.communicationEventId ? { messageId: item.communicationEventId } : {}) }); } }}><ListItemText primary={item.title} secondary={item.body} /></ListItemButton></ListItem>)}</List>
              </Box>;
            })}
            {(notificationsQuery.data ?? []).length === 0 ? <Typography color="text.secondary">No notifications.</Typography> : null}
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setNotificationPanelOpen(false)}>Done</Button></DialogActions>
      </Dialog>
      <Dialog open={notificationSettingsOpen} onClose={() => setNotificationSettingsOpen(false)} fullWidth maxWidth="xs">
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
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setNotificationSettingsOpen(false)}>Done</Button></DialogActions>
      </Dialog>

      <Dialog open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Project settings</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Project name" value={renamedProjectLabel} onChange={(event) => setRenamedProjectLabel(event.target.value)} fullWidth />
          {updateProject.isError ? <Alert severity="error">{String(updateProject.error)}</Alert> : null}
          <Button color="error" variant="outlined" onClick={() => setDeleteConfirmationOpen(true)}>Delete project permanently</Button>
        </Stack></DialogContent><DialogActions><Button onClick={() => setProjectSettingsOpen(false)}>Cancel</Button><Button variant="contained" disabled={!renamedProjectLabel.trim() || updateProject.isPending} onClick={() => updateProject.mutate()}>Save</Button></DialogActions>
      </Dialog>

      <Dialog open={deleteConfirmationOpen} onClose={() => setDeleteConfirmationOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete this project?</DialogTitle><DialogContent><Alert severity="warning">This permanently deletes its Project chats, agents, runs, work items, and files &amp; results. The working folder and its source files are not deleted.</Alert>{deleteProject.isError ? <Alert severity="error" sx={{ mt: 2 }}>{String(deleteProject.error)}</Alert> : null}</DialogContent>
        <DialogActions><Button onClick={() => setDeleteConfirmationOpen(false)}>Cancel</Button><Button color="error" variant="contained" disabled={deleteProject.isPending} onClick={() => deleteProject.mutate()}>Delete permanently</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
