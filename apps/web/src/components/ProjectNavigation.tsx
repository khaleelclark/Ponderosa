import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import CloseIcon from "@mui/icons-material/Close";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
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
import {
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Route } from "../routing";
import type { UnreadNotificationProjection } from "../workspaceNavigation";
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
  unread,
  dragging,
  dropPosition,
  onClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  project: ProjectDto;
  current: boolean;
  expanded: boolean;
  unread?: UnreadNotificationProjection;
  dragging: boolean;
  dropPosition?: "before" | "after";
  onClick(): void;
  onDragStart(event: DragEvent<HTMLButtonElement>): void;
  onDragEnd(): void;
  onDragOver(event: DragEvent<HTMLButtonElement>): void;
  onDrop(event: DragEvent<HTMLButtonElement>): void;
}): JSX.Element {
  const color = PROJECT_COLORS[hashLabel(project.id || project.label) % PROJECT_COLORS.length];
  return (
    <Tooltip title={project.label} placement="right">
      <ButtonBase
        aria-label={`${project.label}${unread?.importantCount ? `, ${unread.importantCount} important unread` : ""}${unread?.ordinaryCount ? `, ${unread.ordinaryCount} ordinary unread` : ""}`}
        aria-current={current ? "page" : undefined}
        aria-expanded={expanded}
        draggable
        onClick={onClick}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
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
          opacity: dragging ? 0.45 : 1,
          transition: "border-radius 140ms ease, transform 140ms ease, background-color 140ms ease, opacity 140ms ease",
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
          "&::after": dropPosition
            ? {
                content: '\"\"',
                position: "absolute",
                left: 6,
                right: 6,
                [dropPosition === "before" ? "top" : "bottom"]: -6,
                height: 3,
                borderRadius: 999,
                bgcolor: "primary.main",
              }
            : undefined,
        }}
      >
        <Badge
          color={unread?.importantCount ? "error" : "default"}
          badgeContent={unread?.importantCount || undefined}
          max={99}
          variant={!unread?.importantCount && unread?.ordinaryCount ? "dot" : "standard"}
          invisible={!unread?.totalCount}
          slotProps={{ badge: { "aria-hidden": true } }}
          sx={{
            "& .MuiBadge-badge": {
              border: `3px solid ${railSurface}`,
              fontWeight: 850,
              color: "#fff",
            },
          }}
        >
          <span>{projectInitials(project.label)}</span>
        </Badge>
        {unread?.importantCount && unread.ordinaryCount ? (
          <Box
            component="span"
            aria-hidden
            sx={{ position: "absolute", right: 3, bottom: 3, width: 8, height: 8, borderRadius: "50%", bgcolor: "text.secondary", border: `2px solid ${railSurface}` }}
          />
        ) : null}
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
  allMessagesUnread,
  attentionNotifications,
  unreadNotificationUpdates,
  projectUnread,
  onReorderProject,
  onOpenHome,
  onOpenAllMessages,
  onOpenProject,
  onOpenCreate,
  createProjectOpen = false,
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
  allMessagesUnread: UnreadNotificationProjection;
  attentionNotifications: number;
  unreadNotificationUpdates: number;
  projectUnread: ReadonlyMap<string, UnreadNotificationProjection>;
  onReorderProject(
    sourceProjectId: string,
    targetProjectId: string,
    position: "before" | "after",
  ): void;
  onOpenHome(): void;
  onOpenAllMessages(): void;
  onOpenProject(project: ProjectDto): void;
  onOpenCreate(): void;
  createProjectOpen?: boolean;
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
  const [draggedProjectId, setDraggedProjectId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{
    projectId: string;
    position: "before" | "after";
  }>();
  const suppressProjectClick = useRef<string>();
  const finishProjectDrag = (projectId: string) => {
    setDraggedProjectId(undefined);
    setDropTarget(undefined);
    window.setTimeout(() => {
      if (suppressProjectClick.current === projectId) {
        suppressProjectClick.current = undefined;
      }
    }, 0);
  };
  const closeOperatorMenu = () => {
    const trigger = operatorAnchor;
    setOperatorAnchor(undefined);
    window.requestAnimationFrame(() => trigger?.isConnected && trigger.focus());
  };
  const runOperatorAction = (action: () => void) => {
    const trigger = operatorAnchor;
    setOperatorAnchor(undefined);
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      action();
    });
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
          badge={allMessagesUnread.importantCount || undefined}
          dot={Boolean(allMessagesUnread.ordinaryCount)}
          badgeColor={allMessagesUnread.importantCount ? "error" : "default"}
          badgeStatus={`${allMessagesUnread.importantCount} important unread${allMessagesUnread.ordinaryCount ? `, ${allMessagesUnread.ordinaryCount} ordinary unread` : ""}`}
          dotStatus={`${allMessagesUnread.ordinaryCount} ordinary unread`}
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
            unread={projectUnread.get(project.id)}
            dragging={project.id === draggedProjectId}
            dropPosition={
              dropTarget?.projectId === project.id
                ? dropTarget.position
                : undefined
            }
            onClick={() => {
              if (suppressProjectClick.current === project.id) return;
              onOpenProject(project);
            }}
            onDragStart={event => {
              suppressProjectClick.current = project.id;
              setDraggedProjectId(project.id);
              setDropTarget(undefined);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", project.id);
            }}
            onDragEnd={() => finishProjectDrag(project.id)}
            onDragOver={event => {
              if (!draggedProjectId || draggedProjectId === project.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const bounds = event.currentTarget.getBoundingClientRect();
              setDropTarget({
                projectId: project.id,
                position: event.clientY >= bounds.top + bounds.height / 2
                  ? "after"
                  : "before",
              });
            }}
            onDrop={event => {
              event.preventDefault();
              if (!draggedProjectId || draggedProjectId === project.id) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              onReorderProject(
                draggedProjectId,
                project.id,
                event.clientY >= bounds.top + bounds.height / 2
                  ? "after"
                  : "before",
              );
              setDraggedProjectId(undefined);
              setDropTarget(undefined);
            }}
          />
        ))}
      </Stack>

      <Stack spacing={0.55} sx={{ alignItems: "center" }}>
        <RailButton label="Create Project" selected={createProjectOpen || (route.kind === "create" && route.resource === "project")} onClick={onOpenCreate}>
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
          onClose={closeOperatorMenu}
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
            <ListItemText>Provider Activity</ListItemText>
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
  { id: "chats", label: "Chats", icon: <ChatBubbleOutlineIcon fontSize="small" /> },
  { id: "agents", label: "Agents", icon: <SmartToyOutlinedIcon fontSize="small" /> },
  { id: "triggers", label: "Automations", icon: <BoltOutlinedIcon fontSize="small" /> },
];

