import CloseIcon from "@mui/icons-material/Close";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
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
  Typography,
} from "@mui/material";
import type { ConversationDto, ProjectDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import type { Route } from "../routing";
import { announceWorkspaceRefresh } from "../hooks/useWorkspaceStream";

export interface NotificationGroup {
  key: string;
  projectId?: string;
  conversationId?: string;
  items: WorkspaceNotificationDto[];
}

export function groupNotificationsByChat(notifications: WorkspaceNotificationDto[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const item of notifications) {
    const key = `${item.projectId ?? "workspace"}\u0000${item.conversationId ?? "project"}`;
    const current = groups.get(key) ?? {
      key,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      items: [],
    };
    current.items.push(item);
    groups.set(key, current);
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const latest = (group: NotificationGroup) => group.items.reduce((value, item) => item.createdAt > value ? item.createdAt : value, "");
  return [...groups.values()].sort((a, b) => latest(b).localeCompare(latest(a)));
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
  const [error, setError] = useState<string>();
  const [respondingDecisionId, setRespondingDecisionId] = useState<string>();
  const projectIds = useMemo(() => [...new Set(notifications.map((item) => item.projectId).filter((id): id is string => Boolean(id)))], [notifications]);
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
  const groups = groupNotificationsByChat(notifications);
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

  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="notifications-title">
    <DialogTitle id="notifications-title" sx={{ pb: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h6" component="span">Notifications</Typography>
          <Typography variant="body2" color="text.secondary">{unreadCount ? `${unreadCount} unread` : "You’re all caught up"}</Typography>
        </Box>
        <IconButton aria-label="Close notifications" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
    </DialogTitle>
    <DialogContent dividers sx={{ px: { xs: 1, sm: 2 }, py: 1.5 }}>
      {error ? <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert> : null}
      <Stack spacing={1}>
        {groups.map((group) => {
          const project = projects.find((candidate) => candidate.id === group.projectId);
          const conversation = group.conversationId ? conversations.get(group.conversationId) : undefined;
          const groupUnread = group.items.filter((item) => !item.readAt).length;
          return <Box key={group.key} sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden", bgcolor: "background.paper" }}>
            <Button
              fullWidth
              disabled={!group.conversationId}
              onClick={() => {
                if (!group.conversationId) return;
                onClose();
                if (group.projectId) onNavigate({ kind: "conversation", projectId: group.projectId, conversationId: group.conversationId });
              }}
              sx={{ justifyContent: "flex-start", px: 1.5, py: 1, textAlign: "left", borderRadius: 0 }}
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="subtitle2" noWrap>{conversation?.title ?? (group.projectId ? "Project notifications" : "Ponderosa operations")}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap>{project?.label ?? (group.projectId ? "Unknown project" : "Across all Projects")}</Typography>
              </Box>
              {groupUnread ? <Badge color="primary" badgeContent={groupUnread} sx={{ mr: 1 }} /> : null}
            </Button>
            <List dense disablePadding aria-label={`Notifications for ${conversation?.title ?? project?.label ?? "project"}`}>
              {group.items.map((item) => <ListItem key={item.id} disablePadding divider>
                <ListItemButton selected={!item.readAt} onClick={() => navigateToNotification(item)} alignItems="flex-start" sx={{ gap: 1, py: 1 }}>
                  <Box aria-hidden sx={{ width: 8, height: 8, mt: .75, borderRadius: "50%", bgcolor: item.readAt ? "transparent" : "primary.main", flex: "0 0 auto" }} />
                  <ListItemText
                    primary={<Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: "center" }}><Typography variant="body2" fontWeight={item.readAt ? 600 : 800} noWrap sx={{ minWidth: 0, flex: 1 }}>{item.title}</Typography>{item.severity && item.severity !== "info" ? <Chip size="small" color={item.severity === "urgent" ? "error" : "warning"} label={item.severity === "urgent" ? "Urgent" : "Needs attention"} /> : null}<Typography variant="caption" color="text.secondary" sx={{ flex: "0 0 auto" }}>{notificationTime(item.createdAt)}</Typography></Stack>}
                    secondary={<Stack spacing={0.5}><Typography variant="body2" color="text.secondary">{item.body}</Typography>{item.kind === "decision" && item.decision && (item.status ?? "open") === "open" ? <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
                      {item.decision.options.map((option) => <Button key={option.id} size="small" variant="outlined" disabled={respondingDecisionId === item.decision!.id} onClick={(event) => { event.stopPropagation(); void respondDecision(item, option.id); }}>{option.label}</Button>)}
                      {(item.decision.allowOther || item.decision.mode === "text") ? <Button size="small" variant="outlined" disabled={respondingDecisionId === item.decision.id} onClick={(event) => { event.stopPropagation(); const answer = window.prompt(item.decision!.mode === "text" ? "Your answer" : "What should the Agent do instead?"); if (answer?.trim()) void respondDecision(item, undefined, answer.trim()); }}>{item.decision.mode === "text" ? "Answer" : "Something else"}</Button> : null}
                    </Stack> : item.kind === "operational" && (item.status ?? "open") === "open" ? <Stack direction="row" spacing={1}><Button size="small" onClick={(event) => { event.stopPropagation(); void setStatus(item, "resolved"); }}>Mark resolved</Button><Button size="small" color="inherit" onClick={(event) => { event.stopPropagation(); void setStatus(item, "dismissed"); }}>Dismiss</Button></Stack> : item.status && item.status !== "open" ? <Typography variant="caption" color="text.secondary">{item.status}</Typography> : null}</Stack>}
                    secondaryTypographyProps={{ sx: { display: "-webkit-box", overflow: "hidden", overflowWrap: "anywhere", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 } }}
                  />
                </ListItemButton>
              </ListItem>)}
            </List>
          </Box>;
        })}
        {notifications.length === 0 ? <Box sx={{ py: 5, textAlign: "center" }}><Typography fontWeight={750}>No notifications</Typography><Typography variant="body2" color="text.secondary">New agent responses and mentions will appear here.</Typography></Box> : null}
      </Stack>
    </DialogContent>
    <DialogActions sx={{ px: 2, py: 1.25 }}>
      <Button startIcon={<DoneAllIcon />} disabled={!unreadCount || Boolean(pending)} onClick={() => void markAllRead()}>Mark all read</Button>
      <Button color="error" startIcon={<DeleteSweepOutlinedIcon />} disabled={!notifications.length || Boolean(pending)} onClick={() => void clearAll()}>Clear all</Button>
    </DialogActions>
  </Dialog>;
}
