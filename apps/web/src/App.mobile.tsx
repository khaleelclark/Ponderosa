import { Box, SwipeableDrawer } from "@mui/material";
import type {
  ConversationDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { routeProjectId, type Route } from "./routing";

export function mobileRouteAfterResourceRemoval(
  current: Route,
  removed: Route,
): Route | undefined {
  if (removed.kind === "project") {
    return routeProjectId(current) === removed.projectId
      ? { kind: "projects" }
      : undefined;
  }
  if (
    removed.kind === "conversation" &&
    current.kind === "conversation" &&
    current.projectId === removed.projectId &&
    current.conversationId === removed.conversationId
  ) {
    return { kind: "project", projectId: removed.projectId };
  }
  if (
    removed.kind === "agent" && current.kind === "agent" &&
    current.projectId === removed.projectId && current.agentId === removed.agentId
  ) {
    return { kind: "agents", projectId: removed.projectId };
  }
  return undefined;
}

interface MobileWorkspaceDrawerProps {
  open: boolean;
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  route: Route;
  notifications: WorkspaceNotificationDto[];
  onOpenChange(open: boolean): void;
  onNavigate(route: Route): void;
  onCreate(kind: "project" | "chat" | "agent" | "trigger"): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onConversationAction(
    action: "rename" | "delete",
    conversation: ConversationDto,
  ): void;
  onSearch(): void;
  onOpenNotifications(): void;
  onOpenEngineStatus(): void;
}

export function MobileWorkspaceDrawer({
  open,
  projects,
  preferences,
  route,
  notifications,
  onOpenChange,
  onNavigate,
  onCreate,
  onPreferences,
  onConversationAction,
  onSearch,
  onOpenNotifications,
  onOpenEngineStatus,
}: MobileWorkspaceDrawerProps): JSX.Element {
  const close = () => onOpenChange(false);
  return (
    <SwipeableDrawer
      open={open}
      onOpen={() => onOpenChange(true)}
      onClose={close}
      disableDiscovery
      swipeAreaWidth={8}
      PaperProps={{
        sx: {
          width: "auto",
          maxWidth: "100vw",
          height: "100dvh",
          overflow: "hidden",
          transition: "width 180ms cubic-bezier(0.2, 0, 0, 1)",
        },
      }}
    >
      <Box sx={{ position: "relative", height: "100%", minHeight: 0 }}>
        <WorkspaceSidebar
          drawer
          projects={projects}
          preferences={preferences}
          route={route}
          notifications={notifications}
          onNavigate={next => {
            close();
            onNavigate(next);
          }}
          onCreate={kind => {
            close();
            onCreate(kind);
          }}
          onPreferences={onPreferences}
          onRenameConversation={conversation => {
            close();
            onConversationAction("rename", conversation);
          }}
          onDeleteConversation={conversation => {
            close();
            onConversationAction("delete", conversation);
          }}
          onSearch={() => {
            close();
            onSearch();
          }}
          onOpenNotifications={() => {
            close();
            onOpenNotifications();
          }}
          onOpenEngineStatus={() => {
            close();
            onOpenEngineStatus();
          }}
          onDismiss={close}
        />
      </Box>
    </SwipeableDrawer>
  );
}
