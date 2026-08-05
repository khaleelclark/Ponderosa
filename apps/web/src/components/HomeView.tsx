import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type {
  EngineDto,
  ProjectDto,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceConversationDirectoryItemDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
  WorkspaceProjectDirectoryItemDto,
  WorkspaceTriggerDirectoryItemDto,
} from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type MouseEvent, type ReactElement } from "react";
import {
  combineWorkspaceDirectoryRequestStates,
  useWorkspaceDirectory,
  workspaceDirectoryItems,
} from "../hooks/useWorkspaceDirectory";
import { engineAvailabilityPresentation } from "../conversationEngine";
import type { Route } from "../routing";
import { isOpenAttention } from "../attention";
import { sortWorkspaceResources, starredWorkspaceResources, toggleWorkspaceResourceStar } from "../resourcePreferences";
import { CollectionStateFeedback } from "./CollectionPrimitives";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import {
  markWorkspaceResourceUsed,
  useWorkspaceResourceRecency,
  workspaceResourceRecencyMap,
} from "../workspaceRecency";

type RecentResource = { id: string; title: string; detail: string; updatedAt: string; route: Route; icon: JSX.Element };

function Stat({ label, value, onClick }: { label: string; value: string | number; onClick?(): void }): JSX.Element {
  const content = <Stack spacing={0.25} sx={{ p: 1.5, minWidth: 0, textAlign: "left" }}><Typography variant="h5" fontWeight={800}>{value}</Typography><Typography variant="body2" color="text.secondary">{label}</Typography></Stack>;
  return <Paper variant="outlined" sx={{ minWidth: 0, overflow: "hidden" }}>{onClick ? <ButtonBase onClick={onClick} sx={{ display: "block", width: "100%" }}>{content}</ButtonBase> : content}</Paper>;
}

function CreateEntry({
  icon,
  title,
  description,
  disabled,
  onCreate,
}: {
  icon: ReactElement;
  title: string;
  description: string;
  disabled?: boolean;
  onCreate(): void;
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "center", minWidth: 0 }}
      >
        <Box
          sx={{
            width: 44,
            height: 44,
            flex: "0 0 auto",
            borderRadius: 1.5,
            bgcolor: "action.selected",
            color: "primary.main",
            display: "grid",
            placeItems: "center",
          }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography fontWeight={800}>{title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          disabled={disabled}
          onClick={onCreate}
          sx={{
            width: { xs: 176, sm: 200 },
            minHeight: 48,
            flexShrink: 0,
          }}
        >
          Create {title}
        </Button>
      </Stack>
    </Paper>
  );
}

