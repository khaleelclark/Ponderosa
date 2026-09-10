import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import type {
  ConversationDto,
  EngineDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspaceNotificationPageDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { HomeView } from "./components/HomeView";
import type { ProjectBrowserRequest } from "./components/ProjectBrowserContext";
import { RecoverableLazyRoute } from "./components/RecoverableLazyRoute";
import type { Route } from "./routing";
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
const loadCreateWorkspace = () => import("./components/CreateWorkspace").then(module => ({ default: module.CreateWorkspace }));
const loadProjectShell = () => import("./components/ProjectShell").then(module => ({ default: module.ProjectShell }));
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
  projectsLoaded: boolean;
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  notificationCounts?: Pick<WorkspaceNotificationPageDto, "openActionCount">;
  preferences: WorkspacePreferencesDto;
  preferencesLoaded: boolean;
  colorMode: ColorMode;
  projectBrowserRequest?: ProjectBrowserRequest;
  loadError: boolean;
  onRetryLoad(): void;
  onNavigate(route: Route): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onSavePreferences(
    patch: Partial<WorkspacePreferencesDto>,
  ): Promise<WorkspacePreferencesDto>;
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
  notifications,
  notificationCounts,
  preferences,
  preferencesLoaded,
  colorMode,
  projectBrowserRequest,
  loadError,
  onRetryLoad,
  onNavigate,
  onPreferences,
  onSavePreferences,
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
  return (
    <Box
      sx={{
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
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
      ) : routeWaitsForWorkspacePreferences(route, preferencesLoaded) ? (
        <Stack role="status" aria-live="polite" spacing={1} sx={{ p: 3 }}>
          <LinearProgress />
          <Typography color="text.secondary">Loading profile…</Typography>
        </Stack>
      ) : route.kind === "create" ? (
        <RecoverableLazyRoute
          key={[
            "create",
            route.resource,
            route.projectId ?? "",
            route.conversationId ?? "",
            route.managerAgentId ?? "",
            route.agentId ?? "",
          ].join(":")}
          load={loadCreateWorkspace}
          componentProps={{ route, projects, engines, preferences, onCancel: onCancelCreate, onNavigate }}
        />
      ) : route.kind === "home" ? (
        <Box
          sx={{ display: "contents" }}
        >
          <HomeView
            projects={projects}
            projectsLoaded={projectsLoaded}
            engines={engines}
            notifications={notifications}
            notificationCounts={notificationCounts}
            onNavigate={onNavigate}
            onCreateProject={() => onCreate("project")}
            onOpenInbox={onOpenInbox}
          />
        </Box>
      ) : route.kind === "allChat" ? (
        <RecoverableLazyRoute
          key="all-chat"
          load={loadAllChatView}
          componentProps={{ onNavigate, notifications }}
        />
      ) : route.kind === "projects" ? (
        <RecoverableLazyRoute
          key="projects"
          load={loadAllProjectsView}
          componentProps={{
            projects,
            preferences,
            onNavigate,
            onCreateProject: () => onCreate("project"),
            onProjectDeleted,
            onPreferences,
          }}
        />
      ) : route.kind === "allAgents" ? (
        <RecoverableLazyRoute
          key="all-agents"
          load={loadAllAgentsWorkspace}
          componentProps={{
            projects,
            engines,
            filterProjectId: route.filterProjectId,
            preferences,
            onPreferences,
            onNavigate,
            onCreate: (projectId, managerAgentId, conversationId) =>
              onCreate("agent", {
                ...(projectId ? { projectId } : {}),
                ...(conversationId ? { conversationId } : {}),
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
          key="all-chats"
          load={loadAllChatsWorkspace}
          componentProps={{
            projects,
            filterProjectId: route.filterProjectId,
            preferences,
            onPreferences,
            onNavigate,
            onCreate: projectId => onCreate("chat", { projectId }),
            onConversationAction,
          }}
        />
      ) : route.kind === "allTriggers" ? (
        <RecoverableLazyRoute
          key="all-triggers"
          load={loadAllTriggersWorkspace}
          componentProps={{
            projects,
            preferences,
            onPreferences,
            onNavigate,
            onCreate: () => onCreate("trigger"),
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
          }}
        />
      ) : route.kind === "profile" ? (
        <RecoverableLazyRoute
          key="profile"
          load={loadOperatorProfileWorkspace}
          componentProps={{ preferences, onPreferences }}
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
              onResourceDeleted,
              onProjectDeleted,
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
