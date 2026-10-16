import type { AssetDto, DraftPendingSubmissionDto, EngineDto, SendMessageRequest, SendMessageResponse } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
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
  pendingDraftAttachmentIds,
  recipientUploadCleanupSettled,
  pendingRecipientUploads,
  type RecipientUploads,
  uploadFilesForRecipients,
  withPendingRecipientUploads,
  withPendingRequest,
} from "../conversationRouting";
import { directAgentDeliveryNotice } from "./AgentDetail.helpers";
import {
  selectIdempotentAttempt,
  type IdempotentAttempt,
} from "./idempotentAttempt";
import {
  type QueuedMessageCommandAttemptRegistry,
} from "./queuedMessageCommandAttempts";

import { useQueuedMessageCommandMutation } from "./useQueuedMessageCommandMutation";

interface AgentMessageControllerInput {
  agentId: string;
  projectId?: string;
  engine?: EngineDto;
  model: string;
  effort: string;
  speed: string;
  onNotice(value?: string): void;
  onChatSelected(): void;
  onAccepted?(response: SendMessageResponse, delivery: "steer" | "queue"): void;
}

interface AgentMessageSubmissionPrepared {
  agentId: string;
  files: File[];
  request: SendMessageRequest & {
    draftAttachmentIds?: string[];
    draftId?: string;
    draftOwnerId?: string;
  };
  uploads: RecipientUploads<Pick<AssetDto, "id">>;
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
  onAccepted,
}: AgentMessageControllerInput) {
  const queryClient = useQueryClient();
  const activeAgentId = useRef(agentId);
  activeAgentId.current = agentId;
  const sendMessage = useSendMessage();
  const queuedMessagesQuery = useQuery({
    queryKey: queryKeys.queuedMessages.agent(agentId),
    queryFn: () => api.listQueuedAgentMessages(agentId),
  });
  const sendAttempt = useRef<IdempotentAttempt<AgentMessageSubmissionPrepared>>();
  const sendAttempts = useRef(new Map<string, IdempotentAttempt<AgentMessageSubmissionPrepared>>());
  const queuedCommandAttempts = useRef<QueuedMessageCommandAttemptRegistry>(
    new Map(),
  );
  const [queuedMessageFailure, setQueuedMessageFailure] = useState<{
    error: Error;
    deliveryId: string;
    retry(): void;
  }>();
  useEffect(() => {
    setQueuedMessageFailure(undefined);
    queuedCommandAttempts.current.clear();
  }, [agentId]);
  useEffect(() => {
    if (!queuedMessageFailure || queuedMessagesQuery.isFetching || !queuedMessagesQuery.data) return;
    if (!queuedMessagesQuery.data.some(message =>
      message.deliveryId === queuedMessageFailure.deliveryId)) {
      setQueuedMessageFailure(undefined);
    }
  }, [queuedMessageFailure, queuedMessagesQuery.data, queuedMessagesQuery.isFetching]);
  const invalidateQueuedMessages = () =>
    void queryClient.invalidateQueries({
      queryKey: queryKeys.queuedMessages.agent(agentId),
    });
  const commandOptions = { attempts: queuedCommandAttempts, invalidate: invalidateQueuedMessages, onFailure: setQueuedMessageFailure };
  const cancelQueuedMessage = useQueuedMessageCommandMutation({
    ...commandOptions,
    input: (deliveryId: string) => ({ command: "cancel", deliveryId }),
    dispatch: (deliveryId, { idempotencyKey }) => api.cancelQueuedAgentMessage(agentId, deliveryId, { idempotencyKey }),
  });
  const editQueuedMessage = useQueuedMessageCommandMutation({
    ...commandOptions,
    input: ({ deliveryId, text }: { deliveryId: string; text: string }) => ({ command: "edit", deliveryId, text }),
    dispatch: ({ deliveryId }, { idempotencyKey, canonicalText }) => api.editQueuedAgentMessage(agentId, deliveryId, { text: canonicalText!, idempotencyKey }),
  });
  const steerQueuedMessage = useQueuedMessageCommandMutation({
    ...commandOptions,
    input: (deliveryId: string) => ({ command: "steer", deliveryId }),
    dispatch: (deliveryId, { idempotencyKey }) => api.steerQueuedAgentMessage(agentId, deliveryId, { idempotencyKey }),
  });

  const submitAgentMessage =
    (activeRunDelivery: NonNullable<SendMessageRequest["activeRunDelivery"]>) =>
    (
      text: string,
      files: File[],
      draftAttachmentIds: string[] = [],
      draftOwnerId?: string,
      context?: {
        retryPreparedAttempt?: boolean;
        capturedSubmission?: boolean;
        pendingSubmission?: DraftPendingSubmissionDto;
        persistPendingSubmission?(
          value: DraftPendingSubmissionDto,
          retainOnFailure?: boolean,
        ): Promise<void>;
      },
    ) => {
      const sent = (async () => {
        let pendingSubmission = context?.pendingSubmission;
        if (pendingSubmission && !pendingSubmission.request && context?.persistPendingSubmission) {
          pendingSubmission = withPendingRequest(pendingSubmission, {
            recipientAgentIds: [agentId],
            runtime: {
              activeRunDelivery,
              ...(engine?.id ? { engine: engine.id } : {}),
              ...(model ? { model } : {}),
              ...(effortSelectionIsCompatible(engine, model, effort) && effort
                ? { effort }
                : {}),
              ...(speed && speedSelectionIsCompatible(engine, model, speed)
                ? { speed }
                : {}),
            },
          });
          await context.persistPendingSubmission(pendingSubmission);
        }
        const exactRuntime = pendingSubmission?.request?.runtime;
        const durableId = pendingSubmission?.idempotencyKey;
        const previous = durableId ? sendAttempts.current.get(durableId) : sendAttempt.current;
        const attempt = selectIdempotentAttempt(
          previous,
          context?.retryPreparedAttempt === true,
          () => JSON.stringify({
            agentId,
            text,
            files: fileSelectionFingerprint(files),
            draftAttachmentIds,
            draftOwnerId,
            engine: engine?.id,
            model,
            effort,
            speed,
            activeRunDelivery,
          }),
          () => pendingSubmission?.idempotencyKey ?? createClientId(),
          () => ({
            agentId,
            files: [...files],
            request: {
              text,
              idempotencyKey: "",
              attachmentIds: [],
              ...(pendingDraftAttachmentIds(context?.pendingSubmission, draftAttachmentIds).length
                ? {
                    draftAttachmentIds: pendingDraftAttachmentIds(
                      context?.pendingSubmission,
                      draftAttachmentIds,
                    ),
                    draftId: `agent:${agentId}`,
                    draftOwnerId,
                  }
                : {}),
              engine: exactRuntime?.engine ?? engine?.id,
              model: exactRuntime?.model ?? model,
              effort: exactRuntime
                ? exactRuntime.effort ?? ""
                : effortSelectionIsCompatible(engine, model, effort) ? effort : "",
              ...((exactRuntime?.speed ??
                    (speed && speedSelectionIsCompatible(engine, model, speed) ? speed : ""))
                ? { speed: exactRuntime?.speed ?? speed }
                : {}),
              activeRunDelivery: exactRuntime?.activeRunDelivery ?? activeRunDelivery,
            },
            uploads: [],
          }),
        );
        if (previous && previous !== attempt) {
          await discardRecipientUploads(
            previous.prepared.uploads,
            (recipientId, attachment) =>
              api.deleteAttachment(recipientId, attachment.id),
            error => error instanceof ApiRequestError &&
              recipientUploadCleanupSettled(error.status, error.message),
          );
        }
        if (durableId) sendAttempts.current.set(durableId, attempt);
        else sendAttempt.current = attempt;
        const prepared = attempt.prepared;
        const durableUploads = pendingRecipientUploads(
          pendingSubmission,
          "direct-agent",
        );
        if (durableUploads?.length === 1 &&
            durableUploads[0]?.agentId === prepared.agentId) {
          prepared.uploads = durableUploads;
        }
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
            error => error instanceof ApiRequestError && error.status === 404,
          );
          if (pendingSubmission && context?.persistPendingSubmission) {
            await context.persistPendingSubmission(withPendingRecipientUploads(
              pendingSubmission,
              "direct-agent",
              prepared.uploads,
            ));
          }
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
              if (activeAgentId.current === prepared.agentId) {
                onAccepted?.(response, prepared.request.activeRunDelivery ?? "steer");
                onNotice(directAgentDeliveryNotice(response, prepared.request.activeRunDelivery ?? "steer"));
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
        if (durableId) sendAttempts.current.delete(durableId);
        else if (sendAttempt.current === attempt) sendAttempt.current = undefined;
        return response;
      })();
      if (activeAgentId.current === agentId) onChatSelected();
      return sent;
    };

  return {
    cancelQueuedMessage,
    editQueuedMessage,
    queuedMessagesQuery,
    queuedMessageFailure: queuedMessageFailure ?? (queuedMessagesQuery.error
      ? {
          error: queuedMessagesQuery.error instanceof Error
            ? queuedMessagesQuery.error
            : new Error(String(queuedMessagesQuery.error)),
          retry: () => { void queuedMessagesQuery.refetch(); },
        }
      : undefined),
    sendMessage,
    steerQueuedMessage,
    submitAgentMessage,
  };
}