export function ProjectSidebarHeader({
  project,
  overviewActive,
  section,
  counts,
  runningCount,
  unreadCount,
  drawer,
  onSectionChange,
  onOpenOverview,
  onOpenBrowser,
  onRename,
  onOpenSettings,
  onDelete,
}: {
  project: ProjectDto;
  overviewActive: boolean;
  section: ProjectSidebarSection;
  counts: { chats?: number; agents?: number; triggers?: number };
  runningCount?: number;
  unreadCount: number;
  drawer: boolean;
  onSectionChange(section: ProjectSidebarSection): void;
  onOpenOverview(): void;
  onOpenBrowser(): void;
  onRename(): void;
  onOpenSettings(): void;
  onDelete(): void;
}): JSX.Element {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const openMenu = (event: MouseEvent<HTMLElement>) => setMenuAnchor(event.currentTarget);
  const closeMenu = () => {
    const trigger = menuAnchor;
    setMenuAnchor(undefined);
    window.requestAnimationFrame(() => trigger?.isConnected && trigger.focus());
  };
  const run = (action: () => void) => {
    const trigger = menuAnchor;
    setMenuAnchor(undefined);
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      action();
    });
  };
  return (
    <Box sx={{ pt: 1.75, pb: 1, pr: drawer ? 6 : 0 }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", px: 2 }}>
        <Tooltip title="Open Project Overview" placement="bottom-start">
          <ButtonBase
            aria-label={`Open ${project.label} Project Overview`}
            aria-current={overviewActive ? "page" : undefined}
            onClick={onOpenOverview}
            sx={{
              minWidth: 0,
              flex: 1,
              justifyContent: "flex-start",
              gap: 1.25,
              mx: -0.75,
              px: 0.75,
              py: 0.5,
              borderRadius: 1.5,
              textAlign: "left",
              bgcolor: overviewActive ? "action.selected" : "transparent",
              "&:hover": {
                bgcolor: overviewActive ? "action.selected" : "action.hover",
              },
              "&:focus-visible": {
                outline: "2px solid",
                outlineColor: "primary.main",
                outlineOffset: 2,
              },
            }}
          >
            <Box
              aria-hidden
              sx={{
                width: 38,
                height: 38,
                flex: "0 0 38px",
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
            <ChevronRightRoundedIcon
              aria-hidden
              fontSize="small"
              sx={{ color: "text.secondary", flex: "0 0 auto" }}
            />
          </ButtonBase>
        </Tooltip>
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
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
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
              data-project-section={mode.id}
              aria-pressed={section === mode.id}
              onClick={() => {
                onSectionChange(mode.id);
                window.requestAnimationFrame(() => {
                  const visibleTarget = Array.from(
                    document.querySelectorAll<HTMLElement>(
                      `[data-project-section="${mode.id}"]`,
                    ),
                  ).find(candidate => (
                    candidate.getClientRects().length > 0 &&
                    !candidate.closest('[aria-hidden="true"]')
                  ));
                  visibleTarget?.focus();
                });
              }}
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
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        <MenuItem onClick={() => run(onOpenBrowser)}>
          <LanguageIcon fontSize="small" sx={{ mr: 1.25 }} /> Project Browser
        </MenuItem>
        <MenuItem onClick={() => run(onRename)}>
          <FolderOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} /> Rename Project
        </MenuItem>
        <MenuItem onClick={() => run(onOpenSettings)}>
          <SettingsOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} /> Project Settings
        </MenuItem>
        <MenuItem onClick={() => run(onDelete)} sx={{ color: "error.main" }}>
          <DeleteOutlineIcon fontSize="small" sx={{ mr: 1.25 }} /> Delete Project
        </MenuItem>
      </Menu>
    </Box>
  );
}
