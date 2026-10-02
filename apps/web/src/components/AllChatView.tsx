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
  AgentDetailDto,
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
  authoredAgentMentionForHandle,
  communicationVisibleText,
  resolveMessageMentionText,
  showBroadcastBadge,
} from "./chat/ChatMessages";
import { Composer } from "./chat/Composer";
import { copyText } from "../clipboard";
import { AttentionSurface } from "./AttentionSurface";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { LiveAgentProgress } from "./chat/LiveAgentProgress";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { TimedChatLiveBanner } from "./chat/ChatLiveBanner";
import { ChatSurface } from "./chat/ChatSurface";
import { OutgoingMessageProvider } from "./chat/OutgoingMessage";
import { publishCreatedAgent } from "../conversationAgentCache";
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
import {
  resolveRuntimeSelection,
  runtimeControlState,
} from "../conversationEngine";
import { useRuntimeControls } from "../hooks/useRuntimeControls";
import { AUTO_ALLOWED_DECISION_OPTION_ID } from "./ConversationView.helpers";
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
  allChatAttentionRoute,
  allChatComposerConversationId,
  allChatRuntimeInitializationKey,
  allChatRuntimeMutationOwnsSelection,
  allChatSubmissionSettlementStillCurrent,
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
  recordRuntimeCanonicalKey,
  runtimeCanonicalKey,
  shouldInitializeAllChatRuntime,
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
  const abandonedSendAttempts = useRef<
    IdempotentAttempt<AllChatSubmissionPrepared>[]
  >([]);
  const [runtimeEngine, setRuntimeEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState("");
  const [submissionRuntimeIntent, setSubmissionRuntimeIntent] = useState(0);
  const runtimeMutationGenerationByAgent = useRef(new Map<string, number>());
  const runtimeCanonicalKeyByAgent = useRef(new Map<string, string>());
  const initializedRuntime = useRef<string>();
  const dirtyRuntimeAgentId = useRef<string>();
  const [runtimeAgentId, setRuntimeAgentId] = useState<string>();
  const [notice, setNotice] = useState<string>();
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
  const items = useMemo(
    () => mergeAllChatItems(older?.items ?? [], query.data?.items ?? [])
      .filter(item => !availableProjectIds || availableProjectIds.has(item.project.id)),
    [availableProjectIds, older?.items, query.data?.items],
  );
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
      if (agent.archived || !activeProjectId) continue;
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
        if (agent.archived) continue;
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
        const choice = allChatDecisionChoice(item);
        return choice ? [{ kind: "decision-response", id: item.id, at: item.createdAt, item, choice }] : [];
      }),
    ];
    return entries.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  }, [decisionEvents, items]);
  const layoutKey = timeline.map((entry) => entry.id).join(":");
  const selectedAgentId = activeReplyTarget?.id;
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const selectedProjectId = activeProjectId;
  const selectedAgent = useQuery({
    queryKey: queryKeys.agents.detail(selectedAgentId),
    queryFn: () => api.getAgent(selectedAgentId!, AGENT_DETAIL_PAGE_SIZE),
    enabled: Boolean(selectedAgentId),
  });
  const currentRuntimeCanonical = useRef<{ agentId: string; key: string }>();
  if (selectedAgent.data?.agent) {
    currentRuntimeCanonical.current = {
      agentId: selectedAgent.data.agent.id,
      key: runtimeCanonicalKey({
        engine: selectedAgent.data.agent.activeEngine,
        model: selectedAgent.data.agent.model,
        effort: selectedAgent.data.agent.effort,
        speed: selectedAgent.data.agent.speed,
      }),
    };
  }
  const conversationsQuery = useConversations(selectedProjectId);
  useEffect(() => {
    setReplyTarget(current => {
      if (!current) return current;
      if (!projectAgentsQuery.data) return current;
      const agent = projectAgentsQuery.data?.find(candidate => candidate.id === current.id);
      if (!agent || agent.archived) return undefined;
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
      dirtyRuntimeAgentId.current = undefined;
      setRuntimeEngine("");
      setModel("");
      setEffort("");
      setSpeed("");
      setRuntimeAgentId(undefined);
      return;
    }
    if (dirtyRuntimeAgentId.current !== selectedAgentId) {
      dirtyRuntimeAgentId.current = undefined;
    }
    const agent = selectedAgent.data?.agent;
    if (!agent) return;
    const engine = engines.find(item => item.id === agent.activeEngine);
    const initializationKey = allChatRuntimeInitializationKey({
      selectedAgentId,
      agent,
      engine,
      project,
      enginesLoaded: enginesQuery.data !== undefined,
      preferencesLoaded: workspacePreferences.data !== undefined,
      preferencesRevision: workspacePreferences.data?.revision,
      projectsLoaded: projectsQuery.data !== undefined,
    });
    if (!shouldInitializeAllChatRuntime(
      initializationKey,
      initializedRuntime.current,
      dirtyRuntimeAgentId.current === selectedAgentId,
    )) return;
    const canonicalKey = runtimeCanonicalKey({
      engine: agent.activeEngine,
      model: agent.model,
      effort: agent.effort,
      speed: agent.speed,
    });
    recordRuntimeCanonicalKey(
      runtimeMutationGenerationByAgent.current,
      runtimeCanonicalKeyByAgent.current,
      agent.id,
      canonicalKey,
    );
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
      speed: agent.speed ?? readChatState(
        chatStateKey("runtime", `agent.${agent.id}.speed`),
      ),
    });
    initializedRuntime.current = initializationKey;
    setRuntimeAgentId(agent.id);
    setRuntimeEngine(agent.activeEngine);
    setModel(resolved.model);
    setEffort(resolved.effort);
    setSpeed(resolved.speed);
  }, [
    engines,
    enginesQuery.data,
    project,
    projectsQuery.data,
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
      queryClient.setQueryData<AgentDetailDto>(
        queryKeys.agents.detail(updated.id),
        current => current ? { ...current, agent: updated } : current,
      );
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
        `/${command.name} completed for ${activeReplyTarget?.title ?? "Agent"}.`,
    );
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
      if (!replyTargetRef.current || !submissionTargetId || replyTargetRef.current.id !== submissionTargetId) {
        throw new Error("Choose a message to reply to first.");
      }
      if (pendingSubmission?.request?.recipientAgentIds && !pendingSubmission.request.recipientAgentIds.includes(submissionTargetId)) {
        throw new Error("Choose the original recipient’s message to retry this reply.");
      }
      const previous = sendAttempt.current;
      let attempt = preparedIdempotentAttemptForRetry(
        previous,
        retryPreparedAttempt,
      );
      if (!attempt) {
        if (!activeProjectId) throw new Error("Select a message to reply to first");
        if (!body.trim() && files.length === 0)
          throw new Error("Message text or an attachment is required");
        const selectedConversationId = composerConversationId;
        const validAgents = new Map((projectAgentsQuery.data ?? []).filter(agent =>
          !agent.archived).map(agent => [agent.id, agent]));
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
              ...allChatRuntimePayloadSnapshot({
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
          (): AllChatSubmissionPrepared => ({
            projectId: activeProjectId,
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
      sendAttempt.current = attempt;
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
        setActiveOperation(createCreationOperationTracker(
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
              definitiveFailure,
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
          if (directTracker) {
            setActiveOperation(acceptDirectOperation(directTracker, response));
          }
          queuedMessages.recordDelivery(
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
          if (createdTitles.length === 0 &&
              await cleanupRecipientUploadsForDefinitiveFailure({
                error,
                recipients: uploaded,
                definitiveFailure,
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
          if (sendAttempt.current === attempt) sendAttempt.current = undefined;
          return {
            recipientIds: createdAgentIds,
            recipientTitles: createdTitles,
            queuedRecipientTitles,
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
      if (sendAttempt.current === attempt) sendAttempt.current = undefined;
      return {
        recipientIds: [...deliveredRecipientIds, ...createdAgentIds],
        recipientTitles: [
          ...deliveredRecipientIds.map(id => prepared.recipientTitles.get(id) ?? "Agent"),
          ...createdTitles,
        ],
        queuedRecipientTitles,
        unavailableCount,
        creationRecovering,
        submissionEpoch,
        submissionSourceKey,
        submissionTargetId,
      };
    },
    onSuccess: async result => {
      setNotice(undefined);
      if (allChatSubmissionSettlementStillCurrent({
        capturedEpoch: result.submissionEpoch,
        currentEpoch: submissionIntentRef.current.epoch,
        capturedSourceKey: result.submissionSourceKey,
        currentSourceKey: submissionIntentRef.current.sourceKey,
        capturedTargetId: result.submissionTargetId,
        currentTargetId: replyTargetRef.current?.id,
      })) {
        setReplyTarget(undefined);
      }
      const confirmation = allChatDeliveryConfirmation(result);
      if (confirmation) {
        directSendConfirmationSequence.current += 1;
        setDirectSendConfirmation({
          id: directSendConfirmationSequence.current,
          text: confirmation,
        });
      } else {
        setDirectSendConfirmation(undefined);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
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
  const selectItem = (item: AllChatItemDto, clearRecipient = false) => {
    const sourceIdentity = allChatSourceIdentity(
      item.project.id,
      item.source,
      projectAgentsQuery.data ?? [],
    );
    dispatchSubmissionIntent({
      kind: "source-selected",
      sourceKey: allChatSourceIntentKey(
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
    setNotice(undefined);
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
    // Mentions (including restored drafts) must never select a reply target.
  }, []);
  const mentionItem = (item: AllChatItemDto) => {
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
        allChatSourceConversationId(
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
        () => api.getAllChat(50, history.cursor),
        setOlderError,
        "Older messages could not be loaded.",
      );
      if (!page) return;
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
        disabled={updateRuntimeEngine.isPending}
        onEngineChange={next => {
          const nextEngine = engines.find(item => item.id === next);
          if (!nextEngine || !selectedAgentId) return;
          dirtyRuntimeAgentId.current = selectedAgentId;
          setSubmissionRuntimeIntent(value => value + 1);
          const mutationGeneration =
            (runtimeMutationGenerationByAgent.current.get(selectedAgentId) ?? 0) + 1;
          runtimeMutationGenerationByAgent.current.set(
            selectedAgentId,
            mutationGeneration,
          );
          const capturedCanonicalKey = runtimeCanonicalKeyByAgent.current.get(
            selectedAgentId,
          ) ?? runtimeCanonicalKey({
            engine: selectedAgent.data.agent.activeEngine,
            model: selectedAgent.data.agent.model,
            effort: selectedAgent.data.agent.effort,
            speed: selectedAgent.data.agent.speed,
          });
          const speedKey = chatStateKey(
            "runtime",
            `agent.${selectedAgentId}.speed`,
          );
          const previous = {
            engine: selectedEngineId ?? "",
            model,
            effort,
            speed,
            persistedSpeed: readChatState(speedKey),
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
            speedKey,
            resolved.speed ?? "",
          );
          updateRuntimeEngine.mutate(
            {
              agentId: selectedAgentId,
              activeEngine: next as EngineDto["id"],
              model: resolved.model || null,
              effort: resolved.effort || null,
              speed: resolved.speed || null,
            },
            {
              onError: () => {
                const currentGeneration =
                  runtimeMutationGenerationByAgent.current.get(selectedAgentId);
                if (!allChatRuntimeMutationOwnsSelection({
                  capturedAgentId: selectedAgentId,
                  currentAgentId: selectedAgentIdRef.current,
                  capturedGeneration: mutationGeneration,
                  currentGeneration,
                  capturedCanonicalKey,
                  currentCanonicalKey:
                    currentRuntimeCanonical.current?.agentId === selectedAgentId
                      ? currentRuntimeCanonical.current.key
                      : undefined,
                })) return;
                if (readChatState(speedKey) === (resolved.speed || undefined)) {
                  writeChatState(speedKey, previous.persistedSpeed ?? "");
                }
                setRuntimeEngine(previous.engine);
                setModel(previous.model);
                setEffort(previous.effort);
                setSpeed(previous.speed);
              },
            },
          );
        }}
        onModelChange={next => {
          if (selectedAgentId) dirtyRuntimeAgentId.current = selectedAgentId;
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
          if (selectedAgentId) dirtyRuntimeAgentId.current = selectedAgentId;
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
          if (selectedAgentId) dirtyRuntimeAgentId.current = selectedAgentId;
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
        gridTemplateRows: "auto auto minmax(0, 1fr) auto",
        bgcolor: "background.default",
      }}
    >
      <CompactWorkspaceHeader
        icon={<ChatBubbleOutlineIcon fontSize="small" />}
        title="Messages Across Ponderosa"
      />
      <Box sx={{ minWidth: 0 }}>
          <AttentionSurface
            notifications={notifications.filter((item) => item.kind !== "decision")}
          onOpen={item => {
            const route = allChatAttentionRoute(item);
            if (route) onNavigate(route);
          }}
        />
      </Box>

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
                  selectLabel: allChatSourceAccessibleName(item),
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
                      preserveWhitespace={fromUser}
                      projectId={item.project.id}
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
                            : allChatAgentTitle(agentId))
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
                            void copyText(communicationVisibleText({
                              text: item.text,
                              intent: item.communicationIntent,
                              fromAgent: !fromUser,
                              agentMentions: item.agentMentions,
                            }));
                          }}
                        >
                          <ContentCopyOutlinedIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
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
        {notice ? (
          <Alert severity="success" sx={{ mx: 1.5, mt: 1 }}>
            {notice}
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
        {send.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            {send.error instanceof Error
              ? send.error.message
              : "Direct message could not be sent."}
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
          agentNameForId={agentId => allChatAgentTitle(agentId)}
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
              : "Choose a message’s Reply action first."
          }
          mentionHandles={composerTargets.handles}
          mentionBindings={composerTargets.mentionBindings}
          mentionSuggestionHandles={composerTargets.suggestionHandles}
          ambiguousMentionHandles={composerTargets.ambiguousHandles}
          onMentionedHandlesChange={syncReplyTargetFromMentions}
          commands={activeReplyTarget ? selectedCommands : undefined}
          capabilities={
            selectedEngineCapabilities?.composerCapabilities ?? []
          }
          enableVoiceDictation
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
          disabled={
            !activeReplyTarget ||
            send.isPending ||
            updateRuntimeEngine.isPending ||
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
              : "Choose a message to reply to"
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
