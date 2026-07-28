import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import MenuIcon from "@mui/icons-material/Menu";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import SettingsIcon from "@mui/icons-material/Settings";
import {
  AppBar,
  Badge,
  Box,
  Chip,
  IconButton,
  SwipeableDrawer,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  ConversationDto,
  OperatorProfileDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import type { Route } from "./routing";
import { OperatorAvatar } from "./components/OperatorAvatar";
import { ProviderQuotaIndicator } from "./components/ProviderUsageCenter";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";

interface MobileWorkspaceHeaderProps {
  appIconSource: string;
  preferredQuotaProvider?: string;
  engineAvailability: {
    label: string;
    severity: "success" | "warning" | "default";
    detail: string;
  };
  unreadNotifications: number;
  profile?: OperatorProfileDto;
  onOpenNavigation(): void;
  onOpenEngineStatus(): void;
  onOpenNotifications(): void;
  onCreateProject(): void;
  onOpenProfile(): void;
  onOpenSettings(): void;
}

export function MobileWorkspaceHeader({
  appIconSource,
  preferredQuotaProvider,
  engineAvailability,
  unreadNotifications,
  profile,
  onOpenNavigation,
  onOpenEngineStatus,
  onOpenNotifications,
  onCreateProject,
  onOpenProfile,
  onOpenSettings,
}: MobileWorkspaceHeaderProps): JSX.Element {
  return (
    <AppBar
      position="static"
      color="inherit"
      elevation={0}
      sx={{
        display: { xs: "block", md: "none" },
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Toolbar
        sx={{
          minHeight: { xs: 52, sm: 56 },
          px: { xs: 1.5, sm: 3 },
          pt: "env(safe-area-inset-top)",
        }}
      >
        <IconButton
          aria-label="Open workspace navigation"
          onClick={onOpenNavigation}
          sx={{ display: { xs: "inline-flex", md: "none" }, mr: 0.25 }}
        >
          <MenuIcon />
        </IconButton>
        <Box
          component="img"
          src={appIconSource}
          alt=""
          sx={{
            display: "block",
            width: { xs: 26, sm: 28 },
            height: { xs: 26, sm: 28 },
            mr: { xs: 0.75, sm: 1 },
            borderRadius: 1,
            objectFit: "contain",
            flexShrink: 0,
          }}
        />
        <Box aria-label="Ponderosa" sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="h6"
            component="h1"
            sx={{ fontWeight: 800, minWidth: 0 }}
            noWrap
          >
            Ponderosa
          </Typography>
        </Box>
        <ProviderQuotaIndicator preferredProvider={preferredQuotaProvider} mobile />
        <Tooltip
          title={`${engineAvailability.label}. Click for provider details.`}
          arrow
          enterTouchDelay={0}
        >
          <Chip
            size="small"
            label={engineAvailability.label}
            color={engineAvailability.severity}
            variant="outlined"
            tabIndex={0}
            aria-label={`${engineAvailability.label}. ${engineAvailability.detail}`}
            onClick={onOpenEngineStatus}
            sx={{
              maxWidth: { sm: 132, md: "none" },
              display: { xs: "none", sm: "inline-flex" },
              cursor: "pointer",
            }}
          />
        </Tooltip>
        <Tooltip title="Notifications">
          <IconButton aria-label="Open notifications" onClick={onOpenNotifications}>
            <Badge color="primary" badgeContent={unreadNotifications}>
              <NotificationsOutlinedIcon />
            </Badge>
          </IconButton>
        </Tooltip>
        <Tooltip title="New Project">
          <IconButton
            aria-label="New project"
            onClick={onCreateProject}
            sx={{ display: { xs: "none", sm: "inline-flex", md: "none" } }}
          >
            <AddIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Operator Profile">
          <IconButton
            aria-label="Open operator profile"
            onClick={onOpenProfile}
            sx={{ ml: 0.5, p: 0, width: 44, height: 44 }}
          >
            <OperatorAvatar profile={profile} size={32} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Settings">
          <IconButton
            aria-label="Open settings"
            onClick={onOpenSettings}
            sx={{ ml: 0.5 }}
          >
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}

interface MobileWorkspaceDrawerProps {
  open: boolean;
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  route: Route;
  notifications: WorkspaceNotificationDto[];
  onOpenChange(open: boolean): void;
  onNavigate(route: Route): void;
  onOpenInNewTab(route: Route): void;
  onCreate(kind: "project" | "chat" | "agent" | "trigger"): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onConversationAction(
    action: "rename" | "delete",
    conversation: ConversationDto,
  ): void;
  onSearch(): void;
}

export function MobileWorkspaceDrawer({
  open,
  projects,
  preferences,
  route,
  notifications,
  onOpenChange,
  onNavigate,
  onOpenInNewTab,
  onCreate,
  onPreferences,
  onConversationAction,
  onSearch,
}: MobileWorkspaceDrawerProps): JSX.Element {
  const close = () => onOpenChange(false);
  return (
    <SwipeableDrawer
      open={open}
      onOpen={() => onOpenChange(true)}
      onClose={close}
      disableDiscovery
      PaperProps={{
        sx: {
          width: "min(100vw, 390px)",
          maxWidth: "100vw",
          height: "100dvh",
          overflow: "hidden",
        },
      }}
    >
      <Box sx={{ position: "relative", height: "100%", minHeight: 0 }}>
        <Tooltip title="Close Navigation">
          <IconButton
            aria-label="Close workspace navigation"
            onClick={close}
            sx={{
              position: "absolute",
              zIndex: 4,
              top: "max(8px, env(safe-area-inset-top))",
              right: 8,
              bgcolor: "background.paper",
              boxShadow: 1,
            }}
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
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
          onOpenInNewTab={next => {
            close();
            onOpenInNewTab(next);
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
        />
      </Box>
    </SwipeableDrawer>
  );
}
