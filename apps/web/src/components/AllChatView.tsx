import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Alert, Box, Button, ButtonBase, Chip, CircularProgress, Divider, Paper, Stack, Typography,
} from "@mui/material";
import type { AllChatItemDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAllChat } from "../hooks/queries";
import type { Route } from "../routing";
import { Composer, isChatNearBottom, ScrollToLatestButton, scrollChatToBottom } from "./panes";
import { MessageTimestamp } from "./MessageTimestamp";

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
  if (item.source.kind === "project") return `${item.project.label} · Project Chat · ${item.source.title}`;
  if (item.source.kind === "team") return `${item.project.label} · Team Chat · ${item.source.title}`;
  return `${item.project.label} · Agent Chat · ${item.source.title}`;
}

export function allChatSourceAccessibleName(item: AllChatItemDto): string {
  const normalized = item.text.replace(/\s+/gu, " ").trim();
  const excerpt = normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized || "Empty message";
  return `Select message from ${item.author.label} in ${sourceLabel(item)}, sent ${new Date(item.createdAt).toLocaleString()}: ${excerpt}`;
}

export function allChatReplyUnavailableMessage(item: AllChatItemDto): string | undefined {
  if (item.author.kind === "user") return "You cannot message yourself. Select an Agent-authored message to reply privately to that Agent.";
  if (!item.directMessageAgent) return "This source does not identify one exact active Agent. All Chat cannot compose broadcasts or choose a different recipient.";
  return undefined;
}

export function AllChatView({ onNavigate }: { onNavigate(route: Route): void }): JSX.Element {
  const queryClient = useQueryClient();
  const query = useAllChat();
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
    }
  }, [layoutKey]);

  return <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", bgcolor: "background.default" }}>
    <Stack direction="row" spacing={1.5} sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: "center", borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h1" fontWeight={800}>All Chat</Typography>
        <Typography variant="body2" color="text.secondary">Canonical messages across Project, Team, and Agent chats.</Typography>
      </Box>
      <Chip size="small" variant="outlined" label="View oriented" />
    </Stack>

    <Box sx={{ minHeight: 0, position: "relative", overflow: "hidden" }}>
    <Box ref={scrollRef} className="ponderosa-scroll" onScroll={() => {
      if (!scrollRef.current) return;
      followLatest.current = isChatNearBottom(scrollRef.current);
      setShowScrollToLatest(!followLatest.current);
    }} sx={{ height: "100%", minHeight: 0, overflowY: "auto", p: { xs: 1.5, md: 2.5 } }}>
      {query.isLoading ? <Stack sx={{ alignItems: "center", py: 6 }}><CircularProgress size={28} /></Stack> : null}
      {query.isError ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void query.refetch()}>Retry</Button>}>All Chat could not be loaded.</Alert> : null}
      {history.hasMore ? <Stack sx={{ alignItems: "center", mb: 2 }}><Button size="small" variant="outlined" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : "Load Older Messages"}</Button></Stack> : null}
      <Stack spacing={1.25} sx={{ maxWidth: 920, mx: "auto" }} role="radiogroup" aria-label="Source message for direct reply">
        {items.map((item, index) => {
          const selectedItem = selectedId === item.communicationEventId;
          return <Paper
            key={item.communicationEventId}
            component="article"
            variant="outlined"
            onClick={() => {
              selectItem(item);
              setMobileTimestampId((current) => current === item.communicationEventId ? undefined : item.communicationEventId);
            }}
            sx={{ p: 1.75, cursor: "pointer", borderColor: selectedItem ? "primary.main" : "divider", bgcolor: selectedItem ? "action.selected" : "background.paper" }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
              <ButtonBase
                role="radio"
                aria-checked={selectedItem}
                aria-label={allChatSourceAccessibleName(item)}
                tabIndex={selectedId ? (selectedItem ? 0 : -1) : (index === 0 ? 0 : -1)}
                onClick={(event) => {
                  event.stopPropagation();
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
                sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", textAlign: "left", borderRadius: 1 }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle2">{item.author.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{sourceLabel(item)}<Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}> · {new Date(item.createdAt).toLocaleString()}</Box></Typography>
                </Box>
              </ButtonBase>
              <Button
                size="small"
                color="inherit"
                endIcon={<OpenInNewIcon fontSize="small" />}
                onClick={(event) => { event.stopPropagation(); onNavigate(allChatSourceRoute(item)); }}
              >Open Source</Button>
            </Stack>
            <Divider sx={{ my: 1.25 }} />
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.text}</Typography>
            {mobileTimestampId === item.communicationEventId ? <Box sx={{ display: { xs: "block", sm: "none" }, color: "text.secondary", mt: 0.5 }}><MessageTimestamp value={item.createdAt} compact align="start" /></Box> : null}
            {item.directMessageAgent ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.25 }}>Select to message {item.directMessageAgent.title} directly.</Typography> : null}
          </Paper>;
        })}
        {!query.isLoading && !query.isError && items.length === 0 ? <Alert severity="info">No authored chat messages yet.</Alert> : null}
      </Stack>
    </Box>
    <ScrollToLatestButton visible={showScrollToLatest} onClick={() => {
      if (!scrollRef.current) return;
      followLatest.current = true;
      scrollChatToBottom(scrollRef.current);
      setShowScrollToLatest(false);
    }} />
    </Box>

    <Box sx={{ borderTop: 1, borderColor: "divider", bgcolor: "background.paper", p: { xs: 1, md: 2 } }}>
      <Box sx={{ maxWidth: 920, mx: "auto" }}>
        {!selected ? <Alert severity="info">Select a source message to inspect its fixed direct-message target.</Alert>
          : !selected.directMessageAgent ? <Alert severity="info">{replyUnavailable ?? "This message has no Agent recipient."}</Alert>
            : <Stack spacing={1}>
              {notice ? <Alert severity="success">{notice}</Alert> : null}
              {send.isError ? <Alert severity="error">{send.error instanceof Error ? send.error.message : "Direct message could not be sent."}</Alert> : null}
              <Composer
                disabled={send.isPending}
                running={false}
                attachmentsEnabled={false}
                attachmentsUnavailableReason="All Chat sends a direct text reply to the selected Agent."
                placeholder={`Message ${selected.directMessageAgent.title}`}
                replyTo={{ text: selected.text }}
                replyLabel={`Direct reply to ${selected.directMessageAgent.title}`}
                draftStorageKey={`all-chat:${selected.communicationEventId}`}
                guidance="Recipient is fixed by the selected source. This message is private and cannot be broadcast from All Chat."
                onSend={(body) => send.mutateAsync(body)}
              />
            </Stack>}
      </Box>
    </Box>
  </Box>;
}
