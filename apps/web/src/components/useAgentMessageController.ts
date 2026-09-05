import type { AssetDto, EngineDto, SendMessageRequest } from "@ponderosa/core";
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
import {
  discardRecipientUploads,
  fileSelectionFingerprint,
  type RecipientUploads,
  uploadFilesForRecipients,
} from "../conversationRouting";
import { directAgentDeliveryNotice } from "./AgentDetail.helpers";
import {
  selectIdempotentAttempt,
  type IdempotentAttempt,
} from "./idempotentAttempt";
import {
  runQueuedMessageCommand,
  type QueuedMessageCommandAttemptRegistry,
} from "./queuedMessageCommandAttempts";

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

interface AgentMessageSubmissionPrepared {
  agentId: string;
  files: File[];
  request: SendMessageRequest & {
    draftAttachmentIds?: string[];
    draftId?: string;
    draftOwnerId?: string;
  };
  uploads: RecipientUploads<AssetDto>;
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
  const sendMessage = useSendMessage();
  const queuedMessagesQuery = useQuery({
    queryKey: queryKeys.queuedMessages.agent(agentId),
    queryFn: () => api.listQueuedAgentMessages(agentId),
  });
  const [queueDeliveryNotice, setQueueDeliveryNotice] = useState<{
    deliveryId: string;
    text: string;
  }>();
  const queueNoticeBaseline = useRef(0);
  const sendAttempt = useRef<IdempotentAttempt<AgentMessageSubmissionPrepared>>();
  const queuedCommandAttempts = useRef<QueuedMessageCommandAttemptRegistry>(
    new Map(),
  );
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
      runQueuedMessageCommand(
        queuedCommandAttempts.current,
        { command: "cancel", deliveryId },
        () => `cancel:${deliveryId}`,
        ({ idempotencyKey }) =>
          api.cancelQueuedAgentMessage(agentId, deliveryId, {
            idempotencyKey,
          }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.agent(agentId),
      }),
  });
  const editQueuedMessage = useMutation({
    mutationFn: ({ deliveryId, text }: { deliveryId: string; text: string }) =>
      runQueuedMessageCommand(
        queuedCommandAttempts.current,
        { command: "edit", deliveryId, text },
        () => createClientId(),
        ({ idempotencyKey, canonicalText }) =>
          api.editQueuedAgentMessage(agentId, deliveryId, {
            text: canonicalText!,
            idempotencyKey,
          }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.queuedMessages.agent(agentId),
      }),
  });
  const steerQueuedMessage = useMutation({
    mutationFn: (deliveryId: string) =>
      runQueuedMessageCommand(
        queuedCommandAttempts.current,
        { command: "steer", deliveryId },
        () => `steer:${deliveryId}`,
        ({ idempotencyKey }) =>
          api.steerQueuedAgentMessage(agentId, deliveryId, {
            idempotencyKey,
          }),
      ),
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
      context?: { retryPreparedAttempt?: boolean },
    ) => {
      const sent = (async () => {
        const previous = sendAttempt.current;
        const attempt = selectIdempotentAttempt(
          previous,
          context?.retryPreparedAttempt === true,
          () => JSON.stringify({
            agentId,
            text,
            files: fileSelectionFingerprint(files),
            draftAttachmentIds,
            draftOwnerId,
            model,
            effort,
            speed,
            activeRunDelivery,
          }),
          () => createClientId(),
          () => ({
            agentId,
            files: [...files],
            request: {
              text,
              idempotencyKey: "",
              attachmentIds: [],
              ...(draftAttachmentIds.length
                ? {
                    draftAttachmentIds: [...draftAttachmentIds],
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
            uploads: [],
          }),
        );
        if (previous && previous !== attempt) {
          await discardRecipientUploads(
            previous.prepared.uploads,
            (recipientId, attachment) =>
              api.deleteAttachment(recipientId, attachment.id),
          );
        }
        sendAttempt.current = attempt;
        const prepared = attempt.prepared;
        if (
          !prepared.request.draftAttachmentIds?.length &&
          prepared.uploads.length === 0 &&
          prepared.files.length > 0
        ) {
          prepared.uploads = await uploadFilesForRecipients(
            [prepared.agentId],
            prepared.files,
            (recipientId, file) => api.uploadAttachment(recipientId, file),
            (recipientId, attachment) =>
              api.deleteAttachment(recipientId, attachment.id),
          );
        }
        const attachments = prepared.uploads[0]?.attachments ?? [];
        const response = await sendMessage.mutateAsync(
          {
            agentId: prepared.agentId,
            request: {
              ...prepared.request,
              idempotencyKey: attempt.idempotencyKey,
              attachmentIds: attachments.map(item => item.id),
            },
          },
          {
            onSuccess: response => {
              const notice = directAgentDeliveryNotice(
                response,
                prepared.request.activeRunDelivery ?? "steer",
              );
              if (
                response.queued &&
                prepared.request.activeRunDelivery === "queue" &&
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
                queryKey: queryKeys.queuedMessages.agent(prepared.agentId),
              });
              if (projectId) {
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.agents.health(projectId),
                });
              }
            },
          },
        );
        if (sendAttempt.current === attempt) sendAttempt.current = undefined;
        return response;
      })();
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
