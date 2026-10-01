import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
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
  ProjectFolderDto,
} from "@ponderosa/core";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Route } from "../routing";
import type { ProjectSidebarSection } from "../routeRegistry";
import type { UnreadNotificationProjection } from "../workspaceNavigation";
import { OperatorAvatar } from "./OperatorAvatar";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import {
  SIDEBAR_RAIL_WIDTH,
  railSurface,
} from "./WorkspaceSidebar.helpers";
import { RailButton } from "./WorkspaceSidebar.parts";
import { ProjectFolderRail } from "./ProjectFolderRail";

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

export function ProjectRailButton({
  project,
  current,
  expanded,
  unread,
  runningCount = 0,
  activityUnknown = false,
  dragging,
  dropPosition,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  project: ProjectDto;
  current: boolean;
  expanded: boolean;
  unread?: UnreadNotificationProjection;
  runningCount?: number;
  activityUnknown?: boolean;
  dragging: boolean;
  dropPosition?: "before" | "after";
  onClick(): void;
  onContextMenu?(event: MouseEvent<HTMLButtonElement>): void;
  onDragStart(event: DragEvent<HTMLButtonElement>): void;
  onDragEnd(): void;
  onDragOver(event: DragEvent<HTMLButtonElement>): void;
  onDrop(event: DragEvent<HTMLButtonElement>): void;
}): JSX.Element {
  const color = PROJECT_COLORS[hashLabel(project.id || project.label) % PROJECT_COLORS.length];
  return (
    <Tooltip title={`${project.label}${runningCount ? ` · ${runningCount} agents working` : ""}`} placement="right">
      <ButtonBase
        aria-label={`${project.label}${unread?.importantCount ? `, ${unread.importantCount} important unread` : ""}${unread?.ordinaryCount ? `, ${unread.ordinaryCount} ordinary unread` : ""}`}
        aria-current={current ? "page" : undefined}
        aria-expanded={expanded}
        draggable
        onClick={onClick}
        onContextMenu={onContextMenu}
        onKeyDown={event => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
          }
        }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        sx={{
          position: "relative",
          width: 48,
          minWidth: 48,
          height: 48,
          flexShrink: 0,
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
            width: "100%",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            "& .MuiBadge-badge": {
              top: 4,
              right: -4,
              transform: "translateY(-50%)",
              "&.MuiBadge-invisible": { transform: "translateY(-50%) scale(0)" },
              border: `1px solid ${railSurface}`,
              fontWeight: 850,
              color: "#fff",
            },
          }}
        >
          <span>{projectInitials(project.label)}</span>
        </Badge>
        {runningCount > 0 ? <Box sx={{ position: "absolute", right: 2, bottom: 2, display: "flex", border: `2px solid ${railSurface}`, borderRadius: "50%" }}>
          <AgentStatusIndicator status="running" />
        </Box> : null}
        {activityUnknown ? <Box component="span" role="img" aria-label="Activity not yet available" title="Activity not yet available" sx={{ position: "absolute", right: 2, bottom: 2, fontSize: 10 }}>?</Box> : null}
        {unread?.importantCount && unread.ordinaryCount ? (
          <Box
            component="span"
            aria-hidden
            sx={{ position: "absolute", left: 3, bottom: 3, width: 8, height: 8, borderRadius: "50%", bgcolor: "text.secondary", border: `2px solid ${railSurface}` }}
          />
        ) : null}
      </ButtonBase>
    </Tooltip>
  );
}

