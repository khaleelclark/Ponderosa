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
  const [activeOperation, setActiveOperation] = useState<{
    agentIds: string[];
    state: "starting" | "running";
  }>();
  const [stoppedNotice, setStoppedNotice] = useState<string>();
  const [stopConfirmation, setStopConfirmation] = useState<{
    targets: { agentId: string; runId: string }[];
    names: string;
  }>();
  const stopOperationRequestId = useRef<string>();

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
      const runConfig = selectedRunConfig(compatibleModel, compatibleEffort);
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
    names: string,
  ) => {
    setStoppedNotice(`Stopping ${names}. Partial output will remain visible.`);
    const requestId = stopOperationRequestId.current ?? createClientId();
    stopOperationRequestId.current = requestId;
    await Promise.allSettled(
      targets.map(({ agentId, runId }) =>
        api.cancelRun(agentId, {
          targetRunId: runId,
          idempotencyKey: `${requestId}:${runId}`,
        }),
      ),
    );
    stopOperationRequestId.current = undefined;
    setStopConfirmation(undefined);
    setStoppedNotice(`Stopped ${names}. Partial output remains visible.`);
    invalidate();
  };
  const stopOperation = async () => {
    const targets = (activeOperation?.agentIds ?? []).flatMap(agentId => {
      const runId = healthByAgentId.get(agentId)?.runtimeActivity?.executionId;
      return runId ? [{ agentId, runId }] : [];
    });
    if (targets.length === 0) return;
    const names = targets.map(({ agentId }) => agentTitle(agentId)).join(", ");
    if (targets.length > 1) {
      setStopConfirmation({ targets, names });
      return;
    }
    await cancelOperationTargets(targets, names);
  };

  const submit = async (
    text: string,
    files: File[],
    activeRunDelivery: "steer" | "queue" = "steer",
    draftAttachmentIds: string[] = [],
    draftOwnerId?: string,
  ) => {
    const broadcastMentioned = hasBroadcastMention(text);
    const broadcastText = managerBroadcastText(text);
    const everyoneMentioned = hasEveryoneMention(text);
    const explicitlyMentionedAgents = findMentionedAgents(text, agents);
    const targets = everyoneMentioned
      ? agents.filter(agent => !agent.archived)
      : explicitlyMentionedAgents;
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
    stoppedNotice,
    stopOperation,
    submit,
  };
}
