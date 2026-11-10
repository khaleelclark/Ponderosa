import {useMutationNotification} from "./MutationNotifications";
import { useMutation } from "@tanstack/react-query";
import type { MutableRefObject } from "react";
import { createClientId } from "../clientId";
import { runQueuedMessageCommand, type QueuedMessageCommandAttemptRegistry, type QueuedMessageCommandInput } from "./queuedMessageCommandAttempts";

export interface QueuedMessageCommandFailure {
  error: Error;
  deliveryId: string;
  retry(): void;
}

/** Surfaces own scope, query and attempt lifetime; commands share exact retry handling. */
export function useQueuedMessageCommandMutation<Variables extends string | { deliveryId: string }, Response>({
  attempts, input, dispatch, invalidate, onFailure, onSuccess,
}: {
  attempts: MutableRefObject<QueuedMessageCommandAttemptRegistry>;
  input(variables: Variables): QueuedMessageCommandInput;
  dispatch(variables: Variables, request: { idempotencyKey: string; canonicalText?: string }): Promise<Response>;
  invalidate(): void | Promise<unknown>;
  onFailure(failure?: QueuedMessageCommandFailure): void;
  onSuccess?(response: Response, variables: Variables): void;
}) {
  const notify=useMutationNotification();
  const mutation = useMutation({
    mutationFn: (variables: Variables) => {
      const command = input(variables);
      return runQueuedMessageCommand(attempts.current, command,
        () => command.command === "edit" ? createClientId() : `${command.command}:${command.deliveryId}`,
        request => {
          const key=JSON.stringify([command.command,command.deliveryId,request.idempotencyKey]);
          return dispatch(variables, request).then(response=>{
            notify({key,message:"",dismiss:true});return response;
          },error=>{
            notify({key,severity:"error",message:"Queue action could not be confirmed. Review the queued message before retrying."});throw error;
          });
        });
    },
    onMutate: () => onFailure(undefined),
    onSuccess: async (response, variables) => {
      onSuccess?.(response, variables);
      // Keep the accepted edit visible until the canonical queue is refreshed.
      // Refresh failure must never turn a committed command into a retry.
      try { await invalidate(); } catch {}
    },
    onError: (error, variables) => {
      onFailure({ error: error instanceof Error ? error : new Error(String(error)),
        deliveryId: typeof variables === "string" ? variables : variables.deliveryId, retry: () => mutation.mutate(variables) });
      invalidate();
    },
  });
  return mutation;
}
