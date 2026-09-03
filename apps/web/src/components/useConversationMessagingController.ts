import type {
  AgentDto,
  AgentHealthDto,
  AgentMentionBindingDto,
  AssetDto,
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
  fileSelectionFingerprint,
  managerBroadcastText,
  type RecipientUploads,
  uploadFilesForRecipients,
} from "../conversationRouting";
import { pickAgentName } from "../parkNames";
import { queryKeys } from "../queryKeys";
import type { AgentStatus } from "../agents";
import { activeDirectDeliveryAgentIds } from "./directDeliveryState";
import {
  retainIdempotentAttempt,
  type IdempotentAttempt,
} from "./idempotentAttempt";

interface ConversationSubmissionPrepared {
  uploads: Map<string, RecipientUploads<AssetDto>>;
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
  statusByAgentId: Map<string, AgentStatus>;
  healthByAgentId: Map<string, AgentHealthDto>;
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
  statusByAgentId,
  healthByAgentId,
  agentTitle,
}: ConversationMessagingControllerInput) {
  const queryClient = useQueryClient();
  const queuedMessagesQuery = useQuery({
    queryKey: queryKeys.queuedMessages.conversation(conversationId),
    queryFn: () => api.listQueuedConversationMessages(conversationId),
  });
  const [queuedMessageNotice, setQueuedMessageNotice] = useState<string>();
  const submissionAttempt =
    useRef<IdempotentAttempt<ConversationSubmissionPrepared>>();
  const [spawnNotice, setSpawnNotice] = useState<string>();
  const queuedNoticeDeliveryIds = useRef<Set<string>>(new Set());
  const queuedNoticeBaseline = useRef(0);
  const [activeOperation, setActiveOperation] = useState<{
    agentIds: string[];
    state: "starting" | "running";
  }>();
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
    }: {
      text: string;
      draftAttachmentIds: string[];
      draftOwnerId?: string;
      title: string;
      idempotencyKey: string;
    }) => {
      if (!conversation) throw new Error("Project chat not loaded");
      setActiveOperation({ agentIds: [], state: "starting" });
      const agent = await api.createAgent(
        conversation.projectId,
        conversationId,
        {
          title,
          engine,
          ...runConfig,
          initialMessage: text,
          draftAttachmentIds,
          draftOwnerId,
          idempotencyKey,
        },
      );
      setActiveOperation("recovering" in agent
        ? undefined
        : { agentIds: [agent.id], state: "starting" });
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
    }: {
      agentIds: string[];
      text: string;
      uploadedRecipients: RecipientUploads<AssetDto>;
      requestId: string;
      activeRunDelivery: "steer" | "queue";
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
        ...(agentIds.length === 1 ? runConfig : {}),
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
      const activeIds = activeDirectDeliveryAgentIds(response);
      if (activeIds.length === 0) setActiveOperation(undefined);
      else setActiveOperation({ agentIds: activeIds, state: "starting" });
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
      activeRunDelivery,
    }: {
      text: string;
      uploadedRecipients: RecipientUploads<AssetDto>;
      requestId: string;
      agentMentions: AgentMentionBindingDto[];
      activeRunDelivery: "steer" | "queue";
    }) => {
      const agentIds = agentMentions.map(binding => binding.agentId);
      const owner = agents.find(agent => !agent.archived);
      const attachmentsByAgent = new Map(
        uploadedRecipients.map(recipient => [
          recipient.agentId,
          recipient.attachments,
        ]),
      );
      const attachments = owner
        ? (attachmentsByAgent.get(owner.id) ?? [])
        : [];
      return api.sendConversationMessage(conversationId, {
        text,
        attachments,
        ...(agentMentions.length ? { recipientAgentMentions: agentMentions } : {}),
        recipientAttachments: agentIds.map(agentId => ({
          agentId,
          attachmentIds: (attachmentsByAgent.get(agentId) ?? []).map(
            item => item.id,
          ),
        })),
        activeRunDelivery,
        idempotencyKey: requestId,
      });
    },
    onSuccess: invalidate,
  });

  const cancelQueued = useMutation({
    mutationFn: (deliveryId: string) =>
      api.cancelQueuedConversationMessage(conversationId, deliveryId, {
        idempotencyKey: `cancel:${deliveryId}`,
      }),
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
      api.editQueuedAgentMessage(targetAgentId, deliveryId, {
        text,
        idempotencyKey: createClientId(),
      }),
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
      api.steerQueuedAgentMessage(targetAgentId, deliveryId, {
        idempotencyKey: createClientId(),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.conversation(conversationId),
      }),
  });

  const busy =
    spawn.isPending || sendToAgents.isPending || broadcast.isPending;
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
    if (!activeOperation || activeOperation.agentIds.length === 0) return;
    const anyRunning = activeOperation.agentIds.some(
      agentId => statusByAgentId.get(agentId) === "running",
    );
    if (anyRunning && activeOperation.state !== "running") {
      setActiveOperation({ ...activeOperation, state: "running" });
    } else if (!busy && activeOperation.state === "running" && !anyRunning) {
      setActiveOperation(undefined);
    }
  }, [activeOperation, busy, statusByAgentId]);

  const operationRunning = Boolean(
    activeOperation && (busy || activeOperation.state === "running"),
  );
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
    const targets = (activeOperation?.agentIds ?? []).flatMap(agentId => {
      const runId = healthByAgentId.get(agentId)?.runtimeActivity?.executionId;
      return runId ? [{ agentId, runId }] : [];
    });
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
  ) => {
    setSpawnNotice(undefined);
    const broadcastMentioned = hasBroadcastMention(text);
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
    const fingerprint = JSON.stringify({
      conversationId,
      text,
      files: fileSelectionFingerprint(files),
      draftAttachmentIds,
      draftOwnerId,
      mentionedAgents: mentionedAgents.map(binding => [binding.agentId, binding.handle]),
      newAgentRequested,
      activeRunDelivery,
      engine,
      ...runConfig,
    });
    const previous = submissionAttempt.current;
    const attempt = retainIdempotentAttempt(
      previous,
      fingerprint,
      () => createClientId(),
      () => ({ uploads: new Map(), titles: new Map() }),
    );
    if (previous && previous !== attempt) {
      await Promise.all(
        [...previous.prepared.uploads.values()].map(recipients =>
          discardRecipientUploads(recipients, (agentId, item) =>
            api.deleteAttachment(agentId, item.id)),
        ),
      );
    }
    submissionAttempt.current = attempt;
    const requestId = attempt.idempotencyKey;
    const preparedUploads = async (key: string, agentIds: string[]) => {
      const cached = attempt.prepared.uploads.get(key);
      if (cached) return cached;
      const uploaded = await uploadFilesForRecipients(
        agentIds,
        files,
        (agentId, file) => api.uploadAttachment(agentId, file),
        (agentId, item) => api.deleteAttachment(agentId, item.id),
      );
      attempt.prepared.uploads.set(key, uploaded);
      return uploaded;
    };
    const finishAttempt = () => {
      if (submissionAttempt.current === attempt) submissionAttempt.current = undefined;
    };
    const createdAgentIds: string[] = [];
    const createdTitles = detailAgents.map(agent => agent.title);
    if (newAgentRequested) {
      const titleKey = "new-agent:0";
      const title =
        attempt.prepared.titles.get(titleKey) ?? pickAgentName(createdTitles);
      attempt.prepared.titles.set(titleKey, title);
      createdTitles.push(title);
      const created = await spawn.mutateAsync({
        text,
        draftAttachmentIds,
        draftOwnerId,
        title,
        idempotencyKey: `${requestId}:new-agent:0`,
      });
      if (!("recovering" in created)) createdAgentIds.push(created.id);
    }
    if (broadcastText !== undefined) {
      if (!broadcastText && files.length === 0) {
        throw new Error(
          "Add informational context or an attachment after #broadcast.",
        );
      }
      const owner = agents.find(agent => !agent.archived);
      if (files.length && !owner) {
        throw new Error(
          "Create an agent before attaching files to shared project context.",
        );
      }
      const uploadAgentIds = [
        ...new Set([
          ...(owner ? [owner.id] : []),
          ...mentionedAgents.map(binding => binding.agentId),
        ]),
      ];
      await broadcast.mutateAsync({
        text: broadcastText,
        uploadedRecipients: await preparedUploads("broadcast", uploadAgentIds),
        requestId,
        agentMentions: broadcastMentioned ? mentionedAgents : [],
        activeRunDelivery,
      });
      if (createdAgentIds.length > 0) {
        setActiveOperation({ agentIds: createdAgentIds, state: "starting" });
      }
      finishAttempt();
      return;
    }
    if (broadcastMentioned) {
      throw new Error("Broadcast scope could not be resolved.");
    }
    if (everyoneMentioned && targets.length === 0) {
      throw new Error("There are no active agents to notify.");
    }
    if (targets.length > 0) {
      setActiveOperation({
        agentIds: targets.map(target => target.id),
        state: "starting",
      });
      await sendToAgents.mutateAsync({
        agentIds: targets.map(target => target.id),
        text,
        uploadedRecipients: await preparedUploads(
          "direct",
          targets.map(target => target.id),
        ),
        requestId,
        activeRunDelivery,
      });
    } else if (!newAgentRequested) {
      setActiveOperation({ agentIds: [], state: "starting" });
      const titleKey = "default-agent";
      const title =
        attempt.prepared.titles.get(titleKey) ??
        pickAgentName(detailAgents.map(agent => agent.title));
      attempt.prepared.titles.set(titleKey, title);
      await spawn.mutateAsync({
        text,
        draftAttachmentIds,
        draftOwnerId,
        title,
        idempotencyKey: `${requestId}:default-agent`,
      });
    } else if (createdAgentIds.length > 0) {
      setActiveOperation({ agentIds: createdAgentIds, state: "starting" });
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
    queuedMessageNotice: queuedMessageNotice ?? spawnNotice,
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
