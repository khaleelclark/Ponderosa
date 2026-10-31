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
    }) => {
      if (!targetRunId) {
        throw new Error("The active Run changed before it could be stopped.");
      }
      return api.cancelRun(agentId, { idempotencyKey, targetRunId });
    },
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
    const idempotencyKey = stopRequestId.current ?? createClientId();
    stopRequestId.current = idempotencyKey;
    cancelRun.mutate({
      idempotencyKey,
      targetRunId: executionId ?? "",
    });
  };
  return { cancelRun, stopActiveRun };
}
