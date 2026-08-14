import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import type {
  ConversationDto,
  EngineDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { HomeView } from "./components/HomeView";
import type { ProjectBrowserRequest } from "./components/ProjectBrowserContext";
import { RecoverableLazyRoute } from "./components/RecoverableLazyRoute";
import type { Route } from "./routing";
import { assertNeverRoute, isProjectRoute, routeToPath } from "./routeRegistry";
import type { ColorMode } from "./theme";

const loadAllChatView = () => import("./components/AllChatView").then(module => ({ default: module.AllChatView }));
const loadCreateWorkspace = () => import("./components/CreateWorkspace").then(module => ({ default: module.CreateWorkspace }));
const loadProjectShell = () => import("./components/ProjectShell").then(module => ({ default: module.ProjectShell }));
const loadWikiView = () => import("./components/WikiView").then(module => ({ default: module.WikiView }));
const loadAllProjectsView = () => import("./components/WorkspaceOverview").then(module => ({ default: module.AllProjectsView }));
const workspaceResourceViews = () => import("./components/WorkspaceResourceViews");
const loadAllAgentsWorkspace = () => workspaceResourceViews().then(module => ({ default: module.AllAgentsWorkspace }));
const loadAllChatsWorkspace = () => workspaceResourceViews().then(module => ({ default: module.AllChatsWorkspace }));
const loadAllTriggersWorkspace = () => workspaceResourceViews().then(module => ({ default: module.AllTriggersWorkspace }));
const workspaceSettingsViews = () => import("./components/WorkspaceSettingsView");
const loadWorkspaceSettingsView = () => workspaceSettingsViews().then(module => ({ default: module.WorkspaceSettingsView }));
const loadOperatorProfileWorkspace = () => workspaceSettingsViews().then(module => ({ default: module.OperatorProfileWorkspace }));

interface WorkspaceRouteOutletProps {
  route: Route;
  selectedProjectId?: string;
  projectResolution?: "loading" | "missing" | "unavailable";
  onRetryProject(): void;
  projects: ProjectDto[];
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  colorMode: ColorMode;
  projectBrowserRequest?: ProjectBrowserRequest;
  loadError: boolean;
  onRetryLoad(): void;
  onNavigate(route: Route): void;
  onOpenInNewTab?(route: Route): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onCreate(
    kind: "project" | "chat" | "agent" | "trigger",
    context?: {
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
      agentId?: string;
    },
  ): void;
  onCancelCreate(): void;
  onOpenInbox(): void;
  onProjectDeleted(projectId: string): void;
  onConversationAction(
    kind: "rename" | "delete",
    conversation: ConversationDto,
  ): void;
  onOpenEngineStatus(): void;
  onBrowserRequestHandled(requestId: number): void;
  onResourceDeleted(route: Route): void;
  onToggleColorMode(): void;
}

export function WorkspaceRouteOutlet({
  route,
  selectedProjectId,
  projectResolution,
  onRetryProject,
  projects,
  engines,
  notifications,
  preferences,
  colorMode,
  projectBrowserRequest,
  loadError,
  onRetryLoad,
  onNavigate,
  onOpenInNewTab,
  onPreferences,
  onCreate,
  onCancelCreate,
  onOpenInbox,
  onProjectDeleted,
  onConversationAction,
  onOpenEngineStatus,
  onBrowserRequestHandled,
  onResourceDeleted,
  onToggleColorMode,
}: WorkspaceRouteOutletProps): JSX.Element {
  const routePath = routeToPath(route);
  const routeMarker = { kind: route.kind, path: routePath };
  return (
    <Box sx={{ minHeight: 0, minWidth: 0, display: "grid" }}>
      {loadError ? (
        <Box sx={{ p: 2 }}>
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
      ) : route.kind === "create" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadCreateWorkspace}
          routeMarker={routeMarker}
          componentProps={{ route, projects, engines, preferences, onCancel: onCancelCreate, onNavigate }}
        />
      ) : route.kind === "wiki" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadWikiView}
          routeMarker={routeMarker}
          componentProps={{ articleId: route.articleId, navigate: onNavigate }}
        />
      ) : route.kind === "home" ? (
        <Box
          data-workspace-route-kind={route.kind}
          data-workspace-route-path={routePath}
          data-workspace-route-content
          sx={{ display: "contents" }}
        >
          <HomeView
            projects={projects}
            engines={engines}
            notifications={notifications}
            preferences={preferences}
            onNavigate={onNavigate}
            onOpenInNewTab={onOpenInNewTab}
            onPreferences={onPreferences}
            onCreateProject={() => onCreate("project")}
            onCreateChat={() => onCreate("chat")}
            onCreateAgent={() => onCreate("agent")}
            onCreateTrigger={() => onCreate("trigger")}
            onOpenInbox={onOpenInbox}
          />
        </Box>
      ) : route.kind === "allChat" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadAllChatView}
          routeMarker={routeMarker}
          componentProps={{ onNavigate, notifications }}
        />
      ) : route.kind === "projects" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadAllProjectsView}
          routeMarker={routeMarker}
          componentProps={{
            projects,
            preferences,
            onNavigate,
            onOpenInNewTab,
            onCreateProject: () => onCreate("project"),
            onProjectDeleted,
            onPreferences,
          }}
        />
      ) : route.kind === "allAgents" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadAllAgentsWorkspace}
          routeMarker={routeMarker}
          componentProps={{
            projects,
            engines,
            filterProjectId: route.filterProjectId,
            preferences,
            onPreferences,
            onNavigate,
            onOpenInNewTab,
            onCreate: (projectId, managerAgentId) =>
              onCreate("agent", {
                ...(projectId ? { projectId } : {}),
                ...(managerAgentId ? { managerAgentId } : {}),
              }),
            onAgentsDeleted: (projectId, agentIds) =>
              agentIds.forEach(agentId =>
                onResourceDeleted({ kind: "agent", projectId, agentId }),
              ),
          }}
        />
      ) : route.kind === "allChats" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadAllChatsWorkspace}
          routeMarker={routeMarker}
          componentProps={{
            projects,
            filterProjectId: route.filterProjectId,
            preferences,
            onPreferences,
            onNavigate,
            onOpenInNewTab,
            onCreate: projectId => onCreate("chat", { projectId }),
            onConversationAction,
          }}
        />
      ) : route.kind === "allTriggers" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadAllTriggersWorkspace}
          routeMarker={routeMarker}
          componentProps={{
            projects,
            preferences,
            onPreferences,
            onNavigate,
            onOpenInNewTab,
            onCreate: () => onCreate("trigger"),
          }}
        />
      ) : route.kind === "settings" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadWorkspaceSettingsView}
          routeMarker={routeMarker}
          componentProps={{
            preferences,
            engines,
            projects,
            colorMode,
            onToggleColorMode,
            onPreferences,
            section: route.section,
          }}
        />
      ) : route.kind === "profile" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadOperatorProfileWorkspace}
          routeMarker={routeMarker}
          componentProps={{ preferences, onPreferences }}
        />
      ) : route.kind === "usage" ? (
        <RecoverableLazyRoute
          key={routePath}
          load={loadWorkspaceSettingsView}
          routeMarker={routeMarker}
          componentProps={{
            preferences,
            engines,
            projects,
            colorMode,
            onToggleColorMode,
            onPreferences,
            section: "activity",
            activityProjectId: route.projectId,
          }}
        />
      ) : isProjectRoute(route) ? (
        selectedProjectId ? (
          <RecoverableLazyRoute
            key={routePath}
            load={loadProjectShell}
            routeMarker={routeMarker}
            componentProps={{
              projectId: selectedProjectId,
              project: projects.find(project => project.id === selectedProjectId)!,
              route,
              engines,
              notifications,
              preferences,
              onPreferences,
              onRenameConversation: conversation =>
                onConversationAction("rename", conversation),
              onDeleteConversation: conversation =>
                onConversationAction("delete", conversation),
              onOpenEngineStatus,
              navigate: onNavigate,
              browserRequest: projectBrowserRequest,
              onBrowserRequestHandled,
              openInNewTab: onOpenInNewTab,
              onResourceDeleted,
              onCreate: (kind, context) => onCreate(kind, context),
            }}
          />
        ) : projectResolution === "loading" ? (
          <Stack role="status" aria-live="polite" spacing={1} sx={{ p: 3 }}>
            <LinearProgress />
            <Typography color="text.secondary">Loading Project...</Typography>
          </Stack>
        ) : projectResolution === "missing" ? (
          <Box sx={{ p: 3 }}>
            <Alert
              severity="warning"
              action={
                <Button onClick={() => onNavigate({ kind: "projects" })}>
                  View Projects
                </Button>
              }
            >
              This Project could not be found. It may have been deleted.
            </Alert>
          </Box>
        ) : (
          <Box sx={{ p: 3 }}>
            <Alert
              severity="error"
              action={<Button onClick={onRetryProject}>Retry</Button>}
            >
              This Project is temporarily unavailable. Your URL has been
              preserved.
            </Alert>
          </Box>
        )
      ) : (
        assertNeverRoute(route)
      )}
    </Box>
  );
}
