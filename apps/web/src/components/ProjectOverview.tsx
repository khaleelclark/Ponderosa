import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import SearchIcon from "@mui/icons-material/Search";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  AgentDto,
  AgentHealthDto,
  ArtifactDto,
  ConversationDto,
  EngineDto,
  ProjectDto,
  ProjectSort,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { conversationDisplayTitle } from "../conversationLabels";
import { engineAvailabilityPresentation, engineIsAvailable } from "../conversationEngine";
import {
  reorderStableIds,
  resourcePreferenceKey,
  sortWorkspaceResources,
  starredWorkspaceResources,
  toggleWorkspaceResourceStar,
  workspaceResourceSort,
  workspaceResourceSortPatch,
} from "../resourcePreferences";
import { unreadByConversation } from "../workspaceNavigation";
import { artifactDisplayLabel } from "./filePreview/ArtifactsPane";
import { ResourceContextMenu, type ResourceContextMenuState } from "./ResourceContextMenu";

function actionableProjectHealth(
  health: AgentHealthDto[] | undefined,
  agents: Pick<AgentDto, "id" | "activeEngine">[],
  engines: EngineDto[],
): { health: AgentHealthDto[] | undefined; unavailableEngineFailures: number } {
  if (!health || engines.length === 0) return { health, unavailableEngineFailures: 0 };
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const enginesById = new Map(engines.map((engine) => [engine.id, engine]));
  let unavailableEngineFailures = 0;
  const actionable = health.filter((item) => {
    if (item.status !== "failed" && item.status !== "stalled") return true;
    const engine = enginesById.get(agentsById.get(item.agentId)?.activeEngine ?? "");
    if (!engine || engineIsAvailable(engine)) return true;
    unavailableEngineFailures += 1;
    return false;
  });
  return { health: actionable, unavailableEngineFailures };
}

export function projectHealthPresentation(
  health: AgentHealthDto[] | undefined,
  agents: Pick<AgentDto, "id" | "activeEngine">[] = [],
  engines: EngineDto[] = [],
): {
  label: string;
  color: "success.main" | "info.main" | "warning.main" | "error.main" | "text.disabled";
} {
  const actionable = actionableProjectHealth(health, agents, engines).health;
  if (!actionable) return { label: "Checking", color: "text.disabled" };
  if (actionable.some((agent) => agent.status === "failed" || agent.status === "stalled")) return { label: "Needs attention", color: "error.main" };
  if (actionable.some((agent) => agent.status === "blocked" || agent.status === "interrupted")) return { label: "Blocked", color: "warning.main" };
  if (actionable.some((agent) => agent.status === "running" || agent.status === "compacting")) return { label: "Active", color: "info.main" };
  if (actionable.some((agent) => agent.status === "waiting")) return { label: "Waiting", color: "warning.main" };
  return { label: "Healthy", color: "success.main" };
}

export function projectHealthDetail(
  health: AgentHealthDto[] | undefined,
  agents: Pick<AgentDto, "id" | "activeEngine">[] = [],
  engines: EngineDto[] = [],
): string {
  const presentation = projectHealthPresentation(health, agents, engines);
  if (engines.length === 0) return `${presentation.label}. Engine availability is still loading.`;
  const { unavailableEngineFailures } = actionableProjectHealth(health, agents, engines);
  const providerDetail = engineAvailabilityPresentation(engines).detail;
  const deferredDetail = unavailableEngineFailures > 0
    ? ` ${unavailableEngineFailures} ${unavailableEngineFailures === 1 ? "agent failure is" : "agent failures are"} tied to an unavailable engine and ${unavailableEngineFailures === 1 ? "remains" : "remain"} visible in Agent details without blocking this Project.`
    : "";
  return `${presentation.label}. ${providerDetail}${deferredDetail}`;
}

