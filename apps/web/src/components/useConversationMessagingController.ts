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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
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
  broadcastAttachmentsForOwner,
  cleanupRecipientUploadsForDefinitiveFailure,
  fileSelectionFingerprint,
  recipientUploadsForAgentIds,
  recipientUploadsNeedPersistence,
  recipientActionSnapshot,
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
import { publishConversationMessageReceipt } from "../conversationMessageReceipt";
import { publishCreatedAgent } from "../conversationAgentCache";
import {
  acceptBroadcastOperation,
  acceptDirectOperation,
  createCreationOperationTracker,
  createDeliveryOperationTracker,
  createQueuedSteerOperationTracker,
} from "./activeOperationTracker";
import {
  compoundCreationUnavailableUploads,
  preparedIdempotentAttemptForRetry,
  retainIdempotentAttempt,
  withCommittedAgentCreation,
  withPendingAgentTitle,
  type IdempotentAttempt,
} from "./idempotentAttempt";
import { recipientUploadControls } from "./recipientUploadControls";
import { useActiveOperationController } from "./useActiveOperationController";
import { useQueuedConversationMessagesController } from "./useQueuedConversationMessagesController";

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
  const activeConversationId = useRef(conversationId);
  activeConversationId.current = conversationId;
  const [pendingUploadCleanups, setPendingUploadCleanups] = useState(0);
  const submissionAttempt =
    useRef<IdempotentAttempt<ConversationSubmissionPrepared>>();
  const submissionAttempts = useRef(new Map<string, IdempotentAttempt<ConversationSubmissionPrepared>>());
  const [spawnNotice, setSpawnNotice] = useState<string>();

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
  const deleteUploadedAttachment = (ownerId: string, attachmentId: string) =>
    ownerId === conversationId
      ? api.deleteConversationAttachment(conversationId, attachmentId)
      : api.deleteAttachment(ownerId, attachmentId);
  const {
    recipientUnavailable, cleanupSettled, definitiveFailure,
    cleanupPendingReporter, cleanupRecipientUploads,
  } = recipientUploadControls({
    deleteAttachment: deleteUploadedAttachment,
    onPendingDelta: delta => setPendingUploadCleanups(count => Math.max(0, count + delta)),
  });

  const invalidate = (scopeId = conversationId, projectId = conversation?.projectId) => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.detailPrefix(scopeId),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.queuedMessages.conversation(scopeId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.all,
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.collaborationPrefix(scopeId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.targetedNextRun(scopeId),
    });
    if (projectId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(projectId),
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
    activeScopeId: conversationId,
    healthByAgentId,
    receiptSources: messages,
    agentTitle,
    invalidate,
  });
  const queuedMessages = useQueuedConversationMessagesController(
    conversationId,
    message => setActiveOperation(createQueuedSteerOperationTracker(
      message.deliveryId,
      message.targetAgentId,
      healthByAgentId,
      conversationId,
    )),
  );
  const queuedMessagesQuery = queuedMessages.query;
  const queuedMessageNotice = queuedMessages.notice;
  const setQueuedMessageNotice = queuedMessages.setNotice;

  const spawn = useMutation({
    mutationFn: async ({
      scopeId,
      scopeProjectId,
      text,
      draftAttachmentIds,
      draftOwnerId,
      title,
      idempotencyKey,
      selectedEngine,
      runtimeConfig,
      onAgentCreated,
    }: {
      scopeId: string;
      scopeProjectId?: string;
      text: string;
      draftAttachmentIds: string[];
      draftOwnerId?: string;
      title: string;
      idempotencyKey: string;
      selectedEngine: string;
      runtimeConfig: ReturnType<typeof selectedRunConfig>;
      onAgentCreated?(agent: AgentDto): void;
    }) => {
      if (!scopeProjectId) throw new Error("Project chat not loaded");
      const agent = await api.createAgent(
        scopeProjectId,
        scopeId,
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
      const agentId = "recovering" in agent ? agent.agentId : agent.id;
      if (!("recovering" in agent)) onAgentCreated?.(agent);
      if (activeConversationId.current === scopeId) setActiveOperation(createCreationOperationTracker(agentId, scopeId));
      return agent;
    },
    onSuccess: async (agent, variables) => {
      if (!("recovering" in agent)) publishCreatedAgent(queryClient, agent);
      invalidate(variables.scopeId, variables.scopeProjectId);
      if (activeConversationId.current !== variables.scopeId) return;
      setQueuedMessageNotice(undefined);
      setSpawnNotice("recovering" in agent
        ? "Agent creation is committed and recovery is finishing. It will appear when ready."
        : undefined);
      await queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(variables.scopeId) });
    },
  });

  const sendToAgents = useMutation({
    mutationFn: async ({
      scopeId,
      agentIds,
      text,
      uploadedRecipients,
      requestId,
      activeRunDelivery,
      engine,
      runtimeConfig,
    }: {
      scopeId: string;
      scopeProjectId?: string;
      agentIds: string[];
      text: string;
      uploadedRecipients: RecipientUploads<Pick<AssetDto, "id">>;
      requestId: string;
      activeRunDelivery: "steer" | "queue";
      engine: string;
      runtimeConfig: ReturnType<typeof selectedRunConfig>;
    }) => {
      return api.sendMultiAgentDirectMessage(scopeId, {
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
    onSuccess: async (response, variables) => {
      await publishConversationMessageReceipt(queryClient, variables.scopeId, response.message);
      invalidate(variables.scopeId, variables.scopeProjectId);
      if (activeConversationId.current === variables.scopeId) queuedMessages.recordDelivery(
        response,
        variables.activeRunDelivery,
        agentId => detailAgents.find(agent => agent.id === agentId)?.title ?? "Agent",
      );
      for (const agentId of variables.agentIds) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detailPrefix(agentId),
        });
      }
    },
  });

  const broadcast = useMutation({
    mutationFn: async ({
      scopeId,
      text,
      uploadedRecipients,
      requestId,
      agentMentions,
      attachmentOwnerAgentId,
      activeRunDelivery,
      engine,
      runtimeConfig,
    }: {
      scopeId: string;
      scopeProjectId?: string;
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
      const attachments = broadcastAttachmentsForOwner(
        scopeId, attachmentOwnerAgentId, uploadedRecipients,
      );
      return api.sendConversationMessage(scopeId, {
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
    onSuccess: async (response, variables) => {
      await publishConversationMessageReceipt(queryClient, variables.scopeId,
        "id" in response ? response : undefined);
      invalidate(variables.scopeId, variables.scopeProjectId);
    },
  });

  const cancelQueued = queuedMessages.cancel;
  const editQueued = queuedMessages.edit;
  const steerQueued = queuedMessages.steer;
  const busy =
    spawn.isPending || sendToAgents.isPending || broadcast.isPending;

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
    onAgentCreated?: (agent: AgentDto) => void,
    capturedSubmission = false,
  ) => {
    if (activeConversationId.current === conversationId) setSpawnNotice(undefined);
    const showOperation = (operation: Parameters<typeof setActiveOperation>[0]) => {
      if (activeConversationId.current === conversationId) setActiveOperation(operation);
    };
    const durableId = pendingSubmission?.idempotencyKey;
    const previous = durableId ? submissionAttempts.current.get(durableId) : submissionAttempt.current;
    let attempt = preparedIdempotentAttemptForRetry(
      previous,
      retryPreparedAttempt,
    );
    if (!attempt) {
      const broadcastText = managerBroadcastText(text);
      const everyoneMentioned = hasEveryoneMention(text);
      const explicitlyMentionedAgents = mentionedAgents.flatMap(binding => {
        const agent = agents.find(candidate =>
          candidate.id === binding.agentId);
        return agent ? [agent] : [];
      });
      const targets = everyoneMentioned
        ? agents
        : explicitlyMentionedAgents;
      const broadcastAttachmentOwnerId = broadcastText !== undefined
        ? agents[0]?.id ?? (files.length ? conversationId : undefined)
        : undefined;
      const liveRecipientSnapshot = recipientActionSnapshot(
        targets.map(target => target.id),
        broadcastAttachmentOwnerId,
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
    if (durableId) submissionAttempts.current.set(durableId, attempt);
    else submissionAttempt.current = attempt;
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
          (agentId, file) => agentId === conversationId
            ? api.uploadConversationAttachment(conversationId, file)
            : api.uploadAttachment(agentId, file),
          (agentId, item) => deleteUploadedAttachment(agentId, item.id),
          recipientUnavailable,
          cleanupPendingReporter(),
        );
      prepared.uploads.set(key, uploaded);
      // An empty upload set has no cleanup authority to journal. The durable
      // request already holds the recipient snapshot and idempotency key; a
      // third draft write here only delays every ordinary text send.
      if (pendingSubmission && persistPendingSubmission && recipientUploadsNeedPersistence(uploaded)) {
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
            cleanup: (agentId, item) => deleteUploadedAttachment(agentId, item.id),
            definitiveFailure: capturedSubmission ? () => false : definitiveFailure,
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
      if (durableId) submissionAttempts.current.delete(durableId);
      else if (submissionAttempt.current === attempt) submissionAttempt.current = undefined;
    };
    let acceptedResponse: MultiAgentDirectMessageResponse | undefined;
    const createdAgentIds: string[] = [];
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
      const titleKey = "new-agent:0";
      const title = await durableAgentTitle(titleKey);
      createdTitles.push(title);
      const created = await spawn.mutateAsync({
        scopeId: conversationId, scopeProjectId: conversation?.projectId,
        text: submittedText,
        draftAttachmentIds: prepared.draftAttachmentIds,
        draftOwnerId: prepared.draftOwnerId,
        title,
        idempotencyKey: `${requestId}:new-agent:0`,
        onAgentCreated,
        selectedEngine: prepared.engine,
        runtimeConfig: prepared.runConfig,
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
      if (prepared.files.length && !broadcastAttachmentOwnerAgentId) throw new Error("This Chat could not store the Broadcast attachment. Try again.");
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
            Date.now(),
            conversationId,
          )
        : undefined;
      try {
        const response = await broadcast.mutateAsync({
          scopeId: conversationId, scopeProjectId: conversation?.projectId,
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
          showOperation(acceptBroadcastOperation(
            broadcastTracker,
            response.communicationEventId,
          ));
        }
      } catch (error) {
        if (!capturedSubmission && !agentCreationCommitted &&
            await cleanupRecipientUploadsForDefinitiveFailure({
              error,
              recipients: uploadedRecipients,
              definitiveFailure: capturedSubmission ? () => false : definitiveFailure,
              cleanup: (agentId, item) => deleteUploadedAttachment(agentId, item.id),
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
        Date.now(),
        conversationId,
      );
      let response: MultiAgentDirectMessageResponse;
      try {
        response = await sendToAgents.mutateAsync({
          scopeId: conversationId, scopeProjectId: conversation?.projectId,
          agentIds: targetAgentIds,
          text: submittedText,
          uploadedRecipients,
          requestId,
          activeRunDelivery: prepared.activeRunDelivery,
          engine: prepared.engine,
          runtimeConfig: prepared.runConfig,
        });
        if (directTracker) {
          showOperation(acceptDirectOperation(directTracker, response));
        }
      } catch (error) {
        if (!capturedSubmission && !agentCreationCommitted &&
            await cleanupRecipientUploadsForDefinitiveFailure({
              error,
              recipients: uploadedRecipients,
              definitiveFailure: capturedSubmission ? () => false : definitiveFailure,
              cleanup: (agentId, item) => deleteUploadedAttachment(agentId, item.id),
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
              await deleteUploadedAttachment(agentId, attachment.id);
            } catch (cleanupError) {
              if (!cleanupSettled(cleanupError)) throw cleanupError;
            }
          },
          cleanupPendingReporter(),
        );
        showOperation(createdAgentIds.length
          ? createCreationOperationTracker(createdAgentIds[0]!, conversationId)
          : undefined);
        if (activeConversationId.current === conversationId) setQueuedMessageNotice(
          `Created ${prepared.titles.get("new-agent:0") ?? "the new Agent"}; every other addressed Agent became unavailable.`,
        );
        finishAttempt();
        return;
      }
      acceptedResponse = response;
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
            await deleteUploadedAttachment(agentId, attachment.id);
          } catch (error) {
            if (!cleanupSettled(error)) throw error;
          }
        },
        cleanupPendingReporter(),
      );
    } else if (!prepared.newAgentRequested) {
      const titleKey = "default-agent";
      const title = await durableAgentTitle(titleKey);
      await spawn.mutateAsync({
        scopeId: conversationId, scopeProjectId: conversation?.projectId,
        text: submittedText,
        draftAttachmentIds: prepared.draftAttachmentIds,
        draftOwnerId: prepared.draftOwnerId,
        title,
        idempotencyKey: `${requestId}:default-agent`,
        onAgentCreated,
        selectedEngine: prepared.engine,
        runtimeConfig: prepared.runConfig,
      });
    } else if (createdAgentIds.length > 0) {
      showOperation(createCreationOperationTracker(
        createdAgentIds[0]!,
        conversationId,
      ));
    }
    finishAttempt();
    return acceptedResponse;
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
    queuedMessageFailure: queuedMessages.failure,
    queuedMessagesQuery,
    setQueuedMessageNotice,
    setStopConfirmation,
    steerQueued,
    stopConfirmation,
    stopOperation,
    submit,
  };
}
