import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Badge,
  Box,
  ButtonBase,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  WorkspaceActivityCountDto,
  OperatorProfileDto,
} from "@ponderosa/core";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Route } from "../routing";
import type { ProjectSidebarSection } from "../routeRegistry";
import { SidebarHeader, SidebarOperatorFooter } from "./WorkspaceSidebar.chrome";
import { SidebarActivityBadge } from "./SidebarActivityBadge";

export function ProjectRail({
  sections,
  drawer,
  route,
  profile,
  attentionNotifications,
  unreadNotificationUpdates,
  onOpenHome,
  onOpenAllMessages,
  onManageSection,
  onOpenSearch,
  onOpenNotifications,
  onOpenSettings,
  onCollapse,
  onClose,
}: {
  sections: { active?: ProjectSidebarSection; agentsActivity?: WorkspaceActivityCountDto; agentsActivityFresh?: boolean; onSelect(section: ProjectSidebarSection): void };
  drawer: boolean;
  route: Route;
  profile: OperatorProfileDto;
  attentionNotifications: number;
  unreadNotificationUpdates: number;
  onOpenHome(): void;
  onOpenAllMessages(): void;
  onManageSection(section: ProjectSidebarSection): void;
  onOpenSearch(): void;
  onOpenNotifications(): void;
  onOpenSettings(): void;
  onCollapse?(): void;
  onClose?(): void;
}): JSX.Element {
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
  const notificationBadge = attentionNotifications ||
    (unreadNotificationUpdates ? unreadNotificationUpdates : undefined);
  return (
    <>
      <SidebarHeader drawer={drawer} hideTitle={drawer} homeLabel="Home" selected={route.kind === "home"} onHome={onOpenHome} onCollapse={drawer ? onClose : onCollapse} actions={<>
        {drawer ? (
          <Tooltip title="Messages across Ponderosa">
            <IconButton aria-label="Messages across Ponderosa" aria-current={route.kind === "allChat" ? "page" : undefined} onClick={onOpenAllMessages}>
              <ForumOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
        {drawer ? <Box aria-hidden sx={{ flex: 1 }} /> : null}
        <Tooltip title="Search">
          <IconButton aria-label="Search" onClick={onOpenSearch}>
            <SearchIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Notifications">
          <IconButton aria-label={notificationBadge ? `Notifications, ${notificationBadge} unread` : "Notifications"} onClick={onOpenNotifications}>
            <Badge color="error" badgeContent={notificationBadge} max={99} invisible={!notificationBadge} slotProps={{ badge: { "aria-hidden": true } }} sx={{ "& .MuiBadge-badge": { color: "#fff", fontWeight: 800 } }}>
              <NotificationsOutlinedIcon fontSize="small" />
            </Badge>
          </IconButton>
        </Tooltip>
      </>} />

      <Box
        component="nav"
        aria-label="Workspace sections"
        data-workspace-sidebar-sections
        sx={{
          gridRow: 2,
          display: "grid",
          gridTemplateColumns: `repeat(${PROJECT_MODES.length}, minmax(0, 1fr))`,
          gap: 0.5,
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
            {mode.id === "agents" ? <SidebarActivityBadge activity={sections.agentsActivity} fresh={sections.agentsActivityFresh} /> : null}
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
                : "Manage chats"}
            </ListItemText>
          </MenuItem>
        </Menu>
      </Box>

      <SidebarOperatorFooter profile={profile} drawer={drawer} onSettings={onOpenSettings} />
    </>
  );
}

const PROJECT_MODES: Array<{
  id: ProjectSidebarSection;
  label: string;
  icon: ReactNode;
}> = [
  { id: "chats", label: "Chats", icon: <ChatBubbleOutlineIcon fontSize="small" /> },
  { id: "agents", label: "Agents", icon: <SmartToyOutlinedIcon fontSize="small" /> },
];
