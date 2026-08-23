import {
  Box,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { ConversationDto, ProjectDto } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { ApiRequestError } from "./api/types";
import { ProjectShell } from "./components/ProjectShell";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
import { WorkspaceConnectionNotice } from "./components/WorkspaceConnectionNotice";
import { WorkspaceConnectionProvider } from "./components/WorkspaceConnectionContext";
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
  useAgent,
  useEngines,
  useNotifications,
  useProjects,
  useWorkspacePreferences,
} from "./hooks/queries";
import { reconcileDeletedProjectClientState, useWorkspaceStream } from "./hooks/useWorkspaceStream";
import {
  parseRoute,
  routeProjectId,
  saveLastProjectId,
  useRoute,
  type Route,
} from "./routing";
import { isProjectRoute } from "./routeRegistry";
import type { ColorMode } from "./theme";
import {
  reconcileDisplayedPushNotifications,
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
import { recheckProvider } from "./providerAuthRefresh";
import { changedWorkspaceDirectoryKinds } from "./resourcePreferences";
import {
  WORKSPACE_SIDEBAR_STORAGE_KEY,
  restoreWorkspaceSidebarState,
  serializeWorkspaceSidebarState,
} from "./workspaceSidebarState";
import { queryKeys } from "./queryKeys";
import {
  MobileWorkspaceDrawer,
  WorkspaceAppHeader,
} from "./App.mobile";
import { WorkspaceRouteOutlet } from "./App.workspace-content";
import {
  markWorkspaceResourceUsed,
  workspaceResourceFromRoute,
} from "./workspaceRecency";
import { MobileWorkspaceActionsProvider } from "./components/MobileWorkspaceActionsContext";
import {
  notificationsForAvailableProjects,
} from "./attention";
import { useAppViewport } from "./hooks/useAppViewport";
import {
  ActiveNotificationViewProvider,
  activeNotificationViewForRoute,
} from "./notificationActiveView";

const OPERATOR_PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const OPERATOR_PROFILE_IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif";
const PUSH_CLEANUP_RETRY_INITIAL_MS = 1_000;
const PUSH_CLEANUP_RETRY_MAX_MS = 30_000;

export default function App({
  colorMode,
  onToggleColorMode,
}: {
  colorMode: ColorMode;
  onToggleColorMode(): void;
}): JSX.Element {
  useAppViewport();
  const queryClient = useQueryClient();
  const { route, navigate } = useRoute();
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState === "visible",
  );
  const activeNotificationView = useMemo(
    () => activeNotificationViewForRoute(route, pageVisible),
    [route, pageVisible],
  );

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    const publish = () => navigator.serviceWorker?.controller?.postMessage({
      type: "ponderosa:active-notification-view",
      view: activeNotificationView ?? null,
    });
    publish();
    navigator.serviceWorker?.addEventListener("controllerchange", publish);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", publish);
  }, [activeNotificationView]);
  const routeRef = useRef(route);
  routeRef.current = route;
  const creationOrigin = useRef<Route>();
  const reconcileDeletedProject = (
    projectId: string,
    at = new Date().toISOString(),
  ) => {
    reconcileDeletedProjectClientState(queryClient, projectId, at);
    if (routeProjectId(routeRef.current) === projectId) {
      creationOrigin.current = undefined;
      navigate({ kind: "projects" }, { replace: true });
    }
  };
  const workspaceConnection = useWorkspaceStream({
    onProjectDeleted: reconcileDeletedProject,
  });
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
  const routedProjectId = routeProjectId(route);
  const projectPage = projectsQuery.data ?? [];
  const routedProjectQuery = useQuery({
    queryKey: queryKeys.projects.detail(routedProjectId),
    queryFn: () => api.getProject(routedProjectId ?? ""),
    enabled: Boolean(routedProjectId) &&
      !projectPage.some(project => project.id === routedProjectId),
    retry: false,
  });
  const enginesQuery = useEngines();
  const preferencesQuery = useWorkspacePreferences();
  const notificationsQuery = useNotifications();
  const triggerPushCleanup = useRef<() => void>(() => undefined);
  const projectOrder = preferencesQuery.data?.projectOrder ?? [];
  const projects = [
    ...projectPage,
    ...(routedProjectQuery.data &&
    !projectPage.some(project => project.id === routedProjectQuery.data.id)
      ? [routedProjectQuery.data]
      : []),
  ].sort((a, b) => {
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
  const presentedNotifications = useMemo(
    () => projectsQuery.isSuccess
      ? notificationsForAvailableProjects(
          notificationsQuery.data?.items ?? [],
          new Set((projectsQuery.data ?? []).map(project => project.id)),
        )
      : notificationsQuery.data?.items ?? [],
    [notificationsQuery.data, projectsQuery.data, projectsQuery.isSuccess],
  );
  const notificationCounts = {
    attentionCount: notificationsQuery.data?.attentionCount ?? 0,
    unreadUpdateCount: notificationsQuery.data?.unreadUpdateCount ?? 0,
  };
  const engines = enginesQuery.data ?? [];
  const providerEngines = useRef(engines);
  providerEngines.current = engines;
  const providerRecheckAt = useRef(new Map<string, number>());
  const providerRecheckInFlight = useRef(new Set<string>());
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
  const readinessQuery = useQuery({
    queryKey: queryKeys.readiness.all,
    queryFn: () => api.getReadiness(),
    enabled: engineStatusOpen,
    staleTime: 30_000,
  });
  const activeAgentQuery = useAgent(
    route.kind === "agent" ? route.agentId : undefined,
  );

  useEffect(() => {
    let stopped = false;

    const recheckUnavailableProviders = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const now = Date.now();
      for (const engine of providerEngines.current) {
        if (
          engine.enabled === false ||
          (engine.authentication === "authenticated" && engine.intakeReady && engine.reachability === "reachable") ||
          providerRecheckInFlight.current.has(engine.id) ||
          now - (providerRecheckAt.current.get(engine.id) ?? 0) < 4_000
        ) {
          continue;
        }
        providerRecheckAt.current.set(engine.id, now);
        providerRecheckInFlight.current.add(engine.id);
        void recheckProvider(queryClient, engine.id)
          .catch(() => {
            // Provider settings keep the explicit retry and error surface.
          })
          .finally(() => {
            providerRecheckInFlight.current.delete(engine.id);
          });
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheckUnavailableProviders();
    };

    window.addEventListener("focus", recheckUnavailableProviders);
    document.addEventListener("visibilitychange", onVisible);
    recheckUnavailableProviders();
    return () => {
      stopped = true;
      window.removeEventListener("focus", recheckUnavailableProviders);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [engines, queryClient]);
  const preferredQuotaProvider =
    activeAgentQuery.data?.agent.activeEngine;

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
    let stopped = false;
    let reconciliationInFlight = false;
    let reconciliationRequested = false;
    let retryTimer: number | undefined;
    let retryDelay = PUSH_CLEANUP_RETRY_INITIAL_MS;
    const reconcile = () => {
      if (stopped) return;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (reconciliationInFlight) {
        reconciliationRequested = true;
        return;
      }
      reconciliationInFlight = true;
      reconciliationRequested = false;
      void reconcileDisplayedPushNotifications()
        .catch(() => false)
        .then((succeeded) => {
          reconciliationInFlight = false;
          if (stopped) return;
          if (succeeded) {
            retryDelay = PUSH_CLEANUP_RETRY_INITIAL_MS;
            if (reconciliationRequested) queueMicrotask(reconcile);
            return;
          }
          const delay = retryDelay;
          retryDelay = Math.min(retryDelay * 2, PUSH_CLEANUP_RETRY_MAX_MS);
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            reconcile();
          }, delay);
        });
    };
    triggerPushCleanup.current = reconcile;
    const refresh = () => {
      void inspectWebPush();
      reconcile();
    };
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      void syncWebPush(false).finally(() => {
        reconcile();
      });
    } else refresh();
    const unsubscribe = subscribeWebPushChanges(refresh);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    navigator.serviceWorker?.addEventListener("controllerchange", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (triggerPushCleanup.current === reconcile) {
        triggerPushCleanup.current = () => undefined;
      }
      unsubscribe();
      navigator.serviceWorker?.removeEventListener("controllerchange", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (workspaceConnection.status === "live") triggerPushCleanup.current();
  }, [workspaceConnection.status]);

  useEffect(() => {
    if (notificationsQuery.data) triggerPushCleanup.current();
  }, [notificationsQuery.data]);

  const selectedProjectId =
    routedProjectId && projects.some(project => project.id === routedProjectId)
      ? routedProjectId
      : undefined;

  const projectResolution = !isProjectRoute(route) || selectedProjectId
    ? undefined
    : routedProjectQuery.isPending || projectsQuery.isPending
      ? "loading"
      : routedProjectQuery.error instanceof ApiRequestError &&
          routedProjectQuery.error.status === 404
        ? "missing"
        : "unavailable";


  const openSidebarConversationAction = (
    kind: "rename" | "delete",
    conversation: ConversationDto,
  ) => {
    setSidebarConversationAction({ kind, conversation });
  };

  const preferences = preferencesQuery.data ?? { projectSort: "last_used" as const, projectOrder: [], homeSort: "last_used" as const, homeOrder: [], chatSort: "last_used" as const, chatOrder: [], agentSort: "last_used" as const, agentOrder: [], triggerSort: "last_used" as const, triggerOrder: [], starredResourceIds: [], starredProjectIds: [], sidebarCollapsed: false, sidebarWidth: 288, notifications: { directResponses: true, broadcasts: true }, fontFamily: "inter" as const, providerAvailability: {}, defaultUsageProvider: undefined as string | undefined, engineDefaults: {}, claudeModelOptions: [], globalInstructions: "", maxConcurrentAgentRuns: 8, contextRolloverEnabled: false, contextRolloverTokens: 150_000, contextRolloverWindowFraction: 0.7, onboardingCompletedAt: null, profile: { displayName: "User", handle: "operator", avatarId: "default-user" }, updatedAt: new Date(0).toISOString() };
  const usageProviders = engines.filter(engine =>
    engine.authentication === "authenticated" && Boolean(engine.providerUsageCommand)
  );
  const defaultQuotaProvider = usageProviders.some(
    engine => engine.id === preferences.defaultUsageProvider,
  )
    ? preferences.defaultUsageProvider
    : usageProviders[0]?.id;
  const displayedQuotaProvider = preferredQuotaProvider ?? defaultQuotaProvider;
  const savePreferences = (patch: Partial<typeof preferences>) => {
    queryClient.setQueryData(queryKeys.workspacePreferences.all, { ...preferences, ...patch });
    void api.updateWorkspacePreferences(patch).then((value) => {
      queryClient.setQueryData(queryKeys.workspacePreferences.all, value);
      for (const kind of changedWorkspaceDirectoryKinds(preferences, value)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.workspaceDirectory.kind(kind),
        });
      }
      if (patch.starredResourceIds !== undefined || patch.starredProjectIds !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.workspaceResourceRecency.all,
        });
      }
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
    if (next.kind !== "create") creationOrigin.current = undefined;
    recordWorkspaceRouteUse(next);
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
    if (route.kind !== "create") creationOrigin.current = route;
    navigateWorkspace({
      kind: "create",
      resource: kind,
      surface: "workspace",
      ...(context?.projectId ? { projectId: context.projectId } : {}),
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.managerAgentId ? { managerAgentId: context.managerAgentId } : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
    });
  };
  const replaceWorkspaceWithCreationForm = (
    kind: "project" | "chat" | "agent" | "trigger",
  ) => openCreationForm(kind);
  const openProjectBrowser = (url?: string) => {
    if (!selectedProjectId) return;
    projectBrowserRequestId.current += 1;
    setProjectBrowserRequest({
      ...(url ? { url } : {}),
      requestId: projectBrowserRequestId.current,
    });
    navigateWorkspace({ kind: "browser", projectId: selectedProjectId });
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
      navigateWorkspace(parseRoute(target.pathname, target.search));
    };
    navigator.serviceWorker?.addEventListener("message", openNotificationRoute);
    return () =>
      navigator.serviceWorker?.removeEventListener(
        "message",
        openNotificationRoute,
      );
  }, [navigateWorkspace]);
  const cancelCreationWorkspace = () => {
    const destination = creationOrigin.current ?? { kind: "home" as const };
    creationOrigin.current = undefined;
    navigateWorkspace(destination);
  };
  const removeWorkspaceView = (removedRoute: Extract<Route, { kind: "agent" | "conversation" }>) => {
    const current = routeRef.current;
    const removedCurrent = removedRoute.kind === "conversation"
      ? current.kind === "conversation" && current.projectId === removedRoute.projectId && current.conversationId === removedRoute.conversationId
      : current.kind === "agent" && current.projectId === removedRoute.projectId && current.agentId === removedRoute.agentId;
    if (!removedCurrent) return;
    navigateWorkspace(removedRoute.kind === "conversation"
      ? { kind: "project", projectId: removedRoute.projectId }
      : { kind: "agents", projectId: removedRoute.projectId });
  };
  const handleProjectDeleted = (projectId: string) => {
    reconcileDeletedProject(projectId);
  };
  const openSettings = () => {
    navigateWorkspace({ kind: "settings", section: "general" });
  };
  const openProviderSettings = () => {
    navigateWorkspace({ kind: "settings", section: "providers" });
  };
  const openOperatorProfile = () => {
    setOperatorProfileOpen(true);
  };
  return (
    <ProjectBrowserContext.Provider
      value={{ projectId: selectedProjectId, open: openProjectBrowser }}
    >
      <MobileWorkspaceActionsProvider>
      <Box
        sx={{
          height: "var(--ponderosa-app-viewport-block-size, 100dvh)",
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
        <WorkspaceAppHeader
          preferredQuotaProvider={displayedQuotaProvider}
          engineAvailability={engineAvailability}
          attentionNotifications={notificationCounts.attentionCount}
          unreadNotificationUpdates={notificationCounts.unreadUpdateCount}
          profile={preferences.profile}
          onOpenNavigation={() => setMobileNavOpen(true)}
          onOpenEngineStatus={() => setEngineStatusOpen(true)}
          onOpenSearch={() => setGlobalSearchOpen(true)}
          onOpenNotifications={() => setNotificationPanelOpen(true)}
          onOpenProfile={openOperatorProfile}
          onOpenSettings={openSettings}
          onOpenProviderSettings={openProviderSettings}
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
              notifications={presentedNotifications}
              onNavigate={navigateWorkspace}
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
              gridTemplateRows: "minmax(0, 1fr)",
            }}
          >
            <Box
              sx={{
                minHeight: 0,
                minWidth: 0,
                display: "grid",
                gridTemplateRows: "auto minmax(0, 1fr)",
                position: "relative",
              }}
            >
              <WorkspaceConnectionNotice connection={workspaceConnection} />
              <Box
                sx={{
                  gridRow: 2,
                  minHeight: 0,
                  minWidth: 0,
                  display: "grid",
                }}
              >
              <ActiveNotificationViewProvider value={activeNotificationView}>
              <WorkspaceConnectionProvider value={workspaceConnection}>
                <WorkspaceErrorBoundary
                  title="This workspace view could not be displayed."
                  resetKey={JSON.stringify(route)}
                >
                  <WorkspaceRouteOutlet
                    route={route}
                    selectedProjectId={selectedProjectId}
                    projectResolution={projectResolution}
                    onRetryProject={() => void routedProjectQuery.refetch()}
                    projects={projects}
                    engines={engines}
                    notifications={presentedNotifications}
                    preferences={preferences}
                    colorMode={colorMode}
                    projectBrowserRequest={projectBrowserRequest}
                    loadError={
                      enginesQuery.isError ||
                      (!isProjectRoute(route) && projectsQuery.isError)
                    }
                    onRetryLoad={() => {
                      void projectsQuery.refetch();
                      void enginesQuery.refetch();
                    }}
                    onNavigate={navigateWorkspace}
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
              </WorkspaceConnectionProvider>
              </ActiveNotificationViewProvider>
              </Box>
            </Box>
          </Box>
        </Box>

        <MobileWorkspaceDrawer
          open={mobileNavOpen}
          projects={projects}
          preferences={preferences}
          route={route}
          notifications={presentedNotifications}
          onOpenChange={setMobileNavOpen}
          onNavigate={navigateWorkspace}
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
          firstPage={notificationsQuery.data}
          onClose={() => setNotificationPanelOpen(false)}
          onNavigate={navigateWorkspace}
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
      </MobileWorkspaceActionsProvider>
    </ProjectBrowserContext.Provider>
  );
}
