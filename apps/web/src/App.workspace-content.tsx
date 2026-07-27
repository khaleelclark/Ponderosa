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
import { NewWorkspace } from "./components/NewWorkspace";
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
  onCreateProject(): void;
  onBeginHomeCreate(kind: "chat" | "agent" | "trigger"): void;
  onCreateHomeChat(projectId?: string): void;
  onCreateHomeAgent(projectId?: string, managerAgentId?: string): void;
  onOpenInbox(): void;
  onManageProject(project: ProjectDto): void;
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
  onCreateProject,
  onBeginHomeCreate,
  onCreateHomeChat,
  onCreateHomeAgent,
  onOpenInbox,
  onManageProject,
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
      ) : route.kind === "wiki" ? (
        <WikiView articleId={route.articleId} navigate={onNavigate} />
      ) : route.kind === "new" ? (
        <NewWorkspace
          initialKind={route.createKind}
          onKindChange={createKind =>
            onNavigate({ kind: "new", createKind })
          }
          onCreate={createKind => {
            if (createKind === "project") onCreateProject();
            else onBeginHomeCreate(createKind);
          }}
        />
      ) : route.kind === "home" ? (
        <HomeView
          projects={projects}
          engines={engines}
          notifications={notifications}
          preferences={preferences}
          onNavigate={onNavigate}
          onOpenInNewTab={onOpenInNewTab}
          onPreferences={onPreferences}
          onCreateProject={() => onNavigate({ kind: "new", createKind: "project" })}
          onCreateChat={() => onNavigate({ kind: "new", createKind: "chat" })}
          onCreateAgent={() => onNavigate({ kind: "new", createKind: "agent" })}
          onCreateTrigger={() =>
            onNavigate({ kind: "new", createKind: "trigger" })
          }
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
          onCreateProject={() => onNavigate({ kind: "new", createKind: "project" })}
          onManageProject={onManageProject}
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
            projectId
              ? onCreateHomeAgent(projectId, managerAgentId)
              : onNavigate({ kind: "new", createKind: "agent" })
          }
        />
      ) : route.kind === "allChats" ? (
        <AllChatsWorkspace
          projects={projects}
          filterProjectId={route.filterProjectId}
          preferences={preferences}
          onPreferences={onPreferences}
          onNavigate={onNavigate}
          onOpenInNewTab={onOpenInNewTab}
          onCreate={projectId =>
            projectId
              ? onCreateHomeChat(projectId)
              : onNavigate({ kind: "new", createKind: "chat" })
          }
        />
      ) : route.kind === "allTriggers" ? (
        <AllTriggersWorkspace
          projects={projects}
          preferences={preferences}
          onPreferences={onPreferences}
          onNavigate={onNavigate}
          onOpenInNewTab={onOpenInNewTab}
          onCreate={() => onNavigate({ kind: "new", createKind: "trigger" })}
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
            onManageProject={onManageProject}
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
