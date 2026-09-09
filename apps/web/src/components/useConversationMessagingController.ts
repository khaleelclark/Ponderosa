import type {
  AgentDto,
  AgentHealthDto,
  AgentMentionBindingDto,
  AssetDto,
  ConversationDto,
  EngineDto,
  ConversationMessageDto,
  MultiAgentDirectMessageResponse,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { hasBroadcastMention, hasEveryoneMention } from "../mentions";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { createClientId } from "../clientId";
import {
  effortSelectionIsCompatible,
  modelSelectionIsCompatible,
  selectedRunConfig,
} from "../conversationEngine";
import {
  discardRecipientUploads,
  cleanupRecipientUploadsForDefinitiveFailure,
  fileSelectionFingerprint,
  recipientUploadsForAgentIds,
  recipientActionSnapshot,
  recipientUploadCleanupSettled,
  recipientUploadCleanupReporter,
  pendingRecipientUploads,
  pendingDraftAttachmentIds,
  recipientUploadCacheKey,
  retryRecipientUploadCleanup,
  managerBroadcastText,
  persistRecipientUploadAuthority,
  stableMessageActionText,
  withPendingRecipientUploads,
  withPendingRequest,
  type RecipientUploads,
  uploadFilesForRecipients,
} from "../conversationRouting";
import { pickAgentName } from "../parkNames";
import { queryKeys } from "../queryKeys";
import {
  acceptBroadcastOperation,
  acceptDirectOperation,
  activeOperationExecutionTargets,
  activeOperationIsRunning,
  createActiveOperationTracker,
  createDeliveryOperationTracker,
  reconcileActiveOperationTracker,
  type ActiveOperationReceipt,
  type ActiveOperationTracker,
} from "./activeOperationTracker";
import {
  compoundCreationUnavailableUploads,
  definitiveSubmissionStatus,
  preparedIdempotentAttemptForRetry,
  retainIdempotentAttempt,
  withCommittedAgentCreation,
  withPendingAgentTitle,
  type IdempotentAttempt,
} from "./idempotentAttempt";
import {
  runQueuedMessageCommand,
  type QueuedMessageCommandAttemptRegistry,
} from "./queuedMessageCommandAttempts";

interface ConversationSubmissionPrepared {
  text: string;
  files: File[];
  draftAttachmentIds: string[];
  draftOwnerId?: string;
  newAgentRequested: boolean;
  activeRunDelivery: "steer" | "queue";
  engine: string;
  runConfig: ReturnType<typeof selectedRunConfig>;
  broadcastText?: string;
  mentionedAgents: AgentMentionBindingDto[];
  broadcastUploadAgentIds: string[];
  recipientSnapshot: ReturnType<typeof recipientActionSnapshot>;
  uploads: Map<string, RecipientUploads<Pick<AssetDto, "id">>>;
  titles: Map<string, string>;
}

interface ConversationMessagingControllerInput {
  conversationId: string;
  conversation?: ConversationDto;
  agents: AgentDto[];
  detailAgents: AgentDto[];
  engines: EngineDto[];
  engine: string;
  model: string;
  effort: string;
  speed: string;
  healthByAgentId: Map<string, AgentHealthDto>;
  messages: ConversationMessageDto[];
  agentTitle(agentId: string | undefined): string;
}

export function useConversationMessagingController({
  conversationId,
  conversation,
  agents,
  detailAgents,
  engines,
  engine,
  model,
  effort,
  speed,
  healthByAgentId,
  messages,
  agentTitle,
}: ConversationMessagingControllerInput) {
  const queryClient = useQueryClient();
  const queuedMessagesQuery = useQuery({
    queryKey: queryKeys.queuedMessages.conversation(conversationId),
    queryFn: () => api.listQueuedConversationMessages(conversationId),
  });
  const [queuedMessageNotice, setQueuedMessageNotice] = useState<string>();
  const [pendingUploadCleanups, setPendingUploadCleanups] = useState(0);
  const submissionAttempt =
    useRef<IdempotentAttempt<ConversationSubmissionPrepared>>();
  const [spawnNotice, setSpawnNotice] = useState<string>();
  const queuedNoticeDeliveryIds = useRef<Set<string>>(new Set());
  const queuedNoticeBaseline = useRef(0);
  const queuedCommandAttempts = useRef<QueuedMessageCommandAttemptRegistry>(
    new Map(),
  );
  const [activeOperation, setActiveOperation] =
    useState<ActiveOperationTracker>();
  const [stopConfirmation, setStopConfirmation] = useState<{
    targets: { agentId: string; runId: string }[];
    names: string;
  }>();
  const [cancelOperationPending, setCancelOperationPending] = useState(false);
  const [cancelOperationError, setCancelOperationError] = useState<Error>();
  const stopOperationRequestIds = useRef<Map<string, string>>(new Map());
  const stopOperationPending = useRef(false);

  const selectedEngine = engines.find(candidate => candidate.id === engine);
  const compatibleModel = modelSelectionIsCompatible(selectedEngine, model)
    ? model
    : "";
  const compatibleEffort = effortSelectionIsCompatible(
    selectedEngine,
    compatibleModel,
    effort,
  )
    ? effort
    : "";
  const runConfig = selectedRunConfig(compatibleModel, compatibleEffort, speed);
  const recipientUnavailable = (error: unknown) =>
    error instanceof ApiRequestError && error.status === 404;
  const cleanupSettled = (error: unknown) =>
    error instanceof ApiRequestError &&
    recipientUploadCleanupSettled(error.status, error.message);
  const definitiveFailure = (error: unknown) =>
    error instanceof ApiRequestError &&
    definitiveSubmissionStatus(error.status, error.message);
  const cleanupPendingReporter = () => recipientUploadCleanupReporter(delta =>
    setPendingUploadCleanups(count => Math.max(0, count + delta)));
  const cleanupRecipientUploads = (
    recipients: RecipientUploads<Pick<AssetDto, "id">>,
  ) => discardRecipientUploads(
    recipients,
    (agentId, item) => api.deleteAttachment(agentId, item.id),
    cleanupSettled,
    cleanupPendingReporter(),
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.detailPrefix(conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.all,
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.collaborationPrefix(conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.targetedNextRun(conversationId),
    });
    if (conversation) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(conversation.projectId),
      });
    }
  };

  const spawn = useMutation({
    mutationFn: async ({
      text,
      draftAttachmentIds,
      draftOwnerId,
      title,
      idempotencyKey,
      selectedEngine,
      runtimeConfig,
      initiatedAt,
    }: {
      text: string;
      draftAttachmentIds: string[];
      draftOwnerId?: string;
      title: string;
      idempotencyKey: string;
      selectedEngine: string;
      runtimeConfig: ReturnType<typeof selectedRunConfig>;
      initiatedAt: number;
    }) => {
      if (!conversation) throw new Error("Project chat not loaded");
      const agent = await api.createAgent(
        conversation.projectId,
        conversationId,
        {
          title,
          engine: selectedEngine,
          ...runtimeConfig,
          initialMessage: text,
          draftAttachmentIds,
          draftOwnerId,
          idempotencyKey,
        },
      );
      setActiveOperation(createActiveOperationTracker(
        "creation",
        ["recovering" in agent ? agent.agentId : agent.id],
        new Map(),
        initiatedAt,
      ));
      return agent;
    },
    onSuccess: agent => {
      invalidate();
      setQueuedMessageNotice(undefined);
      setSpawnNotice("recovering" in agent
        ? "Agent creation is committed and recovery is finishing. It will appear when ready."
        : `Created ${agent.title} and started its first Run.`);
    },
  });

  const sendToAgents = useMutation({
    mutationFn: async ({
      agentIds,
      text,
      uploadedRecipients,
      requestId,
      activeRunDelivery,
      engine,
      runtimeConfig,
    }: {
      agentIds: string[];
      text: string;
      uploadedRecipients: RecipientUploads<Pick<AssetDto, "id">>;
      requestId: string;
      activeRunDelivery: "steer" | "queue";
      engine: string;
      runtimeConfig: ReturnType<typeof selectedRunConfig>;
    }) => {
      return api.sendMultiAgentDirectMessage(conversationId, {
        text,
        recipients: uploadedRecipients.map(({ agentId, attachments }) => ({
          agentId,
          attachmentIds: attachments.map(item => item.id),
        })),
        idempotencyKey: requestId,
        activeRunDelivery,
        // A shared Project-chat selection cannot safely override recipients
        // with different engines or durable models. Single-target sends keep
        // the explicit composer selection; multi-target sends let each Agent
        // use its own persisted runtime.
        ...(agentIds.length === 1 ? { engine, ...runtimeConfig } : {}),
      });
    },
    onSuccess: (response, variables) => {
      invalidate();
      const queuedTitles = response.recipients
        .filter(recipient => recipient.queued)
        .map(
          recipient =>
            detailAgents.find(agent => agent.id === recipient.agentId)?.title ??
            "Agent",
        );
      const unavailableTitles = (response.unavailableRecipients ?? []).map(
        recipient =>
          detailAgents.find(agent => agent.id === recipient.agentId)?.title ?? "Agent",
      );
      setQueuedMessageNotice(
        [
          ...(queuedTitles.length > 0 && variables.activeRunDelivery === "queue"
            ? [`Queued for ${queuedTitles.join(", ")}; it will start when the current response finishes.`]
            : []),
          ...(unavailableTitles.length
            ? [`Skipped unavailable recipient${unavailableTitles.length === 1 ? "" : "s"}: ${unavailableTitles.join(", ")}.`]
            : []),
        ].join(" ") || undefined,
      );
      queuedNoticeDeliveryIds.current = new Set(
        variables.activeRunDelivery === "queue"
          ? response.recipients.flatMap(recipient =>
              recipient.queued && recipient.deliveryId
                ? [recipient.deliveryId]
                : []
            )
          : [],
      );
      queuedNoticeBaseline.current = queuedMessagesQuery.dataUpdatedAt;
      for (const agentId of variables.agentIds) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detailPrefix(agentId),
        });
      }
    },
  });

  const broadcast = useMutation({
    mutationFn: async ({
      text,
      uploadedRecipients,
      requestId,
      agentMentions,
      attachmentOwnerAgentId,
      activeRunDelivery,
      engine,
      runtimeConfig,
    }: {
      text: string;
      uploadedRecipients: RecipientUploads<Pick<AssetDto, "id">>;
      requestId: string;
      agentMentions: AgentMentionBindingDto[];
      attachmentOwnerAgentId?: string;
      activeRunDelivery: "steer" | "queue";
      engine: string;
      runtimeConfig: ReturnType<typeof selectedRunConfig>;
    }) => {
      const agentIds = agentMentions.map(binding => binding.agentId);
      const attachmentsByAgent = new Map(
        uploadedRecipients.map(recipient => [
          recipient.agentId,
          recipient.attachments,
        ]),
      );
      const attachments = attachmentOwnerAgentId
        ? (attachmentsByAgent.get(attachmentOwnerAgentId) ?? []).map(item => ({
            id: item.id,
            agentId: attachmentOwnerAgentId,
          }))
        : [];
      return api.sendConversationMessage(conversationId, {
        text,
        attachments: attachments as AssetDto[],
        ...(agentMentions.length ? { recipientAgentMentions: agentMentions } : {}),
        recipientAttachments: agentIds.map(agentId => ({
          agentId,
          attachmentIds: (attachmentsByAgent.get(agentId) ?? []).map(
            item => item.id,
          ),
        })),
        activeRunDelivery,
        ...(engine ? { engine } : {}),
        ...runtimeConfig,
        idempotencyKey: requestId,
      });
    },
    onSuccess: invalidate,
  });

  const cancelQueued = useMutation({
    mutationFn: (deliveryId: string) =>
      runQueuedMessageCommand(
        queuedCommandAttempts.current,
        { command: "cancel", deliveryId },
        () => `cancel:${deliveryId}`,
        ({ idempotencyKey }) =>
          api.cancelQueuedConversationMessage(conversationId, deliveryId, {
            idempotencyKey,
          }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.conversation(conversationId),
      });
    },
  });
  const editQueued = useMutation({
    mutationFn: ({
      deliveryId,
      targetAgentId,
      text,
    }: {
      deliveryId: string;
      targetAgentId: string;
      text: string;
    }) =>
      runQueuedMessageCommand(
        queuedCommandAttempts.current,
        { command: "edit", deliveryId, text },
        () => createClientId(),
        ({ idempotencyKey, canonicalText }) =>
          api.editQueuedAgentMessage(targetAgentId, deliveryId, {
            text: canonicalText!,
            idempotencyKey,
          }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.conversation(conversationId),
      }),
  });
  const steerQueued = useMutation({
    mutationFn: ({
      deliveryId,
      targetAgentId,
    }: {
      deliveryId: string;
      targetAgentId: string;
    }) =>
      runQueuedMessageCommand(
        queuedCommandAttempts.current,
        { command: "steer", deliveryId },
        () => `steer:${deliveryId}`,
        ({ idempotencyKey }) =>
          api.steerQueuedAgentMessage(targetAgentId, deliveryId, {
            idempotencyKey,
          }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.conversation(conversationId),
      }),
  });

  const busy =
    spawn.isPending || sendToAgents.isPending || broadcast.isPending;
  const activeOperationReceipts = useMemo<ActiveOperationReceipt[]>(
    () => messages.flatMap(message =>
      message.communicationEventId
        ? (message.deliveryReceipts ?? []).map(receipt => ({
            communicationEventId: message.communicationEventId!,
            receipt,
          }))
        : []
    ),
    [messages],
  );
  useEffect(() => {
    if (
      !queuedMessageNotice ||
      queuedMessagesQuery.isFetching ||
      queuedMessagesQuery.dataUpdatedAt <= queuedNoticeBaseline.current
    ) return;
    const pendingIds = new Set(
      (queuedMessagesQuery.data ?? []).map(message => message.deliveryId),
    );
    const trackedIds = queuedNoticeDeliveryIds.current;
    const deliveryStillQueued = trackedIds.size > 0
      ? [...trackedIds].some(deliveryId => pendingIds.has(deliveryId))
      : pendingIds.size > 0;
    if (!deliveryStillQueued) {
      queuedNoticeDeliveryIds.current.clear();
      setQueuedMessageNotice(undefined);
    }
  }, [
    queuedMessageNotice,
    queuedMessagesQuery.data,
    queuedMessagesQuery.dataUpdatedAt,
    queuedMessagesQuery.isFetching,
  ]);
  useEffect(() => {
    if (!activeOperation) return;
    const reconciled = reconcileActiveOperationTracker(
      activeOperation,
      healthByAgentId,
      activeOperationReceipts,
    );
    if (reconciled !== activeOperation) {
      setActiveOperation(reconciled);
      return;
    }
    if (activeOperation.targets.every(target => target.matchedExecutionId)) return;
    const delay = Math.max(0, activeOperation.expiresAt - Date.now());
    const timeout = window.setTimeout(() => {
      setActiveOperation(current => current
        ? reconcileActiveOperationTracker(
            current,
            healthByAgentId,
            activeOperationReceipts,
          )
        : current);
    }, delay + 1);
    return () => window.clearTimeout(timeout);
  }, [activeOperation, activeOperationReceipts, healthByAgentId]);

  const operationRunning = activeOperationIsRunning(activeOperation);
  const cancelOperationTargets = async (
    targets: { agentId: string; runId: string }[],
  ) => {
    if (stopOperationPending.current) return;
    stopOperationPending.current = true;
    setCancelOperationPending(true);
    setCancelOperationError(undefined);
    const attempts = targets.map(target => {
      const targetKey = `${target.agentId}:${target.runId}`;
      const idempotencyKey =
        stopOperationRequestIds.current.get(targetKey) ?? createClientId();
      stopOperationRequestIds.current.set(targetKey, idempotencyKey);
      return { target, targetKey, idempotencyKey };
    });
    try {
      const results = await Promise.allSettled(
        attempts.map(({ target, idempotencyKey }) =>
          api.cancelRun(target.agentId, {
            targetRunId: target.runId,
            idempotencyKey,
          }),
        ),
      );
      const unresolved: { agentId: string; runId: string }[] = [];
      let unresolvedError: Error | undefined;
      results.forEach((result, index) => {
        const attempt = attempts[index]!;
        const alreadyInactive =
          result.status === "rejected" &&
          result.reason instanceof ApiRequestError &&
          result.reason.status === 409;
        if (result.status === "fulfilled" || alreadyInactive) {
          stopOperationRequestIds.current.delete(attempt.targetKey);
          return;
        }
        unresolved.push(attempt.target);
        unresolvedError ??=
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
      });
      if (unresolved.length === 0) {
        setStopConfirmation(undefined);
        setCancelOperationError(undefined);
      } else {
        setStopConfirmation(current =>
          current
            ? {
                targets: unresolved,
                names: unresolved
                  .map(({ agentId }) => agentTitle(agentId))
                  .join(", "),
              }
            : current,
        );
        setCancelOperationError(unresolvedError);
      }
    } finally {
      stopOperationPending.current = false;
      setCancelOperationPending(false);
      invalidate();
    }
  };
  const stopOperation = async () => {
    if (stopOperationPending.current) return;
    const targets = activeOperationExecutionTargets(activeOperation).filter(
      ({ agentId, runId }) =>
        healthByAgentId.get(agentId)?.runtimeActivity?.executionId === runId,
    );
    if (targets.length === 0) return;
    setCancelOperationError(undefined);
    const names = targets.map(({ agentId }) => agentTitle(agentId)).join(", ");
    if (targets.length > 1) {
      setStopConfirmation({ targets, names });
      return;
    }
    await cancelOperationTargets(targets);
  };

  const submit = async (
    text: string,
    files: File[],
    activeRunDelivery: "steer" | "queue" = "steer",
    draftAttachmentIds: string[] = [],
    draftOwnerId?: string,
    mentionedAgents: AgentMentionBindingDto[] = [],
    newAgentRequested = false,
    retryPreparedAttempt = false,
    pendingSubmission?: import("@ponderosa/core").DraftPendingSubmissionDto,
    persistPendingSubmission?: (
      value: import("@ponderosa/core").DraftPendingSubmissionDto,
      retainOnFailure?: boolean,
    ) => Promise<void>,
  ) => {
    setSpawnNotice(undefined);
    const previous = submissionAttempt.current;
    let attempt = preparedIdempotentAttemptForRetry(
      previous,
      retryPreparedAttempt,
    );
    if (!attempt) {
      const broadcastText = managerBroadcastText(text);
      const everyoneMentioned = hasEveryoneMention(text);
      const explicitlyMentionedAgents = mentionedAgents.flatMap(binding => {
        const agent = agents.find(candidate =>
          candidate.id === binding.agentId && !candidate.archived);
        return agent ? [agent] : [];
      });
      const targets = everyoneMentioned
        ? agents.filter(agent => !agent.archived)
        : explicitlyMentionedAgents;
      const broadcastAttachmentOwner = broadcastText !== undefined
        ? agents.find(agent => !agent.archived)
        : undefined;
      const liveRecipientSnapshot = recipientActionSnapshot(
        targets.map(target => target.id),
        broadcastAttachmentOwner?.id,
      );
      const durableRequest = pendingSubmission?.request;
      const exactDelivery = durableRequest?.runtime.activeRunDelivery ?? activeRunDelivery;
      const exactEngine = durableRequest
        ? durableRequest.runtime.engine ?? ""
        : engine;
      const exactRunConfig = durableRequest
        ? selectedRunConfig(
            durableRequest.runtime.model ?? "",
            durableRequest.runtime.effort ?? "",
            durableRequest.runtime.speed ?? "",
          )
        : runConfig;
      const recipientSnapshot = durableRequest
        ? recipientActionSnapshot(
            durableRequest.recipientAgentIds,
            durableRequest.broadcastAttachmentOwnerAgentId,
          )
        : liveRecipientSnapshot;
      const exactMentionedAgents = durableRequest?.mentionBindings ?? mentionedAgents;
      const broadcastUploadAgentIds = [
        ...new Set([
          ...(recipientSnapshot.broadcastAttachmentOwnerAgentId
            ? [recipientSnapshot.broadcastAttachmentOwnerAgentId]
            : []),
          ...exactMentionedAgents.map(binding => binding.agentId),
        ]),
      ];
      const fingerprint = JSON.stringify({
        conversationId,
        text: stableMessageActionText(text, mentionedAgents),
        files: fileSelectionFingerprint(files),
        draftAttachmentIds,
        draftOwnerId,
        mentionedAgentIds: [...new Set(mentionedAgents.map(binding => binding.agentId))]
          .sort(),
        newAgentRequested,
        activeRunDelivery,
        engine,
        ...runConfig,
      });
      attempt = retainIdempotentAttempt(
        previous,
        fingerprint,
        () => pendingSubmission?.idempotencyKey ?? createClientId(),
        () => ({
          text,
          files,
          draftAttachmentIds: pendingDraftAttachmentIds(
            pendingSubmission,
            draftAttachmentIds,
          ),
          draftOwnerId,
          newAgentRequested,
          activeRunDelivery: exactDelivery,
          engine: exactEngine,
          runConfig: exactRunConfig,
          broadcastText,
          mentionedAgents: exactMentionedAgents,
          broadcastUploadAgentIds,
          recipientSnapshot,
          uploads: new Map(),
          titles: new Map(),
        }),
      );
      if (pendingSubmission && !pendingSubmission.request && persistPendingSubmission) {
        pendingSubmission = withPendingRequest(pendingSubmission, {
          conversationId,
          recipientAgentIds: recipientSnapshot.targetAgentIds,
          ...(exactMentionedAgents.length ? { mentionBindings: exactMentionedAgents } : {}),
          ...(recipientSnapshot.broadcastAttachmentOwnerAgentId ? {
            broadcastAttachmentOwnerAgentId:
              recipientSnapshot.broadcastAttachmentOwnerAgentId,
          } : {}),
          runtime: {
            activeRunDelivery,
            engine,
            ...runConfig,
          },
        });
        await persistPendingSubmission(pendingSubmission);
      }
    }
    if (previous && previous !== attempt) {
      await Promise.all(
        [...previous.prepared.uploads.values()].map(recipients =>
          cleanupRecipientUploads(recipients),
        ),
      );
    }
    submissionAttempt.current = attempt;
    const requestId = attempt.idempotencyKey;
    const prepared = attempt.prepared;
    const submittedText = prepared.text;
    const submittedBroadcastText = prepared.broadcastText;
    const {
      targetAgentIds,
      broadcastAttachmentOwnerAgentId,
    } = prepared.recipientSnapshot;
    const preparedUploads = async (scope: string, agentIds: string[]) => {
      const key = recipientUploadCacheKey(scope, agentIds);
      let uploaded = prepared.uploads.get(key);
      const durable = pendingRecipientUploads(pendingSubmission, scope);
      if (!uploaded && durable &&
          JSON.stringify(durable.map(item => item.agentId)) === JSON.stringify(agentIds)) {
        uploaded = durable;
      }
      uploaded ??= await uploadFilesForRecipients(
          agentIds,
          prepared.files,
          (agentId, file) => api.uploadAttachment(agentId, file),
          (agentId, item) => api.deleteAttachment(agentId, item.id),
          recipientUnavailable,
          cleanupPendingReporter(),
        );
      prepared.uploads.set(key, uploaded);
      if (pendingSubmission && persistPendingSubmission) {
        pendingSubmission = withPendingRecipientUploads(
          pendingSubmission,
          scope,
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
            prepared.uploads.delete(key);
          }
          throw error;
        }
      }
      return uploaded;
    };
    const finishAttempt = () => {
      if (submissionAttempt.current === attempt) submissionAttempt.current = undefined;
    };
    const createdAgentIds: string[] = [];
    let createdAgentInitiatedAt: number | undefined;
    const createdTitles = detailAgents.map(agent => agent.title);
    let agentCreationCommitted = false;
    const durableAgentTitle = async (
      titleKey: "new-agent:0" | "default-agent",
    ): Promise<string> => {
      const title = pendingSubmission?.agentTitle ??
        prepared.titles.get(titleKey) ?? pickAgentName(createdTitles);
      prepared.titles.set(titleKey, title);
      if (pendingSubmission && !pendingSubmission.agentTitle &&
          persistPendingSubmission) {
        pendingSubmission = await withPendingAgentTitle(
          pendingSubmission,
          title,
        );
        await persistPendingSubmission(pendingSubmission);
      }
      return title;
    };
    if (prepared.newAgentRequested) {
      createdAgentInitiatedAt = Date.now();
      const titleKey = "new-agent:0";
      const title = await durableAgentTitle(titleKey);
      createdTitles.push(title);
      const created = await spawn.mutateAsync({
        text: submittedText,
        draftAttachmentIds: prepared.draftAttachmentIds,
        draftOwnerId: prepared.draftOwnerId,
        title,
        idempotencyKey: `${requestId}:new-agent:0`,
        selectedEngine: prepared.engine,
        runtimeConfig: prepared.runConfig,
        initiatedAt: createdAgentInitiatedAt,
      });
      agentCreationCommitted = true;
      if (pendingSubmission && persistPendingSubmission) {
        pendingSubmission = withCommittedAgentCreation(pendingSubmission);
        await persistPendingSubmission(pendingSubmission, true);
      }
      if (!("recovering" in created)) createdAgentIds.push(created.id);
    }
    if (submittedBroadcastText !== undefined) {
      if (!submittedBroadcastText && prepared.files.length === 0) {
        throw new Error(
          "Add informational context or an attachment after #broadcast.",
        );
      }
      if (prepared.files.length && !broadcastAttachmentOwnerAgentId) {
        throw new Error(
          "Create an agent before attaching files to shared project context.",
        );
      }
      const broadcastUploadKey = recipientUploadCacheKey(
        "broadcast",
        prepared.broadcastUploadAgentIds,
      );
      const uploadedRecipients = await preparedUploads(
        "broadcast",
        prepared.broadcastUploadAgentIds,
      );
      const broadcastTracker = submittedBroadcastText !== undefined &&
          prepared.mentionedAgents.length > 0
        ? createDeliveryOperationTracker(
            prepared.activeRunDelivery,
            prepared.mentionedAgents.map(binding => binding.agentId),
            healthByAgentId,
          )
        : undefined;
      try {
        const response = await broadcast.mutateAsync({
          text: submittedBroadcastText,
          uploadedRecipients,
          requestId,
          agentMentions: prepared.mentionedAgents,
          attachmentOwnerAgentId: broadcastAttachmentOwnerAgentId,
          activeRunDelivery: prepared.activeRunDelivery,
          engine: prepared.engine,
          runtimeConfig: prepared.runConfig,
        });
        if (broadcastTracker) {
          setActiveOperation(acceptBroadcastOperation(
            broadcastTracker,
            response.communicationEventId,
          ));
        }
      } catch (error) {
        if (!agentCreationCommitted &&
            await cleanupRecipientUploadsForDefinitiveFailure({
              error,
              recipients: uploadedRecipients,
              definitiveFailure,
              cleanup: (agentId, item) => api.deleteAttachment(agentId, item.id),
              cleanupUnavailable: cleanupSettled,
              onPendingChange: cleanupPendingReporter(),
            })) {
          prepared.uploads.delete(broadcastUploadKey);
        }
        throw error;
      }
      finishAttempt();
      return;
    }
    if (hasBroadcastMention(submittedText)) {
      throw new Error("Broadcast scope could not be resolved.");
    }
    if (hasEveryoneMention(submittedText) && targetAgentIds.length === 0) {
      throw new Error("There are no active agents to notify.");
    }
    if (targetAgentIds.length > 0) {
      const uploadKey = recipientUploadCacheKey("direct", targetAgentIds);
      const uploadedRecipients = await preparedUploads("direct", targetAgentIds);
      const directTracker = createDeliveryOperationTracker(
        prepared.activeRunDelivery,
        targetAgentIds,
        healthByAgentId,
      );
      let response: MultiAgentDirectMessageResponse;
      try {
        response = await sendToAgents.mutateAsync({
          agentIds: targetAgentIds,
          text: submittedText,
          uploadedRecipients,
          requestId,
          activeRunDelivery: prepared.activeRunDelivery,
          engine: prepared.engine,
          runtimeConfig: prepared.runConfig,
        });
        if (directTracker) {
          setActiveOperation(acceptDirectOperation(directTracker, response));
        }
      } catch (error) {
        if (!agentCreationCommitted &&
            await cleanupRecipientUploadsForDefinitiveFailure({
              error,
              recipients: uploadedRecipients,
              definitiveFailure,
              cleanup: (agentId, item) => api.deleteAttachment(agentId, item.id),
              cleanupUnavailable: cleanupSettled,
              onPendingChange: cleanupPendingReporter(),
            })) {
          prepared.uploads.delete(uploadKey);
          throw error;
        }
        const cleanupUploads = error instanceof ApiRequestError
          ? compoundCreationUnavailableUploads(
              agentCreationCommitted,
              error.status,
              error.message,
              uploadedRecipients,
            )
          : undefined;
        if (!cleanupUploads) {
          throw error;
        }
        sendToAgents.reset();
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
        setActiveOperation(createdAgentIds.length
          ? createActiveOperationTracker(
              "creation",
              createdAgentIds,
              healthByAgentId,
              createdAgentInitiatedAt,
            )
          : undefined);
        setQueuedMessageNotice(
          `Created ${prepared.titles.get("new-agent:0") ?? "the new Agent"}; every other addressed Agent became unavailable.`,
        );
        finishAttempt();
        return;
      }
      const deliveredRecipientIds = response.recipients.map(
        recipient => recipient.agentId,
      );
      const unavailableRecipientIds = (response.unavailableRecipients ?? []).map(
        recipient => recipient.agentId,
      );
      prepared.uploads.set(
        uploadKey,
        recipientUploadsForAgentIds(uploadedRecipients, deliveredRecipientIds),
      );
      void retryRecipientUploadCleanup(
        recipientUploadsForAgentIds(uploadedRecipients, unavailableRecipientIds),
        async (agentId, attachment) => {
          try {
            await api.deleteAttachment(agentId, attachment.id);
          } catch (error) {
            if (!cleanupSettled(error)) throw error;
          }
        },
        cleanupPendingReporter(),
      );
    } else if (!prepared.newAgentRequested) {
      const titleKey = "default-agent";
      const title = await durableAgentTitle(titleKey);
      createdAgentInitiatedAt = Date.now();
      await spawn.mutateAsync({
        text: submittedText,
        draftAttachmentIds: prepared.draftAttachmentIds,
        draftOwnerId: prepared.draftOwnerId,
        title,
        idempotencyKey: `${requestId}:default-agent`,
        selectedEngine: prepared.engine,
        runtimeConfig: prepared.runConfig,
        initiatedAt: createdAgentInitiatedAt,
      });
    } else if (createdAgentIds.length > 0) {
      setActiveOperation(createActiveOperationTracker(
        "creation",
        createdAgentIds,
        healthByAgentId,
        createdAgentInitiatedAt,
      ));
    }
    finishAttempt();
  };

  return {
    busy,
    cancelOperationError,
    cancelOperationPending,
    cancelOperationTargets,
    cancelQueued,
    editQueued,
    invalidate,
    operationRunning,
    queuedMessageNotice: [
      queuedMessageNotice ?? spawnNotice,
      pendingUploadCleanups
        ? "Message sent. Temporary uploads for skipped recipients are still being cleaned up automatically."
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined,
    queuedMessagesQuery,
    sendError: spawn.error ?? sendToAgents.error,
    setQueuedMessageNotice,
    setStopConfirmation,
    steerQueued,
    stopConfirmation,
    stopOperation,
    submit,
  };
}
