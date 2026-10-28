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
  AgentDto,
  AgentMentionBindingDto,
  AllChatDecisionEventDto,
  AllChatItemDto,
  AssetDto,
  EngineCommand,
  EngineDto,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { AGENT_DETAIL_PAGE_SIZE } from "../agentHistoryPagination";
import {
  useAllChat,
  useAgentHealth,
  useAgents,
  useConversations,
  useEngines,
  useProjects,
  useWorkspacePreferences,
} from "../hooks/queries";
import type { Route } from "../routing";
import {
  ChatMessageBody,
  fileOwnerForMessage,
  authoredAgentMentionForHandle,
  communicationVisibleText,
  resolveMessageMentionText,
  showBroadcastBadge,
} from "./chat/ChatMessages";
import { Composer } from "./chat/Composer";
import { copyText } from "../clipboard";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { LiveAgentProgress } from "./chat/LiveAgentProgress";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { useMutationNotification } from "./MutationNotifications";
import { MessageRequestAction } from "./MessageRequestAction";
import { TimedChatLiveBanner } from "./chat/ChatLiveBanner";
import { ChatSurface } from "./chat/ChatSurface";
import { OutgoingMessageProvider } from "./chat/OutgoingMessage";
import { publishCreatedAgent, publishUpdatedAgent, refreshAgentRuntime } from "../conversationAgentCache";
import { uniqueBy } from "../collections";
import TagIcon from "@mui/icons-material/Tag";
import { createClientId } from "../clientId";
import {
  cleanupRecipientUploadsForDefinitiveFailure,
  fileSelectionFingerprint,
  pendingDraftAttachmentIds,
  pendingRecipientUploads,
  persistRecipientUploadAuthority,
  recipientUploadsForAgentIds,
  retryRecipientUploadCleanup,
  stableMessageActionText,
  withPendingRecipientUploads,
  withPendingRequest,
  type RecipientUploads,
  uploadFilesForRecipients,
} from "../conversationRouting";
import { pickAgentName } from "../parkNames";
import { queryKeys } from "../queryKeys";
import { loadRetainedData } from "../retainedData";
import { DecisionCard } from "./decisions/DecisionCard";
import { DecisionResponseMessage } from "./decisions/DecisionResponseMessage";
import { AgentRuntimeControls } from "./AgentDetail.parts";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { resolveRuntimeSelection } from "../conversationEngine";
import { pendingRuntimeSelection, runtimeMutationOptions, useRuntimeControls, useRuntimeSaving } from "../hooks/useRuntimeControls";
import { decisionChoice } from "./ConversationView.helpers";
import { CompactWorkspaceHeader } from "./WorkspaceFrame";
import { useConversationNotificationVisibility } from "./useConversationNotificationVisibility";
import { ChatComposerDock } from "./chat/ChatComposerDock";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { ReadAloudControls } from "./speech/ReadAloudControls";
import { ActiveOperationStopDialog } from "./ActiveOperationStopDialog";
import {
  acceptDirectOperation,
  createCreationOperationTracker,
  createDeliveryOperationTracker,
  createQueuedSteerOperationTracker,
} from "./activeOperationTracker";
import { useMessageDeliveryReceipts } from "./useMessageDeliveryReceipts";
import { useActiveOperationController } from "./useActiveOperationController";
import { useQueuedConversationMessagesController } from "./useQueuedConversationMessagesController";
import {
  abandonIdempotentAttempt,
  compoundCreationUnavailableUploads,
  preparedIdempotentAttemptForRetry,
  retainIdempotentAttempt,
  withCommittedAgentCreation,
  withPendingAgentTitle,
  type IdempotentAttempt,
} from "./idempotentAttempt";
import { recipientUploadControls } from "./recipientUploadControls";

