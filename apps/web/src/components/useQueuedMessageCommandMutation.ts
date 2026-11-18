import {useMutationNotification} from "./MutationNotifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CancelQueuedMessageResponse } from "@ponderosa/core";
import { applyQueuedMessageCancellation } from "./messageDeliveryReceipts";
import {useRef, type MutableRefObject} from "react";
import {productApiPath} from "../api/productScope";
import { createClientId } from "../clientId";
import { runQueuedMessageCommand, type QueuedMessageCommandAttemptRegistry, type QueuedMessageCommandInput } from "./queuedMessageCommandAttempts";

export interface QueuedMessageCommandFailure {
  error: Error;
  deliveryId: string;
  retry(): void;
}

/** Surfaces own scope, query and attempt lifetime; commands share exact retry handling. */
export function useQueuedMessageCommandMutation<Variables extends string | { deliveryId: string }, Response>({
  owner, attempts, input, dispatch, invalidate, onFailure, onSuccess,
}: {
  owner: string;
  attempts: MutableRefObject<QueuedMessageCommandAttemptRegistry>;
  input(variables: Variables): QueuedMessageCommandInput;
  dispatch(variables: Variables, request: { idempotencyKey: string; canonicalText?: string }): Promise<Response>;
  invalidate(): void | Promise<unknown>;
  onFailure(failure?: QueuedMessageCommandFailure): void;
  onSuccess?(response: Response, variables: Variables): void;
}) {
  const notify=useMutationNotification();
  const queryClient=useQueryClient();
  const activeOwner=useRef(owner);activeOwner.current=owner;
  const mutation = useMutation({
    mutationKey:["queue-action",productApiPath("/api/conversations"),owner],
    mutationFn: (variables: Variables) => {
      const command = input(variables);
      const incident=createClientId("queue-feedback-");
      const namespace=productApiPath("/api/conversations");
      return runQueuedMessageCommand(attempts.current, command,
        () => command.command === "edit" ? createClientId() : `${command.command}:${command.deliveryId}`,
        request => {
          const key=JSON.stringify([namespace,owner,command.command,command.deliveryId,request.idempotencyKey]);
          return dispatch(variables, request).then(response=>{
            if(command.command === "cancel" && activeOwner.current === owner &&
                productApiPath("/api/conversations") === namespace) {
              applyQueuedMessageCancellation(queryClient,response as CancelQueuedMessageResponse);
            }
            notify({key,message:"",dismiss:true});return response;
          },error=>{
            notify({key,incident,severity:"error",message:"Queue Action Needs Review",description:"Review the queued message in its original Chat before retrying.",details:error instanceof Error?error.message:String(error)});throw error;
          });
        });
    },
    onMutate: () => {if(activeOwner.current===owner)onFailure(undefined);},
    onSuccess: async (response, variables) => {
      onSuccess?.(response, variables);
      // Keep the accepted edit visible until the canonical queue is refreshed.
      // Refresh failure must never turn a committed command into a retry.
      try { await invalidate(); } catch {}
    },
    onError: (error, variables) => {
      if(activeOwner.current===owner)onFailure({ error: error instanceof Error ? error : new Error(String(error)),
        deliveryId: typeof variables === "string" ? variables : variables.deliveryId, retry: () => {if(activeOwner.current===owner)mutation.mutate(variables);} });
      invalidate();
    },
  });
  return mutation;
}
