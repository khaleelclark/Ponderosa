import {
  Alert, Box, Button, ButtonBase, CircularProgress, IconButton, Stack, Tooltip, Typography,
} from "@mui/material";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import type { AllChatItemDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { useMemo, useState } from "react";
import { api } from "../api";
import { useAllChat, useWorkspacePreferences } from "../hooks/queries";
import type { Route } from "../routing";
import { ChatMessageBody } from "./chat/ChatMessages";
import { copyText } from "../clipboard";
import { agentMentionHandle } from "../mentions";
import { AttentionSurface } from "./AttentionSurface";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { ChatSurface } from "./chat/ChatSurface";
import { uniqueBy } from "../collections";

export function allChatSourceRoute(item: AllChatItemDto): Route {
  if (item.source.kind === "agent") {
    return {
      kind: "agent", projectId: item.project.id, agentId: item.source.agentId,
      focusMessageId: item.communicationEventId,
    };
  }
  return {
    kind: "conversation", projectId: item.project.id, conversationId: item.source.conversationId,
    focusMessageId: item.communicationEventId,
    ...(item.source.kind === "team" ? { channel: "collaboration" as const } : {}),
  };
}

export function mergeAllChatItems(...groups: AllChatItemDto[][]): AllChatItemDto[] {
  return uniqueBy(groups.flat(), (item) => item.communicationEventId,
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.communicationEventId.localeCompare(b.communicationEventId));
}

function sourceLabel(item: AllChatItemDto): string {
  return `${item.project.label} · ${item.source.title}`;
}

export function allChatSourceAccessibleName(item: AllChatItemDto): string {
  const normalized = item.text.replace(/\s+/gu, " ").trim();
  const excerpt = normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized || "Empty message";
  return `Select message from ${item.author.label} in ${sourceLabel(item)}, sent ${new Date(item.createdAt).toLocaleString()}: ${excerpt}`;
}

export function AllChatView({ onNavigate, notifications = [] }: { onNavigate(route: Route): void; notifications?: WorkspaceNotificationDto[] }): JSX.Element {
  const query = useAllChat();
  const workspacePreferences = useWorkspacePreferences();
  const [older, setOlder] = useState<{ items: AllChatItemDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const items = useMemo(
    () => mergeAllChatItems(older?.items ?? [], query.data?.items ?? []),
    [older?.items, query.data?.items],
  );
  const layoutKey = items.map((item) => item.communicationEventId).join(":");
  const history = older ?? {
    items: [], cursor: query.data?.history.cursor, hasMore: query.data?.history.hasMore ?? false,
  };
  const loadOlder = async () => {
    if (loadingOlder || !history.hasMore || !history.cursor) return;
    setLoadingOlder(true);
    try {
      const page = await api.getAllChat(50, history.cursor);
      setOlder((current) => ({
        items: mergeAllChatItems(page.items, current?.items ?? [], query.data?.items ?? []),
        cursor: page.history.cursor,
        hasMore: page.history.hasMore,
      }));
    } finally {
      setLoadingOlder(false);
    }
  };
  return <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: "background.default" }}>
    <Stack direction="row" spacing={1.5} sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: "center", borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h1" fontWeight={800}>All Messages</Typography>
        <Typography variant="body2" color="text.secondary">Everything sent to or from you across Ponderosa.</Typography>
      </Box>
    </Stack>
    <Box data-chat-attention-slot sx={{ minWidth: 0 }}>
      <AttentionSurface notifications={notifications} onOpen={(item) => {
        if (!item.projectId) return;
        const focusId = notificationTechnicalFocusId(item);
        if (item.action?.kind === "open_agent" && item.action.targetId) {
          onNavigate({
            kind: "agent", projectId: item.projectId, agentId: item.action.targetId, view: "technical",
            ...(focusId ? { technicalFocusId: focusId } : {}),
          });
        } else if (item.conversationId) {
          onNavigate({ kind: "projectWork", projectId: item.projectId, conversationId: item.conversationId, ...(focusId ? { focusId } : {}) });
        } else {
          onNavigate({ kind: "projectWork", projectId: item.projectId, ...(focusId ? { focusId } : {}) });
        }
      }} />
    </Box>

    <ChatSurface
      layout="workspace"
      layoutKey={layoutKey}
      label="All messages"
      follow={{ kind: "latest" }}
      history={{ kind: "cursor", hasEarlier: history.hasMore, loading: loadingOlder, label: "Load Older Messages", onLoadEarlier: () => void loadOlder() }}
      beforeMessages={<>
        {query.isLoading ? <Stack sx={{ alignItems: "center", py: 6 }}><CircularProgress size={28} /></Stack> : null}
        {query.isError ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void query.refetch()}>Retry</Button>}>Messages could not be loaded.</Alert> : null}
      </>}
    >
      <Stack spacing={1.75} sx={{ width: "100%", maxWidth: 1280, mx: "auto", py: 1 }}>
        {items.map((item) => {
          const fromUser = item.author.kind === "user";
          return <ChatMessageFrame
            key={item.communicationEventId}
            message={{
              id: `all-message-${item.communicationEventId}`,
              author: fromUser
                ? { kind: "operator", profile: workspacePreferences.data?.profile }
                : {
                    kind: "agent",
                    name: item.author.label,
                    ...(item.directMessageAgent ? { onOpen: () => onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.directMessageAgent!.id }) } : {}),
                  },
              createdAt: item.createdAt,
              ariaLabel: allChatSourceAccessibleName(item),
              body: <ChatMessageBody
                    text={item.text}
                    collapseLongMessage
                    compactMarkdown
                    projectId={item.project.id}
                    operatorHandle={workspacePreferences.data?.profile.handle}
                    agentMentionForHandle={(handle) => item.directMessageAgent && agentMentionHandle(item.directMessageAgent.title).toLocaleLowerCase() === handle.toLocaleLowerCase() ? { agentId: item.directMessageAgent.id, label: item.directMessageAgent.title } : undefined}
                    onOpenAgent={(agentId) => onNavigate({ kind: "agent", projectId: item.project.id, agentId })}
                  />,
              afterBody: <Stack direction="row" spacing={0.65} sx={{ mt: 0.5, justifyContent: fromUser ? "flex-end" : "flex-start", alignItems: "center", color: "text.secondary" }}>
                  <ButtonBase onClick={(event) => { event.stopPropagation(); onNavigate({ kind: "project", projectId: item.project.id }); }} sx={{ borderRadius: 0.75, typography: "caption", fontWeight: 650, px: 0.25 }}>{item.project.label}</ButtonBase>
                  <Typography variant="caption" aria-hidden>·</Typography>
                  <ButtonBase onClick={(event) => { event.stopPropagation(); onNavigate(allChatSourceRoute(item)); }} sx={{ borderRadius: 0.75, typography: "caption", px: 0.25 }}>{item.source.title}</ButtonBase>
                </Stack>,
              actions: <>
                  <Tooltip title="Copy"><IconButton size="small" aria-label="Copy message" onClick={() => void copyText(item.text)}><ContentCopyOutlinedIcon fontSize="inherit" /></IconButton></Tooltip>
                </>,
            }}
          />;
        })}
        {!query.isLoading && !query.isError && items.length === 0 ? <Alert severity="info">No authored chat messages yet.</Alert> : null}
      </Stack>
    </ChatSurface>

  </Box>;
}
