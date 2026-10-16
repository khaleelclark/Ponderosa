import type {
  MultiAgentDirectMessageResponse,
} from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import {
  type QueuedMessageCommandAttemptRegistry,
} from "./queuedMessageCommandAttempts";

import { useQueuedMessageCommandMutation, type QueuedMessageCommandFailure } from "./useQueuedMessageCommandMutation";

export function useQueuedConversationMessagesController(
  conversationId: string | undefined,
  onSteered?: (message: { deliveryId: string; targetAgentId: string }) => void,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.queuedMessages.conversation(conversationId ?? ""),
    queryFn: () => api.listQueuedConversationMessages(conversationId!),
    enabled: Boolean(conversationId),
  });
  const [notice, setNotice] = useState<string>();
  const noticeDeliveryIds = useRef<Set<string>>(new Set());
  const noticeBaseline = useRef(0);
  const commandAttempts = useRef<QueuedMessageCommandAttemptRegistry>(new Map());
  const [commandFailure, setCommandFailure] = useState<{
    error: Error;
    conversationId: string;
    deliveryId: string;
    retry(): void;
  }>();

  useEffect(() => {
    setNotice(undefined);
    setCommandFailure(undefined);
    noticeDeliveryIds.current.clear();
    noticeBaseline.current = 0;
  }, [conversationId]);

  useEffect(() => {
    if (
      !notice ||
      query.isFetching ||
      query.dataUpdatedAt <= noticeBaseline.current
    ) return;
    const pendingIds = new Set(
      (query.data ?? []).map(message => message.deliveryId),
    );
    const trackedIds = noticeDeliveryIds.current;
    const deliveryStillQueued = trackedIds.size > 0
      ? [...trackedIds].some(deliveryId => pendingIds.has(deliveryId))
      : pendingIds.size > 0;
    if (!deliveryStillQueued) {
      trackedIds.clear();
      setNotice(undefined);
    }
  }, [notice, query.data, query.dataUpdatedAt, query.isFetching]);

  useEffect(() => {
    if (!commandFailure || query.isFetching || !query.data) return;
    if (!query.data.some(message =>
      message.deliveryId === commandFailure.deliveryId)) {
      setCommandFailure(undefined);
    }
  }, [commandFailure, query.data, query.isFetching]);

  const invalidate = () => {
    if (!conversationId) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.queuedMessages.conversation(conversationId),
    });
  };
  const commandOptions = {
    attempts: commandAttempts,
    invalidate,
    onFailure: (failure?: QueuedMessageCommandFailure) => setCommandFailure(failure
      ? { ...failure, conversationId: conversationId! } : undefined),
  };
  const cancel = useQueuedMessageCommandMutation({
    ...commandOptions,
    input: (deliveryId: string) => {
      if (!conversationId) throw new Error("Chat is required");
      return { command: "cancel", deliveryId };
    },
    dispatch: (deliveryId, { idempotencyKey }) => api.cancelQueuedConversationMessage(conversationId!, deliveryId, { idempotencyKey }),
  });
  const edit = useQueuedMessageCommandMutation({
    ...commandOptions,
    input: ({ deliveryId, text }: { deliveryId: string; targetAgentId: string; text: string }) => ({ command: "edit", deliveryId, text }),
    dispatch: ({ deliveryId, targetAgentId }, { idempotencyKey, canonicalText }) =>
      api.editQueuedAgentMessage(targetAgentId, deliveryId, { text: canonicalText!, idempotencyKey }),
  });
  const steer = useQueuedMessageCommandMutation({
    ...commandOptions,
    input: ({ deliveryId }: { deliveryId: string; targetAgentId: string }) => ({ command: "steer", deliveryId }),
    dispatch: ({ deliveryId, targetAgentId }, { idempotencyKey }) => api.steerQueuedAgentMessage(targetAgentId, deliveryId, { idempotencyKey }),
    onSuccess: (response, message) => { if (response.steered) onSteered?.(message); },
  });

  const recordDelivery = (
    response: MultiAgentDirectMessageResponse,
    delivery: "steer" | "queue",
    agentTitle: (agentId: string) => string,
  ) => {
    const unavailableTitles = (response.unavailableRecipients ?? [])
      .map(recipient => agentTitle(recipient.agentId));
    setNotice(unavailableTitles.length
      ? `Skipped unavailable recipient${unavailableTitles.length === 1 ? "" : "s"}: ${unavailableTitles.join(", ")}.`
      : undefined);
    noticeDeliveryIds.current = new Set(
      delivery === "queue"
        ? response.recipients.flatMap(recipient =>
            recipient.queued && recipient.deliveryId
              ? [recipient.deliveryId]
              : []
          )
        : [],
    );
    noticeBaseline.current = query.dataUpdatedAt;
    invalidate();
  };
  const failure = commandFailure?.conversationId === conversationId
    ? commandFailure
    : query.error
    ? {
        error: query.error instanceof Error
          ? query.error
          : new Error(String(query.error)),
        retry: () => { void query.refetch(); },
      }
    : undefined;

  return {
    query,
    notice,
    setNotice,
    failure,
    recordDelivery,
    cancel,
    edit,
    steer,
  };
}
