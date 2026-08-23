import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
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
  ListItemButton,
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
import { routeProjectId, type Route } from "./routing";
import { api } from "./api";
import { OperatorAvatar } from "./components/OperatorAvatar";
import { ProviderQuotaIndicator } from "./components/ProviderUsageCenter";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { useMobileWorkspaceActions } from "./components/MobileWorkspaceActionsContext";
import { workspaceHeaderSurfaceSx } from "./theme";

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

interface WorkspaceAppHeaderProps {
  preferredQuotaProvider?: string;
  engineAvailability: {
    label: string;
    severity: "success" | "warning" | "default";
    detail: string;
  };
  attentionNotifications: number;
  unreadNotificationUpdates: number;
  profile?: OperatorProfileDto;
  onOpenNavigation(): void;
  onOpenEngineStatus(): void;
  onOpenSearch(): void;
  onOpenNotifications(): void;
  onOpenProfile(): void;
  onOpenSettings(): void;
  onOpenProviderSettings(): void;
}

export function WorkspaceAppHeader({
  preferredQuotaProvider,
  engineAvailability,
  attentionNotifications,
  unreadNotificationUpdates,
  profile,
  onOpenNavigation,
  onOpenEngineStatus,
  onOpenSearch,
  onOpenNotifications,
  onOpenProfile,
  onOpenSettings,
  onOpenProviderSettings,
}: WorkspaceAppHeaderProps): JSX.Element {
  const [overflowAnchor, setOverflowAnchor] = useState<HTMLElement>();
  const mobileWorkspaceActions = useMobileWorkspaceActions();
  const openOverflow = (event: MouseEvent<HTMLElement>) =>
    setOverflowAnchor(event.currentTarget);
  const runWorkspaceAction = (
    event: MouseEvent<HTMLElement>,
    action: (anchor: HTMLElement) => void,
  ) => {
    setOverflowAnchor(undefined);
    action(event.currentTarget);
  };

  return (
    <AppBar
      position="static"
      color="inherit"
      elevation={0}
      sx={theme => ({
        ...workspaceHeaderSurfaceSx(theme),
        display: "block",
        borderBottom: 1,
        borderColor: "divider",
      })}
    >
      <Toolbar
        sx={{
          minHeight: { xs: 52, sm: 56 },
          px: { xs: 1.5, sm: 2.5, md: 3 },
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
            component="div"
            sx={{ fontWeight: 800, minWidth: 0 }}
            noWrap
          >
            Ponderosa
          </Typography>
        </Box>
        <Tooltip title="Search">
          <IconButton aria-label="Search Ponderosa" onClick={onOpenSearch}>
            <SearchIcon />
          </IconButton>
        </Tooltip>
        <ProviderQuotaIndicator
          preferredProvider={preferredQuotaProvider}
          onOpenProviderSettings={onOpenProviderSettings}
          mobile
          renderTrigger={openUsage => (
            <Tooltip title="Provider usage">
              <IconButton
                aria-label="Open provider usage"
                onClick={event => openUsage(event.currentTarget)}
              >
                <DataUsageOutlinedIcon />
              </IconButton>
            </Tooltip>
          )}
        />
        <Tooltip title={attentionNotifications
          ? `${attentionNotifications} ${attentionNotifications === 1 ? "item needs" : "items need"} attention`
          : unreadNotificationUpdates
            ? `${unreadNotificationUpdates} unread update${unreadNotificationUpdates === 1 ? "" : "s"}`
            : "Notifications"}>
          <IconButton
            aria-label={attentionNotifications
              ? `Open notifications, ${attentionNotifications} ${attentionNotifications === 1 ? "item needs" : "items need"} attention`
              : unreadNotificationUpdates
                ? `Open notifications, ${unreadNotificationUpdates} unread update${unreadNotificationUpdates === 1 ? "" : "s"}`
                : "Open notifications"}
            onClick={onOpenNotifications}
          >
            <Badge
              color={attentionNotifications ? "warning" : "success"}
              badgeContent={attentionNotifications || (unreadNotificationUpdates ? 1 : 0)}
              max={9}
              variant={attentionNotifications ? "standard" : "dot"}
              invisible={!attentionNotifications && !unreadNotificationUpdates}
            >
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
        {profile ? (
          <Tooltip title="Operator profile">
            <IconButton
              aria-label="Open operator profile"
              onClick={onOpenProfile}
              sx={{ display: { xs: "none", sm: "inline-flex" }, ml: 0.25 }}
            >
              <OperatorAvatar profile={profile} size={28} />
            </IconButton>
          </Tooltip>
        ) : null}
      </Toolbar>
      <Menu
        anchorEl={overflowAnchor}
        open={Boolean(overflowAnchor)}
        onClose={() => setOverflowAnchor(undefined)}
        keepMounted
        MenuListProps={{ "aria-label": "Workspace actions" }}
        slotProps={{
          paper: { sx: { minWidth: 260, maxWidth: "calc(100vw - 24px)" } },
        }}
      >
        {mobileWorkspaceActions ? (
          <Box sx={{ px: 2, pt: 1.25, pb: 0.5 }}>
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ lineHeight: 1.5 }}
            >
              {mobileWorkspaceActions.label}
            </Typography>
          </Box>
        ) : null}
        {mobileWorkspaceActions?.details ? (
          <MenuItem
            disabled={mobileWorkspaceActions.details.disabled}
            onClick={event =>
              runWorkspaceAction(
                event,
                mobileWorkspaceActions.details!.onSelect,
              )
            }
            sx={
              mobileWorkspaceActions.details.destructive
                ? { color: "error.main" }
                : undefined
            }
          >
            {mobileWorkspaceActions.details.icon ? (
              <ListItemIcon>
                {mobileWorkspaceActions.details.icon}
              </ListItemIcon>
            ) : null}
            <ListItemText>{mobileWorkspaceActions.details.label}</ListItemText>
          </MenuItem>
        ) : null}
        {mobileWorkspaceActions?.actions.map(action => (
          <MenuItem
            key={action.label}
            disabled={action.disabled}
            onClick={event =>
              runWorkspaceAction(event, action.onSelect)
            }
            sx={action.destructive ? { color: "error.main" } : undefined}
          >
            {action.icon ? (
              <ListItemIcon
                sx={action.destructive ? { color: "inherit" } : undefined}
              >
                {action.icon}
              </ListItemIcon>
            ) : null}
            <ListItemText>{action.label}</ListItemText>
          </MenuItem>
        ))}
        {mobileWorkspaceActions?.copy ? (
          <MenuItem
            onClick={event =>
              runWorkspaceAction(event, mobileWorkspaceActions.copy!.onSelect)
            }
          >
            <ListItemIcon>{mobileWorkspaceActions.copy.icon}</ListItemIcon>
            <ListItemText>{mobileWorkspaceActions.copy.label}</ListItemText>
            <ChevronRightIcon fontSize="small" />
          </MenuItem>
        ) : null}
        {mobileWorkspaceActions?.download ? (
          <MenuItem
            onClick={event =>
              runWorkspaceAction(
                event,
                mobileWorkspaceActions.download!.onSelect,
              )
            }
          >
            <ListItemIcon>{mobileWorkspaceActions.download.icon}</ListItemIcon>
            <ListItemText>{mobileWorkspaceActions.download.label}</ListItemText>
            <ChevronRightIcon fontSize="small" />
          </MenuItem>
        ) : null}
        {mobileWorkspaceActions ? <Divider /> : null}
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
      disableSwipeToOpen
      PaperProps={{
        sx: {
          width: routeProjectId(route) ? "min(100vw, 390px)" : 64,
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
            const switchingProject = next.kind === "project" &&
              next.projectId !== routeProjectId(route);
            if (!switchingProject) close();
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
          onDismiss={close}
        />
      </Box>
    </SwipeableDrawer>
  );
}
