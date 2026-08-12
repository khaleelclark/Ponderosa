import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import type {
  AllChatDecisionEventDto,
  AllChatItemDto,
  EngineCommand,
  EngineDto,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { AGENT_DETAIL_PAGE_SIZE } from "../agentHistoryPagination";
import {
  useAllChat,
  useConversations,
  useEngines,
  useProjects,
  useWorkspacePreferences,
} from "../hooks/queries";
import type { Route } from "../routing";
import {
  ChatMessageBody,
  authoredAgentMentionForHandle,
  communicationVisibleText,
  showBroadcastBadge,
} from "./chat/ChatMessages";
import { Composer } from "./chat/Composer";
import { copyText } from "../clipboard";
import { agentMentionHandle } from "../mentions";
import { AttentionSurface } from "./AttentionSurface";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { TimedChatLiveBanner } from "./chat/ChatLiveBanner";
import { ChatSurface } from "./chat/ChatSurface";
import { uniqueBy } from "../collections";
import TagIcon from "@mui/icons-material/Tag";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import { DecisionCard } from "./decisions/DecisionCard";
import { AgentRuntimeControls } from "./AgentDetail.parts";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import {
  resolveRuntimeSelection,
  runtimeControlState,
} from "../conversationEngine";
import { useRuntimeControls } from "../hooks/useRuntimeControls";
import { AUTO_ALLOWED_DECISION_OPTION_ID } from "./ConversationView.helpers";
import { CompactWorkspaceHeader } from "./WorkspaceFrame";
import { useConversationNotificationVisibility } from "./useConversationNotificationVisibility";
import { ChatComposerDock } from "./chat/ChatComposerDock";

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

type AllChatReplyTarget = {
  id: string;
  title: string;
  projectId: string;
};

function allChatDecisionChoice(item: AllChatDecisionEventDto): string | undefined {
  const { decision } = item;
  if (
    decision.response?.optionId === AUTO_ALLOWED_DECISION_OPTION_ID
  ) {
    return decision.response.text;
  }
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
  const enginesQuery = useEngines();
  const projectsQuery = useProjects();
  const queryClient = useQueryClient();
  const markCommunicationVisible = useConversationNotificationVisibility(
    { data: notifications },
    queryClient,
  );
  const [older, setOlder] = useState<{
    items: AllChatItemDto[];
    decisions: AllChatDecisionEventDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [replyTarget, setReplyTarget] = useState<AllChatReplyTarget>();
  const [runtimeEngine, setRuntimeEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState("");
  const initializedRuntime = useRef<string>();
  const [notice, setNotice] = useState<string>();
  const [directSendConfirmation, setDirectSendConfirmation] = useState<{
    id: number;
    text: string;
  }>();
  const directSendConfirmationSequence = useRef(0);
  const dismissDirectSendConfirmation = useCallback(
    () => setDirectSendConfirmation(undefined),
    [],
  );
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{
    id: string;
    text: string;
  }>();
  const [mentionRemoveRequest, setMentionRemoveRequest] = useState<{
    id: string;
    text: string;
  }>();
  const items = useMemo(
    () => mergeAllChatItems(older?.items ?? [], query.data?.items ?? []),
    [older?.items, query.data?.items],
  );
  const composerTargets = useMemo(() => {
    const byId = new Map<string, AllChatReplyTarget>();
    for (const item of items) {
      if (!item.directMessageAgent) continue;
      byId.set(item.directMessageAgent.id, {
        ...item.directMessageAgent,
        projectId: item.project.id,
      });
    }
    const groups = new Map<string, Array<{ handle: string; target: AllChatReplyTarget }>>();
    for (const target of byId.values()) {
      const handle = agentMentionHandle(target.title);
      const normalized = handle.toLocaleLowerCase();
      if (!handle || ["broadcast", "user", "everyone"].includes(normalized)) continue;
      const group = groups.get(normalized) ?? [];
      group.push({ handle, target });
      groups.set(normalized, group);
    }
    const targetByHandle = new Map<string, AllChatReplyTarget>();
    for (const [handle, group] of groups) {
      if (group.length === 1) targetByHandle.set(handle, group[0]!.target);
    }
    return {
      handles: [...groups.values()].map((group) => group[0]!.handle),
      suggestionHandles: [...groups.values()]
        .filter((group) => group.length === 1)
        .map((group) => group[0]!.handle),
      ambiguousHandles: [...groups.values()]
        .filter((group) => group.length > 1)
        .map((group) => group[0]!.handle),
      targetByHandle,
    };
  }, [items]);
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
  const selectedProjectId = replyTarget?.projectId;
  const selectedAgent = useQuery({
    queryKey: queryKeys.agents.detail(selectedAgentId),
    queryFn: () => api.getAgent(selectedAgentId!, AGENT_DETAIL_PAGE_SIZE),
    enabled: Boolean(selectedAgentId),
  });
  const conversationsQuery = useConversations(selectedProjectId);
  const engines = enginesQuery.data ?? [];
  const project = projectsQuery.data?.find(
    item => item.id === selectedProjectId,
  );
  const selectedEngineId =
    runtimeEngine || selectedAgent.data?.agent.activeEngine;
  const selectedModel = model || selectedAgent.data?.agent.model;
  const selectedEngine = engines.find(
    item => item.id === selectedEngineId,
  );
  const selectedRuntime = useRuntimeControls({
    engine: selectedEngine,
    preferences: workspacePreferences.data,
    project,
    selection: { model, effort, speed },
    onChange: next => {
      setModel(next.model);
      setEffort(next.effort);
      setSpeed(next.speed ?? "");
      if (selectedAgentId) {
        writeChatState(
          chatStateKey("runtime", `agent.${selectedAgentId}.speed`),
          next.speed ?? "",
        );
      }
    },
  });
  useEffect(() => {
    if (!selectedAgentId) {
      initializedRuntime.current = undefined;
      setRuntimeEngine("");
      setModel("");
      setEffort("");
      setSpeed("");
      return;
    }
    const agent = selectedAgent.data?.agent;
    if (!agent) return;
    const initializationKey = [
      agent.id,
      agent.activeEngine,
      agent.model ?? "",
      agent.effort ?? "",
    ].join(":");
    if (initializedRuntime.current === initializationKey) return;
    const engine = engines.find(item => item.id === agent.activeEngine);
    const resolved = runtimeControlState(engine, {
      model:
        agent.model ??
        resolveRuntimeSelection(
          engine,
          workspacePreferences.data,
          project,
        ).model,
      effort:
        agent.effort ??
        resolveRuntimeSelection(
          engine,
          workspacePreferences.data,
          project,
        ).effort,
      speed: readChatState(
        chatStateKey("runtime", `agent.${agent.id}.speed`),
      ),
    });
    initializedRuntime.current = initializationKey;
    setRuntimeEngine(agent.activeEngine);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed);
  }, [
    engines,
    project,
    selectedAgent.data?.agent,
    selectedAgentId,
    workspacePreferences.data,
  ]);
  const updateRuntimeEngine = useMutation({
    mutationFn: ({
      agentId,
      activeEngine,
      model: nextModel,
      effort: nextEffort,
    }: {
      agentId: string;
      activeEngine: EngineDto["id"];
      model: string | null;
      effort: string | null;
    }) =>
      api.updateAgent(agentId, {
        activeEngine,
        model: nextModel,
        effort: nextEffort,
      }),
    onSuccess: updated => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(updated.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(updated.projectId),
      });
    },
  });
  const selectedCapabilities = useQuery({
    queryKey: queryKeys.engines.capabilitySelection(
      selectedProjectId,
      selectedAgentId,
      selectedEngineId,
      selectedModel,
    ),
    queryFn: () =>
      api.getEngineCapabilities(selectedProjectId!, {
        engineId: selectedEngineId,
        model: selectedModel,
        agentId: selectedAgentId,
      }),
    enabled: Boolean(
      selectedProjectId && selectedAgentId && selectedEngineId,
    ),
    staleTime: 10_000,
  });
  const selectedEngineCapabilities = selectedCapabilities.data?.find(
    item => item.engineId === selectedEngineId,
  );
  const selectedCommands: EngineCommand[] =
    selectedEngineCapabilities?.commands ?? [];
  const refreshSelectedCapabilities = async () => {
    if (!selectedProjectId || !selectedAgentId) return;
    const discovered = await api.getEngineCapabilities(selectedProjectId, {
      engineId: selectedEngineId,
      model: selectedModel,
      agentId: selectedAgentId,
      refresh: true,
    });
    queryClient.setQueryData(
      queryKeys.engines.capabilitySelection(
        selectedProjectId,
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
        `/${command.name} completed for ${replyTarget?.title ?? "Agent"}.`,
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
          ...(selectedRuntime.model
            ? { model: selectedRuntime.model }
            : {}),
          ...(selectedRuntime.effort
            ? { effort: selectedRuntime.effort }
            : {}),
          ...(selectedRuntime.speed
            ? { speed: selectedRuntime.speed }
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
      setNotice(undefined);
      directSendConfirmationSequence.current += 1;
      setDirectSendConfirmation({
        id: directSendConfirmationSequence.current,
        text: `Direct message sent to ${replyTarget?.title ?? "Agent"}.`,
      });
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
    setDirectSendConfirmation(undefined);
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
  const syncReplyTargetFromMentions = useCallback((handles: string[]) => {
    const agentHandles = handles.filter(
      (handle) => !["broadcast", "user", "everyone"].includes(handle.toLocaleLowerCase()),
    );
    const handle = agentHandles.length === 1 ? agentHandles[0] : undefined;
    const resolved = handle
      ? composerTargets.targetByHandle.get(handle.toLocaleLowerCase())
      : undefined;
    setReplyTarget((current) => {
      if (resolved) return current?.id === resolved.id ? current : resolved;
      if (
        handle &&
        current &&
        agentMentionHandle(current.title).toLocaleLowerCase() === handle.toLocaleLowerCase()
      )
        return current;
      return undefined;
    });
  }, [composerTargets.targetByHandle]);
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
    setReplyTarget({
      ...item.directMessageAgent,
      projectId: item.project.id,
    });
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
  const runtimeControls =
    replyTarget && selectedAgent.data && selectedEngine ? (
      <AgentRuntimeControls
        engine={selectedEngine}
        engines={engines}
        model={model}
        models={selectedRuntime.models}
        effort={effort}
        efforts={selectedRuntime.efforts}
        speed={selectedRuntime.speed}
        speeds={selectedRuntime.speeds}
        selectedRuntime={selectedRuntime}
        onEngineChange={next => {
          const nextEngine = engines.find(item => item.id === next);
          if (!nextEngine || !selectedAgentId) return;
          const previous = {
            engine: selectedEngineId ?? "",
            model,
            effort,
            speed,
          };
          const resolved = resolveRuntimeSelection(
            nextEngine,
            workspacePreferences.data,
            project,
          );
          setRuntimeEngine(next);
          setModel(resolved.model);
          setEffort(resolved.effort);
          setSpeed(resolved.speed ?? "");
          writeChatState(
            chatStateKey("runtime", `agent.${selectedAgentId}.speed`),
            resolved.speed ?? "",
          );
          updateRuntimeEngine.mutate(
            {
              agentId: selectedAgentId,
              activeEngine: next as EngineDto["id"],
              model: resolved.model || null,
              effort: resolved.effort || null,
            },
            {
              onError: () => {
                setRuntimeEngine(previous.engine);
                setModel(previous.model);
                setEffort(previous.effort);
                setSpeed(previous.speed);
              },
            },
          );
        }}
      />
    ) : null;
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
      <CompactWorkspaceHeader
        icon={<ChatBubbleOutlineIcon fontSize="small" />}
        title="Messages Across Ponderosa"
      />
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
        follow={{ kind: "latest" }}
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
            if (entry.kind === "decision-response") {
              const automatic =
                entry.item.decision.response?.optionId ===
                AUTO_ALLOWED_DECISION_OPTION_ID;
              return <ChatMessageFrame
              key={entry.id}
              message={{
                id: entry.id,
                author: automatic
                  ? { kind: "notice" }
                  : {
                      kind: "operator",
                      profile: workspacePreferences.data?.profile,
                    },
                createdAt: entry.at,
                ariaLabel: automatic
                  ? entry.choice
                  : `You chose ${entry.choice}`,
                body: (
                  <Typography variant="body2">
                    {automatic
                      ? entry.choice
                      : `You chose ${entry.choice}.`}
                  </Typography>
                ),
              }}
              />;
            }
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
                  source:
                    showBroadcastBadge(
                      item.communicationIntent,
                      item.communicationEventId,
                    ) ? (
                      <Chip size="small" variant="outlined" label="Broadcast" />
                    ) : undefined,
                  attachments: item.attachments,
                  attachmentDensity: "compact",
                  onVisible: (visible) =>
                    markCommunicationVisible(
                      item.communicationEventId,
                      visible,
                    ),
                  ariaLabel: allChatSourceAccessibleName(item),
                  body: (
                    <ChatMessageBody
                      text={communicationVisibleText({
                        text: item.text,
                        intent: item.communicationIntent,
                        fromAgent: !fromUser,
                        agentMentions: item.agentMentions,
                      })}
                      collapseLongMessage
                      compactMarkdown
                      projectId={item.project.id}
                      operatorHandle={workspacePreferences.data?.profile.handle}
                      agentMentionForHandle={handle => {
                        const binding = authoredAgentMentionForHandle(
                          handle,
                          item.agentMentions,
                        );
                        if (binding) return binding;
                        return item.directMessageAgent &&
                          agentMentionHandle(
                            item.directMessageAgent.title,
                          ).toLocaleLowerCase() === handle.toLocaleLowerCase()
                          ? {
                              agentId: item.directMessageAgent.id,
                              label: agentMentionHandle(
                                item.directMessageAgent.title,
                              ),
                            }
                          : undefined;
                      }}
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
                      {!fromUser && item.directMessageAgent ? (
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
      <ChatComposerDock
        onKeyDown={event => {
          if (!event.defaultPrevented && event.key === "Escape" && replyTarget) {
            event.preventDefault();
            clearReplyTarget();
          }
        }}
      >
        {directSendConfirmation ? (
          <Box
            sx={{
              height: 28,
              px: { xs: 1, sm: 1.5 },
              mt: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              pointerEvents: "none",
            }}
          >
            <TimedChatLiveBanner
              key={directSendConfirmation.id}
              onDismiss={dismissDirectSendConfirmation}
            >
              {directSendConfirmation.text}
            </TimedChatLiveBanner>
          </Box>
        ) : null}
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
          recipientRequiredMessage={
            selected && !selected.directMessageAgent
              ? "This message does not identify an active Agent you can message."
              : "Tag an Agent with # to choose a recipient."
          }
          mentionHandles={composerTargets.handles}
          mentionSuggestionHandles={composerTargets.suggestionHandles}
          ambiguousMentionHandles={composerTargets.ambiguousHandles}
          onMentionedHandlesChange={syncReplyTargetFromMentions}
          commands={replyTarget ? selectedCommands : undefined}
          capabilities={
            selectedEngineCapabilities?.composerCapabilities ?? []
          }
          onCapabilitiesOpen={refreshSelectedCapabilities}
          onCommand={replyTarget ? invokeCommand : undefined}
          controls={runtimeControls}
          disabled={send.isPending || updateRuntimeEngine.isPending}
          running={false}
          allowUnmentionedSend={Boolean(replyTarget)}
          attachmentsEnabled
          placeholder={
            replyTarget
              ? `Message ${replyTarget.title} directly`
              : "Select an Agent with # then write a message"
          }
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
      </ChatComposerDock>
    </Box>
  );
}
