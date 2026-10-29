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
  InboxDecisionEventDto,
  InboxItemDto,
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
  useInbox,
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

interface InboxSubmissionPrepared {
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
  runtime: InboxRuntimePayload;
  title?: string;
  uploads?: RecipientUploads<Pick<AssetDto, "id">>;
}
import {
  INBOX_REPLY_TARGET_KEY,
  INBOX_SOURCE_KEY,
  inboxDeliveryConfirmation,
  inboxComposerConversationId,
  inboxSourceIntentKey,
  authoritativeInboxReplyTarget,
  busyInboxMentionHandles,
  inboxRuntimePayloadSnapshot,
  inboxRuntimeSelectionReady,
  inboxSourceConversationId,
  inboxSourceIdentity,
  eligibleInboxTargets,
  parseInboxSourceIdentity,
  reduceInboxSubmissionIntent,
  type InboxReplyTarget,
  type InboxRuntimePayload,
  type InboxSourceIdentity,
} from "./inboxRouting";

function inboxSourceRoute(item: InboxItemDto): Route {
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

function mergeInboxItems(
  ...groups: InboxItemDto[][]
): InboxItemDto[] {
  return uniqueBy(
    groups.flat(),
    item => item.communicationEventId,
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.communicationEventId.localeCompare(b.communicationEventId),
  );
}

type InboxTimelineEntry =
  | { kind: "message"; id: string; at: string; item: InboxItemDto }
  | { kind: "decision"; id: string; at: string; item: InboxDecisionEventDto }
  | { kind: "decision-response"; id: string; at: string; item: InboxDecisionEventDto; choice: string };

function sourceLabel(item: InboxItemDto): string {
  return item.source.title;
}

function inboxSourceAccessibleName(item: InboxItemDto): string {
  const normalized = item.text.replace(/\s+/gu, " ").trim();
  const excerpt =
    normalized.length > 80
      ? `${normalized.slice(0, 79)}…`
      : normalized || "Empty message";
  return `Use ${sourceLabel(item)} as the source Chat. Message from ${item.author.label}, sent ${new Date(item.createdAt).toLocaleString()}: ${excerpt}`;
}

export function InboxView({
  onNavigate,
  notifications = [],
}: {
  onNavigate(route: Route): void;
  notifications?: WorkspaceNotificationDto[];
}): JSX.Element {
  const query = useInbox();
  const workspacePreferences = useWorkspacePreferences();
  const enginesQuery = useEngines();
  const projectsQuery = useProjects();
  const queryClient = useQueryClient();
  const markCommunicationVisible = useConversationNotificationVisibility(
    queryClient,
  );
  const [older, setOlder] = useState<{
    items: InboxItemDto[];
    decisions: InboxDecisionEventDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [replyTarget, setReplyTarget] = useState<InboxReplyTarget>();
  const [composerSource, setComposerSource] = useState<
    InboxSourceIdentity | undefined
  >(() => parseInboxSourceIdentity(readChatState(INBOX_SOURCE_KEY)));
  const [submissionIntent, dispatchSubmissionIntent] = useReducer(
    reduceInboxSubmissionIntent,
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
  const sendAttempt = useRef<IdempotentAttempt<InboxSubmissionPrepared>>();
  const sendAttempts = useRef(new Map<string, IdempotentAttempt<InboxSubmissionPrepared>>());
  const abandonedSendAttempts = useRef<
    IdempotentAttempt<InboxSubmissionPrepared>[]
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
    () => mergeInboxItems(older?.items ?? [], query.data?.items ?? [])
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
  const selectedSourceConversationId = inboxSourceConversationId(
    selected?.source,
    projectAgentsQuery.data ?? [],
  );
  const composerConversationId = inboxComposerConversationId(
    selectedSourceConversationId,
    replyTarget?.conversationId,
    composerSource,
  );
  const activeReplyTarget = authoritativeInboxReplyTarget(
    replyTarget,
    selected?.project.id ?? activeProjectId,
    composerConversationId,
  );
  const allProjectAgentsQuery = useQuery({
    queryKey: queryKeys.agents.inbox,
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
    const byId = new Map<string, InboxReplyTarget>();
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
    const eligibleTargets = eligibleInboxTargets(
      byId.values(),
      composerConversationId,
    );
    const groups = new Map<string, Array<{ handle: string; target: InboxReplyTarget }>>();
    for (const target of eligibleTargets) {
      const handle = target.handle;
      const normalized = handle.toLocaleLowerCase();
      if (!handle || ["broadcast", "user", "everyone"].includes(normalized)) continue;
      const group = groups.get(normalized) ?? [];
      group.push({ handle, target });
      groups.set(normalized, group);
    }
    const targetByHandle = new Map<string, InboxReplyTarget>();
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
    () => busyInboxMentionHandles(
      composerTargets.targetByHandle.values(),
      agentHealthQuery.data?.agents ?? [],
    ),
    [agentHealthQuery.data?.agents, composerTargets.targetByHandle],
  );
  const inboxAgentTitle = (agentId: string | undefined) =>
    projectAgentsQuery.data?.find(agent => agent.id === agentId)?.title ??
    [...composerTargets.targetByHandle.values()]
      .find(agent => agent.id === agentId)?.title ??
    "Agent";
  const invalidateOperation = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll });
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
    agentTitle: inboxAgentTitle,
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
  const timeline = useMemo<InboxTimelineEntry[]>(() => {
    const entries: InboxTimelineEntry[] = [
      ...items.map((item) => ({
        kind: "message" as const,
        id: `message:${item.communicationEventId}`,
        at: item.createdAt,
        item,
      })),
      ...decisionEvents.flatMap((item): InboxTimelineEntry[] => {
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
    writeChatState(INBOX_REPLY_TARGET_KEY, "");
  }, []);
  useEffect(() => {
    if (!selected) return;
    const identity = inboxSourceIdentity(
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
      INBOX_SOURCE_KEY,
      composerSource ? JSON.stringify(composerSource) : "",
    );
  }, [composerSource]);
  const engines = enginesQuery.data ?? [];
  const project = projectsQuery.data?.find(
    item => item.id === selectedProjectId,
  );
  const runtimeSelectionReady = inboxRuntimeSelectionReady(
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
  };
  const send = useMutation({
    mutationFn: async ({
      body,
      files,
      draftAttachmentIds,
      draftOwnerId,
      mentionedAgents,
      newAgentRequested,
      onAgentCreated,
      retryPreparedAttempt,
      capturedSubmission,
      capturedProjectId,
      submissionEpoch,
      submissionSourceKey,
      submissionTargetId,
      pendingSubmission,
      persistPendingSubmission,
      activeRunDelivery,
    }: {
      body: string;
      files: File[];
      draftAttachmentIds: string[];
      draftOwnerId?: string;
      mentionedAgents: AgentMentionBindingDto[];
      newAgentRequested: boolean;
      onAgentCreated?(agent: AgentDto): void;
      retryPreparedAttempt: boolean;
      capturedSubmission: boolean;
      capturedProjectId?: string;
      activeRunDelivery: "steer" | "queue";
      submissionEpoch: number;
      submissionSourceKey?: string;
      submissionTargetId?: string;
      pendingSubmission?: import("@ponderosa/core").DraftPendingSubmissionDto;
      persistPendingSubmission?: (
        value: import("@ponderosa/core").DraftPendingSubmissionDto,
        retainOnFailure?: boolean,
      ) => Promise<void>;
    }) => {
      if (!pendingSubmission?.request && (!replyTargetRef.current || !submissionTargetId || replyTargetRef.current.id !== submissionTargetId)) {
        throw new Error("Choose a message to reply to first.");
      }
      const durableId = pendingSubmission?.idempotencyKey;
      const previous = durableId ? sendAttempts.current.get(durableId) : sendAttempt.current;
      let attempt = preparedIdempotentAttemptForRetry(
        previous,
        retryPreparedAttempt,
      );
      if (!attempt) {
        const submissionProjectId = capturedProjectId ?? activeProjectId;
        if (!submissionProjectId) throw new Error("Select a message to reply to first");
        if (!body.trim() && files.length === 0)
          throw new Error("Message text or an attachment is required");
        const selectedConversationId = composerConversationId;
        const validAgents = new Map((projectAgentsQuery.data ?? []).map(agent => [agent.id, agent]));
        const liveRecipientIds = [...new Set(
          mentionedAgents.map(binding => binding.agentId),
        )].filter(agentId => validAgents.has(agentId));
        const currentRecipientIds = pendingSubmission?.request?.recipientAgentIds ??
          liveRecipientIds;
        const currentRecipientConversationIds = [...new Set(
          liveRecipientIds.flatMap(agentId => {
            const conversationId = validAgents.get(agentId)?.conversationId;
            return conversationId ? [conversationId] : [];
          }),
        )];
        if (currentRecipientConversationIds.length > 1) {
          throw new Error("One message can address Agents from only one Chat");
        }
        const currentConversationId = pendingSubmission?.request?.conversationId ??
          currentRecipientConversationIds[0] ?? selectedConversationId;
        const currentRuntime = pendingSubmission?.request?.runtime
          ? {
              activeRunDelivery:
                pendingSubmission.request.runtime.activeRunDelivery ??
                activeRunDelivery,
              ...(pendingSubmission.request.runtime.engine
                ? { engine: pendingSubmission.request.runtime.engine }
                : {}),
              model: pendingSubmission.request.runtime.model ?? "",
              effort: pendingSubmission.request.runtime.effort ?? "",
              speed: pendingSubmission.request.runtime.speed ?? "",
            }
          : {
              activeRunDelivery,
              ...inboxRuntimePayloadSnapshot({
                newAgentRequested,
                recipientCount: currentRecipientIds.length,
                selectedEngineId,
                defaultEngine: project?.defaultEngine,
                runtime: runtimeSelectionReady
                  ? selectedRuntime
                  : { model: "", effort: "", speed: "" },
              }),
            };
        if (currentRecipientIds.length === 0 && !newAgentRequested) {
          throw new Error("Select at least one Agent or add #new-agent");
        }
        if (
          newAgentRequested &&
          !pendingSubmission?.request &&
          (!currentConversationId ||
            !conversationsQuery.data?.some(candidate =>
              candidate.id === currentConversationId))
        ) {
          throw new Error("No active Chat is available for the new Agent");
        }
        const fingerprint = JSON.stringify({
          activeProjectId,
          selectedConversationId,
          body: stableMessageActionText(body, mentionedAgents),
          files: fileSelectionFingerprint(files),
          draftAttachmentIds,
          draftOwnerId,
          mentionedAgentIds: [...new Set(
            mentionedAgents.map(binding => binding.agentId),
          )].sort(),
          newAgentRequested,
          runtime: currentRuntime,
        });
        attempt = retainIdempotentAttempt(
          previous,
          fingerprint,
          () => pendingSubmission?.idempotencyKey ?? createClientId(),
          (): InboxSubmissionPrepared => ({
            projectId: submissionProjectId,
            body,
            files,
            draftAttachmentIds: pendingDraftAttachmentIds(
              pendingSubmission,
              draftAttachmentIds,
            ),
            draftOwnerId,
            newAgentRequested,
            recipientIds: currentRecipientIds,
            recipientTitles: new Map([...validAgents.values()].map(agent => [
              agent.id,
              agent.title,
            ])),
            existingAgentTitles: [...validAgents.values()].map(agent => agent.title),
            conversationId: currentConversationId,
            runtime: currentRuntime,
          }),
        );
        if (pendingSubmission && !pendingSubmission.request && persistPendingSubmission) {
          pendingSubmission = withPendingRequest(pendingSubmission, {
            ...(currentConversationId ? { conversationId: currentConversationId } : {}),
            recipientAgentIds: currentRecipientIds,
            ...(mentionedAgents.length ? { mentionBindings: mentionedAgents } : {}),
            runtime: {
              ...currentRuntime,
            },
          });
          await persistPendingSubmission(pendingSubmission);
        }
      }
      if (previous && previous !== attempt && previous.prepared.uploads) {
        await cleanupRecipientUploads(previous.prepared.uploads);
      }
      if (durableId) sendAttempts.current.set(durableId, attempt);
      else sendAttempt.current = attempt;
      const requestId = attempt.idempotencyKey;
      const prepared = attempt.prepared;
      const submittedBody = prepared.body;
      const recipientIds = prepared.recipientIds;
      const creationConversationId = prepared.conversationId;
      const submittedRuntime = prepared.runtime;
      const createdNames = [...prepared.existingAgentTitles];
      const createdAgentIds: string[] = [];
      const createdTitles: string[] = [];
      let creationRecovering = false;
      let deliveredRecipientIds: string[] = [];
      const queuedRecipientTitles: string[] = [];
      const deliveryIds: string[] = [];
      let unavailableCount = 0;
      if (prepared.newAgentRequested) {
        const title = pendingSubmission?.agentTitle ?? prepared.title ??
          pickAgentName(createdNames);
        prepared.title = title;
        if (pendingSubmission && !pendingSubmission.agentTitle &&
            persistPendingSubmission) {
          pendingSubmission = await withPendingAgentTitle(
            pendingSubmission,
            title,
          );
          await persistPendingSubmission(pendingSubmission);
        }
        createdNames.push(title);
        createdTitles.push(title);
        const created = await api.createAgent(prepared.projectId, creationConversationId!, {
          title,
          engine: submittedRuntime.engine ?? "codex",
          ...(submittedRuntime.model ? { model: submittedRuntime.model } : {}),
          ...(submittedRuntime.effort ? { effort: submittedRuntime.effort } : {}),
          initialMessage: submittedBody.trim(),
          ...(prepared.draftAttachmentIds.length ? {
            draftAttachmentIds: prepared.draftAttachmentIds,
            draftOwnerId: prepared.draftOwnerId,
          } : {}),
          idempotencyKey: `${requestId}:new-agent:0`,
        });
        if (!("recovering" in created)) {
          onAgentCreated?.(created);
          publishCreatedAgent(queryClient, created);
        }
        const createdAgentId = "recovering" in created ? created.agentId : created.id;
        if (composerScopeRef.current === creationConversationId) setActiveOperation(createCreationOperationTracker(
          createdAgentId,
          creationConversationId,
        ));
        if ("recovering" in created) creationRecovering = true;
        else createdAgentIds.push(created.id);
        if (pendingSubmission && persistPendingSubmission) {
          pendingSubmission = withCommittedAgentCreation(pendingSubmission);
          await persistPendingSubmission(pendingSubmission, true);
        }
      }
      if (recipientIds.length > 0) {
        const conversationId = prepared.conversationId;
        if (!conversationId) {
          throw new Error("Every addressed Agent must belong to one active Chat");
        }
        const durableUploads = pendingRecipientUploads(pendingSubmission, "direct");
        const durableUploadsMatch = Boolean(durableUploads &&
          JSON.stringify(durableUploads.map(item => item.agentId)) ===
            JSON.stringify(recipientIds));
        const uploaded = prepared.uploads ??
          (durableUploadsMatch ? durableUploads! : await uploadFilesForRecipients(
          recipientIds,
          prepared.files,
          (agentId, file) => api.uploadAttachment(agentId, file),
          (agentId, attachment) => api.deleteAttachment(agentId, attachment.id),
          recipientUnavailable,
          cleanupPendingReporter(),
        ));
        prepared.uploads = uploaded;
        if (pendingSubmission && persistPendingSubmission) {
          pendingSubmission = withPendingRecipientUploads(
            pendingSubmission,
            "direct",
            uploaded,
          );
          try {
            await persistRecipientUploadAuthority({
              pending: pendingSubmission,
              recipients: uploaded,
              persist: persistPendingSubmission,
              cleanup: (agentId, item) => api.deleteAttachment(agentId, item.id),
              definitiveFailure: capturedSubmission ? () => false : definitiveFailure,
              cleanupUnavailable: cleanupSettled,
              onPendingChange: cleanupPendingReporter(),
            });
          } catch (error) {
            if (definitiveFailure(error)) {
              prepared.uploads = undefined;
            }
            throw error;
          }
        }
        const uploadedByAgentId = new Map(uploaded.map(item => [item.agentId, item]));
        const activeRunDelivery = submittedRuntime.activeRunDelivery ?? "steer";
        const directTracker = createDeliveryOperationTracker(
          activeRunDelivery,
          recipientIds,
          healthByAgentId,
          Date.now(),
          conversationId,
        );
        let response;
        try {
          response = await api.sendMultiAgentDirectMessage(conversationId, {
            text: submittedBody.trim(),
            recipients: recipientIds.map((agentId) => ({
              agentId,
              attachmentIds: (uploadedByAgentId.get(agentId)?.attachments ?? [])
                .map(attachment => attachment.id),
            })),
            idempotencyKey: `${requestId}:${conversationId}`,
            activeRunDelivery,
            ...(submittedRuntime.engine ? { engine: submittedRuntime.engine } : {}),
            ...(submittedRuntime.model ? { model: submittedRuntime.model } : {}),
            ...(submittedRuntime.effort ? { effort: submittedRuntime.effort } : {}),
            ...(submittedRuntime.speed ? { speed: submittedRuntime.speed } : {}),
          });
          if (directTracker && composerScopeRef.current === conversationId) {
            setActiveOperation(acceptDirectOperation(directTracker, response));
          }
          deliveryIds.push(...response.recipients.flatMap(recipient => recipient.deliveryId ? [recipient.deliveryId] : []));
          void queryClient.invalidateQueries({queryKey: queryKeys.queuedMessages.conversation(conversationId)});
          if (composerScopeRef.current === conversationId) queuedMessages.recordDelivery(
            response,
            activeRunDelivery,
            agentId => prepared.recipientTitles.get(agentId) ?? "Agent",
          );
          if (activeRunDelivery === "queue") {
            queuedRecipientTitles.push(...response.recipients.flatMap(recipient =>
              recipient.queued
                ? [prepared.recipientTitles.get(recipient.agentId) ?? "Agent"]
                : []
            ));
          }
        } catch (error) {
          if (!capturedSubmission && createdTitles.length === 0 &&
              await cleanupRecipientUploadsForDefinitiveFailure({
                error,
                recipients: uploaded,
                definitiveFailure: capturedSubmission ? () => false : definitiveFailure,
                cleanup: (agentId, item) => api.deleteAttachment(agentId, item.id),
                cleanupUnavailable: cleanupSettled,
                onPendingChange: cleanupPendingReporter(),
              })) {
            prepared.uploads = undefined;
            throw error;
          }
          const cleanupUploads = error instanceof ApiRequestError
            ? compoundCreationUnavailableUploads(
                createdTitles.length > 0,
                error.status,
                error.message,
                uploaded,
              )
            : undefined;
          if (!cleanupUploads) {
            throw error;
          }
          unavailableCount = recipientIds.length;
          await retryRecipientUploadCleanup(
            cleanupUploads,
            async (agentId, attachment) => {
              try {
                await api.deleteAttachment(agentId, attachment.id);
              } catch (cleanupError) {
                if (!cleanupSettled(cleanupError)) throw cleanupError;
              }
            },
            cleanupPendingReporter(),
          );
          if (durableId) sendAttempts.current.delete(durableId);
          else if (sendAttempt.current === attempt) sendAttempt.current = undefined;
          return {
            recipientIds: createdAgentIds,
            recipientTitles: createdTitles,
            queuedRecipientTitles,
            deliveryIds,
            unavailableCount,
            creationRecovering,
            submissionEpoch,
            submissionSourceKey,
            submissionTargetId,
          };
        }
        deliveredRecipientIds = response.recipients.map(recipient => recipient.agentId);
        const unavailableRecipientIds = (response.unavailableRecipients ?? [])
          .map(recipient => recipient.agentId);
        unavailableCount = unavailableRecipientIds.length;
        const unavailableUploads = recipientUploadsForAgentIds(
          uploaded,
          unavailableRecipientIds,
        );
        prepared.uploads = recipientUploadsForAgentIds(
          uploaded,
          deliveredRecipientIds,
        );
        void retryRecipientUploadCleanup(
          unavailableUploads,
          async (agentId, attachment) => {
            try {
              await api.deleteAttachment(agentId, attachment.id);
            } catch (error) {
              if (!cleanupSettled(error)) throw error;
            }
          },
          cleanupPendingReporter(),
        );
      }
      if (durableId) sendAttempts.current.delete(durableId);
      else if (sendAttempt.current === attempt) sendAttempt.current = undefined;
      return {
        recipientIds: [...deliveredRecipientIds, ...createdAgentIds],
        recipientTitles: [
          ...deliveredRecipientIds.map(id => prepared.recipientTitles.get(id) ?? "Agent"),
          ...createdTitles,
        ],
        queuedRecipientTitles,
        deliveryIds,
        unavailableCount,
        creationRecovering,
        submissionEpoch,
        submissionSourceKey,
        submissionTargetId,
      };
    },
    onSuccess: async result => {
      const sameTarget = replyTargetRef.current?.id === result.submissionTargetId &&
        submissionIntentRef.current.sourceKey === result.submissionSourceKey;
      if (sameTarget) setCommandResult(undefined);
      const confirmation = sameTarget ? inboxDeliveryConfirmation(result) : undefined;
      if (confirmation) {
        directSendConfirmationSequence.current += 1;
        setDirectSendConfirmation({
          id: directSendConfirmationSequence.current,
          text: confirmation,
        });
      } else if (sameTarget) {
        setDirectSendConfirmation(undefined);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll });
      for (const agentId of result.recipientIds) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detailPrefix(agentId),
        });
      }
    },
  });
  const previousSubmissionIntentEpoch = useRef(submissionIntent.epoch);
  useEffect(() => {
    if (previousSubmissionIntentEpoch.current === submissionIntent.epoch) return;
    previousSubmissionIntentEpoch.current = submissionIntent.epoch;
    const abandoned = abandonIdempotentAttempt(sendAttempt.current);
    sendAttempt.current = abandoned.current;
    abandonedSendAttempts.current.push(...abandoned.abandoned);
  }, [submissionIntent.epoch]);
  useEffect(() => {
    if (send.isPending || abandonedSendAttempts.current.length === 0) return;
    const abandoned = abandonedSendAttempts.current.splice(0);
    void Promise.all(abandoned.flatMap(attempt =>
      attempt.prepared.uploads
        ? [cleanupRecipientUploads(attempt.prepared.uploads)]
        : [],
    ));
  }, [send.isPending, submissionIntent.epoch]);
  const invalidatePreparedSubmissionIntent = useCallback(() => {
    if (!sendAttempt.current) return;
    dispatchSubmissionIntent({ kind: "draft-mutated" });
  }, []);
  const selectItem = (item: InboxItemDto, clearRecipient = false) => {
    const sourceIdentity = inboxSourceIdentity(
      item.project.id,
      item.source,
      projectAgentsQuery.data ?? [],
    );
    dispatchSubmissionIntent({
      kind: "source-selected",
      sourceKey: inboxSourceIntentKey(
        item.project.id,
        item.source,
        projectAgentsQuery.data ?? [],
      ),
    });
    pendingMentionTargetId.current = undefined;
    setSelectedId(item.communicationEventId);
    setComposerSource(sourceIdentity);
    if (clearRecipient) {
      dispatchSubmissionIntent({ kind: "recipient-cleared" });
      if (replyTarget) {
        setMentionRemoveRequest({
          id: `source:${replyTarget.id}:${Date.now()}`,
          text: `#${replyTarget.handle}`,
        });
      }
      setReplyTarget(undefined);
    }
    setCommandResult(undefined);
    setDirectSendConfirmation(undefined);
    send.reset();
  };
  const clearReplyTarget = (advanceIntent = true) => {
    if (advanceIntent) {
      dispatchSubmissionIntent({ kind: "recipient-cleared" });
    }
    pendingMentionTargetId.current = undefined;
    if (replyTarget) {
      setMentionRemoveRequest({
        id: `clear:${replyTarget.id}:${Date.now()}`,
        text: `#${replyTarget.handle}`,
      });
    }
    setReplyTarget(undefined);
  };
  const syncReplyTargetFromMentions = useCallback((handles: string[]) => {
    mentionedHandlesRef.current = handles;
    // Projection/restored mentions must never select a reply target.
    // Explicit authored input is handled separately below.
  }, []);
  const selectAuthoredMentionTarget = useCallback((handles: string[]) => {
    const targets = handles.flatMap(handle => {
      const target = composerTargets.targetByHandle.get(handle.toLocaleLowerCase());
      return target?.conversationId ? [target] : [];
    });
    if (!targets.length || new Set(targets.map(target => target.conversationId)).size !== 1) return;
    const target = targets[0]!;
    if (replyTarget?.id === target.id) return;
    dispatchSubmissionIntent({ kind: "recipient-selected" });
    setSelectedId(undefined);
    setComposerSource({ projectId: target.projectId, conversationId: target.conversationId! });
    setReplyTarget(target);
  }, [composerTargets.targetByHandle, replyTarget?.id]);
  const mentionItem = (item: InboxItemDto) => {
    selectItem(item);
    if (!item.directMessageAgent) return;
    dispatchSubmissionIntent({ kind: "recipient-selected" });
    const handle = item.directMessageAgent.handle;
    pendingMentionTargetId.current = mentionedHandlesRef.current.some(candidate =>
      candidate.toLocaleLowerCase() === handle.toLocaleLowerCase())
      ? undefined
      : item.directMessageAgent.id;
    setReplyTarget({
      ...item.directMessageAgent,
      projectId: item.project.id,
      conversationId:
        projectAgentsQuery.data?.find(candidate =>
          candidate.id === item.directMessageAgent?.id)?.conversationId ??
        inboxSourceConversationId(
          item.source,
          projectAgentsQuery.data ?? [],
        ),
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
      const page = await loadRetainedData(
        () => api.getInbox(50, history.cursor),
        setOlderError,
        "Older messages could not be loaded.",
      );
      if (!page) return;
      setOlder(current => ({
        items: mergeInboxItems(
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
  const resetOrChangeEngine = (next: string) => {
    const nextEngine = engines.find(item => item.id === next);
    if (!nextEngine || !selectedAgentId || !selectedAgent.data) return;
    setSubmissionRuntimeIntent(value => value + 1);
    const resolved = resolveRuntimeSelection(
      nextEngine,
      workspacePreferences.data,
      project,
    );
    if (next === selectedEngineId && resolved.model === model && resolved.effort === effort && (resolved.speed ?? "") === (speed ?? "")) return;
    setRuntimeEngine(next);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed ?? "");
    updateRuntimeEngine.mutate(
      {
        agentId: selectedAgentId,
        activeEngine: next as EngineDto["id"],
        model: resolved.model || null,
        effort: resolved.effort || null,
        speed: resolved.speed || null,
      },
    );
  };
  const runtimeControls =
    replyTarget && runtimeSelectionReady && selectedAgent.data && selectedEngine ? (
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
        scopeLabel={`${selectedAgent.data.agent.title} Next Run`}
        selectionKey={selectedAgentId ?? ""}
        onEngineChange={resetOrChangeEngine}
        onReset={() => { if (selectedEngineId) resetOrChangeEngine(selectedEngineId); }}
        onModelChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const resolved = selectedRuntime.selectModel(next);
          if (selectedAgentId && selectedEngineId) updateRuntimeEngine.mutate({
            agentId: selectedAgentId,
            activeEngine: selectedEngineId,
            model: resolved.model || null,
            effort: resolved.effort || null,
            speed: resolved.speed || null,
          });
        }}
        onEffortChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const resolved = selectedRuntime.selectEffort(next);
          if (selectedAgentId && selectedEngineId) updateRuntimeEngine.mutate({
            agentId: selectedAgentId,
            activeEngine: selectedEngineId,
            model: resolved.model || null,
            effort: resolved.effort || null,
            speed: resolved.speed || null,
          });
        }}
        onSpeedChange={next => {
          setSubmissionRuntimeIntent(value => value + 1);
          const resolved = selectedRuntime.selectSpeed(next);
          if (selectedAgentId && selectedEngineId) updateRuntimeEngine.mutate({
            agentId: selectedAgentId,
            activeEngine: selectedEngineId,
            model: resolved.model || null,
            effort: resolved.effort || null,
            speed: resolved.speed || null,
          });
        }}
      />
    ) : null;
  return (
    <OutgoingMessageProvider scope={composerConversationId ?? "all"} profile={workspacePreferences.data?.profile}
      onOpenAgent={(agentId, projectId) => onNavigate({ kind: "agent", projectId, agentId })}><Box
      sx={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        bgcolor: "background.default",
      }}
    >
      <CompactWorkspaceHeader
        icon={<ChatBubbleOutlineIcon fontSize="small" />}
        title="Inbox"
      />
      <ChatSurface
        showOutgoingMessage
        canonicalCommunicationIds={items.map(item => item.communicationEventId)}
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
            {olderError ? (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" size="small" onClick={() => void loadOlder()}>
                    Retry
                  </Button>
                }
              >
                {olderError}
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
            if (entry.kind === "decision") {
              const notification = notifications.find((item) =>
                item.decision?.id === entry.item.decision.id && (item.status ?? "open") === "open");
              const card = <Box component="article" key={entry.id} id={entry.id} sx={{ width: "min(1120px, 100%)", mx: "auto" }}>
              <DecisionCard
                decision={entry.item.decision}
                title={entry.item.decision.question}
                context={entry.item.decision.context}
              />
              <Typography variant="caption" color="text.secondary">{entry.item.source.title}</Typography>
              </Box>;
              return notification ? <Box key={entry.id} data-notification-id={notification.id}>{card}</Box> : card;
            }
            if (entry.kind === "decision-response") {
              return <DecisionResponseMessage key={entry.id} event={entry.item}
                operatorProfile={workspacePreferences.data?.profile}
                onOpenAgent={agentId => onNavigate({ kind: "agent", projectId: entry.item.decision.projectId, agentId })} />;
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
                  onSelect: () => selectItem(item, true),
                  selectLabel: inboxSourceAccessibleName(item),
                  body: (
                    <ChatMessageBody
                      collaborationRecipients={item.communicationIntent === "collaboration" ? item.collaborationRecipients ?? [] : undefined}
                      agentMentions={item.agentMentions}
                      text={communicationVisibleText({
                        text: item.text,
                        intent: item.communicationIntent,
                        fromAgent: !fromUser,
                        agentMentions: item.agentMentions,
                      })}
                      collapseLongMessage
                      compactMarkdown
                      projectId={item.project.id}
                      fileScope={fileOwnerForMessage({ authorAgentId: item.author.agentId, conversationId: item.source.conversationId }, item.source.kind === "agent" ? item.source.agentId : undefined)}
                      operatorHandle={workspacePreferences.data?.profile.handle}
                      agentMentionForHandle={handle => {
                        const binding = authoredAgentMentionForHandle(
                          handle,
                          item.agentMentions,
                        );
                        if (binding) return binding;
                        return item.directMessageAgent &&
                          item.directMessageAgent.handle.toLocaleLowerCase() === handle.toLocaleLowerCase()
                          ? {
                              agentId: item.directMessageAgent.id,
                              label: item.directMessageAgent.handle,
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
                          onNavigate(inboxSourceRoute(item));
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
                  belowBody: fromUser ? <LiveAgentProgress receipts={item.deliveryReceipts} onOpenAgent={agentId =>
                    onNavigate({ kind: "agent", projectId: item.project.id, agentId })} /> : undefined,
                  status:
                    fromUser && item.deliveryReceipts?.length ? (
                      <MessageDeliveryStatus
                        projectId={item.project.id}
                        receipts={item.deliveryReceipts}
                        recipientName={agentId =>
                          item.directMessageAgents?.find(agent => agent.id === agentId)?.title ??
                          (item.directMessageAgent?.id === agentId
                            ? item.directMessageAgent.title
                            : inboxAgentTitle(agentId))
                        }
                        compact
                      />
                    ) : undefined,
                  actions: (
                    <>
                      <Tooltip title="Copy">
                        <IconButton
                          size="small"
                          aria-label="Copy message"
                          onClick={event => {
                            event.stopPropagation();
                            void copyText(item.communicationIntent === "collaboration" ? item.text : communicationVisibleText({
                              text: item.text,
                              intent: item.communicationIntent,
                              fromAgent: !fromUser,
                              agentMentions: item.agentMentions,
                            })).then(() => notify({ key: "copy-message", message: "Copied" }), () => notify({ key: "copy-message", message: "Message could not be copied. Check your browser clipboard permissions and try again.", severity: "error" }));
                          }}
                        >
                          <ContentCopyOutlinedIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                      <MessageRequestAction projectId={item.project.id} conversationId={item.source.conversationId}
                        recipients={item.collaborationRecipients} receipts={item.deliveryReceipts} requests={item.coordinationRequests} agentTitle={inboxAgentTitle} />
                      {item.author.kind === "agent" ? (
                        <ReadAloudControls
                          text={resolveMessageMentionText(
                            communicationVisibleText({
                              text: item.text,
                              intent: item.communicationIntent,
                              fromAgent: true,
                              agentMentions: item.agentMentions,
                            }),
                            item.agentMentions,
                          )}
                        />
                      ) : null}
                      {!fromUser && item.directMessageAgent ? (
                        <Tooltip
                          title={`Reply to ${item.directMessageAgent.title}`}
                        >
                          <IconButton
                            size="small"
                            aria-label={`Reply to ${item.directMessageAgent.title}`}
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
          if (!event.defaultPrevented && event.key === "Escape" && activeReplyTarget) {
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
        {commandResult ? (
          <Alert severity="info" onClose={() => setCommandResult(undefined)} sx={{ mx: 1.5, mt: 1 }}>
            {commandResult}
          </Alert>
        ) : null}
        {updateRuntimeEngine.isError ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => updateRuntimeEngine.reset()}>
                Dismiss
              </Button>
            }
            sx={{ mx: 1.5, mt: 1 }}
          >
            Provider selection was not saved. The last saved selection was restored; choose a provider to retry.
          </Alert>
        ) : null}
        {queuedMessages.notice ? (
          <Alert severity="info" sx={{ mx: 1.5, mt: 1 }}>
            {queuedMessages.notice}
          </Alert>
        ) : null}
        {pendingUploadCleanups ? (
          <Alert severity="info" sx={{ mx: 1.5, mt: 1 }}>
            Message sent. Temporary uploads for skipped recipients are still
            being cleaned up automatically.
          </Alert>
        ) : null}
        {cancelOperationError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            Cancellation failed. {cancelOperationError.message}
          </Alert>
        ) : null}
        {queuedMessages.failure ? (
          <Alert
            severity="error"
            sx={{ mx: 1.5, mt: 1 }}
            action={<Button
              color="inherit"
              size="small"
              onClick={queuedMessages.failure.retry}
            >
              Retry
            </Button>}
          >
            Queued messages could not be updated. {queuedMessages.failure.error.message}
          </Alert>
        ) : null}
        <QueuedMessageTray
          messages={queuedMessages.query.data ?? []}
          scope={composerConversationId}
          attachmentNamesForMessage={queued => items.find(item => item.messageId === queued.messageId || item.communicationEventId === queued.messageId)?.attachments?.map(attachment => attachment.name)}
          agentNameForId={agentId => inboxAgentTitle(agentId)}
          busy={
            queuedMessages.cancel.isPending ||
            queuedMessages.edit.isPending ||
            queuedMessages.steer.isPending
          }
          onSteer={message => queuedMessages.steer.mutateAsync({
            deliveryId: message.deliveryId,
            targetAgentId: message.targetAgentId,
          })}
          onEdit={(message, text) => queuedMessages.edit.mutateAsync({
            deliveryId: message.deliveryId,
            targetAgentId: message.targetAgentId,
            text,
          })}
          onDelete={message => queuedMessages.cancel.mutateAsync(
            message.deliveryId,
          )}
        />
        <Composer
          destinationMode="target-required"
          defaultDestination={activeReplyTarget ? {
            handle: activeReplyTarget.handle,
            binding: {
              projectId: activeReplyTarget.projectId,
              handle: activeReplyTarget.handle,
              agentId: activeReplyTarget.id,
              currentHandle: activeReplyTarget.handle,
              currentTitle: activeReplyTarget.title,
            },
            selectionKey: `agent:${activeReplyTarget.id}:${activeReplyTarget.title}`,
          } : undefined}
          requiredRecipient={activeReplyTarget ? {
            handle: activeReplyTarget.handle,
            title: activeReplyTarget.title,
            onClear: () => clearReplyTarget(false),
          } : undefined}
          recipientRequiredMessage={
            selected && !selected.directMessageAgent
              ? "This message does not identify an active Agent you can message."
              : "Mention an Agent or choose a message to reply to."
          }
          mentionHandles={composerTargets.handles}
          mentionBindings={composerTargets.mentionBindings}
          mentionSuggestionHandles={composerTargets.suggestionHandles}
          ambiguousMentionHandles={composerTargets.ambiguousHandles}
          onMentionedHandlesChange={syncReplyTargetFromMentions}
          onAuthoredMentionHandlesChange={selectAuthoredMentionTarget}
          preserveUntargetedDraft
          commands={activeReplyTarget ? selectedCommands : undefined}
          capabilities={
            selectedEngineCapabilities?.composerCapabilities ?? []
          }
          enableVoiceDictation
          voiceContext={activeReplyTarget && composerConversationId ? {
            projectId: activeReplyTarget.projectId,
            conversationId: composerConversationId,
            agents: projectAgentsQuery.data ?? [],
            selectedAgentId: activeReplyTarget.id,
            lockAgent: true,
          } : undefined}
          onCapabilitiesOpen={refreshSelectedCapabilities}
          submissionRuntimeKey={JSON.stringify([
            selectedEngineId ?? "",
            selectedModel ?? "",
            selectedRuntime.effort ?? "",
            selectedRuntime.speed ?? "",
          ])}
          submissionRuntimeIntentKey={String(submissionRuntimeIntent)}
          onCommand={activeReplyTarget ? invokeCommand : undefined}
          controls={runtimeControls}
          disabled={false}
          submissionDisabled={
            runtimeSaving ||
            Boolean(selectedAgentId && !runtimeSelectionReady)
          }
          running={operationRunning}
          allowSendWhileRunning
          busyMentionHandles={busyMentionHandles}
          agentResponding={Boolean(
            activeReplyTarget &&
            healthByAgentId.get(activeReplyTarget.id)?.runtimeActivity,
          )}
          allowUnmentionedSend={Boolean(activeReplyTarget)}
          attachmentsEnabled={Boolean(composerConversationId)}
          attachmentsUnavailableReason={
            composerConversationId
              ? undefined
              : "Select a source Chat before adding attachments."
          }
          placeholder={
            activeReplyTarget
              ? `Message ${activeReplyTarget.title} directly`
              : "Mention an Agent or choose a message to reply to"
          }
          removeTextRequest={mentionRemoveRequest}
          submissionIntentKey={String(submissionIntent.epoch)}
          onSubmissionIntentChange={invalidatePreparedSubmissionIntent}
          draftStorageKey={composerConversationId
            ? chatStateKey(
                "draft",
                `conversation.${composerConversationId}.main`,
              )
            : "messages:composer"}
          conversationDraftId={composerConversationId}
          projectId={activeProjectId}
          onSend={(body, files, draftAttachmentIds = [], draftOwnerId, context) =>
            send.mutateAsync({
              activeRunDelivery: "steer",
              body,
              files,
              draftAttachmentIds,
              draftOwnerId,
              mentionedAgents: context?.mentionedAgents ?? [],
              newAgentRequested: context?.newAgentRequested ?? false,
              retryPreparedAttempt: context?.retryPreparedAttempt ?? false,
              capturedSubmission: context?.capturedSubmission ?? false,
              capturedProjectId: context?.capturedProjectId,
              submissionEpoch: submissionIntent.epoch,
              submissionSourceKey: submissionIntent.sourceKey,
              submissionTargetId: activeReplyTarget?.id,
              pendingSubmission: context?.pendingSubmission,
              persistPendingSubmission: context?.persistPendingSubmission,
              onAgentCreated: context?.onAgentCreated,
            })
          }
          onQueue={(body, files, draftAttachmentIds = [], draftOwnerId, context) =>
            send.mutateAsync({
              activeRunDelivery: "queue",
              body,
              files,
              draftAttachmentIds,
              draftOwnerId,
              mentionedAgents: context?.mentionedAgents ?? [],
              newAgentRequested: context?.newAgentRequested ?? false,
              retryPreparedAttempt: context?.retryPreparedAttempt ?? false,
              capturedSubmission: context?.capturedSubmission ?? false,
              capturedProjectId: context?.capturedProjectId,
              submissionEpoch: submissionIntent.epoch,
              submissionSourceKey: submissionIntent.sourceKey,
              submissionTargetId: activeReplyTarget?.id,
              pendingSubmission: context?.pendingSubmission,
              persistPendingSubmission: context?.persistPendingSubmission,
              onAgentCreated: context?.onAgentCreated,
            })
          }
          onCancel={stopOperation}
          cancelPending={cancelOperationPending}
        />
      </ChatComposerDock>
      <ActiveOperationStopDialog
        confirmation={stopConfirmation}
        pending={cancelOperationPending}
        error={cancelOperationError?.message}
        onCancel={() => {
          if (!cancelOperationPending) setStopConfirmation(undefined);
        }}
        onConfirm={targets => void cancelOperationTargets(targets)}
      />
    </Box></OutgoingMessageProvider>
  );
}
