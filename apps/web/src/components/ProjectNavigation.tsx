import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CloseIcon from "@mui/icons-material/Close";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import SpeedOutlinedIcon from "@mui/icons-material/SpeedOutlined";
import {
  Badge,
  Box,
  ButtonBase,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  OperatorProfileDto,
  ProjectDto,
} from "@ponderosa/core";
import { useState, type MouseEvent, type ReactNode } from "react";
import type { Route } from "../routing";
import { OperatorAvatar } from "./OperatorAvatar";
import type { ProjectSidebarSection } from "./useWorkspaceSidebarState";
import {
  SIDEBAR_RAIL_WIDTH,
  railSurface,
} from "./WorkspaceSidebar.helpers";
import { RailButton } from "./WorkspaceSidebar.parts";

const PROJECT_COLORS = [
  "#315B49",
  "#4B536D",
  "#6A4F55",
  "#4D6040",
  "#5D4C72",
  "#3F5965",
  "#66543D",
];

function hashLabel(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function projectInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "P";
  if (words.length === 1) return words[0]!.slice(0, 2).toLocaleUpperCase();
  return `${words[0]![0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toLocaleUpperCase();
}

function ProjectRailButton({
  project,
  current,
  expanded,
  badge,
  onClick,
}: {
  project: ProjectDto;
  current: boolean;
  expanded: boolean;
  badge?: number;
  onClick(): void;
}): JSX.Element {
  const color = PROJECT_COLORS[hashLabel(project.id || project.label) % PROJECT_COLORS.length];
  return (
    <Tooltip title={project.label} placement="right">
      <ButtonBase
        aria-label={badge ? `${project.label}, ${badge} unread` : project.label}
        aria-current={current ? "page" : undefined}
        aria-expanded={expanded}
        onClick={onClick}
        sx={{
          position: "relative",
          width: 48,
          minWidth: 48,
          height: 48,
          borderRadius: current || expanded ? 1.5 : 2,
          bgcolor: current ? "primary.main" : expanded ? "action.selected" : color,
          outline: expanded && !current ? "2px solid" : "none",
          outlineColor: "primary.main",
          color: "#F5F7F5",
          fontSize: 12,
          fontWeight: 850,
          letterSpacing: ".02em",
          transition: "border-radius 140ms ease, transform 140ms ease, background-color 140ms ease",
          "&:hover": {
            borderRadius: 1.5,
            transform: "translateY(-1px)",
            filter: "brightness(1.12)",
          },
          "&::before": current
            ? {
                content: '\"\"',
                position: "absolute",
                left: -12,
                width: 4,
                height: 30,
                borderRadius: "0 6px 6px 0",
                bgcolor: "text.primary",
              }
            : undefined,
        }}
      >
        <Badge
          color="error"
          badgeContent={badge}
          max={99}
          invisible={!badge}
          slotProps={{ badge: { "aria-hidden": true } }}
          sx={{
            "& .MuiBadge-badge": {
              border: `3px solid ${railSurface}`,
              fontWeight: 850,
            },
          }}
        >
          <span>{projectInitials(project.label)}</span>
        </Badge>
      </ButtonBase>
    </Tooltip>
  );
}

export function ProjectRail({
  drawer,
  projects,
  activeProjectId,
  currentProjectId,
  route,
  profile,
  unreadMessages,
  attentionNotifications,
  unreadNotificationUpdates,
  projectBadgeCounts,
  onOpenHome,
  onOpenAllMessages,
  onOpenProject,
  onOpenCreate,
  onOpenSearch,
  onOpenNotifications,
  onOpenUsage,
  onOpenEngineStatus,
  onOpenSettings,
  onOpenProfile,
  onClose,
}: {
  drawer: boolean;
  projects: ProjectDto[];
  activeProjectId?: string;
  currentProjectId?: string;
  route: Route;
  profile: OperatorProfileDto;
  unreadMessages: number;
  attentionNotifications: number;
  unreadNotificationUpdates: number;
  projectBadgeCounts: ReadonlyMap<string, number>;
  onOpenHome(): void;
  onOpenAllMessages(): void;
  onOpenProject(project: ProjectDto): void;
  onOpenCreate(): void;
  onOpenSearch(): void;
  onOpenNotifications(): void;
  onOpenUsage(): void;
  onOpenEngineStatus(): void;
  onOpenSettings(): void;
  onOpenProfile(): void;
  onClose?(): void;
}): JSX.Element {
  const railWidth = drawer ? 64 : SIDEBAR_RAIL_WIDTH;
  const [operatorAnchor, setOperatorAnchor] = useState<HTMLElement>();
  const runOperatorAction = (action: () => void) => {
    setOperatorAnchor(undefined);
    action();
  };
  return (
    <Box
      component="nav"
      aria-label={drawer ? "Project navigation drawer" : "Project navigation"}
      sx={{
        width: railWidth,
        minWidth: railWidth,
        height: "100%",
        minHeight: 0,
        borderRight: 1,
        borderColor: "var(--ponderosa-rail-border)",
        bgcolor: railSurface,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        justifyItems: "center",
        py: 1.5,
      }}
    >
      <Stack spacing={0.6} sx={{ alignItems: "center" }}>
        {drawer && onClose ? (
          <Tooltip title="Close navigation" placement="right">
            <IconButton aria-label="Close workspace navigation" onClick={onClose} sx={{ width: 42, height: 42, mb: 1.5 }}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip title="Home" placement="right">
          <ButtonBase
            aria-label="Home"
            aria-current={route.kind === "home" ? "page" : undefined}
            onClick={onOpenHome}
            sx={{
              width: 48,
              height: 48,
              mb: 1.1,
              borderRadius: 1.5,
              bgcolor: route.kind === "home" ? "action.selected" : "transparent",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Box component="img" src="/icons/app-icon.png" alt="" sx={{ width: 42, height: 42, p: 0.25, borderRadius: 1, objectFit: "cover" }} />
          </ButtonBase>
        </Tooltip>
        <RailButton
          label="All Messages"
          selected={route.kind === "allChat"}
          badge={unreadMessages || undefined}
          badgeColor="error"
          onClick={onOpenAllMessages}
        >
          <ForumOutlinedIcon />
        </RailButton>
        <Box aria-hidden sx={{ width: 32, borderTop: 1, borderColor: "var(--ponderosa-rail-border)", my: 0.25 }} />
      </Stack>

      <Stack
        className="ponderosa-scroll"
        spacing={0.8}
        sx={{
          width: "100%",
          minHeight: 0,
          alignItems: "center",
          overflowX: "hidden",
          overflowY: "auto",
          py: 0.5,
          scrollbarWidth: "none",
          "&::-webkit-scrollbar": { display: "none" },
        }}
      >
        {projects.map(project => (
          <ProjectRailButton
            key={project.id}
            project={project}
            current={project.id === currentProjectId}
            expanded={project.id === activeProjectId}
            badge={projectBadgeCounts.get(project.id)}
            onClick={() => onOpenProject(project)}
          />
        ))}
      </Stack>

      <Stack spacing={0.55} sx={{ alignItems: "center" }}>
        <RailButton label="Create" selected={route.kind === "create"} onClick={onOpenCreate}>
          <AddIcon />
        </RailButton>
        <Box aria-hidden sx={{ width: 32, borderTop: 1, borderColor: "var(--ponderosa-rail-border)", my: 0.25 }} />
        <RailButton label="Search" selected={false} onClick={onOpenSearch}>
          <SearchIcon />
        </RailButton>
        <RailButton
          label="Notifications"
          selected={false}
          badge={attentionNotifications || (unreadNotificationUpdates ? 1 : undefined)}
          badgeColor={attentionNotifications ? "error" : "primary"}
          onClick={onOpenNotifications}
        >
          <NotificationsOutlinedIcon />
        </RailButton>
        <RailButton label="Settings" selected={route.kind === "settings" || route.kind === "usage"} onClick={onOpenSettings}>
          <SettingsOutlinedIcon />
        </RailButton>
        <Tooltip title={profile.displayName || "Operator profile"} placement="right">
          <IconButton
            aria-label="Open operator profile"
            aria-current={route.kind === "profile" ? "page" : undefined}
            aria-haspopup="menu"
            aria-expanded={Boolean(operatorAnchor)}
            onClick={event => setOperatorAnchor(event.currentTarget)}
            sx={{ width: 48, height: 48, borderRadius: 1.5 }}
          >
            <OperatorAvatar profile={profile} size={34} />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={operatorAnchor}
          open={Boolean(operatorAnchor)}
          onClose={() => setOperatorAnchor(undefined)}
          anchorOrigin={{ vertical: "top", horizontal: "right" }}
          transformOrigin={{ vertical: "bottom", horizontal: "left" }}
          slotProps={{ paper: { sx: { minWidth: 230, ml: 1 } } }}
        >
          <MenuItem onClick={() => runOperatorAction(onOpenProfile)}>
            <ListItemIcon><PersonOutlineIcon /></ListItemIcon>
            <ListItemText>Operator Profile</ListItemText>
          </MenuItem>
          <MenuItem onClick={() => runOperatorAction(onOpenUsage)}>
            <ListItemIcon><DataUsageOutlinedIcon /></ListItemIcon>
            <ListItemText>Provider Usage</ListItemText>
          </MenuItem>
          <MenuItem onClick={() => runOperatorAction(onOpenEngineStatus)}>
            <ListItemIcon><SpeedOutlinedIcon /></ListItemIcon>
            <ListItemText>Provider Status</ListItemText>
          </MenuItem>
          <MenuItem onClick={() => runOperatorAction(onOpenSettings)}>
            <ListItemIcon><SettingsOutlinedIcon /></ListItemIcon>
            <ListItemText>Settings</ListItemText>
          </MenuItem>
        </Menu>
      </Stack>
    </Box>
  );
}

const PROJECT_MODES: Array<{
  id: ProjectSidebarSection;
  label: string;
  icon: ReactNode;
}> = [
  { id: "overview", label: "Overview", icon: <HomeOutlinedIcon fontSize="small" /> },
  { id: "chats", label: "Chats", icon: <ChatBubbleOutlineIcon fontSize="small" /> },
  { id: "agents", label: "Agents", icon: <SmartToyOutlinedIcon fontSize="small" /> },
  { id: "triggers", label: "Automations", icon: <BoltOutlinedIcon fontSize="small" /> },
];

export function ProjectSidebarHeader({
  project,
  section,
  counts,
  runningCount,
  unreadCount,
  drawer,
  onSectionChange,
  onOpenBrowser,
  onRename,
  onOpenSettings,
}: {
  project: ProjectDto;
  section: ProjectSidebarSection;
  counts: { chats?: number; agents?: number; triggers?: number };
  runningCount?: number;
  unreadCount: number;
  drawer: boolean;
  onSectionChange(section: ProjectSidebarSection): void;
  onOpenBrowser(): void;
  onRename(): void;
  onOpenSettings(): void;
}): JSX.Element {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const openMenu = (event: MouseEvent<HTMLElement>) => setMenuAnchor(event.currentTarget);
  const run = (action: () => void) => {
    setMenuAnchor(undefined);
    action();
  };
  return (
    <Box sx={{ pt: 1.75, pb: 1, pr: drawer ? 6 : 0 }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", px: 2 }}>
        <Box
          aria-hidden
          sx={{
            width: 38,
            height: 38,
            borderRadius: 1.5,
            display: "grid",
            placeItems: "center",
            bgcolor: PROJECT_COLORS[hashLabel(project.id) % PROJECT_COLORS.length],
            color: "#F5F7F5",
            fontSize: 11,
            fontWeight: 850,
          }}
        >
          {projectInitials(project.label)}
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography fontWeight={800} noWrap>{project.label}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {runningCount == null ? "Checking activity" : `${runningCount} active`} · {unreadCount} unread
          </Typography>
        </Box>
        <IconButton
          aria-label={`Actions for ${project.label}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAnchor)}
          onClick={openMenu}
        >
          <MoreVertIcon />
        </IconButton>
      </Stack>
      <Box
        component="nav"
        aria-label={`${project.label} navigation`}
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 0.5,
          mx: 1.25,
          mt: 1.5,
          p: 0.5,
          borderRadius: 1.5,
          bgcolor: "rgba(5, 15, 11, .28)",
        }}
      >
        {PROJECT_MODES.map(mode => {
          const count = mode.id === "chats"
            ? counts.chats
            : mode.id === "agents"
              ? counts.agents
              : mode.id === "triggers"
                ? counts.triggers
                : undefined;
          return (
            <ButtonBase
              key={mode.id}
              aria-pressed={section === mode.id}
              onClick={() => onSectionChange(mode.id)}
              sx={{
                minWidth: 0,
                minHeight: 52,
                px: 0.5,
                py: 0.6,
                borderRadius: 1.1,
                display: "flex",
                flexDirection: "column",
                gap: 0.25,
                color: section === mode.id ? "primary.main" : "text.secondary",
                bgcolor: section === mode.id ? "rgba(124, 200, 145, .10)" : "transparent",
                "&:hover": { bgcolor: section === mode.id ? "rgba(124, 200, 145, .14)" : "action.hover", color: "text.primary" },
              }}
            >
              {mode.icon}
              <Typography
                component="span"
                sx={{
                  maxWidth: "100%",
                  fontSize: mode.id === "triggers" ? 8.75 : 9.5,
                  letterSpacing: mode.id === "triggers" ? "-.025em" : undefined,
                  fontWeight: 700,
                }}
                noWrap
              >
                {mode.label}
              </Typography>
              {count == null ? null : (
                <Typography component="span" sx={{ fontSize: 9, color: "text.disabled" }}>
                  {count}
                </Typography>
              )}
            </ButtonBase>
          );
        })}
      </Box>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(undefined)}>
        <MenuItem onClick={() => run(onOpenBrowser)}>
          <LanguageIcon fontSize="small" sx={{ mr: 1.25 }} /> Project Browser
        </MenuItem>
        <MenuItem onClick={() => run(onRename)}>
          <FolderOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} /> Rename Project
        </MenuItem>
        <MenuItem onClick={() => run(onOpenSettings)}>
          <SettingsOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} /> Project Settings
        </MenuItem>
      </Menu>
    </Box>
  );
}
