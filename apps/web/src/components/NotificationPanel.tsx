import CloseIcon from "@mui/icons-material/Close";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import {
  Alert,
  Badge,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import type { ConversationDto, ProjectDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import type { Route } from "../routing";
import { announceWorkspaceRefresh } from "../hooks/useWorkspaceStream";
import { AgentWorkInspector } from "./AgentWorkInspector";

export interface NotificationGroup {
  key: string;
  projectId?: string;
  items: WorkspaceNotificationDto[];
}

function compareNotificationsNewestFirst(a: WorkspaceNotificationDto, b: WorkspaceNotificationDto): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

export function notificationsNewestFirst(notifications: WorkspaceNotificationDto[]): WorkspaceNotificationDto[] {
  return [...notifications].sort(compareNotificationsNewestFirst);
}

export function filterNotifications(notifications: WorkspaceNotificationDto[], filter: "all" | "mentions"): WorkspaceNotificationDto[] {
  return filter === "mentions" ? notifications.filter((item) => item.kind === "mentions") : notifications;
}

export function groupNotificationsByProject(notifications: WorkspaceNotificationDto[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const item of notificationsNewestFirst(notifications)) {
    const key = item.projectId ?? "workspace";
    const current = groups.get(key) ?? {
      key,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      items: [],
    };
    current.items.push(item);
    groups.set(key, current);
  }
  for (const group of groups.values()) {
    group.items.sort(compareNotificationsNewestFirst);
  }
  return [...groups.values()].sort((a, b) => compareNotificationsNewestFirst(a.items[0]!, b.items[0]!));
}

function notificationTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function NotificationPanel({ open, projects, notifications, onClose, onNavigate, onOpenSettings }: {
  open: boolean;
  projects: ProjectDto[];
  notifications: WorkspaceNotificationDto[];
  onClose(): void;
  onNavigate(route: Route): void;
  onOpenSettings?(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<"read" | "clear">();
  const [pendingProjectId, setPendingProjectId] = useState<string>();
  const [filter, setFilter] = useState<"all" | "mentions">("all");
  const [error, setError] = useState<string>();
  const [respondingDecisionId, setRespondingDecisionId] = useState<string>();
  const [agentWorkTarget, setAgentWorkTarget] = useState<{ projectId: string; conversationId?: string; focusId?: string }>();
  const visibleNotifications = filterNotifications(notifications, filter);
  const projectIds = useMemo(() => [...new Set(visibleNotifications.map((item) => item.projectId).filter((id): id is string => Boolean(id)))], [visibleNotifications]);
  const conversationQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["conversations", projectId],
      queryFn: () => api.listConversations(projectId),
      staleTime: 10_000,
      enabled: open,
    })),
  });
  const conversations = new Map<string, ConversationDto>();
  conversationQueries.forEach((query) => query.data?.forEach((conversation) => conversations.set(conversation.id, conversation)));
  const groups = groupNotificationsByProject(visibleNotifications);
  const unreadCount = notifications.filter((item) => !item.readAt).length;

  const navigateToNotification = (item: WorkspaceNotificationDto) => {
    if (item.action?.kind === "open_settings") {
      onClose();
      onOpenSettings?.();
      return;
    }
    if (!item.projectId) return;
    onClose();
    if (item.conversationId) {
      onNavigate({
        kind: "conversation",
        projectId: item.projectId,
        conversationId: item.conversationId,
        ...(item.communicationEventId ? { focusMessageId: item.communicationEventId } : {}),
      });
      return;
    }
    onNavigate({ kind: "project", projectId: item.projectId });
  };

  const setStatus = async (item: WorkspaceNotificationDto, status: "resolved" | "dismissed") => {
    setError(undefined);
    try {
      await api.setNotificationStatus(item.id, status);
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notification could not be updated.");
    }
  };
  const respondDecision = async (item: WorkspaceNotificationDto, optionId?: string, text?: string) => {
    if (!item.decision) return;
    setRespondingDecisionId(item.decision.id);
    setError(undefined);
    try {
      await api.respondDecision(item.decision.id, { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}) });
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      await queryClient.invalidateQueries({ queryKey: ["collaboration-chat"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Decision response could not be sent.");
    } finally {
      setRespondingDecisionId(undefined);
    }
  };

  const markAllRead = async () => {
    setPending("read");
    setError(undefined);
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationDto[]>(["notifications"], (current = []) =>
      current.map((item) => item.readAt ? item : { ...item, readAt }),
    );
    try {
      await api.markAllNotificationsRead();
      announceWorkspaceRefresh();
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      await queryClient.invalidateQueries({ queryKey: ["global-search"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notifications could not be marked read.");
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } finally {
      setPending(undefined);
    }
  };

  const clearAll = async () => {
    setPending("clear");
    setError(undefined);
    queryClient.setQueryData<WorkspaceNotificationDto[]>(["notifications"], []);
    try {
      await api.clearAllNotifications();
      announceWorkspaceRefresh();
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      await queryClient.invalidateQueries({ queryKey: ["global-search"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notifications could not be cleared.");
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } finally {
      setPending(undefined);
    }
  };

  const clearProject = async (projectId: string) => {
    setPendingProjectId(projectId);
    setError(undefined);
    queryClient.setQueryData<WorkspaceNotificationDto[]>(["notifications"], (current = []) => current.filter((item) => item.projectId !== projectId));
    try {
      await api.clearProjectNotifications(projectId);
      announceWorkspaceRefresh();
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      await queryClient.invalidateQueries({ queryKey: ["global-search"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project notifications could not be cleared.");
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } finally {
      setPendingProjectId(undefined);
    }
  };

  return <><Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="notifications-title">
    <DialogTitle id="notifications-title" sx={{ pb: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h6" component="span">Notifications</Typography>
          <Typography variant="body2" color="text.secondary">{unreadCount ? `${unreadCount} unread` : "You’re all caught up"}</Typography>
        </Box>
        <IconButton aria-label="Close notifications" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
    </DialogTitle>
    <Tabs value={filter} onChange={(_event, value) => setFilter(value as "all" | "mentions")} aria-label="Notification filters" sx={{ px: { xs: 1, sm: 2 }, minHeight: 42 }}>
      <Tab value="all" label={`All (${notifications.length})`} sx={{ minHeight: 42 }} />
      <Tab value="mentions" label={`Mentions (${notifications.filter((item) => item.kind === "mentions").length})`} sx={{ minHeight: 42 }} />
    </Tabs>
    <DialogContent dividers sx={{ px: { xs: 1, sm: 2 }, py: 1.5 }}>
      {error ? <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert> : null}
      <Stack spacing={1}>
        {groups.map((group) => {
          const project = projects.find((candidate) => candidate.id === group.projectId);
          const groupUnread = group.items.filter((item) => !item.readAt).length;
          return <Box key={group.key} sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden", bgcolor: "background.paper" }}>
            <Stack direction="row" sx={{ alignItems: "center", bgcolor: "action.hover", borderBottom: 1, borderColor: "divider", pr: 1 }}>
            <Button fullWidth disabled={!group.projectId} onClick={() => { if (group.projectId) { onClose(); onNavigate({ kind: "project", projectId: group.projectId }); } }} sx={{ justifyContent: "flex-start", px: 1.5, py: 1.1, textAlign: "left", borderRadius: 0 }}>
              <Box sx={{ width: 32, height: 32, mr: 1.25, borderRadius: 1, bgcolor: "action.selected", color: "secondary.main", display: "grid", placeItems: "center", flex: "0 0 auto" }}><FolderOutlinedIcon fontSize="small" /></Box>
              <Stack spacing={.1} sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="overline" color="text.secondary" fontWeight={800} lineHeight={1.25} noWrap>{project?.label ?? (group.projectId ? "Unknown project" : "Ponderosa")}</Typography>
                <Typography variant="subtitle2" noWrap>{group.items.length} {group.items.length === 1 ? "notification" : "notifications"}</Typography>
              </Stack>
              {groupUnread ? <Badge color="primary" badgeContent={groupUnread} sx={{ mr: 1 }} /> : null}
            </Button>
            {group.projectId ? <Button size="small" color="inherit" aria-label={`Clear all notifications for ${project?.label ?? "this Project"}`} disabled={pendingProjectId === group.projectId} onClick={() => void clearProject(group.projectId!)} sx={{ flex: "0 0 auto", whiteSpace: "nowrap" }}>Clear All</Button> : null}
            </Stack>
            <List dense disablePadding aria-label={`Notifications for ${project?.label ?? "Ponderosa"}`}>
              {group.items.map((item) => <ListItem key={item.id} disablePadding>
                <ListItemButton selected={!item.readAt} onClick={() => navigateToNotification(item)} alignItems="flex-start" sx={{ gap: 1, mx: .75, my: .45, py: 1, borderRadius: 1.5 }}>
                  <Box aria-hidden sx={{ width: 8, height: 8, mt: .75, borderRadius: "50%", bgcolor: item.readAt ? "transparent" : "primary.main", flex: "0 0 auto" }} />
                  <ListItemText
                    primary={<Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: "center" }}><Typography variant="body2" fontWeight={item.readAt ? 600 : 800} noWrap sx={{ minWidth: 0, flex: 1 }}>{item.title}</Typography>{item.severity && item.severity !== "info" ? <Chip size="small" color={item.severity === "urgent" ? "error" : "warning"} label={item.severity === "urgent" ? "Urgent" : "Needs attention"} /> : null}<Typography variant="caption" color="text.secondary" sx={{ flex: "0 0 auto" }}>{notificationTime(item.createdAt)}</Typography></Stack>}
                    secondary={<Stack spacing={0.5}>{item.conversationId && conversations.get(item.conversationId) ? <Typography variant="caption" color="text.secondary">{conversations.get(item.conversationId)!.title}</Typography> : null}<Typography variant="body2" color="text.secondary">{item.body}</Typography>{item.kind === "decision" && item.decision && (item.status ?? "open") === "open" ? <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
                      {item.decision.options.map((option) => <Button key={option.id} size="small" variant="outlined" disabled={respondingDecisionId === item.decision!.id} onClick={(event) => { event.stopPropagation(); void respondDecision(item, option.id); }}>{option.label}</Button>)}
                      {(item.decision.allowOther || item.decision.mode === "text") ? <Button size="small" variant="outlined" disabled={respondingDecisionId === item.decision.id} onClick={(event) => { event.stopPropagation(); const answer = window.prompt(item.decision!.mode === "text" ? "Your answer" : "What should the Agent do instead?"); if (answer?.trim()) void respondDecision(item, undefined, answer.trim()); }}>{item.decision.mode === "text" ? "Answer" : "Something Else"}</Button> : null}
                    </Stack> : item.kind === "operational" && (item.status ?? "open") === "open" ? <Stack direction="row" spacing={1}><Button size="small" onClick={(event) => { event.stopPropagation(); void setStatus(item, "resolved"); }}>Mark Resolved</Button><Button size="small" color="inherit" onClick={(event) => { event.stopPropagation(); void setStatus(item, "dismissed"); }}>Dismiss</Button></Stack> : item.status && item.status !== "open" ? <Typography variant="caption" color="text.secondary">{item.status}</Typography> : null}
                    {item.projectId && (item.kind === "operational" || ["coordination", "trigger", "decision"].includes(item.category ?? "")) ? <Button size="small" sx={{ alignSelf: "flex-start" }} onClick={(event) => {
                      event.stopPropagation();
                      const focusId = item.decision?.id ? `decision:${item.decision.id}` : item.communicationEventId;
                      setAgentWorkTarget({ projectId: item.projectId!, ...(item.conversationId ? { conversationId: item.conversationId } : {}), ...(focusId ? { focusId } : {}) });
                      onClose();
                    }}>View Agent Work</Button> : null}</Stack>}
                    secondaryTypographyProps={{ sx: { display: "-webkit-box", overflow: "hidden", overflowWrap: "anywhere", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 } }}
                  />
                </ListItemButton>
              </ListItem>)}
            </List>
          </Box>;
        })}
        {visibleNotifications.length === 0 ? <Box sx={{ py: 5, textAlign: "center" }}><Typography fontWeight={750}>{filter === "mentions" ? "No mentions" : "No notifications"}</Typography><Typography variant="body2" color="text.secondary">{filter === "mentions" ? "Messages that mention you will appear here." : "New agent responses and mentions will appear here."}</Typography></Box> : null}
      </Stack>
    </DialogContent>
    <DialogActions sx={{ px: 2, py: 1.25 }}>
      <Button startIcon={<DoneAllIcon />} disabled={!unreadCount || Boolean(pending)} onClick={() => void markAllRead()}>Mark All Read</Button>
      <Button color="error" startIcon={<DeleteSweepOutlinedIcon />} disabled={!notifications.length || Boolean(pending)} onClick={() => void clearAll()}>Clear All</Button>
    </DialogActions>
  </Dialog>
  {agentWorkTarget ? <AgentWorkInspector
    open
    projectId={agentWorkTarget.projectId}
    conversationId={agentWorkTarget.conversationId}
    focus={agentWorkTarget.focusId ? { id: agentWorkTarget.focusId } : undefined}
    onClose={() => setAgentWorkTarget(undefined)}
  /> : null}</>;
}
