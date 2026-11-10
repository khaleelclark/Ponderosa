import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import {useMutationNotification} from "./MutationNotifications";
import {productApiPath} from "../api/productScope";

export function useAgentRunCancellation(
  agentId: string,
  executionId?: string,
) {
  const queryClient = useQueryClient();
  const notify=useMutationNotification();
  const namespace=productApiPath("/api/conversations");
  const feedbackKey=(targetRunId:string)=>JSON.stringify([namespace,agentId,"stop",targetRunId]);
  const stopRequestId = useRef<string>();
  const cancelRun = useMutation({
    mutationKey:["stop-run",namespace,agentId],
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
    onError:(error,variables)=>notify({key:feedbackKey(variables.targetRunId),incident:createClientId("stop-feedback-"),severity:"error",message:"Stop Needs Review",description:"Review the original Agent and Run before trying again.",details:error instanceof Error?error.message:String(error)}),
    onSuccess:(_response,variables)=>notify({key:feedbackKey(variables.targetRunId),message:"",dismiss:true}),
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
