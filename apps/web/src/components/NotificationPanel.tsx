import CloseIcon from "@mui/icons-material/Close";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import {
  Alert,
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
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { ConversationDto, ProjectDto, WorkspaceNotificationDto, WorkspaceNotificationPageDto } from "@ponderosa/core";
import { queryKeys } from "../queryKeys";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Route } from "../routing";
import {
  isOpenAttention,
  isUnreadNotificationUpdate,
  notificationsForAvailableProjects,
} from "../attention";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { notificationDecision } from "../decisions";
import { DecisionActions } from "./decisions/DecisionActions";

interface NotificationGroup {
  key: string;
  projectId?: string;
  items: WorkspaceNotificationDto[];
}

function compareNotificationsNewestFirst(a: WorkspaceNotificationDto, b: WorkspaceNotificationDto): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function notificationsNewestFirst(notifications: WorkspaceNotificationDto[]): WorkspaceNotificationDto[] {
  return [...notifications].sort(compareNotificationsNewestFirst);
}

type NotificationFilter = "attention" | "updates";

function filterNotifications(notifications: WorkspaceNotificationDto[], filter: NotificationFilter): WorkspaceNotificationDto[] {
  return notifications.filter(filter === "attention" ? isOpenAttention : isUnreadNotificationUpdate);
}

