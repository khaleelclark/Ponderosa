import {
  Alert, Avatar, Box, Button, ButtonBase, CircularProgress, IconButton, Stack, Tooltip, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import TagIcon from "@mui/icons-material/Tag";
import type { AllChatItemDto, EngineCommand, WorkspaceNotificationDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAllChat, useWorkspacePreferences } from "../hooks/queries";
import type { Route } from "../routing";
import { ChatMessageBody, Composer, isChatNearBottom, ScrollToLatestButton, scrollChatToBottom, UserMessageLabel } from "./panes";
import { MessageTimestamp } from "./MessageTimestamp";
import { useMobileComposerAutoHide } from "../mobileChat";
import { copyText } from "../clipboard";
import { agentMentionHandle } from "../mentions";
import { AttentionSurface } from "./AttentionSurface";

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

export function AllChatView({ onNavigate, notifications = [] }: { onNavigate(route: Route): void; notifications?: WorkspaceNotificationDto[] }): JSX.Element {
  const queryClient = useQueryClient();
  const query = useAllChat();
  const workspacePreferences = useWorkspacePreferences();
  const [older, setOlder] = useState<{ items: AllChatItemDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [mobileTimestampId, setMobileTimestampId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{ id: string; text: string }>();
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
  const selectedAgentId = selected?.directMessageAgent?.id;
  const selectedAgent = useQuery({
    queryKey: ["agent", selectedAgentId, 100],
    queryFn: () => api.getAgent(selectedAgentId!, 100),
    enabled: Boolean(selectedAgentId),
  });
  const invokeCommand = async (command: EngineCommand, argumentsText?: string) => {
    if (!selectedAgentId) throw new Error("Select an Agent-authored message first.");
    const result = await api.invokeProviderCommand(selectedAgentId, {
      name: command.name,
      ...(argumentsText ? { argumentsText } : {}),
    });
    setNotice(result.message ?? `/${command.name} completed for ${selected?.directMessageAgent?.title ?? "the selected Agent"}.`);
  };
  const refreshSelectedCapabilities = async () => {
    if (!selected?.project.id || !selectedAgentId) return;
    const discovered = await api.getEngineCapabilities(selected.project.id, {
      engineId: selectedEngineId,
      model: selectedModel,
      agentId: selectedAgentId,
      refresh: true,
    });
    queryClient.setQueryData(
      ["engine-capabilities", selected.project.id, selectedAgentId, selectedEngineId, selectedModel],
      discovered,
    );
  };
  const selectedEngineId = selectedAgent.data?.agent.activeEngine;
  const selectedModel = selectedAgent.data?.agent.model;
  const selectedCapabilities = useQuery({
    queryKey: ["engine-capabilities", selected?.project.id, selectedAgentId, selectedEngineId, selectedModel],
    queryFn: () => api.getEngineCapabilities(selected!.project.id, {
      engineId: selectedEngineId,
      model: selectedModel,
      agentId: selectedAgentId,
    }),
    enabled: Boolean(selected?.project.id && selectedAgentId && selectedEngineId),
    staleTime: 10_000,
  });
  const selectedEngineCapabilities = selectedCapabilities.data?.find((item) => item.engineId === selectedEngineId);
  const selectedCommands: EngineCommand[] = selectedEngineCapabilities?.commands ?? [];
  const replyUnavailable = selected ? allChatReplyUnavailableMessage(selected) : undefined;
  const selectItem = (item: AllChatItemDto) => {
    setSelectedId(item.communicationEventId);
    setMentionInsertRequest(undefined);
    setNotice(undefined);
    send.reset();
  };
  const mentionItem = (item: AllChatItemDto) => {
    selectItem(item);
    if (!item.directMessageAgent) return;
    setMentionInsertRequest({ id: `${item.communicationEventId}:${Date.now()}`, text: `#${agentMentionHandle(item.directMessageAgent.title)}` });
  };
  const history = older ?? {
    items: [], cursor: query.data?.history.cursor, hasMore: query.data?.history.hasMore ?? false,
  };
  const send = useMutation({
    mutationFn: async ({ body, files, draftAttachmentIds, draftOwnerId }: { body: string; files: File[]; draftAttachmentIds: string[]; draftOwnerId?: string }) => {
      if (!selected?.directMessageAgent) throw new Error("Select a message tied to one exact Agent");
      if (!body.trim() && files.length === 0) throw new Error("Message text or an attachment is required");
      return api.sendMessage(selected.directMessageAgent.id, {
        text: body.trim(),
        ...(draftAttachmentIds.length ? { draftAttachmentIds, draftId: `agent:${selected.directMessageAgent.id}`, draftOwnerId } : {}),
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

  return <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: "background.default" }}>
    <Stack direction="row" spacing={1.5} sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: "center", borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h1" fontWeight={800}>All Messages</Typography>
        <Typography variant="body2" color="text.secondary">Everything sent to or from you across Ponderosa.</Typography>
      </Box>
    </Stack>
    <AttentionSurface notifications={notifications} onOpen={(item) => {
      if (!item.projectId) return;
      if (item.action?.kind === "open_agent" && item.action.targetId) {
        onNavigate({ kind: "agent", projectId: item.projectId, agentId: item.action.targetId, view: "technical" });
      } else if (item.conversationId) {
        onNavigate({ kind: "projectWork", projectId: item.projectId, conversationId: item.conversationId });
      } else {
        onNavigate({ kind: "projectWork", projectId: item.projectId });
      }
    }} />

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
      <Stack spacing={1.75} sx={{ width: "100%", maxWidth: 1280, mx: "auto", py: 1 }}>
        {items.map((item) => {
          const fromUser = item.author.kind === "user";
          return <Box
            key={item.communicationEventId}
            component="article"
            aria-label={allChatSourceAccessibleName(item)}
            onClick={() => setMobileTimestampId((current) => current === item.communicationEventId ? undefined : item.communicationEventId)}
            sx={{ display: "flex", justifyContent: fromUser ? "flex-end" : "flex-start", borderRadius: 2, "& .messages-hover-actions": { opacity: { xs: 1, sm: 0 }, transition: "opacity 120ms ease" }, "&:hover .messages-hover-actions, &:focus-within .messages-hover-actions": { opacity: 1 } }}
          >
            <Stack direction="row" spacing={1.25} sx={{ width: fromUser ? "fit-content" : "100%", maxWidth: fromUser ? { xs: "94%", sm: 920 } : 1120, alignItems: "flex-start" }}>
              {!fromUser ? <ButtonBase aria-label={`Message ${item.author.label}`} onClick={(event) => { event.stopPropagation(); if (item.directMessageAgent) onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.directMessageAgent.id }); }} sx={{ borderRadius: "50%", flex: "0 0 auto" }}><Avatar sx={{ width: 36, height: 36, bgcolor: "action.selected", color: "text.primary", fontSize: 14 }}>{item.author.label.slice(0, 1).toUpperCase()}</Avatar></ButtonBase> : null}
              <Box sx={{ minWidth: 0, flex: 1 }}>
                {fromUser
                  ? <UserMessageLabel profile={workspacePreferences.data?.profile} createdAt={item.createdAt} />
                  : <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ alignItems: "baseline", mb: 0.25 }}>
                    <ButtonBase onClick={(event) => { event.stopPropagation(); if (item.directMessageAgent) onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.directMessageAgent.id }); }} sx={{ borderRadius: 0.75 }}><Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{item.author.label}</Typography></ButtonBase>
                    <MessageTimestamp value={item.createdAt} compact desktopOnly />
                  </Stack>}
                <Box sx={{ width: fromUser ? "fit-content" : "auto", maxWidth: "100%", ml: fromUser ? "auto" : 0, px: fromUser ? { xs: 1.5, sm: 1.75 } : 0, py: fromUser ? { xs: 1, sm: 1.15 } : 0, borderRadius: 2.5, bgcolor: fromUser ? "action.selected" : "transparent", minWidth: 0, "& p": { my: 0.15 }, "& li + li": { mt: 0.05 } }}>
                  <ChatMessageBody
                    text={item.text}
                    collapseLongMessage
                    compactMarkdown
                    projectId={item.project.id}
                    operatorHandle={workspacePreferences.data?.profile.handle}
                    agentMentionForHandle={(handle) => item.directMessageAgent && agentMentionHandle(item.directMessageAgent.title).toLocaleLowerCase() === handle.toLocaleLowerCase() ? { agentId: item.directMessageAgent.id, label: item.directMessageAgent.title } : undefined}
                    onOpenAgent={(agentId) => onNavigate({ kind: "agent", projectId: item.project.id, agentId })}
                  />
                </Box>
                {mobileTimestampId === item.communicationEventId ? <Box sx={{ display: { xs: "block", sm: "none" }, color: "text.secondary", mt: 0.5 }}><MessageTimestamp value={item.createdAt} compact align={fromUser ? "end" : "start"} /></Box> : null}
                <Stack direction="row" spacing={0.65} sx={{ mt: 0.5, justifyContent: fromUser ? "flex-end" : "flex-start", alignItems: "center", color: "text.secondary" }}>
                  <ButtonBase onClick={(event) => { event.stopPropagation(); onNavigate({ kind: "project", projectId: item.project.id }); }} sx={{ borderRadius: 0.75, typography: "caption", fontWeight: 650, px: 0.25 }}>{item.project.label}</ButtonBase>
                  <Typography variant="caption" aria-hidden>·</Typography>
                  <ButtonBase onClick={(event) => { event.stopPropagation(); onNavigate(allChatSourceRoute(item)); }} sx={{ borderRadius: 0.75, typography: "caption", px: 0.25 }}>{item.source.title}</ButtonBase>
                </Stack>
                <Stack className="messages-hover-actions" direction="row" spacing={0.25} sx={{ mt: 0.15, justifyContent: fromUser ? "flex-end" : "flex-start", minHeight: 28 }}>
                  <Tooltip title="Copy"><IconButton size="small" aria-label="Copy message" onClick={() => void copyText(item.text)}><ContentCopyOutlinedIcon fontSize="inherit" /></IconButton></Tooltip>
                  {item.directMessageAgent ? <Tooltip title={`Mention ${item.directMessageAgent.title}`}><IconButton size="small" aria-label={`Mention ${item.directMessageAgent.title}`} onClick={() => mentionItem(item)}><TagIcon fontSize="inherit" /></IconButton></Tooltip> : null}
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
                commands={selectedCommands}
                capabilities={selectedEngineCapabilities?.composerCapabilities ?? []}
                onCapabilitiesOpen={refreshSelectedCapabilities}
                onCommand={invokeCommand}
                disabled={send.isPending}
                running={false}
                attachmentsEnabled
                placeholder={`Message ${selected.directMessageAgent.title}`}
                insertTextRequest={mentionInsertRequest}
                draftStorageKey={`messages:agent:${selected.directMessageAgent.id}`}
                conversationDraftId={`agent:${selected.directMessageAgent.id}`}
                onSend={(body, files, draftAttachmentIds = [], draftOwnerId) => send.mutateAsync({ body, files, draftAttachmentIds, draftOwnerId })}
              />
            </Stack>}
      </Box>
    </Box>
  </Box>;
}
