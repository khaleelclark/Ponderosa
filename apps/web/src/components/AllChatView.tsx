import {
  Alert,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import type {
  AllChatDecisionEventDto,
  AllChatItemDto,
  EngineCommand,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAllChat, useWorkspacePreferences } from "../hooks/queries";
import type { Route } from "../routing";
import { ChatMessageBody } from "./chat/ChatMessages";
import { Composer } from "./chat/Composer";
import { useMobileComposerAutoHide } from "../mobileChat";
import { copyText } from "../clipboard";
import { agentMentionHandle } from "../mentions";
import { AttentionSurface } from "./AttentionSurface";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { ChatSurface } from "./chat/ChatSurface";
import { uniqueBy } from "../collections";
import TagIcon from "@mui/icons-material/Tag";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import { isOrdinaryMessageNotification } from "../workspaceNavigation";
import { DecisionCard } from "./decisions/DecisionCard";

function allChatSourceRoute(item: AllChatItemDto): Route {
  if (item.source.kind === "agent") {
    return {
      kind: "agent",
      projectId: item.project.id,
      agentId: item.source.agentId,
      focusMessageId: item.communicationEventId,
    };
  }
  return {
    kind: "conversation",
    projectId: item.project.id,
    conversationId: item.source.conversationId,
    focusMessageId: item.communicationEventId,
    ...(item.source.kind === "team"
      ? { channel: "collaboration" as const }
      : {}),
  };
}

function mergeAllChatItems(
  ...groups: AllChatItemDto[][]
): AllChatItemDto[] {
  return uniqueBy(
    groups.flat(),
    item => item.communicationEventId,
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.communicationEventId.localeCompare(b.communicationEventId),
  );
}

type AllMessagesTimelineEntry =
  | { kind: "message"; id: string; at: string; item: AllChatItemDto }
  | { kind: "decision"; id: string; at: string; item: AllChatDecisionEventDto }
  | { kind: "decision-response"; id: string; at: string; item: AllChatDecisionEventDto; choice: string };

function allChatDecisionChoice(item: AllChatDecisionEventDto): string | undefined {
  const { decision } = item;
  return decision.response?.optionId
    ? decision.options.find((option) => option.id === decision.response?.optionId)?.label
    : decision.response?.text;
}

function sourceLabel(item: AllChatItemDto): string {
  return `${item.project.label} · ${item.source.title}`;
}

function allChatSourceAccessibleName(item: AllChatItemDto): string {
  const normalized = item.text.replace(/\s+/gu, " ").trim();
  const excerpt =
    normalized.length > 80
      ? `${normalized.slice(0, 79)}…`
      : normalized || "Empty message";
  return `Message from ${item.author.label} in ${sourceLabel(item)}, sent ${new Date(item.createdAt).toLocaleString()}: ${excerpt}`;
}

export function AllChatView({
  onNavigate,
  notifications = [],
}: {
  onNavigate(route: Route): void;
  notifications?: WorkspaceNotificationDto[];
}): JSX.Element {
  const query = useAllChat();
  const workspacePreferences = useWorkspacePreferences();
  const queryClient = useQueryClient();
  const markedVisibleNotificationIds = useRef(new Set<string>());
  const [older, setOlder] = useState<{
    items: AllChatItemDto[];
    decisions: AllChatDecisionEventDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [replyTarget, setReplyTarget] = useState<{ id: string; title: string }>();
  const [notice, setNotice] = useState<string>();
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{
    id: string;
    text: string;
  }>();
  const [mentionRemoveRequest, setMentionRemoveRequest] = useState<{
    id: string;
    text: string;
  }>();
  const theme = useTheme();
  const mobileViewport = useMediaQuery(theme.breakpoints.down("sm"));
  const mobileComposer = useMobileComposerAutoHide(mobileViewport);
  const items = useMemo(
    () => mergeAllChatItems(older?.items ?? [], query.data?.items ?? []),
    [older?.items, query.data?.items],
  );
  const decisionEvents = useMemo(
    () => uniqueBy(
      [...(older?.decisions ?? []), ...(query.data?.decisions ?? [])],
      (item) => item.id,
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    ),
    [older?.decisions, query.data?.decisions],
  );
  const timeline = useMemo<AllMessagesTimelineEntry[]>(() => {
    const entries: AllMessagesTimelineEntry[] = [
      ...items.map((item) => ({
        kind: "message" as const,
        id: `message:${item.communicationEventId}`,
        at: item.createdAt,
        item,
      })),
      ...decisionEvents.flatMap((item): AllMessagesTimelineEntry[] => {
        if (item.kind === "decision") return [{ kind: "decision", id: item.id, at: item.createdAt, item }];
        const choice = allChatDecisionChoice(item);
        return choice ? [{ kind: "decision-response", id: item.id, at: item.createdAt, item, choice }] : [];
      }),
    ];
    return entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  }, [decisionEvents, items]);
  const layoutKey = timeline.map((entry) => entry.id).join(":");
  const selected = items.find(item => item.communicationEventId === selectedId);
  const selectedAgentId = replyTarget?.id;
  const selectedAgent = useQuery({
    queryKey: queryKeys.agents.detail(selectedAgentId),
    queryFn: () => api.getAgent(selectedAgentId!, 100),
    enabled: Boolean(selectedAgentId),
  });
  const selectedEngineId = selectedAgent.data?.agent.activeEngine;
  const selectedModel = selectedAgent.data?.agent.model;
  const selectedCapabilities = useQuery({
    queryKey: queryKeys.engines.capabilitySelection(
      selected?.project.id,
      selectedAgentId,
      selectedEngineId,
      selectedModel,
    ),
    queryFn: () =>
      api.getEngineCapabilities(selected!.project.id, {
        engineId: selectedEngineId,
        model: selectedModel,
        agentId: selectedAgentId,
      }),
    enabled: Boolean(
      selected?.project.id && selectedAgentId && selectedEngineId,
    ),
    staleTime: 10_000,
  });
  const selectedEngineCapabilities = selectedCapabilities.data?.find(
    item => item.engineId === selectedEngineId,
  );
  const selectedCommands: EngineCommand[] =
    selectedEngineCapabilities?.commands ?? [];
  const markCommunicationVisible = useCallback((communicationEventId: string) => {
    if (document.visibilityState === "hidden") return;
    const matching = notifications.filter((item) =>
      item.communicationEventId === communicationEventId &&
      !item.readAt &&
      (item.status ?? "open") === "open" &&
      isOrdinaryMessageNotification(item) &&
      !markedVisibleNotificationIds.current.has(item.id));
    if (!matching.length) return;
    const ids = new Set(matching.map((item) => item.id));
    ids.forEach((id) => markedVisibleNotificationIds.current.add(id));
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all, (current = []) =>
      current.map((item) => ids.has(item.id) ? { ...item, readAt } : item));
    void Promise.all(matching.map((item) => api.markNotificationRead(item.id)))
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }))
      .catch(() => {
        ids.forEach((id) => markedVisibleNotificationIds.current.delete(id));
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      });
  }, [notifications, queryClient]);
  const refreshSelectedCapabilities = async () => {
    if (!selected?.project.id || !selectedAgentId) return;
    const discovered = await api.getEngineCapabilities(selected.project.id, {
      engineId: selectedEngineId,
      model: selectedModel,
      agentId: selectedAgentId,
      refresh: true,
    });
    queryClient.setQueryData(
      queryKeys.engines.capabilitySelection(
        selected.project.id,
        selectedAgentId,
        selectedEngineId,
        selectedModel,
      ),
      discovered,
    );
  };
  const invokeCommand = async (
    command: EngineCommand,
    argumentsText?: string,
  ) => {
    if (!selectedAgentId)
      throw new Error("Select an Agent-authored message first.");
    const result = await api.invokeProviderCommand(selectedAgentId, {
      name: command.name,
      ...(argumentsText ? { argumentsText } : {}),
    });
    setNotice(
      result.message ??
        `/${command.name} completed for ${selected?.directMessageAgent?.title ?? "Agent"}.`,
    );
  };
  const send = useMutation({
    mutationFn: async ({
      body,
      files,
      draftAttachmentIds,
      draftOwnerId,
    }: {
      body: string;
      files: File[];
      draftAttachmentIds: string[];
      draftOwnerId?: string;
    }) => {
      if (!replyTarget)
        throw new Error("Select a message tied to one exact Agent");
      if (!body.trim() && files.length === 0)
        throw new Error("Message text or an attachment is required");
      const attachments = draftAttachmentIds.length
        ? []
        : await Promise.all(
            files.map(file =>
              api.uploadAttachment(replyTarget.id, file),
            ),
          );
      try {
        return await api.sendMessage(replyTarget.id, {
          text: body.trim(),
          attachmentIds: attachments.map(item => item.id),
          ...(draftAttachmentIds.length
            ? {
                draftAttachmentIds,
                draftId: `agent:${replyTarget.id}`,
                draftOwnerId,
              }
            : {}),
          idempotencyKey: createClientId(),
          activeRunDelivery: "steer",
        });
      } catch (error) {
        await Promise.allSettled(
          attachments.map(item =>
            api.deleteAttachment(replyTarget.id, item.id),
          ),
        );
        throw error;
      }
    },
    onSuccess: () => {
      setNotice(
        `Direct message sent to ${replyTarget?.title ?? "Agent"}.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
      if (replyTarget) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detailPrefix(
            replyTarget.id,
          ),
        });
      }
    },
  });
  const selectItem = (item: AllChatItemDto) => {
    setSelectedId(item.communicationEventId);
    setMentionInsertRequest(undefined);
    setNotice(undefined);
    send.reset();
  };
  const clearReplyTarget = () => {
    if (replyTarget) {
      setMentionRemoveRequest({
        id: `clear:${replyTarget.id}:${Date.now()}`,
        text: `#${agentMentionHandle(replyTarget.title)}`,
      });
    }
    setReplyTarget(undefined);
  };
  const mentionItem = (item: AllChatItemDto) => {
    selectItem(item);
    if (!item.directMessageAgent) return;
    const handle = agentMentionHandle(item.directMessageAgent.title);
    if (replyTarget?.id === item.directMessageAgent.id) {
      setMentionRemoveRequest({
        id: `${item.communicationEventId}:remove:${Date.now()}`,
        text: `#${handle}`,
      });
      setReplyTarget(undefined);
      return;
    }
    setReplyTarget(item.directMessageAgent);
    setMentionInsertRequest({
      id: `${item.communicationEventId}:${Date.now()}`,
      text: `#${handle}`,
    });
  };
  const history = older ?? {
    items: [],
    decisions: [],
    cursor: query.data?.history.cursor,
    hasMore: query.data?.history.hasMore ?? false,
  };
  const loadOlder = async () => {
    if (loadingOlder || !history.hasMore || !history.cursor) return;
    setLoadingOlder(true);
    try {
      const page = await api.getAllChat(50, history.cursor);
      setOlder(current => ({
        items: mergeAllChatItems(
          page.items,
          current?.items ?? [],
          query.data?.items ?? [],
        ),
        decisions: uniqueBy(
          [...(page.decisions ?? []), ...(current?.decisions ?? []), ...(query.data?.decisions ?? [])],
          (item) => item.id,
          (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        ),
        cursor: page.history.cursor,
        hasMore: page.history.hasMore,
      }));
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto auto minmax(0, 1fr) auto",
        bgcolor: "background.default",
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          px: { xs: 2, md: 3 },
          py: 2,
          alignItems: "center",
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" component="h1" fontWeight={800}>
            All Messages
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Everything sent to or from you across Ponderosa.
          </Typography>
        </Box>
      </Stack>
      <Box data-chat-attention-slot sx={{ minWidth: 0 }}>
          <AttentionSurface
            notifications={notifications.filter((item) => item.kind !== "decision")}
          onOpen={item => {
            if (!item.projectId) return;
            const focusId = notificationTechnicalFocusId(item);
            if (item.action?.kind === "open_agent" && item.action.targetId) {
              onNavigate({
                kind: "agent",
                projectId: item.projectId,
                agentId: item.action.targetId,
                view: "technical",
                ...(focusId ? { technicalFocusId: focusId } : {}),
              });
            } else if (item.conversationId) {
              onNavigate({
                kind: "projectWork",
                projectId: item.projectId,
                conversationId: item.conversationId,
                ...(focusId ? { focusId } : {}),
              });
            } else {
              onNavigate({
                kind: "projectWork",
                projectId: item.projectId,
                ...(focusId ? { focusId } : {}),
              });
            }
          }}
        />
      </Box>

      <ChatSurface
        layout="workspace"
        layoutKey={layoutKey}
        label="All messages"
        follow={{
          kind: "latest",
          onPositionChange: (element, atLatest) =>
            mobileComposer.observeScroll(element, atLatest),
        }}
        history={{
          kind: "cursor",
          hasEarlier: history.hasMore,
          loading: loadingOlder,
          label: "Load Older Messages",
          onLoadEarlier: () => void loadOlder(),
        }}
        beforeMessages={
          <>
            {query.isLoading ? (
              <Stack sx={{ alignItems: "center", py: 6 }}>
                <CircularProgress size={28} />
              </Stack>
            ) : null}
            {query.isError ? (
              <Alert
                severity="error"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => void query.refetch()}
                  >
                    Retry
                  </Button>
                }
              >
                Messages could not be loaded.
              </Alert>
            ) : null}
          </>
        }
      >
        <Stack
          spacing={1.75}
          sx={{ width: "100%", maxWidth: 1280, mx: "auto", py: 1 }}
        >
          {timeline.map(entry => {
            if (entry.kind === "decision") return <Box component="article" key={entry.id} id={entry.id} sx={{ width: "min(1120px, 100%)", mx: "auto" }}>
              <DecisionCard
                decision={entry.item.decision}
                title={entry.item.decision.question}
                context={entry.item.decision.context}
              />
              <Typography variant="caption" color="text.secondary">{entry.item.project.label} · {entry.item.source.title}</Typography>
            </Box>;
            if (entry.kind === "decision-response") return <ChatMessageFrame
              key={entry.id}
              message={{
                id: entry.id,
                author: { kind: "operator", profile: workspacePreferences.data?.profile },
                createdAt: entry.at,
                ariaLabel: `You chose ${entry.choice}`,
                body: <Typography variant="body2">You chose {entry.choice}.</Typography>,
              }}
            />;
            const item = entry.item;
            const fromUser = item.author.kind === "user";
            return (
              <ChatMessageFrame
                key={entry.id}
                message={{
                  id: `all-message-${item.communicationEventId}`,
                  author: fromUser
                    ? {
                        kind: "operator",
                        profile: workspacePreferences.data?.profile,
                      }
                    : {
                        kind: "agent",
                        name: item.author.label,
                        ...(item.directMessageAgent
                          ? {
                              onOpen: () =>
                                onNavigate({
                                  kind: "agent",
                                  projectId: item.project.id,
                                  agentId: item.directMessageAgent!.id,
                                }),
                            }
                          : {}),
                      },
                  createdAt: item.createdAt,
                  onVisible: () => markCommunicationVisible(item.communicationEventId),
                  ariaLabel: allChatSourceAccessibleName(item),
                  body: (
                    <ChatMessageBody
                      text={item.text}
                      collapseLongMessage
                      compactMarkdown
                      projectId={item.project.id}
                      operatorHandle={workspacePreferences.data?.profile.handle}
                      agentMentionForHandle={handle =>
                        item.directMessageAgent &&
                        agentMentionHandle(
                          item.directMessageAgent.title,
                        ).toLocaleLowerCase() === handle.toLocaleLowerCase()
                          ? {
                              agentId: item.directMessageAgent.id,
                              label: item.directMessageAgent.title,
                            }
                          : undefined
                      }
                      onOpenAgent={agentId =>
                        onNavigate({
                          kind: "agent",
                          projectId: item.project.id,
                          agentId,
                        })
                      }
                    />
                  ),
                  afterBody: (
                    <Stack
                      direction="row"
                      spacing={0.65}
                      sx={{
                        mt: 0.5,
                        justifyContent: fromUser ? "flex-end" : "flex-start",
                        alignItems: "center",
                        color: "text.secondary",
                      }}
                    >
                      <ButtonBase
                        onClick={event => {
                          event.stopPropagation();
                          onNavigate({
                            kind: "project",
                            projectId: item.project.id,
                          });
                        }}
                        sx={{
                          borderRadius: 0.75,
                          typography: "caption",
                          fontWeight: 650,
                          px: 0.25,
                        }}
                      >
                        {item.project.label}
                      </ButtonBase>
                      <Typography variant="caption" aria-hidden>
                        ·
                      </Typography>
                      <ButtonBase
                        onClick={event => {
                          event.stopPropagation();
                          onNavigate(allChatSourceRoute(item));
                        }}
                        sx={{
                          borderRadius: 0.75,
                          typography: "caption",
                          px: 0.25,
                        }}
                      >
                        {item.source.title}
                      </ButtonBase>
                    </Stack>
                  ),
                  actions: (
                    <>
                      <Tooltip title="Copy">
                        <IconButton
                          size="small"
                          aria-label="Copy message"
                          onClick={event => {
                            event.stopPropagation();
                            void copyText(item.text);
                          }}
                        >
                          <ContentCopyOutlinedIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                      {item.directMessageAgent ? (
                        <Tooltip
                          title={`Mention ${item.directMessageAgent.title}`}
                        >
                          <IconButton
                            size="small"
                            aria-label={`Mention ${item.directMessageAgent.title}`}
                            onClick={event => {
                              event.stopPropagation();
                              mentionItem(item);
                            }}
                          >
                            <TagIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                      ) : null}
                    </>
                  ),
                }}
              />
            );
          })}
          {!query.isLoading && !query.isError && items.length === 0 ? (
            <Alert severity="info">No authored chat messages yet.</Alert>
          ) : null}
        </Stack>
      </ChatSurface>
      <Box
        className="mobile-chat-chrome mobile-chat-composer"
        onKeyDown={event => {
          if (!event.defaultPrevented && event.key === "Escape" && replyTarget) {
            event.preventDefault();
            clearReplyTarget();
          }
        }}
        data-mobile-composer-hidden={mobileComposer.hidden ? "true" : "false"}
        onTransitionEnd={event => {
          if (
            event.currentTarget !== event.target ||
            event.propertyName !== "max-height"
          )
            return;
          mobileComposer.finishTransition();
        }}
        sx={{ minWidth: 0 }}
      >
        {notice ? (
          <Alert severity="success" sx={{ mx: 1.5, mt: 1 }}>
            {notice}
          </Alert>
        ) : null}
        {send.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            {send.error instanceof Error
              ? send.error.message
              : "Direct message could not be sent."}
          </Alert>
        ) : null}
        <Composer
          destinationMode="target-required"
          requiredRecipient={replyTarget ? {
            handle: agentMentionHandle(replyTarget.title),
            title: replyTarget.title,
            onClear: () => setReplyTarget(undefined),
          } : undefined}
          recipientRequiredMessage="Tag an Agent with # to choose a recipient."
          commands={selectedCommands}
          capabilities={
            selectedEngineCapabilities?.composerCapabilities ?? []
          }
          onCapabilitiesOpen={refreshSelectedCapabilities}
          onCommand={invokeCommand}
          disabled={send.isPending}
          running={false}
          allowUnmentionedSend={Boolean(replyTarget)}
          attachmentsEnabled
          placeholder={replyTarget ? `Message ${replyTarget.title}` : "Write a message, then choose an Agent"}
          insertTextRequest={mentionInsertRequest}
          removeTextRequest={mentionRemoveRequest}
          draftStorageKey="messages:composer"
          onSend={(body, files, draftAttachmentIds = [], draftOwnerId) =>
            send.mutateAsync({
              body,
              files,
              draftAttachmentIds,
              draftOwnerId,
            })
          }
        />
      </Box>
    </Box>
  );
}
