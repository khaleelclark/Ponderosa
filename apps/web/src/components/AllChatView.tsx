import {
  Alert, Avatar, Box, Button, ButtonBase, CircularProgress, Stack, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import type { AllChatItemDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAllChat, useWorkspacePreferences } from "../hooks/queries";
import type { Route } from "../routing";
import { ChatMessageBody, Composer, isChatNearBottom, ScrollToLatestButton, scrollChatToBottom, UserMessageLabel } from "./panes";
import { MessageTimestamp } from "./MessageTimestamp";
import { useMobileComposerAutoHide } from "../mobileChat";

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
  const byId = new Map<string, AllChatItemDto>();
  for (const item of groups.flat()) byId.set(item.communicationEventId, item);
  return [...byId.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.communicationEventId.localeCompare(b.communicationEventId));
}

function sourceLabel(item: AllChatItemDto): string {
  return `${item.project.label} · ${item.source.title}`;
}

export function allChatSourceAccessibleName(item: AllChatItemDto): string {
  const normalized = item.text.replace(/\s+/gu, " ").trim();
  const excerpt = normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized || "Empty message";
  return `Select message from ${item.author.label} in ${sourceLabel(item)}, sent ${new Date(item.createdAt).toLocaleString()}: ${excerpt}`;
}

export function allChatReplyUnavailableMessage(item: AllChatItemDto): string | undefined {
  if (item.author.kind === "user") return "You cannot message yourself. Select an Agent-authored message to reply privately to that Agent.";
  if (!item.directMessageAgent) return "This message does not identify one active Agent you can reply to. Messages can send only a private reply to the selected Agent.";
  return undefined;
}

