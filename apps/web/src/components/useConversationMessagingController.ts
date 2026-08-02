import type {
  AgentDto,
  AgentHealthDto,
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  findMentionedAgents,
  hasBroadcastMention,
  hasEveryoneMention,
} from "../mentions";
import { api } from "../api";
import { createClientId } from "../clientId";
import {
  effortSelectionIsCompatible,
  modelSelectionIsCompatible,
  selectedRunConfig,
} from "../conversationEngine";
import {
  managerBroadcastText,
  uploadFilesForRecipients,
} from "../conversationRouting";
import { pickAgentName } from "../parkNames";
import { queryKeys } from "../queryKeys";
import type { AgentStatus } from "../agents";

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
  const stopOperationRequestId = useRef<string>();
  const stopOperationPending = useRef(false);

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
    }: {
      text: string;
      draftAttachmentIds: string[];
      draftOwnerId?: string;
    }) => {
      if (!conversation) throw new Error("Project chat not loaded");
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
      const runConfig = selectedRunConfig(
        compatibleModel,
        compatibleEffort,
        speed,
      );
      setActiveOperation({ agentIds: [], state: "starting" });
      const agent = await api.createAgent(
        conversation.projectId,
        conversationId,
        {
          title: pickAgentName(detailAgents.map(agent => agent.title)),
          engine,
          ...runConfig,
          initialMessage: text,
          draftAttachmentIds,
          draftOwnerId,
        },
      );
      setActiveOperation({ agentIds: [agent.id], state: "starting" });
      return agent;
    },
    onSuccess: invalidate,
  });

  const sendToAgents = useMutation({
    mutationFn: async ({
      agentIds,
      text,
      files,
      requestId,
      activeRunDelivery,
    }: {
      agentIds: string[];
      text: string;
      files: File[];
      requestId: string;
      activeRunDelivery: "steer" | "queue";
    }) => {
      const recipients = await uploadFilesForRecipients(
        agentIds,
        files,
        (agentId, file) => api.uploadAttachment(agentId, file),
        (agentId, item) => api.deleteAttachment(agentId, item.id),
      );
      return api.sendMultiAgentDirectMessage(conversationId, {
        text,
        recipients: recipients.map(({ agentId, attachments }) => ({
          agentId,
          attachmentIds: attachments.map(item => item.id),
        })),
        idempotencyKey: requestId,
        activeRunDelivery,
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
      setQueuedMessageNotice(
        queuedTitles.length > 0 && variables.activeRunDelivery === "queue"
          ? `Queued for ${queuedTitles.join(", ")}; it will start when the current response finishes.`
          : undefined,
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
      const activeIds = response.recipients
        .filter(recipient => !recipient.queued)
        .map(recipient => recipient.agentId);
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
      files,
      requestId,
      agentIds,
      activeRunDelivery,
    }: {
      text: string;
      files: File[];
      requestId: string;
      agentIds: string[];
      activeRunDelivery: "steer" | "queue";
    }) => {
      const owner = agents.find(agent => !agent.archived);
      if (files.length && !owner) {
        throw new Error(
          "Create an agent before attaching files to shared project context.",
        );
      }
      const uploadAgentIds = [
        ...new Set([...(owner ? [owner.id] : []), ...agentIds]),
      ];
      const uploadedRecipients = await uploadFilesForRecipients(
        uploadAgentIds,
        files,
        (agentId, file) => api.uploadAttachment(agentId, file),
        (agentId, item) => api.deleteAttachment(agentId, item.id),
      );
      const attachmentsByAgent = new Map(
        uploadedRecipients.map(recipient => [
          recipient.agentId,
          recipient.attachments,
        ]),
      );
      const attachments = owner
        ? (attachmentsByAgent.get(owner.id) ?? [])
        : [];
      try {
        return await api.sendConversationMessage(conversationId, {
          text,
          attachments,
          recipientAgentIds: agentIds,
          recipientAttachments: agentIds.map(agentId => ({
            agentId,
            attachmentIds: (attachmentsByAgent.get(agentId) ?? []).map(
              item => item.id,
            ),
          })),
          activeRunDelivery,
          idempotencyKey: requestId,
        });
      } catch (error) {
        await Promise.allSettled(
          uploadedRecipients.flatMap(recipient =>
            recipient.attachments.map(item =>
              api.deleteAttachment(recipient.agentId, item.id),
            ),
          ),
        );
        throw error;
      }
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
    const requestId = stopOperationRequestId.current ?? createClientId();
    stopOperationRequestId.current = requestId;
    try {
      const results = await Promise.allSettled(
        targets.map(({ agentId, runId }) =>
          api.cancelRun(agentId, {
            targetRunId: runId,
            idempotencyKey: `${requestId}:${runId}`,
          }),
        ),
      );
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (rejected) {
        throw rejected.reason instanceof Error
          ? rejected.reason
          : new Error(String(rejected.reason));
      }
      setStopConfirmation(undefined);
    } catch (error) {
      setCancelOperationError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      stopOperationRequestId.current = undefined;
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
    implicitTargetAgentId?: string,
  ) => {
    const broadcastMentioned = hasBroadcastMention(text);
    const broadcastText = managerBroadcastText(text);
    const everyoneMentioned = hasEveryoneMention(text);
    const explicitlyMentionedAgents = findMentionedAgents(text, agents);
    const implicitTarget =
      implicitTargetAgentId &&
      !everyoneMentioned &&
      explicitlyMentionedAgents.length === 0
        ? agents.find(
            agent => agent.id === implicitTargetAgentId && !agent.archived,
          )
        : undefined;
    const targets = everyoneMentioned
      ? agents.filter(agent => !agent.archived)
      : explicitlyMentionedAgents.length > 0
        ? explicitlyMentionedAgents
        : implicitTarget
          ? [implicitTarget]
          : [];
    if (broadcastText !== undefined) {
      if (!broadcastText && files.length === 0) {
        throw new Error(
          "Add informational context or an attachment after #broadcast.",
        );
      }
      await broadcast.mutateAsync({
        text: broadcastText,
        files,
        requestId: createClientId(),
        agentIds: targets.map(target => target.id),
        activeRunDelivery,
      });
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
        files,
        requestId: createClientId(),
        activeRunDelivery,
      });
    } else {
      setActiveOperation({ agentIds: [], state: "starting" });
      await spawn.mutateAsync({ text, draftAttachmentIds, draftOwnerId });
    }
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
    queuedMessageNotice,
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
