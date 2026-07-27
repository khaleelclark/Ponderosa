import type { EngineDto, SendMessageRequest } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { createClientId } from "../clientId";
import { effortSelectionIsCompatible } from "../conversationEngine";
import { useSendMessage } from "../hooks/useSendMessage";
import { queryKeys } from "../queryKeys";
import { directAgentDeliveryNotice } from "./AgentDetail.helpers";

interface AgentMessageControllerInput {
  agentId: string;
  projectId?: string;
  engine?: EngineDto;
  model: string;
  effort: string;
  onNotice(value?: string): void;
  onChatSelected(): void;
}

export function useAgentMessageController({
  agentId,
  projectId,
  engine,
  model,
  effort,
  onNotice,
  onChatSelected,
}: AgentMessageControllerInput) {
  const queryClient = useQueryClient();
  const sendMessage = useSendMessage(agentId);
  const queuedMessagesQuery = useQuery({
    queryKey: queryKeys.queuedMessages.agent(agentId),
    queryFn: () => api.listQueuedAgentMessages(agentId),
  });
  const cancelQueuedMessage = useMutation({
    mutationFn: (deliveryId: string) =>
      api.cancelQueuedAgentMessage(agentId, deliveryId, {
        idempotencyKey: createClientId(),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.agent(agentId),
      }),
  });
  const editQueuedMessage = useMutation({
    mutationFn: ({ deliveryId, text }: { deliveryId: string; text: string }) =>
      api.editQueuedAgentMessage(agentId, deliveryId, {
        text,
        idempotencyKey: createClientId(),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.agent(agentId),
      }),
  });
  const steerQueuedMessage = useMutation({
    mutationFn: (deliveryId: string) =>
      api.steerQueuedAgentMessage(agentId, deliveryId, {
        idempotencyKey: createClientId(),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.agent(agentId),
      }),
  });

  const submitAgentMessage =
    (activeRunDelivery: NonNullable<SendMessageRequest["activeRunDelivery"]>) =>
    (
      text: string,
      files: File[],
      draftAttachmentIds: string[] = [],
      draftOwnerId?: string,
    ) => {
      const sent = (
        draftAttachmentIds.length
          ? Promise.resolve([])
          : Promise.all(files.map(file => api.uploadAttachment(agentId, file)))
      ).then(async attachments => {
        try {
          return await sendMessage.mutateAsync(
            {
              text,
              idempotencyKey: createClientId(),
              attachmentIds: attachments.map(item => item.id),
              ...(draftAttachmentIds.length
                ? {
                    draftAttachmentIds,
                    draftId: `agent:${agentId}`,
                    draftOwnerId,
                  }
                : {}),
              model,
              effort: effortSelectionIsCompatible(engine, model, effort)
                ? effort
                : "",
              activeRunDelivery,
            },
            {
              onSuccess: response => {
                onNotice(
                  directAgentDeliveryNotice(response, activeRunDelivery),
                );
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.queuedMessages.agent(agentId),
                });
                if (projectId) {
                  void queryClient.invalidateQueries({
                    queryKey: queryKeys.agents.health(projectId),
                  });
                }
              },
            },
          );
        } catch (error) {
          await Promise.allSettled(
            attachments.map(item => api.deleteAttachment(agentId, item.id)),
          );
          throw error;
        }
      });
      onChatSelected();
      return sent;
    };

  return {
    cancelQueuedMessage,
    editQueuedMessage,
    queuedMessagesQuery,
    sendMessage,
    steerQueuedMessage,
    submitAgentMessage,
  };
}
