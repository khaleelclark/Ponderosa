import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import {useMutationNotification} from "./MutationNotifications";
import {productApiPath} from "../api/productScope";

export function useAgentRunCancellation(
  agentId: string,
  executionId?: string,
  pauseId?: string,
) {
  const queryClient = useQueryClient();
  const notify=useMutationNotification();
  const namespace=productApiPath("/api/conversations");
  // One local command gate prevents duplicate clicks and Pause/Stop races.
  // Each mutation carries its observed owner; callbacks never retarget to a
  // newer Agent, Run, product, or pause that arrived while it was in flight.
  const commandPending = useRef<{owner:string;idempotencyKey:string}>();
  const commandOwner=JSON.stringify([namespace,agentId,executionId]);
  const identity=JSON.stringify([namespace,agentId,executionId,pauseId]);
  const current=useRef<string|undefined>(identity);current.current=identity;
  useEffect(()=>{current.current=identity;return()=>{current.current=undefined;};},[identity]);
  const stopRequest=useRef<{identity:string;idempotencyKey:string}>();
  const cancelRun = useMutation({
    mutationKey:["stop-run",namespace,agentId],
    mutationFn: (target:{agentId:string;targetRunId:string;namespace:string;identity:string;idempotencyKey:string}) => {
      if (!target.targetRunId || current.current!==target.identity || productApiPath("/api/conversations")!==target.namespace) {
        throw new Error("The active Run changed before it could be stopped.");
      }
      return api.cancelRun(target.agentId, { idempotencyKey:target.idempotencyKey, targetRunId:target.targetRunId });
    },
    onError:(error,target)=>notify({key:JSON.stringify([target.namespace,target.agentId,"stop",target.targetRunId]),incident:createClientId("stop-feedback-"),severity:"error",message:"Stop Needs Review",description:"Review the original Agent and Run before trying again.",details:error instanceof Error?error.message:String(error)}),
    onSuccess:(_response,target)=>{if(stopRequest.current?.idempotencyKey===target.idempotencyKey)stopRequest.current=undefined;notify({key:JSON.stringify([target.namespace,target.agentId,"stop",target.targetRunId]),message:"",dismiss:true});},
    onSettled: (_data,_error,target) => {
      if(commandPending.current?.idempotencyKey===target.idempotencyKey)commandPending.current=undefined;
      void queryClient.invalidateQueries({queryKey:queryKeys.agents.detailPrefix(target.agentId)});
      void queryClient.invalidateQueries({queryKey:queryKeys.agents.healthAll});
    },
  });
  const stopActiveRun = () => {
    if(commandPending.current?.owner===commandOwner || current.current!==identity || productApiPath("/api/conversations")!==namespace || !executionId)return;
    const idempotencyKey=stopRequest.current?.identity===identity?stopRequest.current.idempotencyKey:createClientId();
    stopRequest.current={identity,idempotencyKey};commandPending.current={owner:commandOwner,idempotencyKey};
    cancelRun.mutate({agentId,targetRunId:executionId,namespace,identity,idempotencyKey});
  };
  return { cancelRun, stopActiveRun, commandPending, commandOwner, stopping:cancelRun.isPending&&cancelRun.variables?.namespace===namespace&&cancelRun.variables?.agentId===agentId&&cancelRun.variables?.targetRunId===executionId };
}