export function ProjectRail({
  sections,
  drawer,
  projects,
  activeProjectId,
  currentProjectId,
  route,
  profile,
  attentionNotifications,
  unreadNotificationUpdates,
  projectUnread,
  folders = [],
  onFoldersChange,
  onRenameProject,
  onProjectSettings,
  onDeleteProject,
  projectRunningCounts,
  onReorderProject,
  onOpenHome,
  onOpenAllMessages,
  onManageSection,
  onOpenProject,
  onOpenCreate,
  createProjectOpen = false,
  onOpenSearch,
  onOpenNotifications,
  onOpenSettings,
  onCollapse,
  onClose,
}: {
  sections?: { active?: ProjectSidebarSection; agentsWorking?: boolean; onSelect(section: ProjectSidebarSection): void };
  drawer: boolean;
  projects: ProjectDto[];
  activeProjectId?: string;
  currentProjectId?: string;
  route: Route;
  profile: OperatorProfileDto;
  attentionNotifications: number;
  unreadNotificationUpdates: number;
  projectUnread: ReadonlyMap<string, UnreadNotificationProjection>;
  folders?: ProjectFolderDto[];
  onFoldersChange(folders: ProjectFolderDto[]): void;
  onRenameProject(project: ProjectDto): void;
  onProjectSettings(project: ProjectDto): void;
  onDeleteProject(project: ProjectDto): void;
  projectRunningCounts?: ReadonlyMap<string, number>;
  onReorderProject(
    sourceProjectId: string,
    targetProjectId: string,
    position: "before" | "after",
  ): void;
  onOpenHome(): void;
  onOpenAllMessages(): void;
  onManageSection(section: ProjectSidebarSection): void;
  onOpenProject(project: ProjectDto): void;
  onOpenCreate(): void;
  createProjectOpen?: boolean;
  onOpenSearch(): void;
  onOpenNotifications(): void;
  onOpenSettings(): void;
  onCollapse?(): void;
  onClose?(): void;
}): JSX.Element {
  const railWidth = drawer ? 64 : SIDEBAR_RAIL_WIDTH;
  const mobile = drawer && Boolean(sections);
  const [operatorAnchor, setOperatorAnchor] = useState<HTMLElement>();
  const [sectionMenu, setSectionMenu] = useState<{
    anchor: HTMLElement;
    section: ProjectSidebarSection;
  }>();
  const sectionLongPressTimer = useRef<number | undefined>(undefined);
  const suppressSectionClick = useRef(false);
  const cancelSectionLongPress = () => {
    if (sectionLongPressTimer.current !== undefined) {
      window.clearTimeout(sectionLongPressTimer.current);
      sectionLongPressTimer.current = undefined;
    }
  };
  useEffect(() => {
    if (!sectionMenu) return;
    const switchSectionMenu = (event: globalThis.MouseEvent) => {
      const button = document.elementsFromPoint(event.clientX, event.clientY)
        .map(element => element.closest<HTMLElement>("[data-sidebar-section]"))
        .find((element): element is HTMLElement => Boolean(element));
      const section = button?.dataset.sidebarSection as ProjectSidebarSection | undefined;
      if (!button || !section || !PROJECT_MODES.some(mode => mode.id === section)) return;
      event.preventDefault();
      event.stopPropagation();
      setSectionMenu({ anchor: button, section });
    };
    // MUI's menu backdrop sits above the other tabs. Inspecting the elements
    // under the pointer lets a second right-click replace the open menu instead
    // of falling through to the browser's native context menu.
    window.addEventListener("contextmenu", switchSectionMenu, true);
    return () => window.removeEventListener("contextmenu", switchSectionMenu, true);
  }, [sectionMenu]);
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
  if (sections) {
    const notificationBadge = attentionNotifications ||
      (unreadNotificationUpdates ? unreadNotificationUpdates : undefined);
    return (
      <>
        <Stack
          component="nav"
          aria-label="Workspace navigation"
          direction="row"
          data-workspace-sidebar-header
          sx={{
            gridRow: 1,
            minWidth: 0,
            alignItems: "center",
            gap: 0.25,
            px: 1.25,
            py: 0.75,
          }}
        >
          <ButtonBase
            aria-label="Home"
            aria-current={route.kind === "home" ? "page" : undefined}
            onClick={onOpenHome}
            sx={{
              minWidth: 0,
              flex: drawer ? "0 0 40px" : 1,
              minHeight: drawer ? 44 : 36,
              alignItems: "center",
              justifyContent: drawer ? "center" : "flex-start",
              gap: 0.75,
              px: 0.5,
              py: 0.25,
              mr: 0,
              borderRadius: 1.5,
              bgcolor: route.kind === "home" ? "action.selected" : "transparent",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Box
              component="img"
              src="/icons/app-icon.png"
              alt=""
              sx={{ width: 32, height: 32, flex: "0 0 32px", borderRadius: 1, objectFit: "cover" }}
            />
            {!drawer ? (
              <Typography noWrap sx={{ minWidth: 0, fontSize: 16, fontWeight: 750 }}>
                Ponderosa
              </Typography>
            ) : null}
          </ButtonBase>
          {drawer ? (
            <Tooltip title="Messages across Ponderosa">
              <IconButton
                aria-label="Messages across Ponderosa"
                aria-current={route.kind === "allChat" ? "page" : undefined}
                onClick={onOpenAllMessages}
                sx={{ width: 36, height: 36, flex: "0 0 36px" }}
              >
                <ForumOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          {drawer ? <Box aria-hidden sx={{ flex: 1 }} /> : null}
          {!drawer && onCollapse ? (
            <Tooltip title="Collapse sidebar">
              <IconButton aria-label="Collapse workspace navigation" onClick={onCollapse} sx={{ width: 36, height: 36, flex: "0 0 36px" }}>
                <ViewSidebarOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip title="Search">
            <IconButton aria-label="Search" onClick={onOpenSearch} sx={{ width: 36, height: 36, flex: "0 0 36px" }}>
              <SearchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Notifications">
            <IconButton
              aria-label={notificationBadge ? `Notifications, ${notificationBadge} unread` : "Notifications"}
              onClick={onOpenNotifications}
              sx={{ width: 36, height: 36, flex: "0 0 36px" }}
            >
              <Badge
                color={attentionNotifications ? "error" : "primary"}
                badgeContent={notificationBadge}
                max={99}
                invisible={!notificationBadge}
                slotProps={{ badge: { "aria-hidden": true } }}
                sx={{ "& .MuiBadge-badge": { color: "#fff", fontWeight: 800 } }}
              >
                <NotificationsOutlinedIcon fontSize="small" />
              </Badge>
            </IconButton>
          </Tooltip>
          {drawer && onClose ? (
            <Tooltip title="Close navigation">
              <IconButton aria-label="Close workspace navigation" onClick={onClose} sx={{ width: 36, height: 36, flex: "0 0 36px" }}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>

        <Box
          component="nav"
          aria-label="Workspace sections"
          data-workspace-sidebar-sections
          sx={{
            gridRow: 2,
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 0.5,
            borderTop: 1,
            borderBottom: 1,
            borderColor: "divider",
            px: 1.25,
            pt: 0.75,
            pb: 0.75,
          }}
        >
          {!drawer ? <ButtonBase
            aria-label="Messages across Ponderosa"
            aria-current={route.kind === "allChat" ? "page" : undefined}
            onClick={onOpenAllMessages}
            sx={{
              gridColumn: "1 / -1",
              minWidth: 0,
              minHeight: 36,
              justifyContent: "center",
              gap: 1,
              px: 1,
              borderRadius: 1.5,
              color: "text.secondary",
              bgcolor: "transparent",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <ForumOutlinedIcon sx={{ fontSize: 18, flex: "0 0 auto" }} />
            <Typography component="span" noWrap sx={{ minWidth: 0, fontSize: 12, fontWeight: 700 }}>
              Messages across Ponderosa
            </Typography>
          </ButtonBase> : null}
          {PROJECT_MODES.map(mode => (
            <ButtonBase
              key={mode.id}
              data-sidebar-section={mode.id}
              aria-label={mode.label}
              aria-pressed={sections.active === mode.id}
              aria-haspopup="menu"
              aria-expanded={sectionMenu?.section === mode.id || undefined}
              onClick={() => {
                if (suppressSectionClick.current) {
                  suppressSectionClick.current = false;
                  return;
                }
                sections.onSelect(mode.id);
              }}
              onPointerDown={event => {
                if (event.pointerType === "mouse") return;
                cancelSectionLongPress();
                const anchor = event.currentTarget;
                sectionLongPressTimer.current = window.setTimeout(() => {
                  suppressSectionClick.current = true;
                  setSectionMenu({ anchor, section: mode.id });
                }, 550);
              }}
              onPointerUp={cancelSectionLongPress}
              onPointerCancel={cancelSectionLongPress}
              onPointerLeave={cancelSectionLongPress}
              onContextMenu={event => {
                event.preventDefault();
                setSectionMenu({ anchor: event.currentTarget, section: mode.id });
              }}
              onKeyDown={event => {
                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                setSectionMenu({ anchor: event.currentTarget, section: mode.id });
              }}
              sx={{
                minWidth: 0,
                minHeight: drawer ? 44 : 40,
                gap: 0.5,
                px: 0.5,
                borderRadius: 2,
                color: sections.active === mode.id ? "primary.main" : "text.secondary",
                bgcolor: sections.active === mode.id ? "action.selected" : "transparent",
                "&:hover": { bgcolor: sections.active === mode.id ? "action.selected" : "action.hover" },
                "& > .MuiSvgIcon-root": { flex: "0 0 auto", fontSize: 18 },
              }}
            >
              {mode.icon}
              <Typography component="span" noWrap sx={{ minWidth: 0, fontSize: 12, fontWeight: 700 }}>
                {mode.label}
              </Typography>
              {mode.id === "agents" && sections.agentsWorking ? <AgentStatusIndicator status="running" /> : null}
            </ButtonBase>
          ))}
          <Menu
            anchorEl={sectionMenu?.anchor}
            open={Boolean(sectionMenu)}
            onClose={() => {
              const trigger = sectionMenu?.anchor;
              setSectionMenu(undefined);
              window.requestAnimationFrame(() => trigger?.isConnected && trigger.focus());
            }}
          >
            <MenuItem onClick={() => {
              const section = sectionMenu?.section;
              setSectionMenu(undefined);
              if (section) onManageSection(section);
            }}>
              <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
              <ListItemText>
                {sectionMenu?.section === "agents"
                  ? "Manage agents"
                  : sectionMenu?.section === "triggers"
                    ? "Manage automations"
                    : "Manage chats"}
              </ListItemText>
            </MenuItem>
          </Menu>
        </Box>

        <Box
          data-workspace-sidebar-profile
          sx={{
            gridRow: 4,
            minWidth: 0,
            borderTop: 1,
            borderColor: "divider",
            px: 1,
            pt: 0.75,
            pb: drawer ? "max(6px, env(safe-area-inset-bottom))" : 0.75,
          }}
        >
          <ButtonBase
            aria-label="Open operator menu"
            aria-haspopup="menu"
            aria-expanded={Boolean(operatorAnchor)}
            onClick={event => setOperatorAnchor(event.currentTarget)}
            sx={{
              width: "100%",
              minWidth: 0,
              minHeight: 48,
              justifyContent: "flex-start",
              gap: 1,
              px: 0.75,
              borderRadius: 1.5,
              textAlign: "left",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <OperatorAvatar profile={profile} size={34} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography noWrap sx={{ fontSize: 14, fontWeight: 700 }}>
                {profile.displayName || "Operator"}
              </Typography>
              {profile.handle ? (
                <Typography noWrap variant="caption" color="text.secondary">
                  #{profile.handle.replace(/^[@#]/, "")}
                </Typography>
              ) : null}
            </Box>
            <MoreVertIcon fontSize="small" sx={{ color: "text.secondary", flex: "0 0 auto" }} />
          </ButtonBase>
          <Menu
            anchorEl={operatorAnchor}
            open={Boolean(operatorAnchor)}
            onClose={closeOperatorMenu}
            anchorOrigin={{ vertical: "top", horizontal: "right" }}
            transformOrigin={{ vertical: "bottom", horizontal: "right" }}
            slotProps={{ paper: { sx: { minWidth: 230, mb: 0.75 } } }}
          >
            <MenuItem onClick={() => runOperatorAction(onOpenSettings)}>
              <ListItemIcon><SettingsOutlinedIcon /></ListItemIcon>
              <ListItemText>Settings</ListItemText>
            </MenuItem>
          </Menu>
        </Box>
      </>
    );
  }
  return (
    <Box
      component="nav"
      aria-label={sections ? "Workspace sections" : drawer ? "Project navigation drawer" : "Project navigation"}
      sx={{
        width: railWidth,
        minWidth: railWidth,
        height: "100%",
        minHeight: 0,
        borderRight: 1,
        borderColor: "var(--ponderosa-rail-border)",
        bgcolor: railSurface,
        display: mobile ? "contents" : "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        justifyItems: "center",
        py: 1.5,
      }}
    >
      <Stack spacing={0.6} sx={{ alignItems: "center", ...(mobile ? { gridRow: 1, flexDirection: "row", px: 1.5, py: 0.25 } : {}) }}>
        {drawer && onClose ? (
          <Tooltip title="Close navigation" placement="right">
            <IconButton aria-label="Close workspace navigation" onClick={onClose} sx={{ width: 44, height: 44, mb: mobile ? 0 : 1.5, order: mobile ? 2 : undefined, ml: mobile ? "auto !important" : undefined }}>
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
              width: mobile ? 40 : 48,
              height: mobile ? 44 : 48,
              mb: mobile ? 0 : 1.1,
              borderRadius: 1.5,
              bgcolor: route.kind === "home" ? "action.selected" : "transparent",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Box component="img" src="/icons/app-icon.png" alt="" sx={{ width: mobile ? 32 : 42, height: mobile ? 32 : 42, p: 0.25, borderRadius: 1, objectFit: "cover" }} />
          </ButtonBase>
        </Tooltip>
        {mobile ? <Typography sx={{ fontWeight: 750, fontSize: 16 }}>Ponderosa</Typography> : null}
        <RailButton
          label="All Messages"
          selected={route.kind === "allChat"}
          onClick={onOpenAllMessages}
        >
          <ForumOutlinedIcon />
        </RailButton>
        {!mobile ? <Box aria-hidden sx={{ width: 32, borderTop: 1, borderColor: "var(--ponderosa-rail-border)", my: 0.25 }} /> : null}
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
          ...(mobile ? { gridRow: 2, flexDirection: "row", px: 1.5, gap: 0.5, py: 0, overflow: "visible", "& > *": { marginTop: "0 !important" } } : {}),
        }}
      >
        <ProjectFolderRail projects={projects} folders={folders} onChange={onFoldersChange}
          currentProjectId={currentProjectId} activeProjectId={activeProjectId}
          unread={projectUnread} running={projectRunningCounts}
          onOpen={onOpenProject} onReorder={onReorderProject}
          onRename={onRenameProject} onSettings={onProjectSettings} onDelete={onDeleteProject} />
      </Stack>

      <Stack spacing={0.55} sx={{ alignItems: "center", ...(mobile ? { gridRow: 4, flexDirection: "row", justifyContent: "space-around", borderTop: 1, borderColor: "divider", py: 0, pb: "env(safe-area-inset-bottom)", "& > *": { marginTop: "0 !important" }, "& .MuiIconButton-root": { width: 44, height: 44 }, "& .MuiSvgIcon-root": { fontSize: 21 } } : {}) }}>
        <RailButton label="Create Project" selected={createProjectOpen || (route.kind === "create" && route.resource === "project")} onClick={onOpenCreate}>
          <AddIcon />
        </RailButton>
        {!mobile ? <Box aria-hidden sx={{ width: 32, borderTop: 1, borderColor: "var(--ponderosa-rail-border)", my: 0.25 }} /> : null}
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
    <Box sx={{ pt: 1.75, pb: 1 }}>
      <Stack direction="row" spacing={drawer ? 0.5 : 1.25} sx={{ alignItems: "center", px: drawer ? 1 : 2 }}>
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
              <Typography fontWeight={800} noWrap={!drawer} sx={drawer ? { overflowWrap: "anywhere", lineHeight: 1.3, fontSize: { xs: 14, sm: "0.875rem" }, fontWeight: { xs: 650, sm: 800 } } : undefined}>{project.label}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap={!drawer} sx={drawer ? { fontSize: { xs: 12, sm: "0.75rem" } } : undefined}>
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
          gridTemplateColumns: drawer ? { xs: "minmax(0, 1fr)", sm: "repeat(3, minmax(0, 1fr))" } : "repeat(3, minmax(0, 1fr))",
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
                minHeight: drawer ? { xs: 44, sm: 52 } : 52,
                px: 0.5,
                py: 0.6,
                borderRadius: 1.1,
                display: "flex",
                flexDirection: drawer ? { xs: "row", sm: "column" } : "column",
                justifyContent: drawer ? { xs: "flex-start", sm: "center" } : "center",
                gap: drawer ? { xs: 1, sm: 0.25 } : 0.25,
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
                  fontSize: drawer ? { xs: 14, sm: 11 } : mode.id === "triggers" ? 8.75 : 9.5,
                  letterSpacing: mode.id === "triggers" ? "-.025em" : undefined,
                  fontWeight: drawer ? { xs: 600, sm: 700 } : 700,
                }}
                noWrap
              >
                {mode.label}
              </Typography>
              {count == null ? null : (
                <Typography component="span" sx={{ fontSize: drawer ? { xs: 12, sm: 9 } : 9, color: "text.disabled" }}>
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
