import AddIcon from "@mui/icons-material/Add";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import SearchIcon from "@mui/icons-material/Search";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CloseIcon from "@mui/icons-material/Close";
import DifferenceOutlinedIcon from "@mui/icons-material/DifferenceOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import {
  Badge,
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import {
  routeTabIcon,
  routeTabLabel,
  type RouteTabIcon,
} from "../routeRegistry";
import type { WorkspaceTabState } from "../workspaceTabs";
import { OperatorAvatar, operatorInitials } from "./OperatorAvatar";
import { ProviderQuotaIndicator } from "./ProviderUsageCenter";

const TAB_ICONS = {
  agent: SmartToyOutlinedIcon,
  bolt: BoltOutlinedIcon,
  chat: ChatBubbleOutlineIcon,
  dataUsage: DataUsageOutlinedIcon,
  difference: DifferenceOutlinedIcon,
  folder: FolderOutlinedIcon,
  home: HomeOutlinedIcon,
  language: LanguageIcon,
  menuBook: MenuBookOutlinedIcon,
  person: PersonOutlineIcon,
  settings: SettingsOutlinedIcon,
} satisfies Record<RouteTabIcon, typeof FolderOutlinedIcon>;

function TabIcon({
  route,
}: {
  route: WorkspaceTabState["route"];
}): JSX.Element {
  const Icon = TAB_ICONS[routeTabIcon(route)];
  return <Icon fontSize="small" />;
}

function newTabShortcutLabel(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): "⌘T" | "Ctrl T" {
  return /Mac|iPhone|iPad/iu.test(platform) ? "⌘T" : "Ctrl T";
}

