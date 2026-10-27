import { Alert, Box, Button } from "@mui/material";
import { LoadingState } from "./components/LoadingState";
import { MobileNavigationButton } from "./components/MobileNavigationContext";
import type {
  EngineDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspaceNotificationPageDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import type { ProjectBrowserRequest } from "./components/ProjectBrowserContext";
import { RecoverableLazyRoute } from "./components/RecoverableLazyRoute";
import { routeReturnLabel, routeReturnTarget, type Route } from "./routing";
import {
  assertNeverRoute,
  isProjectRoute,
  routeWaitsForWorkspacePreferences,
} from "./routeRegistry";
import type { ColorMode } from "./theme";

type RemovableWorkspaceResourceRoute = Extract<
  Route,
  { kind: "agent" | "conversation" }
>;

const loadAllChatView = () => import("./components/AllChatView").then(module => ({ default: module.AllChatView }));
const loadManageChatsWorkspace = () => import("./components/ManageChatsWorkspace").then(module => ({ default: module.ManageChatsWorkspace }));
const loadManageAgentsWorkspace = () => import("./components/WorkspaceResourceViews").then(module => ({ default: module.AllAgentsWorkspace }));
const loadHomeView = () => import("./components/HomeView").then(module => ({ default: module.HomeView }));
const loadCreateWorkspace = () => import("./components/CreateWorkspace").then(module => ({ default: module.CreateWorkspace }));
const loadProjectShell = () => import("./components/ProjectShell").then(module => ({ default: module.ProjectShell }));
const workspaceSettingsViews = () => import("./components/WorkspaceSettingsView");
const loadWorkspaceSettingsView = () => workspaceSettingsViews().then(module => ({ default: module.WorkspaceSettingsView }));

interface WorkspaceRouteOutletProps {
  route: Route;
  selectedProjectId?: string;
  projectResolution?: "loading" | "missing" | "unavailable";
  onRetryProject(): void;
  projects: ProjectDto[];
  projectsLoaded: boolean;
  engines: EngineDto[];
  enginesLoaded: boolean;
  notifications: WorkspaceNotificationDto[];
  notificationCounts?: Pick<WorkspaceNotificationPageDto, "openActionCount">;
  notificationsLoadFailed?: boolean;
  preferences: WorkspacePreferencesDto;
  preferencesLoaded: boolean;
  colorMode: ColorMode;
  projectBrowserRequest?: ProjectBrowserRequest;
  loadError: boolean;
  refreshError: boolean;
  onRetryLoad(): void;
  onNavigate(route: Route): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onSavePreferences(
    patch: Partial<WorkspacePreferencesDto>,
  ): Promise<WorkspacePreferencesDto>;
  onCreate(
    kind: "chat" | "agent",
    context?: {
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
    },
  ): void;
  onCancelCreate(): void;
  onOpenInbox(): void;
  onBrowserRequestHandled(requestId: number): void;
  onResourceDeleted(route: RemovableWorkspaceResourceRoute): void;
  onToggleColorMode(): void;
}

export function WorkspaceRouteOutlet({
  route,
  selectedProjectId,
  projectResolution,
  onRetryProject,
  projects,
  projectsLoaded,
  engines,
  enginesLoaded,
  notifications,
  notificationCounts,
  notificationsLoadFailed,
  preferences,
  preferencesLoaded,
  colorMode,
  projectBrowserRequest,
  loadError,
  refreshError,
  onRetryLoad,
  onNavigate,
  onPreferences,
  onSavePreferences,
  onCreate,
  onOpenInbox,
  onCancelCreate,
  onBrowserRequestHandled,
  onResourceDeleted,
  onToggleColorMode,
}: WorkspaceRouteOutletProps): JSX.Element {
  return (
    <Box
      sx={{
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: refreshError && !loadError
          ? "auto minmax(0, 1fr)"
          : "minmax(0, 1fr)",
      }}
    >
      {refreshError && !loadError ? (
        <Alert
          severity="warning"
          action={<Button color="inherit" size="small" onClick={onRetryLoad}>Retry</Button>}
          sx={{ m: 1 }}
        >
          Some workspace data could not be refreshed. The last loaded data remains available.
        </Alert>
      ) : null}
      <Box sx={{ minHeight: 0, minWidth: 0, display: "grid" }}>
      {loadError ? (
        <Box sx={{ p: 2 }}>
          <MobileNavigationButton />
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={onRetryLoad}>
                Retry
              </Button>
            }
          >
            Ponderosa could not load its workspace data. Check the server
            connection and try again.
          </Alert>
        </Box>
      ) : routeWaitsForWorkspacePreferences(route, preferencesLoaded) ? (
        <LoadingState resource="settings" variant="route" />
      ) : route.kind === "create" ? (
        <RecoverableLazyRoute
          key={[
            "create",
            route.resource,
            route.projectId ?? "",
            route.conversationId ?? "",
            route.managerAgentId ?? "",
            route.creationKey ?? "",
          ].join(":")}
          load={loadCreateWorkspace}
          componentProps={{ route, projects, engines, enginesLoaded, preferences, onCancel: onCancelCreate, onNavigate }}
        />
      ) : route.kind === "home" ? (
        <RecoverableLazyRoute key="home" load={loadHomeView} componentProps={{ projects, projectsLoaded, engines, enginesLoaded, notifications, notificationCounts, notificationsLoadFailed, onNavigate, onCreateProject: () => onCreate("chat"), onOpenInbox }} />
      ) : route.kind === "allChat" ? (
        <RecoverableLazyRoute
          key="all-chat"
          load={loadAllChatView}
          componentProps={{ onNavigate, notifications }}
        />
      ) : route.kind === "manageChats" ? (
        <RecoverableLazyRoute
          key="manage-chats"
          load={loadManageChatsWorkspace}
          componentProps={{ onNavigate }}
        />
      ) : route.kind === "manageAgents" ? (
        <RecoverableLazyRoute
          key="manage-agents"
          load={loadManageAgentsWorkspace}
          componentProps={{
            projects,
            engines,
            preferences,
            onPreferences,
            onNavigate,
            managementMode: true,
            onCreate: (
              projectId?: string,
              managerAgentId?: string,
              conversationId?: string,
            ) => onCreate("agent", { projectId, managerAgentId, conversationId }),
            onAgentsDeleted: () => undefined,
          }}
        />
      ) : route.kind === "settings" ? (
        <RecoverableLazyRoute
          key="settings"
          load={loadWorkspaceSettingsView}
          componentProps={{
            preferences,
            engines,
            projects,
            colorMode,
            onToggleColorMode,
            onPreferences,
            onSavePreferences,
            section: route.section,
            onReturn: () => onNavigate(routeReturnTarget(route.returnTo, { kind: "home" })),
            returnLabel: routeReturnLabel(routeReturnTarget(route.returnTo, { kind: "home" })),
          }}
        />
      ) : route.kind === "usage" ? (
        <RecoverableLazyRoute
          key="usage"
          load={loadWorkspaceSettingsView}
          componentProps={{
            preferences,
            engines,
            projects,
            colorMode,
            onToggleColorMode,
            onPreferences,
            onSavePreferences,
            section: "activity",
            activityProjectId: route.projectId,
          }}
        />
      ) : isProjectRoute(route) ? (
        selectedProjectId ? (
          <RecoverableLazyRoute
            key={`project:${selectedProjectId}`}
            load={loadProjectShell}
            componentProps={{
              projectId: selectedProjectId,
              project: projects.find(project => project.id === selectedProjectId)!,
              route,
              engines,
              preferences,
              onPreferences,
              decisionReviewAction: <Button color="inherit" size="small" onClick={onOpenInbox}>View decision</Button>,
              navigate: onNavigate,
              browserRequest: projectBrowserRequest,
              onBrowserRequestHandled,
              onResourceDeleted,
              onCreate: (kind, context) => onCreate(kind, context),
            }}
          />
        ) : projectResolution === "loading" ? (
          <LoadingState resource="Chat workspace" variant="route" />
        ) : projectResolution === "missing" ? (
          <Box sx={{ p: 3 }}>
            <Alert
              severity="warning"
              action={
                <Button onClick={() => onNavigate({ kind: "home" })}>
                  Go Home
                </Button>
              }
            >
              This Chat workspace could not be found. It may have been deleted.
            </Alert>
          </Box>
        ) : (
          <Box sx={{ p: 3 }}>
            <Alert
              severity="error"
              action={<Button onClick={onRetryProject}>Retry</Button>}
            >
              This Chat workspace is temporarily unavailable. Your URL has been
              preserved.
            </Alert>
          </Box>
        )
      ) : (
        assertNeverRoute(route)
      )}
      </Box>
    </Box>
  );
}
