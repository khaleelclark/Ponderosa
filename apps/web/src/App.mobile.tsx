import { Box, SwipeableDrawer } from "@mui/material";
import type {
  ConversationDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspaceNotificationPageDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { type Route } from "./routing";

interface MobileWorkspaceDrawerProps {
  open: boolean;
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  route: Route;
  notifications: WorkspaceNotificationDto[];
  notificationCounts?: Pick<WorkspaceNotificationPageDto, "unacknowledgedActionCount" | "unreadUpdateCount">;
  creating?: "project" | "chat" | "agent" | "trigger";
  onOpenChange(open: boolean): void;
  onNavigate(route: Route): void;
  onCreate(
    kind: "project" | "chat" | "agent" | "trigger",
    context?: {
      projectId?: string;
      conversationId?: string;
      managerAgentId?: string;
      agentId?: string;
    },
  ): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onConversationAction(
    action: "rename" | "delete",
    conversation: ConversationDto,
  ): void;
  onProjectDeleted(projectId: string): void;
  onSearch(): void;
  onOpenNotifications(): void;
}

export function MobileWorkspaceDrawer({
  open,
  projects,
  preferences,
  route,
  notifications,
  notificationCounts,
  creating,
  onOpenChange,
  onNavigate,
  onCreate,
  onPreferences,
  onConversationAction,
  onProjectDeleted,
  onSearch,
  onOpenNotifications,
}: MobileWorkspaceDrawerProps): JSX.Element {
  const close = () => onOpenChange(false);
  return (
    <SwipeableDrawer
      open={open}
      onOpen={() => onOpenChange(true)}
      onClose={close}
      disableDiscovery
      // MUI disables opening on iOS by default; reserve only the edge strip,
      // and keep native horizontal history gestures from claiming that strip.
      disableSwipeToOpen={false}
      swipeAreaWidth={24}
      SwipeAreaProps={{ style: { touchAction: "pan-y" } }}
      hysteresis={0.25}
      ModalProps={{ disableRestoreFocus: true }}
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
          notificationCounts={notificationCounts}
          creating={creating}
          onNavigate={next => {
            close();
            onNavigate(next);
          }}
          onCreate={(kind, context) => {
            close();
            onCreate(kind, context);
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
          onProjectDeleted={projectId => {
            close();
            onProjectDeleted(projectId);
          }}
          onSearch={() => {
            close();
            onSearch();
          }}
          onOpenNotifications={() => {
            close();
            onOpenNotifications();
          }}
          onDismiss={close}
        />
      </Box>
    </SwipeableDrawer>
  );
}
