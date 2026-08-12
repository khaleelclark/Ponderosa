import CloseIcon from "@mui/icons-material/Close";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import SearchIcon from "@mui/icons-material/Search";
import SettingsIcon from "@mui/icons-material/Settings";
import SpeedOutlinedIcon from "@mui/icons-material/SpeedOutlined";
import TabOutlinedIcon from "@mui/icons-material/TabOutlined";
import {
  AppBar,
  Badge,
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
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
import { WorkspaceRouteIcon } from "./components/WorkspaceTabs";
import { queryKeys } from "./queryKeys";
import { routeTabLabel } from "./routeRegistry";
import type { WorkspaceTabState } from "./workspaceTabs";
import { useQueries } from "@tanstack/react-query";

export function mobileCreationReturnRoute(
  origins: ReadonlyMap<string, Route>,
  activeTabKey: string,
): Route {
  return origins.get(activeTabKey) ?? { kind: "home" };
}

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

interface MobileWorkspaceHeaderProps {
  tabs: WorkspaceTabState[];
  projects: ProjectDto[];
  activeTabKey: string;
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
  onActivateTab(key: string): void;
  onCloseTab(key: string): void;
}

export function MobileWorkspaceTabManager({
  open,
  tabs,
  projects,
  activeKey,
  onClose,
  onActivate,
  onCloseTab,
}: {
  open: boolean;
  tabs: WorkspaceTabState[];
  projects: ProjectDto[];
  activeKey: string;
  onClose(): void;
  onActivate(key: string): void;
  onCloseTab(key: string): void;
}): JSX.Element {
  const conversationProjectIds = [
    ...new Set(
      tabs.flatMap(tab =>
        tab.route.kind === "conversation"
          ? [tab.route.projectId]
          : [],
      ),
    ),
  ];
  const agentProjectIds = [
    ...new Set(
      tabs.flatMap(tab =>
        tab.route.kind === "agent" ? [tab.route.projectId] : [],
      ),
    ),
  ];
  const conversationQueries = useQueries({
    queries: conversationProjectIds.map(projectId => ({
      queryKey: queryKeys.conversations.project(projectId),
      queryFn: () => api.listConversations(projectId),
      enabled: open,
      staleTime: 10_000,
    })),
  });
  const agentQueries = useQueries({
    queries: agentProjectIds.map(projectId => ({
      queryKey: queryKeys.agents.project(projectId),
      queryFn: () => api.listAgents(projectId),
      enabled: open,
      staleTime: 10_000,
    })),
  });
  const conversationsByProject = new Map(
    conversationProjectIds.map((projectId, index) => [
      projectId,
      conversationQueries[index]?.data ?? [],
    ]),
  );
  const agentsByProject = new Map(
    agentProjectIds.map((projectId, index) => [
      projectId,
      agentQueries[index]?.data ?? [],
    ]),
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="mobile-workspace-tabs-title"
      slotProps={{
        paper: {
          sx: {
            m: { xs: 1.5, sm: 3 },
            width: { xs: "calc(100% - 24px)", sm: "100%" },
            maxHeight: "calc(100dvh - 24px)",
          },
        },
      }}
    >
      <DialogTitle
        id="mobile-workspace-tabs-title"
        sx={{ display: "flex", alignItems: "center", gap: 1, pr: 1 }}
      >
        <TabOutlinedIcon />
        <Box component="span" sx={{ flex: 1 }}>Open tabs</Box>
        <IconButton aria-label="Close open tabs" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <List disablePadding aria-label="Open workspace tabs">
          {tabs.map(tab => {
            const projectId =
              "projectId" in tab.route &&
              typeof tab.route.projectId === "string"
                ? tab.route.projectId
                : undefined;
            const project = projectId
              ? projects.find(candidate => candidate.id === projectId)
              : undefined;
            const label = tab.title ?? routeTabLabel(tab.route, {
              conversationTitle: conversationId =>
                conversationsByProject.get(projectId ?? "")?.find(
                  conversation => conversation.id === conversationId,
                )?.title,
              agentTitle: agentId =>
                agentsByProject.get(projectId ?? "")?.find(
                  agent => agent.id === agentId,
                )?.title,
              projectLabel: project?.label,
            });
            const selected = tab.key === activeKey;
            return (
              <ListItem
                key={tab.key}
                disablePadding
                secondaryAction={
                  tabs.length > 1 ? (
                    <IconButton
                      edge="end"
                      aria-label={`Close ${label}`}
                      onClick={() => onCloseTab(tab.key)}
                      sx={{ width: 44, height: 44 }}
                    >
                      <CloseIcon />
                    </IconButton>
                  ) : null
                }
                sx={{ pr: tabs.length > 1 ? 7 : 0 }}
              >
                <ListItemButton
                  selected={selected}
                  onClick={() => onActivate(tab.key)}
                  sx={{ minHeight: 56 }}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    <WorkspaceRouteIcon route={tab.route} />
                  </ListItemIcon>
                  <ListItemText
                    primary={label}
                    secondary={[
                      project?.label,
                      selected ? "Current tab" : undefined,
                    ].filter(Boolean).join(" · ") || "Ponderosa"}
                    slotProps={{
                      primary: { noWrap: true },
                      secondary: { noWrap: true },
                    }}
                  />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      </DialogContent>
    </Dialog>
  );
}

export function MobileWorkspaceHeader({
  tabs,
  projects,
  activeTabKey,
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
  onActivateTab,
  onCloseTab,
}: MobileWorkspaceHeaderProps): JSX.Element {
  const [overflowAnchor, setOverflowAnchor] = useState<HTMLElement>();
  const [tabManagerOpen, setTabManagerOpen] = useState(false);
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
            setTabManagerOpen(true);
          }}
        >
          <ListItemIcon><TabOutlinedIcon /></ListItemIcon>
          <ListItemText
            primary="Open tabs"
            secondary={`${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`}
          />
        </MenuItem>
        <Divider />
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
      <MobileWorkspaceTabManager
        open={tabManagerOpen}
        tabs={tabs}
        projects={projects}
        activeKey={activeTabKey}
        onClose={() => setTabManagerOpen(false)}
        onActivate={key => {
          setTabManagerOpen(false);
          onActivateTab(key);
        }}
        onCloseTab={onCloseTab}
      />
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
  onOpenInNewTab?(route: Route): void;
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
      disableSwipeToOpen
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