interface AllChatSubmissionPrepared {
  projectId: string;
  body: string;
  files: File[];
  draftAttachmentIds: string[];
  draftOwnerId?: string;
  newAgentRequested: boolean;
  recipientIds: string[];
  recipientTitles: Map<string, string>;
  existingAgentTitles: string[];
  conversationId?: string;
  runtime: AllChatRuntimePayload;
  title?: string;
  uploads?: RecipientUploads<Pick<AssetDto, "id">>;
}
import {
  ALL_CHAT_REPLY_TARGET_KEY,
  ALL_CHAT_SOURCE_KEY,
  allChatDeliveryConfirmation,
  allChatComposerConversationId,
  allChatSourceIntentKey,
  authoritativeAllChatReplyTarget,
  busyAllChatMentionHandles,
  allChatRuntimePayloadSnapshot,
  allChatRuntimeSelectionReady,
  allChatSourceConversationId,
  allChatSourceIdentity,
  eligibleAllChatTargets,
  parseAllChatSourceIdentity,
  reduceAllChatSubmissionIntent,
  type AllChatReplyTarget,
  type AllChatRuntimePayload,
  type AllChatSourceIdentity,
} from "./allChatRouting";

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

function sourceLabel(item: AllChatItemDto): string {
  return item.source.title;
}

