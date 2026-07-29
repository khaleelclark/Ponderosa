import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
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
  Button,
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
import { useState, type MouseEvent } from "react";
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
import { WorkspaceRouteIcon } from "./components/WorkspaceTabs";
import type { WorkspaceTabState } from "./workspaceTabs";

interface MobileWorkspaceHeaderProps {
  title: string;
  route: Route;
  workspaceTabs: Array<WorkspaceTabState & { label: string }>;
  activeWorkspaceTabKey: string;
  preferredQuotaProvider?: string;
  engineAvailability: {
    label: string;
    severity: "success" | "warning" | "default";
    detail: string;
  };
  unreadNotifications: number;
  profile?: OperatorProfileDto;
  onOpenNavigation(): void;
  onActivateWorkspace(key: string): void;
  onCloseWorkspace(key: string): void;
  onOpenEngineStatus(): void;
  onOpenNotifications(): void;
  onCreateProject(): void;
  onOpenProfile(): void;
  onOpenSettings(): void;
}

export function MobileWorkspaceHeader({
  title,
  route,
  workspaceTabs,
  activeWorkspaceTabKey,
  preferredQuotaProvider,
  engineAvailability,
  unreadNotifications,
  profile,
  onOpenNavigation,
  onActivateWorkspace,
  onCloseWorkspace,
  onOpenEngineStatus,
  onOpenNotifications,
  onCreateProject,
  onOpenProfile,
  onOpenSettings,
}: MobileWorkspaceHeaderProps): JSX.Element {
  const [recentAnchor, setRecentAnchor] = useState<HTMLElement>();
  const [overflowAnchor, setOverflowAnchor] = useState<HTMLElement>();
  const openRecent = (event: MouseEvent<HTMLElement>) =>
    setRecentAnchor(event.currentTarget);
  const openOverflow = (event: MouseEvent<HTMLElement>) =>
    setOverflowAnchor(event.currentTarget);

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
          aria-hidden
          sx={{
            display: "grid",
            placeItems: "center",
            mr: 0.75,
            color: "text.secondary",
            flexShrink: 0,
          }}
        >
          <WorkspaceRouteIcon route={route} />
        </Box>
        <Box aria-label={title} sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="h6"
            component="h1"
            sx={{ fontWeight: 800, minWidth: 0 }}
            noWrap
          >
            {title}
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
      <Box sx={{ px: 1.5, pb: 1 }}>
        <Button
          fullWidth
          color="inherit"
          variant="outlined"
          aria-haspopup="menu"
          aria-expanded={Boolean(recentAnchor)}
          onClick={openRecent}
          endIcon={<KeyboardArrowDownIcon />}
          sx={{
            minHeight: 40,
            justifyContent: "space-between",
            borderColor: "divider",
            bgcolor: "background.paper",
            px: 1.5,
          }}
        >
          <Typography component="span" variant="body2" fontWeight={750} noWrap>
            Recent work · {title}
          </Typography>
        </Button>
      </Box>
      <Menu
        anchorEl={recentAnchor}
        open={Boolean(recentAnchor)}
        onClose={() => setRecentAnchor(undefined)}
        slotProps={{
          paper: {
            sx: {
              width: "min(calc(100vw - 24px), 420px)",
              maxHeight: "min(70dvh, 560px)",
            },
          },
        }}
      >
        {workspaceTabs.map(tab => (
          <MenuItem
            key={tab.key}
            selected={tab.key === activeWorkspaceTabKey}
            onClick={() => {
              setRecentAnchor(undefined);
              onActivateWorkspace(tab.key);
            }}
            sx={{ minHeight: 48, gap: 1 }}
          >
            <ListItemIcon>
              <WorkspaceRouteIcon route={tab.route} />
            </ListItemIcon>
            <ListItemText
              primary={tab.label}
              primaryTypographyProps={{ noWrap: true, fontWeight: 700 }}
            />
            {workspaceTabs.length > 1 ? (
              <IconButton
                size="small"
                aria-label={`Close ${tab.label}`}
                onClick={event => {
                  event.stopPropagation();
                  onCloseWorkspace(tab.key);
                  if (workspaceTabs.length <= 2)
                    setRecentAnchor(undefined);
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            ) : null}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        anchorEl={overflowAnchor}
        open={Boolean(overflowAnchor)}
        onClose={() => setOverflowAnchor(undefined)}
      >
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
