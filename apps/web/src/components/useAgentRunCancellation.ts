import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";

export function useAgentRunCancellation(
  agentId: string,
  executionId?: string,
) {
  const queryClient = useQueryClient();
  const stopRequestId = useRef<string>();
  const cancelRun = useMutation({
    mutationFn: ({
      idempotencyKey,
      targetRunId,
    }: {
      idempotencyKey: string;
      targetRunId: string;
    }) => api.cancelRun(agentId, { idempotencyKey, targetRunId }),
    onSettled: () => {
      stopRequestId.current = undefined;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(agentId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.healthAll,
      });
    },
  });
  const stopActiveRun = () => {
    if (!executionId) {
      return Promise.reject(
        new Error("The active Run changed before it could be stopped."),
      );
    }
    const idempotencyKey = stopRequestId.current ?? createClientId();
    stopRequestId.current = idempotencyKey;
    return cancelRun.mutateAsync({
      idempotencyKey,
      targetRunId: executionId,
    });
  };
  return { cancelRun, stopActiveRun };
}
