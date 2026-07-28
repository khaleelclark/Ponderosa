import { Alert, Box, Button } from "@mui/material";
import type {
  ConversationDto,
  EngineDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { AllChatView } from "./components/AllChatView";
import { HomeView } from "./components/HomeView";
import { CreateWorkspace } from "./components/CreateWorkspace";
import type { ProjectBrowserRequest } from "./components/ProjectBrowserContext";
import { ProjectShell } from "./components/ProjectShell";
import {
  OperatorProfileWorkspace,
  WorkspaceSettingsView,
} from "./components/WorkspaceSettingsView";
import { AllProjectsView } from "./components/WorkspaceOverview";
import {
  AllAgentsWorkspace,
  AllChatsWorkspace,
  AllTriggersWorkspace,
  ProviderActivityWorkspace,
} from "./components/WorkspaceResourceViews";
import { WikiView } from "./components/WikiView";
import type { Route } from "./routing";
import { assertNeverRoute, isProjectRoute } from "./routeRegistry";
import type { ColorMode } from "./theme";

interface WorkspaceRouteOutletProps {
  route: Route;
  selectedProjectId?: string;
  projects: ProjectDto[];
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  colorMode: ColorMode;
  projectBrowserRequest?: ProjectBrowserRequest;
  loadError: boolean;
  onRetryLoad(): void;
  onNavigate(route: Route): void;
  onOpenInNewTab(route: Route): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onCreate(
    kind: "project" | "chat" | "agent" | "trigger",
    context?: { projectId?: string; managerAgentId?: string; agentId?: string },
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
        <CreateWorkspace
          route={route}
          projects={projects}
          engines={engines}
          preferences={preferences}
          onCancel={onCancelCreate}
          onNavigate={onNavigate}
        />
      ) : route.kind === "wiki" ? (
        <WikiView articleId={route.articleId} navigate={onNavigate} />
      ) : route.kind === "home" ? (
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
      ) : route.kind === "allChat" ? (
        <AllChatView onNavigate={onNavigate} notifications={notifications} />
      ) : route.kind === "projects" ? (
        <AllProjectsView
          projects={projects}
          preferences={preferences}
          onNavigate={onNavigate}
          onOpenInNewTab={onOpenInNewTab}
          onCreateProject={() => onCreate("project")}
          onProjectDeleted={onProjectDeleted}
          onPreferences={onPreferences}
        />
      ) : route.kind === "allAgents" ? (
        <AllAgentsWorkspace
          projects={projects}
          engines={engines}
          filterProjectId={route.filterProjectId}
          preferences={preferences}
          onPreferences={onPreferences}
          onNavigate={onNavigate}
          onOpenInNewTab={onOpenInNewTab}
          onCreate={(projectId, managerAgentId) =>
            onCreate("agent", { projectId, managerAgentId })}
        />
      ) : route.kind === "allChats" ? (
        <AllChatsWorkspace
          projects={projects}
          filterProjectId={route.filterProjectId}
          preferences={preferences}
          onPreferences={onPreferences}
          onNavigate={onNavigate}
          onOpenInNewTab={onOpenInNewTab}
          onCreate={projectId => onCreate("chat", { projectId })}
          onConversationAction={onConversationAction}
        />
      ) : route.kind === "allTriggers" ? (
        <AllTriggersWorkspace
          projects={projects}
          preferences={preferences}
          onPreferences={onPreferences}
          onNavigate={onNavigate}
          onOpenInNewTab={onOpenInNewTab}
          onCreate={() => onCreate("trigger")}
        />
      ) : route.kind === "settings" ? (
        <WorkspaceSettingsView
          preferences={preferences}
          engines={engines}
          projects={projects}
          colorMode={colorMode}
          onToggleColorMode={onToggleColorMode}
          onPreferences={onPreferences}
          section={route.section}
        />
      ) : route.kind === "profile" ? (
        <OperatorProfileWorkspace
          preferences={preferences}
          onPreferences={onPreferences}
        />
      ) : route.kind === "usage" ? (
        <ProviderActivityWorkspace
          projects={projects}
          projectId={route.projectId}
        />
      ) : isProjectRoute(route) ? (
        selectedProjectId ? (
          <ProjectShell
            projectId={selectedProjectId}
            project={
              projects.find(project => project.id === selectedProjectId)!
            }
            route={route}
            engines={engines}
            notifications={notifications}
            preferences={preferences}
            onPreferences={onPreferences}
            onRenameConversation={conversation =>
              onConversationAction("rename", conversation)
            }
            onDeleteConversation={conversation =>
              onConversationAction("delete", conversation)
            }
            onOpenEngineStatus={onOpenEngineStatus}
            navigate={onNavigate}
            browserRequest={projectBrowserRequest}
            onBrowserRequestHandled={onBrowserRequestHandled}
            openInNewTab={onOpenInNewTab}
            onResourceDeleted={onResourceDeleted}
          />
        ) : (
          <Box />
        )
      ) : (
        assertNeverRoute(route)
      )}
    </Box>
  );
}
