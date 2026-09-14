import type {
  MultiAgentDirectMessageResponse,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import {
  runQueuedMessageCommand,
  type QueuedMessageCommandAttemptRegistry,
} from "./queuedMessageCommandAttempts";

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
  const cancel = useMutation({
    mutationFn: (deliveryId: string) => {
      if (!conversationId) throw new Error("Chat is required");
      return runQueuedMessageCommand(
        commandAttempts.current,
        { command: "cancel", deliveryId },
        () => `cancel:${deliveryId}`,
        ({ idempotencyKey }) =>
          api.cancelQueuedConversationMessage(conversationId, deliveryId, {
            idempotencyKey,
          }),
      );
    },
    onMutate: () => setCommandFailure(undefined),
    onSuccess: invalidate,
    onError: (error, deliveryId) => {
      setCommandFailure({
        error: error instanceof Error ? error : new Error(String(error)),
        conversationId: conversationId!,
        deliveryId,
        retry: () => cancel.mutate(deliveryId),
      });
      invalidate();
    },
  });
  const edit = useMutation({
    mutationFn: ({
      deliveryId,
      targetAgentId,
      text,
    }: {
      deliveryId: string;
      targetAgentId: string;
      text: string;
    }) => runQueuedMessageCommand(
      commandAttempts.current,
      { command: "edit", deliveryId, text },
      () => createClientId(),
      ({ idempotencyKey, canonicalText }) =>
        api.editQueuedAgentMessage(targetAgentId, deliveryId, {
          text: canonicalText!,
          idempotencyKey,
        }),
    ),
    onMutate: () => setCommandFailure(undefined),
    onSuccess: invalidate,
    onError: (error, variables) => {
      setCommandFailure({
        error: error instanceof Error ? error : new Error(String(error)),
        conversationId: conversationId!,
        deliveryId: variables.deliveryId,
        retry: () => edit.mutate(variables),
      });
      invalidate();
    },
  });
  const steer = useMutation({
    mutationFn: ({
      deliveryId,
      targetAgentId,
    }: {
      deliveryId: string;
      targetAgentId: string;
    }) => runQueuedMessageCommand(
      commandAttempts.current,
      { command: "steer", deliveryId },
      () => `steer:${deliveryId}`,
      ({ idempotencyKey }) =>
        api.steerQueuedAgentMessage(targetAgentId, deliveryId, {
          idempotencyKey,
        }),
    ),
    onMutate: () => setCommandFailure(undefined),
    onSuccess: (response, message) => {
      invalidate();
      if (response.steered) onSteered?.(message);
    },
    onError: (error, variables) => {
      setCommandFailure({
        error: error instanceof Error ? error : new Error(String(error)),
        conversationId: conversationId!,
        deliveryId: variables.deliveryId,
        retry: () => steer.mutate(variables),
      });
      invalidate();
    },
  });

  const recordDelivery = (
    response: MultiAgentDirectMessageResponse,
    delivery: "steer" | "queue",
    agentTitle: (agentId: string) => string,
  ) => {
    const queuedTitles = delivery === "queue"
      ? response.recipients
          .filter(recipient => recipient.queued)
          .map(recipient => agentTitle(recipient.agentId))
      : [];
    const unavailableTitles = (response.unavailableRecipients ?? [])
      .map(recipient => agentTitle(recipient.agentId));
    setNotice([
      ...(queuedTitles.length
        ? [`Queued for ${queuedTitles.join(", ")}; it will start when the current response finishes.`]
        : []),
      ...(unavailableTitles.length
        ? [`Skipped unavailable recipient${unavailableTitles.length === 1 ? "" : "s"}: ${unavailableTitles.join(", ")}.`]
        : []),
    ].join(" ") || undefined);
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
