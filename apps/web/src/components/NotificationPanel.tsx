import CloseIcon from "@mui/icons-material/Close";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { NotificationAcknowledgementBoundary } from "./NotificationAcknowledgementBoundary";
import {
  useNotificationAcknowledgement,
  type NotificationAcknowledgementOptimisticTarget,
} from "../hooks/useNotificationAcknowledgement";

interface NotificationGroup {
  key: string;
  projectId?: string;
  items: WorkspaceNotificationDto[];
}

interface RetainedNotificationPage extends WorkspaceNotificationPageDto {
  requestedCursor: string;
}

interface HistoryOperation {
  epoch: number;
  kind: "load" | "reconcile";
  canonicalRevision: number;
  panelGeneration: number;
  startCursor: string;
  terminalBoundaryCursor?: string;
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

function notificationSummaryText(openActionCount: number, unacknowledgedActionCount: number, unreadUpdateCount: number): string {
  const actionSummary = openActionCount
    ? `${openActionCount} open action${openActionCount === 1 ? "" : "s"}${unacknowledgedActionCount ? ` · ${unacknowledgedActionCount} new` : ""}`
    : "";
  if (actionSummary && unreadUpdateCount) {
    return `${actionSummary} · ${unreadUpdateCount} unread update${unreadUpdateCount === 1 ? "" : "s"}`;
  }
  if (actionSummary) return actionSummary;
  if (unreadUpdateCount) return `${unreadUpdateCount} unread update${unreadUpdateCount === 1 ? "" : "s"}`;
  return "You’re all caught up";
}

export function NotificationPanel({ open, projects, firstPage, firstPageRevision, getFirstPageRevision, onClose, onNavigate, onOpenSettings }: {
  open: boolean;
  projects: ProjectDto[];
  firstPage?: WorkspaceNotificationPageDto;
  firstPageRevision: number;
  getFirstPageRevision(): number;
  onClose(): void;
  onNavigate(route: Route): void;
  onOpenSettings?(): void;
}): JSX.Element {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const queryClient = useQueryClient();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reconcilingOlder, setReconcilingOlder] = useState(false);
  const [historyReconcileFailed, setHistoryReconcileFailed] = useState(false);
  const [historyReconcileNonce, setHistoryReconcileNonce] = useState(0);
  const [olderPages, setOlderPages] = useState<RetainedNotificationPage[]>([]);
  const olderPagesRef = useRef<RetainedNotificationPage[]>([]);
  const panelGeneration = useRef(0);
  const operationEpoch = useRef(0);
  const activeHistoryOperation = useRef<HistoryOperation>();
  const retainedPagesCanonical = useRef(true);
  const reconciledRevision = useRef(firstPageRevision);
  const historyContext = useRef({ open, firstPageRevision, firstPageCursor: firstPage?.nextCursor ?? "" });
  if (historyContext.current.open !== open) {
    panelGeneration.current += 1;
    operationEpoch.current += 1;
    activeHistoryOperation.current = undefined;
  }
  if (historyContext.current.firstPageRevision !== firstPageRevision) {
    operationEpoch.current += 1;
    activeHistoryOperation.current = undefined;
    if (open && olderPagesRef.current.length > 0) {
      retainedPagesCanonical.current = false;
    }
  }
  historyContext.current = { open, firstPageRevision, firstPageCursor: firstPage?.nextCursor ?? "" };
  const replaceOlderPages = useCallback((
    update: (current: RetainedNotificationPage[]) => RetainedNotificationPage[],
  ) => {
    const next = update(olderPagesRef.current);
    olderPagesRef.current = next;
    setOlderPages(next);
  }, []);
  const pendingAcknowledgements = useRef(new Map<string, string>());
  const pendingReads = useRef(new Map<string, string>());
  const [filter, setFilter] = useState<NotificationFilter>("updates");
  const [error, setError] = useState<string>();
  const acknowledgeNotifications = useNotificationAcknowledgement((reason) => {
    setError(reason instanceof Error ? reason.message : "Action review could not be saved.");
  });
  const olderPagesOptimisticTarget = useMemo<NotificationAcknowledgementOptimisticTarget>(
    () => ({
      apply(notificationIds, acknowledgedAt) {
        const ids = new Set(notificationIds);
        notificationIds.forEach((id) => pendingAcknowledgements.current.set(id, acknowledgedAt));
        replaceOlderPages((current) => current.map((page) => ({
          ...page,
          items: page.items.map((item) => ids.has(item.id) && isOpenAttention(item) && !item.acknowledgedAt
            ? { ...item, acknowledgedAt }
            : item),
        })));
      },
      commit(notificationIds, acknowledgedAt) {
        notificationIds.forEach((id) => {
          if (pendingAcknowledgements.current.get(id) === acknowledgedAt) {
            pendingAcknowledgements.current.delete(id);
          }
        });
      },
      rollback(notificationIds, acknowledgedAt) {
        const ids = new Set(notificationIds);
        const revertedIds = new Set<string>();
        const deferCountIds = new Set<string>();
        if (!retainedPagesCanonical.current) {
          notificationIds.forEach((id) => deferCountIds.add(id));
        }
        replaceOlderPages((current) => current.map((page) => ({
          ...page,
          items: page.items.map((item) => {
            if (!ids.has(item.id)) return item;
            if (item.acknowledgedAt && item.acknowledgedAt !== acknowledgedAt) {
              deferCountIds.add(item.id);
              return item;
            }
            if (item.acknowledgedAt !== acknowledgedAt) return item;
            revertedIds.add(item.id);
            const { acknowledgedAt: _acknowledgedAt, ...unacknowledged } = item;
            return unacknowledged;
          }),
        })));
        notificationIds.forEach((id) => {
          if (pendingAcknowledgements.current.get(id) === acknowledgedAt) {
            pendingAcknowledgements.current.delete(id);
          }
        });
        return {
          revertedIds: [...revertedIds],
          deferCountIds: [...deferCountIds],
        };
      },
    }),
    [replaceOlderPages],
  );
  const acknowledgePresentedNotifications = (notificationIds: readonly string[]) => {
    setError(undefined);
    acknowledgeNotifications(notificationIds, olderPagesOptimisticTarget);
  };
  const wasOpen = useRef(false);
  const availableProjectIds = useMemo(
    () => new Set(projects.map(project => project.id)),
    [projects],
  );
  const notifications = useMemo(() => {
    const unique = new Map<string, WorkspaceNotificationDto>();
    for (const page of [firstPage, ...olderPages]) {
      for (const notification of page?.items ?? []) {
        if (!unique.has(notification.id)) unique.set(notification.id, notification);
      }
    }
    return notificationsForAvailableProjects([...unique.values()], availableProjectIds)
      .sort(compareNotificationsNewestFirst);
  }, [availableProjectIds, firstPage, olderPages]);
  const openActionCount = firstPage?.openActionCount ?? 0;
  const unacknowledgedActionCount = firstPage?.unacknowledgedActionCount ?? 0;
  const unreadUpdateCount = firstPage?.unreadUpdateCount ?? 0;
  const nextCursor = olderPages.length > 0
    ? olderPages.at(-1)?.nextCursor
    : firstPage?.nextCursor;
  const liveFirstPageRevision = getFirstPageRevision();
  const revisionUnreconciled = open && (
    reconciledRevision.current !== firstPageRevision ||
    liveFirstPageRevision !== firstPageRevision
  );
  const historyOperationActive = Boolean(activeHistoryOperation.current);
  useEffect(() => {
    if (open && !wasOpen.current) {
      replaceOlderPages(() => []);
      retainedPagesCanonical.current = true;
      reconciledRevision.current = firstPageRevision;
      pendingAcknowledgements.current.clear();
      pendingReads.current.clear();
      setHistoryReconcileFailed(false);
      setFilter(openActionCount ? "attention" : "updates");
    }
    if (!open) {
      setLoadingOlder(false);
      setReconcilingOlder(false);
    }
    wasOpen.current = open;
  }, [firstPageRevision, openActionCount, open, replaceOlderPages]);

