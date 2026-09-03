import type { EngineDto, SendMessageRequest } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import {
  effortSelectionIsCompatible,
  speedSelectionIsCompatible,
} from "../conversationEngine";
import { useSendMessage } from "../hooks/useSendMessage";
import { queryKeys } from "../queryKeys";
import { uploadFilesForRecipients } from "../conversationRouting";
import { directAgentDeliveryNotice } from "./AgentDetail.helpers";

interface AgentMessageControllerInput {
  agentId: string;
  projectId?: string;
  engine?: EngineDto;
  model: string;
  effort: string;
  speed: string;
  onNotice(value?: string): void;
  onChatSelected(): void;
}

export function useAgentMessageController({
  agentId,
  projectId,
  engine,
  model,
  effort,
  speed,
  onNotice,
  onChatSelected,
}: AgentMessageControllerInput) {
  const queryClient = useQueryClient();
  const sendMessage = useSendMessage(agentId);
  const queuedMessagesQuery = useQuery({
    queryKey: queryKeys.queuedMessages.agent(agentId),
    queryFn: () => api.listQueuedAgentMessages(agentId),
  });
  const [queueDeliveryNotice, setQueueDeliveryNotice] = useState<{
    deliveryId: string;
    text: string;
  }>();
  const queueNoticeBaseline = useRef(0);
  useEffect(() => {
    if (
      !queueDeliveryNotice ||
      queuedMessagesQuery.isFetching ||
      queuedMessagesQuery.dataUpdatedAt <= queueNoticeBaseline.current
    ) return;
    if (!queuedMessagesQuery.data?.some(
      message => message.deliveryId === queueDeliveryNotice.deliveryId,
    )) {
      setQueueDeliveryNotice(undefined);
    }
  }, [
    queueDeliveryNotice,
    queuedMessagesQuery.data,
    queuedMessagesQuery.dataUpdatedAt,
    queuedMessagesQuery.isFetching,
  ]);
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
          : uploadFilesForRecipients(
              [agentId],
              files,
              (recipientId, file) => api.uploadAttachment(recipientId, file),
              (recipientId, attachment) =>
                api.deleteAttachment(recipientId, attachment.id),
            ).then(recipients => recipients[0]?.attachments ?? [])
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
              ...(speed && speedSelectionIsCompatible(engine, model, speed)
                ? { speed }
                : {}),
              activeRunDelivery,
            },
            {
              onSuccess: response => {
                const notice = directAgentDeliveryNotice(
                  response,
                  activeRunDelivery,
                );
                if (
                  response.queued &&
                  activeRunDelivery === "queue" &&
                  notice &&
                  response.deliveryId
                ) {
                  queueNoticeBaseline.current =
                    queuedMessagesQuery.dataUpdatedAt;
                  setQueueDeliveryNotice({
                    deliveryId: response.deliveryId,
                    text: notice,
                  });
                  onNotice(undefined);
                } else {
                  setQueueDeliveryNotice(undefined);
                  onNotice(notice);
                }
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
    queueDeliveryNotice: queueDeliveryNotice?.text,
    queuedMessagesQuery,
    sendMessage,
    steerQueuedMessage,
    submitAgentMessage,
  };
}