function conversationGroup(updatedAt: string): "Today" | "Yesterday" | "Earlier" {
  const value = new Date(updatedAt);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const timestamp = value.getTime();
  if (timestamp >= start) return "Today";
  if (timestamp >= start - 86_400_000) return "Yesterday";
  return "Earlier";
}

function relativeChatTime(updatedAt: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(updatedAt).getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ProjectOverview({
  project,
  agents,
  healthByAgentId,
  importantArtifacts,
  conversations,
  notifications,
  preferences,
  onPreferences,
  onCreateConversation,
  onOpenConversation,
  onOpenConversationInNewTab,
  onRenameConversation,
  onDeleteConversation,
  onOpenBrowser,
  onOpenAgentWork,
  onOpenProjectFiles,
  onOpenImportantArtifact,
}: {
  project: ProjectDto;
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
  importantArtifacts: ArtifactDto[];
  conversations: ConversationDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onCreateConversation(): void;
  onOpenConversation(conversationId: string): void;
  onOpenConversationInNewTab?(conversationId: string): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onOpenBrowser(): void;
  onOpenAgentWork(): void;
  onOpenProjectFiles(): void;
  onOpenImportantArtifact(artifact: ArtifactDto): void;
}): JSX.Element {
  const [chatFilter, setChatFilter] = useState("");
  const [draggedChatId, setDraggedChatId] = useState<string>();
  const [chatMenu, setChatMenu] = useState<ResourceContextMenuState<ConversationDto>>();
  useEffect(() => {
    setChatFilter("");
    setDraggedChatId(undefined);
    setChatMenu(undefined);
  }, [project.id]);

  const work = useQuery({
    queryKey: ["agent-work", project.id, "", "", "overview"],
    queryFn: () => api.getAgentWork(project.id, { limit: 120 }),
    staleTime: 10_000,
  });
  const decisions = useQuery({
    queryKey: ["decisions", "project", project.id],
    queryFn: () => api.listDecisions({ projectId: project.id, status: "pending" }),
    staleTime: 10_000,
  });
  const browser = useQuery({
    queryKey: ["project-browser", project.id],
    queryFn: () => api.getProjectBrowser(project.id),
    retry: false,
    staleTime: 5_000,
  });

  const activeAgents = agents.filter((agent) => {
    const status = healthByAgentId.get(agent.id)?.status;
    return status === "running" || status === "compacting";
  });
  const activeWork = (work.data?.traces ?? []).filter((trace) => trace.state === "active");
  const importantOutputs = importantArtifacts
    .filter((artifact) => artifact.pinned || artifact.visibility === "published")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 3);
  const unread = useMemo(() => unreadByConversation(notifications), [notifications]);
  const chatSort = workspaceResourceSort(preferences, "chat");
  const activeConversations = useMemo(() => sortWorkspaceResources(
    conversations.filter((conversation) => !conversation.archived),
    chatSort,
    preferences.chatOrder,
    (conversation) => conversation.id,
    (conversation) => conversation.title,
    (conversation) => conversation.updatedAt,
  ), [chatSort, conversations, preferences.chatOrder]);
  const normalizedFilter = chatFilter.trim().toLocaleLowerCase();
  const visibleConversations = activeConversations.filter((conversation) =>
    !normalizedFilter || conversationDisplayTitle(conversation, activeConversations).toLocaleLowerCase().includes(normalizedFilter));
  const groupedConversations = (["Today", "Yesterday", "Earlier"] as const).map((group) => ({
    group,
    conversations: visibleConversations.filter((conversation) => conversationGroup(conversation.updatedAt) === group),
  }));
  const starred = starredWorkspaceResources(preferences);

  return <Stack spacing={1.5}>
    <Accordion defaultExpanded disableGutters variant="outlined" sx={{ borderRadius: "10px !important", "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="project-overview-content">
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", width: "100%", minWidth: 0 }}>
          <Typography variant="subtitle1" fontWeight={800} sx={{ flex: 1 }}>Project Overview</Typography>
          <Chip size="small" color={activeAgents.length ? "info" : "default"} label={`${activeAgents.length} active`} />
        </Stack>
      </AccordionSummary>
      <AccordionDetails id="project-overview-content" sx={{ pt: 0 }}>
        <Stack spacing={1.25}>
          <Box>
            <Typography variant="overline" color="text.secondary">Purpose and constraints</Typography>
            {project.instructions?.trim()
              ? <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" }}>{project.instructions.trim()}</Typography>
              : <Typography variant="body2" color="text.secondary">No Project instructions have been set. Project history remains canonical, but the current purpose is not stated as a rule.</Typography>}
          </Box>
          <Divider />
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="overline" color="text.secondary">Interactive Browser</Typography>
              <Typography variant="body2" color="text.secondary">{browser.data?.status === "ready" ? browser.data.title || browser.data.url || "Browser session active" : "No active browser session."}</Typography>
              <Button size="small" startIcon={<LanguageIcon />} onClick={onOpenBrowser} sx={{ mt: 0.5 }}>{browser.data?.status === "ready" ? "Open Tab" : "Open Browser"}</Button>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="overline" color="text.secondary">Current activity</Typography>
              {activeWork.length ? <Stack spacing={0.35}>{activeWork.slice(0, 3).map((trace) => <Typography key={trace.id} variant="body2" noWrap>{trace.title}</Typography>)}</Stack>
                : <Typography variant="body2" color="text.secondary">No coordinated work is active.</Typography>}
              {activeWork.length > 3 ? <Typography variant="caption" color="text.secondary">+{activeWork.length - 3} more active work traces</Typography> : null}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="overline" color="text.secondary">Important outputs</Typography>
              {importantOutputs.length ? <Stack spacing={0.15}>{importantOutputs.map((artifact) => <Button key={artifact.id} size="small" color="inherit" onClick={() => onOpenImportantArtifact(artifact)} sx={{ justifyContent: "flex-start", px: 0, minWidth: 0 }}><Typography variant="body2" noWrap>{artifactDisplayLabel(artifact)}</Typography></Button>)}</Stack>
                : <Typography variant="body2" color="text.secondary">No pinned or published outputs yet.</Typography>}
              <Button size="small" startIcon={<FolderOutlinedIcon />} onClick={onOpenProjectFiles} sx={{ mt: 0.5 }}>Files & Results</Button>
            </Box>
          </Stack>
          {work.isError || decisions.isError ? <Alert severity="warning">Some overview details could not be refreshed. Open the linked source view for authoritative state.</Alert> : null}
        </Stack>
      </AccordionDetails>
    </Accordion>

    <Box component="section" aria-labelledby="project-chats-title">
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, mb: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography id="project-chats-title" variant="h5" component="h2" fontWeight={800}>Project Chats</Typography>
          <Typography variant="body2" color="text.secondary">Search, organize, and open every Chat in this Project.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={onCreateConversation}>New Chat</Button>
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1.25 }}>
        <TextField
          fullWidth
          size="small"
          value={chatFilter}
          onChange={(event) => setChatFilter(event.target.value)}
          placeholder="Search Project Chats"
          inputProps={{ "aria-label": "Search Project Chats" }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
        />
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel id="project-chat-sort-label">Sort Chats</InputLabel>
          <Select
            labelId="project-chat-sort-label"
            label="Sort Chats"
            value={chatSort}
            onChange={(event) => onPreferences(workspaceResourceSortPatch("chat", event.target.value as ProjectSort))}
          >
            <MenuItem value="last_used">Recent Activity</MenuItem>
            <MenuItem value="alphabetical">Alphabetical (A–Z)</MenuItem>
            <MenuItem value="custom">Custom Order</MenuItem>
          </Select>
        </FormControl>
      </Stack>
      <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, overflow: "hidden" }}>
        {groupedConversations.map(({ group, conversations: grouped }) => grouped.length ? <Box key={group} component="section">
          <Typography variant="overline" color="text.secondary" sx={{ display: "block", px: 1.5, py: 0.75, bgcolor: "action.hover", borderBottom: 1, borderColor: "divider" }}>{group}</Typography>
          {grouped.map((conversation) => {
            const title = conversationDisplayTitle(conversation, activeConversations);
            const unreadCount = unread.get(conversation.id) ?? 0;
            const isStarred = starred.has(resourcePreferenceKey("conversation", conversation.id));
            return <Stack
              key={conversation.id}
              direction="row"
              draggable
              onDragStart={() => setDraggedChatId(conversation.id)}
              onDragEnd={() => setDraggedChatId(undefined)}
              onDragOver={(event) => { if (draggedChatId) event.preventDefault(); }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedChatId) onPreferences({
                  chatSort: "custom",
                  chatOrder: reorderStableIds(preferences.chatOrder, activeConversations.map((item) => item.id), draggedChatId, conversation.id),
                });
                setDraggedChatId(undefined);
              }}
              onContextMenu={(event) => { event.preventDefault(); setChatMenu({ anchor: event.currentTarget, resource: conversation }); }}
              sx={{ alignItems: "center", borderBottom: 1, borderColor: "divider", "&:last-of-type": { borderBottom: 0 }, opacity: draggedChatId === conversation.id ? 0.55 : 1 }}
            >
              <ListItemButton aria-label={`Open Chat ${title}`} onClick={() => onOpenConversation(conversation.id)} sx={{ minWidth: 0 }}>
                <ListItemIcon sx={{ minWidth: 40 }}><ChatBubbleOutlineIcon fontSize="small" /></ListItemIcon>
                <ListItemText
                  primary={title}
                  secondary={`${unreadCount ? `${unreadCount} unread · ` : ""}${relativeChatTime(conversation.updatedAt)}`}
                  primaryTypographyProps={{ noWrap: true, fontWeight: unreadCount ? 800 : 650 }}
                  secondaryTypographyProps={{ noWrap: true }}
                />
                {unreadCount ? <Chip size="small" color="primary" label={unreadCount} sx={{ mr: 0.5 }} /> : null}
              </ListItemButton>
              <Tooltip title={`${isStarred ? "Unstar" : "Star"} ${title}`}>
                <IconButton
                  aria-label={`${isStarred ? "Unstar" : "Star"} ${title}`}
                  onClick={() => onPreferences(toggleWorkspaceResourceStar(preferences, "conversation", conversation.id))}
                  sx={{ mr: 0.5 }}
                >{isStarred ? <StarRoundedIcon sx={{ color: "var(--ponderosa-star)" }} /> : <StarBorderRoundedIcon />}</IconButton>
              </Tooltip>
            </Stack>;
          })}
        </Box> : null)}
        {visibleConversations.length === 0 ? <Box sx={{ p: 3, textAlign: "center" }}>
          <Typography fontWeight={750}>{chatFilter.trim() ? "No matching Chats" : "No Chats Yet"}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{chatFilter.trim() ? `No Project Chats match “${chatFilter.trim()}”.` : "Create a Chat to give users and Agents a shared Project workspace."}</Typography>
          {!chatFilter.trim() ? <Button variant="contained" startIcon={<AddIcon />} onClick={onCreateConversation} sx={{ mt: 1.5 }}>New Chat</Button> : null}
        </Box> : null}
      </Box>
    </Box>
    <ResourceContextMenu
      state={chatMenu}
      onClose={() => setChatMenu(undefined)}
      onOpenInNewTab={onOpenConversationInNewTab
        ? (conversation) => onOpenConversationInNewTab(conversation.id)
        : undefined}
      actions={[
        { id: "rename", label: "Rename", onSelect: onRenameConversation },
        { id: "delete", label: "Delete", color: "error", onSelect: onDeleteConversation },
      ]}
    />
  </Stack>;
}