  useEffect(() => {
    if (!open || !firstPage || reconciledRevision.current === firstPageRevision) return;
    if (olderPagesRef.current.length === 0) {
      retainedPagesCanonical.current = true;
      reconciledRevision.current = firstPageRevision;
      setLoadingOlder(false);
      return;
    }
    const priorPages = olderPagesRef.current;
    const loadedPageCount = priorPages.length;
    const priorLastPage = priorPages.at(-1)!;
    const priorTailWasTerminal = !priorLastPage.nextCursor;
    const priorTailBoundary = priorTailWasTerminal ? {
      id: notificationsNewestFirst(priorLastPage.items).at(-1)?.id,
      cursor: priorLastPage.requestedCursor,
    } : undefined;
    const epoch = ++operationEpoch.current;
    const operation: HistoryOperation = {
      epoch,
      kind: "reconcile",
      canonicalRevision: firstPageRevision,
      panelGeneration: panelGeneration.current,
      startCursor: firstPage.nextCursor ?? "",
      ...(priorTailBoundary ? { terminalBoundaryCursor: priorTailBoundary.cursor } : {}),
    };
    activeHistoryOperation.current = operation;
    const operationIsCurrent = () =>
      activeHistoryOperation.current === operation &&
      activeHistoryOperation.current?.kind === operation.kind &&
      operationEpoch.current === operation.epoch &&
      historyContext.current.open &&
      historyContext.current.firstPageRevision === operation.canonicalRevision &&
      getFirstPageRevision() === operation.canonicalRevision &&
      historyContext.current.firstPageCursor === operation.startCursor &&
      operation.terminalBoundaryCursor === priorTailBoundary?.cursor &&
      panelGeneration.current === operation.panelGeneration;
    const reconcile = async () => {
      setLoadingOlder(false);
      setReconcilingOlder(true);
      setHistoryReconcileFailed(false);
      try {
        const pages: RetainedNotificationPage[] = [];
        let cursor = firstPage.nextCursor;
        for (let index = 0; index < loadedPageCount && cursor; index += 1) {
          const requestedCursor = cursor;
          const page = await api.listNotifications(requestedCursor);
          if (!operationIsCurrent()) return;
          if (page.nextCursor === requestedCursor) {
            throw new Error("Notification history did not advance.");
          }
          pages.push({ ...page, requestedCursor });
          cursor = page.nextCursor;
        }
        if (priorTailBoundary?.id && !pages.some((page) => page.items.some((item) => item.id === priorTailBoundary.id)) && cursor) {
          const requestedCursor = cursor;
          const spillPage = await api.listNotifications(requestedCursor);
          if (!operationIsCurrent()) return;
          if (spillPage.nextCursor === requestedCursor) {
            throw new Error("Notification history did not advance.");
          }
          pages.push({ ...spillPage, requestedCursor });
          cursor = spillPage.nextCursor;
        }
        if (
          priorTailWasTerminal &&
          priorTailBoundary?.id &&
          !pages.some((page) => page.items.some((item) => item.id === priorTailBoundary.id)) &&
          cursor
        ) {
          throw new Error("The previously loaded end of notification history moved beyond the bounded refresh. Retry to restore the complete loaded history.");
        }
        if (!operationIsCurrent()) return;
        replaceOlderPages(() => pages.map((page) => ({
          ...page,
          items: page.items.map((item) => {
            const acknowledgedAt = pendingAcknowledgements.current.get(item.id);
            const readAt = pendingReads.current.get(item.id);
            if (item.acknowledgedAt) pendingAcknowledgements.current.delete(item.id);
            if (item.readAt) pendingReads.current.delete(item.id);
            return {
              ...item,
              ...(!item.acknowledgedAt && acknowledgedAt ? { acknowledgedAt } : {}),
              ...(!item.readAt && readAt ? { readAt } : {}),
            };
          }),
        })));
        retainedPagesCanonical.current = true;
        reconciledRevision.current = firstPageRevision;
      } catch (reason) {
        if (!operationIsCurrent()) return;
        setHistoryReconcileFailed(true);
        setError(reason instanceof Error
          ? `Loaded notification history could not be refreshed: ${reason.message}`
          : "Loaded notification history could not be refreshed.");
      } finally {
        if (operationIsCurrent()) {
          activeHistoryOperation.current = undefined;
          setReconcilingOlder(false);
        }
      }
    };
    void reconcile();
    return () => {
      if (activeHistoryOperation.current === operation) {
        operationEpoch.current += 1;
        activeHistoryOperation.current = undefined;
      }
    };
  }, [firstPage?.nextCursor, firstPageRevision, getFirstPageRevision, historyReconcileNonce, open, replaceOlderPages]);
  const visibleNotifications = filterNotifications(notifications, filter);
  const totalForFilter = filter === "attention" ? openActionCount : unreadUpdateCount;
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
    const currentPages = olderPagesRef.current;
    const currentNextCursor = currentPages.length > 0
      ? currentPages.at(-1)?.nextCursor
      : firstPage?.nextCursor;
    if (
      !currentNextCursor ||
      activeHistoryOperation.current ||
      reconciledRevision.current !== historyContext.current.firstPageRevision ||
      getFirstPageRevision() !== historyContext.current.firstPageRevision ||
      !historyContext.current.open
    ) return;
    const operation: HistoryOperation = {
      epoch: ++operationEpoch.current,
      kind: "load",
      canonicalRevision: historyContext.current.firstPageRevision,
      panelGeneration: panelGeneration.current,
      startCursor: currentNextCursor,
    };
    activeHistoryOperation.current = operation;
    const operationIsCurrent = () =>
      activeHistoryOperation.current === operation &&
      activeHistoryOperation.current?.kind === operation.kind &&
      operationEpoch.current === operation.epoch &&
      historyContext.current.open &&
      historyContext.current.firstPageRevision === operation.canonicalRevision &&
      getFirstPageRevision() === operation.canonicalRevision &&
      panelGeneration.current === operation.panelGeneration;
    setLoadingOlder(true);
    setError(undefined);
    try {
      const page = await api.listNotifications(operation.startCursor);
      if (!operationIsCurrent()) return;
      if (page.nextCursor === operation.startCursor) throw new Error("Notification history did not advance.");
      const current = olderPagesRef.current;
      const expectedCursor = current.length > 0 ? current.at(-1)?.nextCursor : firstPage?.nextCursor;
      if (expectedCursor !== operation.startCursor) return;
      replaceOlderPages((pages) => [...pages, {
        ...page,
        requestedCursor: operation.startCursor,
        items: page.items.map((item) => {
          const acknowledgedAt = pendingAcknowledgements.current.get(item.id);
          const readAt = pendingReads.current.get(item.id);
          return {
            ...item,
            ...(!item.acknowledgedAt && acknowledgedAt ? { acknowledgedAt } : {}),
            ...(!item.readAt && readAt ? { readAt } : {}),
          };
        }),
      }]);
    } catch (reason) {
      if (operationIsCurrent()) {
        setError(reason instanceof Error ? reason.message : "Older notifications could not be loaded.");
      }
    } finally {
      if (operationIsCurrent()) {
        activeHistoryOperation.current = undefined;
        setLoadingOlder(false);
      }
    }
  };

  const markRead = (item: WorkspaceNotificationDto) => {
    const readAt = new Date().toISOString();
    pendingReads.current.set(item.id, readAt);
    queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, (current) => current ? ({
      ...current,
      items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, readAt } : candidate),
      unreadUpdateCount: isUnreadNotificationUpdate(item)
        ? Math.max(0, current.unreadUpdateCount - 1)
        : current.unreadUpdateCount,
    }) : current);
    replaceOlderPages((current) => current.map((page) => ({
      ...page,
      items: page.items.map((candidate) => candidate.id === item.id ? { ...candidate, readAt } : candidate),
    })));
    void api.markNotificationRead(item.id).then(() => {
      if (pendingReads.current.get(item.id) === readAt) pendingReads.current.delete(item.id);
      return queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    }).catch((reason) => {
      let reverted = false;
      let deferCountRollback = !retainedPagesCanonical.current;
      queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, (current) => {
        if (!current) return current;
        const items = current.items.map((candidate) => {
          if (candidate.id !== item.id) return candidate;
          if (candidate.readAt && candidate.readAt !== readAt) {
            deferCountRollback = true;
            return candidate;
          }
          if (candidate.readAt !== readAt) return candidate;
          reverted = true;
          const { readAt: _readAt, ...unread } = candidate;
          return unread;
        });
        return { ...current, items };
      });
      replaceOlderPages((current) => current.map((page) => ({
        ...page,
        items: page.items.map((candidate) => {
          if (candidate.id !== item.id) return candidate;
          if (candidate.readAt && candidate.readAt !== readAt) {
            deferCountRollback = true;
            return candidate;
          }
          if (candidate.readAt !== readAt) return candidate;
          reverted = true;
          const { readAt: _readAt, ...unread } = candidate;
          return unread;
        }),
      })));
      if (reverted && !deferCountRollback && isUnreadNotificationUpdate(item)) {
        queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, (current) => current ? ({
          ...current,
          unreadUpdateCount: current.unreadUpdateCount + 1,
        }) : current);
      }
      if (pendingReads.current.get(item.id) === readAt) pendingReads.current.delete(item.id);
      setError(reason instanceof Error ? reason.message : "Notification could not be marked read.");
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    });
  };
  const navigateToNotification = (item: WorkspaceNotificationDto) => {
    if (isOpenAttention(item)) acknowledgePresentedNotifications([item.id]);
    else if (!item.readAt) markRead(item);
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
  return <><Dialog open={open} onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="md" aria-labelledby="notifications-title" PaperProps={{ sx: { overflow: "hidden", maxHeight: fullScreen ? "100%" : "85dvh" } }}>
    <Box component="header" sx={{ px: 3, pt: 2, pb: 1, flexShrink: 0 }}>
      <Typography
        id="notifications-title"
        component="h2"
        sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}
      >
        Notifications
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h6" component="span" aria-hidden="true">Notifications</Typography>
          <Typography variant="body2" color="text.secondary">{notificationSummaryText(openActionCount, unacknowledgedActionCount, unreadUpdateCount)}</Typography>
        </Box>
        <IconButton aria-label="Close notifications" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
    </Box>
    <Tabs value={filter} onChange={(_event, value) => setFilter(value as NotificationFilter)} aria-label="Notification filters" sx={{ px: { xs: 1, sm: 2 }, minHeight: 42 }}>
      <Tab value="attention" label={`Needs Action (${openActionCount})`} sx={{ minHeight: 42 }} />
      <Tab value="updates" label={`Updates (${unreadUpdateCount})`} sx={{ minHeight: 42 }} />
    </Tabs>
    <DialogContent dividers sx={{ px: { xs: 1, sm: 2 }, py: 1.5, overflowX: "hidden", minWidth: 0 }}>
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
                <Typography variant="subtitle2" noWrap>{group.items.length} {filter === "attention" ? (group.items.length === 1 ? "open action" : "open actions") : (group.items.length === 1 ? "unread update" : "unread updates")}</Typography>
              </Stack>
            </Button>
            </Stack>
            <List dense disablePadding aria-label={`Notifications for ${project?.label ?? "Ponderosa"}`}>
              {group.items.map((item) => <ListItem key={item.id} disablePadding sx={{ "& > [data-notification-id]": { width: "100%", minWidth: 0 } }}>
                <NotificationAcknowledgementBoundary notificationId={item.id} acknowledged={Boolean(item.acknowledgedAt) || !isOpenAttention(item)} onAcknowledge={acknowledgePresentedNotifications}>
                <ListItemButton selected={filter === "updates" ? !item.readAt : !item.acknowledgedAt} onClick={() => navigateToNotification(item)} alignItems="flex-start" sx={{ gap: 1, mx: .75, my: .45, py: 1, borderRadius: 1.5 }}>
                  <Box aria-hidden sx={{ width: 8, height: 8, mt: .75, borderRadius: "50%", bgcolor: filter === "updates" ? "primary.main" : item.acknowledgedAt ? "action.disabled" : item.severity === "urgent" ? "error.main" : "warning.main", flex: "0 0 auto" }} />
                  <ListItemText
                    sx={{ minWidth: 0, overflowWrap: "anywhere" }}
                    primary={<Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: "center" }}><Typography variant="body2" fontWeight={(filter === "attention" ? item.acknowledgedAt : item.readAt) ? 600 : 800} noWrap sx={{ minWidth: 0, flex: 1 }}>{item.title}</Typography>{filter === "attention" && !item.acknowledgedAt ? <Chip size="small" color="primary" label="New" /> : item.severity && item.severity !== "info" ? <Chip size="small" color={item.severity === "urgent" ? "error" : "warning"} label={item.severity === "urgent" ? "Urgent" : "Issue"} /> : null}<Typography variant="caption" color="text.secondary" sx={{ flex: "0 0 auto" }}>{notificationTime(item.createdAt)}</Typography></Stack>}
                    secondary={<Stack spacing={0.5}>{affectedAgentLabel(item) ? <Typography variant="caption" color="text.secondary">Affected Agent · {affectedAgentLabel(item)}</Typography> : null}{item.conversationId && conversations.get(item.conversationId) ? <Typography variant="caption" color="text.secondary">{conversations.get(item.conversationId)!.title}</Typography> : null}<Typography variant="body2" color="text.secondary" sx={{ display: "-webkit-box", overflow: "hidden", overflowWrap: "anywhere", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}>{item.body}</Typography>{item.kind === "decision" && item.decision && (item.status ?? "open") === "open"
                      ? <DecisionActions decision={notificationDecision(item)!} compact />
                      : item.status && item.status !== "open" ? <Typography variant="caption" color="text.secondary">{item.status}</Typography> : null}
                    <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: .5 }}>
                    {item.kind === "operational" && (item.status ?? "open") === "open" ? <Button size="small" onClick={(event) => { event.stopPropagation(); void setStatus(item, "resolved"); }}>Mark Resolved</Button> : null}
                    {item.projectId && (item.kind === "operational" || ["coordination", "trigger", "decision"].includes(item.category ?? "")) ? <Button size="small" onClick={(event) => {
                      event.stopPropagation();
                      const route = notificationWorkRoute(item, availableProjectIds);
                      if (route) {
                        onClose();
                        onNavigate(route);
                      }
                    }}>Review Work Details</Button> : null}
                    {item.kind === "operational" && (item.status ?? "open") === "open" ? <Button size="small" color="inherit" sx={{ ml: "auto" }} onClick={(event) => { event.stopPropagation(); void setStatus(item, "dismissed"); }}>Dismiss</Button> : null}
                    </Box></Stack>}
                    secondaryTypographyProps={{ component: "div" }}
                  />
                </ListItemButton>
                </NotificationAcknowledgementBoundary>
              </ListItem>)}
            </List>
          </Box>;
        })}
        {visibleNotifications.length === 0 && totalForFilter === 0 ? <Box sx={{ py: 5, textAlign: "center" }}><Typography fontWeight={750}>{filter === "attention" ? "Nothing needs attention" : "No unread updates"}</Typography><Typography variant="body2" color="text.secondary">{filter === "attention" ? "Open decisions, blockers, and failures stay here until they are resolved or dismissed." : "New Agent responses and broadcasts will appear here."}</Typography></Box> : null}
        {reconcilingOlder ? <Typography variant="caption" color="text.secondary" role="status">
          Refreshing loaded notification history…
        </Typography> : null}
        {historyReconcileFailed ? <Button onClick={() => {
          setError(undefined);
          setHistoryReconcileNonce((current) => current + 1);
        }}>Retry notification refresh</Button> : null}
        {nextCursor ? <Button disabled={loadingOlder || reconcilingOlder || revisionUnreconciled || historyOperationActive || historyReconcileFailed} onClick={() => void loadOlder()}>
          {loadingOlder ? "Loading older notifications…" : reconcilingOlder
            ? "Refreshing loaded notifications…" : remainingForFilter
            ? `Load older (${remainingForFilter} ${filter === "attention" ? "attention" : "updates"} remaining)`
            : "Load older notifications"}
        </Button> : null}
      </Stack>
    </DialogContent>
  </Dialog>
  </>;
}
