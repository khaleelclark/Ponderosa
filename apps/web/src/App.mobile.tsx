import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import MenuIcon from "@mui/icons-material/Menu";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import SearchIcon from "@mui/icons-material/Search";
import SettingsIcon from "@mui/icons-material/Settings";
import SpeedOutlinedIcon from "@mui/icons-material/SpeedOutlined";
import {
  AppBar,
  Badge,
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  SwipeableDrawer,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useState, type MouseEvent } from "react";
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
  const [overflowAnchor, setOverflowAnchor] = useState<HTMLElement>();
  const openOverflow = (event: MouseEvent<HTMLElement>) =>
    setOverflowAnchor(event.currentTarget);
  useEffect(() => {
    const close = () => setOverflowAnchor(undefined);
    window.addEventListener("ponderosa-mobile-workspace-action", close);
    return () =>
      window.removeEventListener("ponderosa-mobile-workspace-action", close);
  }, []);

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
        <Box sx={{ display: { xs: "none", sm: "block" } }}>
          <ProviderQuotaIndicator
            preferredProvider={preferredQuotaProvider}
            mobile
          />
        </Box>
        <Tooltip title="Notifications">
          <IconButton aria-label="Open notifications" onClick={onOpenNotifications}>
            <Badge color="primary" badgeContent={unreadNotifications}>
              <NotificationsOutlinedIcon />
            </Badge>
          </IconButton>
        </Tooltip>
        <Tooltip title="More">
          <IconButton
            aria-label="Open workspace actions"
            aria-haspopup="menu"
            aria-expanded={Boolean(overflowAnchor)}
            onClick={openOverflow}
          >
            <MoreVertIcon />
          </IconButton>
        </Tooltip>
      </Toolbar>
      <Menu
        anchorEl={overflowAnchor}
        open={Boolean(overflowAnchor)}
        onClose={() => setOverflowAnchor(undefined)}
        keepMounted
        slotProps={{
          paper: { sx: { minWidth: 260, maxWidth: "calc(100vw - 24px)" } },
        }}
      >
        <Box id="ponderosa-mobile-workspace-action-slot" />
        <MenuItem
          onClick={() => {
            setOverflowAnchor(undefined);
            onCreateProject();
          }}
        >
          <ListItemIcon><AddIcon /></ListItemIcon>
          <ListItemText>New Project</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            setOverflowAnchor(undefined);
            onOpenEngineStatus();
          }}
        >
          <ListItemIcon><SpeedOutlinedIcon /></ListItemIcon>
          <ListItemText
            primary="Provider Status"
            secondary={engineAvailability.label}
          />
        </MenuItem>
        <MenuItem
          onClick={() => {
            setOverflowAnchor(undefined);
            onOpenNavigation();
          }}
        >
          <ListItemIcon><SearchIcon /></ListItemIcon>
          <ListItemText>Browse Workspaces</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            setOverflowAnchor(undefined);
            onOpenProfile();
          }}
        >
          <ListItemIcon>
            {profile ? (
              <OperatorAvatar profile={profile} size={24} />
            ) : (
              <PersonOutlineIcon />
            )}
          </ListItemIcon>
          <ListItemText>Operator Profile</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            setOverflowAnchor(undefined);
            onOpenSettings();
          }}
        >
          <ListItemIcon><SettingsIcon /></ListItemIcon>
          <ListItemText>Settings</ListItemText>
        </MenuItem>
      </Menu>
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