export function WorkspaceTabs({
  tabs,
  projects,
  preferences,
  activeKey,
  notificationCount = 0,
  onActivate,
  onCreate,
  onSearch,
  onOpenInbox,
  onOpenProfile,
  onClose,
  onCloseOthers,
  onRename,
  onReorder,
  preferredProvider,
}: {
  tabs: WorkspaceTabState[];
  projects: ProjectDto[];
  preferences: WorkspacePreferencesDto;
  activeKey: string;
  notificationCount?: number;
  onActivate(key: string): void;
  onCreate(): void;
  onSearch(): void;
  onOpenInbox(): void;
  onOpenProfile(): void;
  onClose(key: string): void;
  onCloseOthers(key: string): void;
  onRename(key: string, title: string): void;
  onReorder(draggedKey: string, targetKey: string): void;
  preferredProvider?: string;
}): JSX.Element {
  const [contextMenu, setContextMenu] = useState<{
    anchor: HTMLElement;
    key: string;
    label: string;
  }>();
  const [renameTarget, setRenameTarget] = useState<{
    key: string;
    label: string;
  }>();
  const [renameDraft, setRenameDraft] = useState("");
  const [draggedKey, setDraggedKey] = useState<string>();
  const [dragTargetKey, setDragTargetKey] = useState<string>();
  const projectIds = [
    ...new Set(
      tabs.flatMap(tab =>
        "projectId" in tab.route && typeof tab.route.projectId === "string"
          ? [tab.route.projectId]
          : [],
      ),
    ),
  ];
  const conversationQueries = useQueries({
    queries: projectIds.map(projectId => ({
      queryKey: queryKeys.conversations.project(projectId),
      queryFn: () => api.listConversations(projectId),
      staleTime: 10_000,
    })),
  });
  const agentQueries = useQueries({
    queries: projectIds.map(projectId => ({
      queryKey: queryKeys.agents.project(projectId),
      queryFn: () => api.listAgents(projectId),
      staleTime: 10_000,
    })),
  });
  const resourcesByProject = new Map(
    projectIds.map((projectId, index) => [
      projectId,
      {
        conversations: conversationQueries[index]?.data ?? [],
        agents: agentQueries[index]?.data ?? [],
      },
    ]),
  );

  const beginRename = (key: string, label: string) => {
    setRenameTarget({ key, label });
    setRenameDraft(label);
    setContextMenu(undefined);
  };
  const moveContextTab = (offset: -1 | 1) => {
    if (!contextMenu) return;
    const index = tabs.findIndex(tab => tab.key === contextMenu.key);
    const target = tabs[index + offset];
    if (target) onReorder(contextMenu.key, target.key);
    setContextMenu(undefined);
  };

  return (
    <Stack
      component="nav"
      aria-label="Open workspace tabs"
      direction="row"
      sx={{
        minWidth: 0,
        height: { xs: 52, md: 52 },
        px: { xs: 0.5, sm: 1 },
        py: 0.5,
        bgcolor: "var(--ponderosa-topbar)",
        color: "var(--ponderosa-rail-foreground)",
        alignItems: "center",
        overflow: "hidden",
        borderBottom: 1,
        borderColor: "var(--ponderosa-rail-border)",
        "& .MuiButtonBase-root.Mui-focusVisible": {
          outlineColor: "var(--ponderosa-rail-foreground-active)",
        },
      }}
    >
      <Stack
        className="workspace-tab-strip"
        direction="row"
        spacing={0.5}
        sx={{
          minWidth: 0,
          flex: 1,
          height: { xs: 44, md: 38 },
          overflowX: "auto",
          overflowY: "hidden",
          alignItems: "stretch",
          overscrollBehaviorInline: "contain",
          scrollSnapType: "x proximity",
          scrollbarWidth: "none",
          "&::-webkit-scrollbar": { display: "none" },
        }}
      >
        {tabs.map(tab => {
          const tabRoute = tab.route;
          const projectId =
            "projectId" in tabRoute && typeof tabRoute.projectId === "string"
              ? tabRoute.projectId
              : undefined;
          const project = projectId
            ? projects.find(candidate => candidate.id === projectId)
            : undefined;
          const resources = projectId
            ? resourcesByProject.get(projectId)
            : undefined;
          const generatedLabel = routeTabLabel(tabRoute, {
            conversationTitle: conversationId =>
              resources?.conversations.find(
                conversation => conversation.id === conversationId,
              )?.title,
            agentTitle: agentId =>
              resources?.agents.find(agent => agent.id === agentId)?.title,
            projectLabel: project?.label,
          });
          const label = tab.title ?? generatedLabel;
          const accessibleLabel =
            tabRoute.kind === "conversation"
              ? (resources?.conversations.find(
                  conversation => conversation.id === tabRoute.conversationId,
                )?.title ?? "Project Chat")
              : label;
          const selected = tab.key === activeKey;
          const projectLabel =
            project?.label ?? (projectId ? "Unavailable project" : "Ponderosa");
          return (
            <Box
              key={tab.key}
              data-tab-key={tab.key}
              data-tab-dragging={draggedKey === tab.key ? "true" : undefined}
              draggable
              onDragStart={event => {
                setDraggedKey(tab.key);
                setDragTargetKey(undefined);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tab.key);
              }}
              onDragOver={event => {
                if (!draggedKey || draggedKey === tab.key) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragTargetKey(tab.key);
              }}
              onDragLeave={() =>
                setDragTargetKey(current =>
                  current === tab.key ? undefined : current,
                )
              }
              onDrop={event => {
                event.preventDefault();
                const sourceKey =
                  draggedKey ?? event.dataTransfer.getData("text/plain");
                if (sourceKey && sourceKey !== tab.key)
                  onReorder(sourceKey, tab.key);
                setDraggedKey(undefined);
                setDragTargetKey(undefined);
              }}
              onDragEnd={() => {
                setDraggedKey(undefined);
                setDragTargetKey(undefined);
              }}
              onContextMenu={event => {
                event.preventDefault();
                setContextMenu({
                  anchor: event.currentTarget,
                  key: tab.key,
                  label,
                });
              }}
              sx={{
                position: "relative",
                containerType: "inline-size",
                minWidth: { xs: 132, md: 140 },
                maxWidth: 240,
                flex: "0 1 220px",
                height: { xs: 44, md: 38 },
                display: "flex",
                alignItems: "stretch",
                overflow: "hidden",
                borderRadius: 2,
                scrollSnapAlign: "start",
                border: 1,
                borderColor:
                  dragTargetKey === tab.key
                    ? "var(--ponderosa-rail-foreground-active)"
                    : selected
                      ? "var(--ponderosa-rail-border)"
                      : "rgba(178, 187, 180, 0.18)",
                color: selected
                  ? "#E6E7DF"
                  : "var(--ponderosa-rail-foreground)",
                bgcolor: selected
                  ? "rgba(124, 191, 138, .14)"
                  : "rgba(178, 187, 180, 0.05)",
                boxShadow:
                  dragTargetKey === tab.key
                    ? "inset 3px 0 0 var(--ponderosa-rail-foreground-active)"
                    : "none",
                opacity: draggedKey === tab.key ? 0.55 : 1,
                cursor: draggedKey === tab.key ? "grabbing" : "grab",
                "&:hover": {
                  bgcolor: selected
                    ? "rgba(124, 191, 138, .20)"
                    : "rgba(178, 187, 180, .10)",
                  color: "#E6E7DF",
                },
              }}
            >
              <Tooltip title={`${label} · ${projectLabel}`} enterDelay={500}>
                <ButtonBase
                  onClick={() => onActivate(tab.key)}
                  onDoubleClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    beginRename(tab.key, label);
                  }}
                  onKeyDown={event => {
                    if (
                      event.key === "ContextMenu" ||
                      (event.shiftKey && event.key === "F10")
                    ) {
                      event.preventDefault();
                      setContextMenu({
                        anchor: event.currentTarget,
                        key: tab.key,
                        label,
                      });
                    }
                  }}
                  aria-keyshortcuts="Shift+F10"
                  aria-label={`Open ${accessibleLabel} in ${projectLabel}`}
                  aria-current={selected ? "page" : undefined}
                  sx={{
                    minWidth: 0,
                    flex: 1,
                    px: 1,
                    gap: 0.75,
                    justifyContent: "flex-start",
                    overflow: "hidden",
                    "& > svg": { flex: "0 0 auto", fontSize: 18 },
                  }}
                >
                  <TabIcon route={tabRoute} />
                  <Typography
                    className="workspace-tab-label"
                    variant="body2"
                    fontWeight={selected ? 750 : 600}
                    noWrap
                    sx={{ minWidth: 0 }}
                  >
                    {label}
                  </Typography>
                </ButtonBase>
              </Tooltip>
              {tabs.length > 1 ? (
                <IconButton
                  size="small"
                  aria-label={`Close ${label}`}
                  onClick={event => {
                    event.stopPropagation();
                    onClose(tab.key);
                  }}
                  sx={{
                    width: { xs: 36, md: 28 },
                    minWidth: { xs: 36, md: 28 },
                    height: { xs: 36, md: 28 },
                    alignSelf: "center",
                    mr: 0.25,
                    color: "var(--ponderosa-rail-foreground)",
                    opacity: {
                      xs: selected ? 0.75 : 0.45,
                      md: selected ? 0.75 : 0,
                    },
                    "&:hover": { color: "#E6E7DF", opacity: 1 },
                    "&:focus-visible, &.Mui-focusVisible": {
                      color: "#E6E7DF",
                      opacity: 1,
                    },
                    "@container (max-width: 86px)": { display: "none" },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              ) : null}
            </Box>
          );
        })}
      </Stack>
      <Tooltip title={`New Tab (${newTabShortcutLabel()})`}>
        <IconButton
          aria-label="New tab"
          onClick={onCreate}
          sx={{
            ml: 0.5,
            width: { xs: 44, md: 36 },
            height: { xs: 44, md: 36 },
            flexShrink: 0,
            color: "var(--ponderosa-rail-foreground)",
            "&:hover": {
              color: "#E6E7DF",
              bgcolor: "rgba(178, 187, 180, .10)",
            },
          }}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Box
        sx={{
          ml: 0.75,
          pl: 1,
          pr: 0.25,
          height: 34,
          display: { xs: "none", sm: "flex" },
          alignItems: "center",
          borderLeft: 1,
          borderColor: "var(--ponderosa-rail-border)",
          flexShrink: 0,
        }}
      >
        <ProviderQuotaIndicator preferredProvider={preferredProvider} />
        <Tooltip title="Search">
          <IconButton
            aria-label="Search Ponderosa"
            onClick={onSearch}
            sx={{
              ml: 0.5,
              width: 36,
              height: 36,
              flexShrink: 0,
              color: "var(--ponderosa-rail-foreground)",
              "&:hover": {
                color: "#E6E7DF",
                bgcolor: "rgba(178, 187, 180, .10)",
              },
            }}
          >
            <SearchIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Inbox">
          <IconButton
            aria-label="Open Inbox"
            onClick={onOpenInbox}
            sx={{
              width: 36,
              height: 36,
              flexShrink: 0,
              color: "var(--ponderosa-rail-foreground)",
              "&:hover": {
                color: "#E6E7DF",
                bgcolor: "rgba(178, 187, 180, .10)",
              },
            }}
          >
            <Badge color="error" badgeContent={notificationCount} max={99}>
              <NotificationsOutlinedIcon fontSize="small" />
            </Badge>
          </IconButton>
        </Tooltip>
        <Tooltip title="Operator Profile">
          <IconButton
            aria-label="Open operator profile"
            onClick={onOpenProfile}
            sx={{ width: 36, height: 36, ml: 0.25, p: 0 }}
          >
            <OperatorAvatar
              profile={preferences.profile}
              size={30}
              fallback={operatorInitials(preferences.profile.displayName)}
            />
          </IconButton>
        </Tooltip>
      </Box>
      {contextMenu ? (
        <Menu
          anchorEl={contextMenu.anchor}
          open
          onClose={() => setContextMenu(undefined)}
        >
          <MenuItem
            onClick={() => beginRename(contextMenu.key, contextMenu.label)}
          >
            Rename Tab
          </MenuItem>
          <MenuItem
            disabled={tabs.findIndex(tab => tab.key === contextMenu.key) <= 0}
            onClick={() => moveContextTab(-1)}
          >
            Move Left
          </MenuItem>
          <MenuItem
            disabled={
              tabs.findIndex(tab => tab.key === contextMenu.key) >=
              tabs.length - 1
            }
            onClick={() => moveContextTab(1)}
          >
            Move Right
          </MenuItem>
          <MenuItem
            disabled={tabs.length === 1}
            onClick={() => {
              onClose(contextMenu.key);
              setContextMenu(undefined);
            }}
          >
            Close Tab
          </MenuItem>
          <MenuItem
            disabled={tabs.length === 1}
            onClick={() => {
              onCloseOthers(contextMenu.key);
              setContextMenu(undefined);
            }}
          >
            Close Other Tabs
          </MenuItem>
        </Menu>
      ) : null}
      <Dialog
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(undefined)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Rename tab</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Tab name"
            value={renameDraft}
            sx={{ mt: 1 }}
            inputProps={{ maxLength: 80 }}
            onChange={event => setRenameDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && renameTarget) {
                event.preventDefault();
                onRename(renameTarget.key, renameDraft);
                setRenameTarget(undefined);
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(undefined)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (renameTarget) onRename(renameTarget.key, renameDraft);
              setRenameTarget(undefined);
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