function groupNotificationsByProject(notifications: WorkspaceNotificationDto[]): NotificationGroup[] {
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

function notificationWorkRoute(
  item: WorkspaceNotificationDto,
  availableProjectIds: ReadonlySet<string>,
): Route | undefined {
  if (!item.projectId || !availableProjectIds.has(item.projectId)) return undefined;
  const focusId = notificationTechnicalFocusId(item);
  if (item.action?.kind === "open_agent" && item.action.targetId) {
    return {
      kind: "agent", projectId: item.projectId, agentId: item.action.targetId, view: "technical",
      ...(focusId ? { technicalFocusId: focusId } : {}),
    };
  }
  return {
    kind: "projectWork", projectId: item.projectId,
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    ...(focusId ? { focusId } : {}),
  };
}

export function notificationNavigationRoute(
  item: WorkspaceNotificationDto,
  availableProjectIds: ReadonlySet<string>,
): Route | undefined {
  if (!item.projectId || !availableProjectIds.has(item.projectId)) return undefined;
  if (item.action?.kind === "open_agent" && item.action.targetId) {
    return {
      kind: "agent",
      projectId: item.projectId,
      agentId: item.action.targetId,
      ...(item.category === "coordination" ? { view: "technical" as const } : {}),
    };
  }
  if (item.conversationId) {
    return {
      kind: "conversation",
      projectId: item.projectId,
      conversationId: item.conversationId,
      ...(item.communicationEventId
        ? { focusMessageId: item.communicationEventId }
        : {}),
    };
  }
  return { kind: "project", projectId: item.projectId };
}

function notificationTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function affectedAgentLabel(item: WorkspaceNotificationDto): string | undefined {
  if (!item.agentId) return undefined;
  return item.agentTitle ?? `Agent ${item.agentId.slice(0, 8)}`;
}

function notificationSummaryText(attentionCount: number, unreadUpdateCount: number): string {
  if (attentionCount && unreadUpdateCount) {
    return `${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} attention · ${unreadUpdateCount} unread update${unreadUpdateCount === 1 ? "" : "s"}`;
  }
  if (attentionCount) return `${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} attention`;
  if (unreadUpdateCount) return `${unreadUpdateCount} unread update${unreadUpdateCount === 1 ? "" : "s"}`;
  return "You’re all caught up";
}

export function NotificationPanel({ open, projects, firstPage, onClose, onNavigate, onOpenSettings }: {
  open: boolean;
  projects: ProjectDto[];
  firstPage?: WorkspaceNotificationPageDto;
  onClose(): void;
  onNavigate(route: Route): void;
  onOpenSettings?(): void;
}): JSX.Element {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const queryClient = useQueryClient();
  const [markingRead, setMarkingRead] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderPages, setOlderPages] = useState<WorkspaceNotificationPageDto[]>([]);
  const [filter, setFilter] = useState<NotificationFilter>("updates");
  const [error, setError] = useState<string>();
  const wasOpen = useRef(false);
  const availableProjectIds = useMemo(
    () => new Set(projects.map(project => project.id)),
    [projects],
  );
  useEffect(() => {
    setOlderPages([]);
  }, [firstPage]);
  const notifications = useMemo(() => {
    const unique = new Map<string, WorkspaceNotificationDto>();
    for (const page of [firstPage, ...olderPages]) {
      for (const notification of page?.items ?? []) unique.set(notification.id, notification);
    }
    return notificationsForAvailableProjects([...unique.values()], availableProjectIds)
      .sort(compareNotificationsNewestFirst);
  }, [availableProjectIds, firstPage, olderPages]);
  const attentionCount = firstPage?.attentionCount ?? 0;
  const unreadUpdateCount = firstPage?.unreadUpdateCount ?? 0;
  const nextCursor = olderPages.at(-1)?.nextCursor ?? firstPage?.nextCursor;
  useEffect(() => {
    if (open && !wasOpen.current) {
      setFilter(attentionCount ? "attention" : "updates");
    }
    wasOpen.current = open;
  }, [attentionCount, open]);
  const visibleNotifications = filterNotifications(notifications, filter);
  const totalForFilter = filter === "attention" ? attentionCount : unreadUpdateCount;
  const remainingForFilter = Math.max(0, totalForFilter - visibleNotifications.length);
  const projectIds = useMemo(() => [...new Set(visibleNotifications.map((item) => item.projectId).filter((id): id is string => Boolean(id)))], [visibleNotifications]);
  const conversationQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: queryKeys.conversations.project(projectId),
      queryFn: () => api.listConversations(projectId),
      staleTime: 10_000,
      enabled: open,
    })),
  });
  const conversations = new Map<string, ConversationDto>();
  conversationQueries.forEach((query) => query.data?.forEach((conversation) => conversations.set(conversation.id, conversation)));
  const groups = groupNotificationsByProject(visibleNotifications);

  const loadOlder = async () => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    setError(undefined);
    try {
      const page = await api.listNotifications(nextCursor);
      if (page.nextCursor === nextCursor) throw new Error("Notification history did not advance.");
      setOlderPages((current) => [...current, page]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Older notifications could not be loaded.");
    } finally {
      setLoadingOlder(false);
    }
  };

  const markRead = (item: WorkspaceNotificationDto) => {
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, (current) => current ? ({
      ...current,
      items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, readAt } : candidate),
      unreadUpdateCount: isUnreadNotificationUpdate(item)
        ? Math.max(0, current.unreadUpdateCount - 1)
        : current.unreadUpdateCount,
    }) : current);
    setOlderPages((current) => current.map((page) => ({
      ...page,
      items: page.items.map((candidate) => candidate.id === item.id ? { ...candidate, readAt } : candidate),
    })));
    void api.markNotificationRead(item.id).then(() => {
      return queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "Notification could not be marked read.");
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    });
  };
  const navigateToNotification = (item: WorkspaceNotificationDto) => {
    if (!item.readAt) markRead(item);
    if (item.action?.kind === "open_settings") {
      onClose();
      onOpenSettings?.();
      return;
    }
    const destination = notificationNavigationRoute(item, availableProjectIds);
    if (!destination) return;
    onClose();
    onNavigate(destination);
  };

  const setStatus = async (item: WorkspaceNotificationDto, status: "resolved" | "dismissed") => {
    setError(undefined);
    try {
      await api.setNotificationStatus(item.id, status);
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notification could not be updated.");
    }
  };
  const markAllRead = async () => {
    setMarkingRead(true);
    setError(undefined);
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, (current) => current ? ({
      ...current,
      items: current.items.map((item) => isUnreadNotificationUpdate(item) ? { ...item, readAt } : item),
      unreadUpdateCount: 0,
    }) : current);
    setOlderPages((current) => current.map((page) => ({
      ...page,
      items: page.items.map((item) => isUnreadNotificationUpdate(item) ? { ...item, readAt } : item),
    })));
    try {
      await api.markAllNotificationsRead();
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.globalSearch.all });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notifications could not be marked read.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    } finally {
      setMarkingRead(false);
    }
  };

  return <><Dialog open={open} onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="sm" aria-labelledby="notifications-title">
    <DialogTitle id="notifications-title" sx={{ pb: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h6" component="span">Notifications</Typography>
          <Typography variant="body2" color="text.secondary">{notificationSummaryText(attentionCount, unreadUpdateCount)}</Typography>
        </Box>
        <IconButton aria-label="Close notifications" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
    </DialogTitle>
    <Tabs value={filter} onChange={(_event, value) => setFilter(value as NotificationFilter)} aria-label="Notification filters" sx={{ px: { xs: 1, sm: 2 }, minHeight: 42 }}>
      <Tab value="attention" label={`Needs attention (${attentionCount})`} sx={{ minHeight: 42 }} />
      <Tab value="updates" label={`Updates (${unreadUpdateCount})`} sx={{ minHeight: 42 }} />
    </Tabs>
    <DialogContent dividers sx={{ px: { xs: 1, sm: 2 }, py: 1.5 }}>
      {error ? <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert> : null}
      <Stack spacing={1}>
        {groups.map((group) => {
          const project = projects.find((candidate) => candidate.id === group.projectId);
          return <Box key={group.key} sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden", bgcolor: "background.paper" }}>
            <Stack direction="row" sx={{ alignItems: "center", bgcolor: "action.hover", borderBottom: 1, borderColor: "divider" }}>
            <Button fullWidth disabled={!project} onClick={() => { if (project) { onClose(); onNavigate({ kind: "project", projectId: project.id }); } }} sx={{ justifyContent: "flex-start", px: 1.5, py: 1.1, textAlign: "left", borderRadius: 0 }}>
              <Box sx={{ width: 32, height: 32, mr: 1.25, borderRadius: 1, bgcolor: "action.selected", color: "secondary.main", display: "grid", placeItems: "center", flex: "0 0 auto" }}><FolderOutlinedIcon fontSize="small" /></Box>
              <Stack spacing={.1} sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="overline" color="text.secondary" fontWeight={800} lineHeight={1.25} noWrap>{project?.label ?? (group.projectId ? "Unknown project" : "Ponderosa")}</Typography>
                <Typography variant="subtitle2" noWrap>{group.items.length} {filter === "attention" ? (group.items.length === 1 ? "item needs attention" : "items need attention") : (group.items.length === 1 ? "unread update" : "unread updates")}</Typography>
              </Stack>
            </Button>
            </Stack>
            <List dense disablePadding aria-label={`Notifications for ${project?.label ?? "Ponderosa"}`}>
              {group.items.map((item) => <ListItem key={item.id} disablePadding>
                <ListItemButton selected={filter === "updates" && !item.readAt} onClick={() => navigateToNotification(item)} alignItems="flex-start" sx={{ gap: 1, mx: .75, my: .45, py: 1, borderRadius: 1.5 }}>
                  <Box aria-hidden sx={{ width: 8, height: 8, mt: .75, borderRadius: "50%", bgcolor: filter === "updates" ? "primary.main" : item.severity === "urgent" ? "error.main" : "warning.main", flex: "0 0 auto" }} />
                  <ListItemText
                    primary={<Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: "center" }}><Typography variant="body2" fontWeight={item.readAt ? 600 : 800} noWrap sx={{ minWidth: 0, flex: 1 }}>{item.title}</Typography>{item.severity && item.severity !== "info" ? <Chip size="small" color={item.severity === "urgent" ? "error" : "warning"} label={item.severity === "urgent" ? "Urgent" : "Issue"} /> : null}<Typography variant="caption" color="text.secondary" sx={{ flex: "0 0 auto" }}>{notificationTime(item.createdAt)}</Typography></Stack>}
                    secondary={<Stack spacing={0.5}>{affectedAgentLabel(item) ? <Typography variant="caption" color="text.secondary">Affected Agent · {affectedAgentLabel(item)}</Typography> : null}{item.conversationId && conversations.get(item.conversationId) ? <Typography variant="caption" color="text.secondary">{conversations.get(item.conversationId)!.title}</Typography> : null}<Typography variant="body2" color="text.secondary" sx={{ display: "-webkit-box", overflow: "hidden", overflowWrap: "anywhere", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}>{item.body}</Typography>{item.kind === "decision" && item.decision && (item.status ?? "open") === "open"
                      ? <DecisionActions decision={notificationDecision(item)!} compact />
                      : item.kind === "operational" && (item.status ?? "open") === "open" ? <Stack direction="row" spacing={1}><Button size="small" onClick={(event) => { event.stopPropagation(); void setStatus(item, "resolved"); }}>Mark Resolved</Button><Button size="small" color="inherit" onClick={(event) => { event.stopPropagation(); void setStatus(item, "dismissed"); }}>Dismiss</Button></Stack> : item.status && item.status !== "open" ? <Typography variant="caption" color="text.secondary">{item.status}</Typography> : null}
                    {item.projectId && (item.kind === "operational" || ["coordination", "trigger", "decision"].includes(item.category ?? "")) ? <Button size="small" sx={{ alignSelf: "flex-start" }} onClick={(event) => {
                      event.stopPropagation();
                      const route = notificationWorkRoute(item, availableProjectIds);
                      if (route) {
                        onClose();
                        onNavigate(route);
                      }
                    }}>Review Work Details</Button> : null}</Stack>}
                    secondaryTypographyProps={{ component: "div" }}
                  />
                </ListItemButton>
              </ListItem>)}
            </List>
          </Box>;
        })}
        {visibleNotifications.length === 0 && totalForFilter === 0 ? <Box sx={{ py: 5, textAlign: "center" }}><Typography fontWeight={750}>{filter === "attention" ? "Nothing needs attention" : "No unread updates"}</Typography><Typography variant="body2" color="text.secondary">{filter === "attention" ? "Open decisions, blockers, and failures stay here until they are resolved or dismissed." : "New Agent responses and broadcasts will appear here."}</Typography></Box> : null}
        {nextCursor ? <Button disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? "Loading older notifications…" : remainingForFilter
            ? `Load older (${remainingForFilter} ${filter === "attention" ? "attention" : "updates"} remaining)`
            : "Load older notifications"}
        </Button> : null}
      </Stack>
    </DialogContent>
    {unreadUpdateCount ? <DialogActions sx={{ px: 2, py: 1.25 }}>
      <Button startIcon={<DoneAllIcon />} disabled={markingRead} onClick={() => void markAllRead()}>Mark Updates Read</Button>
    </DialogActions> : null}
  </Dialog>
  </>;
}