function allChatSourceAccessibleName(item: AllChatItemDto): string {
  const normalized = item.text.replace(/\s+/gu, " ").trim();
  const excerpt =
    normalized.length > 80
      ? `${normalized.slice(0, 79)}…`
      : normalized || "Empty message";
  return `Use ${sourceLabel(item)} as the source Chat. Message from ${item.author.label}, sent ${new Date(item.createdAt).toLocaleString()}: ${excerpt}`;
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
    queryClient,
  );
  const [older, setOlder] = useState<{
    items: AllChatItemDto[];
    decisions: AllChatDecisionEventDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [replyTarget, setReplyTarget] = useState<AllChatReplyTarget>();
  const [composerSource, setComposerSource] = useState<
    AllChatSourceIdentity | undefined
  >(() => parseAllChatSourceIdentity(readChatState(ALL_CHAT_SOURCE_KEY)));
  const [submissionIntent, dispatchSubmissionIntent] = useReducer(
    reduceAllChatSubmissionIntent,
    {
      epoch: 0,
      ...(composerSource
        ? {
            sourceKey: JSON.stringify([
              composerSource.projectId,
              composerSource.conversationId,
            ]),
          }
        : {}),
    },
  );
  const submissionIntentRef = useRef(submissionIntent);
  submissionIntentRef.current = submissionIntent;
  const replyTargetRef = useRef(replyTarget);
  replyTargetRef.current = replyTarget;
  const sendAttempt = useRef<IdempotentAttempt<AllChatSubmissionPrepared>>();
  const sendAttempts = useRef(new Map<string, IdempotentAttempt<AllChatSubmissionPrepared>>());
  const abandonedSendAttempts = useRef<
    IdempotentAttempt<AllChatSubmissionPrepared>[]
  >([]);
  const [runtimeEngine, setRuntimeEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState("");
  const [submissionRuntimeIntent, setSubmissionRuntimeIntent] = useState(0);
  const [runtimeAgentId, setRuntimeAgentId] = useState<string>();
  const notify = useMutationNotification();
  const [commandResult, setCommandResult] = useState<string>();
  const [pendingUploadCleanups, setPendingUploadCleanups] = useState(0);
  const {
    recipientUnavailable, cleanupSettled, definitiveFailure,
    cleanupPendingReporter, cleanupRecipientUploads,
  } = recipientUploadControls({
    deleteAttachment: (agentId, attachmentId) => api.deleteAttachment(agentId, attachmentId),
    onPendingDelta: delta => setPendingUploadCleanups(count => Math.max(0, count + delta)),
  });
  const [directSendConfirmation, setDirectSendConfirmation] = useState<{
    id: number;
    text: string;
  }>();
  const directSendConfirmationSequence = useRef(0);
  const dismissDirectSendConfirmation = useCallback(
    () => setDirectSendConfirmation(undefined),
    [],
  );
  const [mentionRemoveRequest, setMentionRemoveRequest] = useState<{
    id: string;
    text: string;
  }>();
  const mentionedHandlesRef = useRef<string[]>([]);
  const pendingMentionTargetId = useRef<string>();
  const availableProjectIds = useMemo(
    () => projectsQuery.data
      ? new Set(projectsQuery.data.map(project => project.id))
      : undefined,
    [projectsQuery.data],
  );
  const retainedItems = useMemo(
    () => mergeAllChatItems(older?.items ?? [], query.data?.items ?? [])
      .filter(item => !availableProjectIds || availableProjectIds.has(item.project.id)),
    [availableProjectIds, older?.items, query.data?.items],
  );
  const items = useMessageDeliveryReceipts(retainedItems);
  useEffect(() => {
    if (!availableProjectIds) return;
    setReplyTarget(current =>
      current && !availableProjectIds.has(current.projectId) ? undefined : current,
    );
    setComposerSource(current =>
      current && !availableProjectIds.has(current.projectId) ? undefined : current,
    );
    setSelectedId(current =>
      current && !items.some(item => item.communicationEventId === current)
        ? undefined
        : current,
    );
  }, [availableProjectIds, items]);
  const selected = items.find(item => item.communicationEventId === selectedId);
  const activeProjectId =
    selected?.project.id ?? replyTarget?.projectId ?? composerSource?.projectId;
  const projectAgentsQuery = useAgents(activeProjectId);
  const agentHealthQuery = useAgentHealth(activeProjectId);
  const selectedSourceConversationId = allChatSourceConversationId(
    selected?.source,
    projectAgentsQuery.data ?? [],
  );
  const composerConversationId = allChatComposerConversationId(
    selectedSourceConversationId,
    replyTarget?.conversationId,
    composerSource,
  );
  const activeReplyTarget = authoritativeAllChatReplyTarget(
    replyTarget,
    selected?.project.id ?? activeProjectId,
    composerConversationId,
  );
  const allProjectAgentsQuery = useQuery({
    queryKey: queryKeys.agents.allChat,
    queryFn: async () => {
      const byId = new Map<string, WorkspaceAgentDirectoryItemDto>();
      let cursor: string | undefined;
      do {
        const page = await api.getWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>(
          "agent",
          { limit: 100, cursor },
        );
        for (const item of [...page.starredItems, ...page.items]) {
          byId.set(item.agent.id, item);
        }
        const nextCursor = page.history.hasMore ? page.history.cursor : undefined;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      } while (cursor);
      return [...byId.values()];
    },
    enabled: !activeProjectId,
    staleTime: 30_000,
  });
  const composerTargets = useMemo(() => {
    const byId = new Map<string, AllChatReplyTarget>();
    for (const item of items) {
      if (!item.directMessageAgent || item.project.id !== activeProjectId) continue;
      const agent = projectAgentsQuery.data?.find(candidate =>
        candidate.id === item.directMessageAgent?.id);
      byId.set(item.directMessageAgent.id, {
        ...item.directMessageAgent,
        projectId: item.project.id,
        conversationId: agent?.conversationId,
      });
    }
    for (const agent of projectAgentsQuery.data ?? []) {
      if (!activeProjectId) continue;
      byId.set(agent.id, {
        id: agent.id,
        title: agent.title,
        handle: agent.handle,
        projectId: activeProjectId,
        conversationId: agent.conversationId,
      });
    }
    if (!activeProjectId) {
      for (const { project, agent } of allProjectAgentsQuery.data ?? []) {
        byId.set(agent.id, {
          id: agent.id,
          title: agent.title,
          handle: agent.handle,
          projectId: project.id,
          conversationId: agent.conversationId,
        });
      }
    }
    const eligibleTargets = eligibleAllChatTargets(
      byId.values(),
      composerConversationId,
    );
    const groups = new Map<string, Array<{ handle: string; target: AllChatReplyTarget }>>();
    for (const target of eligibleTargets) {
      const handle = target.handle;
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
      mentionBindings: eligibleTargets.map(target => ({
        projectId: target.projectId,
        handle: target.handle,
        agentId: target.id,
        currentHandle: target.handle,
        currentTitle: target.title,
      })),
      targetByHandle,
    };
  }, [
    activeProjectId,
    allProjectAgentsQuery.data,
    composerConversationId,
    items,
    projectAgentsQuery.data,
  ]);
  const healthByAgentId = useMemo(
    () => new Map(
      (agentHealthQuery.data?.agents ?? []).map(health => [health.agentId, health]),
    ),
    [agentHealthQuery.data?.agents],
  );
  const busyMentionHandles = useMemo(
    () => busyAllChatMentionHandles(
      composerTargets.targetByHandle.values(),
      agentHealthQuery.data?.agents ?? [],
    ),
    [agentHealthQuery.data?.agents, composerTargets.targetByHandle],
  );
  const allChatAgentTitle = (agentId: string | undefined) =>
    projectAgentsQuery.data?.find(agent => agent.id === agentId)?.title ??
    [...composerTargets.targetByHandle.values()]
      .find(agent => agent.id === agentId)?.title ??
    "Agent";
  const invalidateOperation = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
    if (activeProjectId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.health(activeProjectId),
      });
    }
    if (composerConversationId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.detailPrefix(composerConversationId),
      });
    }
  };
  const {
    cancelOperationError,
    cancelOperationPending,
    cancelOperationTargets,
    operationRunning,
    setActiveOperation,
    setStopConfirmation,
    stopConfirmation,
    stopOperation,
  } = useActiveOperationController({
    activeScopeId: composerConversationId,
    healthByAgentId,
    receiptSources: items,
    agentTitle: allChatAgentTitle,
    invalidate: invalidateOperation,
  });
  const composerScopeRef = useRef(composerConversationId);
  composerScopeRef.current = composerConversationId;
  const queuedMessages = useQueuedConversationMessagesController(
    composerConversationId,
    message => composerConversationId && setActiveOperation(
      createQueuedSteerOperationTracker(
        message.deliveryId,
        message.targetAgentId,
        healthByAgentId,
        composerConversationId,
      ),
    ),
  );
  const decisionEvents = useMemo(
    () => uniqueBy(
      [...(older?.decisions ?? []), ...(query.data?.decisions ?? [])],
      (item) => item.id,
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    ).filter(item => !availableProjectIds || availableProjectIds.has(item.project.id)),
    [availableProjectIds, older?.decisions, query.data?.decisions],
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
        const choice = decisionChoice(item.decision);
        return choice ? [{ kind: "decision-response", id: item.id, at: item.createdAt, item, choice }] : [];
      }),
    ];
    return entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  }, [decisionEvents, items]);
  const layoutKey = timeline.map((entry) => entry.id).join(":");
  const selectedAgentId = activeReplyTarget?.id;
  const runtimeSaving = useRuntimeSaving(`agent:${selectedAgentId ?? ""}`);
  const hydratedRuntimeAgent = useRef<string>();
  const selectedProjectId = activeProjectId;
  const selectedAgent = useQuery({
    queryKey: queryKeys.agents.detail(selectedAgentId),
    queryFn: () => api.getAgent(selectedAgentId!, AGENT_DETAIL_PAGE_SIZE),
    enabled: Boolean(selectedAgentId),
  });
  const conversationsQuery = useConversations(selectedProjectId);
  useEffect(() => {
    setReplyTarget(current => {
      if (!current) return current;
      if (!projectAgentsQuery.data) return current;
      const agent = projectAgentsQuery.data?.find(candidate => candidate.id === current.id);
      if (!agent) return undefined;
      if (
        current.title === agent.title &&
        current.handle === agent.handle &&
        current.conversationId === agent.conversationId
      ) return current;
      return {
        ...current,
        title: agent.title,
        handle: agent.handle,
        conversationId: agent.conversationId,
      };
    });
  }, [projectAgentsQuery.data]);
  useEffect(() => {
    // A restored draft is not permission to reply from the global feed.
    writeChatState(ALL_CHAT_REPLY_TARGET_KEY, "");
  }, []);
  useEffect(() => {
    if (!selected) return;
    const identity = allChatSourceIdentity(
      selected.project.id,
      selected.source,
      projectAgentsQuery.data ?? [],
    );
    if (identity) setComposerSource(identity);
  }, [projectAgentsQuery.data, selected]);
  useEffect(() => {
    if (!selectedSourceConversationId && activeReplyTarget?.conversationId) {
      setComposerSource({
        projectId: activeReplyTarget.projectId,
        conversationId: activeReplyTarget.conversationId,
      });
    }
  }, [activeReplyTarget, selectedSourceConversationId]);
  useEffect(() => {
    if (!replyTarget || activeReplyTarget || !composerConversationId) return;
    if (
      !replyTarget.conversationId &&
      replyTarget.projectId === (selected?.project.id ?? activeProjectId)
    ) return;
    pendingMentionTargetId.current = undefined;
    setMentionRemoveRequest({
      id: `source-mismatch:${replyTarget.id}:${Date.now()}`,
      text: `#${replyTarget.handle}`,
    });
    setReplyTarget(undefined);
  }, [activeProjectId, activeReplyTarget, composerConversationId, replyTarget, selected]);
  useEffect(() => {
    writeChatState(
      ALL_CHAT_SOURCE_KEY,
      composerSource ? JSON.stringify(composerSource) : "",
    );
  }, [composerSource]);
  const engines = enginesQuery.data ?? [];
  const project = projectsQuery.data?.find(
    item => item.id === selectedProjectId,
  );
  const runtimeSelectionReady = allChatRuntimeSelectionReady(
    selectedAgentId,
    runtimeAgentId,
  );
  const selectedEngineId = runtimeSelectionReady
    ? runtimeEngine || selectedAgent.data?.agent.activeEngine
    : selectedAgentId
      ? selectedAgent.data?.agent.activeEngine
      : undefined;
  const selectedModel = runtimeSelectionReady
    ? model || selectedAgent.data?.agent.model
    : selectedAgent.data?.agent.model;
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
    },
  });
  useEffect(() => {
    if (!selectedAgentId) {
      setRuntimeEngine("");
      setModel("");
      setEffort("");
      setSpeed("");
      setRuntimeAgentId(undefined);
      return;
    }
    if (runtimeSaving && hydratedRuntimeAgent.current === selectedAgentId) return;
    const agent = selectedAgent.data?.agent;
    if (!agent || !enginesQuery.data || !workspacePreferences.data || !projectsQuery.data) return;
    const selection = { engine: agent.activeEngine, model: agent.model, effort: agent.effort, speed: agent.speed, ...pendingRuntimeSelection(queryClient, `agent:${agent.id}`) };
    const engine = engines.find(item => item.id === selection.engine);
    const resolved = resolveRuntimeSelection(engine, workspacePreferences.data, project, {
      model: selection.model ?? undefined,
      effort: selection.effort ?? undefined,
      speed: selection.speed ?? undefined,
    });
    hydratedRuntimeAgent.current = agent.id;
    setRuntimeAgentId(agent.id);
    setRuntimeEngine(selection.engine);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed ?? "");
  }, [
    engines,
    enginesQuery.data,
    project,
    projectsQuery.data,
    selectedAgent.data?.agent,
    selectedAgentId,
    workspacePreferences.data,
    runtimeSaving,
  ]);
  const updateRuntimeEngine = useMutation({
    ...runtimeMutationOptions(`agent:${selectedAgentId ?? ""}`),
    mutationFn: ({
      agentId,
      activeEngine,
      model: nextModel,
      effort: nextEffort,
      speed: nextSpeed,
    }: {
      agentId: string;
      activeEngine: EngineDto["id"];
      model: string | null;
      effort: string | null;
      speed: string | null;
    }) =>
      api.updateAgent(agentId, {
        activeEngine,
        model: nextModel,
        effort: nextEffort,
        speed: nextSpeed,
      }),
    onSuccess: updated => {
      publishUpdatedAgent(queryClient, updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(updated.projectId),
      });
    },
    onSettled: (_updated, _error, variables) => refreshAgentRuntime(queryClient, variables.agentId),
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
    if (result.outcome && result.outcome !== "completed") throw new Error(result.message ?? "Provider command completion is unconfirmed. Do not repeat the command.");
    setCommandResult(result.message);
    if (!result.message) notify({ key: "provider-command", message: `/${command.name} Completed` });
