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
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import type {
  AllChatItemDto,
  EngineCommand,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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

function AllChatInfoPill({ message }: { message: string }): JSX.Element {
  return (
    <Box
      role="status"
      sx={{
        position: "relative",
        zIndex: 3,
        display: "flex",
        width: "fit-content",
        alignItems: "center",
        minHeight: 28,
        maxWidth: "100%",
        mt: { xs: 0.75, sm: 1 },
        mb: { xs: 1, sm: 1.5 },
        px: 0.75,
        py: 0.25,
        borderRadius: 999,
        color: "info.main",
        bgcolor: "action.hover",
        boxShadow: theme =>
          theme.palette.mode === "dark"
            ? "0 10px 30px rgba(3,8,6,.18)"
            : "0 10px 30px rgba(33,45,38,.09)",
      }}
    >
      <InfoOutlinedIcon sx={{ mr: 0.5, fontSize: 16, flex: "0 0 auto" }} />
      <Typography
        variant="caption"
        component="span"
        sx={{
          color: "text.secondary",
          fontWeight: 650,
          overflowWrap: "anywhere",
        }}
      >
        {message}
      </Typography>
    </Box>
  );
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
  const [older, setOlder] = useState<{
    items: AllChatItemDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{
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
  const layoutKey = items.map(item => item.communicationEventId).join(":");
  const selected = items.find(item => item.communicationEventId === selectedId);
  const selectedAgentId = selected?.directMessageAgent?.id;
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
      if (!selected?.directMessageAgent)
        throw new Error("Select a message tied to one exact Agent");
      if (!body.trim() && files.length === 0)
        throw new Error("Message text or an attachment is required");
      const attachments = draftAttachmentIds.length
        ? []
        : await Promise.all(
            files.map(file =>
              api.uploadAttachment(selected.directMessageAgent!.id, file),
            ),
          );
      try {
        return await api.sendMessage(selected.directMessageAgent.id, {
          text: body.trim(),
          attachmentIds: attachments.map(item => item.id),
          ...(draftAttachmentIds.length
            ? {
                draftAttachmentIds,
                draftId: `agent:${selected.directMessageAgent.id}`,
                draftOwnerId,
              }
            : {}),
          idempotencyKey: createClientId(),
          activeRunDelivery: "steer",
        });
      } catch (error) {
        await Promise.allSettled(
          attachments.map(item =>
            api.deleteAttachment(selected.directMessageAgent!.id, item.id),
          ),
        );
        throw error;
      }
    },
    onSuccess: () => {
      setNotice(
        `Direct message sent to ${selected?.directMessageAgent?.title ?? "Agent"}.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
      if (selected?.directMessageAgent) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detailPrefix(
            selected.directMessageAgent.id,
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
  const mentionItem = (item: AllChatItemDto) => {
    selectItem(item);
    if (!item.directMessageAgent) return;
    setMentionInsertRequest({
      id: `${item.communicationEventId}:${Date.now()}`,
      text: `#${agentMentionHandle(item.directMessageAgent.title)}`,
    });
  };
  const history = older ?? {
    items: [],
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
          notifications={notifications}
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
          {items.map(item => {
            const fromUser = item.author.kind === "user";
            return (
              <ChatMessageFrame
                key={item.communicationEventId}
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
        {!selected ? (
          <Box sx={{ display: "flex", justifyContent: "center" }}>
            <AllChatInfoPill message="Select an Agent-authored message to mention that Agent." />
          </Box>
        ) : !selected.directMessageAgent ? (
          <Box sx={{ display: "flex", justifyContent: "center" }}>
            <AllChatInfoPill message="This message does not identify an active Agent you can message." />
          </Box>
        ) : (
          <>
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
              commands={selectedCommands}
              capabilities={
                selectedEngineCapabilities?.composerCapabilities ?? []
              }
              onCapabilitiesOpen={refreshSelectedCapabilities}
              onCommand={invokeCommand}
              disabled={send.isPending}
              running={false}
              attachmentsEnabled
              guidance="Message this Agent directly. Use @ to reference a project file."
              placeholder={`Message ${selected.directMessageAgent.title}`}
              insertTextRequest={mentionInsertRequest}
              draftStorageKey={`messages:agent:${selected.directMessageAgent.id}`}
              conversationDraftId={`agent:${selected.directMessageAgent.id}`}
              onSend={(body, files, draftAttachmentIds = [], draftOwnerId) =>
                send.mutateAsync({
                  body,
                  files,
                  draftAttachmentIds,
                  draftOwnerId,
                })
              }
            />
          </>
        )}
      </Box>
    </Box>
  );
}