export function AllChatView({ onNavigate }: { onNavigate(route: Route): void }): JSX.Element {
  const queryClient = useQueryClient();
  const query = useAllChat();
  const workspacePreferences = useWorkspacePreferences();
  const [older, setOlder] = useState<{ items: AllChatItemDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [mobileTimestampId, setMobileTimestampId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstLayout = useRef(true);
  const followLatest = useRef(true);
  const restoreDistance = useRef<number>();
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const theme = useTheme();
  const mobileViewport = useMediaQuery(theme.breakpoints.down("sm"));
  const mobileComposer = useMobileComposerAutoHide(mobileViewport);
  const items = useMemo(
    () => mergeAllChatItems(older?.items ?? [], query.data?.items ?? []),
    [older?.items, query.data?.items],
  );
  const selected = items.find((item) => item.communicationEventId === selectedId);
  const replyUnavailable = selected ? allChatReplyUnavailableMessage(selected) : undefined;
  const selectItem = (item: AllChatItemDto) => {
    setSelectedId(item.communicationEventId);
    setNotice(undefined);
    send.reset();
  };
  const history = older ?? {
    items: [], cursor: query.data?.history.cursor, hasMore: query.data?.history.hasMore ?? false,
  };
  const send = useMutation({
    mutationFn: async (body: string) => {
      if (!selected?.directMessageAgent) throw new Error("Select a message tied to one exact Agent");
      if (!body.trim()) throw new Error("Message text is required");
      return api.sendMessage(selected.directMessageAgent.id, {
        text: body.trim(),
        replyToMessageId: selected.messageId,
        idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        activeRunDelivery: "steer",
      });
    },
    onSuccess: (_response, _variables) => {
      setNotice(`Direct message sent to ${selected?.directMessageAgent?.title ?? "Agent"}.`);
      void queryClient.invalidateQueries({ queryKey: ["all-chat"] });
      if (selected?.directMessageAgent) {
        void queryClient.invalidateQueries({ queryKey: ["agent", selected.directMessageAgent.id] });
      }
    },
  });
  const loadOlder = async () => {
    if (loadingOlder || !history.hasMore || !history.cursor) return;
    setLoadingOlder(true);
    try {
      if (scrollRef.current) restoreDistance.current = scrollRef.current.scrollHeight - scrollRef.current.scrollTop;
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
  const layoutKey = items.map((item) => item.communicationEventId).join(":");
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (restoreDistance.current !== undefined) {
      element.scrollTop = element.scrollHeight - restoreDistance.current;
      restoreDistance.current = undefined;
      return;
    }
    if (firstLayout.current || followLatest.current) {
      scrollChatToBottom(element);
      firstLayout.current = false;
      setShowScrollToLatest(false);
      mobileComposer.showAtLatest(element);
    }
  }, [layoutKey]);

  return <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", bgcolor: "background.default" }}>
    <Stack direction="row" spacing={1.5} sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: "center", borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h1" fontWeight={800}>Messages</Typography>
        <Typography variant="body2" color="text.secondary">Everything sent to or from you across Ponderosa.</Typography>
      </Box>
    </Stack>

    <Box sx={{ minHeight: 0, position: "relative", overflow: "hidden" }}>
    <Box ref={scrollRef} className="ponderosa-scroll" onScroll={() => {
      if (!scrollRef.current) return;
      followLatest.current = isChatNearBottom(scrollRef.current);
      setShowScrollToLatest(!followLatest.current);
      mobileComposer.observeScroll(scrollRef.current, followLatest.current);
    }} sx={{ height: "100%", minHeight: 0, overflowY: "auto", p: { xs: 1.5, md: 2.5 } }}>
      {query.isLoading ? <Stack sx={{ alignItems: "center", py: 6 }}><CircularProgress size={28} /></Stack> : null}
      {query.isError ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void query.refetch()}>Retry</Button>}>Messages could not be loaded.</Alert> : null}
      {history.hasMore ? <Stack sx={{ alignItems: "center", mb: 2 }}><Button size="small" variant="outlined" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : "Load Older Messages"}</Button></Stack> : null}
      <Stack spacing={2.5} sx={{ width: "100%", maxWidth: 1280, mx: "auto", py: 1 }} role="radiogroup" aria-label="Source message for direct reply">
        {items.map((item, index) => {
          const selectedItem = selectedId === item.communicationEventId;
          const fromUser = item.author.kind === "user";
          return <Box
            key={item.communicationEventId}
            component="article"
            role="radio"
            aria-checked={selectedItem}
            aria-label={allChatSourceAccessibleName(item)}
            tabIndex={selectedId ? (selectedItem ? 0 : -1) : (index === 0 ? 0 : -1)}
            onClick={() => {
              selectItem(item);
              setMobileTimestampId((current) => current === item.communicationEventId ? undefined : item.communicationEventId);
            }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
              event.preventDefault();
              const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
              const nextIndex = (index + delta + items.length) % items.length;
              const nextItem = items[nextIndex];
              if (!nextItem) return;
              selectItem(nextItem);
              const group = event.currentTarget.closest<HTMLElement>('[role="radiogroup"]');
              group?.querySelectorAll<HTMLElement>('[role="radio"]')[nextIndex]?.focus();
            }}
            sx={{ display: "flex", justifyContent: fromUser ? "flex-end" : "flex-start", outline: "none", cursor: "pointer", borderRadius: 2, "&:focus-visible": { boxShadow: (muiTheme) => `0 0 0 2px ${muiTheme.palette.primary.main}` } }}
          >
            <Stack direction="row" spacing={1.25} sx={{ width: fromUser ? "fit-content" : "100%", maxWidth: fromUser ? { xs: "94%", sm: 920 } : 1120, alignItems: "flex-start" }}>
              {!fromUser ? <Avatar sx={{ width: 36, height: 36, bgcolor: "action.selected", color: "text.primary", fontSize: 14 }}>{item.author.label.slice(0, 1).toUpperCase()}</Avatar> : null}
              <Box sx={{ minWidth: 0, flex: 1 }}>
                {fromUser
                  ? <UserMessageLabel profile={workspacePreferences.data?.profile} createdAt={item.createdAt} />
                  : <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ alignItems: "baseline", mb: 0.25 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{item.author.label}</Typography>
                    <MessageTimestamp value={item.createdAt} compact desktopOnly />
                  </Stack>}
                <Box sx={{ width: fromUser ? "fit-content" : "auto", maxWidth: "100%", ml: fromUser ? "auto" : 0, px: fromUser ? 1.5 : 0, py: fromUser ? 1 : 0, borderRadius: 2.5, bgcolor: fromUser ? "action.selected" : "transparent", border: selectedItem ? 1 : 0, borderColor: "primary.main", minWidth: 0 }}>
                  <ChatMessageBody text={item.text} collapseLongMessage={fromUser} projectId={item.project.id} operatorHandle={workspacePreferences.data?.profile.handle} />
                </Box>
                {mobileTimestampId === item.communicationEventId ? <Box sx={{ display: { xs: "block", sm: "none" }, color: "text.secondary", mt: 0.5 }}><MessageTimestamp value={item.createdAt} compact align={fromUser ? "end" : "start"} /></Box> : null}
                <Stack direction="row" spacing={0.65} sx={{ mt: 0.5, justifyContent: fromUser ? "flex-end" : "flex-start", alignItems: "center", color: "text.secondary" }}>
                  <ButtonBase onClick={(event) => { event.stopPropagation(); onNavigate({ kind: "project", projectId: item.project.id }); }} sx={{ borderRadius: 0.75, typography: "caption", fontWeight: 650, px: 0.25 }}>{item.project.label}</ButtonBase>
                  <Typography variant="caption" aria-hidden>·</Typography>
                  <ButtonBase onClick={(event) => { event.stopPropagation(); onNavigate(allChatSourceRoute(item)); }} sx={{ borderRadius: 0.75, typography: "caption", px: 0.25 }}>{item.source.title}</ButtonBase>
                </Stack>
              </Box>
            </Stack>
          </Box>;
        })}
        {!query.isLoading && !query.isError && items.length === 0 ? <Alert severity="info">No authored chat messages yet.</Alert> : null}
      </Stack>
    </Box>
    <ScrollToLatestButton visible={showScrollToLatest} onClick={() => {
      if (!scrollRef.current) return;
      followLatest.current = true;
      scrollChatToBottom(scrollRef.current);
      setShowScrollToLatest(false);
      mobileComposer.showAtLatest(scrollRef.current);
    }} />
    </Box>

    <Box
      className="mobile-chat-chrome mobile-chat-composer"
      data-mobile-composer-hidden={mobileComposer.hidden ? "true" : "false"}
      onTransitionEnd={(event) => {
        if (
          event.currentTarget !== event.target
          || event.propertyName !== "max-height"
        ) return;
        mobileComposer.finishTransition();
      }}
      sx={{ borderTop: 1, borderColor: "divider", bgcolor: "background.paper", p: { xs: 1, md: 2 } }}
    >
      <Box sx={{ width: "100%", maxWidth: 1280, mx: "auto" }}>
        {!selected ? <Alert severity="info">Select a source message to inspect its fixed direct-message target.</Alert>
          : !selected.directMessageAgent ? <Alert severity="info">{replyUnavailable ?? "This message has no Agent recipient."}</Alert>
            : <Stack spacing={1}>
              {notice ? <Alert severity="success">{notice}</Alert> : null}
              {send.isError ? <Alert severity="error">{send.error instanceof Error ? send.error.message : "Direct message could not be sent."}</Alert> : null}
              <Composer
                disabled={send.isPending}
                running={false}
                attachmentsEnabled={false}
                attachmentsUnavailableReason="Messages sends a direct text reply to the selected Agent."
                placeholder={`Message ${selected.directMessageAgent.title}`}
                replyTo={{ text: selected.text }}
                replyLabel={`Direct reply to ${selected.directMessageAgent.title}`}
                onCancelReply={() => { setSelectedId(undefined); setNotice(undefined); send.reset(); }}
                draftStorageKey={`messages:${selected.communicationEventId}`}
                guidance="Recipient is fixed by the selected source. This is a private reply and cannot be broadcast from Messages."
                onSend={(body) => send.mutateAsync(body)}
              />
            </Stack>}
      </Box>
    </Box>
  </Box>;
}