export function HomeView({ projects, engines, notifications, preferences, onNavigate, onOpenInNewTab, onPreferences, onCreateProject, onCreateChat, onCreateAgent, onCreateTrigger, onOpenInbox }: {
  projects: ProjectDto[];
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onOpenInNewTab?(route: Route): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onCreateProject(): void;
  onCreateChat(): void;
  onCreateAgent(): void;
  onCreateTrigger(): void;
  onOpenInbox(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const recencyQuery = useWorkspaceResourceRecency();
  const recency = workspaceResourceRecencyMap(recencyQuery.data);
  const [tabMenu, setTabMenu] = useState<ResourceContextMenuState<Route>>();
  const [createAnchor, setCreateAnchor] = useState<HTMLElement>();
  const [tab, setTab] = useState<"overview" | "work">("overview");
  const directoryOptions = { sort: "last_used" as const };
  const projectDirectoryQuery =
    useWorkspaceDirectory<WorkspaceProjectDirectoryItemDto>("project", directoryOptions);
  const conversationDirectoryQuery =
    useWorkspaceDirectory<WorkspaceConversationDirectoryItemDto>("conversation", directoryOptions);
  const agentDirectoryQuery =
    useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", directoryOptions);
  const triggerDirectoryQuery =
    useWorkspaceDirectory<WorkspaceTriggerDirectoryItemDto>("trigger", directoryOptions);
  const projectDirectory = workspaceDirectoryItems(projectDirectoryQuery.data?.pages, preferences);
  const conversationDirectory = workspaceDirectoryItems(conversationDirectoryQuery.data?.pages, preferences);
  const agentDirectory = workspaceDirectoryItems(agentDirectoryQuery.data?.pages, preferences);
  const triggerDirectory = workspaceDirectoryItems(triggerDirectoryQuery.data?.pages, preferences);
  const projectItems = [...projectDirectory.starredItems, ...projectDirectory.items];
  const conversationItems = [...conversationDirectory.starredItems, ...conversationDirectory.items];
  const agentItems = [...agentDirectory.starredItems, ...agentDirectory.items];
  const triggerItems = [...triggerDirectory.starredItems, ...triggerDirectory.items];
  const homeDirectoryRequest = combineWorkspaceDirectoryRequestStates([
    projectDirectoryQuery.requestState,
    conversationDirectoryQuery.requestState,
    agentDirectoryQuery.requestState,
    triggerDirectoryQuery.requestState,
  ]);
  const recentDirectoryRequest = {
    ...homeDirectoryRequest,
    hasNextPage: false,
    isPaginationError: false,
  };
  const activeAgents = agentDirectoryQuery.requestState.hasResolved
    ? agentDirectoryQuery.data?.pages.at(-1)?.activeCount ?? 0
    : "—";
  const needsAttention = notifications.filter(isOpenAttention).length;
  const unread = notifications.filter((item) => !item.readAt && (item.status ?? "open") === "open").length;
  const provider = engineAvailabilityPresentation(engines);
  const allResources: RecentResource[] = [
    ...projectItems.map(({ project }) => ({ id: `project:${project.id}`, title: project.label, detail: "Project", updatedAt: project.lastUsedAt ?? project.createdAt, route: { kind: "project", projectId: project.id } as Route, icon: <FolderOutlinedIcon fontSize="small" /> })),
    ...conversationItems.map(({ conversation, project }) => ({ id: `conversation:${conversation.id}`, title: conversation.title, detail: `${project.label} · Chat`, updatedAt: conversation.updatedAt, route: { kind: "conversation", projectId: project.id, conversationId: conversation.id } as Route, icon: <ChatBubbleOutlineIcon fontSize="small" /> })),
    ...agentItems.map(({ agent, project }) => ({ id: `agent:${agent.id}`, title: agent.title, detail: `${project.label} · Agent`, updatedAt: agent.updatedAt, route: { kind: "agent", projectId: project.id, agentId: agent.id } as Route, icon: <SmartToyOutlinedIcon fontSize="small" /> })),
    ...triggerItems.map(({ trigger, project, agent }) => ({ id: `trigger:${trigger.id}`, title: trigger.name, detail: `${project.label} · Trigger`, updatedAt: trigger.updatedAt, route: { kind: "agent", projectId: project.id, agentId: agent.id, view: "triggers" } as Route, icon: <BoltOutlinedIcon fontSize="small" /> })),
  ];
  const starredIds = starredWorkspaceResources(preferences);
  const orderedResources = sortWorkspaceResources(allResources, "last_used", [], (item) => item.id, (item) => item.title, (item) => recency.get(item.id) ?? item.updatedAt);
  const starred = orderedResources.filter((item) => starredIds.has(item.id));
  const recent = orderedResources.filter((item) => !starredIds.has(item.id)).slice(0, 10);
  const unstar = (item: RecentResource) => {
    const [kind, id] = item.id.split(":", 2) as ["project" | "conversation" | "agent" | "trigger", string];
    onPreferences(toggleWorkspaceResourceStar(preferences, kind, id));
  };
  const openResource = (item: RecentResource) => {
    if (item.id.startsWith("trigger:")) {
      markWorkspaceResourceUsed(
        queryClient,
        "trigger",
        item.id.slice("trigger:".length),
      );
    }
    onNavigate(item.route);
  };

  return <Box className="ponderosa-scroll" aria-busy={homeDirectoryRequest.isInitialLoading || homeDirectoryRequest.isRefreshing} sx={{ minHeight: 0, overflowY: "auto" }}>
    <TabbedWorkspaceFrame<"overview" | "work">
      icon={<HomeOutlinedIcon />}
      title="Home"
      context={<Typography variant="body2" color="text.secondary">A calm overview of your organization and its recent work.</Typography>}
      tabs={{
        value: tab,
        onChange: setTab,
        label: "Home",
        items: [
          { value: "overview", label: "Overview", icon: <HomeOutlinedIcon /> },
          { value: "work", label: "Recent work", icon: <ChatBubbleOutlineIcon /> },
        ],
      }}
    />
    <Box sx={{ p: { xs: 2, sm: 3, lg: 4 } }}>
    <Stack spacing={3} sx={{ width: "100%", maxWidth: 1320, mx: "auto" }}>
      {tab === "overview" ? <><Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 1.25 }}>
        <Stat label="Active Agents" value={activeAgents} />
        <Stat label="Open Issues" value={needsAttention} onClick={onOpenInbox} />
        <Stat label="Unread Messages" value={unread} onClick={() => onNavigate({ kind: "allChat" })} />
        <Stat label="Provider Health" value={provider.label} />
      </Box>

      <Box component="section" aria-labelledby="home-create-heading">
        <Box sx={{ mb: 1.5, display: { xs: "flex", sm: "block" }, gap: 1.5, alignItems: "center" }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="home-create-heading" variant="h6" fontWeight={800}>
            Create
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Create a new Project, Chat, Agent, or Trigger to get started. You can also open existing Projects from the sidebar.
          </Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            aria-haspopup="menu"
            aria-expanded={Boolean(createAnchor)}
            onClick={(event: MouseEvent<HTMLElement>) =>
              setCreateAnchor(event.currentTarget)
            }
            sx={{ display: { xs: "inline-flex", sm: "none" }, minHeight: 44, flexShrink: 0 }}
          >
            Create
          </Button>
        </Box>
        <Menu
          anchorEl={createAnchor}
          open={Boolean(createAnchor)}
          onClose={() => setCreateAnchor(undefined)}
          slotProps={{ paper: { sx: { width: "min(calc(100vw - 32px), 360px)" } } }}
        >
          {[
            { label: "Project", icon: <FolderOutlinedIcon />, disabled: false, action: onCreateProject },
            { label: "Chat", icon: <ChatBubbleOutlineIcon />, disabled: !projects.length, action: onCreateChat },
            { label: "Agent", icon: <SmartToyOutlinedIcon />, disabled: !projects.length, action: onCreateAgent },
            { label: "Trigger", icon: <BoltOutlinedIcon />, disabled: !projects.length, action: onCreateTrigger },
          ].map(item => (
            <MenuItem
              key={item.label}
              disabled={item.disabled}
              onClick={() => {
                setCreateAnchor(undefined);
                item.action();
              }}
              sx={{ minHeight: 48 }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={`Create ${item.label}`} />
            </MenuItem>
          ))}
        </Menu>
        <Stack spacing={1} sx={{ display: { xs: "none", sm: "flex" } }}>
          <CreateEntry
            icon={<FolderOutlinedIcon />}
            title="Project"
            description="A workspace with its own folder, runtime defaults, Chats, and Agents."
            onCreate={onCreateProject}
          />
          <CreateEntry
            icon={<ChatBubbleOutlineIcon />}
            title="Chat"
            description="A shared Project conversation for requests, decisions, and coordinated Agent work."
            disabled={!projects.length}
            onCreate={onCreateChat}
          />
          <CreateEntry
            icon={<SmartToyOutlinedIcon />}
            title="Agent"
            description="A managed worker with its own role, provider session, and Project authority."
            disabled={!projects.length}
            onCreate={onCreateAgent}
          />
          <CreateEntry
            icon={<BoltOutlinedIcon />}
            title="Trigger"
            description="An automation that starts Agent work from schedules or filesystem events."
            disabled={!projects.length}
            onCreate={onCreateTrigger}
          />
        </Stack>
      </Box>

      {needsAttention > 0 ? <Paper variant="outlined" sx={{ p: 2, borderColor: "warning.main" }}><Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}><WarningAmberOutlinedIcon color="warning" /><Box sx={{ flex: 1 }}><Typography fontWeight={800}>{needsAttention} open {needsAttention === 1 ? "issue" : "issues"}</Typography><Typography variant="body2" color="text.secondary">Review decisions, blockers, and failures that still need action.</Typography></Box><Button onClick={onOpenInbox}>Open Inbox</Button></Stack></Paper> : null}</> : null}

      {tab === "work" ? <>{starred.length ? <Box component="section"><Typography variant="h6" fontWeight={800} sx={{ mb: 1 }}>Starred</Typography><Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">{starred.map((item) => <Chip key={item.id} clickable icon={item.icon} deleteIcon={<StarRoundedIcon />} label={item.title} onClick={() => openResource(item)} onDelete={() => unstar(item)} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ anchor: event.currentTarget, resource: item.route }); }} sx={{ "& .MuiChip-deleteIcon, & .MuiChip-deleteIcon:hover": { color: "var(--ponderosa-star)" } }} />)}</Stack></Box> : null}

      <Box component="section">
        <Typography variant="h6" fontWeight={800} sx={{ mb: 1 }}>Recent</Typography>
        <CollectionStateFeedback request={recentDirectoryRequest} itemCount={recent.length} filtersActive={false} resourceLabel="recent work" emptyTitle="Your Recent Work Will Appear Here" emptyDetail="Create a Project to begin." />
        <Box sx={{ display: homeDirectoryRequest.hasResolved && recent.length ? "grid" : "none", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
          {recent.map((item) => <Paper key={item.id} variant="outlined" onContextMenu={(event) => { event.preventDefault(); setTabMenu({ anchor: event.currentTarget, resource: item.route }); }}><ButtonBase onClick={() => openResource(item)} sx={{ width: "100%", p: 1.5, gap: 1.25, justifyContent: "flex-start", textAlign: "left" }}><Box sx={{ width: 34, height: 34, borderRadius: 1.5, bgcolor: "action.selected", display: "grid", placeItems: "center", flexShrink: 0 }}>{item.icon}</Box><Box sx={{ minWidth: 0 }}><Typography fontWeight={750} noWrap>{item.title}</Typography><Typography variant="caption" color="text.secondary" noWrap>{item.detail}</Typography></Box></ButtonBase></Paper>)}
        </Box>
      </Box></> : null}
    </Stack>
    <ResourceContextMenu state={tabMenu} onClose={() => setTabMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
    </Box>
  </Box>;
}
